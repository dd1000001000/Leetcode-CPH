'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  TEST_CASES_FILE,
  fromCapturePayload,
  mergeCaptureTestCases,
  loadTestCaseState,
  parseLeetCodeSamples,
  loadTestCases,
  saveTestCases,
  createTestCase,
  deleteTestCase
} = require('../vscode-extension/testcase-store');

const temporaryFolders = [];
afterEach(async () => {
  await Promise.all(temporaryFolders.splice(0).map((folder) => fs.rm(folder, { recursive: true, force: true })));
});

async function temporaryProblem() {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-testcases-'));
  temporaryFolders.push(folder);
  return folder;
}

test('fromCapturePayload preserves multiple structured LeetCode examples', () => {
  const cases = fromCapturePayload({
    source: 'https://leetcode.cn/problems/two-sum/',
    capturedAt: '2026-09-02T00:00:00.000Z',
    testCases: [
      { input: 'nums = [2,7,11,15], target = 9', expectedOutput: '[0,1]' },
      { name: 'testcase 009', input: 'nums = [3,2,4], target = 6', expectedOutput: '[1,2]' }
    ]
  });

  assert.equal(cases.length, 2);
  assert.deepEqual(cases.map(({ name, input, expectedOutput, source, createdAt }) => ({ name, input, expectedOutput, source, createdAt })), [
    {
      name: 'testcase 001',
      input: 'nums = [2,7,11,15], target = 9',
      expectedOutput: '[0,1]',
      source: 'leetcode',
      createdAt: '2026-09-02T00:00:00.000Z'
    },
    {
      name: 'testcase 009',
      input: 'nums = [3,2,4], target = 6',
      expectedOutput: '[1,2]',
      source: 'leetcode',
      createdAt: '2026-09-02T00:00:00.000Z'
    }
  ]);
  assert.match(cases[0].id, /^leetcode-/);
  assert.notEqual(cases[0].id, cases[1].id);
});

test('legacy samples parse multiple English and Chinese Input/Output examples without explanation prose', () => {
  const cases = parseLeetCodeSamples([
    'Example 1:',
    'Input: nums = [2,7,11,15], target = 9',
    'Output: [0,1]',
    'Explanation: Because nums[0] + nums[1] == 9.',
    '',
    '示例 2：',
    '输入：nums = [3,2,4], target = 6',
    '输出：[1,2]',
    '解释：nums[1] + nums[2] == 6。'
  ].join('\n'));

  assert.deepEqual(cases, [
    {
      name: 'testcase 001',
      input: 'nums = [2,7,11,15], target = 9',
      expectedOutput: '[0,1]',
      source: 'leetcode'
    },
    {
      name: 'testcase 002',
      input: 'nums = [3,2,4], target = 6',
      expectedOutput: '[1,2]',
      source: 'leetcode'
    }
  ]);

  const migrated = fromCapturePayload({
    source: 'https://leetcode.com/problems/two-sum/',
    samples: 'Input: n = 1\nOutput: true\nExplanation: legacy capture'
  }, { now: () => '2026-09-02T01:00:00.000Z' });
  assert.deepEqual(migrated.map(({ name, input, expectedOutput, source, createdAt }) => ({ name, input, expectedOutput, source, createdAt })), [{
    name: 'testcase 001', input: 'n = 1', expectedOutput: 'true', source: 'leetcode', createdAt: '2026-09-02T01:00:00.000Z'
  }]);
});

test('an empty structured list falls back to legacy samples and a parser miss preserves prior captured cases', () => {
  const fallback = fromCapturePayload({
    source: 'https://leetcode.com/problems/example/',
    testCases: [],
    samples: 'Input: n = 7\nOutput: 49'
  });
  assert.deepEqual(fallback.map((item) => ({ name: item.name, input: item.input, expectedOutput: item.expectedOutput })), [{
    name: 'testcase 001', input: 'n = 7', expectedOutput: '49'
  }]);

  const existing = [{
    id: 'leetcode-existing', name: 'testcase 001', input: 'n = 1', expectedOutput: '1', source: 'leetcode', createdAt: '2026-09-01T00:00:00.000Z'
  }];
  assert.deepEqual(
    mergeCaptureTestCases(existing, { source: 'https://leetcode.com/problems/example/', testCases: [], samples: '' }),
    existing,
    'a transient collector miss must not silently erase known examples'
  );
});

