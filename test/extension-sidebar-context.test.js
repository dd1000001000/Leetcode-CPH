'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const source = require('node:fs').readFileSync(path.join(__dirname, '..', 'vscode-extension', 'extension.js'), 'utf8');
const { ApplyTracker } = require('../vscode-extension/apply-tracker');
const { fromAiExtraction } = require('../vscode-extension/testcase-store');

const temporaryFolders = [];
afterEach(async () => {
  await Promise.all(temporaryFolders.splice(0).map((folder) => fs.rm(folder, { recursive: true, force: true })));
});

function loadExtension(vscodeStub, dependencyOverrides = {}) {
  const sandbox = {
    module: { exports: {} },
    console,
    Buffer,
    URL,
    process,
    setTimeout: dependencyOverrides.setTimeout || setTimeout,
    clearTimeout: dependencyOverrides.clearTimeout || clearTimeout,
    setInterval,
    clearInterval,
    require: (name) => {
      if (name === 'vscode') return vscodeStub;
      if (name === 'http') return require('node:http');
      if (name === 'crypto') return crypto;
      if (name === 'path') return path;
      if (name === 'fs/promises') return dependencyOverrides.fsPromises || require('node:fs/promises');
      if (name === './apply-tracker') return { ApplyTracker };
      if (name === './sidebar-provider') return require('../vscode-extension/sidebar-provider');
      if (name === './testcase-store') return require('../vscode-extension/testcase-store');
      if (name === './ai-testcase-service') return require('../vscode-extension/ai-testcase-service');
      if (name === './testcase-runner') return dependencyOverrides.testcaseRunner || require('../vscode-extension/testcase-runner');
      throw new Error(`Unexpected require: ${name}`);
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'extension.js' });
  return sandbox;
}

function initializePrivateStorage(sandbox, formerStoragePath) {
  sandbox.initializeProblemStorage();
  // formerStoragePath intentionally remains unused: v0.8.0 no longer reads or
  // writes ExtensionContext.storageUri/globalStorageUri problem records.
  assert.equal(typeof formerStoragePath, 'string');
}

function stateFolderFor(problemDirectory) {
  return path.join(problemDirectory, '.leetcode_cph');
}

function isPathInsideForTest(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function registeredMetadata(values = {}) {
  return {
    storageSchemaVersion: 3,
    storageLayout: 'workspace-sidecar',
    ...values
  };
}

async function createLinkOrSkip(t, target, linkPath, type) {
  try {
    await fs.symlink(target, linkPath, type);
    return true;
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS', 'UNKNOWN'].includes(error?.code)) {
      t.skip(`filesystem links are unavailable here: ${error.code}`);
      return false;
    }
    throw error;
  }
}

async function settleWithoutReleasingProvider(promise, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message || 'operation did not cancel promptly')), 750);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('overlapping testcase AI jobs retain busy ownership until every caller finishes', () => {
  const sandbox = loadExtension({ workspace: { textDocuments: [] }, window: {} });
  sandbox.testIdentityKey = path.resolve('shared-problem');
  assert.equal(vm.runInContext(`
    beginTestcaseAiJob(testIdentityKey);
    beginTestcaseAiJob(testIdentityKey);
    endTestcaseAiJob(testIdentityKey);
    activeTestcaseAiJobs.has(testIdentityKey);
  `, sandbox), true);
  assert.equal(vm.runInContext(`
    endTestcaseAiJob(testIdentityKey);
    activeTestcaseAiJobs.has(testIdentityKey);
  `, sandbox), false);
});

test('sidebar problem scope changes when the same sidecar record is recaptured', () => {
  const sandbox = loadExtension({ workspace: { textDocuments: [] }, window: {} });
  const folder = path.resolve('same-private-record');
  const first = sandbox.sidebarProblemKey({ folder, metadata: { captureRevision: 'revision-a' } });
  const second = sandbox.sidebarProblemKey({ folder, metadata: { captureRevision: 'revision-b' } });
  assert.notEqual(first, second);
});

test('test scaffold status uses four concise states with live generation taking priority', () => {
  const sandbox = loadExtension({ workspace: { textDocuments: [] }, window: {} });
  const status = (input) => ({ ...sandbox.scaffoldStatusPresentation(input) });

  assert.deepEqual(status({ hasScaffold: true }), {
    kind: 'generated', text: '测试脚手架已生成'
  });
  assert.deepEqual(status({ hasScaffold: true, generationActive: true, stale: true }), {
    kind: 'generating', text: '测试脚手架正在生成'
  });
  assert.deepEqual(status({ hasScaffold: true, stale: true }), {
    kind: 'stale', text: '测试脚手架可能不是最新版本'
  });
  assert.deepEqual(status({ hasScaffold: false, stale: true }), {
    kind: 'missing', text: '测试脚手架未生成'
  });
});

test('a successful browser capture opens and focuses the LeetCode CPH sidebar without surfacing UI failures', async () => {
  const commands = [];
  const output = [];
  const vscodeStub = {
    workspace: { textDocuments: [] },
    window: {},
    commands: {
      executeCommand: async (command) => {
        commands.push(command);
        if (command === 'leetcodeCph.sidebar.focus' && commands.length > 2) throw new Error('workbench is restoring');
      }
    }
  };
  const sandbox = loadExtension(vscodeStub);
  sandbox.injectedOutputChannel = { appendLine: (line) => output.push(String(line)) };
  vm.runInContext('outputChannel = injectedOutputChannel;', sandbox);

  await sandbox.openSidebarAfterCapture();
  assert.deepEqual(commands, [
    'workbench.view.extension.leetcodeCph',
    'leetcodeCph.sidebar.focus'
  ]);

  await sandbox.openSidebarAfterCapture();
  assert.deepEqual(commands.slice(2), [
    'workbench.view.extension.leetcodeCph',
    'leetcodeCph.sidebar.focus'
  ]);
  assert.match(output.at(-1), /Could not open the LeetCode CPH sidebar after capture: workbench is restoring/);
});

test('sidebar notice expires after 15 seconds and stale dismissal cannot clear a newer notice', () => {
  const timers = [];
  const cleared = [];
  const sandbox = loadExtension(
    { workspace: { textDocuments: [] }, window: {} },
    {
      setTimeout: (callback, delay) => {
        const timer = { callback, delay, unref() {} };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (timer) => { if (timer) cleared.push(timer); }
    }
  );
  sandbox.setSidebarRuntime({ notice: '第一条通知' });
  const first = sandbox.runtimeStateFor(null);
  assert.equal(first.notice, '第一条通知');
  assert.ok(Number.isSafeInteger(first.noticeRevision));
  assert.equal(timers.at(-1).delay, 15_000);

  sandbox.setSidebarRuntime({ notice: '第二条通知' });
  const second = sandbox.runtimeStateFor(null);
  assert.ok(second.noticeRevision > first.noticeRevision);
  assert.ok(cleared.includes(timers[0]));
  sandbox.dismissSidebarNotice(first.noticeRevision);
  assert.equal(sandbox.runtimeStateFor(null).notice, '第二条通知');
  timers[0].callback();
  assert.equal(sandbox.runtimeStateFor(null).notice, '第二条通知', 'an already queued old timer must not dismiss a newer notice');
  sandbox.dismissSidebarNotice(second.noticeRevision);
  assert.equal(sandbox.runtimeStateFor(null).notice, '');
  assert.ok(cleared.includes(timers[1]), 'a stale callback must not lose ownership of the current timer');

  sandbox.setSidebarRuntime({ notice: '第三条通知' });
  const third = sandbox.runtimeStateFor(null);
  assert.equal(third.notice, '第三条通知');
  timers.at(-1).callback();
  const dismissed = sandbox.runtimeStateFor(null);
  assert.equal(dismissed.notice, '');
  assert.ok(dismissed.noticeRevision > third.noticeRevision);
});

test('sidebar errors expire after 15 seconds and stale dismissal cannot clear a newer error', () => {
  const timers = [];
  const cleared = [];
  const sandbox = loadExtension(
    { workspace: { textDocuments: [] }, window: {} },
    {
      setTimeout: (callback, delay) => {
        const timer = { callback, delay, unref() {} };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (timer) => { if (timer) cleared.push(timer); }
    }
  );
  sandbox.setSidebarRuntime({ error: '第一条错误' });
  const first = sandbox.runtimeStateFor(null);
  assert.equal(first.error, '第一条错误');
  assert.ok(Number.isSafeInteger(first.errorRevision));
  assert.equal(timers.at(-1).delay, 15_000);

  sandbox.setSidebarRuntime({ error: '第二条错误' });
  const second = sandbox.runtimeStateFor(null);
  assert.ok(second.errorRevision > first.errorRevision);
  assert.ok(cleared.includes(timers[0]));
  sandbox.dismissSidebarError(first.errorRevision);
  assert.equal(sandbox.runtimeStateFor(null).error, '第二条错误');
  timers[0].callback();
  assert.equal(sandbox.runtimeStateFor(null).error, '第二条错误');
  sandbox.dismissSidebarError(second.errorRevision);
  assert.equal(sandbox.runtimeStateFor(null).error, '');
  assert.ok(cleared.includes(timers[1]));

  sandbox.setSidebarRuntime({ error: '第三条错误' });
  const third = sandbox.runtimeStateFor(null);
  timers.at(-1).callback();
  const dismissed = sandbox.runtimeStateFor(null);
  assert.equal(dismissed.error, '');
  assert.ok(dismissed.errorRevision > third.errorRevision);
});

test('problem-read errors enter the same transient error lifecycle', async () => {
  const timers = [];
  const sandbox = loadExtension(
    { workspace: { textDocuments: [] }, window: {} },
    {
      setTimeout: (callback, delay) => {
        const timer = { callback, delay, unref() {} };
        timers.push(timer);
        return timer;
      }
    }
  );
  vm.runInContext("activeProblemContext = async () => { throw new Error('题目信息损坏'); };", sandbox);

  const state = await sandbox.sidebarState();
  assert.equal(state.error, '题目信息损坏');
  assert.equal(sandbox.runtimeStateFor(null).error, '题目信息损坏');
  assert.equal(timers.at(-1).delay, 15_000);
  timers.at(-1).callback();
  assert.equal(sandbox.runtimeStateFor(null).error, '');
});

test('showing an error clears an existing notice and its stale timer cannot clear the error', () => {
  const timers = [];
  const sandbox = loadExtension(
    { workspace: { textDocuments: [] }, window: {} },
    {
      setTimeout: (callback, delay) => {
        const timer = { callback, delay, unref() {} };
        timers.push(timer);
        return timer;
      }
    }
  );
  sandbox.setSidebarRuntime({ notice: '正在处理…' });
  const noticeTimer = timers.at(-1);
  sandbox.setSidebarRuntime({ notice: '', error: '处理失败' });
  const state = sandbox.runtimeStateFor(null);
  assert.equal(state.notice, '');
  assert.equal(state.error, '处理失败');
  noticeTimer.callback();
  assert.equal(sandbox.runtimeStateFor(null).error, '处理失败');
});

test('sidebar keeps the problem context when main.* is active and uses an unsaved solution buffer', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-sidebar-context-'));
  temporaryFolders.push(folder);
  const stateFolder = stateFolderFor(folder);
  const solutionPath = path.join(folder, 'solution.py');
  const testcasePath = path.join(folder, 'main.py');
  await fs.mkdir(stateFolder, { recursive: true });
  await Promise.all([
    fs.writeFile(solutionPath, 'disk_solution = True\n', 'utf8'),
    fs.writeFile(testcasePath, '# generated test scaffold\n', 'utf8'),
    fs.writeFile(path.join(stateFolder, 'metadata.json'), JSON.stringify(registeredMetadata({
      title: '1. Two Sum',
      source: 'https://leetcode.com/problems/two-sum/',
      language: 'Python3',
      solutionFileName: 'solution.py'
    })), 'utf8'),
    fs.writeFile(path.join(stateFolder, 'testcases.json'), JSON.stringify({
      version: 2,
      testCases: [{
        id: 'ai-example', name: 'testcase 001', input: 'nums = [2,7], target = 9',
        expectedOutput: '[0,1]', source: 'ai', createdAt: '2026-09-02T00:00:00.000Z'
      }],
      excludedAiIds: [],
      excludedLeetCodeIds: []
    }), 'utf8')
  ]);

  const solutionDocument = {
    uri: { scheme: 'file', fsPath: solutionPath },
    isDirty: true,
    getText: () => 'unsaved_solution = True\n'
  };
  const vscodeStub = {
    workspace: {
      workspaceFolders: [{ uri: { fsPath: folder } }],
      rootPath: folder,
      textDocuments: [solutionDocument],
      getConfiguration: () => ({ get: () => undefined })
    },
    window: {
      activeTextEditor: {
        document: {
          uri: { scheme: 'file', fsPath: testcasePath },
          getText: () => '# generated test scaffold\n'
        }
      }
    }
  };
  const sandbox = loadExtension(vscodeStub);
  const context = await sandbox.activeProblemContext();

  assert.equal(context.solutionPath, solutionPath);
  assert.equal(context.code, 'unsaved_solution = True\n');
  assert.equal(context.title, '1. Two Sum');
  assert.equal(Array.from(context.testCases, (item) => item.name).join(','), 'testcase 001');
  const state = await sandbox.sidebarState();
  assert.match(state.problem.key, /^[a-f0-9]{24}$/);
});

test('sidebar never shows legacy raw DOM testcases after the AI-only migration', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-sidebar-legacy-'));
  temporaryFolders.push(folder);
  const stateFolder = stateFolderFor(folder);
  const solutionPath = path.join(folder, 'solution.js');
  await fs.mkdir(stateFolder, { recursive: true });
  await Promise.all([
    fs.writeFile(solutionPath, 'module.exports = {};\n', 'utf8'),
    fs.writeFile(path.join(stateFolder, 'metadata.json'), JSON.stringify(registeredMetadata({
      title: '1. Two Sum',
      source: 'https://leetcode.com/problems/two-sum/',
      language: 'JavaScript',
      solutionFileName: 'solution.js'
    })), 'utf8'),
    fs.writeFile(path.join(stateFolder, 'testcases.json'), JSON.stringify({
      version: 1,
      testCases: [
        {
          id: 'leetcode-raw', name: 'testcase 001', input: 'incorrect DOM parsing',
          expectedOutput: 'incorrect output', source: 'leetcode', createdAt: '2026-09-02T00:00:00.000Z'
        },
        {
          id: 'manual-kept', name: 'testcase 002', input: 'manual input',
          expectedOutput: 'manual output', source: 'manual', createdAt: '2026-09-02T00:00:00.000Z'
        }
      ],
      excludedAiIds: [],
      excludedLeetCodeIds: []
    }), 'utf8')
  ]);

  const vscodeStub = {
    workspace: {
      workspaceFolders: [{ uri: { fsPath: folder } }],
      rootPath: folder,
      textDocuments: [],
      getConfiguration: () => ({ get: () => undefined })
    },
    window: {
      activeTextEditor: {
        document: { uri: { scheme: 'file', fsPath: solutionPath }, getText: () => 'module.exports = {};\n' }
      }
    }
  };
  const sandbox = loadExtension(vscodeStub);
  const context = await sandbox.activeProblemContext();

  assert.deepEqual(Array.from(context.testCases, (item) => item.id), ['manual-kept']);
});

test('sidebar uses the saved expected output for status and the runtime protocol for actual output', () => {
  const sandbox = loadExtension({});
  const results = sandbox.sidebarResultsFromRun([
    { id: 'case-1', name: 'testcase 001', input: 'nums=[2,7], target=9', expectedOutput: '[0,1]' }
  ], {
    'testcase 001': { actual: [1, 0], passed: true }
  });

  assert.deepEqual({ ...results['case-1'] }, {
    status: 'failed',
    passed: false,
    actualOutput: '[1,0]'
  });
});

test('sidebar treats a testcase as a draft only when both fields are truly empty', () => {
  const sandbox = loadExtension({});
  assert.equal(sandbox.testcaseHasRunnableData({ input: '', expectedOutput: 'null' }), true);
  assert.equal(sandbox.testcaseHasRunnableData({ input: 'arg', expectedOutput: '' }), true);
  assert.equal(sandbox.testcaseHasRunnableData({ input: ' ', expectedOutput: ' ' }), true);
  assert.equal(sandbox.testcaseHasRunnableData({ input: '', expectedOutput: '' }), false);
  assert.notEqual(sandbox.comparableOutput(' value '), sandbox.comparableOutput('value'));
});

