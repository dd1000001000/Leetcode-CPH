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
  runSingleTestCase,
  supportsLanguage
} = require('./testcase-runner');

let server;
let outputChannel;
let applyTracker;
let sidebarProvider;
let aiTestcaseService;
let extensionStoragePath = '';
const socketClients = new Set();
const problemLocks = new Map();
const solutionRecordCache = new Map();
const activeCaptureJobs = new Set();
const supersededCaptureJobs = new Set();
// Per-problem reference counts prevent overlapping callers from clearing each
// other's busy state. A regenerate request can be queued behind a mutation,
// so a plain Set/delete pair is not sufficient ownership tracking.
const activeTestcaseAiJobs = new Map();
// The companion Edge extension intentionally uses this fixed loopback port.
// Keeping VS Code on the same fixed port avoids a configuration that looks
// supported on one side but silently disconnects capture/sync on the other.
const RECEIVER_PORT = 27121;
// edge-extension/manifest.json contains a fixed public key, so its unpacked
// Chromium extension ID is stable. Restrict the loopback receiver to that
// exact extension origin: ordinary web pages can otherwise open localhost
// WebSockets regardless of CORS and receive solution code sent by Sync.
const COMPANION_EXTENSION_ID = 'lenchpcbgdkafhhfoeobicafbfhgklna';
const COMPANION_EXTENSION_ORIGIN = `chrome-extension://${COMPANION_EXTENSION_ID}`;
const SIDEBAR_NOTICE_TIMEOUT_MS = 15_000;
const SIDEBAR_ERROR_TIMEOUT_MS = 15_000;
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
  noticeRevision: 0,
  error: '',
  errorRevision: 0
};

const EXTENSIONS = {
  c: 'c', cpp: 'cpp', 'c++': 'cpp', java: 'java', python: 'py', python3: 'py',
  javascript: 'js', typescript: 'ts', go: 'go', golang: 'go', rust: 'rs',
  csharp: 'cs', 'c#': 'cs', kotlin: 'kt', swift: 'swift', ruby: 'rb', php: 'php',
  scala: 'scala', haskell: 'hs', sql: 'sql'
};

function slug(value) {
  return String(value || 'untitled-problem')
    .normalize('NFKD').replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, '-').replace(/-+/g, '-')
    .replace(/^-|-$/g, '').slice(0, 100) || 'untitled-problem';
}

function problemFileStem(value, fallback = 'LeetCode Problem') {
  let result = String(value || fallback)
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/-+/g, '-')
    .replace(/[. ]+$/g, '')
    .trim();
  if (!result) result = fallback;
  // Windows device names remain reserved even when an extension is present.
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result)) result = `_${result}`;
  return result.slice(0, 120).replace(/[. ]+$/g, '') || fallback;
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

function workspaceFolders() {
  const folders = Array.isArray(vscode.workspace.workspaceFolders)
    ? vscode.workspace.workspaceFolders
    : [];
  if (folders.length) {
    return folders
      .filter((folder) => (!folder?.uri?.scheme || folder.uri.scheme === 'file') && typeof folder?.uri?.fsPath === 'string')
      .map((folder) => {
        const serialized = typeof folder.uri.toString === 'function' ? folder.uri.toString() : '';
        return {
          path: path.resolve(folder.uri.fsPath),
          uri: serialized && serialized !== '[object Object]' ? serialized : ''
        };
      });
  }
  return vscode.workspace.rootPath
    ? [{ path: path.resolve(vscode.workspace.rootPath), uri: '' }]
    : [];
}

function workspaceRoot() {
  return workspaceFolders()[0]?.path || '';
}

function workspaceFolderForPath(filePath) {
  const resolved = path.resolve(filePath);
  return workspaceFolders()
    .filter((folder) => isPathInside(folder.path, resolved))
    .sort((left, right) => right.path.length - left.path.length)[0];
}

function initializeExtensionStorage(context) {
  const workspaceSpecific = context?.storageUri?.fsPath;
  if (workspaceSpecific) {
    extensionStoragePath = path.resolve(workspaceSpecific);
  } else {
    const globalRoot = context?.globalStorageUri?.fsPath;
    const root = workspaceRoot();
    // A real ExtensionContext always provides globalStorageUri. The fallback
    // keeps lightweight extension-host tests and compatible hosts functional
    // without ever placing private state inside the user's workspace.
    if (!globalRoot) {
      if (!root) throw new Error('当前窗口没有可用的工作区私有存储。请先打开文件夹并重新加载 VS Code。');
      const environment = typeof process === 'object' && process?.env ? process.env : {};
      const temporaryRoot = environment.TEMP || environment.TMP || environment.TMPDIR || path.dirname(root);
      const fallbackKey = crypto.createHash('sha256').update(pathKey(root)).digest('hex').slice(0, 32);
      extensionStoragePath = path.join(temporaryRoot, 'leetcode-cph-private', fallbackKey);
      solutionRecordCache.clear();
      return extensionStoragePath;
    }
    const workspaceKey = root
      ? crypto.createHash('sha256').update(pathKey(root)).digest('hex').slice(0, 32)
      : 'empty-window';
    extensionStoragePath = path.join(globalRoot, 'workspaces', workspaceKey);
  }
  solutionRecordCache.clear();
  return extensionStoragePath;
}

function config() {
  const values = vscode.workspace.getConfiguration('leetcodeCph');
  return { port: RECEIVER_PORT, outputDirectory: values.get('outputDirectory'), open: values.get('openSolutionAfterCapture') };
}

function resolveWorkspaceOutputDirectory(root, configuredDirectory) {
  const workspace = path.resolve(root);
  const relativeDirectory = String(configuredDirectory || 'leetcode').trim() || 'leetcode';
  const resolved = path.resolve(workspace, relativeDirectory);
  const relative = path.relative(workspace, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('leetcodeCph.outputDirectory 不能指向工作区外的位置。');
  }
  return resolved;
}

