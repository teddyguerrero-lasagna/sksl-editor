import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import CanvasKitInit from '../SkSL Watch Face Editor_files/canvaskit.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const CK = await CanvasKitInit({ locateFile: (f) => path.join(__dirname, '../SkSL Watch Face Editor_files/', f) });
  console.log('CanvasKit ready');

  // Load background image
  const bgBytes = fs.readFileSync('assets/wallpaper_silhouette.png');
  const bgImg = CK.MakeImageFromEncoded(bgBytes);
  if (!bgImg) {
    console.error('Failed to decode wallpaper image');
    return;
  }
  console.log('Decoded wallpaper image:', bgImg.width(), 'x', bgImg.height());

  // Target card parameters
  const cardW = 364;
  const cardH = 319;
  const scale = 2; // Render at 2x for retina quality
  const w = cardW * scale;
  const h = cardH * scale;
  const radius = 40.0 * scale;

  // Position of card relative to background (on 602x791 bounds)
  const relX = 119 / 602;
  const relY = 236 / 791;
  const relW = 364 / 602;
  const relH = 319 / 791;

  // SkSL Shader for the Card Surface
  const sksl = `
    uniform shader uBg;
    uniform float2 uSize;
    uniform float4 uRectUV; // x, y, width, height in background UV space
    uniform float  uRadius;
    uniform float  uRefractStrength;
    uniform float  uDispersion;
    uniform float  uBevelWidth;
    uniform float  uBlurRadius;
    uniform float  uCausticIntensity;
    uniform float  uSpecular;
    uniform float  uLightAngle;
    uniform half3  uTintColor;
    uniform half   uTintOpacity;
    uniform float  uRoughness;

    float sdRoundBox(float2 p, float2 b, float r) {
        float2 q = abs(p) - b + r;
        return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
    }

    float hash(float2 p) {
        return fract(sin(dot(p, float2(12.9898, 78.233))) * 43758.5453);
    }

    half4 main(float2 fragCoord) {
        float2 center = uSize * 0.5;
        float2 p = fragCoord - center;
        float dist = sdRoundBox(p, center, uRadius);
        if (dist > 0.0) {
            return half4(0.0);
        }

        float edgeDist = -dist;
        float bevelFactor = smoothstep(uBevelWidth, 0.0, edgeDist);

        // Compute 2D SDF normal
        float2 eps = float2(1.0, 0.0);
        float2 norm2D = normalize(float2(
            sdRoundBox(p + eps.xy, center, uRadius) - sdRoundBox(p - eps.xy, center, uRadius),
            sdRoundBox(p + eps.yx, center, uRadius) - sdRoundBox(p - eps.yx, center, uRadius)
        ));

        // Screen/Background UV space mapping
        float2 cardUV = fragCoord / uSize;
        float2 baseUV = uRectUV.xy + cardUV * uRectUV.zw;

        // Optical Refraction
        float2 refrOffset = -norm2D * bevelFactor * uRefractStrength * float2(uRectUV.z, uRectUV.w);

        // Chromatic Dispersion
        float2 uvR = baseUV + refrOffset * (1.0 + uDispersion);
        float2 uvG = baseUV + refrOffset;
        float2 uvB = baseUV + refrOffset * (1.0 - uDispersion);

        // 16-tap Poisson disk blur
        half3 blurred = half3(0.0);
        float blurScale = uBlurRadius * 0.0015;
        for (int i = 0; i < 16; i++) {
            float fi = float(i);
            float r = sqrt((fi + 0.5) / 16.0) * blurScale;
            float theta = fi * 2.39996323;
            float2 off = float2(cos(theta), sin(theta)) * r;

            blurred.r += uBg.eval(uvR + off).r;
            blurred.g += uBg.eval(uvG + off).g;
            blurred.b += uBg.eval(uvB + off).b;
        }
        blurred /= 16.0;

        // Subtle fluid caustics
        float2 cUV = cardUV * 8.0;
        float w1 = sin(cUV.x * 2.5 + 1.2) + cos(cUV.y * 2.2 - 0.8);
        float w2 = sin(cUV.x * 3.8 + cUV.y * 1.8);
        float caustic = pow(clamp(0.5 + 0.5 * sin(w1 + w2), 0.0, 1.0), 3.5) * uCausticIntensity;

        // 3D Specular Rim & Bevel Lighting
        float3 lightDir = normalize(float3(cos(uLightAngle), sin(uLightAngle), 0.85));
        float3 surfaceNorm = normalize(float3(norm2D * bevelFactor, 1.0 - bevelFactor * 0.6));
        float3 halfVec = normalize(lightDir + float3(0.0, 0.0, 1.0));
        float spec = pow(max(dot(surfaceNorm, halfVec), 0.0), 20.0) * bevelFactor * uSpecular;
        float innerRim = pow(bevelFactor, 2.2) * 0.22;

        // Micro-surface grain
        float grain = (hash(fragCoord) - 0.5) * uRoughness;

        // Composite
        half3 col = mix(blurred, uTintColor, uTintOpacity);
        col += half3(caustic + spec + innerRim);
        col += half3(grain);

        float alpha = smoothstep(0.0, -2.0, dist);
        return half4(col * alpha, alpha);
    }
  `;

  const effect = CK.RuntimeEffect.Make(sksl);
  if (!effect) {
    console.error('Failed to compile SkSL effect');
    return;
  }
  console.log('SkSL RuntimeEffect compiled successfully');

  // Background shader from image
  const bgShader = bgImg.makeShaderOptions(
    CK.TileMode.Clamp,
    CK.TileMode.Clamp,
    CK.FilterMode.Linear,
    CK.MipmapMode.Linear
  );

  // Surface for the Card Shader Texture
  const surface = CK.MakeSurface(w, h);
  const canvas = surface.getCanvas();

  // Render helper
  function renderVariant(name, causticInt, blurRad, specInt, tintOp, tintCol, refr) {
    const uniforms = [
      w, h,
      relX, relY, relW, relH,
      radius,
      refr,                   // uRefractStrength
      0.020,                  // uDispersion
      26.0 * scale,           // uBevelWidth
      blurRad,                // uBlurRadius
      causticInt,             // uCausticIntensity
      specInt,                // uSpecular
      45.0 * Math.PI / 180.0, // uLightAngle
      tintCol[0], tintCol[1], tintCol[2],
      tintOp,                 // uTintOpacity
      0.025                   // uRoughness
    ];
    const s = effect.makeShaderWithChildren(uniforms, [bgShader]);
    const p = new CK.Paint();
    p.setShader(s);

    const surf = CK.MakeSurface(w, h);
    surf.getCanvas().drawRect(CK.LTRBRect(0, 0, w, h), p);
    surf.flush();

    // 1x surface
    const surf1x = CK.MakeSurface(cardW, cardH);
    const c1x = surf1x.getCanvas();
    c1x.scale(1 / scale, 1 / scale);
    c1x.drawImage(surf.makeImageSnapshot(), 0, 0, null);
    surf1x.flush();

    fs.writeFileSync(`assets/${name}_2x.png`, surf.makeImageSnapshot().encodeToBytes());
    fs.writeFileSync(`assets/${name}_1x.png`, surf1x.makeImageSnapshot().encodeToBytes());
    console.log(`Rendered ${name}`);
  }

  // 1. Frosted Acrylic (clean legibility)
  renderVariant('card_frosted', 0.10, 28.0, 0.55, 0.45, [0.78, 0.78, 0.78], 0.030);

  // 2. Sunlight / Liquid Caustics
  renderVariant('card_caustics', 0.28, 22.0, 0.65, 0.38, [0.82, 0.82, 0.85], 0.045);

  // 3. Prism Glass (higher dispersion & specular rim)
  renderVariant('card_prism', 0.18, 18.0, 0.85, 0.32, [0.88, 0.88, 0.92], 0.060);

  // 4. Obsidian Dark Mode
  renderVariant('card_obsidian', 0.12, 26.0, 0.75, 0.65, [0.15, 0.15, 0.18], 0.025);
}

main().catch(console.error);
