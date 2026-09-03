'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  PROVIDERS,
  MAX_REPAIR_DIAGNOSTICS_CHARS,
  createAiTestcaseService,
  getConfiguredProviders,
  secretKeyFor,
  buildTestCaseExtractionPrompt,
  parseExtractedTestCases,
  stripCodeFence,
  validateScaffold
} = require('../vscode-extension/ai-testcase-service');

function makeSecrets(initial = {}) {
  const values = new Map(Object.entries(initial));
  const calls = { get: [], store: [], delete: [] };
  return {
    calls,
    async get(key) { calls.get.push(key); return values.get(key); },
    async store(key, value) { calls.store.push([key, value]); values.set(key, value); },
    async delete(key) { calls.delete.push(key); values.delete(key); }
  };
}

const metadata = {
  title: '1. Two Sum',
  source: 'https://leetcode.com/problems/two-sum/',
  problemId: '1',
  problemSlug: 'two-sum',
  language: 'Python3',
  description: 'Return the indices of two numbers that add up to target.'
};

const testCases = [
  { id: 'one', name: 'testcase 001', input: 'nums = [2,7,11,15], target = 9', expectedOutput: '[0,1]', source: 'leetcode' },
  { id: 'two', name: 'testcase 002', input: 'nums = [3,2,4], target = 6', expectedOutput: '[1,2]', source: 'manual' }
];

function successfulResponse() {
  return {
    choices: [{ message: { content: [
      '```python',
      'import json',
      'import sys',
      "MARKER = '__LEETCODE_CPH_RESULT__'",
      "selected = sys.argv[sys.argv.index('--case') + 1] if '--case' in sys.argv else None",
      "for name in ['testcase 001', 'testcase 002']:",
      '    if selected and name != selected: continue',
      "    print(MARKER + json.dumps({'name': name, 'actual': '[0,1]', 'passed': True}))",
      '```'
    ].join('\n') } }]
  };
}

test('API keys are stored only through SecretStorage and configured status never exposes values', async () => {
  const secrets = makeSecrets();
  const service = createAiTestcaseService({ secrets });
  await service.saveApiKey('glm', '  glm-secret  ');
  await service.saveApiKey('deepseek', 'deepseek-secret');

  assert.deepEqual(secrets.calls.store, [
    [secretKeyFor('glm'), 'glm-secret'],
    [secretKeyFor('deepseek'), 'deepseek-secret']
  ]);
  assert.deepEqual(await service.getConfiguredProviders(), { glm: true, deepseek: true, qwen: false });
  assert.equal(JSON.stringify(await getConfiguredProviders(secrets)).includes('glm-secret'), false);

  await service.deleteApiKey('glm');
  assert.deepEqual(secrets.calls.delete, [secretKeyFor('glm')]);
  assert.deepEqual(await service.getConfiguredProviders(), { glm: false, deepseek: true, qwen: false });
});

test('generation sends the chosen provider request and returns fence-free scaffold without exposing its key', async () => {
  const apiKey = 'very-private-key';
  const secrets = makeSecrets({ [secretKeyFor('deepseek')]: apiKey });
  let received;
  const service = createAiTestcaseService({
    secrets,
    request: async (request) => {
      received = request;
      return successfulResponse();
    }
  });

  const result = await service.generateScaffold({
    metadata,
    solutionCode: 'class Solution:\n    def twoSum(self, nums, target): pass',
    testCases,
    operation: { type: 'add', testCase: testCases[1] },
    existingScaffold: '# testcase 001\n',
    provider: 'deepseek',
    model: 'deepseek-v4-pro'
  });

  assert.equal(received.url, PROVIDERS.deepseek.endpoint);
  assert.equal(received.headers.Authorization, `Bearer ${apiKey}`);
  assert.equal(received.body.model, 'deepseek-v4-pro');
  assert.equal(received.body.temperature, 0);
  assert.match(received.body.messages[1].content, /testcase 001/);
  assert.match(received.body.messages[1].content, /testcase 002/);
  assert.match(received.body.messages[1].content, /__LEETCODE_CPH_RESULT__/);
  assert.match(received.body.messages[1].content, /--case/);
  assert.equal(result.content.includes('```'), false);
  assert.match(result.content, /testcase 001/);
  assert.match(result.content, /testcase 002/);
  assert.deepEqual(Object.keys(result).sort(), ['content', 'model', 'provider']);
  assert.equal(JSON.stringify(result).includes(apiKey), false);
});

