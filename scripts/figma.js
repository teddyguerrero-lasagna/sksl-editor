#!/usr/bin/env node

/**
 * Figma Integration Tool & MCP Server for SkSL Watch Face Editor
 * 
 * Supports both CLI usage and standard Model Context Protocol (MCP) JSON-RPC over stdio.
 * Zero external dependencies: uses Node.js native fetch, fs, path, readline.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

// Helper to resolve token from args, env, or .env file
function resolveToken(cliToken) {
  if (cliToken) return cliToken;
  if (process.env.FIGMA_ACCESS_TOKEN) return process.env.FIGMA_ACCESS_TOKEN;
  if (process.env.FIGMA_TOKEN) return process.env.FIGMA_TOKEN;

  // Try reading from .env in project root
  const envPath = path.join(ROOT_DIR, '.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    const match = content.match(/FIGMA_ACCESS_TOKEN\s*=\s*(.+)/);
    if (match && match[1]) {
      return match[1].trim().replace(/^['"]|['"]$/g, '');
    }
  }

  // Try reading from ~/.figma_token
  const homeTokenPath = path.join(process.env.HOME || '', '.figma_token');
  if (fs.existsSync(homeTokenPath)) {
    return fs.readFileSync(homeTokenPath, 'utf8').trim();
  }

  return null;
}

const FIGMA_API_BASE = 'https://api.figma.com/v1';

async function figmaFetch(endpoint, token) {
  const url = endpoint.startsWith('http') ? endpoint : `${FIGMA_API_BASE}${endpoint}`;
  const res = await fetch(url, {
    headers: {
      'X-Figma-Token': token,
      'User-Agent': 'SkSL-Editor-Figma-Tool/1.0',
    },
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Figma API Error (${res.status} ${res.statusText}): ${errorText}`);
  }

  return res.json();
}

/**
 * Parse any Figma URL to extract fileKey and optional nodeId
 */
function parseFigmaUrl(urlStr) {
  try {
    const url = new URL(urlStr);
    const parts = url.pathname.split('/').filter(Boolean);
    // Typical URLs:
    // https://www.figma.com/file/:fileKey/:title?...
    // https://www.figma.com/design/:fileKey/:title?...
    // https://www.figma.com/proto/:fileKey/:title?...
    let fileKey = null;
    if (['file', 'design', 'proto', 'board'].includes(parts[0]) && parts[1]) {
      fileKey = parts[1];
    }

    let nodeId = url.searchParams.get('node-id');
    if (nodeId) {
      // Decode URL node id, replace '-' or '%3A' with ':'
      nodeId = decodeURIComponent(nodeId).replace(/-/g, ':');
    }

    return { fileKey, nodeId, originalUrl: urlStr };
  } catch (err) {
    return { fileKey: null, nodeId: null, error: err.message };
  }
}

/**
 * API methods
 */
const api = {
  async getMe(token) {
    return figmaFetch('/me', token);
  },

  async getFile(fileKey, token, depth = 2) {
    return figmaFetch(`/files/${fileKey}?depth=${depth}`, token);
  },

  async getNode(fileKey, nodeId, token) {
    const cleanId = nodeId.replace(/-/g, ':');
    const data = await figmaFetch(`/files/${fileKey}/nodes?ids=${encodeURIComponent(cleanId)}`, token);
    return data.nodes ? data.nodes[cleanId] : null;
  },

  async getStyles(fileKey, token) {
    return figmaFetch(`/files/${fileKey}/styles`, token);
  },

  async exportImage(fileKey, nodeId, format = 'svg', scale = 1, token) {
    const cleanId = nodeId.replace(/-/g, ':');
    const endpoint = `/images/${fileKey}?ids=${encodeURIComponent(cleanId)}&format=${format}&scale=${scale}`;
    const data = await figmaFetch(endpoint, token);
    const imageUrl = data.images && data.images[cleanId];
    if (!imageUrl) {
      throw new Error(`No image URL returned for node ${cleanId}`);
    }

    // Fetch the actual image data from AWS S3
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) {
      throw new Error(`Failed to download rendered image: ${imgRes.statusText}`);
    }

    if (format === 'svg') {
      return await imgRes.text();
    } else {
      const arrayBuf = await imgRes.arrayBuffer();
      return Buffer.from(arrayBuf);
    }
  },
};

