const vscode = require('vscode');
const http = require('http');
const path = require('path');
const fs = require('fs/promises');

let server;
let outputChannel;

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
  const normalized = String(language || '').toLowerCase().replace(/[\s.]/g, '');
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
}

function deactivate() { return new Promise((resolve) => server?.close(resolve) || resolve()); }
module.exports = { activate, deactivate };