test('scaffold prompt uses the metadata-recorded solution basename and never embeds a user path', async () => {
  const apiKey = 'runtime-contract-key';
  const userVisiblePath = 'C:\\Users\\Alice\\leetcode\\two-sum.py';
  const secrets = makeSecrets({ [secretKeyFor('glm')]: apiKey });
  let prompt = '';
  const service = createAiTestcaseService({
    secrets,
    request: async (request) => {
      prompt = request.body.messages[1].content;
      return successfulResponse();
    }
  });

  await service.generateScaffold({
    metadata: {
      ...metadata,
      runtimeSolutionFileName: 'answer.py',
      mainFileName: 'main.py',
      solutionPath: userVisiblePath
    },
    solutionCode: 'class Solution:\n    pass',
    testCases,
    operation: { type: 'initialize' },
    provider: 'glm'
  });

  assert.match(prompt, /"runtimeSolutionFileName": "answer\.py"/);
  assert.match(prompt, /"mainFileName": "main\.py"/);
  assert.match(prompt, /exact source basename/i);
  assert.match(prompt, /Use that JSON value exactly/i);
  assert.doesNotMatch(prompt, /Python main imports solution\.py normally/i);
  assert.match(prompt, /class LeetCodeCphTest/);
  assert.match(prompt, /object LeetCodeCphTest/);
  assert.match(prompt, /TypeScript solutionCode and main are concatenated/);
  assert.match(prompt, /never embed an absolute local path/i);
  assert.equal(prompt.includes(userVisiblePath), false);
});