function captureProblemSlug(payload) {
  try {
    const fromUrl = new URL(String(payload?.source || payload?.problemUrl || '')).pathname
      .match(/\/problems\/([^/?#]+)/i)?.[1]?.toLowerCase() || '';
    if (fromUrl) return fromUrl;
  } catch (_) { /* Fall back to an explicit legacy slug. */ }
  return String(payload?.problemSlug || '').trim().toLowerCase();
}

async function captureProblemFolder(base, payload) {
  const problemSlug = captureProblemSlug(payload);

  // Reuse directories created by older versions (for example
  // `1-two-sum`) so the stable slug migration does not split one problem
  // across two folders. Metadata is authoritative; folder names are not.
  let entries = [];
  try {
    entries = await fs.readdir(base, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const matches = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(base, entry.name);
    try {
      const metadata = JSON.parse(await fs.readFile(path.join(candidate, 'metadata.json'), 'utf8'));
      if (captureProblemSlug(metadata) === problemSlug) {
        matches.push({ folder: candidate, savedAt: Date.parse(metadata.savedAt || metadata.capturedAt || 0) || 0 });
      }
    } catch (_) { /* An unrelated/corrupt directory is not a match. */ }
  }
  matches.sort((left, right) => right.savedAt - left.savedAt || left.folder.localeCompare(right.folder));
  // A directory name alone is never proof of identity. It may be a user's
  // unrelated folder or a stale directory whose metadata belongs to another
  // problem, so only matching metadata is eligible for migration.
  return matches[0]?.folder || '';
}

function isPathInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function requireExtensionStoragePath() {
  if (!extensionStoragePath) {
    throw new Error('LeetCode CPH 私有存储尚未初始化，请重新加载 VS Code 窗口。');
  }
  return extensionStoragePath;
}

function captureRecordKey(payload, extension) {
  const identity = captureProblemSlug(payload) || String(payload?.title || 'untitled-problem').trim().toLowerCase();
  return crypto.createHash('sha256').update(`${identity}\0${extension}`).digest('hex').slice(0, 32);
}

function captureStorageFolder(payload, extension) {
  return path.join(requireExtensionStoragePath(), 'problems', captureRecordKey(payload, extension));
}

function localStateFolderForSolution(solutionPath) {
  const identity = crypto.createHash('sha256').update(pathKey(solutionPath)).digest('hex').slice(0, 32);
  return path.join(requireExtensionStoragePath(), 'local-problems', identity);
}

function captureJobKey(problemFolder, captureRevision) {
  return `${pathKey(problemFolder)}\0${String(captureRevision || '')}`;
}

function captureJobActiveForFolder(problemFolder) {
  const prefix = `${pathKey(problemFolder)}\0`;
  for (const key of activeCaptureJobs) {
    if (key.startsWith(prefix) && !supersededCaptureJobs.has(key)) return true;
  }
  return false;
}

function supersedeOlderCaptureJobs(problemFolder, currentRevision) {
  const prefix = `${pathKey(problemFolder)}\0`;
  const currentKey = captureJobKey(problemFolder, currentRevision);
  for (const key of activeCaptureJobs) {
    if (key.startsWith(prefix) && key !== currentKey) supersededCaptureJobs.add(key);
  }
}

function beginTestcaseAiJob(identityKey) {
  activeTestcaseAiJobs.set(identityKey, (activeTestcaseAiJobs.get(identityKey) || 0) + 1);
}

function endTestcaseAiJob(identityKey) {
  const remaining = (activeTestcaseAiJobs.get(identityKey) || 0) - 1;
  if (remaining > 0) activeTestcaseAiJobs.set(identityKey, remaining);
  else activeTestcaseAiJobs.delete(identityKey);
}

function reservedSolutionFileName(filePath) {
  return /^(?:main|testcase)\.[^.]+$/i.test(path.basename(String(filePath || '')));
}

function metadataSolutionPath(metadata) {
  const roots = workspaceFolders();
  const absolute = String(metadata?.solutionPath || '').trim();
  if (absolute) {
    const resolved = path.resolve(absolute);
    if (!roots.length || roots.some((root) => isPathInside(root.path, resolved))) return resolved;
  }

  const relative = String(metadata?.solutionRelativePath || '').trim();
  if (!relative) return '';
  const storedRootPath = String(metadata?.workspaceRootPath || '').trim();
  const storedRootUri = String(metadata?.workspaceFolderUri || '').trim();
  let root = storedRootUri ? roots.find((candidate) => candidate.uri === storedRootUri) : undefined;
  if (!root && storedRootPath) {
    root = roots.find((candidate) => pathKey(candidate.path) === pathKey(storedRootPath));
  }
  // Records written before workspace identity was persisted are safe to
  // reinterpret only when the window contains a single folder. In a
  // multi-root workspace the same relative filename can exist in every root.
  if (!root && !storedRootPath && !storedRootUri && roots.length === 1) root = roots[0];
  if (!root) return '';
  const resolved = path.resolve(root.path, relative);
  return isPathInside(root.path, resolved) ? resolved : '';
}

function cacheSolutionRecord(solutionPath, problemFolder) {
  if (!solutionPath || !problemFolder) return;
  const folder = path.resolve(problemFolder);
  const solution = path.resolve(solutionPath);
  solutionRecordCache.set(pathKey(solution), folder);
  const extension = path.extname(solution);
  if (extension) solutionRecordCache.set(pathKey(path.join(path.dirname(solution), `main${extension}`)), folder);
}

function clearCachedProblemFolder(problemFolder) {
  const folderKey = pathKey(problemFolder);
  for (const [solutionKey, cachedFolder] of solutionRecordCache) {
    if (pathKey(cachedFolder) === folderKey) solutionRecordCache.delete(solutionKey);
  }
}

async function listStoredProblemRecords() {
  if (!extensionStoragePath) return [];

  const recordsRoot = path.join(extensionStoragePath, 'problems');
  let entries = [];
  try {
    entries = await fs.readdir(recordsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const records = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const folder = path.join(recordsRoot, entry.name);
    try {
      const metadata = JSON.parse(await fs.readFile(path.join(folder, 'metadata.json'), 'utf8'));
      const recordedSolution = metadataSolutionPath(metadata);
      if (!recordedSolution) continue;
      records.push({ folder, metadata, solutionPath: recordedSolution });
    } catch (_) { /* Ignore incomplete records; another capture can repair them. */ }
  }
  return records;
}

async function storedRecordOwnsSolution(problemFolder, solutionPath) {
  if (!extensionStoragePath || !problemFolder || !solutionPath) return false;
  const recordsRoot = path.resolve(extensionStoragePath, 'problems');
  const folder = path.resolve(problemFolder);
  if (pathKey(path.dirname(folder)) !== pathKey(recordsRoot)) return false;
  try {
    const metadata = JSON.parse(await fs.readFile(path.join(folder, 'metadata.json'), 'utf8'));
    const recordedSolution = metadataSolutionPath(metadata);
    return Boolean(recordedSolution && pathKey(recordedSolution) === pathKey(solutionPath));
  } catch (_) {
    return false;
  }
}

async function storedRecordOwnsArtifact(problemFolder, artifactPath) {
  if (!extensionStoragePath || !problemFolder || !artifactPath) return false;
  const recordsRoot = path.resolve(extensionStoragePath, 'problems');
  const folder = path.resolve(problemFolder);
  if (pathKey(path.dirname(folder)) !== pathKey(recordsRoot)) return false;
  try {
    const metadata = JSON.parse(await fs.readFile(path.join(folder, 'metadata.json'), 'utf8'));
    const solution = metadataSolutionPath(metadata);
    if (!solution) return false;
    const artifact = path.resolve(artifactPath);
    if (pathKey(artifact) === pathKey(solution)) return true;
    const expectedMain = path.join(path.dirname(solution), `main${path.extname(solution)}`);
    return pathKey(artifact) === pathKey(expectedMain);
  } catch (_) {
    return false;
  }
}

async function findStoredProblemFolderBySolution(solutionPath) {
  const key = pathKey(solutionPath);
  const cached = solutionRecordCache.get(key);
  if (cached) {
    if (await storedRecordOwnsSolution(cached, solutionPath)) return cached;
    solutionRecordCache.delete(key);
  }
  const records = await listStoredProblemRecords();
  for (const record of records) {
    if (pathKey(record.solutionPath) !== key) continue;
    // Revalidate after the scan. A same-title capture can move a record to the
    // private overwrite archive while this asynchronous directory walk is in
    // progress; such a stale result must never be put back into the cache.
    if (!await storedRecordOwnsSolution(record.folder, solutionPath)) continue;
    cacheSolutionRecord(solutionPath, record.folder);
    return record.folder;
  }
  return '';
}

async function findStoredProblemFolderByArtifact(artifactPath) {
  const key = pathKey(artifactPath);
  const cached = solutionRecordCache.get(key);
  if (cached) {
    if (await storedRecordOwnsArtifact(cached, artifactPath)) return cached;
    solutionRecordCache.delete(key);
  }
  // A registered solution may be renamed by the user. The metadata path is
  // the durable identity; relying on a literal solution.* basename makes the
  // record disappear after an extension-host restart, once the in-memory
  // cache is gone. Scan and revalidate both the recorded solution and its
  // sibling main for every artifact name.
  const records = await listStoredProblemRecords();
  for (const record of records) {
    if (pathKey(record.solutionPath) === key) {
      if (!await storedRecordOwnsArtifact(record.folder, artifactPath)) continue;
      cacheSolutionRecord(record.solutionPath, record.folder);
      return record.folder;
    }
    const expectedMain = path.join(path.dirname(record.solutionPath), `main${path.extname(record.solutionPath)}`);
    if (pathKey(expectedMain) !== key) continue;
    if (!await storedRecordOwnsArtifact(record.folder, artifactPath)) continue;
    cacheSolutionRecord(record.solutionPath, record.folder);
    return record.folder;
  }
  return '';
}

async function storedProblemFoldersForDirectory(problemDirectory) {
  const directoryKey = pathKey(problemDirectory);
  const records = await listStoredProblemRecords();
  return records
    .filter((record) => pathKey(path.dirname(record.solutionPath)) === directoryKey)
    .sort((left, right) => {
      const rightTime = Date.parse(right.metadata?.savedAt || right.metadata?.capturedAt || 0) || 0;
      const leftTime = Date.parse(left.metadata?.savedAt || left.metadata?.capturedAt || 0) || 0;
      return rightTime - leftTime || left.folder.localeCompare(right.folder);
    });
}

function primaryProblemDirectory(base, payload) {
  const stem = problemFileStem(payload?.title, captureProblemSlug(payload) || 'LeetCode Problem');
  return path.join(base, stem);
}

function primarySolutionPath(base, payload, extension) {
  return path.join(primaryProblemDirectory(base, payload), `solution.${extension}`);
}

async function visibleSolutionPath(base, payload, extension, previousMetadata = {}, currentProblemFolder = '') {
  const primary = primarySolutionPath(base, payload, extension);
  const primaryDirectory = path.dirname(primary);
  const primaryOwners = await storedProblemFoldersForDirectory(primaryDirectory);
  const primaryOwner = primaryOwners[0]?.folder || '';
  const previous = metadataSolutionPath(previousMetadata);
  // A different registered problem already owns this title directory. The
  // user's collision policy is last capture wins, including across languages,
  // so claim the canonical directory instead of creating a slug suffix.
  if (primaryOwner && (!currentProblemFolder || pathKey(primaryOwner) !== pathKey(currentProblemFolder))) {
    return primary;
  }
  if (Number(previousMetadata.storageSchemaVersion) >= 2
    && previous
    && workspaceFolderForPath(previous)
    && /^solution\.[^.]+$/i.test(path.basename(previous))
    && path.extname(previous).toLowerCase() === `.${extension}`.toLowerCase()) {
    return previous;
  }

  if (!await fileExists(primaryDirectory)) return primary;
  if (primaryOwner) return primary;

  // An unregistered directory may be ordinary user data. Preserve the entire
  // directory; the overwrite rule applies only when a private ownership record
  // proves it came from this extension.
  const stem = problemFileStem(payload?.title, captureProblemSlug(payload) || 'LeetCode Problem');
  const identitySuffix = problemFileStem(captureProblemSlug(payload), 'leetcode').slice(0, 48);
  const alternateDirectory = path.join(base, `${stem} (${identitySuffix})`);
  const alternate = path.join(alternateDirectory, `solution.${extension}`);
  if (!await fileExists(alternateDirectory)) return alternate;
  for (let index = 2; index < 10_000; index += 1) {
    const candidateDirectory = path.join(base, `${stem} (${identitySuffix} ${index})`);
    if (!await fileExists(candidateDirectory)) return path.join(candidateDirectory, `solution.${extension}`);
  }
  throw new Error('无法为题目创建唯一的目录名称。');
}

function aiConfig() {
  const values = vscode.workspace.getConfiguration('leetcodeCph');
  const provider = normalizeProvider(values.get('ai.provider') || 'glm');
  return { provider, model: String(values.get('ai.model') || '').trim() };
}

// Capture requests and sidebar mutations can arrive independently.  Serialize
// every read-modify-write operation for one problem directory so a quick
// double-click, an AI rollback, or a re-capture cannot overwrite another
// operation's testcases.json or visible main.* file.
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

function withProblemLocks(problemFolders, operation) {
  const folders = [...new Map(
    (problemFolders || []).filter(Boolean).map((folder) => [pathKey(folder), path.resolve(folder)])
  ).values()].sort((left, right) => pathKey(left).localeCompare(pathKey(right)));
  const acquire = (index) => index >= folders.length
    ? operation()
    : withProblemLock(folders[index], () => acquire(index + 1));
  return acquire(0);
}

async function archiveOverwrittenProblemRecord(problemFolder) {
  if (!problemFolder) return '';
  const recordsRoot = path.resolve(requireExtensionStoragePath(), 'problems');
  const resolved = path.resolve(problemFolder);
  if (pathKey(path.dirname(resolved)) !== pathKey(recordsRoot)) {
    throw new Error('拒绝覆盖私有存储范围外的题目记录。');
  }
  const archiveRoot = path.join(requireExtensionStoragePath(), 'overwritten');
  await fs.mkdir(archiveRoot, { recursive: true });
  const suffix = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const destination = path.join(archiveRoot, `${path.basename(resolved)}-${suffix}`);
  let captureRevision = '';
  try {
    const metadata = JSON.parse(await fs.readFile(path.join(resolved, 'metadata.json'), 'utf8'));
    captureRevision = String(metadata?.captureRevision || '');
  } catch (_) { /* An incomplete record can still be archived safely. */ }
  try {
    await fs.rename(resolved, destination);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      clearCachedProblemFolder(resolved);
      return '';
    }
    throw error;
  }
  clearCachedProblemFolder(resolved);
  const jobKey = captureRevision ? captureJobKey(resolved, captureRevision) : '';
  if (jobKey && activeCaptureJobs.has(jobKey)) supersededCaptureJobs.add(jobKey);
  return destination;
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
  const settings = config();
  const base = resolveWorkspaceOutputDirectory(root, settings.outputDirectory);
  const extension = languageExtension(payload.language);
  const folder = captureStorageFolder(payload, extension);
  const metadata = path.join(folder, 'metadata.json');
  const captureCoordinator = path.join(requireExtensionStoragePath(), '.capture-coordinator');
  const saved = await withProblemLock(captureCoordinator, async () => {
    // Queue the capture before the first asynchronous filesystem/configuration
    // operation. This preserves request order and prevents another same-title
    // capture from archiving this record between mkdir and the actual commit.
    await Promise.all([fs.mkdir(base, { recursive: true }), fs.mkdir(folder, { recursive: true })]);
    let ai = { provider: 'glm', model: '', configured: false };
    try {
      ai = await configuredAiState();
    } catch (error) {
      outputChannel?.appendLine(`Could not read AI configuration during capture: ${error.message}`);
    }
    const registeredPrimaryOwners = await storedProblemFoldersForDirectory(
      primaryProblemDirectory(base, payload)
    );
    return withProblemLocks([folder, ...registeredPrimaryOwners.map((record) => record.folder)], async () => {
    let previousMetadata = {};
    let previousState;
    let legacyFolder = '';
    const metadataSnapshot = await snapshotFile(metadata);
    const testCasesPath = path.join(folder, TEST_CASES_FILE);
    const testCasesSnapshot = await snapshotFile(testCasesPath);
    try {
      if (metadataSnapshot.exists) previousMetadata = JSON.parse(metadataSnapshot.content.toString('utf8'));
    } catch (_) { /* A fresh/corrupt private record is replaced below. */ }

    if (previousMetadata?.source) {
      previousState = await loadSanitizedTestCaseState(folder);
    } else {
      // Lazy, non-destructive migration for captures made by older versions.
      // Generated state is copied into VS Code private storage; the legacy
      // directory is deliberately left untouched so unknown/user files cannot
      // be deleted by an automatic upgrade.
      const candidate = await captureProblemFolder(base, payload);
      if (candidate && await fileExists(path.join(candidate, 'metadata.json'))) {
        let candidateMetadata = {};
        try { candidateMetadata = JSON.parse(await fs.readFile(path.join(candidate, 'metadata.json'), 'utf8')); } catch (_) { /* Ignore corrupt legacy state. */ }
        // Defend again at the point where files are copied. Folder names are
        // user-controlled and must never cause one problem's cases to be
        // imported into another problem's private record.
        if (captureProblemSlug(candidateMetadata) !== captureProblemSlug(payload)) {
          outputChannel?.appendLine(`Skipped mismatched legacy testcase state in ${candidate}.`);
        } else {
          legacyFolder = candidate;
          previousMetadata = candidateMetadata;
        }
      }
      if (legacyFolder) {
        try {
          const legacyState = await loadTestCaseState(legacyFolder);
          previousState = { ...legacyState, testCases: withoutLegacyRawTestCases(legacyState.testCases) };
        } catch (error) {
          outputChannel?.appendLine(`Could not migrate legacy testcase state from ${legacyFolder}: ${error.message}`);
        }
        const legacyScaffold = path.join(legacyFolder, `testcase.${extension}`);
        const privateScaffoldBackup = path.join(folder, `main.${extension}.legacy.bak`);
        if (await fileExists(legacyScaffold) && !await fileExists(privateScaffoldBackup)) {
          // Old generated code targets the old directory contract. Preserve it
          // for recovery, but never present or execute it as the new main file.
          await writeFileAtomically(privateScaffoldBackup, await fs.readFile(legacyScaffold, 'utf8'));
        }
      }
    }
    if (!previousState) previousState = await loadSanitizedTestCaseState(folder);

    const solution = await visibleSolutionPath(base, payload, extension, previousMetadata, folder);
    const workspaceProblemFolder = path.dirname(solution);
    const main = path.join(workspaceProblemFolder, `main.${extension}`);
    await fs.mkdir(workspaceProblemFolder, { recursive: true });

    const collisionRecords = (await storedProblemFoldersForDirectory(workspaceProblemFolder))
      .filter((record) => pathKey(record.folder) !== pathKey(folder));
    const previousRegisteredSolution = metadataSolutionPath(previousMetadata);
    const obsoleteCurrentSolution = previousRegisteredSolution
      && pathKey(previousRegisteredSolution) !== pathKey(solution)
      ? previousRegisteredSolution
      : '';
    const obsoleteCurrentMain = obsoleteCurrentSolution && Number(previousMetadata.storageSchemaVersion) >= 2
      ? path.join(path.dirname(obsoleteCurrentSolution), `main${path.extname(obsoleteCurrentSolution)}`)
      : '';

    const pathsToSnapshot = new Map();
    const rememberSnapshot = async (filePath) => {
      if (!filePath) return;
      const key = pathKey(filePath);
      if (!pathsToSnapshot.has(key)) pathsToSnapshot.set(key, { filePath, snapshot: await snapshotFile(filePath) });
    };
    await rememberSnapshot(solution);
    await rememberSnapshot(main);
    await rememberSnapshot(obsoleteCurrentSolution);
    await rememberSnapshot(obsoleteCurrentMain);
    for (const record of collisionRecords) {
      await rememberSnapshot(record.solutionPath);
      await rememberSnapshot(path.join(path.dirname(record.solutionPath), `main${path.extname(record.solutionPath)}`));
    }

    for (const { filePath, snapshot } of pathsToSnapshot.values()) {
      if (snapshot.exists && openTextDocument(filePath)?.isDirty) {
        throw new Error(`本地 ${path.basename(filePath)} 有尚未保存的修改。请先保存或关闭该文件，再重新抓取网页代码。`);
      }
    }

    const solutionSnapshot = pathsToSnapshot.get(pathKey(solution)).snapshot;
    const mainSnapshot = pathsToSnapshot.get(pathKey(main)).snapshot;
    const solutionCreated = !solutionSnapshot.exists;
    const previousSolution = solutionSnapshot.exists ? solutionSnapshot.content.toString('utf8') : '';
    const solutionChanged = !solutionCreated && previousSolution !== payload.code;
    const isRegisteredCollision = collisionRecords.length > 0;
    let solutionBackup = '';
    if (!isRegisteredCollision && solutionChanged) {
      solutionBackup = path.join(folder, `solution.${extension}.bak`);
      await writeFileAtomically(solutionBackup, previousSolution);
    }
    if (obsoleteCurrentSolution) {
      const snapshot = pathsToSnapshot.get(pathKey(obsoleteCurrentSolution))?.snapshot;
      if (snapshot?.exists) {
        solutionBackup = path.join(folder, `solution.${path.extname(obsoleteCurrentSolution).slice(1) || extension}.layout.bak`);
        await writeFileAtomically(solutionBackup, snapshot.content);
      }
    }
    if (obsoleteCurrentMain) {
      const snapshot = pathsToSnapshot.get(pathKey(obsoleteCurrentMain))?.snapshot;
      if (snapshot?.exists) {
        await writeFileAtomically(
          path.join(folder, `main.${path.extname(obsoleteCurrentMain).slice(1) || extension}.layout.bak`),
          snapshot.content
        );
      }
    }

    // Preserve every known artifact of the outgoing registered owner before
    // its active record is archived. Unknown files in the title directory are
    // never touched.
    for (const record of collisionRecords) {
      const ownerSolution = pathsToSnapshot.get(pathKey(record.solutionPath));
      const ownerMainPath = path.join(path.dirname(record.solutionPath), `main${path.extname(record.solutionPath)}`);
      const ownerMain = pathsToSnapshot.get(pathKey(ownerMainPath));
      const ownerExtension = path.extname(record.solutionPath).slice(1) || 'txt';
      if (ownerSolution?.snapshot.exists) {
        await writeFileAtomically(path.join(record.folder, `solution.${ownerExtension}.overwritten.bak`), ownerSolution.snapshot.content);
      }
      if (ownerMain?.snapshot.exists) {
        await writeFileAtomically(path.join(record.folder, `main.${ownerExtension}.overwritten.bak`), ownerMain.snapshot.content);
      }
    }

    const capturedCodeChanged = typeof previousMetadata.code === 'string'
      && previousMetadata.code !== payload.code;
    if (solutionCreated && legacyFolder) {
      const legacySolution = path.join(legacyFolder, `solution.${extension}`);
      if (await fileExists(legacySolution)) {
        const legacyCode = await fs.readFile(legacySolution, 'utf8');
        if (legacyCode !== payload.code) {
          await writeFileAtomically(path.join(folder, `solution.${extension}.legacy.bak`), legacyCode);
        }
      }
    }

    const testCases = previousState.testCases;
    // A main file in a directory owned by another problem is never inherited.
    const hasScaffold = mainSnapshot.exists && !isRegisteredCollision;
    const captureRevision = crypto.randomUUID();
    const extraction = ai.configured
      ? {
          status: 'pending', provider: ai.provider, model: ai.model,
          message: '题目和网页代码已保存，AI 正在后台提取测试用例。'
        }
      : {
          status: 'not-configured', provider: ai.provider, model: ai.model,
          message: `未配置 ${providerInfo(ai.provider).label} API Key，因此未生成测试用例。`
        };
    // A generated scaffold can contain language-specific imports and wrappers
    // around the captured solution. Re-capturing different browser code must
    // invalidate it even when AI later extracts the exact same testcases.
    const scaffoldStale = Boolean(legacyFolder) || (hasScaffold
      && (Boolean(previousMetadata.testcaseScaffoldStale) || solutionChanged || capturedCodeChanged));
    const metadataDocument = {
      ...payload,
      storageSchemaVersion: 2,
      code: payload.code,
      language: payload.language,
      solutionPath: solution,
      solutionRelativePath: path.relative(root, solution),
      workspaceRootPath: root,
      workspaceFolderUri: workspaceFolderForPath(solution)?.uri || '',
      solutionFileName: path.basename(solution),
      runtimeSolutionFileName: `solution.${extension}`,
      mainFileName: `main.${extension}`,
      savedAt: new Date().toISOString(),
      captureRevision,
      testcaseScaffoldStale: scaffoldStale,
      testcaseExtraction: {
        status: extraction.status,
        provider: extraction.provider,
        model: extraction.model,
        message: extraction.message,
        at: new Date().toISOString()
      }
    };
    const archivedRecords = [];
    try {
      for (const record of collisionRecords) {
        const destination = await archiveOverwrittenProblemRecord(record.folder);
        if (!destination) throw new Error('同名题目的原记录在覆盖前发生了变化，请重新抓取。');
        archivedRecords.push({ ...record, destination });
      }
    } catch (error) {
      for (const archived of archivedRecords.reverse()) {
        await fs.rename(archived.destination, archived.folder).catch((restoreError) => {
          outputChannel?.appendLine(`Could not restore partially archived record ${archived.folder}: ${restoreError.message}`);
        });
        cacheSolutionRecord(archived.solutionPath, archived.folder);
      }
      throw error;
    }
    const removeKnownArtifact = async (filePath) => {
      if (!filePath || pathKey(filePath) === pathKey(solution)) return;
      await fs.unlink(filePath).catch((error) => { if (error?.code !== 'ENOENT') throw error; });
    };
    const commitOperations = [
      writeFileAtomically(solution, payload.code),
      writeTextAtomically(metadata, JSON.stringify(metadataDocument, null, 2)),
      saveTestCases(folder, testCases, {
        excludedAiIds: previousState.excludedAiIds,
        excludedLeetCodeIds: previousState.excludedLeetCodeIds
      })
    ];
    if (isRegisteredCollision && mainSnapshot.exists) commitOperations.push(removeKnownArtifact(main));
    if (obsoleteCurrentSolution) commitOperations.push(removeKnownArtifact(obsoleteCurrentSolution));
    if (obsoleteCurrentMain) commitOperations.push(removeKnownArtifact(obsoleteCurrentMain));
    for (const record of collisionRecords) {
      commitOperations.push(removeKnownArtifact(record.solutionPath));
      commitOperations.push(removeKnownArtifact(path.join(path.dirname(record.solutionPath), `main${path.extname(record.solutionPath)}`)));
    }
    const writes = await Promise.allSettled(commitOperations);
    const failedWrite = writes.find((result) => result.status === 'rejected');
    if (failedWrite) {
      const rollbackErrors = [];
      const restore = async (label, operation) => {
        try { await operation(); } catch (error) { rollbackErrors.push(`${label}: ${error.message}`); }
      };
      for (const { filePath, snapshot } of pathsToSnapshot.values()) {
        await restore(path.basename(filePath), () => restoreFileSnapshot(filePath, snapshot));
      }
      await restore('metadata', () => restoreFileSnapshot(metadata, metadataSnapshot));
      await restore('testcases', () => restoreFileSnapshot(testCasesPath, testCasesSnapshot));
      for (const archived of archivedRecords) {
        await restore('overwritten record', async () => {
          await fs.rename(archived.destination, archived.folder);
          const ownerMetadata = JSON.parse(await fs.readFile(path.join(archived.folder, 'metadata.json'), 'utf8'));
          const ownerRevision = String(ownerMetadata?.captureRevision || '');
          if (ownerRevision) supersededCaptureJobs.delete(captureJobKey(archived.folder, ownerRevision));
        });
      }
      clearCachedProblemFolder(folder);
      for (const archived of archivedRecords) clearCachedProblemFolder(archived.folder);
      const restoredIncomingSolution = metadataSolutionPath(previousMetadata);
      if (restoredIncomingSolution && metadataSnapshot.exists) cacheSolutionRecord(restoredIncomingSolution, folder);
      for (const archived of archivedRecords) cacheSolutionRecord(archived.solutionPath, archived.folder);
      const cause = failedWrite.reason?.message || '未知写入错误';
      if (rollbackErrors.length) {
        throw new Error(`保存同名题目失败，自动回滚不完整：${cause}；${rollbackErrors.join('；')}`);
      }
      throw new Error(`保存同名题目失败，已恢复覆盖前状态：${cause}`);
    }
    clearCachedProblemFolder(folder);
    cacheSolutionRecord(solution, folder);
    // A newer capture for the same record owns the UI and persisted state.
    // Older provider requests may still be in flight, but they must no longer
    // keep controls disabled or publish results when they eventually return.
    supersedeOlderCaptureJobs(folder, captureRevision);
    const overwrittenRecordBackup = archivedRecords[0]?.destination || '';
    const overwrittenSolutionBackup = overwrittenRecordBackup
      ? path.join(overwrittenRecordBackup, `solution.${path.extname(archivedRecords[0].solutionPath).slice(1) || extension}.overwritten.bak`)
      : '';
    return {
      folder: path.relative(root, base), file: path.relative(root, solution),
      solution, problemFolder: folder, solutionCreated, solutionBackup,
      overwrittenRecordBackup, overwrittenSolutionBackup,
      scaffoldStale, extraction, aiPending: ai.configured, captureRevision
    };
    });
  });
  outputChannel?.appendLine(`Saved browser snapshot ${payload.title} → ${saved.solution}`);
  if (settings.open) await vscode.window.showTextDocument(vscode.Uri.file(saved.solution), { preview: false });
  return saved;
}

async function processCapturedAi(payload, saved) {
  if (!saved?.aiPending) return { extraction: saved?.extraction, skipped: true };
  const extraction = await extractCapturedTestCases(payload);
  const folder = saved.problemFolder;
  if (!folder) throw new Error('后台 AI 处理缺少题目私有存储位置。');
  const jobKey = captureJobKey(folder, saved.captureRevision);
  if (supersededCaptureJobs.has(jobKey)) return { extraction, superseded: true };
  return withProblemLock(folder, async () => {
    const metadataPath = path.join(folder, 'metadata.json');
    let currentMetadata;
    try {
      currentMetadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
    } catch (_) {
      if (supersededCaptureJobs.has(jobKey)) return { extraction, superseded: true };
      throw new Error('后台 AI 处理时无法读取刚保存的 metadata.json。');
    }
    if (currentMetadata.captureRevision !== saved.captureRevision) {
      return { extraction, superseded: true };
    }
    const currentSolution = metadataSolutionPath(currentMetadata);
    if (!currentSolution || !await fileExists(currentSolution)) {
      throw new Error('后台 AI 处理时找不到当前题目解答文件；如果刚刚移动了文件，请重新抓取题目。');
    }
    const currentSolutionDocument = openTextDocument(currentSolution);
    if (currentSolutionDocument?.isDirty) {
      throw new Error('AI 处理期间题目解答出现未保存修改；请先保存，再从浏览器重新抓取题目。');
    }
    const currentCode = await fs.readFile(currentSolution, 'utf8');

    const previousState = await loadSanitizedTestCaseState(folder);
    const testCases = mergeAiExtractedTestCases(previousState.testCases, payload, extraction.testCases, {
      excludedAiIds: previousState.excludedAiIds
    });
    const testCasesChanged = JSON.stringify(previousState.testCases) !== JSON.stringify(testCases);
    const scaffold = path.join(path.dirname(currentSolution), `main${path.extname(currentSolution)}`);
    const hasScaffold = await fileExists(scaffold);
    let scaffoldStale = hasScaffold && (Boolean(currentMetadata.testcaseScaffoldStale) || testCasesChanged);
    let nextMetadata = {
      ...currentMetadata,
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
    if (!scaffoldStale) {
      const { testcaseScaffoldError, ...withoutError } = nextMetadata;
      nextMetadata = withoutError;
    }
    await Promise.all([
      saveTestCases(folder, testCases, {
        excludedAiIds: previousState.excludedAiIds,
        excludedLeetCodeIds: previousState.excludedLeetCodeIds
      }),
      writeTextAtomically(metadataPath, JSON.stringify(nextMetadata, null, 2))
    ]);

    let scaffoldGenerated = false;
    let scaffoldError = '';
    const extractionCompleted = extraction.status === 'extracted' || extraction.status === 'empty';
    const shouldGenerateScaffold = extractionCompleted && testCases.length
      && (!hasScaffold || scaffoldStale);
    if (shouldGenerateScaffold) {
      try {
        const generationContext = {
          folder,
          solutionPath: currentSolution,
          solutionFileName: path.basename(currentSolution),
          activeFilePath: currentSolution,
          code: currentCode,
          metadata: nextMetadata,
          title: currentMetadata.title || payload.title,
          source: currentMetadata.source || payload.source,
          language: currentMetadata.language || payload.language,
          testCases
        };
        await generateTestScaffold(generationContext, testCases, { type: 'initialize' });
        scaffoldGenerated = true;
        scaffoldStale = false;
      } catch (error) {
        scaffoldError = String(error?.message || 'AI 生成测试脚手架失败。').slice(0, 800);
        outputChannel?.appendLine(`Background testcase scaffold generation failed: ${scaffoldError}`);
        scaffoldStale = true;
        const failedMetadata = {
          ...nextMetadata,
          testcaseScaffoldStale: true,
          testcaseScaffoldError: scaffoldError
        };
        await writeTextAtomically(metadataPath, JSON.stringify(failedMetadata, null, 2)).catch((writeError) => {
          outputChannel?.appendLine(`Could not persist testcase scaffold failure state: ${writeError.message}`);
        });
      }
    }
    return { extraction, testCases, scaffoldGenerated, scaffoldStale, scaffoldError };
  });
}

async function markCaptureProcessingFailed(saved, error) {
  const folder = saved?.problemFolder;
  if (!folder) return;
  const message = String(error?.message || 'AI 后台处理失败。').slice(0, 800);
  await withProblemLock(folder, async () => {
    const metadataPath = path.join(folder, 'metadata.json');
    let metadata;
    try {
      metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
    } catch (_) {
      return;
    }
    if (metadata.captureRevision !== saved.captureRevision) return;
    const next = {
      ...metadata,
      testcaseExtraction: {
        ...(metadata.testcaseExtraction || {}),
        status: 'failed',
        message,
        at: new Date().toISOString()
      }
    };
    await writeTextAtomically(metadataPath, JSON.stringify(next, null, 2));
  });
}

async function repairInterruptedCaptureJobs() {
  const records = await listStoredProblemRecords();
  for (const record of records) {
    if (record.metadata?.testcaseExtraction?.status !== 'pending') continue;
    const scannedRevision = String(record.metadata?.captureRevision || '');
    await withProblemLock(record.folder, async () => {
      const metadataPath = path.join(record.folder, 'metadata.json');
      let metadata;
      try {
        metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
      } catch (_) {
        return;
      }
      if (metadata?.testcaseExtraction?.status !== 'pending'
        || String(metadata?.captureRevision || '') !== scannedRevision) return;
      const message = '上次 AI 处理因 VS Code 重载而中断；请从浏览器重新抓取题目后重试。';
      const next = {
        ...metadata,
        testcaseScaffoldStale: true,
        testcaseScaffoldError: message,
        testcaseExtraction: {
          ...(metadata.testcaseExtraction || {}),
          status: 'failed',
          message,
          at: new Date().toISOString()
        }
      };
      await writeTextAtomically(metadataPath, JSON.stringify(next, null, 2));
    });
  }
}

function respond(response, status, body) {
  // The companion extension has an explicit localhost host permission and
  // does not require permissive CORS. Omitting Access-Control-Allow-Origin
  // prevents arbitrary web pages from reading receiver responses.
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function isCompanionExtensionRequest(request) {
  const origin = request?.headers?.origin;
  return typeof origin === 'string' && origin === COMPANION_EXTENSION_ORIGIN;
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
let sidebarNoticeTimer;
let sidebarErrorTimer;
let sidebarRefreshEpoch = 0;

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
  if (request.url !== '/ws'
    || request.headers.upgrade?.toLowerCase() !== 'websocket'
    || !isCompanionExtensionRequest(request)) return socket.destroy();
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

async function snapshotFile(filePath) {
  try {
    return { exists: true, content: await fs.readFile(filePath) };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, content: Buffer.alloc(0) };
    throw error;
  }
}

async function restoreFileSnapshot(filePath, snapshot) {
  if (snapshot?.exists) {
    await writeFileAtomically(filePath, snapshot.content);
  } else {
    await fs.unlink(filePath).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
  }
}

async function writeFileAtomically(filePath, content) {
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temporary, content, 'utf8');
    await fs.rename(temporary, filePath);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

async function writeTextAtomically(filePath, content) {
  return writeFileAtomically(filePath, `${String(content).replace(/\r?\n?$/, '')}\n`);
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
  const windows = typeof process === 'object' ? process.platform === 'win32' : path.sep === '\\';
  return windows ? resolved.toLowerCase() : resolved;
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

async function fileExecutionFingerprint(filePath) {
  const content = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function scaffoldExecutionFingerprint(scaffoldPath) {
  requireTrustedWorkspace('运行');
  // Snapshot the bytes that the runner will execute. The runner checks this
  // digest again immediately before spawning so a concurrent replacement
  // cannot change the code between validation and execution. Running from the
  // sidebar deliberately requires no extra review/confirmation dialog.
  return fileExecutionFingerprint(scaffoldPath);
}

async function assertRunInputsUnchanged(context, scaffoldPath, expectedSolutionHash, expectedScaffoldHash) {
  const solutionDocument = openTextDocument(context.solutionPath);
  const scaffoldDocument = openTextDocument(scaffoldPath);
  if (solutionDocument?.isDirty || scaffoldDocument?.isDirty) {
    throw Object.assign(
      new Error('运行期间 solution 或 main 已被修改，本次结果已丢弃。请保存后重新运行。'),
      { code: 'RUN_INPUT_CHANGED' }
    );
  }
  const [solutionHash, scaffoldHash] = await Promise.all([
    fileExecutionFingerprint(context.solutionPath),
    fileExecutionFingerprint(scaffoldPath)
  ]);
  if (solutionHash !== expectedSolutionHash || scaffoldHash !== expectedScaffoldHash) {
    throw Object.assign(
      new Error('运行期间 solution 或 main 已发生变化，本次结果已丢弃。请重新运行。'),
      { code: 'RUN_INPUT_CHANGED' }
    );
  }
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
    throw new Error('请先打开由 LeetCode CPH 保存的题目解答文件。');
  }
  const activeFilePath = editor.document.uri.fsPath;
  const activeName = path.basename(activeFilePath);
  const storedFolder = await findStoredProblemFolderByArtifact(activeFilePath);
  if (storedFolder) {
    let solutionPath = activeFilePath;
    if (/^main\.[^.]+$/i.test(activeName)) {
      const metadata = JSON.parse(await fs.readFile(path.join(storedFolder, 'metadata.json'), 'utf8'));
      solutionPath = metadataSolutionPath(metadata);
      if (!solutionPath || !await fileExists(solutionPath)) {
        throw new Error('找不到 main 对应的 solution 文件，请重新抓取题目。');
      }
    }
    if (reservedSolutionFileName(solutionPath)) {
      throw new Error('题目解答不能命名为 main.<语言> 或 testcase.<语言>。请将解答文件改回 solution.<语言> 后重试。');
    }
    return {
      folder: storedFolder,
      stateFolder: storedFolder,
      workspaceProblemFolder: path.dirname(solutionPath),
      solutionPath,
      solutionFileName: path.basename(solutionPath),
      activeFilePath,
      code: await readOpenDocumentOrFile(solutionPath)
    };
  }

  // A workspace may already contain a conventional solution.* file without a
  // private LeetCode record (for example after storage was cleared). Keep a
  // small private manual-case store for it, but do not infer problem metadata,
  // call AI, sync, or enable execution until a browser capture registers it.
  const unmanagedSolution = /^solution\.[^.]+$/i.test(activeName)
    ? activeFilePath
    : /^main\.[^.]+$/i.test(activeName)
      ? path.join(path.dirname(activeFilePath), `solution${path.extname(activeFilePath)}`)
      : '';
  if (extensionStoragePath && unmanagedSolution && workspaceFolderForPath(unmanagedSolution)
    && await fileExists(unmanagedSolution)) {
    const localFolder = localStateFolderForSolution(unmanagedSolution);
    return {
      folder: localFolder,
      stateFolder: localFolder,
      workspaceProblemFolder: path.dirname(unmanagedSolution),
      solutionPath: unmanagedSolution,
      solutionFileName: path.basename(unmanagedSolution),
      activeFilePath,
      code: await readOpenDocumentOrFile(unmanagedSolution),
      localOnly: true
    };
  }

  // The hidden scaffold may be opened explicitly from a warning or diagnostic.
  // Resolve it back to the registered visible solution without exposing any
  // other private record as an active problem.
  if (/^testcase\.[^.]+$/i.test(activeName) && extensionStoragePath && isPathInside(extensionStoragePath, activeFilePath)) {
    try {
      const stateFolder = path.dirname(activeFilePath);
      const metadata = JSON.parse(await fs.readFile(path.join(stateFolder, 'metadata.json'), 'utf8'));
      const solutionPath = metadataSolutionPath(metadata);
      if (solutionPath && await fileExists(solutionPath)) {
        cacheSolutionRecord(solutionPath, stateFolder);
        return {
          folder: stateFolder,
          stateFolder,
          workspaceProblemFolder: path.dirname(solutionPath),
          solutionPath,
          solutionFileName: path.basename(solutionPath),
          activeFilePath,
          code: await readOpenDocumentOrFile(solutionPath)
        };
      }
    } catch (_) { /* Fall through to legacy layout detection. */ }
  }

  // Backward-compatible read support for old workspace-visible
  // `<problem>/solution.* + metadata.json + testcase.*` directories. Legacy
  // testcase.* is imported only as a non-executable backup.
  const isSolution = /^solution\.[^.]+$/i.test(activeName);
  const isScaffold = /^(?:testcase|main)\.[^.]+$/i.test(activeName);
  if (!isSolution && !isScaffold) {
    if (!required) return null;
    throw new Error('当前文件不是由 LeetCode CPH 登记的题目解答。请从浏览器重新抓取一次该题目。');
  }
  const folder = path.dirname(activeFilePath);
  const solutionPath = isSolution
    ? activeFilePath
    : await findSolutionFile(folder, path.extname(activeFilePath));
  const code = isSolution ? editor.document.getText() : await readOpenDocumentOrFile(solutionPath);
  return {
    folder,
    stateFolder: folder,
    workspaceProblemFolder: path.dirname(solutionPath),
    solutionPath,
    solutionFileName: path.basename(solutionPath),
    activeFilePath,
    code
  };
}

async function problemContextFromIdentity(identity) {
  if (identity.localOnly) {
    let metadata = {};
    try { metadata = JSON.parse(await fs.readFile(path.join(identity.folder, 'metadata.json'), 'utf8')); } catch (_) { /* Fresh local-only record. */ }
    const testCases = await loadTestCases(identity.folder);
    return {
      ...identity,
      metadata: {
        ...metadata,
        localOnly: true,
        title: metadata.title || path.basename(path.dirname(identity.solutionPath)),
        language: metadata.language || path.extname(identity.solutionPath).slice(1),
        solutionPath: identity.solutionPath
      },
      title: metadata.title || path.basename(path.dirname(identity.solutionPath)),
      source: '',
      language: metadata.language || path.extname(identity.solutionPath).slice(1),
      testCases
    };
  }
  let metadata;
  try {
    metadata = JSON.parse(await fs.readFile(path.join(identity.folder, 'metadata.json'), 'utf8'));
  } catch (_) {
    throw new Error('无法读取该解答对应的私有题目记录，请从浏览器重新抓取。');
  }
  if (!metadata?.source) throw new Error('私有题目记录中缺少来源链接，请重新抓取。');
  const testCases = await loadOrMigrateTestCases(identity.folder, metadata);
  return {
    ...identity,
    stateFolder: identity.stateFolder || identity.folder,
    workspaceProblemFolder: identity.workspaceProblemFolder || path.dirname(identity.solutionPath),
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
  return path.join(path.dirname(context.solutionPath), `main.${extension}`);
}

function runtimeSolutionFilePath(context) {
  return context.solutionPath;
}

async function prepareRuntimeSolution(context) {
  return runtimeSolutionFilePath(context);
}

async function ensurePersistedTestCases(context) {
  await fs.mkdir(context.folder, { recursive: true });
  const storageFile = path.join(context.folder, TEST_CASES_FILE);
  const testCases = await fileExists(storageFile)
    ? context.testCases
    : await saveTestCases(context.folder, context.testCases);
  if (context.localOnly && !await fileExists(path.join(context.folder, 'metadata.json'))) {
    const workspace = workspaceFolderForPath(context.solutionPath);
    const localMetadata = {
      storageSchemaVersion: 2,
      localOnly: true,
      title: context.title,
      language: context.language,
      solutionPath: context.solutionPath,
      solutionRelativePath: workspace ? path.relative(workspace.path, context.solutionPath) : '',
      workspaceRootPath: workspace?.path || '',
      workspaceFolderUri: workspace?.uri || '',
      savedAt: new Date().toISOString()
    };
    await writeTextAtomically(path.join(context.folder, 'metadata.json'), JSON.stringify(localMetadata, null, 2));
  }
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
  if (context?.localOnly) throw new Error('该 solution 没有私有题目信息，不能使用 AI 提取测试用例。');
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
  if (context?.localOnly) throw new Error('该 solution 没有私有题目信息，不能生成 main 测试代码。');
  if (reservedSolutionFileName(context?.solutionPath)) {
    throw new Error('题目解答不能命名为 main.<语言> 或 testcase.<语言>，已拒绝覆盖。请将文件改回 solution.<语言>。');
  }
  if (!aiTestcaseService) throw new Error('AI 服务尚未初始化，请重新加载 VS Code 扩展。');
  if (!Array.isArray(testCases)) {
    throw new Error('测试用例数据无效，无法生成测试脚手架。');
  }
  if ((operation?.type === 'initialize' || operation?.type === 'regenerate') && !testCases.length) {
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
  if (operation?.type === 'repair') {
    const currentSolutionCode = await readOpenDocumentOrFile(context.solutionPath);
    if (currentSolutionCode !== context.code) {
      throw new Error('本次运行结束后 solution 已发生变化，已取消基于旧报错的 AI 自动修复。');
    }
    if (operation.expectedScaffoldHash) {
      const currentScaffoldBytes = destinationExists ? await fs.readFile(destination) : Buffer.alloc(0);
      const currentScaffoldHash = crypto.createHash('sha256').update(currentScaffoldBytes).digest('hex');
      if (currentScaffoldHash !== operation.expectedScaffoldHash) {
        throw new Error('本次运行结束后 main 已发生变化，已取消基于旧报错的 AI 自动修复。');
      }
    }
  }
  const scaffoldMetadata = {
    ...context.metadata,
    runtimeSolutionFileName: path.basename(runtimeSolutionFilePath(context)),
    mainFileName: path.basename(destination)
  };
  const generated = await aiTestcaseService.generateScaffold({
    metadata: scaffoldMetadata,
    solutionCode: context.code,
    testCases,
    operation,
    existingScaffold,
    provider: ai.provider,
    model: ai.model
  });
  const currentSolutionCode = await readOpenDocumentOrFile(context.solutionPath);
  if (currentSolutionCode !== context.code) {
    throw new Error('AI 生成测试代码期间题目解答发生了变化，未写入旧脚手架。请保存代码后重试。');
  }
  const currentScaffoldDocument = openTextDocument(destination);
  if (currentScaffoldDocument?.isDirty) {
    throw new Error(`AI 生成期间 ${path.basename(destination)} 出现未保存修改，未覆盖该文件。请先保存或还原修改后重试。`);
  }
  const currentDestinationExists = await fileExists(destination);
  const currentScaffold = currentDestinationExists ? await readTextIfPresent(destination) : '';
  if (currentDestinationExists !== destinationExists || currentScaffold !== existingScaffold) {
    throw new Error(`AI 生成期间 ${path.basename(destination)} 已发生变化，未覆盖较新的本地内容。请重试。`);
  }
  // AI updates are intentionally recoverable.  A re-capture or testcase
  // mutation may need to replace an already saved scaffold, including one a
  // user has adjusted manually.  Keep one immediately-restorable copy before
  // the atomic replacement; if this write fails, leave the live scaffold
  // untouched instead of risking the user's local framework.
  const backup = destinationExists
    ? path.join(context.folder, `main${path.extname(destination)}.bak`)
    : '';
  if (backup) await writeTextAtomically(backup, existingScaffold);
  await writeTextAtomically(destination, generated.content);
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

async function syncActiveSolution(expectedProblemKey) {
  const context = await activeProblemContext();
  assertSidebarProblem(context, expectedProblemKey);
  assertProblemAiIdle(context);
  if (context.localOnly) throw new Error('该 solution 没有对应的 LeetCode URL，不能安全同步。请从浏览器重新抓取题目。');
  vscode.window.setStatusBarMessage('LeetCode CPH: 正在同步到浏览器…');
  const result = await requestBrowserApply(browserApplyPayload(context));
  const extra = result.duplicates ? `（另有 ${result.duplicates} 个同题标签未修改）` : '';
  vscode.window.setStatusBarMessage(`LeetCode CPH: 已同步到浏览器 ${extra}`, 5000);
  outputChannel.appendLine(`Synced ${context.title} to tab ${result.tabId}.`);
  return result;
}

function setSidebarRuntime(patch = {}) {
  sidebarRefreshEpoch += 1;
  const updatesNotice = Object.prototype.hasOwnProperty.call(patch, 'notice');
  const updatesError = Object.prototype.hasOwnProperty.call(patch, 'error');
  if (updatesNotice) {
    sidebarRuntime.noticeRevision += 1;
    clearSidebarNoticeTimer();
  }
  if (updatesError) {
    sidebarRuntime.errorRevision += 1;
    clearSidebarErrorTimer();
  }
  Object.assign(sidebarRuntime, patch);
  if (updatesNotice && sidebarRuntime.notice) {
    const revision = sidebarRuntime.noticeRevision;
    const timer = setTimeout(() => {
      if (sidebarRuntime.noticeRevision !== revision || !sidebarRuntime.notice || sidebarNoticeTimer !== timer) return;
      sidebarNoticeTimer = undefined;
      setSidebarRuntime({ notice: '' });
    }, SIDEBAR_NOTICE_TIMEOUT_MS);
    sidebarNoticeTimer = timer;
    sidebarNoticeTimer.unref?.();
  }
  if (updatesError && sidebarRuntime.error) {
    const revision = sidebarRuntime.errorRevision;
    const timer = setTimeout(() => {
      if (sidebarRuntime.errorRevision !== revision || !sidebarRuntime.error || sidebarErrorTimer !== timer) return;
      sidebarErrorTimer = undefined;
      setSidebarRuntime({ error: '' });
    }, SIDEBAR_ERROR_TIMEOUT_MS);
    sidebarErrorTimer = timer;
    sidebarErrorTimer.unref?.();
  }
  sidebarProvider?.setState({
    busy: sidebarRuntime.busy,
    testcaseMutationBusy: sidebarRuntime.testcaseMutationBusy,
    runBusy: sidebarRuntime.runBusy,
    runningCaseId: sidebarRuntime.runningCaseId,
    testResults: sidebarRuntime.testResults,
    notice: sidebarRuntime.notice,
    noticeRevision: sidebarRuntime.noticeRevision,
    error: sidebarRuntime.error,
    errorRevision: sidebarRuntime.errorRevision
  });
}

function clearSidebarNoticeTimer() {
  clearTimeout(sidebarNoticeTimer);
  sidebarNoticeTimer = undefined;
}

function clearSidebarErrorTimer() {
  clearTimeout(sidebarErrorTimer);
  sidebarErrorTimer = undefined;
}

function dismissSidebarNotice(revision) {
  if (!Number.isSafeInteger(revision) || revision !== sidebarRuntime.noticeRevision) return;
  setSidebarRuntime({ notice: '' });
}

function dismissSidebarError(revision) {
  if (!Number.isSafeInteger(revision) || revision !== sidebarRuntime.errorRevision) return;
  setSidebarRuntime({ error: '' });
}

function clearRunResults(folder) {
  if (folder && sidebarRuntime.resultFolder && pathKey(folder) !== pathKey(sidebarRuntime.resultFolder)) return;
  sidebarRefreshEpoch += 1;
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
    noticeRevision: sidebarRuntime.noticeRevision,
    error: sidebarRuntime.error,
    errorRevision: sidebarRuntime.errorRevision
  };
}

function sidebarProblemKey(context) {
  // The webview only needs a stable opaque scope for unsaved card drafts. Do
  // not expose the workspace's absolute folder path just to distinguish two
  // open problems. Capture revision is part of the scope so a late webview
  // message from an overwritten capture cannot mutate the new testcase set.
  const captureRevision = String(context?.metadata?.captureRevision || '');
  return crypto.createHash('sha256')
    .update(`${pathKey(context.folder)}\0${captureRevision}`)
    .digest('hex')
    .slice(0, 24);
}

function assertSidebarProblem(context, expectedProblemKey) {
  // Undefined is reserved for trusted in-process callers and tests. Webview
  // messages are normalized to a string, so a missing/empty scope from the UI
  // is rejected rather than silently targeting whichever editor is active.
  if (expectedProblemKey === undefined || expectedProblemKey === null) return;
  const expected = String(expectedProblemKey);
  if (!expected || sidebarProblemKey(context) !== expected) {
    throw new Error('当前编辑器已切换到另一道题。请在侧边栏刷新后重试。');
  }
}

function assertProblemAiIdle(context) {
  if (context?.localOnly) return;
  const pendingExtraction = context?.metadata?.testcaseExtraction?.status === 'pending';
  if (pendingExtraction || captureJobActiveForFolder(context.folder)
    || activeTestcaseAiJobs.has(pathKey(context.folder))) {
    throw new Error('AI 正在提取测试用例或更新 main 测试代码，请等待完成后重试。');
  }
}

function scaffoldStatusPresentation({ hasScaffold, generationActive, stale } = {}) {
  if (generationActive) return { kind: 'generating', text: '测试脚手架正在生成' };
  if (hasScaffold && stale) return { kind: 'stale', text: '测试脚手架可能不是最新版本' };
  if (hasScaffold) return { kind: 'generated', text: '测试脚手架已生成' };
  return { kind: 'missing', text: '测试脚手架未生成' };
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
    noticeRevision: sidebarRuntime.noticeRevision,
    error: '',
    errorRevision: sidebarRuntime.errorRevision
  };
  let context;
  try {
    context = await activeProblemContext({ required: false });
  } catch (error) {
    const message = extra.error || sidebarRuntime.error || error.message || '无法读取当前题目。';
    if (!sidebarRuntime.error || sidebarRuntime.error !== message) {
      setSidebarRuntime({ notice: '', error: message });
    }
    return { ...empty, ...runtimeStateFor(null), ...extra, error: message, errorRevision: sidebarRuntime.errorRevision };
  }
  if (!context) return { ...empty, ...runtimeStateFor(null), ...extra };

  let aiStatus = 'AI：未初始化';
  let aiConfigured = false;
  if (context.localOnly) {
    aiStatus = '未关联题目信息：仅支持手动维护测试用例';
  } else try {
    const ai = await configuredAiState();
    const label = providerInfo(ai.provider).label;
    aiConfigured = ai.configured;
    aiStatus = `AI：${label}${ai.configured ? '（API Key 已安全保存）' : '（未配置 API Key）'}`;
  } catch (error) {
    aiStatus = 'AI：配置无效';
  }
  const hasScaffold = await fileExists(scaffoldFilePath(context));
  const runnerSupported = !context.localOnly && supportsLanguage(scaffoldFilePath(context));
  const persistedExtractionPending = !context.localOnly && context.metadata?.testcaseExtraction?.status === 'pending';
  const extractionPending = persistedExtractionPending && activeCaptureJobs.has(
    captureJobKey(context.folder, context.metadata?.captureRevision)
  );
  const generationActive = !context.localOnly && (extractionPending
    || captureJobActiveForFolder(context.folder)
    || activeTestcaseAiJobs.has(pathKey(context.folder)));
  const aiBusy = !context.localOnly && (persistedExtractionPending
    || generationActive);
  // Background HTTP work cannot survive an extension-host reload. Do not
  // leave the sidebar permanently disabled by a durable "pending" marker
  // when no task for that exact capture revision exists in this process.
  const extractionInterrupted = persistedExtractionPending && !extractionPending;
  const scaffoldStatus = scaffoldStatusPresentation({
    hasScaffold,
    generationActive,
    stale: Boolean(context.metadata?.testcaseScaffoldStale) || extractionInterrupted
  });
  const hasRunnableTestCases = context.testCases.some(testcaseHasRunnableData);
  const scaffoldReady = !context.localOnly && hasScaffold
    && !context.metadata?.testcaseScaffoldStale
    && !persistedExtractionPending
    && !aiBusy;
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
      aiBusy,
      localOnly: Boolean(context.localOnly),
      canSync: !context.localOnly,
      canRegenerateScaffold: !context.localOnly && aiConfigured && hasRunnableTestCases
        && !persistedExtractionPending && !aiBusy,
      scaffoldReady,
      runnerSupported,
      scaffoldStatus: scaffoldStatus.text,
      scaffoldStatusKind: scaffoldStatus.kind
    },
    testCases: context.testCases,
    ...extra
  };
}

async function refreshSidebar(extra = {}) {
  const epoch = ++sidebarRefreshEpoch;
  const state = await sidebarState(extra);
  // Several refreshes can overlap while a capture or provider lookup awaits
  // I/O. Only the newest snapshot may reach the webview; returning undefined
  // also prevents the provider message dispatcher from applying a stale
  // callback result a second time.
  if (epoch !== sidebarRefreshEpoch) return undefined;
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

async function markScaffoldStale(context, errorMessage = '') {
  const { testcaseScaffoldError, ...metadataWithoutError } = context.metadata || {};
  const nextMetadata = { ...metadataWithoutError, testcaseScaffoldStale: true };
  if (errorMessage) nextMetadata.testcaseScaffoldError = errorMessage;
  await writeTextAtomically(
    path.join(context.folder, 'metadata.json'),
    JSON.stringify(nextMetadata, null, 2)
  );
  context.metadata = nextMetadata;
  return nextMetadata;
}

function testcaseDataChanged(previous, current) {
  return String(previous?.input ?? '') !== String(current?.input ?? '')
    || String(previous?.expectedOutput ?? '') !== String(current?.expectedOutput ?? '');
}

function pendingScaffoldDraft(testCase) {
  if (!testCase || typeof testCase !== 'object') return false;
  if (testCase.pendingScaffold === true) return true;
  // Before the marker existed, an all-empty manual case could only have come
  // from the Add button. Preserve that one-time first-save behavior.
  return !Object.prototype.hasOwnProperty.call(testCase, 'pendingScaffold')
    && testCase.source === 'manual'
    && !testcaseHasRunnableData(testCase);
}

function projectedTestCaseUpdate(testCase, payload) {
  const value = payload && typeof payload === 'object' ? payload : {};
  const hasInput = Object.prototype.hasOwnProperty.call(value, 'input');
  const hasExpected = Object.prototype.hasOwnProperty.call(value, 'expectedOutput')
    || Object.prototype.hasOwnProperty.call(value, 'output');
  return {
    ...testCase,
    input: hasInput ? value.input : testCase?.input,
    expectedOutput: hasExpected
      ? (Object.prototype.hasOwnProperty.call(value, 'expectedOutput') ? value.expectedOutput : value.output)
      : testCase?.expectedOutput
  };
}

async function mutateTestCaseAndScaffold(type, payload, onPersisted) {
  const identity = await activeProblemIdentity();
  const identityKey = pathKey(identity.folder);
  if (!identity.localOnly && (captureJobActiveForFolder(identity.folder) || activeTestcaseAiJobs.has(identityKey))) {
    throw new Error('AI 正在提取测试用例或更新 main 测试代码，请等待完成后再修改测试用例。');
  }
  let aiJobStarted = false;
  try {
    return await withProblemLock(identity.folder, async () => {
      let context = await problemContextFromIdentity(identity);
      const localOnly = Boolean(context.localOnly);
      assertSidebarProblem(context, payload?.problemKey);
      assertProblemAiIdle(context);
      // Persist the user's edit before any optional network request. A failed
      // model call must never discard data entered in the sidebar.
      context = await ensurePersistedTestCases(context);
      const previousState = await loadSanitizedTestCaseState(context.folder);
      context = { ...context, testCases: previousState.testCases };

      const requestedId = String(payload?.id || '');
      const previousCase = requestedId
        ? previousState.testCases.find((testCase) => testCase.id === requestedId)
        : null;
      const plannedFirstSave = type === 'update'
        && pendingScaffoldDraft(previousCase)
        && testcaseHasRunnableData(projectedTestCaseUpdate(previousCase, payload));
      const plannedGeneration = !localOnly
        && ((type === 'delete' && Boolean(previousCase)) || plannedFirstSave);
      const previousMetadata = context.metadata;
      let metadataMarkedStale = false;
      if (plannedGeneration) {
        // Invalidate main before committing testcases.json. If the extension
        // host stops between the two writes, the old scaffold remains safely
        // non-runnable instead of being paired with a newer testcase set.
        await markScaffoldStale(context);
        metadataMarkedStale = true;
      }

      let changed;
      try {
        if (type === 'add') {
          // The green add button always creates an empty draft. Test data can
          // only enter the store through the card's explicit Save action.
          changed = await createTestCase(context.folder, {});
        } else if (type === 'update') {
          changed = await updateTestCase(context.folder, payload?.id, payload);
        } else if (type === 'delete') {
          changed = await deleteTestCase(context.folder, payload?.id);
        } else {
          throw new Error('未知的测试用例操作。');
        }
      } catch (error) {
        if (metadataMarkedStale) {
          // No testcase change was committed. Restore the prior state when
          // possible; if restoration itself fails, leaving stale=true is the
          // conservative and safe outcome.
          await writeTextAtomically(
            path.join(context.folder, 'metadata.json'),
            JSON.stringify(previousMetadata, null, 2)
          ).catch((writeError) => {
            outputChannel?.appendLine(`Could not restore metadata after a failed testcase mutation: ${writeError.message}`);
          });
        }
        throw error;
      }

      const affected = type === 'delete' ? changed.deleted : changed.testCase;
      const completedNewCase = type === 'update'
        && pendingScaffoldDraft(changed.previous)
        && testcaseHasRunnableData(changed.testCase);
      const deletedScaffoldCase = type === 'delete';
      const requiresGeneration = !localOnly && (completedNewCase || deletedScaffoldCase);
      const editedExistingCase = type === 'update'
        && testcaseDataChanged(changed.previous, changed.testCase)
        && !completedNewCase;

      clearRunResults(context.folder);

      if (!requiresGeneration) {
        if (typeof onPersisted === 'function') await onPersisted({ ...changed, context });
        return {
          ...changed,
          generated: null,
          localOnly,
          draftCreated: type === 'add',
          completedNewCase,
          scaffoldMayNeedRewrite: !localOnly && editedExistingCase
        };
      }

      // A newly completed case or a deleted scaffolded case changes the
      // runner contract. Mark the old main stale before making the provider
      // request so it cannot be run after a crash or failed generation.
      if (!metadataMarkedStale) await markScaffoldStale(context);
      beginTestcaseAiJob(identityKey);
      aiJobStarted = true;
      if (typeof onPersisted === 'function') await onPersisted({ ...changed, context });

      try {
        requireTrustedWorkspace('更新');
        const ai = await configuredAiState();
        if (!ai.configured) {
          throw new Error(`未配置 ${providerInfo(ai.provider).label} API Key，无法更新测试脚手架。请先点击“配置 AI”。`);
        }
        const operationType = completedNewCase ? 'add' : 'delete';
        const generated = await generateTestScaffold(
          context,
          changed.testCases,
          { type: operationType, testCase: affected }
        );
        return { ...changed, generated, completedNewCase };
      } catch (error) {
        const detail = error?.message || '未知错误。';
        outputChannel?.appendLine(`Testcase scaffold update failed after saving testcase data: ${detail}`);
        await markScaffoldStale(context, detail).catch((writeError) => {
          outputChannel?.appendLine(`Could not persist testcase scaffold failure state: ${writeError.message}`);
        });
        throw new Error(`测试用例已保存，但测试脚手架更新失败。可点击“重新编写测试脚手架”重试。原因：${detail}`);
      }
    });
  } finally {
    if (aiJobStarted) endTestcaseAiJob(identityKey);
  }
}

async function regenerateTestScaffold(payload = {}) {
  const identity = await activeProblemIdentity();
  if (identity.localOnly) {
    throw new Error('该 solution 没有私有题目信息，不能生成 main 测试代码。');
  }
  const identityKey = pathKey(identity.folder);
  if (captureJobActiveForFolder(identity.folder) || activeTestcaseAiJobs.has(identityKey)) {
    throw new Error('AI 正在提取测试用例或更新 main 测试代码，请等待完成后重试。');
  }
  beginTestcaseAiJob(identityKey);
  void refreshSidebar();
  try {
    return await withProblemLock(identity.folder, async () => {
      let context = await problemContextFromIdentity(identity);
      assertSidebarProblem(context, payload?.problemKey);
      if (context.metadata?.testcaseExtraction?.status === 'pending') {
        throw new Error('AI 测试用例提取尚未完成，请等待后重试。');
      }
      context = await ensurePersistedTestCases(context);
      if (!context.testCases.some(testcaseHasRunnableData)) {
        throw new Error('请先至少填写并保存一个测试用例。');
      }
      const generated = await generateTestScaffold(context, context.testCases, { type: 'regenerate' });
      clearRunResults(context.folder);
      return { generated, context };
    });
  } finally {
    endTestcaseAiJob(identityKey);
    void refreshSidebar();
  }
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
    // The sidebar's currently saved expected output is authoritative. main may
    // still contain an older expectation after a user edits a case without
    // regenerating it, so its cached `passed` boolean must not override the
    // comparison shown by the UI. `actual` always comes from main's runtime
    // result protocol.
    const passed = outputsMatch;
    results[testCase.id] = {
      status: passed ? 'passed' : 'failed',
      passed,
      actualOutput
    };
  }
  return results;
}

async function runTestsFromSidebar(mode, payload) {
  const identity = await activeProblemIdentity();
  return withProblemLock(identity.folder, async () => {
    const context = await problemContextFromIdentity(identity);
    assertSidebarProblem(context, payload?.problemKey);
    assertProblemAiIdle(context);
    if (context.localOnly) {
      throw new Error('该 solution 没有私有题目信息，不能运行测试。请从浏览器重新抓取题目后再试。');
    }
    requireTrustedWorkspace('运行');
    if (context.metadata?.testcaseScaffoldStale) {
      throw new Error('测试脚手架需要更新。请点击“重新编写测试脚手架”后再运行。');
    }
    const scaffold = scaffoldFilePath(context);
    if (!await fileExists(scaffold)) {
      throw new Error('尚未生成测试脚手架。请配置 API Key、保存至少一个用例，然后点击“重新编写测试脚手架”。');
    }
    const solutionDocument = openTextDocument(context.solutionPath);
    const scaffoldDocument = openTextDocument(scaffold);
    if (solutionDocument?.isDirty || scaffoldDocument?.isDirty) {
      throw new Error('请先保存题目解答文件，再运行测试。');
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
    // `solution.*` and the AI-generated `main.*` live together in the visible
    // title directory, so language adapters can compile/import them without an
    // extra runtime copy.
    const [expectedScaffoldHash, expectedSolutionHash] = await Promise.all([
      scaffoldExecutionFingerprint(scaffold),
      fileExecutionFingerprint(context.solutionPath)
    ]);
    const runnableCaseNames = context.testCases
      .filter(testcaseHasRunnableData)
      .map((testCase) => testCase.name);
    let execution;
    let runError;
    try {
      execution = mode === 'case'
        ? await runSingleTestCase({
          problemFolder: path.dirname(context.solutionPath),
          scaffoldPath: scaffold,
          solutionPath: context.solutionPath,
          expectedCaseNames: [selected.name],
          expectedScaffoldHash,
          expectedSolutionHash
        }, selected.name)
        : await runAllTestCases({
          problemFolder: path.dirname(context.solutionPath),
          scaffoldPath: scaffold,
          solutionPath: context.solutionPath,
          expectedCaseNames: runnableCaseNames,
          expectedScaffoldHash,
          expectedSolutionHash
        });
    } catch (error) {
      // A non-zero process may emit valid results for some cases before it
      // stops. Keep those results visible while also reporting the exact-set
      // protocol failure and original runtime diagnostic. Successful processes
      // with a mismatched result set remain a hard scaffold error.
      if (error?.execution?.ok === false) {
        execution = {
          ...error.execution,
          error: [error.execution.error, error.message].filter(Boolean).join(' ')
        };
      } else {
        runError = error;
      }
    }
    await assertRunInputsUnchanged(
      context,
      scaffold,
      expectedSolutionHash,
      expectedScaffoldHash
    );
    if (runError) throw runError;
    return { context, execution, selectedName: selected?.name || '' };
  });
}

function runnerErrorMessage(error) {
  const base = String(error?.message || '运行测试失败，请稍后重试。');
  const details = [error?.stderr, error?.stdout]
    .map((value) => String(value || '').trim())
    .filter((value) => value && !base.includes(value));
  return [base, ...details].join('\n').slice(0, 12_000);
}

function logRunnerError(error, message) {
  outputChannel?.appendLine(`Sidebar test run failed: ${error?.stack || message}`);
  const appendDiagnostic = (label, value) => {
    const text = String(value || '').trim();
    if (text) outputChannel?.appendLine(`${label}:\n${text.slice(0, 30_000)}`);
  };
  appendDiagnostic('stderr', error?.stderr);
  appendDiagnostic('stdout', error?.stdout);
  for (const step of Array.isArray(error?.compileSteps) ? error.compileSteps : []) {
    appendDiagnostic(`${step.label || 'compile'} stderr`, step.stderr);
    appendDiagnostic(`${step.label || 'compile'} stdout`, step.stdout);
  }
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
    const caseErrors = Object.entries(result.execution.results || {})
      .filter(([, value]) => typeof value?.error === 'string' && value.error.trim())
      .map(([name, value]) => `${name}: ${value.error.trim()}`);
    const executionError = result.execution.ok === false
      ? (result.execution.error || '测试脚手架运行失败。')
      : caseErrors.length
        ? `测试代码报告错误：${caseErrors.slice(0, 20).join('；')}`
        : '';
    if (executionError) {
      outputChannel?.appendLine(`Sidebar test execution error: ${executionError}`);
      if (result.execution.stderr) outputChannel?.appendLine(result.execution.stderr);
    }
    setSidebarRuntime({
      busy: false,
      runBusy: false,
      runningCaseId: '',
      testResults: merged,
      resultFolder: result.context.folder,
      notice: result.execution.ok && !caseErrors.length
        ? (mode === 'case' ? '测试用例运行完成。' : '全部测试用例运行完成。')
        : '测试运行结束，已显示可用结果和错误信息。',
      error: executionError
    });
    return refreshSidebar();
  } catch (error) {
    const message = runnerErrorMessage(error);
    logRunnerError(error, message);
    if (error?.code === 'RUN_INPUT_CHANGED') clearRunResults();
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
  const updateMessage = (result) => {
    if (result.localOnly) return `已保存 ${result.testCase.name}；该本地题目不支持生成测试脚手架。`;
    if (result.generated) return `已保存 ${result.testCase.name}，并生成最新的 main 测试代码。`;
    if (result.scaffoldMayNeedRewrite) {
      return `已保存 ${result.testCase.name}。用例内容已修改，现有 main 可能不再与之匹配；如有需要，请点击“重新编写测试脚手架”。`;
    }
    return `已保存 ${result.testCase.name}。`;
  };
  return new LeetCodeCphSidebarProvider({
    onReady: () => refreshSidebar(),
    onDismissNotice: (payload) => dismissSidebarNotice(payload?.revision),
    onDismissError: (payload) => dismissSidebarError(payload?.revision),
    onShowError: (payload) => setSidebarRuntime({ notice: '', error: payload?.message || '操作失败，请稍后重试。' }),
    onAdd: (payload) => runSidebarAction(
      '正在新增空白测试用例…',
      () => mutateTestCaseAndScaffold('add', payload, updateAfterPersist),
      (result) => result.localOnly
        ? `已新增 ${result.testCase.name} 空白用例；填写后点击保存。该本地题目不支持生成或运行测试脚手架。`
        : `已新增 ${result.testCase.name} 空白用例；填写后点击保存，届时才会让 AI 更新测试脚手架。`,
      { testcaseMutation: true }
    ),
    onUpdate: (payload) => runSidebarAction(
      '正在保存测试用例…',
      () => mutateTestCaseAndScaffold('update', payload, updateAfterPersist),
      updateMessage,
      { testcaseMutation: true }
    ),
    onDelete: (payload) => runSidebarAction(
      '正在删除测试用例并更新 main 测试代码…',
      () => mutateTestCaseAndScaffold('delete', payload, updateAfterPersist),
      (result) => result.localOnly
        ? `已删除 ${result.deleted.name}；该本地题目没有生成 main 测试代码。`
        : `已删除 ${result.deleted.name}，并更新 main 测试代码。`,
      { testcaseMutation: true }
    ),
    onRunTestCase: (payload) => runSidebarTests('case', payload),
    onRunAllTestCases: (payload) => runSidebarTests('all', payload),
    onSync: (payload) => runSidebarAction('正在同步代码到 LeetCode…', () => syncActiveSolution(payload?.problemKey), (result) => result.duplicates ? `已同步到 LeetCode；另有 ${result.duplicates} 个同题标签未修改。` : '已同步代码到 LeetCode。'),
    onRegenerate: (payload) => runSidebarAction(
      'AI 正在重新编写 main 测试代码…',
      () => regenerateTestScaffold(payload),
      '已重新编写测试脚手架。',
      { testcaseMutation: true }
    ),
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
    if (!isCompanionExtensionRequest(request)) {
      return respond(response, 403, { error: 'Forbidden client origin' });
    }
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
        const jobKey = saved.aiPending ? captureJobKey(saved.problemFolder, saved.captureRevision) : '';
        if (jobKey) activeCaptureJobs.add(jobKey);
        respond(response, 200, {
          ok: true,
          folder: saved.folder,
          file: saved.file,
          solutionCreated: saved.solutionCreated,
          scaffoldStale: saved.scaffoldStale,
          aiPending: saved.aiPending
        });
        vscode.window.setStatusBarMessage(`LeetCode CPH: 已保存 ${payload.title}`, 5000);
        const notice = `已保存 ${payload.title} 的题面和网页代码。${saved.aiPending ? ' AI 正在后台提取测试用例…' : ` ${saved.extraction?.message || ''}`}`.trim();
        clearRunResults();
        setSidebarRuntime({ notice, error: '' });
        void refreshSidebar();
        if (saved.aiPending) {
          void processCapturedAi(payload, saved).then((result) => {
            if (result?.superseded) return;
            const scaffoldNotice = result?.scaffoldError
              ? `测试脚手架生成失败：${result.scaffoldError}`
              : result?.scaffoldGenerated ? '已自动生成测试脚手架。'
                : result?.scaffoldStale ? '测试脚手架需要更新。' : '';
            const completedNotice = `${result?.extraction?.message || 'AI 后台处理已完成。'}${scaffoldNotice ? ` ${scaffoldNotice}` : ''}`;
            clearRunResults();
            setSidebarRuntime({ notice: completedNotice, error: '' });
            void refreshSidebar();
          }).catch(async (error) => {
            const message = error?.message || 'AI 后台处理失败。';
            outputChannel?.appendLine(`Background capture processing failed: ${error?.stack || message}`);
            await markCaptureProcessingFailed(saved, error).catch((writeError) => {
              outputChannel?.appendLine(`Could not persist background capture failure: ${writeError.message}`);
            });
            setSidebarRuntime({ notice: '', error: `题面和网页代码已保存，但 ${message}` });
            void refreshSidebar();
          }).finally(() => {
            if (jobKey) {
              activeCaptureJobs.delete(jobKey);
              supersededCaptureJobs.delete(jobKey);
            }
            void refreshSidebar();
          });
        }
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

async function handleSolutionRenames(event) {
  if (!workspaceFolders().length) return;
  const records = await listStoredProblemRecords();
  const updatedFolders = new Set();
  for (const item of event?.files || []) {
    const oldPath = item.oldUri?.scheme === 'file' ? item.oldUri.fsPath : '';
    const newPath = item.newUri?.scheme === 'file' ? item.newUri.fsPath : '';
    if (!oldPath || !newPath) continue;
    for (const record of records) {
      if (updatedFolders.has(pathKey(record.folder))) continue;
      const oldSolution = record.solutionPath;
      if (!isPathInside(oldPath, oldSolution)) continue;
      const relative = path.relative(path.resolve(oldPath), path.resolve(oldSolution));
      const rebasedSolution = relative ? path.resolve(newPath, relative) : path.resolve(newPath);
      if (reservedSolutionFileName(rebasedSolution)) {
        vscode.window.showWarningMessage('main.<语言> 和 testcase.<语言> 是测试入口保留名称，不能作为题目解答文件名。请将文件改回 solution.<语言>。');
        continue;
      }
      const targetWorkspace = workspaceFolderForPath(rebasedSolution);
      if (!targetWorkspace || path.extname(oldSolution).toLowerCase() !== path.extname(rebasedSolution).toLowerCase()) {
        vscode.window.showWarningMessage('题目解答移出当前工作区或更改语言后无法继续关联；请移回工作区、改回原后缀，或重新抓取题目。');
        continue;
      }
      await withProblemLock(record.folder, async () => {
        const metadataPath = path.join(record.folder, 'metadata.json');
        const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
        // The filesystem move happens before VS Code delivers this async
        // callback. A newer capture may already have recreated the old path
        // and advanced the record. In that case this event belongs to the
        // previous revision and must not redirect the fresh capture to the
        // renamed file containing older code.
        if (record.metadata?.captureRevision
          && metadata.captureRevision !== record.metadata.captureRevision) return;
        const latestSolution = metadataSolutionPath(metadata);
        if (!latestSolution || !isPathInside(oldPath, latestSolution)) return;
        const latestRelative = path.relative(path.resolve(oldPath), path.resolve(latestSolution));
        const latestRebased = latestRelative ? path.resolve(newPath, latestRelative) : path.resolve(newPath);
        const latestWorkspace = workspaceFolderForPath(latestRebased);
        if (!latestWorkspace || reservedSolutionFileName(latestRebased)
          || path.extname(latestSolution).toLowerCase() !== path.extname(latestRebased).toLowerCase()) return;
        if (pathKey(latestSolution) !== pathKey(latestRebased) && await fileExists(latestSolution)) return;
        const solutionFileRenamed = path.basename(latestSolution) !== path.basename(latestRebased);
        const next = {
          ...metadata,
          solutionPath: latestRebased,
          solutionRelativePath: path.relative(latestWorkspace.path, latestRebased),
          workspaceRootPath: latestWorkspace.path,
          workspaceFolderUri: latestWorkspace.uri,
          solutionFileName: path.basename(latestRebased),
          testcaseScaffoldStale: solutionFileRenamed
            ? true
            : Boolean(metadata.testcaseScaffoldStale)
        };
        await writeTextAtomically(metadataPath, JSON.stringify(next, null, 2));
        solutionRecordCache.delete(pathKey(latestSolution));
        cacheSolutionRecord(latestRebased, record.folder);
      });
      updatedFolders.add(pathKey(record.folder));
    }
  }
  void refreshSidebar();
}

function activate(context) {
  initializeExtensionStorage(context);
  outputChannel = vscode.window.createOutputChannel('LeetCode CPH Receiver');
  applyTracker = new ApplyTracker({ log: (line) => outputChannel.appendLine(line) });
  // API keys are deliberately held only by VS Code SecretStorage.  Unit-test
  // sandboxes may omit it, but a real ExtensionContext always provides it.
  aiTestcaseService = context.secrets ? createAiTestcaseService({ secrets: context.secrets }) : undefined;
  sidebarProvider = createSidebar();
  startServer();
  heartbeatTimer = setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);
  context.subscriptions.push(outputChannel, sidebarProvider, { dispose: () => { clearInterval(heartbeatTimer); clearSidebarNoticeTimer(); clearSidebarErrorTimer(); server?.close(); } });
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
      const stateFolder = filePath ? solutionRecordCache.get(pathKey(filePath)) : '';
      if (stateFolder) {
        clearRunResults(stateFolder);
        void refreshSidebar();
      } else if (/^(?:solution|main|testcase)\.[^.]+$/i.test(name)) {
        // Legacy visible-directory compatibility.
        clearRunResults(path.dirname(filePath));
        void refreshSidebar();
      }
    }));
  }
  if (typeof vscode.workspace.onDidRenameFiles === 'function') {
    context.subscriptions.push(vscode.workspace.onDidRenameFiles((event) => {
      void handleSolutionRenames(event).catch((error) => {
        outputChannel?.appendLine(`Could not update renamed solution record: ${error.stack || error.message}`);
      });
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
  void repairInterruptedCaptureJobs().catch((error) => {
    outputChannel?.appendLine(`Could not repair interrupted AI capture state: ${error.stack || error.message}`);
  }).finally(() => refreshSidebar());
}

function deactivate() {
  clearInterval(heartbeatTimer);
  clearSidebarNoticeTimer();
  clearSidebarErrorTimer();
  sidebarRefreshEpoch += 1;
  applyTracker?.disposeAll('VS Code 扩展已停止。');
  sidebarProvider?.dispose();
  sidebarProvider = undefined;
  aiTestcaseService = undefined;
  solutionRecordCache.clear();
  activeCaptureJobs.clear();
  supersededCaptureJobs.clear();
  activeTestcaseAiJobs.clear();
  extensionStoragePath = '';
  for (const client of socketClients) client.socket.destroy();
  return new Promise((resolve) => server?.close(resolve) || resolve());
}
module.exports = { activate, deactivate };