test('capture output directories allow absolute paths only inside the workspace', () => {
  const sandbox = loadExtension({});
  const root = path.resolve(os.tmpdir(), 'leetcode-cph-workspace-root');
  assert.equal(
    sandbox.resolveWorkspaceOutputDirectory(root, 'leetcode/problems'),
    path.join(root, 'leetcode', 'problems')
  );
  const insideAbsolute = path.join(root, 'captured-problems');
  assert.equal(
    sandbox.resolveWorkspaceOutputDirectory(root, insideAbsolute),
    insideAbsolute
  );
  assert.throws(
    () => sandbox.resolveWorkspaceOutputDirectory(root, path.join('..', 'outside-workspace')),
    /工作区外/
  );
  assert.throws(
    () => sandbox.resolveWorkspaceOutputDirectory(root, path.resolve(root, '..', 'outside-workspace')),
    /工作区外/
  );
});

test('capture accepts only LeetCode problem URLs', () => {
  const sandbox = loadExtension({});
  assert.equal(sandbox.validPayload({
    title: 'Two Sum', source: 'https://www.leetcode.com/problems/two-sum/description/?envType=problem-list-v2', code: ''
  }), true);
  assert.equal(sandbox.validPayload({
    title: 'Not a problem', source: 'https://leetcode.com/problemset/', code: ''
  }), false);
  assert.equal(sandbox.validPayload({
    title: 'Wrong host', source: 'https://example.com/problems/two-sum/', code: ''
  }), false);
  assert.equal(sandbox.validPayload({
    title: 'Wrong protocol', source: 'http://leetcode.com/problems/two-sum/', code: ''
  }), false);
  assert.equal(sandbox.languageExtension('Haskell'), 'hs');
});

test('non-solution metadata filenames are ignored and recapture preserves README and .env files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-invalid-solution-name-workspace-'));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-invalid-solution-name-storage-'));
  temporaryFolders.push(root, storage);
  const vscodeStub = {
    workspace: {
      workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }],
      rootPath: root,
      textDocuments: [],
      getConfiguration: () => ({ get: (key) => key === 'outputDirectory' ? 'leetcode' : key === 'openSolutionAfterCapture' ? false : 27121 })
    },
    window: { showTextDocument: async () => {} }
  };
  const sandbox = loadExtension(vscodeStub);
  initializePrivateStorage(sandbox, storage);
  vm.runInContext('outputChannel = { appendLine() {} };', sandbox);

  const fixtures = [
    { title: 'README Poison', slug: 'readme-poison', fileName: 'README.md', contents: '# user documentation\n' },
    { title: 'Env Poison', slug: 'env-poison', fileName: '.env', contents: 'USER_SECRET=must-stay-untouched\n' }
  ];
  for (const fixture of fixtures) {
    const problemDirectory = path.join(root, 'leetcode', fixture.title);
    const stateFolder = stateFolderFor(problemDirectory);
    await fs.mkdir(stateFolder, { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(problemDirectory, fixture.fileName), fixture.contents, 'utf8'),
      fs.writeFile(path.join(stateFolder, 'metadata.json'), JSON.stringify(registeredMetadata({
        title: fixture.title,
        source: `https://leetcode.com/problems/${fixture.slug}/`,
        problemSlug: fixture.slug,
        language: 'Python3',
        solutionFileName: fixture.fileName
      })), 'utf8'),
      fs.writeFile(path.join(stateFolder, 'testcases.json'), JSON.stringify({
        version: 3, testCases: [], excludedAiIds: [], excludedLeetCodeIds: []
      }), 'utf8')
    ]);
  }

  const poisonedRecords = await sandbox.listStoredProblemRecords();
  assert.deepEqual(Array.from(poisonedRecords), [], 'README/.env must never be accepted as registered solutions');

  for (const fixture of fixtures) {
    const saved = await sandbox.saveCapture({
      title: fixture.title,
      source: `https://leetcode.com/problems/${fixture.slug}/`,
      problemSlug: fixture.slug,
      language: 'Python3',
      description: '',
      samples: '',
      code: 'class Solution: pass\n'
    });
    assert.equal(await fs.readFile(path.join(path.dirname(saved.solution), fixture.fileName), 'utf8'), fixture.contents);
    assert.equal(await fs.readFile(saved.solution, 'utf8'), 'class Solution: pass\n');
    const metadata = JSON.parse(await fs.readFile(path.join(saved.problemFolder, 'metadata.json'), 'utf8'));
    assert.equal(metadata.solutionFileName, 'solution.py');
  }
});

test('record enumeration rejects an output directory link that resolves outside the workspace', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-output-link-workspace-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-output-link-outside-'));
  temporaryFolders.push(root, outside);
  const outsideProblem = path.join(outside, 'Outside Problem');
  const outsideState = stateFolderFor(outsideProblem);
  await fs.mkdir(outsideState, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(outsideProblem, 'solution.py'), 'outside = True\n', 'utf8'),
    fs.writeFile(path.join(outsideState, 'metadata.json'), JSON.stringify(registeredMetadata({
      title: 'Outside Problem',
      source: 'https://leetcode.com/problems/outside-problem/',
      language: 'Python3',
      solutionFileName: 'solution.py'
    })), 'utf8')
  ]);
  const linkedOutput = path.join(root, 'linked-output');
  if (!await createLinkOrSkip(t, outside, linkedOutput, 'junction')) return;

  let enumeratedLinkedOutput = false;
  const trackingFs = Object.create(fs);
  trackingFs.readdir = async (target, ...args) => {
    if (path.resolve(String(target)) === path.resolve(linkedOutput)) enumeratedLinkedOutput = true;
    return fs.readdir(target, ...args);
  };
  const sandbox = loadExtension({
    workspace: {
      workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }],
      rootPath: root,
      textDocuments: [],
      getConfiguration: () => ({ get: (key) => key === 'outputDirectory' ? 'linked-output' : undefined })
    },
    window: {}
  }, { fsPromises: trackingFs });
  sandbox.initializeProblemStorage();

  await assert.rejects(
    sandbox.listStoredProblemRecords(),
    /输出目录.*(?:符号链接|工作区外|拒绝)/
  );
  assert.equal(enumeratedLinkedOutput, false, 'the extension must reject the escaped output root before enumerating it');
});

test('capture rejects a backups directory link that resolves outside the problem sidecar', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-backups-link-workspace-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-backups-link-outside-'));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-backups-link-storage-'));
  temporaryFolders.push(root, outside, storage);
  const vscodeStub = {
    workspace: {
      workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }],
      rootPath: root,
      textDocuments: [],
      getConfiguration: () => ({ get: (key) => key === 'outputDirectory' ? 'leetcode' : key === 'openSolutionAfterCapture' ? false : 27121 })
    },
    window: { showTextDocument: async () => {} }
  };
  const sandbox = loadExtension(vscodeStub);
  initializePrivateStorage(sandbox, storage);
  vm.runInContext('outputChannel = { appendLine() {} };', sandbox);
  const payload = {
    title: 'Unsafe Backups', source: 'https://leetcode.com/problems/unsafe-backups/', problemSlug: 'unsafe-backups',
    language: 'Python3', description: '', samples: '', code: 'original = True\n'
  };
  const initial = await sandbox.saveCapture(payload);
  const metadataBefore = await fs.readFile(path.join(initial.problemFolder, 'metadata.json'), 'utf8');
  const backupsLink = path.join(initial.problemFolder, 'backups');
  if (!await createLinkOrSkip(t, outside, backupsLink, 'junction')) return;

  await assert.rejects(
    sandbox.saveCapture({ ...payload, code: 'replacement = True\n' }),
    /backups|符号链接|链接|拒绝/i
  );
  assert.deepEqual(await fs.readdir(outside), [], 'no backup or temporary file may be written through the link');
  assert.equal(await fs.readFile(initial.solution, 'utf8'), payload.code);
  assert.equal(await fs.readFile(path.join(initial.problemFolder, 'metadata.json'), 'utf8'), metadataBefore);
  assert.equal((await fs.lstat(backupsLink)).isSymbolicLink(), true);
});

test('capture rejects solution and main file links that resolve outside the problem directory', async (t) => {
  for (const artifact of ['solution', 'main']) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `leetcode-cph-${artifact}-link-workspace-`));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), `leetcode-cph-${artifact}-link-outside-`));
    const storage = await fs.mkdtemp(path.join(os.tmpdir(), `leetcode-cph-${artifact}-link-storage-`));
    temporaryFolders.push(root, outside, storage);
    const sandbox = loadExtension({
      workspace: {
        workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }],
        rootPath: root,
        textDocuments: [],
        getConfiguration: () => ({ get: (key) => key === 'outputDirectory' ? 'leetcode' : key === 'openSolutionAfterCapture' ? false : 27121 })
      },
      window: { showTextDocument: async () => {} }
    });
    initializePrivateStorage(sandbox, storage);
    vm.runInContext('outputChannel = { appendLine() {} };', sandbox);
    const payload = {
      title: `Unsafe ${artifact}`, source: `https://leetcode.com/problems/unsafe-${artifact}/`, problemSlug: `unsafe-${artifact}`,
      language: 'Python3', description: '', samples: '', code: 'original = True\n'
    };
    const initial = await sandbox.saveCapture(payload);
    const artifactPath = artifact === 'solution'
      ? initial.solution
      : path.join(path.dirname(initial.solution), 'main.py');
    const outsideFile = path.join(outside, `${artifact}.py`);
    const outsideContents = `${artifact}_outside = True\n`;
    await fs.writeFile(outsideFile, outsideContents, 'utf8');
    if (artifact === 'solution') await fs.unlink(artifactPath);
    if (!await createLinkOrSkip(t, outsideFile, artifactPath, 'file')) return;
    const metadataBefore = await fs.readFile(path.join(initial.problemFolder, 'metadata.json'), 'utf8');

    await assert.rejects(
      sandbox.saveCapture({ ...payload, code: 'replacement = True\n' }),
      /solution|main|符号链接|链接|拒绝/i
    );
    assert.equal(await fs.readFile(outsideFile, 'utf8'), outsideContents);
    assert.equal(await fs.readFile(path.join(initial.problemFolder, 'metadata.json'), 'utf8'), metadataBefore);
    assert.equal((await fs.lstat(artifactPath)).isSymbolicLink(), true);
  }
});

test('capture creates a title-named problem directory with a workspace sidecar record', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-recapture-workspace-'));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-recapture-storage-'));
  temporaryFolders.push(root, storage);
  const outputFolder = path.join(root, 'leetcode');
  const problemDirectory = path.join(outputFolder, '1. Two Sum');
  const solutionPath = path.join(problemDirectory, 'solution.py');
  const textDocuments = [];
  const vscodeStub = {
    workspace: {
      // Capturing raw browser data is safe in Restricted Mode; only generating
      // or executing AI code requires a trusted workspace.
      isTrusted: false,
      workspaceFolders: [{ uri: { fsPath: root } }],
      rootPath: root,
      textDocuments,
      getConfiguration: () => ({ get: (key) => key === 'outputDirectory' ? 'leetcode' : key === 'openSolutionAfterCapture' ? false : key === 'ai.provider' ? 'glm' : '' })
    },
    window: { showTextDocument: async () => {} }
  };
  const sandbox = loadExtension(vscodeStub);
  initializePrivateStorage(sandbox, storage);
  vm.runInContext('outputChannel = { appendLine() {} };', sandbox);
  const payload = {
    title: '1. Two Sum', source: 'https://leetcode.com/problems/two-sum/', problemId: '1', problemSlug: 'two-sum',
    language: 'Python3', description: 'Example', samples: '', code: 'disk_solution = True\n'
  };
  const first = await sandbox.saveCapture(payload);
  assert.equal(first.solutionCreated, true);
  assert.equal(first.solution, solutionPath);
  assert.equal(first.problemFolder, stateFolderFor(problemDirectory));

  const scaffoldPath = path.join(problemDirectory, 'main.py');
  await fs.writeFile(scaffoldPath, '# scaffold for the old solution\n', 'utf8');
  textDocuments.push({
    uri: { scheme: 'file', fsPath: solutionPath },
    isDirty: false,
    getText: () => 'disk_solution = True\n'
  });
  const saved = await sandbox.saveCapture({ ...payload, code: 'browser_code = True\n' });

  assert.equal(saved.solutionCreated, false);
  assert.equal(path.dirname(path.dirname(saved.solutionBackup)), path.join(saved.problemFolder, 'backups'));
  assert.equal(path.basename(saved.solutionBackup), 'solution.py');
  assert.equal(saved.scaffoldStale, false);
  assert.equal(await fs.readFile(solutionPath, 'utf8'), 'browser_code = True\n');
  assert.equal(await fs.readFile(saved.solutionBackup, 'utf8'), 'disk_solution = True\n');
  assert.deepEqual(await fs.readdir(outputFolder), ['1. Two Sum']);
  assert.deepEqual((await fs.readdir(problemDirectory)).sort(), ['.leetcode_cph', 'solution.py']);

  const stateEntries = (await fs.readdir(saved.problemFolder)).sort();
  assert.deepEqual(stateEntries, ['backups', 'metadata.json', 'testcases.json']);
  const metadata = JSON.parse(await fs.readFile(path.join(saved.problemFolder, 'metadata.json'), 'utf8'));
  assert.equal(metadata.code, 'browser_code = True\n');
  assert.equal(metadata.storageSchemaVersion, 3);
  assert.equal(metadata.storageLayout, 'workspace-sidecar');
  assert.equal(metadata.solutionPath, undefined);
  assert.equal(metadata.solutionFileName, 'solution.py');
  assert.equal(metadata.mainFileName, 'main.py');
  assert.equal(metadata.testcaseScaffoldStale, false);

  // A new extension-host instance has an empty in-memory cache and does not
  // receive the old storage path. The sibling sidecar alone restores context.
  const reloadedVscodeStub = {
    workspace: {
      workspaceFolders: [{ uri: { fsPath: root } }],
      rootPath: root,
      textDocuments: [],
      getConfiguration: () => ({ get: () => undefined })
    },
    window: {
      activeTextEditor: {
        document: { uri: { scheme: 'file', fsPath: solutionPath }, getText: () => 'browser_code = True\n' }
      }
    }
  };
  const reloaded = loadExtension(reloadedVscodeStub);
  reloaded.initializeProblemStorage();
  const context = await reloaded.activeProblemContext();
  assert.equal(context.folder, saved.problemFolder);
  assert.equal(context.solutionPath, solutionPath);
  assert.equal(context.title, '1. Two Sum');
  assert.equal(context.code, 'browser_code = True\n');
});

test('running all cases executes the sibling visible solution and main files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-hidden-run-workspace-'));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-hidden-run-storage-'));
  temporaryFolders.push(root, storage);
  const windowStub = {
    showTextDocument: async () => {},
    showWarningMessage: async () => '我已审阅，运行'
  };
  const textDocuments = [];
  const vscodeStub = {
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: { fsPath: root } }],
      rootPath: root,
      textDocuments,
      getConfiguration: () => ({ get: (key) => key === 'outputDirectory' ? 'leetcode' : key === 'openSolutionAfterCapture' ? false : 27121 })
    },
    window: windowStub,
    Uri: { file: (value) => ({ scheme: 'file', fsPath: value }) }
  };
  const sandbox = loadExtension(vscodeStub);
  initializePrivateStorage(sandbox, storage);
  vm.runInContext('outputChannel = { appendLine() {} };', sandbox);
  const saved = await sandbox.saveCapture({
    title: '1. Add', source: 'https://leetcode.com/problems/add/', problemSlug: 'add',
    language: 'JavaScript', description: 'Return the sum.', samples: '',
    code: 'module.exports = (left, right) => left + right;\n'
  });
  const testCase = {
    id: 'manual-1', name: 'testcase 001', input: 'left = 1, right = 2',
    expectedOutput: '3', source: 'manual', createdAt: '2026-09-02T00:00:00.000Z'
  };
  await fs.writeFile(path.join(saved.problemFolder, 'testcases.json'), JSON.stringify({
    version: 3, testCases: [testCase], excludedAiIds: [], excludedLeetCodeIds: []
  }), 'utf8');
  await fs.writeFile(path.join(path.dirname(saved.solution), 'main.js'), [
    "const add = require('./solution');",
    "const selected = process.argv[2] === '--case' ? process.argv[3] : '';",
    "if (!selected || selected === 'testcase 001') {",
    '  const actual = add(1, 2);',
    "  console.log('__LEETCODE_CPH_RESULT__' + JSON.stringify({ name: 'testcase 001', actual, passed: actual === 3 }));",
    '}'
  ].join('\n'), 'utf8');
  const metadataPath = path.join(saved.problemFolder, 'metadata.json');
  const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
  await fs.writeFile(metadataPath, JSON.stringify({ ...metadata, testcaseScaffoldStale: false }), 'utf8');
  const solutionDocument = {
    uri: { scheme: 'file', fsPath: saved.solution }, isDirty: false,
    getText: () => 'module.exports = (left, right) => left + right;\n'
  };
  textDocuments.push(solutionDocument);
  windowStub.activeTextEditor = { document: solutionDocument };

  const result = await sandbox.runTestsFromSidebar('all');

  assert.equal(result.execution.ok, true);
  assert.equal(result.execution.results['testcase 001'].actual, 3);
  await assert.rejects(fs.access(path.join(saved.problemFolder, 'solution.js')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(saved.solution, 'utf8'), solutionDocument.getText());
  assert.deepEqual(await fs.readdir(path.join(root, 'leetcode')), ['1. Add']);
  assert.deepEqual((await fs.readdir(path.dirname(saved.solution))).sort(), ['.leetcode_cph', 'main.js', 'solution.js']);
});

