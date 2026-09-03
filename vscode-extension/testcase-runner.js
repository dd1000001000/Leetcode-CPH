'use strict';

// Local execution support for AI-generated testcase scaffolds.
//
// Scaffold stdout protocol (one JSON object per line):
//   __LEETCODE_CPH_RESULT__{"name":"testcase 001","actual":"[0,1]","passed":true}
//
// `name` and `actual` are required. `passed` and `error` are optional and are
// deliberately left to the scaffold: the expected output is already retained
// in testcases.json and the sidebar can render an exact expected/actual diff.
// A scaffold should emit one result for every selected testcase, including a
// failed assertion, and should reserve a non-zero process exit for a genuine
// runtime/setup failure.  This module never uses a shell and only executes a
// real `testcase.py` or `testcase.js` file located inside the current problem
// folder (including after symlinks have been resolved).

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const RESULT_MARKER = '__LEETCODE_CPH_RESULT__';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const MAX_OUTPUT_BYTES = 5_000_000;
// Do not hand an AI-generated program the extension host's entire
// environment. Keep only the small platform/runtime set needed to locate an
// interpreter and create ordinary temporary files; API credentials and other
// arbitrary user variables are deliberately excluded.
const SAFE_ENVIRONMENT_KEYS = Object.freeze([
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC',
  'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE'
]);

class TestcaseRunnerError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'TestcaseRunnerError';
    this.code = code;
    Object.assign(this, details);
  }
}

function runnerError(message, code, details) {
  return new TestcaseRunnerError(message, code, details);
}

function isPathInside(parent, child) {
  const relative = path.relative(parent, child);
  return Boolean(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function boundedInteger(value, fallback, maximum, label) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw runnerError(`${label} 必须是 1 到 ${maximum} 之间的整数。`, 'INVALID_LIMIT');
  }
  return value;
}

function normalizeMode(mode, caseName) {
  const selectedMode = mode == null ? (caseName == null || caseName === '' ? 'all' : 'case') : String(mode);
  if (selectedMode !== 'all' && selectedMode !== 'case') {
    throw runnerError('测试运行模式必须是 all 或 case。', 'INVALID_MODE');
  }
  if (selectedMode === 'all') {
    if (caseName != null && String(caseName).trim()) {
      throw runnerError('运行全部测试时不能指定测试用例名称。', 'INVALID_MODE');
    }
    return { mode: 'all', caseName: null };
  }
  if (typeof caseName !== 'string' || !caseName.trim()) {
    throw runnerError('单个测试运行需要有效的测试用例名称。', 'INVALID_CASE_NAME');
  }
  return { mode: 'case', caseName: caseName.trim() };
}

function normalizeExpectedCaseNames(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) {
    throw runnerError('预期测试用例名称必须是数组。', 'INVALID_EXPECTED_CASES');
  }
  const names = [];
  const seen = new Set();
  for (const rawName of value) {
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (!name || seen.has(name)) {
      throw runnerError('预期测试用例名称必须是唯一的非空文本。', 'INVALID_EXPECTED_CASES');
    }
    seen.add(name);
    names.push(name);
  }
  return names;
}

function assertExpectedResultSet(results, expectedNames) {
  const returnedNames = Object.keys(results);
  const expected = new Set(expectedNames);
  const returned = new Set(returnedNames);
  const missing = expectedNames.filter((name) => !returned.has(name));
  const unexpected = returnedNames.filter((name) => !expected.has(name));
  if (missing.length || unexpected.length) {
    const details = [
      missing.length ? `缺少：${missing.join('、')}` : '',
      unexpected.length ? `多余：${unexpected.join('、')}` : ''
    ].filter(Boolean).join('；');
    throw runnerError(`测试脚手架返回的测试结果与当前请求不一致（${details}）。请重新生成测试脚手架。`, 'RESULT_SET_MISMATCH', { missing, unexpected });
  }
}

