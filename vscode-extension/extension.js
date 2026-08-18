const vscode = require('vscode');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs/promises');

let server;
let outputChannel;
const socketClients = new Set();
const pendingApplies = new Map();

const EXTENSIONS = {
  c: 'c', cpp: 'cpp', 'c++': 'cpp', java: 'java', python: 'py', python3: 'py',
  javascript: 'js', typescript: 'ts', go: 'go', golang: 'go', rust: 'rs',
  csharp: 'cs', 'c#': 'cs', kotlin: 'kt', swift: 'swift', ruby: 'rb', php: 'php',
  scala: 'scala', sql: 'sql'
};

function slug(value) {
  return String(value || 'untitled-problem')
    .normalize('NFKD').replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, '-').replace(/-+/g, '-')
    .replace(/^-|-$/g, '').slice(0, 100) || 'untitled-problem';
}

function languageExtension(language) {
  const normalized = String(language || '').toLowerCase().replace(/[\s.()_-]/g, '');
  if (/^c\+\+\d*$/.test(normalized)) return 'cpp';
  if (/^python\d*$/.test(normalized)) return 'py';
  if (/^java\d*$/.test(normalized)) return 'java';
  if (/^(go|golang)\d*$/.test(normalized)) return 'go';
  if (/^(csharp|c#)\d*$/.test(normalized)) return 'cs';
  if (/^javascript\d*$/.test(normalized)) return 'js';
  if (/^typescript\d*$/.test(normalized)) return 'ts';
  return EXTENSIONS[normalized] || 'txt';
}

function workspaceRoot() {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || vscode.workspace.rootPath || '';
}

function config() {
  const values = vscode.workspace.getConfiguration('leetcodeCph');
  return { port: values.get('port'), outputDirectory: values.get('outputDirectory'), open: values.get('openSolutionAfterCapture') };
}

function validPayload(value) {
  return value && typeof value === 'object' && typeof value.title === 'string' && value.title.trim()
    && typeof value.source === 'string' && typeof value.code === 'string';
}

async function saveCapture(payload) {
  const root = workspaceRoot();
  if (!root) throw new Error('请先在 VS Code 打开一个工作区文件夹。');
  const settings = config();
  const base = path.resolve(root, settings.outputDirectory || 'leetcode');
  const label = payload.problemId ? `${slug(payload.problemId)}-${slug(payload.title.replace(/^\d+\s*[.、-]?\s*/, ''))}` : slug(payload.title);
  const folder = path.join(base, label);
  const extension = languageExtension(payload.language);
  const solution = path.join(folder, `solution.${extension}`);
  const readme = path.join(folder, 'README.md');
  const metadata = path.join(folder, 'metadata.json');
  await fs.mkdir(folder, { recursive: true });

  const markdown = `# ${payload.title}\n\n- Source: ${payload.source}\n- Captured: ${payload.capturedAt || new Date().toISOString()}\n- Language: ${payload.language || 'unknown'}\n\n## Problem\n\n${payload.description || '_题面未能从页面读取；可从 Source 链接查看。'}\n\n${payload.samples ? `## Examples\n\n${payload.samples}\n` : ''}`;
  await Promise.all([
    fs.writeFile(solution, payload.code, 'utf8'),
    fs.writeFile(readme, markdown, 'utf8'),
    fs.writeFile(metadata, JSON.stringify({ ...payload, savedAt: new Date().toISOString() }, null, 2), 'utf8')
  ]);
  outputChannel.appendLine(`Saved ${payload.title} → ${folder}`);
  if (settings.open) await vscode.window.showTextDocument(vscode.Uri.file(solution), { preview: false });
  return { folder: path.relative(root, folder), solution };
}

function respond(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  response.end(JSON.stringify(body));
}

function frame(payload) {
  const body = Buffer.from(JSON.stringify(payload));
  if (body.length > 65_535) throw new Error('WebSocket 消息过大。');
  const header = body.length <= 125 ? Buffer.from([0x81, body.length]) : Buffer.from([0x81, 126, body.length >> 8, body.length & 0xff]);
  return Buffer.concat([header, body]);
}

function sendSocket(client, payload) {
  if (!client.socket.destroyed) client.socket.write(frame(payload));
}

function handleSocketMessage(client, message) {
  if (message?.type === 'hello') {
    client.name = message.client || 'Edge';
    outputChannel.appendLine(`Browser connected: ${client.name}`);
    return;
  }
  if (message?.type !== 'applyResult' || !message.requestId) return;
  const pending = pendingApplies.get(message.requestId);
  if (!pending) return;
  if (message.ok) {
    clearTimeout(pending.timeout);
    pendingApplies.delete(message.requestId);
    pending.resolve(message.result);
    return;
  }
  pending.remaining -= 1;
  if (pending.remaining <= 0) {
    clearTimeout(pending.timeout);
    pendingApplies.delete(message.requestId);
    pending.reject(new Error(message.error || '浏览器同步失败。'));
  }
}

function consumeSocketData(client, chunk) {
  client.buffer = Buffer.concat([client.buffer, chunk]);
  while (client.buffer.length >= 2) {
    const first = client.buffer[0];
    const second = client.buffer[1];
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (client.buffer.length < 4) return;
      length = client.buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      client.socket.destroy();
      return;
    }
    const masked = Boolean(second & 0x80);
    if (!masked || client.buffer.length < offset + 4 + length) return;
    const mask = client.buffer.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.from(client.buffer.subarray(offset, offset + length));
    client.buffer = client.buffer.subarray(offset + length);
    for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
    if ((first & 0x0f) === 0x8) return client.socket.end();
    if ((first & 0x0f) !== 0x1) continue;
    try { handleSocketMessage(client, JSON.parse(payload.toString('utf8'))); } catch (_) { /* Ignore invalid messages. */ }
  }
}

function acceptWebSocket(request, socket) {
  if (request.url !== '/ws' || request.headers.upgrade?.toLowerCase() !== 'websocket') return socket.destroy();
  const key = request.headers['sec-websocket-key'];
  if (!key || Array.isArray(key)) return socket.destroy();
  const accept = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const client = { socket, buffer: Buffer.alloc(0), name: 'unknown' };
  socketClients.add(client);
  socket.setNoDelay(true);
  socket.on('data', (chunk) => consumeSocketData(client, chunk));
  socket.on('close', () => socketClients.delete(client));
  socket.on('error', () => socketClients.delete(client));
}

function requestBrowserApply(payload) {
  const clients = [...socketClients].filter((client) => !client.socket.destroyed);
  if (!clients.length) return Promise.reject(new Error('未连接 Edge 扩展。请在 edge://extensions 重新加载扩展，然后重试。'));
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingApplies.delete(requestId);
      reject(new Error('等待浏览器响应超时。请确认对应力扣页面已打开。'));
    }, 10_000);
    pendingApplies.set(requestId, { resolve, reject, timeout, remaining: clients.length });
    const message = { type: 'applyCode', requestId, ...payload };
    try {
      clients.forEach((client) => sendSocket(client, message));
    } catch (error) {
      clearTimeout(timeout);
      pendingApplies.delete(requestId);
      reject(error);
    }
  });
}

