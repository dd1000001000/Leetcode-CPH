const vscode = require('vscode');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs/promises');

const { ApplyTracker } = require('./apply-tracker');
const { LeetCodeCphSidebarProvider } = require('./sidebar-provider');
const {
  TEST_CASES_FILE,
  LEETCODE_SOURCE,
  mergeAiExtractedTestCases,
  loadTestCaseState,
  loadTestCases,
  saveTestCases,
  createTestCase,
  updateTestCase,
  deleteTestCase
} = require('./testcase-store');
const {
  PROVIDERS,
  PROVIDER_IDS,
  createAiTestcaseService,
  normalizeProvider,
  providerInfo
} = require('./ai-testcase-service');
const {
  formatActualOutput,
  runAllTestCases,
  runSingleTestCase
} = require('./testcase-runner');

let server;
let outputChannel;
let applyTracker;
let sidebarProvider;
let aiTestcaseService;
const socketClients = new Set();
const problemLocks = new Map();
const approvedScaffoldHashes = new Map();
// The companion Edge extension intentionally uses this fixed loopback port.
// Keeping VS Code on the same fixed port avoids a configuration that looks
// supported on one side but silently disconnects capture/sync on the other.
const RECEIVER_PORT = 27121;
// Keep transient sidebar state outside refreshSidebar().  Captures and active
// editor changes can refresh the view while an AI mutation is in progress;
// recreating `busy: false` during that window would prematurely re-enable the
// add/delete buttons.
const sidebarRuntime = {
  busy: false,
  testcaseMutationBusy: false,
  runBusy: false,
  runningCaseId: '',
  testResults: {},
  resultFolder: '',
  notice: '',
  error: ''
};

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
  return { port: RECEIVER_PORT, outputDirectory: values.get('outputDirectory'), open: values.get('openSolutionAfterCapture') };
}