function extensionLanguage(scaffoldPath) {
  const extension = path.extname(scaffoldPath).toLowerCase();
  if (extension === '.py') return 'python';
  if (extension === '.js') return 'javascript';
  throw runnerError(
    `暂不支持运行 ${extension || '无扩展名'} 测试脚手架。目前仅支持 Python（.py）和 JavaScript（.js）。`,
    'UNSUPPORTED_LANGUAGE'
  );
}

/**
 * Resolve and validate the only file the runner is allowed to execute.
 * A lexical containment check alone is insufficient because testcase.py can
 * be a symlink; both paths are therefore canonicalized before the final check.
 */
async function resolveLocalScaffoldPath(problemFolder, scaffoldPath, { fsPromises = fs } = {}) {
  if (typeof problemFolder !== 'string' || !problemFolder.trim()) {
    throw runnerError('缺少题目目录，无法运行测试。', 'INVALID_PROBLEM_FOLDER');
  }
  if (typeof scaffoldPath !== 'string' || !scaffoldPath.trim()) {
    throw runnerError('缺少测试脚手架文件，无法运行测试。', 'INVALID_SCAFFOLD_PATH');
  }

  const requestedRoot = path.resolve(problemFolder);
  const requestedScaffold = path.isAbsolute(scaffoldPath)
    ? path.resolve(scaffoldPath)
    : path.resolve(requestedRoot, scaffoldPath);
  if (!isPathInside(requestedRoot, requestedScaffold)) {
    throw runnerError('测试脚手架必须位于当前题目目录内。', 'SCAFFOLD_OUTSIDE_PROBLEM');
  }

  let realRoot;
  let realScaffold;
  try {
    [realRoot, realScaffold] = await Promise.all([
      fsPromises.realpath(requestedRoot),
      fsPromises.realpath(requestedScaffold)
    ]);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw runnerError('未找到题目目录或测试脚手架文件。请先生成并保存 testcase.*。', 'SCAFFOLD_NOT_FOUND');
    }
    throw runnerError(`无法访问测试脚手架：${error?.message || '未知错误'}。`, 'SCAFFOLD_ACCESS_FAILED');
  }
  if (!isPathInside(realRoot, realScaffold)) {
    throw runnerError('测试脚手架的真实路径不在当前题目目录内，已拒绝执行。', 'SCAFFOLD_OUTSIDE_PROBLEM');
  }

  let stat;
  try {
    stat = await fsPromises.stat(realScaffold);
  } catch (error) {
    throw runnerError(`无法读取测试脚手架：${error?.message || '未知错误'}。`, 'SCAFFOLD_ACCESS_FAILED');
  }
  if (!stat.isFile()) {
    throw runnerError('测试脚手架必须是普通文件。', 'INVALID_SCAFFOLD_PATH');
  }
  if (!/^testcase\.[a-z0-9]+$/i.test(path.basename(realScaffold))) {
    throw runnerError('只能运行题目目录中名为 testcase.<语言> 的脚手架文件。', 'INVALID_SCAFFOLD_NAME');
  }

  return { problemFolder: realRoot, scaffoldPath: realScaffold, language: extensionLanguage(realScaffold) };
}

/**
 * Build a shell-free process plan. The JavaScript runtime is the extension
 * host's own executable; ELECTRON_RUN_AS_NODE also makes it work in VS Code's
 * Electron-based extension host rather than attempting to launch another UI.
 */
