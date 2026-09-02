const vscode = require('vscode');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs/promises');

const { ApplyTracker } = require('./apply-tracker');
const { LeetCodeCphSidebarProvider } = require('./sidebar-provider');
const {
  TEST_CASES_FILE,
  fromCapturePayload,
  mergeCaptureTestCases,
  loadTestCaseState,
  loadTestCases,
  saveTestCases,
  createTestCase,
  deleteTestCase
} = require('./testcase-store');
const {
  PROVIDERS,
  PROVIDER_IDS,
  createAiTestcaseService,
  normalizeProvider,
  providerInfo
} = require('./ai-testcase-service');

let server;
let outputChannel;
let applyTracker;
let sidebarProvider;
let aiTestcaseService;
const socketClients = new Set();
const problemLocks = new Map();

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

function aiConfig() {
  const values = vscode.workspace.getConfiguration('leetcodeCph');
  const provider = normalizeProvider(values.get('ai.provider') || 'glm');
  return { provider, model: String(values.get('ai.model') || '').trim() };
}

// Capture requests and sidebar mutations can arrive independently.  Serialize
// every read-modify-write operation for one problem directory so a quick
// double-click, an AI rollback, or a re-capture cannot overwrite another
// operation's testcases.json or testcase.* file.
function withProblemLock(problemFolder, operation) {
  const key = path.resolve(problemFolder);
  const previous = problemLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  problemLocks.set(key, current);
  return previous.catch(() => {}).then(async () => {
    try {
      return await operation();
    } finally {
      release();
      if (problemLocks.get(key) === current) problemLocks.delete(key);
    }
  });
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

  const saved = await withProblemLock(folder, async () => {
    // Re-capturing a page refreshes examples visible on LeetCode while retaining
    // every case the user added manually in the sidebar (and any explicit
    // deletion tombstone for a captured example).
    let previousMetadata = {};
    try { previousMetadata = JSON.parse(await readTextIfPresent(metadata)); } catch (_) { /* A fresh/corrupt legacy metadata file is replaced below. */ }
    const hasStoredTestCases = await fileExists(path.join(folder, TEST_CASES_FILE));
    let previousState = await loadTestCaseState(folder);
    if (!hasStoredTestCases) {
      // A user can upgrade from an older capture and immediately re-capture
      // while LeetCode is still loading.  Seed the merge from old metadata so
      // that transient empty samples do not erase that legacy information.
      previousState = { ...previousState, testCases: fromCapturePayload(previousMetadata) };
    }
    const testCases = mergeCaptureTestCases(previousState.testCases, payload, {
      excludedLeetCodeIds: previousState.excludedLeetCodeIds
    });
    const testCasesChanged = JSON.stringify(previousState.testCases) !== JSON.stringify(testCases);
    const scaffold = path.join(folder, `testcase.${extension}`);
    const hasScaffold = await fileExists(scaffold);
    const scaffoldStale = hasScaffold && (Boolean(previousMetadata.testcaseScaffoldStale) || testCasesChanged);
    const markdown = `# ${payload.title}\n\n- Source: ${payload.source}\n- Captured: ${payload.capturedAt || new Date().toISOString()}\n- Language: ${payload.language || 'unknown'}\n\n## Problem\n\n${payload.description || '_题面未能从页面读取；可从 Source 链接查看。'}\n\n${payload.samples ? `## Examples\n\n${payload.samples}\n` : ''}`;
    await Promise.all([
      fs.writeFile(solution, payload.code, 'utf8'),
      fs.writeFile(readme, markdown, 'utf8'),
      fs.writeFile(metadata, JSON.stringify({ ...payload, savedAt: new Date().toISOString(), testcaseScaffoldStale: scaffoldStale }, null, 2), 'utf8'),
      saveTestCases(folder, testCases, { excludedLeetCodeIds: previousState.excludedLeetCodeIds })
    ]);
    return { folder: path.relative(root, folder), solution, scaffoldStale };
  });
  outputChannel.appendLine(`Saved ${payload.title} → ${folder}`);
  if (settings.open) await vscode.window.showTextDocument(vscode.Uri.file(solution), { preview: false });
  return saved;
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

// Central client teardown. Every disconnect path funnels through here so a
// failed/closed socket is removed from the candidate set AND from all pending
// applies: a request whose last candidate vanished fails fast with
// “浏览器连接已断开” instead of hanging until the apply timeout.
function removeClient(client, reason) {
  socketClients.delete(client);
  applyTracker?.handleClientClosed(client);
  if (reason) outputChannel?.appendLine(`Removed browser client (${client.name || 'unknown'}: ${reason}).`);
  if (!client.socket.destroyed) client.socket.destroy();
}

function sendSocket(client, payload) {
  if (!client.socket.writable || client.socket.destroyed) {
    removeClient(client);
    return false;
  }
  try {
    client.socket.write(frame(payload));
    return true;
  } catch (error) {
    removeClient(client, `write failed: ${error.message}`);
    return false;
  }
}

const HEARTBEAT_INTERVAL_MS = 15_000;
const CLIENT_STALE_MS = 60_000;
let heartbeatTimer;

// The Edge extension lives in a Manifest V3 service worker, which the browser
// may terminate while it is idle. That kills the WebSocket without VS Code
// noticing, so a stale "zombie" client would otherwise make every sync hang
// for 10 seconds with a misleading "page not open" error. Heartbeat + expiry
// keeps the client list honest: the Edge side already answers {type:'ping'}
// with {type:'pong'}, and it also sends its own ping every 30 seconds.
function heartbeat() {
  const now = Date.now();
  for (const client of [...socketClients]) {
    if (!client.socket.writable || client.socket.destroyed) {
      removeClient(client);
      continue;
    }
    if (now - client.lastSeen > CLIENT_STALE_MS) {
      removeClient(client, 'unresponsive');
      continue;
    }
    sendSocket(client, { type: 'ping' });
  }
}

function handleSocketMessage(client, message) {
  if (message?.type === 'hello') {
    client.name = message.client || 'Edge';
    outputChannel.appendLine(`Browser connected: ${client.name}`);
    return;
  }
  if (message?.type === 'ping') {
    sendSocket(client, { type: 'pong' });
    return;
  }
  if (message?.type !== 'applyResult' || !message.requestId) return;
  applyTracker.handleApplyResult(client, message);
}

function consumeSocketData(client, chunk) {
  client.lastSeen = Date.now();
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
      removeClient(client, 'frame too large');
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
  const client = { socket, buffer: Buffer.alloc(0), name: 'unknown', lastSeen: Date.now() };
  socketClients.add(client);
  socket.setNoDelay(true);
  socket.on('data', (chunk) => consumeSocketData(client, chunk));
  socket.on('close', () => removeClient(client));
  socket.on('error', () => removeClient(client, 'socket error'));
}

function requestBrowserApply(payload) {
  const requestId = crypto.randomUUID();
  const message = { type: 'applyCode', requestId, ...payload };
  const clients = [...socketClients].filter((client) => client.socket.writable && !client.socket.destroyed);
  if (!clients.length) {
    return Promise.reject(new Error('未连接 Edge 扩展。请确认 Edge 已打开且扩展已加载；扩展每 30 秒会自动重连，若刚启动浏览器请稍候再试。'));
  }
  // Handle each client individually so one stale socket cannot fail the whole
  // sync. Failed writes funnel through sendSocket → removeClient, which both
  // drops the dead socket and settles any pending applies waiting on it.
  let remaining = 0;
  const sentClients = [];
  for (const client of clients) {
    if (sendSocket(client, message)) {
      remaining += 1;
      sentClients.push(client);
    }
  }
  if (!remaining) {
    return Promise.reject(new Error('未连接 Edge 扩展。请确认 Edge 已打开且扩展已加载；扩展每 30 秒会自动重连，若刚启动浏览器请稍候再试。'));
  }
  return new Promise((resolve, reject) => {
    applyTracker.create(requestId, sentClients, {
      onSuccess: (result) => resolve(result),
      onFailure: (error) => reject(error),
      onTimeout: () => reject(new Error('等待浏览器响应超时：浏览器扩展可能已休眠，未响应的连接已自动断开，扩展会自行重连，请稍后重试；若仍失败，请在 edge://extensions 重新加载扩展。'))
    });
  });
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function readTextIfPresent(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

async function writeTextAtomically(filePath, content) {
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temporary, `${String(content).replace(/\r?\n?$/, '')}\n`, 'utf8');
    await fs.rename(temporary, filePath);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

async function loadOrMigrateTestCases(problemFolder, metadata) {
  const storageFile = path.join(problemFolder, TEST_CASES_FILE);
  const exists = await fileExists(storageFile);
  const saved = await loadTestCases(problemFolder);
  if (exists) return saved;

  // Existing captures created before testcases.json remain usable immediately.
  // This read path deliberately does not write: a sidebar refresh must not
  // race a capture or mutation.  A mutating operation persists the migration
  // while it holds the per-problem lock.
  const migrated = fromCapturePayload(metadata);
  return migrated;
}

function pathKey(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function openTextDocument(filePath) {
  const target = pathKey(filePath);
  const documents = Array.isArray(vscode.workspace.textDocuments) ? vscode.workspace.textDocuments : [];
  return documents.find((document) => document?.uri?.scheme === 'file'
    && typeof document.uri.fsPath === 'string'
    && pathKey(document.uri.fsPath) === target);
}

async function readOpenDocumentOrFile(filePath) {
  const document = openTextDocument(filePath);
  return document ? document.getText() : fs.readFile(filePath, 'utf8');
}

async function findSolutionFile(problemFolder, preferredExtension) {
  const preferred = path.join(problemFolder, `solution${preferredExtension}`);
  if (await fileExists(preferred)) return preferred;
  const entries = await fs.readdir(problemFolder, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isFile() && /^solution\.[^.]+$/i.test(entry.name))
    .map((entry) => path.join(problemFolder, entry.name));
  if (candidates.length === 1) return candidates[0];
  throw new Error('未找到同目录的 solution.* 文件，无法读取被测代码。');
}

async function activeProblemIdentity({ required = true } = {}) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') {
    if (!required) return null;
    throw new Error('请先打开题目目录中的 solution.* 或 testcase.* 文件。');
  }
  const activeFilePath = editor.document.uri.fsPath;
  const activeName = path.basename(activeFilePath);
  const isSolution = /^solution\.[^.]+$/i.test(activeName);
  const isScaffold = /^testcase\.[^.]+$/i.test(activeName);
  if (!isSolution && !isScaffold) {
    if (!required) return null;
    throw new Error('仅能在题目目录中的 solution.* 或 testcase.* 文件打开时使用此功能。');
  }
  const folder = path.dirname(activeFilePath);
  const solutionPath = isSolution
    ? activeFilePath
    : await findSolutionFile(folder, path.extname(activeFilePath));
  const code = isSolution ? editor.document.getText() : await readOpenDocumentOrFile(solutionPath);
  return {
    folder,
    solutionPath,
    solutionFileName: path.basename(solutionPath),
    activeFilePath,
    code
  };
}

async function problemContextFromIdentity(identity) {
  let metadata;
  try {
    metadata = JSON.parse(await fs.readFile(path.join(identity.folder, 'metadata.json'), 'utf8'));
  } catch (_) {
    throw new Error('未找到同目录的 metadata.json，无法确定对应力扣题目。');
  }
  if (!metadata?.source) throw new Error('metadata.json 中缺少题目来源链接。');
  const testCases = await loadOrMigrateTestCases(identity.folder, metadata);
  return {
    ...identity,
    metadata,
    title: metadata.title || path.basename(identity.folder),
    source: metadata.source,
    language: metadata.language || path.extname(identity.solutionPath).slice(1),
    testCases
  };
}

async function activeProblemContext(options = {}) {
  const identity = await activeProblemIdentity(options);
  return identity ? problemContextFromIdentity(identity) : null;
}

function browserApplyPayload(context) {
  return {
    source: context.source,
    title: context.title,
    language: context.language,
    code: context.code
  };
}

function scaffoldFilePath(context) {
  const extension = path.extname(context.solutionPath).slice(1) || languageExtension(context.language);
  return path.join(context.folder, `testcase.${extension}`);
}

async function ensurePersistedTestCases(context) {
  const storageFile = path.join(context.folder, TEST_CASES_FILE);
  if (await fileExists(storageFile)) return context;
  const testCases = await saveTestCases(context.folder, context.testCases);
  return { ...context, testCases };
}

async function markScaffoldFresh(context) {
  if (!context.metadata?.testcaseScaffoldStale) return;
  const metadataPath = path.join(context.folder, 'metadata.json');
  const nextMetadata = { ...context.metadata, testcaseScaffoldStale: false };
  await writeTextAtomically(metadataPath, JSON.stringify(nextMetadata, null, 2));
  context.metadata = nextMetadata;
}

async function configuredAiState() {
  if (!aiTestcaseService) return { provider: 'glm', model: '', configured: false };
  const { provider, model } = aiConfig();
  const configuredProviders = await aiTestcaseService.getConfiguredProviders();
  return { provider, model, configured: Boolean(configuredProviders[provider]), configuredProviders };
}

async function generateTestScaffold(context, testCases, operation) {
  if (!aiTestcaseService) throw new Error('AI 服务尚未初始化，请重新加载 VS Code 扩展。');
  if (!Array.isArray(testCases)) {
    throw new Error('测试用例数据无效，无法生成测试脚手架。');
  }
  if (operation?.type === 'initialize' && !testCases.length) {
    throw new Error('当前没有测试用例，无法生成测试脚手架。');
  }
  const ai = await configuredAiState();
  if (!ai.configured) {
    const label = providerInfo(ai.provider).label;
    throw new Error(`未配置 ${label} API Key。请在侧边栏点击“配置 AI”后保存密钥。`);
  }
  const destination = scaffoldFilePath(context);
  const openScaffold = openTextDocument(destination);
  if (openScaffold?.isDirty) {
    throw new Error(`请先保存 ${path.basename(destination)} 中的手动编辑，再更新测试脚手架。`);
  }
  const existingScaffold = openScaffold ? openScaffold.getText() : await readTextIfPresent(destination);
  const generated = await aiTestcaseService.generateScaffold({
    metadata: context.metadata,
    solutionCode: context.code,
    testCases,
    operation,
    existingScaffold,
    provider: ai.provider,
    model: ai.model
  });
  await writeTextAtomically(destination, generated.content);
  try {
    await markScaffoldFresh(context);
  } catch (error) {
    // The scaffold itself was written successfully.  Leaving the stale badge
    // visible is safer than reporting the entire mutation as failed and
    // rolling back its testcase JSON after the source file changed.
    outputChannel?.appendLine(`Could not clear testcase scaffold stale marker: ${error.message}`);
  }
  return { ...generated, destination };
}

async function syncActiveSolution() {
  const context = await activeProblemContext();
  vscode.window.setStatusBarMessage('LeetCode CPH: 正在同步到浏览器…');
  const result = await requestBrowserApply(browserApplyPayload(context));
  const extra = result.duplicates ? `（另有 ${result.duplicates} 个同题标签未修改）` : '';
  vscode.window.setStatusBarMessage(`LeetCode CPH: 已同步到浏览器 ${extra}`, 5000);
  outputChannel.appendLine(`Synced ${context.title} to tab ${result.tabId}.`);
  return result;
}

async function sidebarState(extra = {}) {
  const empty = { problem: null, testCases: [], busy: false, notice: '', error: '' };
  let context;
  try {
    context = await activeProblemContext({ required: false });
  } catch (error) {
    return { ...empty, ...extra, error: extra.error || error.message || '无法读取当前题目。' };
  }
  if (!context) return { ...empty, ...extra };

  let aiStatus = 'AI：未初始化';
  try {
    const ai = await configuredAiState();
    const label = providerInfo(ai.provider).label;
    aiStatus = `AI：${label}${ai.configured ? '（API Key 已安全保存）' : '（未配置 API Key）'}`;
  } catch (error) {
    aiStatus = 'AI：配置无效';
  }
  return {
    ...empty,
    problem: {
      title: context.title,
      source: context.source,
      language: context.language,
      aiStatus,
      scaffoldStatus: context.metadata?.testcaseScaffoldStale ? '测试脚手架需要更新' : ''
    },
    testCases: context.testCases,
    ...extra
  };
}

async function refreshSidebar(extra = {}) {
  const state = await sidebarState(extra);
  sidebarProvider?.setState(state);
  return state;
}

async function configureAi() {
  if (!aiTestcaseService) throw new Error('VS Code SecretStorage 不可用，无法安全保存 API Key。');
  const configured = await aiTestcaseService.getConfiguredProviders();
  const selectedConfig = aiConfig();
  const provider = await vscode.window.showQuickPick(
    PROVIDER_IDS.map((id) => ({
      label: providerInfo(id).label,
      description: configured[id] ? 'API Key 已安全保存' : '未配置 API Key',
      detail: PROVIDERS[id].defaultModel,
      id
    })),
    { placeHolder: '选择用于生成 LeetCode 测试脚手架的 AI Provider', ignoreFocusOut: true }
  );
  if (!provider) return null;

  const defaultModel = provider.id === selectedConfig.provider && selectedConfig.model
    ? selectedConfig.model
    : PROVIDERS[provider.id].defaultModel;
  const model = await vscode.window.showInputBox({
    prompt: `${provider.label} 模型名称（可保留默认值）`,
    value: defaultModel,
    ignoreFocusOut: true
  });
  if (model === undefined) return null;
  const apiKey = await vscode.window.showInputBox({
    prompt: `输入 ${provider.label} API Key（仅安全保存于 VS Code SecretStorage）`,
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => value.trim() ? undefined : 'API Key 不能为空。'
  });
  if (apiKey === undefined) return null;

  await aiTestcaseService.saveApiKey(provider.id, apiKey);
  const configuration = vscode.workspace.getConfiguration('leetcodeCph');
  await configuration.update('ai.provider', provider.id, vscode.ConfigurationTarget.Global);
  await configuration.update('ai.model', model.trim(), vscode.ConfigurationTarget.Global);
  return { provider: provider.id, model: model.trim() || PROVIDERS[provider.id].defaultModel };
}

async function mutateTestCaseAndScaffold(type, payload) {
  const identity = await activeProblemIdentity();
  return withProblemLock(identity.folder, async () => {
    let context = await problemContextFromIdentity(identity);
    const ai = await configuredAiState();
    if (!ai.configured) {
      throw new Error(`未配置 ${providerInfo(ai.provider).label} API Key。请先点击“配置 AI”。`);
    }
    // Persist a one-time legacy metadata migration only while holding the
    // same lock as create/delete/capture, then snapshot both cases and
    // deletion tombstones for an exact rollback if AI generation fails.
    context = await ensurePersistedTestCases(context);
    const previousState = await loadTestCaseState(context.folder);
    context = { ...context, testCases: previousState.testCases };
    let changed;
    if (type === 'add') {
      changed = await createTestCase(context.folder, payload);
    } else if (type === 'delete') {
      changed = await deleteTestCase(context.folder, payload?.id);
    } else {
      throw new Error('未知的测试用例操作。');
    }

    const affected = type === 'add' ? changed.testCase : changed.deleted;
    try {
      const generated = await generateTestScaffold(context, changed.testCases, { type, testCase: affected });
      return { ...changed, generated };
    } catch (error) {
      // The testcase store writes before the remote AI call. Restore the exact
      // prior state (including LeetCode-deletion tombstones) when the call or
      // scaffold write fails, keeping local JSON and generated code in sync.
      await saveTestCases(context.folder, previousState.testCases, {
        excludedLeetCodeIds: previousState.excludedLeetCodeIds
      });
      throw error;
    }
  });
}

async function runSidebarAction(startMessage, action, successMessage) {
  sidebarProvider?.setState({ busy: true, notice: startMessage, error: '' });
  try {
    const result = await action();
    return refreshSidebar({ busy: false, notice: typeof successMessage === 'function' ? successMessage(result) : successMessage, error: '' });
  } catch (error) {
    const message = error?.message || '操作失败，请稍后重试。';
    outputChannel?.appendLine(`Sidebar action failed: ${error?.stack || message}`);
    return refreshSidebar({ busy: false, notice: '', error: message });
  }
}

function createSidebar() {
  return new LeetCodeCphSidebarProvider({
    onReady: () => refreshSidebar(),
    onAdd: (payload) => runSidebarAction('正在调用 AI 更新测试脚手架…', () => mutateTestCaseAndScaffold('add', payload), (result) => `已新增 ${result.testCase.name}，并更新 ${path.basename(result.generated.destination)}。`),
    onDelete: (payload) => runSidebarAction('正在调用 AI 更新测试脚手架…', () => mutateTestCaseAndScaffold('delete', payload), (result) => `已删除 ${result.deleted.name}，并更新 ${path.basename(result.generated.destination)}。`),
    onGenerateScaffold: () => runSidebarAction('正在生成测试脚手架…', async () => {
      const identity = await activeProblemIdentity();
      return withProblemLock(identity.folder, async () => {
        const context = await problemContextFromIdentity(identity);
        const generated = await generateTestScaffold(context, context.testCases, { type: 'initialize' });
        return { generated };
      });
    }, (result) => `已生成 ${path.basename(result.generated.destination)}。`),
    onSync: () => runSidebarAction('正在同步代码到 LeetCode…', () => syncActiveSolution(), (result) => result.duplicates ? `已同步到 LeetCode；另有 ${result.duplicates} 个同题标签未修改。` : '已同步代码到 LeetCode。'),
    onConfigure: () => runSidebarAction('正在配置 AI…', () => configureAi(), (result) => result ? `${providerInfo(result.provider).label} API Key 已安全保存。` : '已取消 AI 配置。'),
    onBugReport: () => runSidebarAction('正在打开 GitHub…', async () => {
      await vscode.env.openExternal(vscode.Uri.parse('https://github.com/dd1000001000/simple-leetcode-cph'));
      return {};
    }, '已打开 GitHub 仓库。')
  });
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
        const notice = saved.scaffoldStale
          ? `已保存 ${payload.title}；LeetCode 样例已变化，请更新测试脚手架。`
          : `已保存 ${payload.title} 的题目与测试用例。`;
        void refreshSidebar({ notice, error: '' });
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
  applyTracker = new ApplyTracker({ log: (line) => outputChannel.appendLine(line) });
  // API keys are deliberately held only by VS Code SecretStorage.  Unit-test
  // sandboxes may omit it, but a real ExtensionContext always provides it.
  aiTestcaseService = context.secrets ? createAiTestcaseService({ secrets: context.secrets }) : undefined;
  sidebarProvider = createSidebar();
  startServer();
  heartbeatTimer = setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);
  context.subscriptions.push(outputChannel, sidebarProvider, { dispose: () => { clearInterval(heartbeatTimer); server?.close(); } });
  if (typeof vscode.window.registerWebviewViewProvider === 'function') {
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(
      LeetCodeCphSidebarProvider.viewType,
      sidebarProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    ));
  }
  if (typeof vscode.window.onDidChangeActiveTextEditor === 'function') {
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => { void refreshSidebar(); }));
  }
  if (typeof vscode.workspace.onDidChangeConfiguration === 'function') {
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('leetcodeCph.ai') || event.affectsConfiguration('leetcodeCph.outputDirectory')) {
        void refreshSidebar();
      }
    }));
  }
  context.subscriptions.push(vscode.commands.registerCommand('leetcodeCph.openOutputFolder', async () => {
    const root = workspaceRoot();
    if (!root) return vscode.window.showWarningMessage('请先打开一个工作区文件夹。');
    const folder = path.join(root, config().outputDirectory || 'leetcode');
    await fs.mkdir(folder, { recursive: true });
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(folder));
  }));
  context.subscriptions.push(vscode.commands.registerCommand('leetcodeCph.showStatus', () => outputChannel.show()));
  void refreshSidebar();
}

function deactivate() {
  clearInterval(heartbeatTimer);
  applyTracker?.disposeAll('VS Code 扩展已停止。');
  sidebarProvider?.dispose();
  sidebarProvider = undefined;
  aiTestcaseService = undefined;
  for (const client of socketClients) client.socket.destroy();
  return new Promise((resolve) => server?.close(resolve) || resolve());
}
module.exports = { activate, deactivate };