function resolveWorkspaceOutputDirectory(root, configuredDirectory) {
  const workspace = path.resolve(root);
  const relativeDirectory = String(configuredDirectory || 'leetcode').trim() || 'leetcode';
  if (path.isAbsolute(relativeDirectory)) {
    throw new Error('leetcodeCph.outputDirectory 必须是工作区内的相对路径。');
  }
  const resolved = path.resolve(workspace, relativeDirectory);
  const relative = path.relative(workspace, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('leetcodeCph.outputDirectory 不能指向工作区外的位置。');
  }
  return resolved;
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

function isLeetCodeProblemUrl(value) {
  try {
    const url = new URL(String(value));
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    return url.protocol === 'https:' && !url.port
      && (host === 'leetcode.com' || host === 'leetcode.cn')
      && /^\/problems\/[^/]+(?:\/|$)/i.test(url.pathname);
  } catch (_) {
    return false;
  }
}

function validPayload(value) {
  return value && typeof value === 'object' && typeof value.title === 'string' && value.title.trim()
    && typeof value.source === 'string' && isLeetCodeProblemUrl(value.source)
    && typeof value.code === 'string';
}

// Testcases saved by the pre-AI extension used `source: "leetcode"` for a
// brittle DOM/regex approximation.  Keep the store capable of reading that
// historical shape, but never surface those values in the product again: an
// automatic testcase must now come from the configured user's LLM key.
function withoutLegacyRawTestCases(values) {
  return Array.isArray(values)
    ? values.filter((testCase) => testCase?.source !== LEETCODE_SOURCE)
    : [];
}

async function loadSanitizedTestCaseState(problemFolder) {
  const state = await loadTestCaseState(problemFolder);
  const testCases = withoutLegacyRawTestCases(state.testCases);
  if (testCases.length === state.testCases.length) return state;
  await saveTestCases(problemFolder, testCases, {
    excludedAiIds: state.excludedAiIds,
    excludedLeetCodeIds: state.excludedLeetCodeIds
  });
  return { ...state, testCases };
}

async function extractCapturedTestCases(payload) {
  const ai = await configuredAiState();
  if (!ai.configured) {
    return {
      status: 'not-configured',
      testCases: undefined,
      provider: ai.provider,
      model: ai.model,
      message: `未配置 ${providerInfo(ai.provider).label} API Key，因此未生成测试用例。`
    };
  }
  try {
    const extracted = await aiTestcaseService.extractTestCases({
      metadata: payload,
      provider: ai.provider,
      model: ai.model
    });
    return {
      status: extracted.testCases.length ? 'extracted' : 'empty',
      testCases: extracted.testCases,
      provider: extracted.provider,
      model: extracted.model,
      message: extracted.testCases.length
        ? `AI 已从题面提取 ${extracted.testCases.length} 个测试用例。`
        : 'AI 未在题面中找到明确的输入/输出示例。'
    };
  } catch (error) {
    // Saving a problem must not fail merely because the optional remote AI
    // request is unavailable. A fresh capture remains empty (rather than
    // falling back to the old brittle DOM parser); existing AI/manual cases
    // are preserved until the user retries extraction.
    const message = String(error?.message || 'AI 提取测试用例失败。').slice(0, 800);
    outputChannel?.appendLine(`AI testcase extraction failed: ${message}`);
    return {
      status: 'failed',
      testCases: undefined,
      provider: ai.provider,
      model: ai.model,
      message
    };
  }
}

async function saveCapture(payload) {
  const root = workspaceRoot();
  if (!root) throw new Error('请先在 VS Code 打开一个工作区文件夹。');
  requireTrustedWorkspace('保存抓取的题目');
  const settings = config();
  const base = resolveWorkspaceOutputDirectory(root, settings.outputDirectory);
  const label = payload.problemId ? `${slug(payload.problemId)}-${slug(payload.title.replace(/^\d+\s*[.、-]?\s*/, ''))}` : slug(payload.title);
  const folder = path.join(base, label);
  const extension = languageExtension(payload.language);
  let solution = path.join(folder, `solution.${extension}`);
  const readme = path.join(folder, 'README.md');
  const metadata = path.join(folder, 'metadata.json');
  await fs.mkdir(folder, { recursive: true });

  const saved = await withProblemLock(folder, async () => {
    // Raw page examples are context only. The user's selected AI provider is
    // the sole source of automatic testcases; a missing key intentionally
    // yields no new cases instead of a brittle DOM-regex approximation.
    let previousMetadata = {};
    try { previousMetadata = JSON.parse(await readTextIfPresent(metadata)); } catch (_) { /* A fresh/corrupt legacy metadata file is replaced below. */ }
    const solutionCandidates = (await fs.readdir(folder, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /^solution\.[^.]+$/i.test(entry.name))
      .map((entry) => path.join(folder, entry.name));
    if (solutionCandidates.length > 1) {
      throw new Error('题目目录中存在多个 solution.* 文件。请保留一个解答文件后再重新抓取。');
    }
    const solutionCreated = solutionCandidates.length === 0;
    if (!solutionCreated) solution = solutionCandidates[0];
    // Re-capture refreshes problem context, never overwrites a user's local
    // answer. Use an open dirty buffer when present so any regenerated
    // scaffold targets exactly the code the user is currently editing.
    const solutionCode = solutionCreated ? payload.code : await readOpenDocumentOrFile(solution);
    const localLanguage = solutionCreated
      ? (payload.language || extension)
      : (previousMetadata.language || payload.language || path.extname(solution).slice(1));
    const previousState = await loadSanitizedTestCaseState(folder);
    const extraction = await extractCapturedTestCases(payload);
    const testCases = mergeAiExtractedTestCases(previousState.testCases, payload, extraction.testCases, {
      excludedAiIds: previousState.excludedAiIds
    });
    const testCasesChanged = JSON.stringify(previousState.testCases) !== JSON.stringify(testCases);
    const scaffold = path.join(folder, `testcase${path.extname(solution)}`);
    const hasScaffold = await fileExists(scaffold);
    let scaffoldStale = hasScaffold && (Boolean(previousMetadata.testcaseScaffoldStale) || testCasesChanged);
    const markdown = `# ${payload.title}\n\n- Source: ${payload.source}\n- Captured: ${payload.capturedAt || new Date().toISOString()}\n- Language: ${localLanguage || 'unknown'}\n\n## Problem\n\n${payload.description || '_题面未能从页面读取；可从 Source 链接查看。'}\n\n${payload.samples ? `## Examples\n\n${payload.samples}\n` : ''}`;
    const metadataDocument = {
      ...payload,
      code: solutionCode,
      language: localLanguage,
      savedAt: new Date().toISOString(),
      testcaseScaffoldStale: scaffoldStale,
      testcaseExtraction: {
        status: extraction.status,
        provider: extraction.provider,
        model: extraction.model,
        count: Array.isArray(extraction.testCases) ? extraction.testCases.length : undefined,
        message: extraction.message,
        at: new Date().toISOString()
      }
    };
    const writes = [
      fs.writeFile(readme, markdown, 'utf8'),
      fs.writeFile(metadata, JSON.stringify(metadataDocument, null, 2), 'utf8'),
      saveTestCases(folder, testCases, {
        excludedAiIds: previousState.excludedAiIds,
        excludedLeetCodeIds: previousState.excludedLeetCodeIds
      })
    ];
    if (solutionCreated) writes.push(fs.writeFile(solution, solutionCode, 'utf8'));
    await Promise.all(writes);
    let scaffoldGenerated = false;
    let scaffoldError = '';
    // A successful initial/re-capture extraction is immediately turned into a
    // scaffold, so the sidebar has runnable code without exposing a separate
    // maintenance button. Repeat capture is the retry path if generation
    // fails; existing handwritten framework is supplied to the model for
    // preservation when an update is necessary.
    // A successful extraction that returns no new examples must still be able
    // to generate a scaffold for manual cases saved before the user configured
    // an API key.  Failed/no-key extraction deliberately does not trigger a
    // model call, so it cannot manufacture cases or overwrite a scaffold.
    const extractionCompleted = extraction.status === 'extracted' || extraction.status === 'empty';
    const shouldGenerateScaffold = extractionCompleted && testCases.length
      && (!hasScaffold || scaffoldStale);
    if (shouldGenerateScaffold) {
      try {
        const generationContext = {
          folder,
          solutionPath: solution,
          solutionFileName: path.basename(solution),
          activeFilePath: solution,
          code: solutionCode,
          metadata: metadataDocument,
          title: payload.title,
          source: payload.source,
          language: localLanguage,
          testCases
        };
        await generateTestScaffold(generationContext, testCases, { type: 'initialize' });
        scaffoldGenerated = true;
        scaffoldStale = false;
      } catch (error) {
        scaffoldError = String(error?.message || 'AI 生成测试脚手架失败。').slice(0, 800);
        outputChannel?.appendLine(`Initial testcase scaffold generation failed: ${scaffoldError}`);
        // A first-generation failure has no old file to mark stale, but it is
        // still an unfinished scaffold state. Persist that fact so a later
        // sidebar refresh explains why run controls are unavailable.
        scaffoldStale = true;
        const failedMetadata = {
          ...metadataDocument,
          testcaseScaffoldStale: true,
          testcaseScaffoldError: scaffoldError
        };
        await writeTextAtomically(metadata, JSON.stringify(failedMetadata, null, 2)).catch((writeError) => {
          outputChannel?.appendLine(`Could not persist testcase scaffold failure state: ${writeError.message}`);
        });
      }
    }
    return { folder: path.relative(root, folder), solution, solutionCreated, scaffoldStale, scaffoldGenerated, scaffoldError, extraction };
  });
  outputChannel.appendLine(`Saved ${payload.title} → ${folder}`);
  if (settings.open) await vscode.window.showTextDocument(vscode.Uri.file(solution), { preview: false });
  return saved;
}

function respond(response, status, body) {
  // The companion extension has an explicit localhost host permission and
  // does not require permissive CORS. Omitting Access-Control-Allow-Origin
  // prevents arbitrary web pages from reading receiver responses.
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
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
const MAX_SOCKET_FRAME_BYTES = 65_535;
const MAX_SOCKET_BUFFER_BYTES = 128 * 1024;
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
  const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (client.buffer.length + input.length > MAX_SOCKET_BUFFER_BYTES) {
    removeClient(client, 'socket buffer too large');
    return;
  }
  client.buffer = Buffer.concat([client.buffer, input]);
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
    if (length > MAX_SOCKET_FRAME_BYTES) {
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
  // Read-only sidebar refreshes deliberately do not write migration data,
  // but they must still hide legacy regex-derived values. A later capture,
  // testcase mutation, or scaffold generation persists the cleanup under the
  // problem lock.
  if (exists) return withoutLegacyRawTestCases(saved);

  // Do not revive testcase data from legacy metadata. Earlier versions used a
  // fragile page regex; automatic cases now come only from a configured AI
  // extraction and a missing key must leave the new problem empty.
  return [];
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

function requireTrustedWorkspace(action) {
  // VS Code's Restricted Mode is the supported boundary for workspace code.
  // AI-generated scaffolds are executable source and must never be generated
  // or run when the user has explicitly marked the workspace untrusted.
  if (vscode.workspace.isTrusted === false) {
    throw new Error(`当前工作区未受信任，无法${action} AI 生成的测试脚手架。请在确认工作区安全后信任它再重试。`);
  }
}

async function confirmScaffoldExecution(scaffoldPath) {
  requireTrustedWorkspace('运行');
  // Confirm the bytes that the runner will execute, rather than a possibly
  // stale clean editor buffer. The runner checks this digest again directly
  // before spawning the process.
  const content = await fs.readFile(scaffoldPath);
  const fingerprint = crypto.createHash('sha256').update(content).digest('hex');
  const key = pathKey(scaffoldPath);
  if (approvedScaffoldHashes.get(key) === fingerprint) return fingerprint;
  const confirmLabel = '我已审阅，运行';
  // The API always exists in a real extension host. The conditional keeps the
  // small Node-only test harness from needing a full VS Code UI mock.
  if (typeof vscode.window.showWarningMessage === 'function') {
    const answer = await vscode.window.showWarningMessage(
      '测试脚手架由 AI 生成，将以当前用户权限运行。请先审阅 testcase.* 文件的改动。',
      { modal: true },
      confirmLabel
    );
    if (answer !== confirmLabel) {
      throw new Error('已取消运行。请审阅测试脚手架后再确认运行。');
    }
  }
  approvedScaffoldHashes.set(key, fingerprint);
  return fingerprint;
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
  const { testcaseScaffoldError, ...metadataWithoutError } = context.metadata;
  const nextMetadata = { ...metadataWithoutError, testcaseScaffoldStale: false };
  await writeTextAtomically(metadataPath, JSON.stringify(nextMetadata, null, 2));
  context.metadata = nextMetadata;
}

async function configuredAiState() {
  if (!aiTestcaseService) return { provider: 'glm', model: '', configured: false };
  const { provider, model } = aiConfig();
  const configuredProviders = await aiTestcaseService.getConfiguredProviders();
  return { provider, model, configured: Boolean(configuredProviders[provider]), configuredProviders };
}

async function extractTestCasesForContext(context) {
  if (!aiTestcaseService) throw new Error('AI 服务尚未初始化，请重新加载 VS Code 扩展。');
  const ai = await configuredAiState();
  if (!ai.configured) {
    throw new Error(`未配置 ${providerInfo(ai.provider).label} API Key。请先点击“配置 AI”。`);
  }
  const previousState = await loadSanitizedTestCaseState(context.folder);
  const extracted = await aiTestcaseService.extractTestCases({
    metadata: context.metadata,
    provider: ai.provider,
    model: ai.model
  });
  const testCases = mergeAiExtractedTestCases(previousState.testCases, context.metadata, extracted.testCases, {
    excludedAiIds: previousState.excludedAiIds
  });
  const changed = JSON.stringify(previousState.testCases) !== JSON.stringify(testCases);
  const hasScaffold = await fileExists(scaffoldFilePath(context));
  const nextMetadata = {
    ...context.metadata,
    testcaseScaffoldStale: hasScaffold && (Boolean(context.metadata?.testcaseScaffoldStale) || changed),
    testcaseExtraction: {
      status: extracted.testCases.length ? 'extracted' : 'empty',
      provider: extracted.provider,
      model: extracted.model,
      count: extracted.testCases.length,
      message: extracted.testCases.length
        ? `AI 已从题面提取 ${extracted.testCases.length} 个测试用例。`
        : 'AI 未在题面中找到明确的输入/输出示例。',
      at: new Date().toISOString()
    }
  };
  await Promise.all([
    saveTestCases(context.folder, testCases, {
      excludedAiIds: previousState.excludedAiIds,
      excludedLeetCodeIds: previousState.excludedLeetCodeIds
    }),
    writeTextAtomically(path.join(context.folder, 'metadata.json'), JSON.stringify(nextMetadata, null, 2))
  ]);
  return { ...context, metadata: nextMetadata, testCases, extraction: extracted, testCasesChanged: changed };
}

async function generateTestScaffold(context, testCases, operation) {
  if (!aiTestcaseService) throw new Error('AI 服务尚未初始化，请重新加载 VS Code 扩展。');
  if (!Array.isArray(testCases)) {
    throw new Error('测试用例数据无效，无法生成测试脚手架。');
  }
  if (operation?.type === 'initialize' && !testCases.length) {
    throw new Error('当前没有测试用例，无法生成测试脚手架。');
  }
  requireTrustedWorkspace('生成');
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
  const destinationExists = await fileExists(destination);
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
  // AI updates are intentionally recoverable.  A re-capture or testcase
  // mutation may need to replace an already saved scaffold, including one a
  // user has adjusted manually.  Keep one immediately-restorable copy before
  // the atomic replacement; if this write fails, leave the live scaffold
  // untouched instead of risking the user's local framework.
  const backup = destinationExists ? `${destination}.bak` : '';
  if (backup) await writeTextAtomically(backup, existingScaffold);
  await writeTextAtomically(destination, generated.content);
  approvedScaffoldHashes.delete(pathKey(destination));
  try {
    await markScaffoldFresh(context);
  } catch (error) {
    // The scaffold itself was written successfully.  Leaving the stale badge
    // visible is safer than reporting the entire mutation as failed and
    // rolling back its testcase JSON after the source file changed.
    outputChannel?.appendLine(`Could not clear testcase scaffold stale marker: ${error.message}`);
  }
  return { ...generated, destination, backup };
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

function setSidebarRuntime(patch = {}) {
  Object.assign(sidebarRuntime, patch);
  sidebarProvider?.setState({
    busy: sidebarRuntime.busy,
    testcaseMutationBusy: sidebarRuntime.testcaseMutationBusy,
    runBusy: sidebarRuntime.runBusy,
    runningCaseId: sidebarRuntime.runningCaseId,
    testResults: sidebarRuntime.testResults,
    notice: sidebarRuntime.notice,
    error: sidebarRuntime.error
  });
}

function clearRunResults(folder) {
  if (folder && sidebarRuntime.resultFolder && pathKey(folder) !== pathKey(sidebarRuntime.resultFolder)) return;
  sidebarRuntime.testResults = {};
  sidebarRuntime.resultFolder = '';
  sidebarProvider?.setState({ testResults: {} });
}

function runtimeStateFor(context) {
  const resultMatchesContext = Boolean(context && sidebarRuntime.resultFolder
    && pathKey(context.folder) === pathKey(sidebarRuntime.resultFolder));
  return {
    busy: sidebarRuntime.busy,
    testcaseMutationBusy: sidebarRuntime.testcaseMutationBusy,
    runBusy: sidebarRuntime.runBusy,
    runningCaseId: sidebarRuntime.runningCaseId,
    testResults: resultMatchesContext ? sidebarRuntime.testResults : {},
    notice: sidebarRuntime.notice,
    error: sidebarRuntime.error
  };
}

function sidebarProblemKey(context) {
  // The webview only needs a stable opaque scope for unsaved card drafts. Do
  // not expose the workspace's absolute folder path just to distinguish two
  // open problems.
  return crypto.createHash('sha256').update(pathKey(context.folder)).digest('hex').slice(0, 24);
}

async function sidebarState(extra = {}) {
  const empty = {
    problem: null,
    testCases: [],
    busy: false,
    testcaseMutationBusy: false,
    runBusy: false,
    runningCaseId: '',
    testResults: {},
    notice: '',
    error: ''
  };
  let context;
  try {
    context = await activeProblemContext({ required: false });
  } catch (error) {
    return { ...empty, ...runtimeStateFor(null), ...extra, error: extra.error || sidebarRuntime.error || error.message || '无法读取当前题目。' };
  }
  if (!context) return { ...empty, ...runtimeStateFor(null), ...extra };

  let aiStatus = 'AI：未初始化';
  let aiConfigured = false;
  try {
    const ai = await configuredAiState();
    const label = providerInfo(ai.provider).label;
    aiConfigured = ai.configured;
    aiStatus = `AI：${label}${ai.configured ? '（API Key 已安全保存）' : '（未配置 API Key）'}`;
  } catch (error) {
    aiStatus = 'AI：配置无效';
  }
  const hasScaffold = await fileExists(scaffoldFilePath(context));
  const runnerSupported = ['.py', '.js'].includes(path.extname(scaffoldFilePath(context)).toLowerCase());
  const scaffoldReady = hasScaffold && !context.metadata?.testcaseScaffoldStale;
  return {
    ...empty,
    ...runtimeStateFor(context),
    problem: {
      key: sidebarProblemKey(context),
      title: context.title,
      source: context.source,
      language: context.language,
      aiStatus,
      aiConfigured,
      scaffoldReady,
      runnerSupported,
      scaffoldStatus: context.metadata?.testcaseScaffoldStale
        ? context.metadata?.testcaseScaffoldError
          ? '测试脚手架生成失败；请重新抓取题目后重试。'
          : '测试脚手架需要更新'
        : hasScaffold ? runnerSupported
          ? '测试脚手架已生成，可运行测试。'
          : '测试脚手架已生成；本地运行目前仅支持 Python 和 JavaScript。' : ''
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

async function mutateTestCaseAndScaffold(type, payload, onPersisted) {
  const identity = await activeProblemIdentity();
  return withProblemLock(identity.folder, async () => {
    let context = await problemContextFromIdentity(identity);
    const ai = await configuredAiState();
    requireTrustedWorkspace('更新');
    // Persist the store while holding the same lock as capture and scaffold
    // writes. A remote model failure must never discard a user's add/edit/
    // delete; it merely leaves the generated scaffold marked stale for retry.
    context = await ensurePersistedTestCases(context);
    const previousState = await loadSanitizedTestCaseState(context.folder);
    const previousMetadata = context.metadata;
    context = { ...context, testCases: previousState.testCases };
    let metadataMarkedStale = false;
    if (await fileExists(scaffoldFilePath(context))) {
      // Invalidate before changing testcases.json. If a crash happens after
      // the testcase write, the old scaffold cannot be presented as runnable.
      const staleMetadata = { ...context.metadata, testcaseScaffoldStale: true };
      await writeTextAtomically(path.join(context.folder, 'metadata.json'), JSON.stringify(staleMetadata, null, 2));
      context.metadata = staleMetadata;
      metadataMarkedStale = true;
    }

    let changed;
    try {
      if (type === 'add') {
        changed = await createTestCase(context.folder, payload);
      } else if (type === 'update') {
        changed = await updateTestCase(context.folder, payload?.id, payload);
      } else if (type === 'delete') {
        changed = await deleteTestCase(context.folder, payload?.id);
      } else {
        throw new Error('未知的测试用例操作。');
      }
    } catch (error) {
      // No testcase mutation was persisted, so restore the otherwise
      // unnecessary stale marker when the local mutation itself failed.
      if (metadataMarkedStale) {
        await writeTextAtomically(path.join(context.folder, 'metadata.json'), JSON.stringify(previousMetadata, null, 2)).catch(() => {});
      }
      throw error;
    }

    const affected = type === 'delete' ? changed.deleted : changed.testCase;
    try {
      // Show the newly empty card (or remove a deleted one) immediately while
      // the model is updating testcase.*. Controls remain locked by the
      // durable testcaseMutationBusy state set by the caller.
      clearRunResults(context.folder);
      if (typeof onPersisted === 'function') await onPersisted({ ...changed, context });
      // Manual cases are useful even before an API key is configured.  They
      // are persisted as the user's own data, but we never fabricate or
      // regex-extract a scaffold in that situation.  The next capture after
      // configuration will use the selected model to generate/update it.
      if (!ai.configured) {
        throw new Error(`未配置 ${providerInfo(ai.provider).label} API Key，无法自动更新测试脚手架。请先点击“配置 AI”，再重新抓取题目。`);
      }
      const generated = await generateTestScaffold(context, changed.testCases, { type, testCase: affected });
      return { ...changed, generated };
    } catch (error) {
      // The testcase change is already durable. Preserve it and mark the
      // scaffold stale so the user can retry by re-capturing the problem,
      // without losing work or accidentally running old code.
      const detail = error?.message || '未知错误。';
      outputChannel?.appendLine(`Testcase scaffold update failed after saving testcase data: ${detail}`);
      const failedMetadata = {
        ...context.metadata,
        testcaseScaffoldStale: true,
        testcaseScaffoldError: detail
      };
      await writeTextAtomically(path.join(context.folder, 'metadata.json'), JSON.stringify(failedMetadata, null, 2)).catch((writeError) => {
        outputChannel?.appendLine(`Could not persist testcase scaffold failure state: ${writeError.message}`);
      });
      throw new Error(`测试用例已保存，但测试脚手架更新失败。请重新抓取题目后重试。原因：${detail}`);
    }
  });
}

function testcaseHasRunnableData(testCase) {
  // A zero-argument call can have an empty input, and an assertion can
  // legitimately expect an empty output. Only a brand-new card whose two
  // fields are both untouched is a non-runnable draft. Do not trim: leading
  // and trailing whitespace may be meaningful testcase data.
  return String(testCase?.input ?? '').replace(/\r\n?/g, '\n') !== ''
    || String(testCase?.expectedOutput ?? '').replace(/\r\n?/g, '\n') !== '';
}

function comparableOutput(value) {
  const text = String(value == null ? '' : value).replace(/\r\n?/g, '\n');
  if (!text) return '';
  try {
    return JSON.stringify(JSON.parse(text));
  } catch (_) {
    return text;
  }
}

function sidebarResultsFromRun(testCases, rawResults, selectedName) {
  const selected = selectedName ? new Set([selectedName]) : null;
  const results = {};
  for (const testCase of testCases) {
    if (!testcaseHasRunnableData(testCase)) continue;
    if (selected && !selected.has(testCase.name)) continue;
    const result = rawResults?.[testCase.name];
    if (!result) {
      results[testCase.id] = {
        status: 'error',
        error: '测试脚手架未返回此测试用例的结果。请重新生成测试脚手架。'
      };
      continue;
    }
    const actualOutput = formatActualOutput(result.actual);
    if (result.error) {
      results[testCase.id] = { status: 'error', actualOutput, error: result.error };
      continue;
    }
    const outputsMatch = comparableOutput(actualOutput) === comparableOutput(testCase.expectedOutput);
    // Some LeetCode problems legitimately have multiple valid outputs. The
    // generated scaffold can apply the problem-specific semantic comparison,
    // so its explicit boolean takes precedence; textual comparison remains a
    // safe fallback and still drives the visible expected/actual difference.
    const passed = typeof result.passed === 'boolean' ? result.passed : outputsMatch;
    results[testCase.id] = {
      status: passed ? 'passed' : 'failed',
      passed,
      actualOutput,
      different: !outputsMatch
    };
  }
  return results;
}

async function runTestsFromSidebar(mode, payload) {
  const identity = await activeProblemIdentity();
  return withProblemLock(identity.folder, async () => {
    const context = await problemContextFromIdentity(identity);
    requireTrustedWorkspace('运行');
    if (context.metadata?.testcaseScaffoldStale) {
      throw new Error('测试脚手架需要更新。请重新抓取题目后再运行测试。');
    }
    const scaffold = scaffoldFilePath(context);
    if (!await fileExists(scaffold)) {
      throw new Error('尚未生成测试脚手架。请配置 API Key 后重新抓取题目。');
    }
    const solutionDocument = openTextDocument(context.solutionPath);
    const scaffoldDocument = openTextDocument(scaffold);
    if (solutionDocument?.isDirty || scaffoldDocument?.isDirty) {
      throw new Error('请先保存 solution.* 与 testcase.* 的手动编辑，再运行测试。');
    }
    let selected;
    if (mode === 'case') {
      selected = context.testCases.find((testCase) => testCase.id === payload?.id);
      if (!selected) throw new Error('未找到要运行的测试用例。');
      if (!testcaseHasRunnableData(selected)) {
        throw new Error('请先填写该测试用例的输入和预期输出。');
      }
    } else if (!context.testCases.some(testcaseHasRunnableData)) {
      throw new Error('请至少填写一个测试用例的输入和预期输出。');
    }
    const expectedScaffoldHash = await confirmScaffoldExecution(scaffold);
    const runnableCaseNames = context.testCases
      .filter(testcaseHasRunnableData)
      .map((testCase) => testCase.name);
    const execution = mode === 'case'
      ? await runSingleTestCase({
        problemFolder: context.folder,
        scaffoldPath: scaffold,
        expectedCaseNames: [selected.name],
        expectedScaffoldHash
      }, selected.name)
      : await runAllTestCases({
        problemFolder: context.folder,
        scaffoldPath: scaffold,
        expectedCaseNames: runnableCaseNames,
        expectedScaffoldHash
      });
    return { context, execution, selectedName: selected?.name || '' };
  });
}

async function runSidebarTests(mode, payload) {
  const runningCaseId = mode === 'case' ? String(payload?.id || '') : '';
  const preserved = mode === 'case' && sidebarRuntime.resultFolder
    ? { ...sidebarRuntime.testResults }
    : {};
  if (runningCaseId) delete preserved[runningCaseId];
  setSidebarRuntime({
    busy: true,
    testcaseMutationBusy: false,
    runBusy: true,
    runningCaseId,
    testResults: preserved,
    notice: mode === 'case' ? '正在运行测试用例…' : '正在运行全部测试用例…',
    error: ''
  });
  try {
    const result = await runTestsFromSidebar(mode, payload);
    const fresh = sidebarResultsFromRun(result.context.testCases, result.execution.results, result.selectedName);
    const merged = mode === 'case' && sidebarRuntime.resultFolder && pathKey(sidebarRuntime.resultFolder) === pathKey(result.context.folder)
      ? { ...sidebarRuntime.testResults, ...fresh }
      : fresh;
    setSidebarRuntime({
      busy: false,
      runBusy: false,
      runningCaseId: '',
      testResults: merged,
      resultFolder: result.context.folder,
      notice: result.execution.ok
        ? (mode === 'case' ? '测试用例运行完成。' : '全部测试用例运行完成。')
        : `测试脚手架异常结束；已显示已返回的测试结果。${result.execution.error ? ` ${result.execution.error}` : ''}`,
      error: ''
    });
    return refreshSidebar();
  } catch (error) {
    const message = error?.message || '运行测试失败，请稍后重试。';
    outputChannel?.appendLine(`Sidebar test run failed: ${error?.stack || message}`);
    setSidebarRuntime({ busy: false, runBusy: false, runningCaseId: '', notice: '', error: message });
    return refreshSidebar();
  }
}

async function runSidebarAction(startMessage, action, successMessage, { testcaseMutation = false } = {}) {
  setSidebarRuntime({
    busy: true,
    testcaseMutationBusy: testcaseMutation,
    runBusy: false,
    runningCaseId: '',
    notice: startMessage,
    error: ''
  });
  try {
    const result = await action();
    setSidebarRuntime({
      busy: false,
      testcaseMutationBusy: false,
      notice: typeof successMessage === 'function' ? successMessage(result) : successMessage,
      error: ''
    });
    return refreshSidebar();
  } catch (error) {
    const message = error?.message || '操作失败，请稍后重试。';
    outputChannel?.appendLine(`Sidebar action failed: ${error?.stack || message}`);
    setSidebarRuntime({ busy: false, testcaseMutationBusy: false, notice: '', error: message });
    return refreshSidebar();
  }
}

function createSidebar() {
  const updateAfterPersist = () => refreshSidebar();
  return new LeetCodeCphSidebarProvider({
    onReady: () => refreshSidebar(),
    onAdd: (payload) => runSidebarAction(
      '正在调用 AI 更新测试脚手架…',
      () => mutateTestCaseAndScaffold('add', payload, updateAfterPersist),
      (result) => `已新增 ${result.testCase.name}，并更新 ${path.basename(result.generated.destination)}。`,
      { testcaseMutation: true }
    ),
    onUpdate: (payload) => runSidebarAction(
      '正在调用 AI 更新测试脚手架…',
      () => mutateTestCaseAndScaffold('update', payload, updateAfterPersist),
      (result) => `已更新 ${result.testCase.name}，并更新 ${path.basename(result.generated.destination)}。`,
      { testcaseMutation: true }
    ),
    onDelete: (payload) => runSidebarAction(
      '正在调用 AI 更新测试脚手架…',
      () => mutateTestCaseAndScaffold('delete', payload, updateAfterPersist),
      (result) => `已删除 ${result.deleted.name}，并更新 ${path.basename(result.generated.destination)}。`,
      { testcaseMutation: true }
    ),
    onRunTestCase: (payload) => runSidebarTests('case', payload),
    onRunAllTestCases: () => runSidebarTests('all'),
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
        const extractionNotice = saved.extraction?.message || '未生成测试用例。';
        const scaffoldNotice = saved.scaffoldError
          ? `测试脚手架生成失败：${saved.scaffoldError}`
          : saved.scaffoldGenerated ? '已自动生成测试脚手架。'
            : saved.scaffoldStale ? '测试脚手架需要更新。' : '';
        const notice = `已保存 ${payload.title}；${extractionNotice}${scaffoldNotice ? ` ${scaffoldNotice}` : ''}`;
        clearRunResults();
        setSidebarRuntime({ notice, error: '' });
        void refreshSidebar();
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
  if (typeof vscode.workspace.onDidChangeTextDocument === 'function') {
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
      const filePath = event?.document?.uri?.scheme === 'file' ? event.document.uri.fsPath : '';
      const name = path.basename(filePath || '');
      if (/^(?:solution|testcase)\.[^.]+$/i.test(name)) {
        clearRunResults(path.dirname(filePath));
        void refreshSidebar();
      }
    }));
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
    let folder;
    try {
      folder = resolveWorkspaceOutputDirectory(root, config().outputDirectory);
    } catch (error) {
      return vscode.window.showErrorMessage(error.message || '输出目录配置无效。');
    }
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