function buildRunPlan({ scaffoldPath, language, mode = 'all', caseName = null, platform = process.platform, nodePath = process.execPath } = {}) {
  if (typeof scaffoldPath !== 'string' || !scaffoldPath) {
    throw runnerError('缺少测试脚手架路径。', 'INVALID_SCAFFOLD_PATH');
  }
  const normalized = normalizeMode(mode, caseName);
  const selectedLanguage = language || extensionLanguage(scaffoldPath);
  const selector = normalized.mode === 'case' ? ['--case', normalized.caseName] : [];

  if (selectedLanguage === 'javascript') {
    if (typeof nodePath !== 'string' || !nodePath) {
      throw runnerError('未找到 JavaScript 运行时。请重新加载 VS Code 后重试。', 'RUNTIME_UNAVAILABLE');
    }
    return {
      language: selectedLanguage,
      command: nodePath,
      args: [scaffoldPath, ...selector],
      mode: normalized.mode,
      caseName: normalized.caseName,
      environment: { ELECTRON_RUN_AS_NODE: '1' }
    };
  }
  if (selectedLanguage === 'python') {
    // `py -3` is the standard Python launcher on Windows; python3 is the
    // conventional executable on macOS/Linux. The spawn error below gives a
    // direct installation/path hint if that runtime is unavailable.
    const windows = platform === 'win32';
    return {
      language: selectedLanguage,
      command: windows ? 'py' : 'python3',
      args: [...(windows ? ['-3'] : []), scaffoldPath, ...selector],
      mode: normalized.mode,
      caseName: normalized.caseName,
      environment: {}
    };
  }
  throw runnerError(`暂不支持运行 ${selectedLanguage} 测试脚手架。`, 'UNSUPPORTED_LANGUAGE');
}

function textFromChunks(chunks) {
  return Buffer.concat(chunks).toString('utf8');
}

function safeExecutionEnvironment(extra = {}) {
  const environment = {};
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    if (typeof process.env[key] === 'string') environment[key] = process.env[key];
  }
  // Avoid automatic imports from user-site Python packages and accidental
  // bytecode writes. Callers' explicit runtime flags are appended last.
  environment.PYTHONNOUSERSITE = '1';
  environment.PYTHONDONTWRITEBYTECODE = '1';
  return { ...environment, ...extra };
}

function validateExpectedScaffoldHash(value) {
  if (value === undefined || value === null || value === '') return '';
  const hash = String(value).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw runnerError('测试脚手架校验摘要无效。请重新确认后再运行。', 'INVALID_SCAFFOLD_HASH');
  }
  return hash;
}

async function assertExpectedScaffoldHash(scaffoldPath, expectedHash, fsPromises) {
  if (!expectedHash) return;
  const reader = fsPromises && typeof fsPromises.readFile === 'function' ? fsPromises : fs;
  let bytes;
  try {
    bytes = await reader.readFile(scaffoldPath);
  } catch (error) {
    throw runnerError(`无法读取测试脚手架进行校验：${error?.message || '未知错误'}。`, 'SCAFFOLD_ACCESS_FAILED');
  }
  const actualHash = crypto.createHash('sha256').update(bytes).digest('hex');
  if (actualHash !== expectedHash) {
    throw runnerError('测试脚手架在确认后已发生变化。请审阅最新内容并再次运行。', 'SCAFFOLD_CHANGED');
  }
}

/**
 * Parse the stdout protocol without evaluating any output. The result is an
 * object keyed by testcase name so callers can merge it directly with the
 * persisted testcase list and render expected-versus-actual values.
 */
