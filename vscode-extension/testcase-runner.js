'use strict';

// Local execution support for AI-generated testcase scaffolds.
//
// Scaffold stdout protocol (one JSON object per line):
//   __LEETCODE_CPH_RESULT__{"name":"testcase 001","actual":"[0,1]","passed":true}
//
// The runner deliberately does not use a shell.  It supports a small set of
// language adapters, each of which receives a clean temporary build directory
// for compiled languages.  The visible problem directory is never used for
// compiler output.

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const RESULT_MARKER = '__LEETCODE_CPH_RESULT__';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_COMPILE_TIMEOUT_MS = 60_000;
const MAX_COMPILE_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const MAX_OUTPUT_BYTES = 5_000_000;
const RUNTIME_MAIN_BASENAME = 'main';
const LEGACY_SCAFFOLD_BASENAME = 'testcase';
const RUNTIME_SOLUTION_BASENAME = 'solution';
const BUILD_DIRECTORY_PREFIX = 'leetcode-cph-build-';

// Do not hand an AI-generated program the extension host's entire
// environment. Keep only the small platform/runtime set needed to locate an
// interpreter and create ordinary temporary files; API credentials and other
// arbitrary user variables are deliberately excluded.
const SAFE_ENVIRONMENT_KEYS = Object.freeze([
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC',
  'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE'
]);

const LANGUAGE_BY_EXTENSION = Object.freeze({
  '.c': { id: 'c', extension: '.c', label: 'C', compiled: true },
  '.cc': { id: 'cpp', extension: '.cc', label: 'C++', compiled: true },
  '.cpp': { id: 'cpp', extension: '.cpp', label: 'C++', compiled: true },
  '.cxx': { id: 'cpp', extension: '.cxx', label: 'C++', compiled: true },
  '.cs': { id: 'csharp', extension: '.cs', label: 'C#', compiled: true },
  '.rs': { id: 'rust', extension: '.rs', label: 'Rust', compiled: true },
  '.go': { id: 'go', extension: '.go', label: 'Go', compiled: true },
  '.hs': { id: 'haskell', extension: '.hs', label: 'Haskell', compiled: true },
  '.lhs': { id: 'haskell', extension: '.lhs', label: 'Haskell', compiled: true },
  '.py': { id: 'python', extension: '.py', label: 'Python', compiled: false },
  '.rb': { id: 'ruby', extension: '.rb', label: 'Ruby', compiled: false },
  '.java': { id: 'java', extension: '.java', label: 'Java', compiled: true },
  '.js': { id: 'javascript', extension: '.js', label: 'JavaScript', compiled: false },
  '.mjs': { id: 'javascript', extension: '.mjs', label: 'JavaScript', compiled: false },
  '.cjs': { id: 'javascript', extension: '.cjs', label: 'JavaScript', compiled: false },
  '.ts': { id: 'typescript', extension: '.ts', label: 'TypeScript', compiled: true },
  '.kt': { id: 'kotlin', extension: '.kt', label: 'Kotlin', compiled: true },
  '.kts': { id: 'kotlin', extension: '.kts', label: 'Kotlin', compiled: true },
  '.swift': { id: 'swift', extension: '.swift', label: 'Swift', compiled: true },
  '.php': { id: 'php', extension: '.php', label: 'PHP', compiled: false },
  '.scala': { id: 'scala', extension: '.scala', label: 'Scala', compiled: true }
});

const LANGUAGE_ALIASES = Object.freeze({
  c: 'c',
  cpp: 'cpp',
  'c++': 'cpp',
  csharp: 'csharp',
  'c#': 'csharp',
  cs: 'csharp',
  rust: 'rust',
  go: 'go',
  haskell: 'haskell',
  python: 'python',
  ruby: 'ruby',
  java: 'java',
  javascript: 'javascript',
  js: 'javascript',
  typescript: 'typescript',
  ts: 'typescript',
  kotlin: 'kotlin',
  kt: 'kotlin',
  swift: 'swift',
  php: 'php',
  scala: 'scala'
});

const LANGUAGE_BY_ID = Object.freeze(Object.values(LANGUAGE_BY_EXTENSION).reduce((byId, item) => {
  if (!byId[item.id] || item.extension.length < byId[item.id].extension.length) {
    byId[item.id] = item;
  }
  return byId;
}, Object.create(null)));

const CANONICAL_EXTENSION_BY_LANGUAGE = Object.freeze({
  c: '.c',
  cpp: '.cpp',
  csharp: '.cs',
  rust: '.rs',
  go: '.go',
  haskell: '.hs',
  python: '.py',
  ruby: '.rb',
  java: '.java',
  javascript: '.js',
  typescript: '.ts',
  kotlin: '.kt',
  swift: '.swift',
  php: '.php',
  scala: '.scala'
});

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
    && !relative.startsWith('..' + path.sep)
    && !path.isAbsolute(relative);
}

function boundedInteger(value, fallback, maximum, label) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw runnerError(label + ' 必须是 1 到 ' + maximum + ' 之间的整数。', 'INVALID_LIMIT');
  }
  return value;
}

function normalizeMode(mode, caseName) {
  const selectedMode = mode == null
    ? (caseName == null || caseName === '' ? 'all' : 'case')
    : String(mode);
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
      missing.length ? '缺少：' + missing.join('、') : '',
      unexpected.length ? '多余：' + unexpected.join('、') : ''
    ].filter(Boolean).join('；');
    throw runnerError(
      '测试脚手架返回的测试结果与当前请求不一致（' + details + '）。请重新生成测试脚手架。',
      'RESULT_SET_MISMATCH',
      { missing, unexpected }
    );
  }
}

function extensionLanguage(filePath) {
  const extension = path.extname(String(filePath || '')).toLowerCase();
  if (extension === '.sql') {
    throw runnerError('SQL 测试脚手架不能作为本地进程执行。请使用数据库专用测试环境。', 'UNSUPPORTED_LANGUAGE');
  }
  const descriptor = LANGUAGE_BY_EXTENSION[extension];
  if (!descriptor) {
    throw runnerError(
      '暂不支持运行 ' + (extension || '无扩展名') + ' 测试脚手架。',
      'UNSUPPORTED_LANGUAGE'
    );
  }
  return descriptor.id;
}