test('same-title captures overwrite the registered file and active record instead of creating a suffix', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-title-collision-workspace-'));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-title-collision-storage-'));
  temporaryFolders.push(root, storage);
  const vscodeStub = {
    workspace: {
      workspaceFolders: [{ uri: { fsPath: root } }], rootPath: root, textDocuments: [],
      getConfiguration: () => ({ get: (key) => key === 'outputDirectory' ? 'leetcode' : key === 'openSolutionAfterCapture' ? false : 27121 })
    },
    window: { showTextDocument: async () => {} }
  };
  const sandbox = loadExtension(vscodeStub);
  initializePrivateStorage(sandbox, storage);
  vm.runInContext('outputChannel = { appendLine() {} };', sandbox);
  const common = { title: 'Same Name', language: 'Python3', description: 'A problem.', samples: '' };
  const first = await sandbox.saveCapture({
    ...common, source: 'https://leetcode.com/problems/alpha-problem/', problemSlug: 'alpha-problem', code: 'alpha = 1\n'
  });
  await fs.writeFile(first.solution, 'alpha local latest = True\n', 'utf8');
  const second = await sandbox.saveCapture({
    ...common, source: 'https://leetcode.com/problems/beta-problem/', problemSlug: 'beta-problem', code: 'beta = 1\n'
  });
  assert.equal(second.solution, first.solution);
  assert.equal(await fs.readFile(second.solution, 'utf8'), 'beta = 1\n');
  assert.deepEqual(await fs.readdir(path.join(root, 'leetcode')), ['Same Name']);
  const betaMetadata = JSON.parse(await fs.readFile(path.join(second.problemFolder, 'metadata.json'), 'utf8'));
  assert.equal(betaMetadata.source, 'https://leetcode.com/problems/beta-problem/');
  assert.equal(second.problemFolder, first.problemFolder);
  assert.equal(second.solutionBackup, second.overwrittenSolutionBackup);
  assert.equal(
    await fs.readFile(second.overwrittenSolutionBackup, 'utf8'),
    'alpha local latest = True\n'
  );
  assert.equal(path.dirname(second.overwrittenSolutionBackup), second.overwrittenRecordBackup);
  assert.equal(isPathInsideForTest(second.problemFolder, second.overwrittenRecordBackup), true);
  await assert.rejects(fs.access(path.join(second.problemFolder, 'solution.py.bak')), { code: 'ENOENT' });

  const recaptured = await sandbox.saveCapture({
    ...common, source: 'https://leetcode.cn/problems/alpha-problem/', problemSlug: 'alpha-problem', code: 'alpha = 2\n'
  });

  assert.equal(path.basename(first.solution), 'solution.py');
  assert.equal(recaptured.solution, first.solution);
  assert.equal(recaptured.problemFolder, first.problemFolder);
  assert.equal(second.problemFolder, first.problemFolder);
  assert.equal(await fs.readFile(first.solution, 'utf8'), 'alpha = 2\n');
  const alphaMetadata = JSON.parse(await fs.readFile(path.join(recaptured.problemFolder, 'metadata.json'), 'utf8'));
  assert.equal(alphaMetadata.source, 'https://leetcode.cn/problems/alpha-problem/');
  assert.deepEqual(await fs.readdir(path.join(root, 'leetcode')), ['Same Name']);
  assert.equal((await fs.readdir(path.join(recaptured.problemFolder, 'backups'))).length, 2);
  assert.deepEqual(await fs.readdir(storage), []);
});

test('a failed same-title replacement restores the outgoing file and sidecar owner', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-collision-rollback-workspace-'));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-collision-rollback-storage-'));
  temporaryFolders.push(root, storage);
  let failNextMetadataWrite = false;
  const failingFs = Object.create(fs);
  failingFs.writeFile = async (filePath, ...args) => {
    if (failNextMetadataWrite && /^metadata\.json\..+\.tmp$/i.test(path.basename(String(filePath)))) {
      failNextMetadataWrite = false;
      const error = new Error('injected metadata write failure');
      error.code = 'EIO';
      throw error;
    }
    return fs.writeFile(filePath, ...args);
  };
  const vscodeStub = {
    workspace: {
      workspaceFolders: [{ uri: { fsPath: root } }], rootPath: root, textDocuments: [],
      getConfiguration: () => ({ get: (key) => key === 'outputDirectory' ? 'leetcode' : key === 'openSolutionAfterCapture' ? false : 27121 })
    },
    window: { showTextDocument: async () => {} }
  };
  const sandbox = loadExtension(vscodeStub, { fsPromises: failingFs });
  initializePrivateStorage(sandbox, storage);
  vm.runInContext('outputChannel = { appendLine() {} };', sandbox);
  const first = await sandbox.saveCapture({
    title: 'Same Name', source: 'https://leetcode.com/problems/alpha-problem/', problemSlug: 'alpha-problem',
    language: 'Python3', description: '', samples: '', code: 'alpha = 1\n'
  });
  await fs.writeFile(first.solution, 'alpha local = 2\n', 'utf8');

  failNextMetadataWrite = true;
  await assert.rejects(sandbox.saveCapture({
    title: 'Same Name', source: 'https://leetcode.com/problems/beta-problem/', problemSlug: 'beta-problem',
    language: 'Python3', description: '', samples: '', code: 'beta = 1\n'
  }), /保存同名题目失败，已恢复覆盖前状态/);

  assert.equal(await fs.readFile(first.solution, 'utf8'), 'alpha local = 2\n');
  const ownerMetadata = JSON.parse(await fs.readFile(path.join(first.problemFolder, 'metadata.json'), 'utf8'));
  assert.equal(ownerMetadata.source, 'https://leetcode.com/problems/alpha-problem/');
  assert.deepEqual(await fs.readdir(storage), []);
  vscodeStub.window.activeTextEditor = {
    document: { uri: { scheme: 'file', fsPath: first.solution }, getText: () => 'alpha local = 2\n' }
  };
  assert.equal((await sandbox.activeProblemContext()).source, ownerMetadata.source);
});

test('concurrent same-title captures commit in arrival order without losing the sidecar record', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-collision-order-workspace-'));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-collision-order-storage-'));
  temporaryFolders.push(root, storage);
  let providerReads = 0;
  let blockNextProviderRead = false;
  let enteredBlockedRead;
  let releaseBlockedRead;
  const blockedReadEntered = new Promise((resolve) => { enteredBlockedRead = resolve; });
  const blockedReadRelease = new Promise((resolve) => { releaseBlockedRead = resolve; });
  const vscodeStub = {
    workspace: {
      workspaceFolders: [{ uri: { fsPath: root } }], rootPath: root, textDocuments: [],
      getConfiguration: () => ({ get: (key) => key === 'outputDirectory' ? 'leetcode' : key === 'openSolutionAfterCapture' ? false : key === 'ai.provider' ? 'glm' : '' })
    },
    window: { showTextDocument: async () => {} }
  };
  const sandbox = loadExtension(vscodeStub);
  initializePrivateStorage(sandbox, storage);
  sandbox.injectedAiService = {
    async getConfiguredProviders() {
      providerReads += 1;
      if (blockNextProviderRead) {
        blockNextProviderRead = false;
        enteredBlockedRead();
        await blockedReadRelease;
      }
      return { glm: false, deepseek: false, qwen: false };
    }
  };
  vm.runInContext('aiTestcaseService = injectedAiService; outputChannel = { appendLine() {} };', sandbox);
  const common = { title: 'Same Name', language: 'Python3', description: '', samples: '' };
  await sandbox.saveCapture({
    ...common, source: 'https://leetcode.com/problems/alpha-problem/', problemSlug: 'alpha-problem', code: 'alpha = 1\n'
  });

  blockNextProviderRead = true;
  const alphaRecapture = sandbox.saveCapture({
    ...common, source: 'https://leetcode.com/problems/alpha-problem/', problemSlug: 'alpha-problem', code: 'alpha = 2\n'
  });
  let enteredTimeout;
  try {
    await Promise.race([
      blockedReadEntered,
      new Promise((_, reject) => {
        enteredTimeout = setTimeout(() => reject(new Error(`capture did not reach provider read; reads=${providerReads}`)), 1_000);
      })
    ]);
  } finally {
    clearTimeout(enteredTimeout);
  }
  const betaCapture = sandbox.saveCapture({
    ...common, source: 'https://leetcode.com/problems/beta-problem/', problemSlug: 'beta-problem', code: 'beta = 1\n'
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(providerReads, 2, 'the later capture must wait before reading configuration');
  releaseBlockedRead();
  const [alpha, beta] = await Promise.all([alphaRecapture, betaCapture]);

  assert.equal(alpha.solution, beta.solution);
  assert.equal(await fs.readFile(beta.solution, 'utf8'), 'beta = 1\n');
  const metadata = JSON.parse(await fs.readFile(path.join(beta.problemFolder, 'metadata.json'), 'utf8'));
  assert.equal(metadata.source, 'https://leetcode.com/problems/beta-problem/');
  assert.equal(alpha.problemFolder, beta.problemFolder);
  assert.equal(beta.problemFolder, stateFolderFor(path.dirname(beta.solution)));
  assert.deepEqual(await fs.readdir(storage), []);
});

test('capture ignores root-level legacy state and creates a fresh workspace sidecar', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-legacy-migration-workspace-'));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-legacy-migration-storage-'));
  temporaryFolders.push(root, storage);
  const legacy = path.join(root, 'leetcode', '1. Two Sum');
  await fs.mkdir(legacy, { recursive: true });
  const legacyCase = {
    id: 'manual-legacy', name: 'testcase 001', input: 'x = 1', expectedOutput: '1',
    source: 'manual', createdAt: '2026-09-02T00:00:00.000Z'
  };
  await Promise.all([
    fs.writeFile(path.join(legacy, 'solution.py'), 'old_local = True\n', 'utf8'),
    fs.writeFile(path.join(legacy, 'testcase.py'), '# old private scaffold\n', 'utf8'),
    fs.writeFile(path.join(legacy, 'metadata.json'), JSON.stringify({
      title: '1. Two Sum', source: 'https://leetcode.com/problems/two-sum/', language: 'Python3', code: 'old_local = True\n'
    }), 'utf8'),
    fs.writeFile(path.join(legacy, 'testcases.json'), JSON.stringify({
      version: 3, testCases: [legacyCase], excludedAiIds: [], excludedLeetCodeIds: []
    }), 'utf8')
  ]);
  const vscodeStub = {
    workspace: {
      workspaceFolders: [{ uri: { fsPath: root } }], rootPath: root, textDocuments: [],
      getConfiguration: () => ({ get: (key) => key === 'outputDirectory' ? 'leetcode' : key === 'openSolutionAfterCapture' ? false : 27121 })
    },
    window: { showTextDocument: async () => {} }
  };
  const sandbox = loadExtension(vscodeStub);
  initializePrivateStorage(sandbox, storage);
  vm.runInContext('outputChannel = { appendLine() {} };', sandbox);

  const saved = await sandbox.saveCapture({
    title: '1. Two Sum', source: 'https://leetcode.cn/problems/two-sum/', problemSlug: 'two-sum',
    language: 'Python3', description: 'Example', samples: '', code: 'browser = True\n'
  });

  assert.equal(await fs.readFile(saved.solution, 'utf8'), 'browser = True\n');
  assert.equal(saved.problemFolder, stateFolderFor(legacy));
  assert.equal(await fs.readFile(saved.solutionBackup, 'utf8'), 'old_local = True\n');
  await assert.rejects(fs.access(path.join(path.dirname(saved.solution), 'main.py')), { code: 'ENOENT' });
  const freshCases = JSON.parse(await fs.readFile(path.join(saved.problemFolder, 'testcases.json'), 'utf8'));
  assert.deepEqual(freshCases.testCases, []);
  assert.equal(saved.scaffoldStale, false);
  assert.equal(JSON.parse(await fs.readFile(path.join(legacy, 'metadata.json'), 'utf8')).code, 'old_local = True\n');
  assert.equal(JSON.parse(await fs.readFile(path.join(legacy, 'testcases.json'), 'utf8')).testCases[0].id, legacyCase.id);
  assert.equal(await fs.readFile(path.join(legacy, 'testcase.py'), 'utf8'), '# old private scaffold\n');
  assert.deepEqual(await fs.readdir(storage), []);
});

test('old VS Code private records are ignored and never migrated into the workspace sidecar', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-private-record-workspace-'));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-private-record-storage-'));
  temporaryFolders.push(root, storage);
  const problemDirectory = path.join(root, 'leetcode', 'Two Sum');
  const solutionPath = path.join(problemDirectory, 'solution.py');
  const oldPrivateFolder = path.join(storage, 'problems', 'old-record');
  await Promise.all([
    fs.mkdir(problemDirectory, { recursive: true }),
    fs.mkdir(oldPrivateFolder, { recursive: true })
  ]);
  await Promise.all([
    fs.writeFile(solutionPath, 'old local solution\n', 'utf8'),
    fs.writeFile(path.join(oldPrivateFolder, 'metadata.json'), JSON.stringify({
      title: 'Two Sum', source: 'https://leetcode.com/problems/two-sum/', language: 'Python3',
      solutionPath
    }), 'utf8'),
    fs.writeFile(path.join(oldPrivateFolder, 'testcases.json'), JSON.stringify({
      version: 3,
      testCases: [{
        id: 'old-private-case', name: 'testcase 001', input: 'old', expectedOutput: 'old',
        source: 'manual', createdAt: '2026-09-02T00:00:00.000Z'
      }],
      excludedAiIds: [], excludedLeetCodeIds: []
    }), 'utf8')
  ]);
  const vscodeStub = {
    workspace: {
      workspaceFolders: [{ uri: { fsPath: root } }], rootPath: root, textDocuments: [],
      getConfiguration: () => ({ get: (key) => key === 'outputDirectory' ? 'leetcode' : key === 'openSolutionAfterCapture' ? false : 27121 })
    },
    window: {
      showTextDocument: async () => {},
      activeTextEditor: {
        document: { uri: { scheme: 'file', fsPath: solutionPath }, getText: () => 'old local solution\n' }
      }
    }
  };
  const sandbox = loadExtension(vscodeStub);
  initializePrivateStorage(sandbox, storage);
  vm.runInContext('outputChannel = { appendLine() {} };', sandbox);

  const beforeCapture = await sandbox.activeProblemContext();
  assert.equal(beforeCapture.localOnly, true);
  assert.deepEqual(Array.from(beforeCapture.testCases), []);

  const saved = await sandbox.saveCapture({
    title: 'Two Sum', source: 'https://leetcode.com/problems/two-sum/', problemSlug: 'two-sum',
    language: 'Python3', description: 'Example', samples: '', code: 'class Solution: pass\n'
  });

  const state = JSON.parse(await fs.readFile(path.join(saved.problemFolder, 'testcases.json'), 'utf8'));
  assert.deepEqual(state.testCases, []);
  const unchangedOldState = JSON.parse(await fs.readFile(path.join(oldPrivateFolder, 'testcases.json'), 'utf8'));
  assert.equal(unchangedOldState.testCases[0].id, 'old-private-case');
  assert.equal(saved.problemFolder, stateFolderFor(problemDirectory));
});

