'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  TEST_CASES_FILE,
  TEST_CASES_VERSION,
  AI_SOURCE,
  fromAiExtraction,
  fromCapturePayload,
  mergeAiExtractedTestCases,
  mergeCaptureTestCases,
  loadTestCaseState,
  loadTestCases,
  saveTestCases,
  createTestCase,
  updateTestCase,
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

test('only validated AI extraction output becomes automatic testcase data', () => {
  const rawPayload = {
    source: 'https://leetcode.cn/problems/two-sum/',
    capturedAt: '2026-09-02T00:00:00.000Z',
    testCases: [{ input: 'incorrect raw DOM input', expectedOutput: 'incorrect raw DOM output' }],
    samples: 'Input: also raw\nOutput: ignored'
  };

  assert.deepEqual(fromCapturePayload(rawPayload), [], 'raw DOM fields must never seed testcases');
  const cases = fromAiExtraction(rawPayload, [
    { name: 'ignored model name', id: 'ignored-model-id', input: 'nums = [2,7,11,15], target = 9', expectedOutput: '[0,1]' },
    { input: 'nums = [3,2,4], target = 6', output: '[1,2]' }
  ]);

  assert.deepEqual(cases.map(({ name, input, expectedOutput, source, createdAt }) => ({ name, input, expectedOutput, source, createdAt })), [
    {
      name: 'testcase 001',
      input: 'nums = [2,7,11,15], target = 9',
      expectedOutput: '[0,1]',
      source: AI_SOURCE,
      createdAt: '2026-09-02T00:00:00.000Z'
    },
    {
      name: 'testcase 002',
      input: 'nums = [3,2,4], target = 6',
      expectedOutput: '[1,2]',
      source: AI_SOURCE,
      createdAt: '2026-09-02T00:00:00.000Z'
    }
  ]);
  assert.match(cases[0].id, /^ai-/);
  assert.notEqual(cases[0].id, cases[1].id);
});

test('AI merge preserves manual cases, drops legacy raw cases, and distinguishes no key from empty extraction', () => {
  const existing = [
    { id: 'ai-first', name: 'testcase 001', input: 'n = 1', expectedOutput: 'old', source: AI_SOURCE, createdAt: '2026-09-01T00:00:00.000Z' },
    { id: 'manual-keep', name: 'testcase 002', input: 'n = 99', expectedOutput: 'manual', source: 'manual', createdAt: '2026-09-01T01:00:00.000Z' },
    { id: 'leetcode-legacy', name: 'testcase 003', input: 'n = 3', expectedOutput: 'inaccurate raw data', source: 'leetcode', createdAt: '2026-09-01T00:00:00.000Z' }
  ];
  const payload = { source: 'https://leetcode.com/problems/example/', capturedAt: '2026-09-02T00:00:00.000Z' };

  const noKey = mergeAiExtractedTestCases(existing, payload, undefined);
  assert.deepEqual(noKey.map((item) => item.id), ['ai-first', 'manual-keep']);

  const emptyExtraction = mergeAiExtractedTestCases(existing, payload, []);
  assert.deepEqual(emptyExtraction.map((item) => item.id), ['ai-first', 'manual-keep']);

  const merged = mergeAiExtractedTestCases(existing, payload, [
    { input: 'n = 1', expectedOutput: 'updated' },
    { input: 'n = 2', expectedOutput: 'new' }
  ]);
  assert.deepEqual(merged.map(({ name, input, expectedOutput, source, createdAt }) => ({ name, input, expectedOutput, source, createdAt })), [
    { name: 'testcase 001', input: 'n = 1', expectedOutput: 'updated', source: AI_SOURCE, createdAt: '2026-09-01T00:00:00.000Z' },
    { name: 'testcase 003', input: 'n = 2', expectedOutput: 'new', source: AI_SOURCE, createdAt: '2026-09-02T00:00:00.000Z' },
    { name: 'testcase 002', input: 'n = 99', expectedOutput: 'manual', source: 'manual', createdAt: '2026-09-01T01:00:00.000Z' }
  ]);
  assert.equal(merged[0].id, 'ai-first');
  assert.match(merged[1].id, /^ai-/);
  assert.equal(merged[2].id, 'manual-keep');

  assert.deepEqual(
    mergeCaptureTestCases(existing, { ...payload, testCases: [{ input: 'raw', expectedOutput: 'ignored' }] }),
    noKey,
    'the compatibility wrapper also ignores raw DOM testCases'
  );
});