function languageDescriptor(language, filePath) {
  const fromFile = filePath ? extensionLanguage(filePath) : null;
  const normalized = language == null || language === ''
    ? fromFile
    : LANGUAGE_ALIASES[String(language).trim().toLowerCase()];
  if (!normalized || !LANGUAGE_BY_ID[normalized]) {
    throw runnerError('暂不支持运行 ' + String(language || '未知语言') + ' 测试脚手架。', 'UNSUPPORTED_LANGUAGE');
  }
  if (fromFile && normalized !== fromFile) {
    throw runnerError('测试脚手架扩展名与指定语言不一致。', 'LANGUAGE_MISMATCH');
  }
  return LANGUAGE_BY_ID[normalized];
}

function supportsLanguage(languageOrPath) {
  try {
    if (typeof languageOrPath !== 'string') return false;
    if (languageOrPath.startsWith('.')) return Boolean(LANGUAGE_BY_EXTENSION[languageOrPath.toLowerCase()]);
    if (languageOrPath.includes(path.sep) || languageOrPath.includes('/') || languageOrPath.includes('\\')) {
      extensionLanguage(languageOrPath);
      return true;
    }
    return Boolean(LANGUAGE_ALIASES[languageOrPath.trim().toLowerCase()]);
  } catch (_) {
    return false;
  }
}

function isCompiledLanguage(languageOrPath) {
  try {
    const descriptor = typeof languageOrPath === 'string'
      && (languageOrPath.includes(path.sep) || languageOrPath.includes('/') || languageOrPath.includes('\\') || languageOrPath.startsWith('.'))
      ? languageDescriptor(null, languageOrPath.startsWith('.') ? 'file' + languageOrPath : languageOrPath)
      : languageDescriptor(languageOrPath);
    return descriptor.compiled;
  } catch (_) {
    return false;
  }
}

function languageExtension(language, fallbackPath) {
  const descriptor = languageDescriptor(language, fallbackPath);
  const extension = fallbackPath ? path.extname(fallbackPath).toLowerCase() : '';
  return LANGUAGE_BY_EXTENSION[extension]?.id === descriptor.id
    ? extension
    : (CANONICAL_EXTENSION_BY_LANGUAGE[descriptor.id] || descriptor.extension);
}

function getFsMethod(fsPromises, name) {
  const owner = fsPromises && typeof fsPromises[name] === 'function' ? fsPromises : fs;
  return owner[name].bind(owner);
}

async function resolveInsideRegularFile(problemFolder, candidatePath, {
  fsPromises,
  outsideCode = 'SOURCE_OUTSIDE_PROBLEM',
  outsideMessage = '文件的真实路径不在当前题目目录内，已拒绝执行。',
  missingCode = 'MAIN_SOURCE_NOT_FOUND',
  missingMessage = '未找到运行所需的 source 文件。',
  accessCode = 'SOURCE_ACCESS_FAILED',
  accessPrefix = '无法访问文件'
} = {}) {
  const realpath = getFsMethod(fsPromises, 'realpath');
  const statFile = getFsMethod(fsPromises, 'stat');
  const requestedRoot = path.resolve(problemFolder);
  const requestedFile = path.isAbsolute(candidatePath)
    ? path.resolve(candidatePath)
    : path.resolve(requestedRoot, candidatePath);

  let realRoot;
  let realFile;
  try {
    [realRoot, realFile] = await Promise.all([realpath(requestedRoot), realpath(requestedFile)]);
  } catch (error) {
    if (error?.code === 'ENOENT') throw runnerError(missingMessage, missingCode);
    throw runnerError(accessPrefix + '：' + (error?.message || '未知错误') + '。', accessCode);
  }
  if (!isPathInside(realRoot, realFile)) {
    throw runnerError(outsideMessage, outsideCode);
  }
  let fileStat;
  try {
    fileStat = await statFile(realFile);
  } catch (error) {
    throw runnerError(accessPrefix + '：' + (error?.message || '未知错误') + '。', accessCode);
  }
  if (!fileStat.isFile()) {
    throw runnerError('文件必须是普通文件。', accessCode);
  }
  return { problemFolder: realRoot, filePath: realFile };
}

/**
 * Resolve and validate the only file the runner is allowed to execute.
 * A lexical containment check alone is insufficient because a file can be a
 * symlink; both paths are canonicalized before the final check.
 *
 * main.<ext> is the supported entry point. testcase.<ext> remains readable
 * only as a migration bridge for existing private folders.
 */
async function resolveLocalScaffoldPath(problemFolder, scaffoldPath, { fsPromises = fs } = {}) {
  if (typeof problemFolder !== 'string' || !problemFolder.trim()) {
    throw runnerError('缺少题目目录，无法运行测试。', 'INVALID_PROBLEM_FOLDER');
  }
  if (typeof scaffoldPath !== 'string' || !scaffoldPath.trim()) {
    throw runnerError('缺少测试脚手架文件，无法运行测试。', 'INVALID_SCAFFOLD_PATH');
  }

  const location = await resolveInsideRegularFile(problemFolder, scaffoldPath, {
    fsPromises,
    outsideCode: 'SCAFFOLD_OUTSIDE_PROBLEM',
    outsideMessage: '测试脚手架的真实路径不在当前题目目录内，已拒绝执行。',
    missingCode: 'SCAFFOLD_NOT_FOUND',
    missingMessage: '未找到题目目录或测试脚手架文件。请先生成并保存 main.<语言>。',
    accessCode: 'SCAFFOLD_ACCESS_FAILED',
    accessPrefix: '无法访问测试脚手架'
  });
  const basename = path.basename(location.filePath);
  if (!/^(main|testcase)\.[a-z0-9]+$/i.test(basename)) {
    throw runnerError('只能运行题目目录中名为 main.<语言> 的脚手架文件。', 'INVALID_SCAFFOLD_NAME');
  }
  return {
    problemFolder: location.problemFolder,
    scaffoldPath: location.filePath,
    language: extensionLanguage(location.filePath),
    legacyName: new RegExp('^' + LEGACY_SCAFFOLD_BASENAME + '\\.', 'i').test(basename)
  };
}

async function resolveRuntimeMainPath(problemFolder, language, {
  solutionPath,
  preferredExtension,
  fsPromises = fs
} = {}) {
  const extension = preferredExtension || languageExtension(language);
  const candidates = solutionPath
    ? [solutionPath]
    : [RUNTIME_SOLUTION_BASENAME + extension];
  let missingError;
  for (const candidate of candidates) {
    try {
      return await resolveInsideRegularFile(problemFolder, candidate, {
        fsPromises,
        outsideCode: 'SOURCE_OUTSIDE_PROBLEM',
        outsideMessage: '解答代码的真实路径不在当前题目目录内，已拒绝编译。',
        missingCode: 'MAIN_SOURCE_NOT_FOUND',
        missingMessage: '未找到运行所需的 solution.' + extension.slice(1) + '。请先保存解答代码。',
        accessCode: 'SOURCE_ACCESS_FAILED',
        accessPrefix: '无法访问解答代码'
      });
    } catch (error) {
      if (error?.code !== 'MAIN_SOURCE_NOT_FOUND') throw error;
      missingError = error;
    }
  }
  throw missingError || runnerError('未找到运行所需的解答代码。', 'MAIN_SOURCE_NOT_FOUND');
}