test('workspace sidecars stay bound to their original workspace root when multi-root order changes', async () => {
  const rootA = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-multiroot-a-'));
  const rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-multiroot-b-'));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-multiroot-storage-'));
  temporaryFolders.push(rootA, rootB, storage);
  const folders = [{ uri: { fsPath: rootA } }, { uri: { fsPath: rootB } }];
  const vscodeStub = {
    workspace: {
      workspaceFolders: folders, rootPath: rootA, textDocuments: [],
      getConfiguration: () => ({ get: (key) => key === 'outputDirectory' ? 'leetcode' : key === 'openSolutionAfterCapture' ? false : 27121 })
    },
    window: { showTextDocument: async () => {} }
  };
  const sandbox = loadExtension(vscodeStub);
  initializePrivateStorage(sandbox, storage);
  vm.runInContext('outputChannel = { appendLine() {} };', sandbox);
  const saved = await sandbox.saveCapture({
    title: 'Two Sum', source: 'https://leetcode.com/problems/two-sum/', problemSlug: 'two-sum',
    language: 'Python3', description: '', samples: '', code: 'from_root_a = True\n'
  });
  const sameRelativePathInB = path.join(rootB, 'leetcode', 'Two Sum', 'solution.py');
  await fs.mkdir(path.dirname(sameRelativePathInB), { recursive: true });
  await fs.writeFile(sameRelativePathInB, 'from_root_b = True\n', 'utf8');

  vscodeStub.workspace.workspaceFolders = [folders[1], folders[0]];
  vscodeStub.workspace.rootPath = rootB;
  vscodeStub.window.activeTextEditor = {
    document: { uri: { scheme: 'file', fsPath: sameRelativePathInB }, getText: () => 'from_root_b = True\n' }
  };
  const localContext = await sandbox.activeProblemContext();
  assert.equal(localContext.localOnly, true);
  assert.equal(localContext.source, '');
  assert.notEqual(localContext.folder, saved.problemFolder);

  vscodeStub.window.activeTextEditor = {
    document: { uri: { scheme: 'file', fsPath: saved.solution }, getText: () => 'from_root_a = True\n' }
  };
  const context = await sandbox.activeProblemContext();
  assert.equal(context.solutionPath, saved.solution);
  assert.equal(context.code, 'from_root_a = True\n');
});

test('renaming the whole problem directory keeps its sidecar usable after restart', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-folder-rename-workspace-'));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-folder-rename-storage-'));
  temporaryFolders.push(root, storage);
  const vscodeStub = {
    workspace: {
      workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }], rootPath: root, textDocuments: [],
      getConfiguration: () => ({ get: (key) => key === 'outputDirectory' ? 'leetcode' : key === 'openSolutionAfterCapture' ? false : 27121 })
    },
    window: { showTextDocument: async () => {}, showWarningMessage: () => {} }
  };
  const sandbox = loadExtension(vscodeStub);
  initializePrivateStorage(sandbox, storage);
  vm.runInContext('outputChannel = { appendLine() {} };', sandbox);
  const saved = await sandbox.saveCapture({
    title: 'Two Sum', source: 'https://leetcode.com/problems/two-sum/', problemSlug: 'two-sum',
    language: 'Python3', description: '', samples: '', code: 'class Solution: pass\n'
  });
  const oldFolder = path.dirname(saved.solution);
  const newFolder = path.join(root, 'solutions');
  await fs.rename(oldFolder, newFolder);
  await sandbox.handleSolutionRenames({
    files: [{
      oldUri: { scheme: 'file', fsPath: oldFolder },
      newUri: { scheme: 'file', fsPath: newFolder }
    }]
  });

  const newSolution = path.join(newFolder, path.basename(saved.solution));
  const movedState = stateFolderFor(newFolder);
  const metadata = JSON.parse(await fs.readFile(path.join(movedState, 'metadata.json'), 'utf8'));
  assert.equal(metadata.solutionPath, undefined);
  assert.equal(metadata.solutionRelativePath, undefined);
  assert.equal(metadata.solutionFileName, 'solution.py');
  assert.deepEqual(await fs.readdir(path.join(root, 'leetcode')), []);
  const reloaded = loadExtension({
    workspace: {
      workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }], rootPath: root, textDocuments: [],
      getConfiguration: () => ({ get: () => undefined })
    },
    window: {
      activeTextEditor: {
        document: { uri: { scheme: 'file', fsPath: newSolution }, getText: () => 'class Solution: pass\n' }
      }
    }
  });
  reloaded.initializeProblemStorage();
  const context = await reloaded.activeProblemContext();
  assert.equal(context.solutionPath, newSolution);
  assert.equal(context.folder, movedState);
});

test('moving a problem directory during AI extraction unlocks the moved sidecar as interrupted', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-pending-folder-move-'));
  temporaryFolders.push(root);
  const vscodeStub = {
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }], rootPath: root, textDocuments: [],
      getConfiguration: () => ({ get: (key) => key === 'outputDirectory' ? 'leetcode' : key === 'openSolutionAfterCapture' ? false : key === 'ai.provider' ? 'glm' : '' })
    },
    window: { showTextDocument: async () => {}, showWarningMessage: () => {} }
  };
  const sandbox = loadExtension(vscodeStub);
  sandbox.injectedAiService = {
    async getConfiguredProviders() { return { glm: true, deepseek: false, qwen: false }; },
    async extractTestCases() { return { testCases: [], provider: 'glm', model: 'glm-5.2' }; }
  };
  vm.runInContext('aiTestcaseService = injectedAiService; outputChannel = { appendLine() {} };', sandbox);
  const payload = {
    title: 'Pending Move', source: 'https://leetcode.com/problems/pending-move/', problemSlug: 'pending-move',
    language: 'Python3', description: '', samples: '', code: 'class Solution: pass\n'
  };
  const saved = await sandbox.saveCapture(payload);
  const oldDirectory = path.dirname(saved.solution);
  const movedDirectory = path.join(root, 'Moved Pending Problem');
  await fs.rename(oldDirectory, movedDirectory);
  await sandbox.handleSolutionRenames({
    files: [{
      oldUri: { scheme: 'file', fsPath: oldDirectory },
      newUri: { scheme: 'file', fsPath: movedDirectory }
    }]
  });

  const movedState = stateFolderFor(movedDirectory);
  const movedSolution = path.join(movedDirectory, 'solution.py');
  const metadata = JSON.parse(await fs.readFile(path.join(movedState, 'metadata.json'), 'utf8'));
  assert.equal(metadata.testcaseExtraction.status, 'failed');
  assert.match(metadata.testcaseExtraction.message, /中断/);
  vscodeStub.window.activeTextEditor = {
    document: { uri: { scheme: 'file', fsPath: movedSolution }, getText: () => 'class Solution: pass\n' }
  };
  const state = await sandbox.sidebarState();
  assert.equal(state.problem.aiBusy, false);
  assert.equal(state.problem.scaffoldStatusKind, 'missing');
  const oldResult = await sandbox.processCapturedAi(payload, saved);
  assert.equal(oldResult.superseded, true);
});

test('moving a problem directory during scaffold generation interrupts and supersedes the old job', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-scaffold-folder-move-'));
  temporaryFolders.push(root);
  let signalGenerationStarted;
  let releaseGeneration;
  const generationStarted = new Promise((resolve) => { signalGenerationStarted = resolve; });
  const generationGate = new Promise((resolve) => { releaseGeneration = resolve; });
  const vscodeStub = {
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }], rootPath: root, textDocuments: [],
      getConfiguration: () => ({ get: (key) => key === 'outputDirectory' ? 'leetcode' : key === 'openSolutionAfterCapture' ? false : key === 'ai.provider' ? 'glm' : '' })
    },
    window: { showTextDocument: async () => {}, showWarningMessage: () => {} }
  };
  const sandbox = loadExtension(vscodeStub);
  sandbox.injectedAiService = {
    async getConfiguredProviders() { return { glm: true, deepseek: false, qwen: false }; },
    async extractTestCases() {
      return {
        testCases: [{ input: 'x = 1', expectedOutput: '1', evidence: 'Input: x = 1 Output: 1' }],
        provider: 'glm', model: 'glm-5.2'
      };
    },
    async generateScaffold() {
      signalGenerationStarted();
      await generationGate;
      return { content: '# generated after move\n', provider: 'glm', model: 'glm-5.2' };
    }
  };
  vm.runInContext('aiTestcaseService = injectedAiService; outputChannel = { appendLine() {} };', sandbox);
  const payload = {
    title: 'Scaffold Move', source: 'https://leetcode.com/problems/scaffold-move/', problemSlug: 'scaffold-move',
    language: 'Python3', description: '', samples: '', code: 'class Solution: pass\n'
  };
  const saved = await sandbox.saveCapture(payload);
  const processing = sandbox.processCapturedAi(payload, saved);
  await generationStarted;

  const oldDirectory = path.dirname(saved.solution);
  const movedDirectory = path.join(root, 'Moved During Scaffold');
  await fs.rename(oldDirectory, movedDirectory);
  await sandbox.handleSolutionRenames({
    files: [{
      oldUri: { scheme: 'file', fsPath: oldDirectory },
      newUri: { scheme: 'file', fsPath: movedDirectory }
    }]
  });

  const movedState = stateFolderFor(movedDirectory);
  const metadata = JSON.parse(await fs.readFile(path.join(movedState, 'metadata.json'), 'utf8'));
  assert.equal(metadata.testcaseExtraction.status, 'failed');
  assert.match(metadata.testcaseExtraction.message, /中断/);
  vscodeStub.window.activeTextEditor = {
    document: {
      uri: { scheme: 'file', fsPath: path.join(movedDirectory, 'solution.py') },
      getText: () => 'class Solution: pass\n'
    }
  };
  const state = await sandbox.sidebarState();
  assert.equal(state.problem.aiBusy, false);
  assert.equal(state.problem.scaffoldStatusKind, 'missing');

  releaseGeneration();
  const oldResult = await processing;
  assert.equal(oldResult.superseded, true);
  await assert.rejects(fs.access(path.join(movedDirectory, 'main.py')));
});

test('deleting solution during capture extraction cancels immediately and never applies the late AI result', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-delete-during-extraction-'));
  temporaryFolders.push(root);
  let signalExtractionStarted;
  let releaseExtraction;
  let receivedSignal;
  let scaffoldCalls = 0;
  const extractionStarted = new Promise((resolve) => { signalExtractionStarted = resolve; });
  const extractionGate = new Promise((resolve) => { releaseExtraction = resolve; });
  const vscodeStub = {
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }], rootPath: root, textDocuments: [],
      getConfiguration: () => ({ get: (key) => key === 'outputDirectory' ? 'leetcode' : key === 'openSolutionAfterCapture' ? false : key === 'ai.provider' ? 'glm' : '' })
    },
    window: { showTextDocument: async () => {}, showWarningMessage: () => {} }
  };
  const sandbox = loadExtension(vscodeStub);
  sandbox.injectedAiService = {
    async getConfiguredProviders() { return { glm: true, deepseek: false, qwen: false }; },
    async extractTestCases({ signal }) {
      receivedSignal = signal;
      signalExtractionStarted();
      return extractionGate;
    },
    async generateScaffold() {
      scaffoldCalls += 1;
      return { content: '# must not be written\n', provider: 'glm', model: 'glm-5.2' };
    }
  };
  vm.runInContext('aiTestcaseService = injectedAiService; outputChannel = { appendLine() {} };', sandbox);
  const payload = {
    title: 'Delete During Extraction', source: 'https://leetcode.com/problems/delete-during-extraction/',
    problemSlug: 'delete-during-extraction', language: 'Python3', description: '', samples: '',
    code: 'class Solution: pass\n'
  };
  const saved = await sandbox.saveCapture(payload);
  const processing = sandbox.processCapturedAi(payload, saved);
  await extractionStarted;

  await fs.unlink(saved.solution);
  const deletion = sandbox.handleProblemDeletes({
    files: [{ scheme: 'file', fsPath: saved.solution }]
  });
  assert.equal(sandbox.captureJobActiveForFolder(saved.problemFolder), false);
  assert.equal(receivedSignal.aborted, true);
  const result = await settleWithoutReleasingProvider(
    processing,
    'capture extraction remained blocked after solution deletion'
  );
  assert.equal(result.superseded, true);
  await deletion;

  const metadata = JSON.parse(await fs.readFile(path.join(saved.problemFolder, 'metadata.json'), 'utf8'));
  assert.equal(metadata.testcaseExtraction.status, 'failed');
  assert.match(metadata.testcaseExtraction.message, /被删除/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(saved.problemFolder, 'testcases.json'), 'utf8')).testCases, []);
  assert.equal(scaffoldCalls, 0);
  await assert.rejects(fs.access(saved.solution));
  await assert.rejects(fs.access(path.join(path.dirname(saved.solution), 'main.py')));

  releaseExtraction({
    testCases: [{ input: 'late = true', expectedOutput: 'late', evidence: 'late' }],
    provider: 'glm', model: 'glm-5.2'
  });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(fs.access(saved.solution));
  await assert.rejects(fs.access(path.join(path.dirname(saved.solution), 'main.py')));
});

test('deleting tracked files during capture scaffold generation never revives them or writes main', async (t) => {
  const targets = ['solution', 'main', 'metadata', 'testcases', 'state', 'problem'];
  for (const target of targets) {
    await t.test(target, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), `leetcode-cph-delete-${target}-during-scaffold-`));
      temporaryFolders.push(root);
      let signalGenerationStarted;
      let releaseGeneration;
      let receivedSignal;
      const generationStarted = new Promise((resolve) => { signalGenerationStarted = resolve; });
      const generationGate = new Promise((resolve) => { releaseGeneration = resolve; });
      const vscodeStub = {
        workspace: {
          isTrusted: true,
          workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }], rootPath: root, textDocuments: [],
          getConfiguration: () => ({ get: (key) => key === 'outputDirectory' ? 'leetcode' : key === 'openSolutionAfterCapture' ? false : key === 'ai.provider' ? 'glm' : '' })
        },
        window: { showTextDocument: async () => {}, showWarningMessage: () => {} }
      };
      const sandbox = loadExtension(vscodeStub);
      sandbox.injectedAiService = {
        async getConfiguredProviders() { return { glm: true, deepseek: false, qwen: false }; },
        async extractTestCases() {
          return {
            testCases: [{ input: 'x = 1', expectedOutput: '1', evidence: 'Input: x = 1 Output: 1' }],
            provider: 'glm', model: 'glm-5.2'
          };
        },
        async generateScaffold({ signal }) {
          receivedSignal = signal;
          signalGenerationStarted();
          return generationGate;
        }
      };
      vm.runInContext('aiTestcaseService = injectedAiService; outputChannel = { appendLine() {} };', sandbox);
      const payload = {
        title: `Delete ${target}`, source: `https://leetcode.com/problems/delete-${target}/`,
        problemSlug: `delete-${target}`, language: 'Python3', description: '', samples: '',
        code: 'class Solution: pass\n'
      };
      const saved = await sandbox.saveCapture(payload);
      const problemDirectory = path.dirname(saved.solution);
      const mainPath = path.join(problemDirectory, 'main.py');
      if (target === 'main') await fs.writeFile(mainPath, '# existing main\n', 'utf8');
      vscodeStub.window.activeTextEditor = {
        document: { uri: { scheme: 'file', fsPath: saved.solution }, getText: () => payload.code }
      };
      const processing = sandbox.processCapturedAi(payload, saved);
      await generationStarted;

      const deletedPath = target === 'solution' ? saved.solution
        : target === 'main' ? mainPath
          : target === 'metadata' ? path.join(saved.problemFolder, 'metadata.json')
            : target === 'testcases' ? path.join(saved.problemFolder, 'testcases.json')
              : target === 'state' ? saved.problemFolder : problemDirectory;
      await fs.rm(deletedPath, { recursive: target === 'state' || target === 'problem', force: true });
      const deletion = sandbox.handleProblemDeletes({
        files: [{ scheme: 'file', fsPath: deletedPath }]
      });
      assert.equal(sandbox.captureJobActiveForFolder(saved.problemFolder), false);
      assert.equal(receivedSignal.aborted, true);
      const result = await settleWithoutReleasingProvider(
        processing,
        `scaffold generation remained blocked after deleting ${target}`
      );
      assert.equal(result.superseded, true);
      await deletion;

      if (target === 'testcases') {
        const state = await sandbox.sidebarState();
        assert.equal(state.problem.aiBusy, false);
        assert.equal(state.problem.scaffoldReady, false);
      }
      await assert.rejects(fs.access(deletedPath));
      await assert.rejects(fs.access(mainPath));
      await assert.rejects(fs.access(path.join(saved.problemFolder, 'backups')));

      releaseGeneration({ content: '# late generated main\n', provider: 'glm', model: 'glm-5.2' });
      await new Promise((resolve) => setImmediate(resolve));
      await assert.rejects(fs.access(deletedPath));
      await assert.rejects(fs.access(mainPath));
    });
  }
});

