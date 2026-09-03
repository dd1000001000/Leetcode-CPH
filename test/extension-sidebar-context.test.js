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
    setTimeout,
    clearTimeout,
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
      if (name === './testcase-runner') return require('../vscode-extension/testcase-runner');
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

test('sidebar preserves a scaffold semantic pass while still flagging textual output differences', () => {
  const sandbox = loadExtension({});
  const results = sandbox.sidebarResultsFromRun([
    { id: 'case-1', name: 'testcase 001', input: 'nums=[2,7], target=9', expectedOutput: '[0,1]' }
  ], {
    'testcase 001': { actual: [1, 0], passed: true }
  });

  assert.deepEqual({ ...results['case-1'] }, {
    status: 'passed',
    passed: true,
    actualOutput: '[1,0]',
    different: true
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
});

test('capture exposes only a title-named solution and keeps state, scaffold, and backups private', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-recapture-workspace-'));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-recapture-storage-'));
  temporaryFolders.push(root, storage);
  const outputFolder = path.join(root, 'leetcode');
  const solutionPath = path.join(outputFolder, '1. Two Sum.py');
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

  const scaffoldPath = path.join(first.problemFolder, 'testcase.py');
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
  assert.deepEqual(await fs.readdir(outputFolder), ['1. Two Sum.py']);

  const privateEntries = (await fs.readdir(saved.problemFolder)).sort();
  assert.deepEqual(privateEntries, ['metadata.json', 'solution.py.bak', 'testcase.py', 'testcases.json']);
  const metadata = JSON.parse(await fs.readFile(path.join(saved.problemFolder, 'metadata.json'), 'utf8'));
  assert.equal(metadata.code, 'browser_code = True\n');
  assert.equal(metadata.solutionPath, solutionPath);
  assert.equal(metadata.solutionFileName, '1. Two Sum.py');
  assert.equal(metadata.testcaseScaffoldStale, true);

  // A new extension-host instance has an empty in-memory cache, so this proves
  // the title-named visible file can be resolved by scanning private metadata.
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

test('running all cases combines the visible title file with the private scaffold', async () => {
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
  await fs.writeFile(path.join(saved.problemFolder, 'testcase.js'), [
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
  assert.equal(await fs.readFile(path.join(saved.problemFolder, 'solution.js'), 'utf8'), solutionDocument.getText());
  assert.deepEqual(await fs.readdir(path.join(root, 'leetcode')), ['1. Add.js']);
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
  assert.deepEqual(await fs.readdir(path.join(root, 'leetcode')), ['Same Name.py']);
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

  assert.equal(path.basename(first.solution), 'Same Name.py');
  assert.equal(recaptured.solution, first.solution);
  assert.equal(recaptured.problemFolder, first.problemFolder);
  assert.notEqual(second.problemFolder, first.problemFolder);
  assert.equal(await fs.readFile(first.solution, 'utf8'), 'alpha = 2\n');
  const alphaMetadata = JSON.parse(await fs.readFile(path.join(recaptured.problemFolder, 'metadata.json'), 'utf8'));
  assert.equal(alphaMetadata.source, 'https://leetcode.cn/problems/alpha-problem/');
  assert.deepEqual(await fs.readdir(path.join(root, 'leetcode')), ['Same Name.py']);
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
  assert.equal(await fs.readFile(path.join(saved.problemFolder, 'testcase.py'), 'utf8'), '# old private scaffold\n');
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
  const sameRelativePathInB = path.join(rootB, 'leetcode', 'Two Sum.py');
  await fs.mkdir(path.dirname(sameRelativePathInB), { recursive: true });
  await fs.writeFile(sameRelativePathInB, 'from_root_b = True\n', 'utf8');

  vscodeStub.workspace.workspaceFolders = [folders[1], folders[0]];
  vscodeStub.workspace.rootPath = rootB;
  vscodeStub.window.activeTextEditor = {
    document: { uri: { scheme: 'file', fsPath: sameRelativePathInB }, getText: () => 'from_root_b = True\n' }
  };
  await assert.rejects(sandbox.activeProblemContext(), /不是由 LeetCode CPH 登记/);

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
  assert.equal(await fs.readFile(path.join(saved.problemFolder, 'testcase.py'), 'utf8'), '# generated after rename\n');
});

test('re-capturing rejects a dirty local solution without changing any file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-dirty-workspace-'));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-dirty-storage-'));
  temporaryFolders.push(root, storage);
  const solutionPath = path.join(root, 'leetcode', '1. Two Sum.py');
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
  assert.deepEqual(await fs.readdir(path.dirname(solutionPath)), ['1. Two Sum.py']);
});

test('AI scaffold replacement preserves the prior saved scaffold as a backup', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-scaffold-backup-'));
  temporaryFolders.push(folder);
  const solutionPath = path.join(folder, 'solution.py');
  const scaffoldPath = path.join(folder, 'testcase.py');
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

test('a manual blank case is saved without an API key and leaves the scaffold pending', async () => {
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
  sandbox.injectedAiService = {
    async getConfiguredProviders() { return { glm: false, deepseek: false, qwen: false }; }
  };
  vm.runInContext('aiTestcaseService = injectedAiService; outputChannel = { appendLine() {} };', sandbox);

  await assert.rejects(
    sandbox.mutateTestCaseAndScaffold('add', {}),
    /测试用例已保存.*未配置 GLM API Key/
  );
  const stored = JSON.parse(await fs.readFile(path.join(folder, 'testcases.json'), 'utf8'));
  assert.deepEqual(stored.testCases.map((testCase) => ({ source: testCase.source, input: testCase.input, expectedOutput: testCase.expectedOutput })), [
    { source: 'manual', input: '', expectedOutput: '' }
  ]);
  const metadata = JSON.parse(await fs.readFile(path.join(folder, 'metadata.json'), 'utf8'));
  assert.equal(metadata.testcaseScaffoldStale, true);
  assert.match(metadata.testcaseScaffoldError, /未配置 GLM API Key/);
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
  assert.deepEqual(await fs.readdir(path.join(root, 'leetcode')), ['1. Two Sum.py']);
  await assert.rejects(fs.access(path.join(saved.problemFolder, 'testcase.py')), { code: 'ENOENT' });
  vscodeStub.window.activeTextEditor = {
    document: { uri: { scheme: 'file', fsPath: saved.solution }, getText: () => 'browser_code = True\n' }
  };
  const interruptedState = await sandbox.sidebarState();
  assert.match(interruptedState.problem.scaffoldStatus, /VS Code 重载而中断/);
  assert.equal(interruptedState.problem.scaffoldReady, false);

  // Simulate a manual case already persisted in the private store. An empty
  // extraction must still generate its scaffold in that same private folder.
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
  assert.equal(await fs.readFile(path.join(saved.problemFolder, 'testcase.py'), 'utf8'), '# generated manual scaffold\n');
  await assert.rejects(fs.access(path.join(path.dirname(saved.solution), 'testcase.py')), { code: 'ENOENT' });
});
