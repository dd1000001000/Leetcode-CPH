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

function loadExtension(vscodeStub) {
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
      if (name === 'fs/promises') return require('node:fs/promises');
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

test('capture output directories remain inside the workspace', () => {
  const sandbox = loadExtension({});
  const root = path.resolve(os.tmpdir(), 'leetcode-cph-workspace-root');
  assert.equal(
    sandbox.resolveWorkspaceOutputDirectory(root, 'leetcode/problems'),
    path.join(root, 'leetcode', 'problems')
  );
  assert.throws(
    () => sandbox.resolveWorkspaceOutputDirectory(root, path.join('..', 'outside-workspace')),
    /工作区外/
  );
  assert.throws(
    () => sandbox.resolveWorkspaceOutputDirectory(root, path.parse(root).root),
    /相对路径/
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

test('re-capturing a problem preserves an existing local solution and its dirty editor buffer', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-recapture-'));
  temporaryFolders.push(root);
  const folder = path.join(root, 'leetcode', '1-two-sum');
  await fs.mkdir(folder, { recursive: true });
  const solutionPath = path.join(folder, 'solution.py');
  await Promise.all([
    fs.writeFile(solutionPath, 'disk_solution = True\n', 'utf8'),
    fs.writeFile(path.join(folder, 'metadata.json'), JSON.stringify({
      title: '1. Two Sum', source: 'https://leetcode.com/problems/two-sum/', language: 'Python3'
    }), 'utf8')
  ]);
  const vscodeStub = {
    workspace: {
      workspaceFolders: [{ uri: { fsPath: root } }],
      rootPath: root,
      textDocuments: [{
        uri: { scheme: 'file', fsPath: solutionPath },
        isDirty: true,
        getText: () => 'unsaved_local_solution = True\n'
      }],
      getConfiguration: () => ({ get: (key) => key === 'outputDirectory' ? 'leetcode' : key === 'openSolutionAfterCapture' ? false : 27121 })
    },
    window: { showTextDocument: async () => {} }
  };
  const sandbox = loadExtension(vscodeStub);
  vm.runInContext('outputChannel = { appendLine() {} };', sandbox);
  const saved = await sandbox.saveCapture({
    title: '1. Two Sum', source: 'https://leetcode.com/problems/two-sum/', problemId: '1',
    language: 'Python3', description: 'Example', samples: '', code: 'browser_code = True\n'
  });

  assert.equal(saved.solutionCreated, false);
  assert.equal(await fs.readFile(solutionPath, 'utf8'), 'disk_solution = True\n');
  const metadata = JSON.parse(await fs.readFile(path.join(folder, 'metadata.json'), 'utf8'));
  assert.equal(metadata.code, 'unsaved_local_solution = True\n');
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

test('a successful empty extraction still generates a scaffold for saved manual cases', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-manual-capture-'));
  temporaryFolders.push(root);
  const folder = path.join(root, 'leetcode', '1-two-sum');
  const solutionPath = path.join(folder, 'solution.py');
  await fs.mkdir(folder, { recursive: true });
  await Promise.all([
    fs.writeFile(solutionPath, 'class Solution: pass\n', 'utf8'),
    fs.writeFile(path.join(folder, 'metadata.json'), JSON.stringify({
      title: '1. Two Sum', source: 'https://leetcode.com/problems/two-sum/', language: 'Python3'
    }), 'utf8'),
    fs.writeFile(path.join(folder, 'testcases.json'), JSON.stringify({
      version: 3,
      testCases: [{ id: 'manual-1', name: 'testcase 001', input: 'n = 1', expectedOutput: '1', source: 'manual', createdAt: '2026-09-02T00:00:00.000Z' }],
      excludedAiIds: [], excludedLeetCodeIds: []
    }), 'utf8')
  ]);
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
  sandbox.injectedAiService = {
    async getConfiguredProviders() { return { glm: true, deepseek: false, qwen: false }; },
    async extractTestCases() { return { testCases: [], provider: 'glm', model: 'glm-5.2' }; },
    async generateScaffold() { generated += 1; return { content: '# generated manual scaffold\n', provider: 'glm', model: 'glm-5.2' }; }
  };
  vm.runInContext('aiTestcaseService = injectedAiService; outputChannel = { appendLine() {} };', sandbox);

  const saved = await sandbox.saveCapture({
    title: '1. Two Sum', source: 'https://leetcode.com/problems/two-sum/', problemId: '1',
    language: 'Python3', description: 'No explicit examples', samples: '', code: 'browser_code = True\n'
  });
  assert.equal(saved.scaffoldGenerated, true);
  assert.equal(generated, 1);
  assert.equal(await fs.readFile(path.join(folder, 'testcase.py'), 'utf8'), '# generated manual scaffold\n');
});