test('deleting an unrelated sibling file does not cancel capture extraction', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-unrelated-delete-'));
  temporaryFolders.push(root);
  let signalExtractionStarted;
  let releaseExtraction;
  let receivedSignal;
  const extractionStarted = new Promise((resolve) => { signalExtractionStarted = resolve; });
  const extractionGate = new Promise((resolve) => { releaseExtraction = resolve; });
  const vscodeStub = {
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }], rootPath: root, textDocuments: [],
      getConfiguration: () => ({ get: (key) => key === 'outputDirectory' ? 'leetcode' : key === 'openSolutionAfterCapture' ? false : key === 'ai.provider' ? 'glm' : '' })
    },
    window: { showTextDocument: async () => {}, showWarningMessage: () => {} }
  };
  const sandbox = loadExtension(vscodeStub);
  sandbox.injectedAiService = {
    async getConfiguredProviders() { return { glm: true, deepseek: false, qwen: false }; },
    async extractTestCases({ signal }) {
      receivedSignal = signal;
      signalExtractionStarted();
      return extractionGate;
    }
  };
  vm.runInContext('aiTestcaseService = injectedAiService; outputChannel = { appendLine() {} };', sandbox);
  const payload = {
    title: 'Unrelated Delete', source: 'https://leetcode.com/problems/unrelated-delete/',
    language: 'Python3', code: 'class Solution: pass\n'
  };
  const saved = await sandbox.saveCapture(payload);
  const processing = sandbox.processCapturedAi(payload, saved);
  await extractionStarted;
  const readmePath = path.join(path.dirname(saved.solution), 'README.md');
  await fs.writeFile(readmePath, 'notes\n', 'utf8');
  await fs.unlink(readmePath);
  const cancelled = await sandbox.handleProblemDeletes({ files: [{ scheme: 'file', fsPath: readmePath }] });
  assert.equal(cancelled.length, 0);
  assert.equal(receivedSignal.aborted, false);
  assert.equal(sandbox.captureJobActiveForFolder(saved.problemFolder), true);

  releaseExtraction({ testCases: [], provider: 'glm', model: 'glm-5.2' });
  const result = await processing;
  assert.equal(result.superseded, undefined);
  assert.equal(sandbox.captureJobActiveForFolder(saved.problemFolder), false);
});

test('snapshot revalidation rejects an external testcase deletion even without a VS Code delete event', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-external-delete-'));
  temporaryFolders.push(root);
  let signalGenerationStarted;
  let releaseGeneration;
  const generationStarted = new Promise((resolve) => { signalGenerationStarted = resolve; });
  const generationGate = new Promise((resolve) => { releaseGeneration = resolve; });
  const vscodeStub = {
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }], rootPath: root, textDocuments: [],
      getConfiguration: () => ({ get: (key) => key === 'outputDirectory' ? 'leetcode' : key === 'openSolutionAfterCapture' ? false : key === 'ai.provider' ? 'glm' : '' })
    },
    window: { showTextDocument: async () => {}, showWarningMessage: () => {} }
  };
  const sandbox = loadExtension(vscodeStub);
  sandbox.injectedAiService = {
    async getConfiguredProviders() { return { glm: true, deepseek: false, qwen: false }; },
    async extractTestCases() {
      return {
        testCases: [{ input: 'x = 1', expectedOutput: '1', evidence: 'Input: x = 1 Output: 1' }],
        provider: 'glm', model: 'glm-5.2'
      };
    },
    async generateScaffold() {
      signalGenerationStarted();
      return generationGate;
    }
  };
  vm.runInContext('aiTestcaseService = injectedAiService; outputChannel = { appendLine() {} };', sandbox);
  const payload = {
    title: 'External Delete', source: 'https://leetcode.com/problems/external-delete/',
    language: 'Python3', code: 'class Solution: pass\n'
  };
  const saved = await sandbox.saveCapture(payload);
  const processing = sandbox.processCapturedAi(payload, saved);
  await generationStarted;
  const testCasesPath = path.join(saved.problemFolder, 'testcases.json');
  await fs.unlink(testCasesPath);
  releaseGeneration({ content: '# stale generated main\n', provider: 'glm', model: 'glm-5.2' });
  await assert.rejects(processing, (error) => error?.code === 'LEETCODE_CPH_AI_INPUT_INVALIDATED');
  await assert.rejects(fs.access(testCasesPath));
  await assert.rejects(fs.access(path.join(path.dirname(saved.solution), 'main.py')));
});

test('snapshot revalidation rejects external metadata modification during scaffold generation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-external-metadata-mutate-'));
  temporaryFolders.push(root);
  let signalGenerationStarted;
  let releaseGeneration;
  const generationStarted = new Promise((resolve) => { signalGenerationStarted = resolve; });
  const generationGate = new Promise((resolve) => { releaseGeneration = resolve; });
  const vscodeStub = {
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }],
      rootPath: root,
      textDocuments: [],
      getConfiguration: () => ({ get: (key) => key === 'outputDirectory' ? 'leetcode' : key === 'openSolutionAfterCapture' ? false : key === 'ai.provider' ? 'glm' : '' })
    },
    window: { showTextDocument: async () => {} }
  };
  const sandbox = loadExtension(vscodeStub);
  sandbox.injectedAiService = {
    async getConfiguredProviders() { return { glm: true, deepseek: false, qwen: false }; },
    async generateScaffold() {
      signalGenerationStarted();
      return generationGate;
    }
  };
  vm.runInContext('aiTestcaseService = injectedAiService; outputChannel = { appendLine() {} };', sandbox);

  const folder = path.join(root, 'leetcode', 'Revalidate Metadata');
  const stateFolder = stateFolderFor(folder);
  const solutionPath = path.join(folder, 'solution.py');
  const mainPath = path.join(folder, 'main.py');
  await fs.mkdir(stateFolder, { recursive: true });
  await fs.mkdir(folder, { recursive: true });
  await Promise.all([
    fs.writeFile(solutionPath, 'class Solution: pass\n', 'utf8'),
    fs.writeFile(mainPath, '# existing main\n', 'utf8'),
    fs.writeFile(path.join(stateFolder, 'testcases.json'), JSON.stringify({
      version: 3,
      testCases: [{
        id: 'manual-1', name: 'testcase 001', input: 'x = 1', expectedOutput: '1', source: 'manual', createdAt: '2026-09-03T00:00:00.000Z'
      }],
      excludedAiIds: [],
      excludedLeetCodeIds: []
    }), 'utf8'),
    fs.writeFile(path.join(stateFolder, 'metadata.json'), JSON.stringify(registeredMetadata({
      title: 'Revalidate Metadata', source: 'https://leetcode.com/problems/revalidate-metadata/', language: 'Python3',
      solutionFileName: 'solution.py', testcaseScaffoldStale: false
    }), null, 2), 'utf8')
  ]);
  vscodeStub.window.activeTextEditor = {
    document: {
      uri: { scheme: 'file', fsPath: solutionPath },
      getText: () => 'class Solution: pass\n'
    }
  };
  const metadataPath = path.join(stateFolder, 'metadata.json');
  const processing = sandbox.generateTestScaffold({
    folder: stateFolder,
    solutionPath,
    code: 'class Solution: pass\n',
    metadata: {
      title: 'Revalidate Metadata',
      source: 'https://leetcode.com/problems/revalidate-metadata/',
      language: 'Python3',
      solutionFileName: 'solution.py',
      testcaseScaffoldStale: false
    },
    testCases: [{
      id: 'manual-1', name: 'testcase 001', input: 'x = 1', expectedOutput: '1', source: 'manual', createdAt: '2026-09-03T00:00:00.000Z'
    }]
  }, [{ id: 'manual-1', name: 'testcase 001', input: 'x = 1', expectedOutput: '1', source: 'manual', createdAt: '2026-09-03T00:00:00.000Z' }], {
    type: 'update'
  });
  await generationStarted;

  const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
  await fs.writeFile(metadataPath, JSON.stringify({ ...metadata, mark: 'mutated-outside' }, null, 2), 'utf8');
  releaseGeneration({ content: '# generated main\n', provider: 'glm', model: 'glm-5.2' });
  await assert.rejects(processing, (error) => error?.code === 'LEETCODE_CPH_AI_INPUT_INVALIDATED');
  assert.equal(await fs.readFile(mainPath, 'utf8'), '# existing main\n');
  assert.ok((await fs.readFile(metadataPath, 'utf8')).includes('mutated-outside'));
  await assert.rejects(fs.access(path.join(stateFolder, 'backups')), { code: 'ENOENT' });
});

test('deleting main cancels an explicit scaffold regeneration and releases sidebar busy state immediately', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-delete-during-regenerate-'));
  temporaryFolders.push(root);
  let regenerationMode = false;
  let signalGenerationStarted;
  let releaseGeneration;
  let receivedSignal;
  const generationStarted = new Promise((resolve) => { signalGenerationStarted = resolve; });
  const generationGate = new Promise((resolve) => { releaseGeneration = resolve; });
  const vscodeStub = {
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }], rootPath: root, textDocuments: [],
      getConfiguration: () => ({ get: (key) => key === 'outputDirectory' ? 'leetcode' : key === 'openSolutionAfterCapture' ? false : key === 'ai.provider' ? 'glm' : '' })
    },
    window: { showTextDocument: async () => {}, showWarningMessage: () => {} }
  };
  const sandbox = loadExtension(vscodeStub);
  sandbox.injectedAiService = {
    async getConfiguredProviders() { return { glm: true, deepseek: false, qwen: false }; },
    async extractTestCases() {
      return {
        testCases: [{ input: 'x = 1', expectedOutput: '1', evidence: 'Input: x = 1 Output: 1' }],
        provider: 'glm', model: 'glm-5.2'
      };
    },
    async generateScaffold({ signal }) {
      if (!regenerationMode) {
        return { content: '# initial main\n', provider: 'glm', model: 'glm-5.2' };
      }
      receivedSignal = signal;
      signalGenerationStarted();
      return generationGate;
    }
  };
  vm.runInContext('aiTestcaseService = injectedAiService; outputChannel = { appendLine() {} };', sandbox);
  const payload = {
    title: 'Delete During Regenerate', source: 'https://leetcode.com/problems/delete-during-regenerate/',
    language: 'Python3', code: 'class Solution: pass\n'
  };
  const saved = await sandbox.saveCapture(payload);
  await sandbox.processCapturedAi(payload, saved);
  const mainPath = path.join(path.dirname(saved.solution), 'main.py');
  assert.equal(await fs.readFile(mainPath, 'utf8'), '# initial main\n');
  vscodeStub.window.activeTextEditor = {
    document: { uri: { scheme: 'file', fsPath: saved.solution }, isDirty: false, getText: () => payload.code }
  };

  regenerationMode = true;
  const action = sandbox.runSidebarAction(
    'AI 正在重新编写 main 测试代码…',
    () => sandbox.regenerateTestScaffold(),
    '已重新编写测试脚手架。',
    { testcaseMutation: true }
  );
  await generationStarted;
  await fs.unlink(mainPath);
  const deletion = sandbox.handleProblemDeletes({ files: [{ scheme: 'file', fsPath: mainPath }] });
  sandbox.testFolderKey = sandbox.pathKey(saved.problemFolder);
  assert.equal(vm.runInContext('activeTestcaseAiJobs.has(testFolderKey)', sandbox), false);
  assert.equal(receivedSignal.aborted, true);
  await settleWithoutReleasingProvider(
    action,
    'explicit regenerate action remained blocked after main deletion'
  );
  await deletion;
  const actionState = sandbox.runtimeStateFor(null);
  assert.equal(actionState.busy, false);
  assert.equal(actionState.testcaseMutationBusy, false);
  assert.match(actionState.error, /被删除/);
  await assert.rejects(fs.access(mainPath));

  releaseGeneration({ content: '# late regenerated main\n', provider: 'glm', model: 'glm-5.2' });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(fs.access(mainPath));
});

test('a delayed directory rename event cannot fail a newer capture at the destination', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-delayed-folder-move-'));
  temporaryFolders.push(root);
  const vscodeStub = {
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }], rootPath: root, textDocuments: [],
      getConfiguration: () => ({ get: (key) => key === 'outputDirectory' ? 'leetcode' : key === 'openSolutionAfterCapture' ? false : key === 'ai.provider' ? 'glm' : '' })
    },
    window: { showTextDocument: async () => {}, showWarningMessage: () => {} }
  };
  const sandbox = loadExtension(vscodeStub);
  sandbox.injectedAiService = {
    async getConfiguredProviders() { return { glm: true, deepseek: false, qwen: false }; },
    async extractTestCases() { return { testCases: [], provider: 'glm', model: 'glm-5.2' }; }
  };
  vm.runInContext('aiTestcaseService = injectedAiService; outputChannel = { appendLine() {} };', sandbox);
  const oldPayload = {
    title: 'A', source: 'https://leetcode.com/problems/a/', language: 'Python3', code: 'old = True\n'
  };
  const oldCapture = await sandbox.saveCapture(oldPayload);
  const oldDirectory = path.dirname(oldCapture.solution);
  const destinationDirectory = path.join(root, 'leetcode', 'B');
  await fs.rename(oldDirectory, destinationDirectory);
  const newPayload = {
    title: 'B', source: 'https://leetcode.com/problems/b/', language: 'Python3', code: 'new = True\n'
  };
  const newCapture = await sandbox.saveCapture(newPayload);

  await sandbox.handleSolutionRenames({
    files: [{
      oldUri: { scheme: 'file', fsPath: oldDirectory },
      newUri: { scheme: 'file', fsPath: destinationDirectory }
    }]
  });
  let metadata = JSON.parse(await fs.readFile(path.join(newCapture.problemFolder, 'metadata.json'), 'utf8'));
  assert.equal(metadata.captureRevision, newCapture.captureRevision);
  assert.equal(metadata.testcaseExtraction.status, 'pending');

  await sandbox.processCapturedAi(newPayload, newCapture);
  metadata = JSON.parse(await fs.readFile(path.join(newCapture.problemFolder, 'metadata.json'), 'utf8'));
  assert.equal(metadata.captureRevision, newCapture.captureRevision);
  assert.equal(metadata.testcaseExtraction.status, 'empty');
  await assert.rejects(sandbox.processCapturedAi(oldPayload, oldCapture));
});

test('a delayed rename event cannot redirect a newer capture to the old renamed code', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-rename-capture-race-workspace-'));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-rename-capture-race-storage-'));
  temporaryFolders.push(root, storage);
  const vscodeStub = {
    workspace: {
      workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }], rootPath: root, textDocuments: [],
      getConfiguration: () => ({ get: (key) => key === 'outputDirectory' ? 'leetcode' : key === 'openSolutionAfterCapture' ? false : 27121 })
    },
    window: { showTextDocument: async () => {}, showWarningMessage: () => {} }
  };
  const sandbox = loadExtension(vscodeStub);
  initializePrivateStorage(sandbox, storage);
  vm.runInContext('outputChannel = { appendLine() {} };', sandbox);
  const payload = {
    title: 'Two Sum', source: 'https://leetcode.com/problems/two-sum/', problemSlug: 'two-sum',
    language: 'Python3', description: '', samples: '', code: 'old_browser_code = True\n'
  };
  const first = await sandbox.saveCapture(payload);
  const renamedSolution = path.join(path.dirname(first.solution), 'Renamed Two Sum.py');
  await fs.rename(first.solution, renamedSolution);

  // The user captures again before the asynchronous VS Code rename callback
  // runs. This intentionally recreates the registered original filename.
  const second = await sandbox.saveCapture({ ...payload, code: 'new_browser_code = True\n' });
  await sandbox.handleSolutionRenames({
    files: [{
      oldUri: { scheme: 'file', fsPath: first.solution },
      newUri: { scheme: 'file', fsPath: renamedSolution }
    }]
  });

  const metadata = JSON.parse(await fs.readFile(path.join(second.problemFolder, 'metadata.json'), 'utf8'));
  assert.equal(metadata.solutionPath, undefined);
  assert.equal(metadata.solutionFileName, path.basename(second.solution));
  assert.equal(await fs.readFile(second.solution, 'utf8'), 'new_browser_code = True\n');
  assert.equal(await fs.readFile(renamedSolution, 'utf8'), 'old_browser_code = True\n');
});

