/**
 * Pixel Shader Studio - Figma Plugin Sandbox Controller
 */

figma.showUI(__html__, {
  width: 360,
  height: 640,
  themeColors: true,
  title: 'Pixel Shader Studio'
});

function getSelectionInfo() {
  const sel = figma.currentPage.selection;
  if (!sel || sel.length === 0) {
    return { hasSelection: false };
  }
  const node = sel[0];
  let radius = 0;
  if ('cornerRadius' in node && typeof node.cornerRadius === 'number') {
    radius = node.cornerRadius;
  }
  return {
    hasSelection: true,
    name: node.name,
    id: node.id,
    type: node.type,
    width: Math.round(node.width),
    height: Math.round(node.height),
    cornerRadius: radius
  };
}

function sendSelection() {
  figma.ui.postMessage({
    type: 'selection-change',
    data: getSelectionInfo()
  });
}

// Initial selection notification
sendSelection();

// Listen for selection changes in Figma
figma.on('selectionchange', () => {
  sendSelection();
});

// Handle incoming messages from UI iframe
figma.ui.onmessage = async (msg) => {
  if (msg.type === 'get-selection') {
    sendSelection();
    return;
  }

  if (msg.type === 'apply-shader') {
    const sel = figma.currentPage.selection;
    if (!sel || sel.length === 0) {
      figma.notify('⚠️ Please select a rectangle or shape in Figma first!');
      return;
    }

    try {
      const bytes = new Uint8Array(msg.bytes);
      const image = figma.createImage(bytes);

      for (const node of sel) {
        if ('fills' in node) {
          node.fills = [
            {
              type: 'IMAGE',
              scaleMode: 'FILL',
              imageHash: image.hash
            }
          ];
        }
      }

      figma.notify(`✨ Applied shader texture to "${sel[0].name}"!`);
    } catch (err) {
      figma.notify('❌ Failed to apply shader: ' + err.message);
    }
    return;
  }

  if (msg.type === 'capture-background') {
    const sel = figma.currentPage.selection;
    if (!sel || sel.length === 0) {
      figma.notify('⚠️ Select a layer inside a frame to sample background!');
      return;
    }

    const node = sel[0];
    const parent = node.parent;
    if (!parent || parent.type === 'PAGE') {
      figma.notify('ℹ️ Layer has no parent frame to sample background from.');
      return;
    }

    try {
      // Temporarily hide selected node to capture what is strictly behind it
      const prevVisible = node.visible;
      node.visible = false;

      const exportBytes = await parent.exportAsync({
        format: 'PNG',
        constraint: { type: 'SCALE', value: 1 }
      });

      node.visible = prevVisible;

      figma.ui.postMessage({
        type: 'background-captured',
        bytes: Array.from(exportBytes),
        parentWidth: parent.width,
        parentHeight: parent.height,
        nodeX: node.x,
        nodeY: node.y,
        nodeWidth: node.width,
        nodeHeight: node.height
      });

      figma.notify('📸 Sampled background from parent frame!');
    } catch (err) {
      node.visible = true;
      figma.notify('❌ Could not sample background: ' + err.message);
    }
  }
};