function parseResultLines(stdout) {
  const results = Object.create(null);
  const source = Buffer.isBuffer(stdout) ? stdout.toString('utf8') : String(stdout || '');
  const lines = source.split(/\r?\n/);
  let markerCount = 0;
  for (const rawLine of lines) {
    const line = rawLine.trimStart();
    if (!line.startsWith(RESULT_MARKER)) continue;
    markerCount += 1;
    const json = line.slice(RESULT_MARKER.length).trim();
    let value;
    try {
      value = JSON.parse(json);
    } catch (_) {
      throw runnerError('测试脚手架输出了格式错误的测试结果 JSON。请重新生成测试脚手架。', 'INVALID_RESULT_PROTOCOL');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw runnerError('测试脚手架结果必须是 JSON 对象。请重新生成测试脚手架。', 'INVALID_RESULT_PROTOCOL');
    }
    const name = typeof value.name === 'string' ? value.name.trim() : '';
    if (!name || !Object.prototype.hasOwnProperty.call(value, 'actual')) {
      throw runnerError('测试脚手架结果必须包含 name 和 actual。请重新生成测试脚手架。', 'INVALID_RESULT_PROTOCOL');
    }
    if (Object.prototype.hasOwnProperty.call(results, name)) {
      throw runnerError(`测试脚手架重复输出了测试用例 “${name}” 的结果。`, 'DUPLICATE_RESULT');
    }
    if (Object.prototype.hasOwnProperty.call(value, 'passed') && typeof value.passed !== 'boolean') {
      throw runnerError(`测试用例 “${name}” 的 passed 必须是布尔值。`, 'INVALID_RESULT_PROTOCOL');
    }
    if (Object.prototype.hasOwnProperty.call(value, 'error') && typeof value.error !== 'string') {
      throw runnerError(`测试用例 “${name}” 的 error 必须是字符串。`, 'INVALID_RESULT_PROTOCOL');
    }
    results[name] = {
      name,
      actual: value.actual,
      ...(Object.prototype.hasOwnProperty.call(value, 'passed') ? { passed: value.passed } : {}),
      ...(Object.prototype.hasOwnProperty.call(value, 'error') ? { error: value.error } : {})
    };
  }
  return { results, markerCount };
}

function formatActualOutput(actual) {
  try {
    const value = JSON.stringify(actual);
    return value === undefined ? String(actual) : value;
  } catch (_) {
    return String(actual);
  }
}

/**
 * Decorate persisted testcase records for a sidebar render. It intentionally
 * does not attempt to parse or coerce expectedOutput: that text is the exact
 * value captured/generated for the testcase, while actualOutput is the exact
 * protocol value rendered as text. A UI can therefore show a useful diff even
 * when the language-specific scaffold owns the semantic comparison.
 */
function mergeRunResults(testCases, results) {
  const byName = results && typeof results === 'object' ? results : {};
  if (!Array.isArray(testCases)) return [];
  return testCases.map((testCase) => {
    const name = typeof testCase?.name === 'string' ? testCase.name.trim() : '';
    const result = name && Object.prototype.hasOwnProperty.call(byName, name) ? byName[name] : undefined;
    if (!result) return { ...testCase, hasRunResult: false };
    return {
      ...testCase,
      hasRunResult: true,
      actualOutput: formatActualOutput(result.actual),
      ...(typeof result.passed === 'boolean' ? { passed: result.passed } : {}),
      ...(typeof result.error === 'string' ? { runError: result.error } : {})
    };
  });
}

function outputExcerpt(stdout, stderr) {
  const source = String(stderr || '').trim() || String(stdout || '').trim();
  if (!source) return '';
  const limit = 1_500;
  return source.length <= limit ? source : `${source.slice(0, limit)}…`;
}

function runtimeUnavailableError(plan, error) {
  const label = plan.language === 'python' ? 'Python 3' : 'JavaScript';
  const hint = plan.language === 'python'
    ? '请安装 Python 3，并确认 py（Windows）或 python3（macOS/Linux）可在终端中使用。'
    : '请重新加载 VS Code 后重试。';
  return runnerError(`无法启动 ${label} 运行时（${plan.command}）：${hint}`, 'RUNTIME_UNAVAILABLE', { cause: error });
}

function terminate(child, platform = process.platform) {
  const pid = Number(child?.pid);
  // On POSIX, the runner starts the process in its own group so this also
  // kills descendants that inherited stdout/stderr. On Windows taskkill's /T
  // flag performs the equivalent job-tree termination. The direct kill below
  // remains as a portable fallback for mocked/failed process handles.
  if (Number.isSafeInteger(pid) && pid > 0) {
    if (platform !== 'win32') {
      try { process.kill(-pid, 'SIGKILL'); } catch (_) { /* Fall back below. */ }
    } else {
      try {
        const killer = childProcess.spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
          shell: false,
          windowsHide: true,
          stdio: 'ignore'
        });
        killer.unref?.();
      } catch (_) { /* Fall back below. */ }
    }
  }
  try {
    child.kill('SIGKILL');
  } catch (_) {
    // A process can exit between the limit check and kill; close will settle it.
  }
}