function selectorArgs(normalizedMode) {
  return normalizedMode.mode === 'case' ? ['--case', normalizedMode.caseName] : [];
}

function candidate(command, args, environment = {}) {
  return { command, args, environment };
}

function processStep(label, candidates, environment = {}) {
  return { label, candidates, environment };
}

function executablePath(buildDirectory, platform) {
  return path.join(buildDirectory, platform === 'win32' ? 'testcase-runner.exe' : 'testcase-runner');
}

/**
 * Build a shell-free adapter plan. The JavaScript runtime is the extension
 * host's own executable; ELECTRON_RUN_AS_NODE makes it usable in VS Code's
 * Electron-based extension host instead of launching another UI.
 */
function buildRunPlan({
  scaffoldPath,
  sourcePath,
  language,
  mode = 'all',
  caseName = null,
  platform = process.platform,
  nodePath = process.execPath,
  buildDirectory,
  entryPath
} = {}) {
  if (typeof scaffoldPath !== 'string' || !scaffoldPath) {
    throw runnerError('缺少测试脚手架路径。', 'INVALID_SCAFFOLD_PATH');
  }
  const normalized = normalizeMode(mode, caseName);
  const descriptor = languageDescriptor(language, scaffoldPath);
  const selectedLanguage = descriptor.id;
  const selector = selectorArgs(normalized);
  const direct = (command, args, environment = {}) => ({
    language: selectedLanguage,
    label: descriptor.label,
    command,
    args,
    mode: normalized.mode,
    caseName: normalized.caseName,
    environment,
    compileSteps: [],
    runStep: processStep('运行', [candidate(command, args, environment)])
  });

  if (selectedLanguage === 'javascript') {
    if (typeof nodePath !== 'string' || !nodePath) {
      throw runnerError('未找到 JavaScript 运行时。请重新加载 VS Code 后重试。', 'RUNTIME_UNAVAILABLE');
    }
    return direct(nodePath, [entryPath || scaffoldPath, ...selector], { ELECTRON_RUN_AS_NODE: '1' });
  }
  if (selectedLanguage === 'python') {
    const windows = platform === 'win32';
    const firstCommand = windows ? 'py' : 'python3';
    const runtimeEntry = entryPath || scaffoldPath;
    const firstArgs = [...(windows ? ['-3'] : []), runtimeEntry, ...selector];
    const plan = direct(firstCommand, firstArgs);
    plan.runStep = processStep('运行 Python', [
      candidate(firstCommand, firstArgs),
      candidate('python', [runtimeEntry, ...selector])
    ]);
    return plan;
  }
  if (selectedLanguage === 'ruby') {
    return direct('ruby', ['--disable-gems', scaffoldPath, ...selector]);
  }
  if (selectedLanguage === 'php') {
    return direct('php', ['-n', scaffoldPath, ...selector]);
  }

  const workspace = buildDirectory || path.dirname(scaffoldPath);
  const source = sourcePath || path.join(workspace, RUNTIME_SOLUTION_BASENAME + languageExtension(selectedLanguage, scaffoldPath));
  const program = executablePath(workspace, platform);
  const common = {
    language: selectedLanguage,
    label: descriptor.label,
    mode: normalized.mode,
    caseName: normalized.caseName,
    buildDirectory: workspace,
    sourcePath: source,
    scaffoldPath
  };
  const compiled = (compileSteps, runStep) => {
    const first = runStep.candidates[0];
    return {
      ...common,
      command: first.command,
      args: first.args,
      environment: first.environment || {},
      compileSteps,
      runStep
    };
  };

  if (selectedLanguage === 'c') {
    return compiled([
      processStep('编译 C', [
        candidate('gcc', ['-std=c11', '-O0', '-g0', '-o', program, scaffoldPath, '-lm']),
        candidate('clang', ['-std=c11', '-O0', '-g0', '-o', program, scaffoldPath, '-lm'])
      ])
    ], processStep('运行 C', [candidate(program, selector)]));
  }
  if (selectedLanguage === 'cpp') {
    return compiled([
      processStep('编译 C++', [
        candidate('g++', ['-std=c++17', '-O0', '-g0', '-o', program, scaffoldPath]),
        candidate('clang++', ['-std=c++17', '-O0', '-g0', '-o', program, scaffoldPath])
      ])
    ], processStep('运行 C++', [candidate(program, selector)]));
  }
  if (selectedLanguage === 'csharp') {
    const project = path.join(workspace, 'LeetCodeCph.csproj');
    const nugetConfig = path.join(workspace, 'NuGet.Config');
    const output = path.join(workspace, 'dotnet-out');
    const dotnetEnvironment = {
      DOTNET_CLI_HOME: path.join(workspace, 'dotnet-home'),
      NUGET_PACKAGES: path.join(workspace, 'nuget-packages')
    };
    return compiled([
      processStep('还原 C# 项目', [
        candidate('dotnet', ['restore', project, '--configfile', nugetConfig, '--ignore-failed-sources', '--nologo'], dotnetEnvironment)
      ], dotnetEnvironment),
      processStep('编译 C#', [
        candidate('dotnet', ['build', project, '--no-restore', '--configuration', 'Release', '--output', output, '--nologo', '--verbosity', 'quiet'], dotnetEnvironment)
      ], dotnetEnvironment)
    ], processStep('运行 C#', [
      candidate('dotnet', [path.join(output, 'LeetCodeCph.dll'), ...selector], dotnetEnvironment)
    ], dotnetEnvironment));
  }
  if (selectedLanguage === 'rust') {
    return compiled([
      processStep('编译 Rust', [
        candidate('rustc', ['--edition=2021', '-C', 'debuginfo=0', '-o', program, scaffoldPath])
      ])
    ], processStep('运行 Rust', [candidate(program, selector)]));
  }
  if (selectedLanguage === 'go') {
    const goEnvironment = {
      GOWORK: 'off',
      GOCACHE: path.join(workspace, 'go-cache'),
      GOPATH: path.join(workspace, 'go-path')
    };
    return compiled([
      processStep('编译 Go', [
        candidate('go', ['build', '-trimpath', '-o', program, source, scaffoldPath], goEnvironment)
      ], goEnvironment)
    ], processStep('运行 Go', [candidate(program, selector)]));
  }
  if (selectedLanguage === 'haskell') {
    const output = path.join(workspace, 'ghc-out');
    return compiled([
      processStep('编译 Haskell', [
        candidate('ghc', ['-O0', '-outputdir', output, '-odir', output, '-hidir', output, '-o', program, scaffoldPath])
      ])
    ], processStep('运行 Haskell', [candidate(program, selector)]));
  }
  if (selectedLanguage === 'java') {
    const classes = path.join(workspace, 'java-classes');
    return compiled([
      processStep('编译 Java', [
        candidate('javac', ['-encoding', 'UTF-8', '-d', classes, source, scaffoldPath])
      ])
    ], processStep('运行 Java', [
      candidate('java', ['-Dfile.encoding=UTF-8', '-cp', classes, 'LeetCodeCphTest', ...selector])
    ]));
  }
  if (selectedLanguage === 'typescript') {
    const output = path.join(workspace, 'ts-out');
    const entry = entryPath || scaffoldPath;
    return compiled([
      processStep('编译 TypeScript', [
        candidate('tsc', ['--target', 'ES2020', '--module', 'commonjs', '--moduleResolution', 'node', '--noEmitOnError', '--pretty', 'false', '--outDir', output, entry])
      ])
    ], processStep('运行 TypeScript', [
      candidate(nodePath, [path.join(output, path.basename(entry, '.ts') + '.js'), ...selector], { ELECTRON_RUN_AS_NODE: '1' })
    ]));
  }
  if (selectedLanguage === 'kotlin') {
    const output = path.join(workspace, 'testcase-runner.jar');
    return compiled([
      processStep('编译 Kotlin', [
        candidate('kotlinc', [source, scaffoldPath, '-include-runtime', '-d', output])
      ])
    ], processStep('运行 Kotlin', [candidate('java', ['-jar', output, ...selector])]));
  }
  if (selectedLanguage === 'swift') {
    return compiled([
      processStep('编译 Swift', [
        candidate('swiftc', ['-Onone', '-o', program, source, scaffoldPath])
      ])
    ], processStep('运行 Swift', [candidate(program, selector)]));
  }
  if (selectedLanguage === 'scala') {
    const classes = path.join(workspace, 'scala-classes');
    return compiled([
      processStep('编译 Scala', [
        candidate('scalac', ['-d', classes, source, scaffoldPath])
      ])
    ], processStep('运行 Scala', [
      candidate('scala', ['-cp', classes, 'LeetCodeCphTest', ...selector])
    ]));
  }
  throw runnerError('暂不支持运行 ' + selectedLanguage + ' 测试脚手架。', 'UNSUPPORTED_LANGUAGE');
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
    throw runnerError('测试脚手架校验摘要无效。请重新运行。', 'INVALID_SCAFFOLD_HASH');
  }
  return hash;
}