test('renaming a solution to the reserved main filename never associates or overwrites it', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-reserved-main-rename-workspace-'));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-reserved-main-rename-storage-'));
  temporaryFolders.push(root, storage);
  const warnings = [];
  const vscodeStub = {
    workspace: {
      workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }], rootPath: root, textDocuments: [],
      getConfiguration: () => ({ get: (key) => key === 'outputDirectory' ? 'leetcode' : key === 'openSolutionAfterCapture' ? false : 27121 })
    },
    window: {
      showTextDocument: async () => {},
      showWarningMessage: (message) => { warnings.push(message); }
    }
  };
  const sandbox = loadExtension(vscodeStub);
  initializePrivateStorage(sandbox, storage);
  vm.runInContext('outputChannel = { appendLine() {} };', sandbox);
  const saved = await sandbox.saveCapture({
    title: 'Reserved Rename', source: 'https://leetcode.com/problems/reserved-rename/', problemSlug: 'reserved-rename',
    language: 'Python3', description: '', samples: '', code: 'user_answer = True\n'
  });
  const mainPath = path.join(path.dirname(saved.solution), 'main.py');
  await fs.rm(mainPath, { force: true });
  await fs.rename(saved.solution, mainPath);
  await sandbox.handleSolutionRenames({
    files: [{
      oldUri: { scheme: 'file', fsPath: saved.solution },
      newUri: { scheme: 'file', fsPath: mainPath }
    }]
  });

  const metadata = JSON.parse(await fs.readFile(path.join(saved.problemFolder, 'metadata.json'), 'utf8'));
  assert.equal(metadata.solutionPath, undefined);
  assert.equal(metadata.solutionFileName, path.basename(saved.solution));
  assert.equal(await fs.readFile(mainPath, 'utf8'), 'user_answer = True\n');
  assert.ok(warnings.some((message) => message.includes('保留名称')));
  await assert.rejects(
    sandbox.generateTestScaffold({
      folder: saved.problemFolder,
      solutionPath: mainPath,
      metadata: { title: 'Reserved Rename', source: 'https://leetcode.com/problems/reserved-rename/' },
      code: 'user_answer = True\n'
    }, [{ id: 'manual-1', name: 'testcase 001', input: 'x = 1', expectedOutput: '1' }], { type: 'regenerate' }),
    /已拒绝覆盖/
  );
  assert.equal(await fs.readFile(mainPath, 'utf8'), 'user_answer = True\n');
});

test('background AI generation keeps canonical solution and main resolvable after restart', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-ai-rename-workspace-'));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-ai-rename-storage-'));
  temporaryFolders.push(root, storage);
  let generationMetadata;
  let generationCode;
  const vscodeStub = {
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }], rootPath: root, textDocuments: [],
      getConfiguration: () => ({ get: (key) => key === 'outputDirectory' ? 'leetcode' : key === 'openSolutionAfterCapture' ? false : key === 'ai.provider' ? 'glm' : '' })
    },
    window: { showTextDocument: async () => {}, showWarningMessage: () => {} }
  };
  const sandbox = loadExtension(vscodeStub);
  initializePrivateStorage(sandbox, storage);
  sandbox.injectedAiService = {
    async getConfiguredProviders() { return { glm: true, deepseek: false, qwen: false }; },
    async extractTestCases() { return { testCases: [], provider: 'glm', model: 'glm-5.2' }; },
    async generateScaffold({ metadata, solutionCode }) {
      generationMetadata = metadata;
      generationCode = solutionCode;
      return { content: '# generated scaffold\n', provider: 'glm', model: 'glm-5.2' };
    }
  };
  vm.runInContext('aiTestcaseService = injectedAiService; outputChannel = { appendLine() {} };', sandbox);
  const payload = {
    title: 'Two Sum', source: 'https://leetcode.com/problems/two-sum/', problemSlug: 'two-sum',
    language: 'Python3', description: '', samples: '', code: 'renamed_solution = True\n'
  };
  const saved = await sandbox.saveCapture(payload);
  await fs.writeFile(path.join(saved.problemFolder, 'testcases.json'), JSON.stringify({
    version: 3,
    testCases: [{
      id: 'manual-1', name: 'testcase 001', input: 'x = 1', expectedOutput: '1',
      source: 'manual', createdAt: '2026-09-02T00:00:00.000Z'
    }],
    excludedAiIds: [], excludedLeetCodeIds: []
  }), 'utf8');
  const processed = await sandbox.processCapturedAi(payload, saved);
  assert.equal(processed.scaffoldGenerated, true);
  assert.equal(generationMetadata.solutionFileName, 'solution.py');
  assert.equal(generationCode, payload.code);
  const mainPath = path.join(path.dirname(saved.solution), 'main.py');
  assert.equal(await fs.readFile(mainPath, 'utf8'), '# generated scaffold\n');

  // A fresh extension host has no cache. Opening main must still resolve the
  // canonical solution solely from the sibling workspace sidecar.
  const reloaded = loadExtension({
    workspace: {
      workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }], rootPath: root, textDocuments: [],
      getConfiguration: () => ({ get: () => undefined })
    },
    window: {
      activeTextEditor: { document: { uri: { scheme: 'file', fsPath: mainPath }, getText: () => '# generated after rename\n' } }
    }
  });
  initializePrivateStorage(reloaded, storage);
  const reloadedContext = await reloaded.activeProblemContext();
  assert.equal(reloadedContext.solutionPath, saved.solution);
  assert.equal(reloadedContext.folder, saved.problemFolder);

  // Opening the solution itself must also work after a restart. The
  // previous host's cache is deliberately absent in this sandbox.
  const reloadedFromSolution = loadExtension({
    workspace: {
      workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }], rootPath: root, textDocuments: [],
      getConfiguration: () => ({ get: () => undefined })
    },
    window: {
      activeTextEditor: { document: { uri: { scheme: 'file', fsPath: saved.solution }, getText: () => payload.code } }
    }
  });
  initializePrivateStorage(reloadedFromSolution, storage);
  const solutionContext = await reloadedFromSolution.activeProblemContext();
  assert.equal(solutionContext.solutionPath, saved.solution);
  assert.equal(solutionContext.folder, saved.problemFolder);
});

test('re-capturing rejects a dirty local solution without changing any file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-dirty-workspace-'));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-dirty-storage-'));
  temporaryFolders.push(root, storage);
  const solutionPath = path.join(root, 'leetcode', '1. Two Sum', 'solution.py');
  const originalSolution = 'disk_solution = True\n';
  const textDocuments = [];
  const vscodeStub = {
    workspace: {
      workspaceFolders: [{ uri: { fsPath: root } }],
      rootPath: root,
      textDocuments,
      getConfiguration: () => ({ get: (key) => key === 'outputDirectory' ? 'leetcode' : key === 'openSolutionAfterCapture' ? false : 27121 })
    },
    window: { showTextDocument: async () => {} }
  };
  const sandbox = loadExtension(vscodeStub);
  initializePrivateStorage(sandbox, storage);
  vm.runInContext('outputChannel = { appendLine() {} };', sandbox);
  const payload = {
    title: '1. Two Sum', source: 'https://leetcode.com/problems/two-sum/', problemSlug: 'two-sum',
    language: 'Python3', description: 'Example', samples: '', code: originalSolution
  };
  const initial = await sandbox.saveCapture(payload);
  const metadataPath = path.join(initial.problemFolder, 'metadata.json');
  const originalMetadata = await fs.readFile(metadataPath, 'utf8');
  const originalTestCases = await fs.readFile(path.join(initial.problemFolder, 'testcases.json'), 'utf8');
  textDocuments.push({
    uri: { scheme: 'file', fsPath: solutionPath },
    isDirty: true,
    getText: () => 'unsaved_local_solution = True\n'
  });

  await assert.rejects(
    sandbox.saveCapture({ ...payload, code: 'browser_code = True\n' }),
    /尚未保存的修改/
  );

  assert.equal(await fs.readFile(solutionPath, 'utf8'), originalSolution);
  assert.equal(await fs.readFile(metadataPath, 'utf8'), originalMetadata);
  assert.equal(await fs.readFile(path.join(initial.problemFolder, 'testcases.json'), 'utf8'), originalTestCases);
  await assert.rejects(fs.access(path.join(initial.problemFolder, 'solution.py.bak')), { code: 'ENOENT' });
  assert.deepEqual((await fs.readdir(path.dirname(solutionPath))).sort(), ['.leetcode_cph', 'solution.py']);
});

test('AI scaffold replacement preserves the prior saved scaffold as a backup', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-scaffold-backup-'));
  temporaryFolders.push(folder);
  const stateFolder = stateFolderFor(folder);
  const solutionPath = path.join(folder, 'solution.py');
  const scaffoldPath = path.join(folder, 'main.py');
  const oldScaffold = "# manually adjusted scaffold\nprint('old')\n";
  const newScaffold = "# generated scaffold\nprint('new')\n";
  await fs.mkdir(stateFolder, { recursive: true });
  await Promise.all([
    fs.writeFile(solutionPath, 'class Solution: pass\n', 'utf8'),
    fs.writeFile(scaffoldPath, oldScaffold, 'utf8'),
    fs.writeFile(path.join(stateFolder, 'testcases.json'), JSON.stringify({
      version: 3,
      testCases: [{ id: 'manual-1', name: 'testcase 001', input: 'n = 1', expectedOutput: '1', source: 'manual' }],
      excludedAiIds: [], excludedLeetCodeIds: []
    }), 'utf8'),
    fs.writeFile(path.join(stateFolder, 'metadata.json'), JSON.stringify(registeredMetadata({
      title: '1. Two Sum', source: 'https://leetcode.com/problems/two-sum/', language: 'Python3',
      solutionFileName: 'solution.py', testcaseScaffoldStale: true
    })), 'utf8')
  ]);
  const vscodeStub = {
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: { scheme: 'file', fsPath: folder } }],
      rootPath: folder,
      textDocuments: [],
      getConfiguration: () => ({ get: (key) => key === 'ai.provider' ? 'glm' : '' })
    },
    window: {}
  };
  const sandbox = loadExtension(vscodeStub);
  sandbox.injectedAiService = {
    async getConfiguredProviders() { return { glm: true, deepseek: false, qwen: false }; },
    async generateScaffold() { return { content: newScaffold, provider: 'glm', model: 'glm-5.2' }; }
  };
  vm.runInContext('aiTestcaseService = injectedAiService; outputChannel = { appendLine() {} };', sandbox);

  const result = await sandbox.generateTestScaffold({
    folder: stateFolder,
    solutionPath,
    code: 'class Solution: pass\n',
    metadata: {
      title: '1. Two Sum', source: 'https://leetcode.com/problems/two-sum/', language: 'Python3', testcaseScaffoldStale: true
    }
  }, [{ id: 'manual-1', name: 'testcase 001', input: 'n = 1', expectedOutput: '1', source: 'manual' }], { type: 'update' });

  assert.equal(result.destination, scaffoldPath);
  assert.equal(path.basename(result.backup), 'main.py');
  assert.equal(path.dirname(path.dirname(result.backup)), path.join(stateFolder, 'backups'));
  assert.equal(await fs.readFile(scaffoldPath, 'utf8'), newScaffold);
  assert.equal(await fs.readFile(result.backup, 'utf8'), oldScaffold);
  const metadata = JSON.parse(await fs.readFile(path.join(stateFolder, 'metadata.json'), 'utf8'));
  assert.equal(metadata.testcaseScaffoldStale, false);
});

test('AI generation never overwrites main when it changes while the model request is in flight', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-main-race-'));
  temporaryFolders.push(folder);
  const stateFolder = stateFolderFor(folder);
  const solutionPath = path.join(folder, 'solution.py');
  const mainPath = path.join(folder, 'main.py');
  await fs.mkdir(stateFolder, { recursive: true });
  await Promise.all([
    fs.writeFile(solutionPath, 'class Solution: pass\n', 'utf8'),
    fs.writeFile(mainPath, '# old main\n', 'utf8'),
    fs.writeFile(path.join(stateFolder, 'testcases.json'), JSON.stringify({
      version: 3,
      testCases: [{ id: 'one', name: 'testcase 001', input: '1', expectedOutput: '1', source: 'manual' }],
      excludedAiIds: [], excludedLeetCodeIds: []
    }), 'utf8'),
    fs.writeFile(path.join(stateFolder, 'metadata.json'), JSON.stringify(registeredMetadata({
      title: 'Race', source: 'https://leetcode.com/problems/race/', language: 'Python3',
      solutionFileName: 'solution.py', testcaseScaffoldStale: true
    })), 'utf8')
  ]);
  const sandbox = loadExtension({
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: { scheme: 'file', fsPath: folder } }],
      rootPath: folder,
      textDocuments: [],
      getConfiguration: () => ({ get: (key) => key === 'ai.provider' ? 'glm' : '' })
    },
    window: {}
  });
  sandbox.injectedAiService = {
    async getConfiguredProviders() { return { glm: true, deepseek: false, qwen: false }; },
    async generateScaffold() {
      await fs.writeFile(mainPath, '# newer local main\n', 'utf8');
      return { content: '# stale AI response\n', provider: 'glm', model: 'glm-5.2' };
    }
  };
  vm.runInContext('aiTestcaseService = injectedAiService; outputChannel = { appendLine() {} };', sandbox);

  await assert.rejects(sandbox.generateTestScaffold({
    folder: stateFolder,
    solutionPath,
    code: 'class Solution: pass\n',
    metadata: { title: 'Race', source: 'https://leetcode.com/problems/race/', language: 'Python3', testcaseScaffoldStale: true }
  }, [{ id: 'one', name: 'testcase 001', input: '1', expectedOutput: '1', source: 'manual' }], { type: 'update' }), /main\.py 已发生变化/);
  assert.equal(await fs.readFile(mainPath, 'utf8'), '# newer local main\n');
  await assert.rejects(fs.access(path.join(stateFolder, 'main.py.bak')), { code: 'ENOENT' });
});

test('a manual blank case is saved without an API key without invoking AI or making the scaffold stale', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-manual-no-key-'));
  temporaryFolders.push(folder);
  const stateFolder = stateFolderFor(folder);
  const solutionPath = path.join(folder, 'solution.py');
  await fs.mkdir(stateFolder, { recursive: true });
  await Promise.all([
    fs.writeFile(solutionPath, 'class Solution: pass\n', 'utf8'),
    fs.writeFile(path.join(stateFolder, 'metadata.json'), JSON.stringify(registeredMetadata({
      title: '1. Two Sum', source: 'https://leetcode.com/problems/two-sum/', language: 'Python3',
      solutionFileName: 'solution.py'
    })), 'utf8')
  ]);
  const vscodeStub = {
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: { scheme: 'file', fsPath: folder } }],
      rootPath: folder,
      textDocuments: [],
      getConfiguration: () => ({ get: (key) => key === 'ai.provider' ? 'glm' : '' })
    },
    window: {
      activeTextEditor: { document: { uri: { scheme: 'file', fsPath: solutionPath }, getText: () => 'class Solution: pass\n' } }
    }
  };
  const sandbox = loadExtension(vscodeStub);
  let generateCalls = 0;
  sandbox.injectedAiService = {
    async getConfiguredProviders() { return { glm: false, deepseek: false, qwen: false }; },
    async generateScaffold() { generateCalls += 1; throw new Error('AI must not run for a blank draft'); }
  };
  vm.runInContext('aiTestcaseService = injectedAiService; outputChannel = { appendLine() {} };', sandbox);

  const added = await sandbox.mutateTestCaseAndScaffold('add', {});
  assert.equal(added.generated, null);
  assert.equal(added.draftCreated, true);
  assert.equal(generateCalls, 0);
  const stored = JSON.parse(await fs.readFile(path.join(stateFolder, 'testcases.json'), 'utf8'));
  assert.deepEqual(stored.testCases.map((testCase) => ({ source: testCase.source, input: testCase.input, expectedOutput: testCase.expectedOutput })), [
    { source: 'manual', input: '', expectedOutput: '' }
  ]);
  const metadata = JSON.parse(await fs.readFile(path.join(stateFolder, 'metadata.json'), 'utf8'));
  assert.notEqual(metadata.testcaseScaffoldStale, true);
  assert.equal(metadata.testcaseScaffoldError, undefined);
});