/**
 * Execute a local testcase scaffold. `mode: 'case'` passes exactly
 * `--case <caseName>`; `mode: 'all'` passes no selector. No command string is
 * assembled and `shell` is explicitly false, so a testcase name is data rather
 * than shell syntax.
 *
 * A completed program returns structured results even if it exits non-zero,
 * allowing the sidebar to show any results emitted before a runtime failure.
 * Startup, timeout, output-limit, path, and protocol failures reject with a
 * TestcaseRunnerError and an actionable `code`.
 */
async function runTestScaffold({
  problemFolder,
  scaffoldPath,
  mode,
  caseName,
  timeoutMs,
  maxOutputBytes,
  expectedCaseNames,
  expectedScaffoldHash,
  spawnImpl = childProcess.spawn,
  platform,
  nodePath,
  fsPromises
} = {}) {
  if (typeof spawnImpl !== 'function') throw new TypeError('spawnImpl 必须是函数。');
  const selectedPlatform = platform || process.platform;
  const location = await resolveLocalScaffoldPath(problemFolder, scaffoldPath, { fsPromises });
  const expectedHash = validateExpectedScaffoldHash(expectedScaffoldHash);
  // Confirmation happens in the extension host. Re-read the exact disk file
  // immediately before spawn so an external atomic replacement cannot cause
  // the user to approve one scaffold and execute a different one.
  await assertExpectedScaffoldHash(location.scaffoldPath, expectedHash, fsPromises);
  const plan = buildRunPlan({
    scaffoldPath: location.scaffoldPath,
    language: location.language,
    mode,
    caseName,
    platform: selectedPlatform,
    nodePath
  });
  const selectedTimeoutMs = boundedInteger(timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, '测试超时时间');
  const selectedMaxOutputBytes = boundedInteger(maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES, '测试输出上限');
  const requestedExpectedNames = normalizeExpectedCaseNames(expectedCaseNames);
  // A single-case invocation must never accept output for another card, even
  // if a caller forgot to supply an expected list. For all-cases mode the
  // sidebar supplies its runnable testcase names; generic callers can omit
  // the list and retain the looser protocol-only behavior.
  const expectedNames = plan.mode === 'case' ? [plan.caseName] : requestedExpectedNames;

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(plan.command, plan.args, {
        cwd: location.problemFolder,
        shell: false,
        windowsHide: true,
        // Put POSIX children in an isolated process group. On timeout or an
        // output-limit breach terminate() can then kill the entire group,
        // including descendants that kept stdout/stderr inherited.
        detached: selectedPlatform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: safeExecutionEnvironment(plan.environment)
      });
    } catch (error) {
      reject(runtimeUnavailableError(plan, error));
      return;
    }
    if (!child || typeof child.once !== 'function' || !child.stdout || !child.stderr) {
      reject(runnerError('无法启动测试进程。', 'PROCESS_START_FAILED'));
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    let outputBytes = 0;
    let timedOut = false;
    let outputTooLarge = false;
    let settled = false;
    let forcedStopTimer;
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forcedStopTimer);
      callback();
    };
    const addOutput = (chunks, chunk) => {
      if (outputTooLarge) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      outputBytes += buffer.length;
      if (outputBytes > selectedMaxOutputBytes) {
        outputTooLarge = true;
        stopNow();
        return;
      }
      chunks.push(buffer);
    };
    const stopNow = () => {
      if (settled) return;
      terminate(child, selectedPlatform);
      // A descendant may retain the inherited pipes even after its direct
      // parent exits. Destroying our pipe ends and settling after a short
      // grace period prevents the extension's per-problem lock and sidebar
      // from hanging forever in that situation.
      try { child.stdout.destroy(); } catch (_) { /* best effort */ }
      try { child.stderr.destroy(); } catch (_) { /* best effort */ }
      if (settled) return;
      if (!forcedStopTimer) {
        forcedStopTimer = setTimeout(() => settle(() => {
          const error = timedOut
            ? runnerError(`测试运行超过 ${selectedTimeoutMs}ms，已停止。请检查死循环或缩小测试规模。`, 'EXECUTION_TIMEOUT')
            : runnerError(`测试输出超过 ${selectedMaxOutputBytes} 字节，已停止。请减少调试输出。`, 'OUTPUT_LIMIT_EXCEEDED');
          reject(error);
        }), 500);
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stopNow();
    }, selectedTimeoutMs);

    child.stdout.on('data', (chunk) => addOutput(stdoutChunks, chunk));
    child.stderr.on('data', (chunk) => addOutput(stderrChunks, chunk));
    child.once('error', (error) => settle(() => reject(
      error?.code === 'ENOENT' ? runtimeUnavailableError(plan, error) : runnerError(`无法启动测试进程：${error?.message || '未知错误'}。`, 'PROCESS_START_FAILED', { cause: error })
    )));
    child.once('close', (exitCode, signal) => settle(() => {
      if (timedOut) {
        reject(runnerError(`测试运行超过 ${selectedTimeoutMs}ms，已停止。请检查死循环或缩小测试规模。`, 'EXECUTION_TIMEOUT'));
        return;
      }
      if (outputTooLarge) {
        reject(runnerError(`测试输出超过 ${selectedMaxOutputBytes} 字节，已停止。请减少调试输出。`, 'OUTPUT_LIMIT_EXCEEDED'));
        return;
      }

      const stdout = textFromChunks(stdoutChunks);
      const stderr = textFromChunks(stderrChunks);
      let parsed;
      try {
        parsed = parseResultLines(stdout);
      } catch (error) {
        reject(error);
        return;
      }
      const results = parsed.results;
      if (expectedNames) {
        try {
          assertExpectedResultSet(results, expectedNames);
        } catch (error) {
          reject(error);
          return;
        }
      } else if (plan.mode === 'all' && !parsed.markerCount && exitCode === 0) {
        reject(runnerError('测试脚手架没有输出测试结果。请重新生成测试脚手架。', 'MISSING_RESULT_PROTOCOL'));
        return;
      }

      const ok = exitCode === 0 && !signal;
      const excerpt = ok ? '' : outputExcerpt(stdout, stderr);
      resolve({
        ...plan,
        ok,
        results,
        stdout,
        stderr,
        exitCode: typeof exitCode === 'number' ? exitCode : null,
        signal: signal || null,
        error: ok ? '' : `测试脚手架运行失败${exitCode == null ? '' : `（退出码 ${exitCode}）`}。${excerpt ? ` ${excerpt}` : ''}`
      });
    }));
  });
}

function runAllTestCases(options = {}) {
  return runTestScaffold({ ...options, mode: 'all', caseName: undefined });
}

function runSingleTestCase(options = {}, caseName = options.caseName) {
  return runTestScaffold({ ...options, mode: 'case', caseName });
}

module.exports = {
  RESULT_MARKER,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  MAX_OUTPUT_BYTES,
  TestcaseRunnerError,
  isPathInside,
  extensionLanguage,
  normalizeMode,
  resolveLocalScaffoldPath,
  buildRunPlan,
  parseResultLines,
  formatActualOutput,
  safeExecutionEnvironment,
  validateExpectedScaffoldHash,
  assertExpectedScaffoldHash,
  mergeRunResults,
  runTestScaffold,
  runAllTestCases,
  runSingleTestCase
};