function validateExpectedSolutionHash(value) {
  if (value === undefined || value === null || value === '') return '';
  const hash = String(value).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw runnerError('解答代码校验摘要无效。请重新运行。', 'INVALID_SOLUTION_HASH');
  }
  return hash;
}

async function assertExpectedSolutionHash(solutionPath, expectedHash, fsPromises) {
  if (!expectedHash) return;
  if (!solutionPath) throw runnerError('缺少要校验的解答文件。', 'SOLUTION_ACCESS_FAILED');
  const reader = getFsMethod(fsPromises, 'readFile');
  let bytes;
  try {
    bytes = await reader(solutionPath);
  } catch (error) {
    throw runnerError('无法读取解答代码进行校验：' + (error?.message || '未知错误') + '。', 'SOLUTION_ACCESS_FAILED');
  }
  const actualHash = crypto.createHash('sha256').update(bytes).digest('hex');
  if (actualHash !== expectedHash) {
    throw runnerError('解答代码在运行前已发生变化。请再次运行。', 'SOLUTION_CHANGED');
  }
}

async function assertExpectedScaffoldHash(scaffoldPath, expectedHash, fsPromises) {
  if (!expectedHash) return;
  const reader = getFsMethod(fsPromises, 'readFile');
  let bytes;
  try {
    bytes = await reader(scaffoldPath);
  } catch (error) {
    throw runnerError('无法读取测试脚手架进行校验：' + (error?.message || '未知错误') + '。', 'SCAFFOLD_ACCESS_FAILED');
  }
  const actualHash = crypto.createHash('sha256').update(bytes).digest('hex');
  if (actualHash !== expectedHash) {
    throw runnerError('测试脚手架在运行前已发生变化。请再次运行。', 'SCAFFOLD_CHANGED');
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
      throw runnerError('测试脚手架重复输出了测试用例 “' + name + '” 的结果。', 'DUPLICATE_RESULT');
    }
    if (Object.prototype.hasOwnProperty.call(value, 'passed') && typeof value.passed !== 'boolean') {
      throw runnerError('测试用例 “' + name + '” 的 passed 必须是布尔值。', 'INVALID_RESULT_PROTOCOL');
    }
    if (Object.prototype.hasOwnProperty.call(value, 'error') && typeof value.error !== 'string') {
      throw runnerError('测试用例 “' + name + '” 的 error 必须是字符串。', 'INVALID_RESULT_PROTOCOL');
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
  return source.length <= limit ? source : source.slice(0, limit) + '…';
}

function toolHint(language, compiler) {
  const descriptor = LANGUAGE_BY_ID[language] || { label: language };
  if (!compiler) {
    if (language === 'python') return '请安装 Python 3，并确认 py（Windows）或 python3（macOS/Linux）可在终端中使用。';
    if (language === 'javascript') return '请重新加载 VS Code 后重试。';
    if (language === 'ruby') return '请安装 Ruby，并确认 ruby 可在终端中使用。';
    if (language === 'php') return '请安装 PHP，并确认 php 可在终端中使用。';
    return '请安装 ' + descriptor.label + ' 运行时，并确认其命令已加入 PATH。';
  }
  const commands = {
    c: 'gcc 或 clang',
    cpp: 'g++ 或 clang++',
    csharp: '.NET SDK（dotnet）',
    rust: 'Rust 工具链（rustc）',
    go: 'Go 工具链（go）',
    haskell: 'GHC（ghc）',
    java: 'JDK（javac 和 java）',
    typescript: 'TypeScript 编译器（tsc）',
    kotlin: 'Kotlin 编译器（kotlinc）和 JDK',
    swift: 'Swift 工具链（swiftc）',
    scala: 'Scala 工具链（scalac 和 scala）'
  };
  return '请安装 ' + (commands[language] || descriptor.label + ' 编译器') + '，并确认命令已加入 PATH。';
}

function unavailableError(language, stage, attempted, cause) {
  const compiler = stage === 'compile';
  const code = compiler ? 'COMPILER_UNAVAILABLE' : 'RUNTIME_UNAVAILABLE';
  const action = compiler ? '编译器' : '运行时';
  const commands = attempted.filter(Boolean).join('、');
  return runnerError(
    '无法启动 ' + (LANGUAGE_BY_ID[language]?.label || language) + action
      + (commands ? '（尝试：' + commands + '）' : '') + '。' + toolHint(language, compiler),
    code,
    { cause }
  );
}

function processStartError(error, stage, command) {
  if (error?.code === 'ENOENT') {
    return runnerError('未找到命令 ' + command + '。', 'TOOL_NOT_FOUND', { cause: error, command });
  }
  return runnerError(
    '无法启动' + (stage === 'compile' ? '编译' : '测试') + '进程：' + (error?.message || '未知错误') + '。',
    'PROCESS_START_FAILED',
    { cause: error, command }
  );
}

function terminate(child, platform = process.platform) {
  const pid = Number(child?.pid);
  // On POSIX, the runner starts the process in its own group so this also
  // kills descendants that inherited stdout/stderr. On Windows taskkill's /T
  // flag performs the equivalent job-tree termination. The direct kill below
  // remains as a portable fallback for mocked/failed process handles.
  if (Number.isSafeInteger(pid) && pid > 0) {
    if (platform !== 'win32') {
      try { process.kill(-pid, 'SIGKILL'); } catch (_) { /* fall through */ }
    } else {
      try {
        const killer = childProcess.spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
          shell: false,
          windowsHide: true,
          stdio: 'ignore'
        });
        killer.unref?.();
      } catch (_) { /* fall through */ }
    }
  }
  try {
    child.kill('SIGKILL');
  } catch (_) {
    // A process can exit between the limit check and kill; close will settle it.
  }
}