async function currentSolution() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') throw new Error('请先打开需要同步的 solution 文件。');
  const filePath = editor.document.uri.fsPath;
  if (!/^solution\.[^.]+$/i.test(path.basename(filePath))) {
    throw new Error('仅能同步题目目录中的 solution.* 文件。');
  }
  let metadata;
  try {
    metadata = JSON.parse(await fs.readFile(path.join(path.dirname(filePath), 'metadata.json'), 'utf8'));
  } catch (_) {
    throw new Error('未找到同目录的 metadata.json，无法确定对应力扣题目。');
  }
  if (!metadata?.source) throw new Error('metadata.json 中缺少题目来源链接。');
  return {
    source: metadata.source,
    title: metadata.title || path.basename(path.dirname(filePath)),
    language: metadata.language || path.extname(filePath).slice(1),
    code: editor.document.getText()
  };
}

async function syncCurrentSolution() {
  try {
    const payload = await currentSolution();
    vscode.window.setStatusBarMessage('LeetCode CPH: 正在同步到浏览器…');
    const result = await requestBrowserApply(payload);
    const extra = result.duplicates ? `（另有 ${result.duplicates} 个同题标签未修改）` : '';
    vscode.window.setStatusBarMessage(`LeetCode CPH: 已同步到浏览器 ${extra}`, 5000);
    outputChannel.appendLine(`Synced ${payload.title} to tab ${result.tabId}.`);
  } catch (error) {
    vscode.window.showErrorMessage(`LeetCode CPH 同步失败：${error.message || error}`);
    outputChannel.appendLine(`Sync failed: ${error.stack || error.message}`);
  }
}

function startServer() {
  const { port } = config();
  server = http.createServer((request, response) => {
    if (request.method === 'OPTIONS') return respond(response, 204, {});
    if (request.method !== 'POST' || request.url !== '/capture') return respond(response, 404, { error: 'Not found' });
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 2_000_000) request.destroy();
    });
    request.on('end', async () => {
      try {
        const payload = JSON.parse(raw);
        if (!validPayload(payload)) throw new Error('接收到的数据不完整。');
        const saved = await saveCapture(payload);
        respond(response, 200, { ok: true, ...saved });
        vscode.window.setStatusBarMessage(`LeetCode CPH: 已保存 ${payload.title}`, 5000);
      } catch (error) {
        outputChannel.appendLine(`Capture failed: ${error.stack || error.message}`);
        respond(response, 400, { ok: false, error: error.message || '保存失败。' });
      }
    });
  });
  server.on('upgrade', acceptWebSocket);
  server.on('error', (error) => {
    outputChannel.appendLine(`Receiver error: ${error.message}`);
    vscode.window.showErrorMessage(`LeetCode CPH Receiver 无法启动：${error.message}`);
  });
  server.listen(port, '127.0.0.1', () => outputChannel.appendLine(`Listening on http://127.0.0.1:${port}`));
}

function activate(context) {
  outputChannel = vscode.window.createOutputChannel('LeetCode CPH Receiver');
  startServer();
  context.subscriptions.push(outputChannel, { dispose: () => server?.close() });
  context.subscriptions.push(vscode.commands.registerCommand('leetcodeCph.openOutputFolder', async () => {
    const root = workspaceRoot();
    if (!root) return vscode.window.showWarningMessage('请先打开一个工作区文件夹。');
    const folder = path.join(root, config().outputDirectory || 'leetcode');
    await fs.mkdir(folder, { recursive: true });
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(folder));
  }));
  context.subscriptions.push(vscode.commands.registerCommand('leetcodeCph.showStatus', () => outputChannel.show()));
  context.subscriptions.push(vscode.commands.registerCommand('leetcodeCph.sendCurrentSolution', syncCurrentSolution));
}

function deactivate() {
  for (const pending of pendingApplies.values()) {
    clearTimeout(pending.timeout);
    pending.reject(new Error('VS Code 扩展已停止。'));
  }
  pendingApplies.clear();
  for (const client of socketClients) client.socket.destroy();
  return new Promise((resolve) => server?.close(resolve) || resolve());
}
module.exports = { activate, deactivate };