test('save/load, blank manual creation, and manual update keep stable testcase names', async () => {
  const folder = await temporaryProblem();
  let id = 0;
  const options = {
    now: () => '2026-09-02T02:00:00.000Z',
    idFactory: (source) => `${source}-generated-${++id}`
  };
  const extracted = fromAiExtraction(
    { source: 'https://leetcode.cn/problems/two-sum/' },
    [{ input: 'n = 1', expectedOutput: '1' }],
    options
  );
  await saveTestCases(folder, extracted, options);
  assert.deepEqual((await loadTestCases(folder, options)).map((item) => item.name), ['testcase 001']);

  const created = await createTestCase(folder, {}, options);
  assert.equal(created.testCase.name, 'testcase 002');
  assert.equal(created.testCase.source, 'manual');
  assert.equal(created.testCase.pendingScaffold, true);
  assert.deepEqual({ input: created.testCase.input, expectedOutput: created.testCase.expectedOutput }, { input: '', expectedOutput: '' });

  const updated = await updateTestCase(folder, created.testCase.id, { input: 'n = 2', expectedOutput: '2' }, options);
  assert.equal(updated.testCase.name, 'testcase 002');
  assert.equal(updated.testCase.input, 'n = 2');
  assert.equal(updated.testCase.expectedOutput, '2');
  assert.equal(updated.previous.pendingScaffold, true);
  assert.equal(updated.testCase.pendingScaffold, false);

  const removed = await deleteTestCase(folder, created.testCase.id, options);
  assert.equal(removed.deleted.name, 'testcase 002');
  assert.deepEqual(removed.testCases.map((item) => item.name), ['testcase 001']);

  const afterDelete = await createTestCase(folder, { input: 'n = 3', expectedOutput: '3' }, options);
  assert.equal(afterDelete.testCase.name, 'testcase 002', 'the next name follows the current highest name');

  const saved = JSON.parse(await fs.readFile(path.join(folder, TEST_CASES_FILE), 'utf8'));
  assert.equal(saved.version, TEST_CASES_VERSION);
  assert.equal(saved.testCases.length, 2);
  assert.deepEqual(saved.excludedAiIds, []);
});

test('deleting an AI case persists a tombstone and it does not reappear after re-extraction', async () => {
  const folder = await temporaryProblem();
  const payload = { source: 'https://leetcode.com/problems/example/' };
  const extractedValues = [{ input: 'n = 1', expectedOutput: '1' }];
  const extracted = fromAiExtraction(payload, extractedValues, { now: () => '2026-09-02T00:00:00.000Z' });
  await saveTestCases(folder, extracted);
  await deleteTestCase(folder, extracted[0].id);

  const state = await loadTestCaseState(folder);
  assert.deepEqual(state.testCases, []);
  assert.deepEqual(state.excludedAiIds, [extracted[0].id]);
  assert.deepEqual(
    mergeAiExtractedTestCases(state.testCases, payload, extractedValues, { excludedAiIds: state.excludedAiIds }),
    [],
    'an explicitly deleted AI example remains deleted after a re-extraction'
  );
});