function stageError(stage, kind, limit) {
  if (kind === 'timeout') {
    const code = stage === 'compile' ? 'COMPILE_TIMEOUT' : 'EXECUTION_TIMEOUT';
    const text = stage === 'compile'
      ? '编译超过 ' + limit + 'ms，已停止。请检查递归模板、构建依赖或编译器状态。'
      : '测试运行超过 ' + limit + 'ms，已停止。请检查死循环或缩小测试规模。';
    return runnerError(text, code);
  }
  const code = stage === 'compile' ? 'COMPILE_OUTPUT_LIMIT_EXCEEDED' : 'OUTPUT_LIMIT_EXCEEDED';
  const text = stage === 'compile'
    ? '编译输出超过 ' + limit + ' 字节，已停止。请修复首个编译错误后重试。'
    : '测试输出超过 ' + limit + ' 字节，已停止。请减少调试输出。';
  return runnerError(text, code);
}

function executeProcess(candidatePlan, {
  cwd,
  timeoutMs,
  maxOutputBytes,
  spawnImpl,
  platform,
  stage,
  environment
}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(candidatePlan.command, candidatePlan.args, {
        cwd,
        shell: false,
        windowsHide: true,
        detached: platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: safeExecutionEnvironment({ ...(environment || {}), ...(candidatePlan.environment || {}) })
      });
    } catch (error) {
      reject(processStartError(error, stage, candidatePlan.command));
      return;
    }
    if (!child || typeof child.once !== 'function' || !child.stdout || !child.stderr) {
      reject(runnerError('无法启动' + (stage === 'compile' ? '编译' : '测试') + '进程。', 'PROCESS_START_FAILED'));
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    let outputBytes = 0;
    let timedOut = false;
    let outputTooLarge = false;
    let settled = false;
    let forcedStopTimer;
    let timer;
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forcedStopTimer);
      callback();
    };
    const stopNow = () => {
      if (settled) return;
      terminate(child, platform);
      try { child.stdout.destroy(); } catch (_) { /* best effort */ }
      try { child.stderr.destroy(); } catch (_) { /* best effort */ }
      if (!forcedStopTimer) {
        forcedStopTimer = setTimeout(() => settle(() => {
          reject(stageError(stage, timedOut ? 'timeout' : 'output', timedOut ? timeoutMs : maxOutputBytes));
        }), 500);
      }
    };
    const addOutput = (chunks, chunk) => {
      if (outputTooLarge) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      outputBytes += buffer.length;
      if (outputBytes > maxOutputBytes) {
        outputTooLarge = true;
        stopNow();
        return;
      }
      chunks.push(buffer);
    };
    timer = setTimeout(() => {
      timedOut = true;
      stopNow();
    }, timeoutMs);

    child.stdout.on('data', (chunk) => addOutput(stdoutChunks, chunk));
    child.stderr.on('data', (chunk) => addOutput(stderrChunks, chunk));
    child.once('error', (error) => settle(() => reject(processStartError(error, stage, candidatePlan.command))));
    child.once('close', (exitCode, signal) => settle(() => {
      if (timedOut) {
        reject(stageError(stage, 'timeout', timeoutMs));
        return;
      }
      if (outputTooLarge) {
        reject(stageError(stage, 'output', maxOutputBytes));
        return;
      }
      resolve({
        command: candidatePlan.command,
        args: candidatePlan.args,
        stdout: textFromChunks(stdoutChunks),
        stderr: textFromChunks(stderrChunks),
        exitCode: typeof exitCode === 'number' ? exitCode : null,
        signal: signal || null
      });
    }));
  });
}

async function executeStep(step, {
  cwd,
  timeoutMs,
  maxOutputBytes,
  spawnImpl,
  platform,
  stage
}) {
  const missing = [];
  let lastMissingError;
  for (const candidatePlan of step.candidates) {
    try {
      const result = await executeProcess(candidatePlan, {
        cwd,
        timeoutMs,
        maxOutputBytes,
        spawnImpl,
        platform,
        stage,
        environment: step.environment
      });
      return { ...result, candidate: candidatePlan };
    } catch (error) {
      if (error?.code !== 'TOOL_NOT_FOUND') throw error;
      missing.push(candidatePlan.command);
      lastMissingError = error;
    }
  }
  throw unavailableError(step.language || '', stage, missing, lastMissingError);
}