test('blank add waits for first save, later edits are save-only, and delete regenerates the scaffold', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-manual-mutation-sequence-'));
  temporaryFolders.push(folder);
  const stateFolder = stateFolderFor(folder);
  const solutionPath = path.join(folder, 'solution.py');
  const mainPath = path.join(folder, 'main.py');
  await fs.mkdir(stateFolder, { recursive: true });
  await Promise.all([
    fs.writeFile(solutionPath, 'class Solution: pass\n', 'utf8'),
    fs.writeFile(mainPath, '# original main\n', 'utf8'),
    fs.writeFile(path.join(stateFolder, 'metadata.json'), JSON.stringify(registeredMetadata({
      title: 'Mutation Sequence',
      source: 'https://leetcode.com/problems/mutation-sequence/',
      language: 'Python3',
      solutionFileName: 'solution.py',
      testcaseScaffoldStale: false
    })), 'utf8')
  ]);
  const vscodeStub = {
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: { scheme: 'file', fsPath: folder } }],
      rootPath: folder,
      textDocuments: [],
      getConfiguration: () => ({ get: (key) => key === 'ai.provider' ? 'glm' : '' })
    },
    window: {
      activeTextEditor: {
        document: { uri: { scheme: 'file', fsPath: solutionPath }, getText: () => 'class Solution: pass\n' }
      }
    }
  };
  const sandbox = loadExtension(vscodeStub);
  const generationRequests = [];
  sandbox.injectedAiService = {
    async getConfiguredProviders() { return { glm: true, deepseek: false, qwen: false }; },
    async generateScaffold(request) {
      generationRequests.push(request);
      return {
        content: `# generated for ${request.operation.type}\n`,
        provider: 'glm',
        model: 'glm-5.2'
      };
    }
  };
  vm.runInContext('aiTestcaseService = injectedAiService; outputChannel = { appendLine() {} };', sandbox);

  await assert.rejects(
    sandbox.mutateTestCaseAndScaffold('add', { problemKey: 'stale-sidebar-problem' }),
    /已切换到另一道题/
  );
  assert.equal(generationRequests.length, 0);

  const added = await sandbox.mutateTestCaseAndScaffold('add', {
    input: 'this payload must be ignored',
    expectedOutput: 'this payload must be ignored'
  });
  assert.equal(added.testCase.input, '');
  assert.equal(added.testCase.expectedOutput, '');
  assert.equal(added.generated, null);
  assert.equal(generationRequests.length, 0);
  assert.equal(await fs.readFile(mainPath, 'utf8'), '# original main\n');

  const firstSave = await sandbox.mutateTestCaseAndScaffold('update', {
    id: added.testCase.id,
    input: 'x = 1',
    expectedOutput: '1'
  });
  assert.equal(firstSave.completedNewCase, true);
  assert.equal(generationRequests.length, 1);
  assert.equal(generationRequests[0].operation.type, 'add');
  assert.equal(generationRequests[0].operation.testCase.id, added.testCase.id);
  assert.equal(await fs.readFile(mainPath, 'utf8'), '# generated for add\n');

  const laterEdit = await sandbox.mutateTestCaseAndScaffold('update', {
    id: added.testCase.id,
    input: 'x = 2',
    expectedOutput: '2'
  });
  assert.equal(laterEdit.generated, null);
  assert.equal(laterEdit.scaffoldMayNeedRewrite, true);
  assert.equal(generationRequests.length, 1);
  assert.equal(await fs.readFile(mainPath, 'utf8'), '# generated for add\n');
  let metadata = JSON.parse(await fs.readFile(path.join(stateFolder, 'metadata.json'), 'utf8'));
  assert.equal(metadata.testcaseScaffoldStale, false);
  const persistedAfterEdit = JSON.parse(await fs.readFile(path.join(stateFolder, 'testcases.json'), 'utf8'));
  assert.equal(persistedAfterEdit.testCases[0].input, 'x = 2');
  assert.equal(persistedAfterEdit.testCases[0].expectedOutput, '2');
  assert.equal(persistedAfterEdit.testCases[0].pendingScaffold, false);

  const clearedEdit = await sandbox.mutateTestCaseAndScaffold('update', {
    id: added.testCase.id,
    input: '',
    expectedOutput: ''
  });
  assert.equal(clearedEdit.scaffoldMayNeedRewrite, true);
  const refilledEdit = await sandbox.mutateTestCaseAndScaffold('update', {
    id: added.testCase.id,
    input: 'x = 3',
    expectedOutput: '3'
  });
  assert.equal(refilledEdit.completedNewCase, false, 'refilling a cleared existing case is still an edit');
  assert.equal(refilledEdit.scaffoldMayNeedRewrite, true);
  assert.equal(generationRequests.length, 1, 'later edits must not call AI even after temporarily clearing the case');

  const deleted = await sandbox.mutateTestCaseAndScaffold('delete', { id: added.testCase.id });
  assert.equal(deleted.testCases.length, 0);
  assert.equal(generationRequests.length, 2);
  assert.equal(generationRequests[1].operation.type, 'delete');
  assert.equal(generationRequests[1].operation.testCase.id, added.testCase.id);
  assert.equal(await fs.readFile(mainPath, 'utf8'), '# generated for delete\n');
  metadata = JSON.parse(await fs.readFile(path.join(stateFolder, 'metadata.json'), 'utf8'));
  assert.equal(metadata.testcaseScaffoldStale, false);
});

test('a first-save metadata failure leaves the empty draft unchanged and does not call AI', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-first-save-stale-failure-'));
  temporaryFolders.push(folder);
  const stateFolder = stateFolderFor(folder);
  const solutionPath = path.join(folder, 'solution.py');
  const metadataPath = path.join(stateFolder, 'metadata.json');
  await fs.mkdir(stateFolder, { recursive: true });
  await Promise.all([
    fs.writeFile(solutionPath, 'class Solution: pass\n', 'utf8'),
    fs.writeFile(path.join(folder, 'main.py'), '# existing main\n', 'utf8'),
    fs.writeFile(metadataPath, JSON.stringify(registeredMetadata({
      title: 'Atomic First Save',
      source: 'https://leetcode.com/problems/atomic-first-save/',
      language: 'Python3',
      solutionFileName: 'solution.py',
      testcaseScaffoldStale: false
    })), 'utf8')
  ]);

  let failNextMetadataRename = false;
  const failingFs = Object.create(fs);
  failingFs.rename = async (from, to) => {
    if (failNextMetadataRename && path.resolve(String(to)) === path.resolve(metadataPath)) {
      failNextMetadataRename = false;
      const error = new Error('injected stale metadata failure');
      error.code = 'EIO';
      throw error;
    }
    return fs.rename(from, to);
  };
  const vscodeStub = {
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: { scheme: 'file', fsPath: folder } }],
      rootPath: folder,
      textDocuments: [],
      getConfiguration: () => ({ get: (key) => key === 'ai.provider' ? 'glm' : '' })
    },
    window: {
      activeTextEditor: {
        document: { uri: { scheme: 'file', fsPath: solutionPath }, getText: () => 'class Solution: pass\n' }
      }
    }
  };
  const sandbox = loadExtension(vscodeStub, { fsPromises: failingFs });
  let aiCalls = 0;
  sandbox.injectedAiService = {
    async getConfiguredProviders() { return { glm: true, deepseek: false, qwen: false }; },
    async generateScaffold() { aiCalls += 1; return { content: '# should not be written\n', provider: 'glm', model: 'glm-5.2' }; }
  };
  vm.runInContext('aiTestcaseService = injectedAiService; outputChannel = { appendLine() {} };', sandbox);

  const added = await sandbox.mutateTestCaseAndScaffold('add', {});
  failNextMetadataRename = true;
  await assert.rejects(
    sandbox.mutateTestCaseAndScaffold('update', {
      id: added.testCase.id,
      input: 'x = 1',
      expectedOutput: '1'
    }),
    /injected stale metadata failure/
  );

  const state = JSON.parse(await fs.readFile(path.join(stateFolder, 'testcases.json'), 'utf8'));
  assert.equal(state.testCases.length, 1);
  assert.equal(state.testCases[0].input, '');
  assert.equal(state.testCases[0].expectedOutput, '');
  assert.equal(state.testCases[0].pendingScaffold, true);
  const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
  assert.equal(metadata.testcaseScaffoldStale, false);
  assert.equal(aiCalls, 0);
});

test('an unlinked solution supports manual cases but never AI, execution, or URL-less sync', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-local-only-workspace-'));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-local-only-storage-'));
  temporaryFolders.push(root, storage);
  const problemDirectory = path.join(root, 'leetcode', 'Local Problem');
  const solutionPath = path.join(problemDirectory, 'solution.py');
  await fs.mkdir(problemDirectory, { recursive: true });
  await fs.writeFile(solutionPath, 'class Solution: pass\n', 'utf8');
  const vscodeStub = {
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }],
      rootPath: root,
      textDocuments: [],
      getConfiguration: () => ({ get: () => undefined })
    },
    window: {
      activeTextEditor: {
        document: { uri: { scheme: 'file', fsPath: solutionPath }, getText: () => 'class Solution: pass\n' }
      },
      setStatusBarMessage() {}
    }
  };
  const sandbox = loadExtension(vscodeStub);
  initializePrivateStorage(sandbox, storage);
  vm.runInContext('outputChannel = { appendLine() {} };', sandbox);

  const initial = await sandbox.activeProblemContext();
  assert.equal(initial.localOnly, true);
  assert.equal(initial.source, '');
  const state = await sandbox.sidebarState();
  assert.equal(state.problem.localOnly, true);
  assert.equal(state.problem.canSync, false);
  assert.equal(state.problem.scaffoldReady, false);
  assert.equal(state.problem.scaffoldStatus, '测试脚手架未生成');
  assert.equal(state.problem.scaffoldStatusKind, 'missing');

  const added = await sandbox.mutateTestCaseAndScaffold('add', {});
  assert.equal(added.localOnly, true);
  assert.equal(added.testCase.input, '');
  const localMetadata = JSON.parse(await fs.readFile(path.join(stateFolderFor(problemDirectory), 'metadata.json'), 'utf8'));
  assert.equal(localMetadata.storageSchemaVersion, 3);
  assert.equal(localMetadata.storageLayout, 'workspace-sidecar');
  assert.equal(localMetadata.localOnly, true);
  assert.equal(localMetadata.source, undefined);
  assert.equal(localMetadata.solutionFileName, 'solution.py');
  const updated = await sandbox.mutateTestCaseAndScaffold('update', {
    id: added.testCase.id,
    input: 'x = 1',
    expectedOutput: '1'
  });
  assert.equal(updated.testCase.input, 'x = 1');
  const deleted = await sandbox.mutateTestCaseAndScaffold('delete', { id: added.testCase.id });
  assert.equal(deleted.testCases.length, 0);

  let browserApplyCalls = 0;
  sandbox.requestBrowserApply = async () => { browserApplyCalls += 1; return {}; };
  await assert.rejects(sandbox.syncActiveSolution(), /没有对应的 LeetCode URL/);
  assert.equal(browserApplyCalls, 0);
  await assert.rejects(sandbox.runTestsFromSidebar('all'), /没有有效的 \.leetcode_cph 题目记录/);
  await assert.rejects(sandbox.extractTestCasesForContext(initial), /不能使用 AI/);
  await assert.rejects(sandbox.generateTestScaffold(initial, [], { type: 'initialize' }), /不能生成 main/);
  await assert.rejects(fs.access(path.join(problemDirectory, 'main.py')), { code: 'ENOENT' });

  const linked = await sandbox.saveCapture({
    title: 'Local Problem',
    source: 'https://leetcode.com/problems/local-problem/',
    problemSlug: 'local-problem',
    language: 'C++',
    description: '',
    samples: '',
    code: 'class Solution {};\n'
  });
  assert.equal(linked.solution, path.join(problemDirectory, 'solution.cpp'));
  assert.equal(await fs.readFile(linked.solution, 'utf8'), 'class Solution {};\n');
  await assert.rejects(fs.access(solutionPath), { code: 'ENOENT' });
  const linkedMetadata = JSON.parse(await fs.readFile(path.join(linked.problemFolder, 'metadata.json'), 'utf8'));
  assert.equal(linkedMetadata.localOnly, undefined);
  assert.equal(linkedMetadata.source, 'https://leetcode.com/problems/local-problem/');
  assert.ok(linked.overwrittenRecordBackup);
});

test('an extra solution file cannot reuse or mutate another linked solution sidecar', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-sidecar-owner-workspace-'));
  temporaryFolders.push(root);
  const problemDirectory = path.join(root, 'leetcode', 'Owned Problem');
  const stateFolder = stateFolderFor(problemDirectory);
  const registeredSolution = path.join(problemDirectory, 'solution.py');
  const unrelatedSolution = path.join(problemDirectory, 'solution.js');
  await fs.mkdir(stateFolder, { recursive: true });
  const originalCases = {
    version: 2,
    testCases: [{ id: 'manual-1', name: 'testcase 001', input: 'x = 1', expectedOutput: '1', source: 'manual' }],
    excludedAiIds: [],
    excludedLeetCodeIds: []
  };
  await Promise.all([
    fs.writeFile(registeredSolution, 'class Solution: pass\n', 'utf8'),
    fs.writeFile(unrelatedSolution, 'module.exports = {};\n', 'utf8'),
    fs.writeFile(path.join(stateFolder, 'metadata.json'), JSON.stringify(registeredMetadata({
      title: 'Owned Problem',
      source: 'https://leetcode.com/problems/owned-problem/',
      language: 'Python3',
      solutionFileName: 'solution.py'
    })), 'utf8'),
    fs.writeFile(path.join(stateFolder, 'testcases.json'), JSON.stringify(originalCases), 'utf8')
  ]);
  const sandbox = loadExtension({
    workspace: {
      workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }],
      rootPath: root,
      textDocuments: [],
      getConfiguration: () => ({ get: () => undefined })
    },
    window: {
      activeTextEditor: {
        document: { uri: { scheme: 'file', fsPath: unrelatedSolution }, getText: () => 'module.exports = {};\n' }
      }
    }
  });

  await assert.rejects(sandbox.activeProblemContext(), /属于另一份解答|拒绝修改/);
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(stateFolder, 'testcases.json'), 'utf8')),
    originalCases
  );
});

test('an unlinked solution with an unknown language suffix is rejected before creating sidecar state', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-unknown-local-language-'));
  temporaryFolders.push(root);
  const problemDirectory = path.join(root, 'Unknown Language');
  const solutionPath = path.join(problemDirectory, 'solution.dart');
  await fs.mkdir(problemDirectory, { recursive: true });
  await fs.writeFile(solutionPath, 'class Solution {}\n', 'utf8');
  const sandbox = loadExtension({
    workspace: {
      workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }],
      rootPath: root,
      textDocuments: [],
      getConfiguration: () => ({ get: () => undefined })
    },
    window: {
      activeTextEditor: {
        document: { uri: { scheme: 'file', fsPath: solutionPath }, getText: () => 'class Solution {}\n' }
      }
    }
  });

  await assert.rejects(sandbox.activeProblemContext(), /不支持.*solution\.dart/);
  await assert.rejects(fs.access(stateFolderFor(problemDirectory)), { code: 'ENOENT' });
});