test('a deletion tombstone remains stable when the AI corrects parsed fields from the same evidence', async () => {
  const folder = await temporaryProblem();
  const payload = { source: 'https://leetcode.com/problems/example/' };
  const firstExtraction = [{ input: 'n = 1', expectedOutput: '1', evidence: 'Input: n = 1 Output: 1' }];
  const extracted = fromAiExtraction(payload, firstExtraction);
  await saveTestCases(folder, extracted);
  await deleteTestCase(folder, extracted[0].id);

  const state = await loadTestCaseState(folder);
  const correctedExtraction = [{ input: 'n=1', expectedOutput: '1', evidence: 'Input: n = 1\nOutput: 1' }];
  assert.deepEqual(
    mergeAiExtractedTestCases(state.testCases, payload, correctedExtraction, { excludedAiIds: state.excludedAiIds }),
    [],
    'the same verified page example stays deleted even if AI parsing text changes'
  );
});

test('a deletion tombstone also survives a longer valid AI evidence span', async () => {
  const folder = await temporaryProblem();
  const payload = { source: 'https://leetcode.com/problems/example/' };
  const firstExtraction = [{
    input: 'n = 1', expectedOutput: '1', evidence: 'Input: n = 1\nOutput: 1'
  }];
  const extracted = fromAiExtraction(payload, firstExtraction);
  await saveTestCases(folder, extracted);
  await deleteTestCase(folder, extracted[0].id);

  const state = await loadTestCaseState(folder);
  const longerEvidence = [{
    input: 'n = 1', expectedOutput: '1', evidence: 'Example 1:\nInput: n = 1\nOutput: 1'
  }];
  assert.deepEqual(
    mergeAiExtractedTestCases(state.testCases, payload, longerEvidence, { excludedAiIds: state.excludedAiIds }),
    [],
    'choosing a different valid evidence span must not revive a deleted source example'
  );
});

test('editing an AI case makes it manual and tombstones its former automatic identity', async () => {
  const folder = await temporaryProblem();
  const payload = { source: 'https://leetcode.com/problems/example/' };
  const extractedValues = [{ input: 'n = 1', expectedOutput: '1' }];
  const extracted = fromAiExtraction(payload, extractedValues);
  await saveTestCases(folder, extracted);

  const updated = await updateTestCase(folder, extracted[0].id, { input: 'n = 2', expectedOutput: '4' });
  assert.equal(updated.testCase.source, 'manual');
  const state = await loadTestCaseState(folder);
  assert.deepEqual(state.excludedAiIds, [extracted[0].id]);
  assert.deepEqual(
    mergeAiExtractedTestCases(state.testCases, payload, extractedValues, { excludedAiIds: state.excludedAiIds })
      .map(({ source, input, expectedOutput }) => ({ source, input, expectedOutput })),
    [{ source: 'manual', input: 'n = 2', expectedOutput: '4' }]
  );
});

test('AI testcase identity is stable across leetcode.com and leetcode.cn', () => {
  const sharedCase = [{ input: 'n = 1', expectedOutput: '1' }];
  const cn = fromAiExtraction({ source: 'https://leetcode.cn/problems/example/' }, sharedCase);
  const com = fromAiExtraction({ source: 'https://www.leetcode.com/problems/example/description/' }, sharedCase);
  assert.equal(cn[0].id, com[0].id);
});

test('manual testcase content keeps meaningful whitespace and allows output-only cases', async () => {
  const folder = await temporaryProblem();
  const created = await createTestCase(folder, { input: '', expectedOutput: '  indented result\n' });
  assert.equal(created.testCase.input, '');
  assert.equal(created.testCase.expectedOutput, '  indented result\n');
  assert.deepEqual((await loadTestCases(folder)).map((item) => item.expectedOutput), ['  indented result\n']);
});

test('update/delete reject an unknown testcase and a missing file reads as an empty list', async () => {
  const folder = await temporaryProblem();
  assert.deepEqual(await loadTestCases(folder), []);
  await assert.rejects(updateTestCase(folder, 'does-not-exist', {}), /未找到测试用例/);
  await assert.rejects(deleteTestCase(folder, 'does-not-exist'), /未找到测试用例/);
});
