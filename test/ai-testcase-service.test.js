'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  PROVIDERS,
  createAiTestcaseService,
  getConfiguredProviders,
  secretKeyFor,
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
    choices: [{ message: { content: '```python\n# testcase 001\ndef testcase_001(): pass\n# testcase 002\ndef testcase_002(): pass\n```' } }]
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
  assert.equal(result.content.includes('```'), false);
  assert.match(result.content, /testcase 001/);
  assert.match(result.content, /testcase 002/);
  assert.deepEqual(Object.keys(result).sort(), ['content', 'model', 'provider']);
  assert.equal(JSON.stringify(result).includes(apiKey), false);
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
  assert.throws(
    () => validateScaffold('# testcase 001\ndef testcase_001(): pass\n# testcase 002\n', remaining, { type: 'delete', testCase: testCases[1] }, 'Python3'),
    /仍包含已删除的测试用例/
  );
  assert.equal(
    validateScaffold('# testcase 001\ndef testcase_001(): pass\n', remaining, { type: 'delete', testCase: testCases[1] }, 'Python3'),
    '# testcase 001\ndef testcase_001(): pass\n'
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