test('mergeCaptureTestCases refreshes only LeetCode cases and preserves manual IDs and names', () => {
  const existing = [
    {
      id: 'leetcode-first', name: 'testcase 001', input: 'n = 1', expectedOutput: 'old',
      source: 'leetcode', createdAt: '2026-09-01T00:00:00.000Z'
    },
    {
      id: 'manual-keep', name: 'testcase 002', input: 'n = 99', expectedOutput: 'manual',
      source: 'manual', createdAt: '2026-09-01T01:00:00.000Z'
    },
    {
      id: 'leetcode-stale', name: 'testcase 003', input: 'n = 3', expectedOutput: 'remove me',
      source: 'leetcode', createdAt: '2026-09-01T00:00:00.000Z'
    }
  ];
  const merged = mergeCaptureTestCases(existing, {
    source: 'https://leetcode.com/problems/example/',
    capturedAt: '2026-09-02T00:00:00.000Z',
    testCases: [
      // Same ordinal with changed text: retain the original testcase identity.
      { name: 'testcase 001', input: 'n = 1', expectedOutput: 'updated' },
      // testcase 002 belongs to the preserved manual case, so the new captured
      // example is given an unused name instead of renaming the manual test.
      { name: 'testcase 002', input: 'n = 2', expectedOutput: 'new' }
    ]
  });

  assert.deepEqual(merged.map(({ name, input, expectedOutput, source, createdAt }) => ({ name, input, expectedOutput, source, createdAt })), [
    {
      name: 'testcase 001', input: 'n = 1', expectedOutput: 'updated',
      source: 'leetcode', createdAt: '2026-09-01T00:00:00.000Z'
    },
    {
      name: 'testcase 003', input: 'n = 2', expectedOutput: 'new',
      source: 'leetcode', createdAt: '2026-09-02T00:00:00.000Z'
    },
    {
      name: 'testcase 002', input: 'n = 99', expectedOutput: 'manual',
      source: 'manual', createdAt: '2026-09-01T01:00:00.000Z'
    }
  ]);
  assert.equal(merged[0].id, 'leetcode-first', 'changed captured text keeps the ordinal identity');
  assert.match(merged[1].id, /^leetcode-/);
  assert.notEqual(merged[1].id, 'leetcode-stale', 'samples absent from the new capture are removed');
  assert.equal(merged[2].id, 'manual-keep', 'manual identity is untouched');
});

test('save/load and manual create/delete use testcases.json and stable current testcase names', async () => {
  const folder = await temporaryProblem();
  let id = 0;
  const options = {
    now: () => '2026-09-02T02:00:00.000Z',
    idFactory: (source) => `${source}-generated-${++id}`
  };
  const captured = fromCapturePayload({
    source: 'https://leetcode.cn/problems/two-sum/',
    testCases: [{ input: 'n = 1', expectedOutput: '1' }]
  }, options);
  await saveTestCases(folder, captured, options);
  assert.deepEqual((await loadTestCases(folder, options)).map((item) => item.name), ['testcase 001']);

  const created = await createTestCase(folder, { input: 'n = 2', expectedOutput: '2' }, options);
  assert.equal(created.testCase.name, 'testcase 002');
  assert.equal(created.testCase.source, 'manual');
  assert.equal(created.testCases.length, 2);

  const removed = await deleteTestCase(folder, created.testCase.id, options);
  assert.equal(removed.deleted.name, 'testcase 002');
  assert.deepEqual(removed.testCases.map((item) => item.name), ['testcase 001']);

  const afterDelete = await createTestCase(folder, { input: 'n = 3', expectedOutput: '3' }, options);
  assert.equal(afterDelete.testCase.name, 'testcase 002', 'the next name follows the current highest name');

  const saved = JSON.parse(await fs.readFile(path.join(folder, TEST_CASES_FILE), 'utf8'));
  assert.equal(saved.version, 1);
  assert.equal(saved.testCases.length, 2);
});

test('deleting a captured case persists a tombstone so the next capture does not resurrect it', async () => {
  const folder = await temporaryProblem();
  const payload = {
    source: 'https://leetcode.com/problems/example/',
    testCases: [{ input: 'n = 1', expectedOutput: '1' }]
  };
  const captured = fromCapturePayload(payload, { now: () => '2026-09-02T00:00:00.000Z' });
  await saveTestCases(folder, captured);
  await deleteTestCase(folder, captured[0].id);

  const state = await loadTestCaseState(folder);
  assert.deepEqual(state.testCases, []);
  assert.deepEqual(state.excludedLeetCodeIds, [captured[0].id]);
  assert.deepEqual(
    mergeCaptureTestCases(state.testCases, payload, { excludedLeetCodeIds: state.excludedLeetCodeIds }),
    [],
    'an explicitly deleted page example remains deleted after re-capture'
  );
});

test('captured testcase identity is stable across leetcode.com and leetcode.cn', () => {
  const sharedCase = [{ input: 'n = 1', expectedOutput: '1' }];
  const cn = fromCapturePayload({ source: 'https://leetcode.cn/problems/example/', testCases: sharedCase });
  const com = fromCapturePayload({ source: 'https://www.leetcode.com/problems/example/description/', testCases: sharedCase });
  assert.equal(cn[0].id, com[0].id);
});

test('manual testcase content keeps meaningful whitespace and allows output-only cases', async () => {
  const folder = await temporaryProblem();
  const created = await createTestCase(folder, { input: '', expectedOutput: '  indented result\n' });
  assert.equal(created.testCase.input, '');
  assert.equal(created.testCase.expectedOutput, '  indented result\n');
  assert.deepEqual(
    (await loadTestCases(folder)).map((item) => item.expectedOutput),
    ['  indented result\n']
  );
});

test('delete rejects an unknown id and a missing testcase file reads as an empty list', async () => {
  const folder = await temporaryProblem();
  assert.deepEqual(await loadTestCases(folder), []);
  await assert.rejects(createTestCase(folder, {}), /至少填写测试用例/);
  await assert.rejects(deleteTestCase(folder, 'does-not-exist'), /未找到测试用例/);
});