/**
 * CLI Handler
 */
async function runCli() {
  const args = process.argv.slice(2);
  const command = args[0];
  const token = resolveToken();

  if (!command || command === '--help' || command === '-h') {
    console.log(`
Figma Tool for SkSL Watch Face Editor

Usage:
  node scripts/figma.js whoami
  node scripts/figma.js parse <figma-url>
  node scripts/figma.js file <fileKey> [--depth 2]
  node scripts/figma.js node <fileKey> <nodeId>
  node scripts/figma.js export-svg <fileKey> <nodeId> [outputPath]
  node scripts/figma.js export-png <fileKey> <nodeId> [outputPath] [--scale 2]
  node scripts/figma.js styles <fileKey>
  node scripts/figma.js --mcp (runs MCP server over stdio)
`);
    process.exit(0);
  }

  if (command === '--mcp') {
    startMcpServer(token);
    return;
  }

  try {
    switch (command) {
      case 'whoami': {
        const me = await api.getMe(token);
        console.log(JSON.stringify(me, null, 2));
        break;
      }
      case 'parse': {
        const urlStr = args[1];
        if (!urlStr) throw new Error('Missing URL');
        console.log(JSON.stringify(parseFigmaUrl(urlStr), null, 2));
        break;
      }
      case 'file': {
        const fileKey = args[1];
        const depthIdx = args.indexOf('--depth');
        const depth = depthIdx !== -1 ? parseInt(args[depthIdx + 1], 10) : 2;
        const fileData = await api.getFile(fileKey, token, depth);
        console.log(JSON.stringify(fileData, null, 2));
        break;
      }
      case 'node': {
        const fileKey = args[1];
        const nodeId = args[2];
        if (!fileKey || !nodeId) throw new Error('Usage: node scripts/figma.js node <fileKey> <nodeId>');
        const nodeData = await api.getNode(fileKey, nodeId, token);
        console.log(JSON.stringify(nodeData, null, 2));
        break;
      }
      case 'export-svg': {
        const fileKey = args[1];
        const nodeId = args[2];
        const outPath = args[3];
        if (!fileKey || !nodeId) throw new Error('Usage: node scripts/figma.js export-svg <fileKey> <nodeId> [outputPath]');
        const svgContent = await api.exportImage(fileKey, nodeId, 'svg', 1, token);
        if (outPath) {
          const resolvedPath = path.resolve(process.cwd(), outPath);
          fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
          fs.writeFileSync(resolvedPath, svgContent, 'utf8');
          console.log(`Saved SVG to ${resolvedPath}`);
        } else {
          console.log(svgContent);
        }
        break;
      }
      case 'export-png': {
        const fileKey = args[1];
        const nodeId = args[2];
        const outPath = args[3];
        const scaleIdx = args.indexOf('--scale');
        const scale = scaleIdx !== -1 ? parseFloat(args[scaleIdx + 1]) : 2;
        if (!fileKey || !nodeId || !outPath) throw new Error('Usage: node scripts/figma.js export-png <fileKey> <nodeId> <outputPath> [--scale 2]');
        const pngBuf = await api.exportImage(fileKey, nodeId, 'png', scale, token);
        const resolvedPath = path.resolve(process.cwd(), outPath);
        fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
        fs.writeFileSync(resolvedPath, pngBuf);
        console.log(`Saved PNG (${scale}x) to ${resolvedPath}`);
        break;
      }
      case 'styles': {
        const fileKey = args[1];
        const styles = await api.getStyles(fileKey, token);
        console.log(JSON.stringify(styles, null, 2));
        break;
      }
      default:
        console.error(`Unknown command: ${command}`);
        process.exit(1);
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

/**
 * Standard MCP JSON-RPC Server Implementation
 */
function startMcpServer(token) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  const tools = [
    {
      name: 'figma_whoami',
      description: 'Check Figma authentication and get current user details',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'figma_parse_url',
      description: 'Extract fileKey and nodeId from a Figma link or URL',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The Figma share URL' },
        },
        required: ['url'],
      },
    },
    {
      name: 'figma_get_file',
      description: 'Get file metadata, canvas hierarchy, components, and pages from Figma',
      inputSchema: {
        type: 'object',
        properties: {
          fileKey: { type: 'string', description: 'The key/id of the Figma file' },
          depth: { type: 'number', description: 'Tree depth to retrieve (default 2)' },
        },
        required: ['fileKey'],
      },
    },
    {
      name: 'figma_get_node',
      description: 'Inspect a specific Figma node (frame, vector, text, component) details',
      inputSchema: {
        type: 'object',
        properties: {
          fileKey: { type: 'string', description: 'The Figma file key' },
          nodeId: { type: 'string', description: 'The node ID (e.g. "0:1" or "12-34")' },
        },
        required: ['fileKey', 'nodeId'],
      },
    },
    {
      name: 'figma_export_svg',
      description: 'Export and download a Figma node as an SVG string or file on disk',
      inputSchema: {
        type: 'object',
        properties: {
          fileKey: { type: 'string', description: 'The Figma file key' },
          nodeId: { type: 'string', description: 'The node ID to export' },
          outputPath: { type: 'string', description: 'Optional relative or absolute file path to save SVG' },
        },
        required: ['fileKey', 'nodeId'],
      },
    },
    {
      name: 'figma_export_png',
      description: 'Export and download a Figma node as a PNG image file',
      inputSchema: {
        type: 'object',
        properties: {
          fileKey: { type: 'string', description: 'The Figma file key' },
          nodeId: { type: 'string', description: 'The node ID to export' },
          outputPath: { type: 'string', description: 'File path to save the PNG file' },
          scale: { type: 'number', description: 'Scale factor (1, 2, 3, or 4). Default 2' },
        },
        required: ['fileKey', 'nodeId', 'outputPath'],
      },
    },
  ];

  function sendResponse(id, result, error = null) {
    const res = { jsonrpc: '2.0', id };
    if (error) {
      res.error = error;
    } else {
      res.result = result;
    }
    process.stdout.write(JSON.stringify(res) + '\n');
  }

  rl.on('line', async (line) => {
    line = line.trim();
    if (!line) return;

    try {
      const msg = JSON.parse(line);
      const { id, method, params } = msg;

      if (method === 'initialize') {
        sendResponse(id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'figma-sksl-mcp', version: '1.0.0' },
        });
        return;
      }

      if (method === 'notifications/initialized') {
        // Notification, no reply needed
        return;
      }

      if (method === 'tools/list') {
        sendResponse(id, { tools });
        return;
      }

      if (method === 'tools/call') {
        const { name, arguments: args } = params;
        try {
          let output;
          if (name === 'figma_whoami') {
            output = await api.getMe(token);
          } else if (name === 'figma_parse_url') {
            output = parseFigmaUrl(args.url);
          } else if (name === 'figma_get_file') {
            output = await api.getFile(args.fileKey, token, args.depth || 2);
          } else if (name === 'figma_get_node') {
            output = await api.getNode(args.fileKey, args.nodeId, token);
          } else if (name === 'figma_export_svg') {
            const svg = await api.exportImage(args.fileKey, args.nodeId, 'svg', 1, token);
            if (args.outputPath) {
              const resolved = path.resolve(ROOT_DIR, args.outputPath);
              fs.mkdirSync(path.dirname(resolved), { recursive: true });
              fs.writeFileSync(resolved, svg, 'utf8');
              output = { savedTo: resolved, length: svg.length };
            } else {
              output = { svg };
            }
          } else if (name === 'figma_export_png') {
            const buf = await api.exportImage(args.fileKey, args.nodeId, 'png', args.scale || 2, token);
            const resolved = path.resolve(ROOT_DIR, args.outputPath);
            fs.mkdirSync(path.dirname(resolved), { recursive: true });
            fs.writeFileSync(resolved, buf);
            output = { savedTo: resolved, bytes: buf.length };
          } else {
            sendResponse(id, null, { code: -32601, message: `Tool not found: ${name}` });
            return;
          }

          sendResponse(id, {
            content: [
              {
                type: 'text',
                text: typeof output === 'string' ? output : JSON.stringify(output, null, 2),
              },
            ],
          });
        } catch (callErr) {
          sendResponse(id, {
            content: [{ type: 'text', text: `Error: ${callErr.message}` }],
            isError: true,
          });
        }
        return;
      }

      // Default fallback
      sendResponse(id, null, { code: -32601, message: `Method not found: ${method}` });
    } catch (parseErr) {
      console.error('Error parsing JSON-RPC line:', parseErr);
    }
  });
}

// Start
runCli();
