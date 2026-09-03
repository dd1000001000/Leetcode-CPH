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

function initializePrivateStorage(sandbox, storagePath) {
  const initialized = sandbox.initializeExtensionStorage({ storageUri: { fsPath: storagePath } });
  assert.equal(initialized, path.resolve(storagePath));
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

test('sidebar problem scope changes when the same private record is recaptured', () => {
  const sandbox = loadExtension({ workspace: { textDocuments: [] }, window: {} });
  const folder = path.resolve('same-private-record');
  const first = sandbox.sidebarProblemKey({ folder, metadata: { captureRevision: 'revision-a' } });
  const second = sandbox.sidebarProblemKey({ folder, metadata: { captureRevision: 'revision-b' } });
  assert.notEqual(first, second);
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

test('sidebar keeps the problem context when testcase.* is active and uses an unsaved solution buffer', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-sidebar-context-'));
  temporaryFolders.push(folder);
  const solutionPath = path.join(folder, 'solution.py');
  const testcasePath = path.join(folder, 'testcase.py');
  await Promise.all([
    fs.writeFile(solutionPath, 'disk_solution = True\n', 'utf8'),
    fs.writeFile(testcasePath, '# generated test scaffold\n', 'utf8'),
    fs.writeFile(path.join(folder, 'metadata.json'), JSON.stringify({
      title: '1. Two Sum',
      source: 'https://leetcode.com/problems/two-sum/',
      language: 'Python3'
    }), 'utf8'),
    fs.writeFile(path.join(folder, 'testcases.json'), JSON.stringify({
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
  const solutionPath = path.join(folder, 'solution.js');
  await Promise.all([
    fs.writeFile(solutionPath, 'module.exports = {};\n', 'utf8'),
    fs.writeFile(path.join(folder, 'metadata.json'), JSON.stringify({
      title: '1. Two Sum',
      source: 'https://leetcode.com/problems/two-sum/',
      language: 'JavaScript'
    }), 'utf8'),
    fs.writeFile(path.join(folder, 'testcases.json'), JSON.stringify({
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

test('capture creates a title-named problem directory with solution and main while state stays private', async () => {
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
  assert.equal(first.problemFolder.startsWith(path.join(storage, 'problems')), true);
  assert.notEqual(first.problemFolder, path.dirname(solutionPath));

  const scaffoldPath = path.join(problemDirectory, 'main.py');
  await fs.writeFile(scaffoldPath, '# scaffold for the old solution\n', 'utf8');
  textDocuments.push({
    uri: { scheme: 'file', fsPath: solutionPath },
    isDirty: false,
    getText: () => 'disk_solution = True\n'
  });
  const saved = await sandbox.saveCapture({ ...payload, code: 'browser_code = True\n' });

  assert.equal(saved.solutionCreated, false);
  assert.equal(saved.solutionBackup, path.join(saved.problemFolder, 'solution.py.bak'));
  assert.equal(saved.scaffoldStale, true);
  assert.equal(await fs.readFile(solutionPath, 'utf8'), 'browser_code = True\n');
  assert.equal(await fs.readFile(saved.solutionBackup, 'utf8'), 'disk_solution = True\n');
  assert.deepEqual(await fs.readdir(outputFolder), ['1. Two Sum']);
  assert.deepEqual((await fs.readdir(problemDirectory)).sort(), ['main.py', 'solution.py']);

  const privateEntries = (await fs.readdir(saved.problemFolder)).sort();
  assert.deepEqual(privateEntries, ['metadata.json', 'solution.py.bak', 'testcases.json']);
  const metadata = JSON.parse(await fs.readFile(path.join(saved.problemFolder, 'metadata.json'), 'utf8'));
  assert.equal(metadata.code, 'browser_code = True\n');
  assert.equal(metadata.solutionPath, solutionPath);
  assert.equal(metadata.solutionFileName, 'solution.py');
  assert.equal(metadata.mainFileName, 'main.py');
  assert.equal(metadata.testcaseScaffoldStale, true);

  // A new extension-host instance has an empty in-memory cache, so this proves
  // the visible solution can be resolved by scanning private metadata.
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
  initializePrivateStorage(reloaded, storage);
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
  assert.deepEqual((await fs.readdir(path.dirname(saved.solution))).sort(), ['main.js', 'solution.js']);
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
  assert.equal(second.solutionBackup, '');
  assert.equal(
    await fs.readFile(second.overwrittenSolutionBackup, 'utf8'),
    'alpha local latest = True\n'
  );
  assert.equal(path.dirname(second.overwrittenSolutionBackup), second.overwrittenRecordBackup);
  await assert.rejects(fs.access(path.join(second.problemFolder, 'solution.py.bak')), { code: 'ENOENT' });

  // Simulate a directory scan that completed late and tried to resurrect the
  // now-archived alpha owner in the in-memory cache. The next collision must
  // validate the hint, discard it, and archive the real beta owner.
  sandbox.staleCollisionOwner = { solution: first.solution, folder: first.problemFolder };
  vm.runInContext(
    'solutionRecordCache.set(pathKey(staleCollisionOwner.solution), staleCollisionOwner.folder);',
    sandbox
  );

  const recaptured = await sandbox.saveCapture({
    ...common, source: 'https://leetcode.cn/problems/alpha-problem/', problemSlug: 'alpha-problem', code: 'alpha = 2\n'
  });

  assert.equal(path.basename(first.solution), 'solution.py');
  assert.equal(recaptured.solution, first.solution);
  assert.equal(recaptured.problemFolder, first.problemFolder);
  assert.notEqual(second.problemFolder, first.problemFolder);
  assert.equal(await fs.readFile(first.solution, 'utf8'), 'alpha = 2\n');
  const alphaMetadata = JSON.parse(await fs.readFile(path.join(recaptured.problemFolder, 'metadata.json'), 'utf8'));
  assert.equal(alphaMetadata.source, 'https://leetcode.cn/problems/alpha-problem/');
  assert.deepEqual(await fs.readdir(path.join(root, 'leetcode')), ['Same Name']);
  assert.equal((await fs.readdir(path.join(storage, 'overwritten'))).length, 2);
  assert.deepEqual(await fs.readdir(path.join(storage, 'problems')), [path.basename(recaptured.problemFolder)]);
});

test('a failed same-title replacement restores the outgoing file and private owner', async () => {
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
  assert.deepEqual(await fs.readdir(path.join(storage, 'overwritten')), []);
  vscodeStub.window.activeTextEditor = {
    document: { uri: { scheme: 'file', fsPath: first.solution }, getText: () => 'alpha local = 2\n' }
  };
  assert.equal((await sandbox.activeProblemContext()).source, ownerMetadata.source);
});

test('concurrent same-title captures commit in arrival order without losing a private folder', async () => {
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
  assert.deepEqual(await fs.readdir(path.join(storage, 'problems')), [path.basename(beta.problemFolder)]);
});

test('capturing a legacy problem copies its generated state privately without deleting old files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-legacy-migration-workspace-'));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-legacy-migration-storage-'));
  temporaryFolders.push(root, storage);
  const legacy = path.join(root, 'leetcode', '1-two-sum');
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
  assert.equal(await fs.readFile(path.join(saved.problemFolder, 'solution.py.legacy.bak'), 'utf8'), 'old_local = True\n');
  assert.equal(await fs.readFile(path.join(saved.problemFolder, 'main.py.legacy.bak'), 'utf8'), '# old private scaffold\n');
  await assert.rejects(fs.access(path.join(path.dirname(saved.solution), 'main.py')), { code: 'ENOENT' });
  const migratedCases = JSON.parse(await fs.readFile(path.join(saved.problemFolder, 'testcases.json'), 'utf8'));
  assert.equal(migratedCases.testCases[0].id, legacyCase.id);
  assert.equal(saved.scaffoldStale, true);
  assert.equal(await fs.readFile(path.join(legacy, 'solution.py'), 'utf8'), 'old_local = True\n');
});

test('legacy migration ignores a slug-named directory whose metadata belongs to another problem', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-mismatched-legacy-workspace-'));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-mismatched-legacy-storage-'));
  temporaryFolders.push(root, storage);
  const misleadingFolder = path.join(root, 'leetcode', 'two-sum');
  await fs.mkdir(misleadingFolder, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(misleadingFolder, 'metadata.json'), JSON.stringify({
      title: '3Sum', source: 'https://leetcode.com/problems/three-sum/', language: 'Python3'
    }), 'utf8'),
    fs.writeFile(path.join(misleadingFolder, 'testcases.json'), JSON.stringify({
      version: 3,
      testCases: [{
        id: 'wrong-problem', name: 'testcase 001', input: 'wrong', expectedOutput: 'wrong',
        source: 'manual', createdAt: '2026-09-02T00:00:00.000Z'
      }],
      excludedAiIds: [], excludedLeetCodeIds: []
    }), 'utf8'),
    fs.writeFile(path.join(misleadingFolder, 'testcase.py'), '# wrong problem scaffold\n', 'utf8')
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
    title: 'Two Sum', source: 'https://leetcode.com/problems/two-sum/', problemSlug: 'two-sum',
    language: 'Python3', description: 'Example', samples: '', code: 'class Solution: pass\n'
  });

  const state = JSON.parse(await fs.readFile(path.join(saved.problemFolder, 'testcases.json'), 'utf8'));
  assert.deepEqual(state.testCases, []);
  await assert.rejects(fs.access(path.join(saved.problemFolder, 'testcase.py')), { code: 'ENOENT' });
});

test('private records stay bound to their original workspace root when multi-root order changes', async () => {
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

test('renaming the whole output directory rebases every registered solution path', async () => {
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
  const metadata = JSON.parse(await fs.readFile(path.join(saved.problemFolder, 'metadata.json'), 'utf8'));
  assert.equal(metadata.solutionPath, newSolution);
  assert.equal(metadata.solutionRelativePath, path.relative(root, newSolution));
  const recaptured = await sandbox.saveCapture({
    title: 'Two Sum', source: 'https://leetcode.cn/problems/two-sum/', problemSlug: 'two-sum',
    language: 'Python3', description: '', samples: '', code: 'class Solution: updated\n'
  });
  assert.equal(recaptured.solution, newSolution);
  assert.equal(await fs.readFile(newSolution, 'utf8'), 'class Solution: updated\n');
  assert.deepEqual(await fs.readdir(path.join(root, 'leetcode')), []);
  vscodeStub.window.activeTextEditor = {
    document: { uri: { scheme: 'file', fsPath: newSolution }, getText: () => 'class Solution: updated\n' }
  };
  assert.equal((await sandbox.activeProblemContext()).solutionPath, newSolution);
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
  assert.equal(metadata.solutionPath, second.solution);
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
  assert.equal(metadata.solutionPath, saved.solution);
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

test('background AI generation follows a solution rename recorded after capture', async () => {
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
      return { content: '# generated after rename\n', provider: 'glm', model: 'glm-5.2' };
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
  const renamedSolution = path.join(path.dirname(saved.solution), 'My Two Sum.py');
  await fs.rename(saved.solution, renamedSolution);
  await sandbox.handleSolutionRenames({
    files: [{
      oldUri: { scheme: 'file', fsPath: saved.solution },
      newUri: { scheme: 'file', fsPath: renamedSolution }
    }]
  });

  const processed = await sandbox.processCapturedAi(payload, saved);
  assert.equal(processed.scaffoldGenerated, true);
  assert.equal(generationMetadata.solutionFileName, 'My Two Sum.py');
  assert.equal(generationCode, payload.code);
  const mainPath = path.join(path.dirname(renamedSolution), 'main.py');
  assert.equal(await fs.readFile(mainPath, 'utf8'), '# generated after rename\n');

  // A fresh extension host has no cache. Opening main must still resolve the
  // metadata-recorded, individually renamed solution rather than assuming a
  // sibling file literally named solution.py.
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
  assert.equal(reloadedContext.solutionPath, renamedSolution);
  assert.equal(reloadedContext.folder, saved.problemFolder);

  // Opening the renamed solution itself must also work after a restart. The
  // previous host's cache is deliberately absent in this sandbox.
  const reloadedFromSolution = loadExtension({
    workspace: {
      workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }], rootPath: root, textDocuments: [],
      getConfiguration: () => ({ get: () => undefined })
    },
    window: {
      activeTextEditor: { document: { uri: { scheme: 'file', fsPath: renamedSolution }, getText: () => payload.code } }
    }
  });
  initializePrivateStorage(reloadedFromSolution, storage);
  const renamedContext = await reloadedFromSolution.activeProblemContext();
  assert.equal(renamedContext.solutionPath, renamedSolution);
  assert.equal(renamedContext.folder, saved.problemFolder);
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
  assert.deepEqual(await fs.readdir(path.dirname(solutionPath)), ['solution.py']);
});

test('AI scaffold replacement preserves the prior saved scaffold as a backup', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-scaffold-backup-'));
  temporaryFolders.push(folder);
  const solutionPath = path.join(folder, 'solution.py');
  const scaffoldPath = path.join(folder, 'main.py');
  const oldScaffold = "# manually adjusted scaffold\nprint('old')\n";
  const newScaffold = "# generated scaffold\nprint('new')\n";
  await Promise.all([
    fs.writeFile(solutionPath, 'class Solution: pass\n', 'utf8'),
    fs.writeFile(scaffoldPath, oldScaffold, 'utf8'),
    fs.writeFile(path.join(folder, 'metadata.json'), JSON.stringify({
      title: '1. Two Sum', source: 'https://leetcode.com/problems/two-sum/', language: 'Python3', testcaseScaffoldStale: true
    }), 'utf8')
  ]);
  const vscodeStub = {
    workspace: {
      isTrusted: true,
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
    folder,
    solutionPath,
    code: 'class Solution: pass\n',
    metadata: {
      title: '1. Two Sum', source: 'https://leetcode.com/problems/two-sum/', language: 'Python3', testcaseScaffoldStale: true
    }
  }, [{ id: 'manual-1', name: 'testcase 001', input: 'n = 1', expectedOutput: '1', source: 'manual' }], { type: 'update' });

  assert.equal(result.destination, scaffoldPath);
  assert.equal(result.backup, `${scaffoldPath}.bak`);
  assert.equal(await fs.readFile(scaffoldPath, 'utf8'), newScaffold);
  assert.equal(await fs.readFile(`${scaffoldPath}.bak`, 'utf8'), oldScaffold);
  const metadata = JSON.parse(await fs.readFile(path.join(folder, 'metadata.json'), 'utf8'));
  assert.equal(metadata.testcaseScaffoldStale, false);
});

test('AI generation never overwrites main when it changes while the model request is in flight', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-main-race-'));
  temporaryFolders.push(folder);
  const solutionPath = path.join(folder, 'solution.py');
  const mainPath = path.join(folder, 'main.py');
  await Promise.all([
    fs.writeFile(solutionPath, 'class Solution: pass\n', 'utf8'),
    fs.writeFile(mainPath, '# old main\n', 'utf8'),
    fs.writeFile(path.join(folder, 'metadata.json'), JSON.stringify({
      title: 'Race', source: 'https://leetcode.com/problems/race/', language: 'Python3', testcaseScaffoldStale: true
    }), 'utf8')
  ]);
  const sandbox = loadExtension({
    workspace: {
      isTrusted: true,
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
    folder,
    solutionPath,
    code: 'class Solution: pass\n',
    metadata: { title: 'Race', source: 'https://leetcode.com/problems/race/', language: 'Python3', testcaseScaffoldStale: true }
  }, [{ id: 'one', name: 'testcase 001', input: '1', expectedOutput: '1', source: 'manual' }], { type: 'update' }), /main\.py 已发生变化/);
  assert.equal(await fs.readFile(mainPath, 'utf8'), '# newer local main\n');
  await assert.rejects(fs.access(path.join(folder, 'main.py.bak')), { code: 'ENOENT' });
});

test('a manual blank case is saved without an API key without invoking AI or making the scaffold stale', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-manual-no-key-'));
  temporaryFolders.push(folder);
  const solutionPath = path.join(folder, 'solution.py');
  await Promise.all([
    fs.writeFile(solutionPath, 'class Solution: pass\n', 'utf8'),
    fs.writeFile(path.join(folder, 'metadata.json'), JSON.stringify({
      title: '1. Two Sum', source: 'https://leetcode.com/problems/two-sum/', language: 'Python3'
    }), 'utf8')
  ]);
  const vscodeStub = {
    workspace: {
      isTrusted: true,
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
  const stored = JSON.parse(await fs.readFile(path.join(folder, 'testcases.json'), 'utf8'));
  assert.deepEqual(stored.testCases.map((testCase) => ({ source: testCase.source, input: testCase.input, expectedOutput: testCase.expectedOutput })), [
    { source: 'manual', input: '', expectedOutput: '' }
  ]);
  const metadata = JSON.parse(await fs.readFile(path.join(folder, 'metadata.json'), 'utf8'));
  assert.notEqual(metadata.testcaseScaffoldStale, true);
  assert.equal(metadata.testcaseScaffoldError, undefined);
});

test('blank add waits for first save, later edits are save-only, and delete regenerates the scaffold', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-manual-mutation-sequence-'));
  temporaryFolders.push(folder);
  const solutionPath = path.join(folder, 'solution.py');
  const mainPath = path.join(folder, 'main.py');
  await Promise.all([
    fs.writeFile(solutionPath, 'class Solution: pass\n', 'utf8'),
    fs.writeFile(mainPath, '# original main\n', 'utf8'),
    fs.writeFile(path.join(folder, 'metadata.json'), JSON.stringify({
      title: 'Mutation Sequence',
      source: 'https://leetcode.com/problems/mutation-sequence/',
      language: 'Python3',
      testcaseScaffoldStale: false
    }), 'utf8')
  ]);
  const vscodeStub = {
    workspace: {
      isTrusted: true,
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
  let metadata = JSON.parse(await fs.readFile(path.join(folder, 'metadata.json'), 'utf8'));
  assert.equal(metadata.testcaseScaffoldStale, false);
  const persistedAfterEdit = JSON.parse(await fs.readFile(path.join(folder, 'testcases.json'), 'utf8'));
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
  metadata = JSON.parse(await fs.readFile(path.join(folder, 'metadata.json'), 'utf8'));
  assert.equal(metadata.testcaseScaffoldStale, false);
});

test('a first-save metadata failure leaves the empty draft unchanged and does not call AI', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-first-save-stale-failure-'));
  temporaryFolders.push(folder);
  const solutionPath = path.join(folder, 'solution.py');
  const metadataPath = path.join(folder, 'metadata.json');
  await Promise.all([
    fs.writeFile(solutionPath, 'class Solution: pass\n', 'utf8'),
    fs.writeFile(path.join(folder, 'main.py'), '# existing main\n', 'utf8'),
    fs.writeFile(metadataPath, JSON.stringify({
      title: 'Atomic First Save',
      source: 'https://leetcode.com/problems/atomic-first-save/',
      language: 'Python3',
      testcaseScaffoldStale: false
    }), 'utf8')
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

  const state = JSON.parse(await fs.readFile(path.join(folder, 'testcases.json'), 'utf8'));
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

  const added = await sandbox.mutateTestCaseAndScaffold('add', {});
  assert.equal(added.localOnly, true);
  assert.equal(added.testCase.input, '');
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
  await assert.rejects(sandbox.runTestsFromSidebar('all'), /没有私有题目信息/);
  await assert.rejects(sandbox.extractTestCasesForContext(initial), /不能使用 AI/);
  await assert.rejects(sandbox.generateTestScaffold(initial, [], { type: 'initialize' }), /不能生成 main/);
  await assert.rejects(fs.access(path.join(problemDirectory, 'main.py')), { code: 'ENOENT' });
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
  assert.equal(regenerated.generated.backup, path.join(saved.problemFolder, 'main.py.bak'));
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
  assert.equal(saved.problemFolder.startsWith(path.join(storage, 'problems')), true);
  assert.notEqual(saved.problemFolder, path.dirname(saved.solution));
  assert.deepEqual(await fs.readdir(path.join(root, 'leetcode')), ['1. Two Sum']);
  await assert.rejects(fs.access(path.join(saved.problemFolder, 'main.py')), { code: 'ENOENT' });
  vscodeStub.window.activeTextEditor = {
    document: { uri: { scheme: 'file', fsPath: saved.solution }, getText: () => 'browser_code = True\n' }
  };
  const interruptedState = await sandbox.sidebarState();
  assert.match(interruptedState.problem.scaffoldStatus, /VS Code 重载而中断/);
  assert.equal(interruptedState.problem.scaffoldReady, false);

  // Simulate a manual case already persisted in the private store. An empty
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