test('each supported provider uses its fixed HTTPS endpoint and default model', async () => {
  for (const provider of Object.keys(PROVIDERS)) {
    const secrets = makeSecrets({ [secretKeyFor(provider)]: `${provider}-key` });
    let request;
    const service = createAiTestcaseService({
      secrets,
      request: async (value) => { request = value; return successfulResponse(); }
    });
    const result = await service.generateScaffold({
      metadata,
      solutionCode: 'solution',
      testCases,
      operation: { type: 'add', testCase: testCases[0] },
      provider
    });
    assert.equal(request.url, PROVIDERS[provider].endpoint, provider);
    assert.match(request.url, /^https:\/\//, provider);
    assert.equal(request.body.model, PROVIDERS[provider].defaultModel, provider);
    assert.equal(result.provider, provider);
  }
});

test('initialize generates one scaffold from all captured LeetCode examples without a synthetic mutation', async () => {
  const secrets = makeSecrets({ [secretKeyFor('qwen')]: 'qwen-key' });
  let received;
  const service = createAiTestcaseService({
    secrets,
    request: async (request) => { received = request; return successfulResponse(); }
  });

  const result = await service.generateScaffold({
    metadata,
    solutionCode: 'solution',
    testCases,
    operation: { type: 'initialize' },
    provider: 'qwen'
  });

  assert.equal(result.provider, 'qwen');
  assert.match(received.body.messages[1].content, /"type": "initialize"/);
  assert.match(received.body.messages[1].content, /testcase 001/);
  assert.match(received.body.messages[1].content, /testcase 002/);
});

test('regenerate rewrites the complete scaffold without requiring a synthetic testcase mutation', async () => {
  const secrets = makeSecrets({ [secretKeyFor('glm')]: 'glm-key' });
  let received;
  const service = createAiTestcaseService({
    secrets,
    request: async (request) => { received = request; return successfulResponse(); }
  });

  const result = await service.generateScaffold({
    metadata,
    solutionCode: 'class Solution:\n    pass',
    testCases,
    operation: { type: 'regenerate' },
    existingScaffold: '# outdated main',
    provider: 'glm'
  });

  assert.equal(result.provider, 'glm');
  assert.match(received.body.messages[1].content, /"type": "regenerate"/);
  assert.match(received.body.messages[1].content, /rewrite the complete scaffold/i);
  assert.match(received.body.messages[1].content, /testcase 001/);
  assert.match(received.body.messages[1].content, /testcase 002/);
});

test('repair sends the existing main and sanitized bounded execution diagnostics while preserving the runner contract', async () => {
  const secrets = makeSecrets({ [secretKeyFor('qwen')]: 'qwen-key' });
  const existingScaffold = [
    'import json',
    "MARKER = '__LEETCODE_CPH_RESULT__'",
    "selected = '--case'",
    "TEST_NAMES = ['testcase 001', 'testcase 002']",
    'raise SyntaxError("broken main")'
  ].join('\n');
  const localPath = 'C:\\Users\\Alice Smith\\leetcode\\Two Sum\\main.py';
  let prompt = '';
  const service = createAiTestcaseService({
    secrets,
    request: async (request) => {
      prompt = request.body.messages[1].content;
      return successfulResponse();
    }
  });

  const result = await service.generateScaffold({
    metadata: { ...metadata, runtimeSolutionFileName: 'solution.py', mainFileName: 'main.py' },
    solutionCode: 'class Solution:\n    def twoSum(self, nums, target): pass',
    testCases,
    operation: {
      type: 'repair',
      error: new Error(`SyntaxError in "${localPath}"`),
      diagnostics: {
        stage: 'run',
        stderr: `${localPath}:12: invalid syntax\u001b[31m`,
        stdout: 'ordinary output '.repeat(MAX_REPAIR_DIAGNOSTICS_CHARS),
        exitCode: 1
      }
    },
    existingScaffold,
    provider: 'qwen'
  });

  assert.match(prompt, /"type": "repair"/);
  assert.match(prompt, /existing main failed to compile or run/i);
  assert.match(prompt, /Repair only existingScaffold/i);
  assert.match(prompt, /invalid syntax/);
  assert.ok(prompt.indexOf('invalid syntax') < prompt.indexOf('ordinary output'), 'stderr must survive the combined diagnostic cap before stdout');
  assert.match(prompt, /\[LOCAL_PATH\]\/main\.py/);
  assert.equal(prompt.includes(localPath), false);
  assert.equal(prompt.includes('\u001b[31m'), false);
  assert.match(prompt, /raise SyntaxError\(\\"broken main\\"\)/);
  assert.match(prompt, /class Solution/);
  assert.match(prompt, /testcase 001/);
  assert.match(prompt, /testcase 002/);
  assert.match(prompt, /--case selector/);
  assert.match(prompt, /JSON runtime protocol/);
  assert.match(result.content, /__LEETCODE_CPH_RESULT__/);
});

test('repair rejects an unchanged or incomplete-view replacement before touching the caller file', async () => {
  const secrets = makeSecrets({ [secretKeyFor('glm')]: 'key' });
  const existingScaffold = [
    'import json',
    "MARKER = '__LEETCODE_CPH_RESULT__'",
    "selected = '--case'",
    "TEST_NAMES = ['testcase 001', 'testcase 002']"
  ].join('\n');
  let calls = 0;
  const unchanged = createAiTestcaseService({
    secrets,
    request: async () => {
      calls += 1;
      return { choices: [{ finish_reason: 'stop', message: { content: existingScaffold } }] };
    }
  });
  await assert.rejects(
    unchanged.generateScaffold({
      metadata,
      testCases,
      operation: { type: 'repair', diagnostics: 'runtime failed' },
      existingScaffold
    }),
    /与现有代码相同/
  );
  assert.equal(calls, 1);

  calls = 0;
  await assert.rejects(
    unchanged.generateScaffold({
      metadata,
      testCases,
      operation: { type: 'repair', diagnostics: 'runtime failed' },
      existingScaffold: existingScaffold + '\n' + 'x'.repeat(35_000)
    }),
    /main 代码过长/
  );
  assert.equal(calls, 0, 'an incomplete main must never be sent for destructive replacement');
});

test('repair requires diagnostics and an existing main before making a provider request', async () => {
  let called = false;
  const service = createAiTestcaseService({
    secrets: makeSecrets({ [secretKeyFor('glm')]: 'key' }),
    request: async () => { called = true; return successfulResponse(); }
  });

  await assert.rejects(
    service.generateScaffold({ metadata, testCases, operation: { type: 'repair' }, existingScaffold: 'main' }),
    /需要提供 operation\.error 或 operation\.diagnostics/
  );
  await assert.rejects(
    service.generateScaffold({ metadata, testCases, operation: { type: 'repair', diagnostics: 'compile failed' }, existingScaffold: '' }),
    /必须提供现有 main 代码/
  );
  assert.equal(called, false);
});

test('repair diagnostics are capped and repaired output must still include every testcase and runtime protocol', async () => {
  const secrets = makeSecrets({ [secretKeyFor('glm')]: 'key' });
  let prompt = '';
  const missingCase = createAiTestcaseService({
    secrets,
    request: async (request) => {
      prompt = request.body.messages[1].content;
      return {
        choices: [{ finish_reason: 'stop', message: { content: [
          'import json',
          "MARKER = '__LEETCODE_CPH_RESULT__'",
          "selected = '--case'",
          "print('testcase 001')"
        ].join('\n') } }]
      };
    }
  });

  await assert.rejects(
    missingCase.generateScaffold({
      metadata,
      testCases,
      operation: { type: 'repair', diagnostics: 'x'.repeat(MAX_REPAIR_DIAGNOSTICS_CHARS * 2) },
      existingScaffold: '# testcase 001\n# testcase 002\n--case\n__LEETCODE_CPH_RESULT__'
    }),
    /缺少测试用例 “testcase 002”/
  );
  assert.match(prompt, /Diagnostics truncated due to length limit/);

  const missingProtocol = createAiTestcaseService({
    secrets,
    request: async () => ({
      choices: [{ finish_reason: 'stop', message: { content: "print('testcase 001 testcase 002')" } }]
    })
  });
  await assert.rejects(
    missingProtocol.generateScaffold({
      metadata,
      testCases,
      operation: { type: 'repair', error: 'runtime failed' },
      existingScaffold: 'print("old")'
    }),
    /运行结果协议/
  );
});

test('missing key fails before any request with actionable provider-specific guidance', async () => {
  const secrets = makeSecrets();
  let called = false;
  const service = createAiTestcaseService({ secrets, request: async () => { called = true; return successfulResponse(); } });
  await assert.rejects(
    service.generateScaffold({ metadata, solutionCode: '', testCases, operation: { type: 'add', testCase: testCases[0] }, provider: 'qwen' }),
    /未配置 Qwen API Key/
  );
  assert.equal(called, false);
});

test('testcase extraction uses the selected user key and returns only validated JSON cases', async () => {
  const apiKey = 'private-extraction-key';
  const secrets = makeSecrets({ [secretKeyFor('glm')]: apiKey });
  let received;
  const service = createAiTestcaseService({
    secrets,
    request: async (request) => {
      received = request;
      return {
        choices: [{
          finish_reason: 'stop',
          message: {
            content: '{"testCases":[{"input":"nums = [2,7,11,15], target = 9","expectedOutput":"[0,1]","evidence":"Input: nums = [2,7,11,15], target = 9\\nOutput: [0,1]"},{"input":"nums = [2,7,11,15], target = 9","expectedOutput":"[0,1]","evidence":"Input: nums = [2,7,11,15], target = 9\\nOutput: [0,1]"}]}'
          }
        }]
      };
    }
  });

  const result = await service.extractTestCases({
    metadata: { ...metadata, samples: 'Example 1:\nInput: nums = [2,7,11,15], target = 9\nOutput: [0,1]' }
  });

  assert.equal(received.url, PROVIDERS.glm.endpoint);
  assert.equal(received.headers.Authorization, `Bearer ${apiKey}`);
  assert.equal(received.body.model, PROVIDERS.glm.defaultModel);
  assert.match(received.body.messages[1].content, /Extract the explicit example test cases/);
  assert.match(received.body.messages[1].content, /Example 1/);
  assert.equal(received.body.messages[1].content.includes('solutionCode'), false);
  assert.deepEqual(result, {
    testCases: [{ input: 'nums = [2,7,11,15], target = 9', expectedOutput: '[0,1]', evidence: 'Input: nums = [2,7,11,15], target = 9\nOutput: [0,1]' }],
    provider: 'glm',
    model: PROVIDERS.glm.defaultModel
  });
  assert.equal(JSON.stringify(result).includes(apiKey), false);
});

test('testcase extraction has no raw-page fallback when the user has not configured a key', async () => {
  let called = false;
  const service = createAiTestcaseService({
    secrets: makeSecrets(),
    request: async () => { called = true; return successfulResponse(); }
  });
  await assert.rejects(
    service.extractTestCases({ metadata: { ...metadata, samples: 'Input: n = 1\nOutput: 1' }, provider: 'qwen' }),
    /未配置 Qwen API Key/
  );
  assert.equal(called, false);
});

test('testcase extraction prompt and JSON parser require verifiable page evidence', () => {
  assert.match(buildTestCaseExtractionPrompt({ metadata: { ...metadata, samples: 'Input: n = 1\nOutput: 1' } }), /Do not invent/);
  assert.match(buildTestCaseExtractionPrompt({ metadata: { ...metadata, samples: 'Input: n = 1\nOutput: 1' } }), /evidence/);
  const extractionMetadata = { ...metadata, samples: 'Example 1:\nInput: n = 1\nOutput: 1' };
  assert.deepEqual(
    parseExtractedTestCases('```json\n{"testCases":[{"input":"n = 1","expectedOutput":"1","evidence":"Input: n = 1\\nOutput: 1"}]}\n```', extractionMetadata),
    [{ input: 'n = 1', expectedOutput: '1', evidence: 'Input: n = 1\nOutput: 1' }]
  );
  assert.throws(() => parseExtractedTestCases('testcase 001 is ready', extractionMetadata), /不是有效 JSON/);
  assert.throws(() => parseExtractedTestCases('{"testCases":[{"input":[],"expectedOutput":"1","evidence":"Input: n = 1\\nOutput: 1"}]}', extractionMetadata), /不是文本/);
  assert.throws(() => parseExtractedTestCases('{"testCases":[{"input":"","expectedOutput":"","evidence":"Input: n = 1\\nOutput: 1"}]}', extractionMetadata), /均为空/);
  assert.throws(() => parseExtractedTestCases('{"testCases":[{"input":"invented","expectedOutput":"1","evidence":"Input: n = 1\\nOutput: 1"}]}', extractionMetadata), /字段不在其题面证据中/);
  assert.throws(() => parseExtractedTestCases('{"testCases":[{"input":"n = 1","expectedOutput":"1","evidence":"invented evidence"}]}', extractionMetadata), /证据不在题面中/);
});

test('LeetCode 150 extraction keeps all three explicit examples in page order', () => {
  const examples = [
    {
      input: 'tokens = ["2","1","+","3","*"]',
      expectedOutput: '9',
      evidence: '示例 1：\n输入：tokens = ["2","1","+","3","*"]\n输出：9'
    },
    {
      input: 'tokens = ["4","13","5","/","+"]',
      expectedOutput: '6',
      evidence: '示例 2：\n输入：tokens = ["4","13","5","/","+"]\n输出：6'
    },
    {
      input: 'tokens = ["10","6","9","3","+","-11","*","/","*","17","+","5","+"]',
      expectedOutput: '22',
      evidence: '示例 3：\n输入：tokens = ["10","6","9","3","+","-11","*","/","*","17","+","5","+"]\n输出：22'
    }
  ];
  const extractionMetadata = {
    title: '150. 逆波兰表达式求值',
    source: 'https://leetcode.cn/problems/evaluate-reverse-polish-notation/',
    samples: examples.map((item) => item.evidence).join('\n\n')
  };

  assert.deepEqual(
    parseExtractedTestCases(JSON.stringify({ testCases: examples }), extractionMetadata),
    examples
  );
});

test('provider response errors are useful but redact the API key', async () => {
  const apiKey = 'secret-that-must-not-appear';
  const secrets = makeSecrets({ [secretKeyFor('glm')]: apiKey });
  const service = createAiTestcaseService({
    secrets,
    request: async () => {
      const error = new Error('request failed');
      error.statusCode = 401;
      error.body = { error: { message: `Invalid key ${apiKey}` } };
      throw error;
    }
  });
  await assert.rejects(
    service.generateScaffold({ metadata, solutionCode: '', testCases, operation: { type: 'add', testCase: testCases[0] } }),
    (error) => {
      assert.match(error.message, /调用 GLM AI 服务失败/);
      assert.match(error.message, /\[REDACTED\]/);
      assert.equal(error.message.includes(apiKey), false);
      return true;
    }
  );
});

test('delete operation rejects an AI scaffold that still contains the deleted test name', async () => {
  const remaining = [testCases[0]];
  const protocol = "\nMARKER = '__LEETCODE_CPH_RESULT__'\nselected = '--case'\nTEST_NAMES = ['testcase 001']\n";
  assert.throws(
    () => validateScaffold('# testcase 001\ndef testcase_001(): pass\n# testcase 002\n' + protocol, remaining, { type: 'delete', testCase: testCases[1] }, 'Python3'),
    /仍包含已删除的测试用例/
  );
  assert.equal(
    validateScaffold('# testcase 001\ndef testcase_001(): pass\n' + protocol, remaining, { type: 'delete', testCase: testCases[1] }, 'Python3'),
    '# testcase 001\ndef testcase_001(): pass\n' + protocol
  );
});

test('scaffold generation requires the per-case execution protocol', () => {
  assert.throws(
    () => validateScaffold('# testcase 001\ndef testcase_001(): pass\n', [testCases[0]], { type: 'initialize' }, 'Python3'),
    /运行结果协议/
  );
  assert.throws(
    () => validateScaffold('# testcase 001\n# --case\n# __LEETCODE_CPH_RESULT__\ndef noop(): pass\n', [testCases[0]], { type: 'initialize' }, 'Python3'),
    /运行结果协议/
  );
});

test('truncated and non-source AI output is rejected before it can overwrite a scaffold', async () => {
  const secrets = makeSecrets({ [secretKeyFor('glm')]: 'key' });
  const truncated = createAiTestcaseService({
    secrets,
    request: async () => ({ choices: [{ finish_reason: 'length', message: { content: '# testcase 001\ndef broken(' } }] })
  });
  await assert.rejects(
    truncated.generateScaffold({ metadata, testCases: [testCases[0]], operation: { type: 'initialize' } }),
    /未完整生成/
  );

  const prose = createAiTestcaseService({
    secrets,
    request: async () => ({ choices: [{ finish_reason: 'stop', message: { content: 'testcase 001 已准备好。' } }] })
  });
  await assert.rejects(
    prose.generateScaffold({ metadata, testCases: [testCases[0]], operation: { type: 'initialize' } }),
    /不像可运行的测试源文件/
  );
});

test('code fence stripping only unwraps a complete outer fence', () => {
  assert.equal(stripCodeFence('```cpp\n// testcase 001\n```'), '// testcase 001');
  assert.equal(stripCodeFence('plain text'), 'plain text');
  assert.equal(stripCodeFence('```cpp\nmissing end'), '```cpp\nmissing end');
});

test('malformed provider or model input is rejected before a request can be made', async () => {
  const secrets = makeSecrets({ [secretKeyFor('glm')]: 'key' });
  const service = createAiTestcaseService({ secrets, request: async () => successfulResponse() });
  await assert.rejects(
    service.generateScaffold({ metadata, testCases, operation: { type: 'add', testCase: testCases[0] }, provider: 'unknown' }),
    /不支持的 AI Provider/
  );
  await assert.rejects(
    service.generateScaffold({ metadata, testCases, operation: { type: 'add', testCase: testCases[0] }, model: 'unsafe model name' }),
    /模型名称无效/
  );
});