test('run failures are reported without confirmation or AI rewriting, while explicit regeneration remains available', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-no-auto-repair-workspace-'));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-no-auto-repair-storage-'));
  temporaryFolders.push(root, storage);
  const runner = require('../vscode-extension/testcase-runner');
  let runnerMode = 'compile';
  let runtimeSolutionPath = '';
  let warningCalls = 0;
  const outputLines = [];
  const textDocuments = [];
  const vscodeStub = {
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }],
      rootPath: root,
      textDocuments,
      getConfiguration: () => ({ get: (key) => key === 'outputDirectory' ? 'leetcode' : key === 'openSolutionAfterCapture' ? false : key === 'ai.provider' ? 'glm' : '' })
    },
    window: {
      showTextDocument: async () => {},
      showWarningMessage: async () => {
        warningCalls += 1;
        throw new Error('running tests must not ask for scaffold review');
      }
    },
    Uri: { file: (value) => ({ scheme: 'file', fsPath: value }) }
  };
  const compileFailure = Object.assign(
    new Error('main 编译失败（退出码 1）。 main.py:7: invalid syntax'),
    { code: 'COMPILE_FAILED', exitCode: 1, stdout: '', stderr: 'main.py:7: invalid syntax' }
  );
  const sandbox = loadExtension(vscodeStub, {
    testcaseRunner: {
      ...runner,
      runAllTestCases: async () => {
        if (runnerMode === 'change-success') {
          await fs.writeFile(runtimeSolutionPath, 'class Solution: changed during run\n', 'utf8');
          return {
            ok: true,
            results: { 'testcase 001': { name: 'testcase 001', actual: 1, passed: true } },
            stdout: '', stderr: '', error: '', exitCode: 0, signal: null
          };
        }
        if (runnerMode === 'change-error') {
          await fs.writeFile(runtimeSolutionPath, 'class Solution: changed before failure\n', 'utf8');
          throw compileFailure;
        }
        if (runnerMode === 'compile') throw compileFailure;
        if (runnerMode === 'runtime') {
          return {
            ok: false,
            results: { 'testcase 001': { name: 'testcase 001', actual: 0, passed: false } },
            stdout: '',
            stderr: 'runtime stack trace',
            error: '测试脚手架运行失败（退出码 1）。 runtime stack trace',
            exitCode: 1,
            signal: null
          };
        }
        return {
          ok: true,
          results: {
            'testcase 001': { name: 'testcase 001', actual: null, error: 'TypeError: adapter invocation failed' }
          },
          stdout: '',
          stderr: 'adapter stack trace',
          error: '',
          exitCode: 0,
          signal: null
        };
      }
    }
  });
  initializePrivateStorage(sandbox, storage);
  sandbox.injectedOutputChannel = { appendLine: (line) => outputLines.push(String(line)) };
  vm.runInContext('outputChannel = injectedOutputChannel;', sandbox);
  const saved = await sandbox.saveCapture({
    title: 'No Auto Repair', source: 'https://leetcode.com/problems/no-auto-repair/', problemSlug: 'no-auto-repair',
    language: 'Python3', description: '', samples: '', code: 'class Solution: pass\n'
  });
  runtimeSolutionPath = saved.solution;
  const oldMain = "# broken main\nprint('__LEETCODE_CPH_RESULT__')\n";
  const regeneratedMain = "# explicitly regenerated main\nprint('__LEETCODE_CPH_RESULT__')\n";
  const mainPath = path.join(path.dirname(saved.solution), 'main.py');
  await fs.writeFile(mainPath, oldMain, 'utf8');
  await fs.writeFile(path.join(saved.problemFolder, 'testcases.json'), JSON.stringify({
    version: 3,
    testCases: [{
      id: 'manual-1', name: 'testcase 001', input: 'x = 1', expectedOutput: '1',
      source: 'manual', createdAt: '2026-09-02T00:00:00.000Z'
    }],
    excludedAiIds: [], excludedLeetCodeIds: []
  }), 'utf8');
  const metadataPath = path.join(saved.problemFolder, 'metadata.json');
  const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
  await fs.writeFile(metadataPath, JSON.stringify({
    ...metadata,
    testcaseScaffoldStale: false,
    testcaseExtraction: { status: 'extracted' }
  }), 'utf8');
  const solutionDocument = {
    uri: { scheme: 'file', fsPath: saved.solution },
    isDirty: false,
    getText: () => 'class Solution: pass\n'
  };
  textDocuments.push(solutionDocument);
  vscodeStub.window.activeTextEditor = { document: solutionDocument };

  let aiCalls = 0;
  let regenerationRequest;
  sandbox.injectedAiService = {
    async getConfiguredProviders() { return { glm: true, deepseek: false, qwen: false }; },
    async generateScaffold(request) {
      aiCalls += 1;
      regenerationRequest = request;
      return { content: regeneratedMain, provider: 'glm', model: 'glm-5.2' };
    }
  };
  vm.runInContext('aiTestcaseService = injectedAiService;', sandbox);

  const compileState = await sandbox.runSidebarTests('all');
  assert.match(compileState.error, /invalid syntax/);
  assert.equal(aiCalls, 0);
  assert.equal(warningCalls, 0);
  assert.equal(await fs.readFile(mainPath, 'utf8'), oldMain);

  runnerMode = 'runtime';
  const runtimeState = await sandbox.runSidebarTests('all');
  assert.match(runtimeState.error, /runtime stack trace/);
  assert.equal(runtimeState.testResults['manual-1'].actualOutput, '0');
  assert.equal(aiCalls, 0);
  assert.equal(warningCalls, 0);
  assert.equal(await fs.readFile(mainPath, 'utf8'), oldMain);

  runnerMode = 'protocol';
  const protocolState = await sandbox.runSidebarTests('all');
  assert.match(protocolState.error, /adapter invocation failed/);
  assert.equal(protocolState.testResults['manual-1'].actualOutput, 'null');
  assert.equal(protocolState.testResults['manual-1'].status, 'error');
  assert.equal(aiCalls, 0);
  assert.equal(warningCalls, 0);
  assert.equal(await fs.readFile(mainPath, 'utf8'), oldMain);
  assert.ok(outputLines.some((line) => line.includes('adapter stack trace')));

  runnerMode = 'change-success';
  const changedDuringSuccess = await sandbox.runSidebarTests('all');
  assert.match(changedDuringSuccess.error, /运行期间 solution 或 main 已发生变化/);
  assert.deepEqual(Object.keys(changedDuringSuccess.testResults), []);
  assert.equal(aiCalls, 0);
  await fs.writeFile(saved.solution, 'class Solution: pass\n', 'utf8');

  runnerMode = 'change-error';
  const changedDuringFailure = await sandbox.runSidebarTests('all');
  assert.match(changedDuringFailure.error, /运行期间 solution 或 main 已发生变化/);
  assert.deepEqual(Object.keys(changedDuringFailure.testResults), []);
  assert.equal(aiCalls, 0);
  await fs.writeFile(saved.solution, 'class Solution: pass\n', 'utf8');

  const regenerated = await sandbox.regenerateTestScaffold();
  assert.equal(aiCalls, 1);
  assert.equal(regenerationRequest.operation.type, 'regenerate');
  assert.equal(regenerated.generated.destination, mainPath);
  assert.equal(await fs.readFile(mainPath, 'utf8'), regeneratedMain);
  assert.equal(await fs.readFile(regenerated.generated.backup, 'utf8'), oldMain);
  assert.equal(path.basename(regenerated.generated.backup), 'main.py');
  assert.equal(path.dirname(path.dirname(regenerated.generated.backup)), path.join(saved.problemFolder, 'backups'));
});

test('recapture clears old cases and tombstones before persisting all three newly extracted AI examples', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-three-example-recapture-workspace-'));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-three-example-recapture-storage-'));
  temporaryFolders.push(root, storage);
  const extractedCases = [
    {
      input: 'tokens = ["2","1","+","3","*"]',
      expectedOutput: '9',
      evidence: '输入：tokens = ["2","1","+","3","*"]\n输出：9'
    },
    {
      input: 'tokens = ["4","13","5","/","+"]',
      expectedOutput: '6',
      evidence: '输入：tokens = ["4","13","5","/","+"]\n输出：6'
    },
    {
      input: 'tokens = ["10","6","9","3","+","-11","*","/","*","17","+","5","+"]',
      expectedOutput: '22',
      evidence: '输入：tokens = ["10","6","9","3","+","-11","*","/","*","17","+","5","+"]\n输出：22'
    }
  ];
  const payload = {
    title: '150. 逆波兰表达式求值',
    source: 'https://leetcode.cn/problems/evaluate-reverse-polish-notation/',
    problemId: '150',
    problemSlug: 'evaluate-reverse-polish-notation',
    language: 'C++',
    description: extractedCases.map((testCase) => testCase.evidence).join('\n\n'),
    samples: extractedCases.map((testCase) => testCase.evidence).join('\n\n'),
    code: 'class Solution { public: int evalRPN(vector<string>& tokens) { return 0; } };\n'
  };
  let generationRequest;
  const vscodeStub = {
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }],
      rootPath: root,
      textDocuments: [],
      getConfiguration: () => ({
        get: (key) => key === 'outputDirectory' ? 'leetcode'
          : key === 'openSolutionAfterCapture' ? false
            : key === 'ai.provider' ? 'deepseek' : ''
      })
    },
    window: { showTextDocument: async () => {} }
  };
  const sandbox = loadExtension(vscodeStub);
  initializePrivateStorage(sandbox, storage);
  sandbox.injectedAiService = {
    async getConfiguredProviders() { return { glm: false, deepseek: true, qwen: false }; },
    async extractTestCases() {
      return { testCases: extractedCases, provider: 'deepseek', model: 'deepseek-v4-flash' };
    },
    async generateScaffold(request) {
      generationRequest = request;
      return { content: '// generated for three cases\n', provider: 'deepseek', model: 'deepseek-v4-flash' };
    }
  };
  vm.runInContext('aiTestcaseService = injectedAiService; outputChannel = { appendLine() {} };', sandbox);

  const initial = await sandbox.saveCapture(payload);
  const automaticCases = fromAiExtraction(payload, extractedCases, {
    now: () => '2026-09-03T00:00:00.000Z'
  });
  const oldManual = {
    id: 'manual-old', name: 'testcase 004', input: 'tokens = ["1"]', expectedOutput: '1',
    source: 'manual', createdAt: '2026-09-03T00:00:00.000Z'
  };
  await fs.writeFile(path.join(initial.problemFolder, 'testcases.json'), JSON.stringify({
    version: 3,
    testCases: [automaticCases[1], automaticCases[2], oldManual],
    excludedAiIds: [automaticCases[0].id, automaticCases[0].aiContentId],
    excludedLeetCodeIds: ['legacy-deletion']
  }), 'utf8');
  await fs.writeFile(path.join(path.dirname(initial.solution), 'main.cpp'), '// old scaffold\n', 'utf8');

  const recaptured = await sandbox.saveCapture(payload);
  const pendingState = JSON.parse(await fs.readFile(path.join(recaptured.problemFolder, 'testcases.json'), 'utf8'));
  assert.deepEqual(pendingState.testCases, [], 'a browser recapture replaces the entire prior testcase record');
  assert.deepEqual(pendingState.excludedAiIds, []);
  assert.deepEqual(pendingState.excludedLeetCodeIds, []);
  const pendingMetadata = JSON.parse(await fs.readFile(path.join(recaptured.problemFolder, 'metadata.json'), 'utf8'));
  assert.equal(pendingMetadata.testcaseExtraction.status, 'pending');
  await assert.rejects(fs.access(path.join(path.dirname(recaptured.solution), 'main.cpp')), { code: 'ENOENT' });

  const backupNames = await fs.readdir(path.join(recaptured.problemFolder, 'backups'));
  assert.equal(backupNames.length, 1);
  const backedState = JSON.parse(await fs.readFile(
    path.join(recaptured.problemFolder, 'backups', backupNames[0], 'record-testcases.json'),
    'utf8'
  ));
  assert.equal(backedState.testCases.length, 3);
  assert.deepEqual(backedState.excludedAiIds, [automaticCases[0].id, automaticCases[0].aiContentId]);

  const processed = await sandbox.processCapturedAi(payload, recaptured);
  const persistedState = JSON.parse(await fs.readFile(path.join(recaptured.problemFolder, 'testcases.json'), 'utf8'));
  assert.equal(persistedState.testCases.length, 3);
  assert.deepEqual(persistedState.testCases.map((testCase) => testCase.source), ['ai', 'ai', 'ai']);
  assert.deepEqual(persistedState.testCases.map((testCase) => testCase.expectedOutput), ['9', '6', '22']);
  assert.ok(persistedState.testCases.some((testCase) => testCase.id === automaticCases[0].id));
  assert.deepEqual(persistedState.excludedAiIds, []);
  const completedMetadata = JSON.parse(await fs.readFile(path.join(recaptured.problemFolder, 'metadata.json'), 'utf8'));
  assert.equal(completedMetadata.testcaseExtraction.count, 3);
  assert.equal(completedMetadata.testcaseExtraction.message, 'AI 已从题面提取 3 个测试用例。');
  assert.equal(processed.extraction.count, 3);
  assert.equal(processed.extraction.message, 'AI 已从题面提取 3 个测试用例。');
  assert.equal(generationRequest.testCases.length, 3);
});

test('capture defers remote AI extraction and scaffold generation until processCapturedAi', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-manual-workspace-'));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-manual-storage-'));
  temporaryFolders.push(root, storage);
  let extracted = 0;
  let generated = 0;
  const vscodeStub = {
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: { fsPath: root } }],
      rootPath: root,
      textDocuments: [],
      getConfiguration: () => ({ get: (key) => key === 'outputDirectory' ? 'leetcode' : key === 'openSolutionAfterCapture' ? false : key === 'ai.provider' ? 'glm' : '' })
    },
    window: { showTextDocument: async () => {} }
  };
  const sandbox = loadExtension(vscodeStub);
  initializePrivateStorage(sandbox, storage);
  sandbox.injectedAiService = {
    async getConfiguredProviders() { return { glm: true, deepseek: false, qwen: false }; },
    async extractTestCases() { extracted += 1; return { testCases: [], provider: 'glm', model: 'glm-5.2' }; },
    async generateScaffold() { generated += 1; return { content: '# generated manual scaffold\n', provider: 'glm', model: 'glm-5.2' }; }
  };
  vm.runInContext('aiTestcaseService = injectedAiService; outputChannel = { appendLine() {} };', sandbox);

  const saved = await sandbox.saveCapture({
    title: '1. Two Sum', source: 'https://leetcode.com/problems/two-sum/', problemId: '1',
    language: 'Python3', description: 'No explicit examples', samples: '', code: 'browser_code = True\n'
  });
  assert.equal(saved.aiPending, true);
  assert.equal(saved.extraction.status, 'pending');
  assert.equal(extracted, 0, 'saveCapture must not make the remote extraction request');
  assert.equal(generated, 0, 'saveCapture must not generate a scaffold');
  assert.equal(saved.problemFolder, stateFolderFor(path.dirname(saved.solution)));
  assert.deepEqual(await fs.readdir(path.join(root, 'leetcode')), ['1. Two Sum']);
  await assert.rejects(fs.access(path.join(saved.problemFolder, 'main.py')), { code: 'ENOENT' });
  vscodeStub.window.activeTextEditor = {
    document: { uri: { scheme: 'file', fsPath: saved.solution }, getText: () => 'browser_code = True\n' }
  };
  const interruptedState = await sandbox.sidebarState();
  assert.equal(interruptedState.problem.scaffoldStatus, '测试脚手架正在生成');
  assert.equal(interruptedState.problem.scaffoldStatusKind, 'generating');
  assert.equal(interruptedState.problem.scaffoldReady, false);

  // Simulate a manual case already persisted in the problem sidecar. An empty
  // extraction must still generate its sibling visible main file.
  await fs.writeFile(path.join(saved.problemFolder, 'testcases.json'), JSON.stringify({
    version: 3,
    testCases: [{
      id: 'manual-1', name: 'testcase 001', input: 'n = 1', expectedOutput: '1',
      source: 'manual', createdAt: '2026-09-02T00:00:00.000Z'
    }],
    excludedAiIds: [], excludedLeetCodeIds: []
  }), 'utf8');

  const processed = await sandbox.processCapturedAi({
    title: '1. Two Sum', source: 'https://leetcode.com/problems/two-sum/', problemId: '1',
    language: 'Python3', description: 'No explicit examples', samples: '', code: 'browser_code = True\n'
  }, saved);

  assert.equal(processed.scaffoldGenerated, true);
  assert.equal(extracted, 1);
  assert.equal(generated, 1);
  assert.equal(await fs.readFile(path.join(path.dirname(saved.solution), 'main.py'), 'utf8'), '# generated manual scaffold\n');
  await assert.rejects(fs.access(path.join(saved.problemFolder, 'main.py')), { code: 'ENOENT' });
});

test('an orphaned pending sidecar is repaired lazily instead of leaving controls permanently busy', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-orphan-pending-'));
  temporaryFolders.push(root);
  const problemDirectory = path.join(root, 'leetcode', 'Interrupted');
  const stateFolder = stateFolderFor(problemDirectory);
  const solutionPath = path.join(problemDirectory, 'solution.py');
  await fs.mkdir(stateFolder, { recursive: true });
  await Promise.all([
    fs.writeFile(solutionPath, 'class Solution: pass\n', 'utf8'),
    fs.writeFile(path.join(stateFolder, 'metadata.json'), JSON.stringify(registeredMetadata({
      title: 'Interrupted',
      source: 'https://leetcode.com/problems/interrupted/',
      language: 'Python3',
      solutionFileName: 'solution.py',
      captureRevision: 'orphaned-revision',
      testcaseExtraction: { status: 'pending', provider: 'glm', model: 'glm-5.2' }
    })), 'utf8'),
    fs.writeFile(path.join(stateFolder, 'testcases.json'), JSON.stringify({ version: 3, testCases: [] }), 'utf8')
  ]);
  const sandbox = loadExtension({
    workspace: {
      workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }],
      rootPath: root,
      textDocuments: [],
      getConfiguration: () => ({ get: (key) => key === 'ai.provider' ? 'glm' : '' })
    },
    window: {
      activeTextEditor: {
        document: { uri: { scheme: 'file', fsPath: solutionPath }, getText: () => 'class Solution: pass\n' }
      }
    }
  });
  sandbox.injectedAiService = {
    async getConfiguredProviders() { return { glm: true, deepseek: false, qwen: false }; }
  };
  vm.runInContext('aiTestcaseService = injectedAiService;', sandbox);

  const state = await sandbox.sidebarState();
  assert.equal(state.problem.aiBusy, false);
  assert.equal(state.problem.scaffoldStatusKind, 'missing');
  const metadata = JSON.parse(await fs.readFile(path.join(stateFolder, 'metadata.json'), 'utf8'));
  assert.equal(metadata.testcaseExtraction.status, 'failed');
  assert.match(metadata.testcaseExtraction.message, /中断/);
});