function compilerFailure(plan, step, result) {
  const excerpt = outputExcerpt(result.stdout, result.stderr);
  const exit = result.exitCode == null ? '' : '（退出码 ' + result.exitCode + '）';
  return runnerError(
    (step.label || '编译') + '失败' + exit + '。'
      + (excerpt ? ' ' + excerpt : ' 请查看解答代码和 main 脚手架的编译错误。'),
    'COMPILE_FAILED',
    {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      signal: result.signal,
      language: plan.language
    }
  );
}

function escapeRegularExpression(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function prepareBuildWorkspace(location, {
  solutionPath,
  fsPromises,
  platform
} = {}) {
  const fileSystem = fsPromises || fs;
  const readFile = getFsMethod(fileSystem, 'readFile');
  const writeFile = getFsMethod(fileSystem, 'writeFile');
  const mkdtemp = getFsMethod(fileSystem, 'mkdtemp');
  const mkdir = getFsMethod(fileSystem, 'mkdir');
  const remove = getFsMethod(fileSystem, 'rm');
  const chmod = typeof fileSystem.chmod === 'function' ? fileSystem.chmod.bind(fileSystem) : null;
  const descriptor = languageDescriptor(location.language, location.scaffoldPath);
  const extension = languageExtension(location.language, location.scaffoldPath);
  const source = await resolveRuntimeMainPath(location.problemFolder, location.language, {
    solutionPath,
    preferredExtension: extension,
    fsPromises: fileSystem
  });
  let buildDirectory;
  try {
    buildDirectory = await mkdtemp(path.join(os.tmpdir(), BUILD_DIRECTORY_PREFIX));
    if (chmod) {
      try { await chmod(buildDirectory, 0o700); } catch (_) { /* best effort */ }
    }
    const [sourceBytes, scaffoldBytes] = await Promise.all([
      readFile(source.filePath),
      readFile(location.scaffoldPath)
    ]);
    const sourceFileName = path.basename(source.filePath);
    if (/^(?:main|testcase)\.[^.]+$/i.test(sourceFileName)) {
      throw runnerError(
        '解答文件不能使用 main.<语言> 或 testcase.<语言> 这样的保留名称。请将其改回 solution.<语言>。',
        'INVALID_SOURCE_NAME'
      );
    }
    // Preserve an individually renamed solution's basename in the isolated
    // build directory. Generated C/C++/Rust/Python scaffolds refer to the
    // metadata-recorded relative filename, so staging every source under the
    // literal solution.* name breaks those imports after a VS Code rename.
    let stagedSource = path.join(buildDirectory, sourceFileName);
    const stagedScaffold = path.join(buildDirectory, RUNTIME_MAIN_BASENAME + extension);
    if (location.language === 'haskell') {
      const sourceText = Buffer.isBuffer(sourceBytes) ? sourceBytes.toString('utf8') : String(sourceBytes);
      const moduleMatch = sourceText.match(/^\s*module\s+([A-Za-z][A-Za-z0-9_.']*)\s+where/m);
      if (moduleMatch && moduleMatch[1] !== 'Solution') {
        throw runnerError(
          'Haskell 解答模块必须命名为 Solution，当前为 ' + moduleMatch[1] + '。请调整解答或重新生成脚手架。',
          'UNSUPPORTED_SOURCE_LAYOUT'
        );
      }
      stagedSource = path.join(buildDirectory, 'Solution.hs');
      let normalized = sourceText;
      if (!moduleMatch) {
        // LANGUAGE/OPTIONS pragmas must remain before the module declaration.
        const leadingPragmas = sourceText.match(/^((?:\s*\{-#\s*(?:LANGUAGE|OPTIONS_GHC)[\s\S]*?#-\}\s*)*)/i)?.[1] || '';
        normalized = leadingPragmas
          ? leadingPragmas + 'module Solution where\n\n' + sourceText.slice(leadingPragmas.length)
          : 'module Solution where\n\n' + sourceText;
      }
      await writeFile(stagedSource, normalized, 'utf8');
    } else if (location.language === 'go') {
      const sourceText = Buffer.isBuffer(sourceBytes) ? sourceBytes.toString('utf8') : String(sourceBytes);
      // LeetCode's Go editor normally provides only declarations/functions;
      // `go build` still requires every staged file to declare a package.
      const normalized = /^\s*package\s+[A-Za-z_][A-Za-z0-9_]*/m.test(sourceText)
        ? sourceText
        : 'package main\n\n' + sourceText;
      await writeFile(stagedSource, normalized, 'utf8');
    } else if (location.language === 'java') {
      const sourceText = Buffer.isBuffer(sourceBytes) ? sourceBytes.toString('utf8') : String(sourceBytes);
      // LeetCode implicitly provides common standard-library imports. javac
      // compiles solution.java as a separate unit, so imports in main.java do
      // not make Map/List/etc. visible to the captured solution.
      const commonImports = 'import java.util.*;\nimport java.io.*;\nimport java.math.*;\n';
      const packagePattern = /^\s*package\s+[A-Za-z_][A-Za-z0-9_.]*\s*;/m;
      const normalized = packagePattern.test(sourceText)
        ? sourceText.replace(packagePattern, (declaration) => `${declaration}\n${commonImports}`)
        : `${commonImports}\n${sourceText}`;
      stagedSource = path.join(buildDirectory, 'Solution.java');
      await writeFile(stagedSource, normalized, 'utf8');
    } else {
      await writeFile(stagedSource, sourceBytes);
    }
    await writeFile(stagedScaffold, scaffoldBytes);

    let entryPath;
    if (location.language === 'typescript' || location.language === 'javascript') {
      // Standard LeetCode TypeScript/JavaScript snippets are script-style
      // declarations, not modules. Joining solution and main preserves that
      // lexical contract without modifying the user's solution file. Keep
      // compatibility with older scaffolds that explicitly load ./solution.
      const sourceText = Buffer.isBuffer(sourceBytes) ? sourceBytes.toString('utf8') : String(sourceBytes);
      const scaffoldText = Buffer.isBuffer(scaffoldBytes) ? scaffoldBytes.toString('utf8') : String(scaffoldBytes);
      const typescriptPrelude = location.language === 'typescript'
        && !/\bdeclare\s+(?:const|let|var)\s+process\b/.test(sourceText + '\n' + scaffoldText)
        ? 'declare const process: { argv: string[]; exitCode?: number; exit(code?: number): never };\n\n'
        : '';
      const sourceStem = path.basename(stagedSource, path.extname(stagedSource));
      const siblingModule = escapeRegularExpression(`./${sourceStem}`)
        + `(?:${escapeRegularExpression(path.extname(stagedSource))})?`;
      const loadsSiblingSolution = new RegExp(`\\brequire\\s*\\(\\s*['"]${siblingModule}['"]\\s*\\)`, 'i').test(scaffoldText)
        || (location.language === 'typescript'
          && new RegExp(`\\b(?:from\\s*|import\\s*)['"]${siblingModule}['"]`, 'i').test(scaffoldText));
      if (loadsSiblingSolution) {
        entryPath = stagedScaffold;
        if (typescriptPrelude) await writeFile(stagedScaffold, typescriptPrelude + scaffoldText, 'utf8');
      } else {
        entryPath = path.join(buildDirectory, `entry${extension}`);
        await writeFile(entryPath, typescriptPrelude + sourceText + '\n\n' + scaffoldText, 'utf8');
      }
    } else if (location.language === 'python') {
      // LeetCode injects common typing/collection names and platform node
      // classes. A small bootstrap exposes equivalent names through builtins
      // before main.py imports solution.py, without changing the user's file.
      entryPath = path.join(buildDirectory, 'entry.py');
      const mainLiteral = JSON.stringify(stagedScaffold);
      await writeFile(entryPath, [
        'import builtins, bisect, collections, functools, heapq, itertools, math, re, runpy, sys, typing',
        '# Mirror the common standard-library star imports supplied by LeetCode.',
        'for _module in (typing, collections, functools, itertools, math, heapq, bisect):',
        '    for _name in getattr(_module, "__all__", [name for name in dir(_module) if not name.startswith("_")]):',
        '        setattr(builtins, _name, getattr(_module, _name))',
        'class _CallableBisectModule:',
        '    def __call__(self, *args, **kwargs): return bisect.bisect(*args, **kwargs)',
        '    def __getattr__(self, name): return getattr(bisect, name)',
        'builtins.bisect = _CallableBisectModule()',
        'for _name, _module in {"collections": collections, "functools": functools, "heapq": heapq, "itertools": itertools, "math": math, "re": re, "sys": sys, "typing": typing}.items():',
        '    setattr(builtins, _name, _module)',
        'class ListNode:',
        '    def __init__(self, val=0, next=None): self.val, self.next = val, next',
        'class TreeNode:',
        '    def __init__(self, val=0, left=None, right=None): self.val, self.left, self.right = val, left, right',
        'class Node:',
        '    def __init__(self, val=0, next=None, random=None, neighbors=None, children=None):',
        '        self.val, self.next, self.random = val, next, random',
        '        self.neighbors = [] if neighbors is None else neighbors',
        '        self.children = [] if children is None else children',
        'builtins.ListNode, builtins.TreeNode, builtins.Node = ListNode, TreeNode, Node',
        `runpy.run_path(${mainLiteral}, run_name="__main__")`,
        ''
      ].join('\n'), 'utf8');
    }
    if (location.language === 'csharp') {
      await writeFile(path.join(buildDirectory, 'LeetCodeCph.csproj'), [
        '<Project Sdk="Microsoft.NET.Sdk">',
        '  <PropertyGroup>',
        '    <OutputType>Exe</OutputType>',
        '    <TargetFramework>net8.0</TargetFramework>',
        '    <ImplicitUsings>enable</ImplicitUsings>',
        '    <Nullable>disable</Nullable>',
        '  </PropertyGroup>',
        '</Project>',
        ''
      ].join('\n'), 'utf8');
      await writeFile(path.join(buildDirectory, 'NuGet.Config'), [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<configuration><packageSources><clear /></packageSources></configuration>',
        ''
      ].join('\n'), 'utf8');
    }
    // Several compilers require their -d/-outputdir target to exist instead
    // of creating it themselves. Keep every generated artifact inside the
    // disposable build directory.
    if (location.language === 'java') await mkdir(path.join(buildDirectory, 'java-classes'), { recursive: true });
    if (location.language === 'scala') await mkdir(path.join(buildDirectory, 'scala-classes'), { recursive: true });
    if (location.language === 'haskell') await mkdir(path.join(buildDirectory, 'ghc-out'), { recursive: true });
    return {
      buildDirectory,
      sourcePath: stagedSource,
      scaffoldPath: stagedScaffold,
      entryPath,
      language: descriptor.id,
      platform
    };
  } catch (error) {
    if (buildDirectory) {
      try { await remove(buildDirectory, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    }
    if (error instanceof TestcaseRunnerError) throw error;
    throw runnerError('无法准备临时编译目录：' + (error?.message || '未知错误') + '。', 'BUILD_PREPARE_FAILED', { cause: error });
  }
}

async function removeBuildWorkspace(buildDirectory, fsPromises) {
  if (!buildDirectory) return;
  const remove = getFsMethod(fsPromises, 'rm');
  try {
    await remove(buildDirectory, { recursive: true, force: true });
  } catch (_) {
    // Build files contain no durable state. A failed best-effort cleanup is
    // intentionally not allowed to hide the test result.
  }
}

function runtimeResult(plan, execution, compileSteps, originalScaffoldPath) {
  const stdout = execution.stdout;
  const stderr = execution.stderr;
  let parsed;
  try {
    parsed = parseResultLines(stdout);
  } catch (error) {
    if (error && typeof error === 'object') {
      if (error.stdout == null) error.stdout = stdout;
      if (error.stderr == null) error.stderr = stderr;
      if (error.exitCode == null) error.exitCode = execution.exitCode;
      if (error.signal == null) error.signal = execution.signal;
    }
    throw error;
  }
  const ok = execution.exitCode === 0 && !execution.signal;
  const excerpt = ok ? '' : outputExcerpt(stdout, stderr);
  return {
    ...plan,
    scaffoldPath: originalScaffoldPath,
    ok,
    results: parsed.results,
    markerCount: parsed.markerCount,
    stdout,
    stderr,
    exitCode: execution.exitCode,
    signal: execution.signal,
    compileSteps,
    error: ok ? '' : '测试脚手架运行失败'
      + (execution.exitCode == null ? '' : '（退出码 ' + execution.exitCode + '）')
      + '。' + (excerpt ? ' ' + excerpt : '')
  };
}

/**
 * Execute a local testcase scaffold. mode case passes exactly --case and the
 * case name as separate arguments; mode all passes no selector. A completed
 * program returns structured results even if it exits non-zero, allowing the
 * sidebar to show results emitted before a runtime failure.
 */
async function runTestScaffold({
  problemFolder,
  scaffoldPath,
  solutionPath,
  mode,
  caseName,
  timeoutMs,
  compileTimeoutMs,
  maxOutputBytes,
  expectedCaseNames,
  expectedScaffoldHash,
  expectedSolutionHash,
  spawnImpl = childProcess.spawn,
  platform,
  nodePath,
  fsPromises
} = {}) {
  if (typeof spawnImpl !== 'function') throw new TypeError('spawnImpl 必须是函数。');
  const selectedPlatform = platform || process.platform;
  const location = await resolveLocalScaffoldPath(problemFolder, scaffoldPath, { fsPromises });
  const expectedHash = validateExpectedScaffoldHash(expectedScaffoldHash);
  const expectedSourceHash = validateExpectedSolutionHash(expectedSolutionHash);
  // The extension host snapshots this file before dispatch. Re-read the exact
  // disk bytes immediately before any spawn so an external atomic replacement
  // cannot swap in different code between validation and execution.
  await assertExpectedScaffoldHash(location.scaffoldPath, expectedHash, fsPromises);
  await assertExpectedSolutionHash(solutionPath, expectedSourceHash, fsPromises);
  const selectedTimeoutMs = boundedInteger(timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, '测试超时时间');
  const selectedCompileTimeoutMs = boundedInteger(
    compileTimeoutMs,
    DEFAULT_COMPILE_TIMEOUT_MS,
    MAX_COMPILE_TIMEOUT_MS,
    '编译超时时间'
  );
  const selectedMaxOutputBytes = boundedInteger(maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES, '测试输出上限');
  const requestedExpectedNames = normalizeExpectedCaseNames(expectedCaseNames);
  const normalized = normalizeMode(mode, caseName);
  const expectedNames = normalized.mode === 'case' ? [normalized.caseName] : requestedExpectedNames;
  const descriptor = languageDescriptor(location.language, location.scaffoldPath);
  let buildWorkspace;
  let plan;
  let execution;
  const completedCompileSteps = [];

  try {
    if (descriptor.compiled || ((descriptor.id === 'javascript' || descriptor.id === 'python') && Boolean(solutionPath))) {
      buildWorkspace = await prepareBuildWorkspace(location, {
        solutionPath,
        fsPromises,
        platform: selectedPlatform
      });
      plan = buildRunPlan({
        scaffoldPath: buildWorkspace.scaffoldPath,
        sourcePath: buildWorkspace.sourcePath,
        entryPath: buildWorkspace.entryPath,
        language: location.language,
        mode: normalized.mode,
        caseName: normalized.caseName,
        platform: selectedPlatform,
        nodePath,
        buildDirectory: buildWorkspace.buildDirectory
      });
      for (const step of plan.compileSteps) {
        const compileResult = await executeStep({ ...step, language: plan.language }, {
          cwd: buildWorkspace.buildDirectory,
          timeoutMs: selectedCompileTimeoutMs,
          maxOutputBytes: selectedMaxOutputBytes,
          spawnImpl,
          platform: selectedPlatform,
          stage: 'compile'
        });
        completedCompileSteps.push({
          label: step.label,
          command: compileResult.command,
          args: compileResult.args,
          exitCode: compileResult.exitCode,
          signal: compileResult.signal,
          stdout: compileResult.stdout,
          stderr: compileResult.stderr
        });
        if (compileResult.exitCode !== 0 || compileResult.signal) {
          throw compilerFailure(plan, step, compileResult);
        }
      }
      execution = await executeStep({ ...plan.runStep, language: plan.language }, {
        cwd: buildWorkspace.buildDirectory,
        timeoutMs: selectedTimeoutMs,
        maxOutputBytes: selectedMaxOutputBytes,
        spawnImpl,
        platform: selectedPlatform,
        stage: 'run'
      });
    } else {
      plan = buildRunPlan({
        scaffoldPath: location.scaffoldPath,
        language: location.language,
        mode: normalized.mode,
        caseName: normalized.caseName,
        platform: selectedPlatform,
        nodePath
      });
      execution = await executeStep({ ...plan.runStep, language: plan.language }, {
        cwd: location.problemFolder,
        timeoutMs: selectedTimeoutMs,
        maxOutputBytes: selectedMaxOutputBytes,
        spawnImpl,
        platform: selectedPlatform,
        stage: 'run'
      });
    }

    const output = runtimeResult(plan, execution, completedCompileSteps, location.scaffoldPath);
    if (expectedNames) {
      try {
        assertExpectedResultSet(output.results, expectedNames);
      } catch (error) {
        if (error && typeof error === 'object') {
          error.stdout = output.stdout;
          error.stderr = output.stderr;
          error.exitCode = output.exitCode;
          error.signal = output.signal;
          // Keep already emitted case results and the original non-zero exit
          // diagnostic available to the sidebar. The runner still rejects the
          // protocol mismatch for callers that require an exact result set.
          error.execution = output;
        }
        throw error;
      }
    } else if (plan.mode === 'all' && !output.markerCount && output.exitCode === 0) {
      throw runnerError(
        '测试脚手架没有输出测试结果。请重新生成测试脚手架。',
        'MISSING_RESULT_PROTOCOL',
        { stdout: output.stdout, stderr: output.stderr, exitCode: output.exitCode, signal: output.signal }
      );
    }
    return output;
  } finally {
    await removeBuildWorkspace(buildWorkspace?.buildDirectory, fsPromises);
  }
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
  DEFAULT_COMPILE_TIMEOUT_MS,
  MAX_COMPILE_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  MAX_OUTPUT_BYTES,
  RUNTIME_MAIN_BASENAME,
  LEGACY_SCAFFOLD_BASENAME,
  RUNTIME_SOLUTION_BASENAME,
  BUILD_DIRECTORY_PREFIX,
  TestcaseRunnerError,
  isPathInside,
  extensionLanguage,
  supportsLanguage,
  isCompiledLanguage,
  languageExtension,
  normalizeMode,
  resolveLocalScaffoldPath,
  resolveRuntimeMainPath,
  buildRunPlan,
  parseResultLines,
  formatActualOutput,
  safeExecutionEnvironment,
  validateExpectedScaffoldHash,
  assertExpectedScaffoldHash,
  mergeRunResults,
  prepareBuildWorkspace,
  runTestScaffold,
  runAllTestCases,
  runSingleTestCase
};
