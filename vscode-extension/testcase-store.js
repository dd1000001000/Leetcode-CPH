'use strict';

// The test-case model deliberately has no vscode dependency.  The sidebar,
// capture receiver, and AI scaffold service can all use the same small API
// without reaching into each other's state.
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const TEST_CASES_FILE = 'testcases.json';
const TEST_CASES_VERSION = 1;
const LEETCODE_SOURCE = 'leetcode';
const MANUAL_SOURCE = 'manual';
const TEST_CASE_NAME_RE = /^testcase\s+(\d+)$/i;

function text(value) {
  return value == null ? '' : String(value).replace(/\r\n?/g, '\n').trim();
}

// Input and expected-output text are data, rather than identifiers.  Do not
// trim it: an assertion may intentionally distinguish an empty string from a
// space, or include indentation/newlines in its expected result.
function contentText(value) {
  return value == null ? '' : String(value).replace(/\r\n?/g, '\n');
}

function nowIso(now) {
  const value = typeof now === 'function' ? now() : new Date().toISOString();
  return value instanceof Date ? value.toISOString() : String(value);
}

function caseSource(value, fallback = MANUAL_SOURCE) {
  if (value === LEETCODE_SOURCE || value === MANUAL_SOURCE) return value;
  return fallback === LEETCODE_SOURCE ? LEETCODE_SOURCE : MANUAL_SOURCE;
}

function testcaseName(number) {
  return `testcase ${String(Math.max(1, Number(number) || 1)).padStart(3, '0')}`;
}

function testcaseNumber(name) {
  const match = text(name).match(TEST_CASE_NAME_RE);
  const value = Number(match?.[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function newId(source) {
  const suffix = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString('hex');
  return `${source === LEETCODE_SOURCE ? LEETCODE_SOURCE : MANUAL_SOURCE}-${suffix}`;
}

function captureId(payload, index, testCase) {
  // Do not include capturedAt or the site host: refreshing the same problem
  // through leetcode.com / leetcode.cn should preserve its captured identity.
  const source = text(payload?.problemUrl || payload?.source);
  const sourceSlug = source.match(/\/problems\/([^/?#]+)/i)?.[1] || '';
  const problem = text(payload?.problemSlug || sourceSlug || source).toLowerCase();
  const contents = `${problem}\u0000${contentText(testCase?.input)}\u0000${contentText(testCase?.expectedOutput ?? testCase?.output)}\u0000${index}`;
  const digest = crypto.createHash('sha256').update(contents).digest('hex').slice(0, 16);
  return `${LEETCODE_SOURCE}-${digest}`;
}

function uniqueId(preferred, source, usedIds, idFactory) {
  const create = typeof idFactory === 'function' ? idFactory : newId;
  let candidate = text(preferred) || text(create(source));
  if (!candidate) candidate = newId(source);
  if (!usedIds.has(candidate)) return candidate;
  let attempt = 2;
  const base = candidate;
  do {
    candidate = `${base}-${attempt}`;
    attempt += 1;
  } while (usedIds.has(candidate));
  return candidate;
}

function normalizedName(value, usedNumbers, fallback) {
  let number = testcaseNumber(value);
  if (!number || usedNumbers.has(number)) {
    number = Math.max(1, fallback);
    while (usedNumbers.has(number)) number += 1;
  }
  usedNumbers.add(number);
  return testcaseName(number);
}

/**
 * Normalize a list into the persisted testcase shape.  Names are intentionally
 * generated as "testcase 001", "testcase 002", ... so the AI scaffold has a
 * stable human-readable target.  The array order is retained.
 */
function normalizeTestCases(values, options = {}) {
  if (!Array.isArray(values)) return [];
  const usedIds = new Set();
  const usedNumbers = new Set();
  let fallbackNumber = 1;
  const defaultSource = caseSource(options.defaultSource, MANUAL_SOURCE);
  const createdAt = nowIso(options.now);

  return values
    .filter((value) => value && typeof value === 'object')
    .map((value) => {
      const source = caseSource(value.source, defaultSource);
      const name = normalizedName(value.name, usedNumbers, fallbackNumber);
      fallbackNumber = Math.max(fallbackNumber, testcaseNumber(name) + 1);
      const id = uniqueId(value.id, source, usedIds, options.idFactory);
      usedIds.add(id);
      return {
        id,
        name,
        input: contentText(value.input),
        expectedOutput: contentText(value.expectedOutput ?? value.output),
        source,
        createdAt: text(value.createdAt) || createdAt
      };
    });
}

function normalizeTestCase(value, options = {}) {
  return normalizeTestCases([value], options)[0];
}

function nextTestcaseName(testCases) {
  const lastNumber = (Array.isArray(testCases) ? testCases : [])
    .reduce((max, testCase) => Math.max(max, testcaseNumber(testCase?.name)), 0);
  return testcaseName(lastNumber + 1);
}

/**
 * Parse legacy `samples` strings saved by versions before structured
 * `payload.testCases` existed.  It intentionally preserves the input/output
 * text rather than attempting to interpret arrays, strings, linked lists, or
 * any other language-specific LeetCode notation.
 */
function parseLeetCodeSamples(samples) {
  const source = text(samples);
  if (!source) return [];
  const inputMarker = /(?:^|\n)\s*(?:Input|输入)\s*[：:]\s*/gim;
  const outputMarker = /(?:^|\n)\s*(?:Output|输出)\s*[：:]\s*/gim;
  const outputEndMarker = /(?:^|\n)\s*(?:(?:Explanation|Constraints?|Follow[- ]?up|Notes?|Note|Example)\b|(?:解释|约束条件|提示|进阶|注意|示例)\s*[：:]|(?:Input|输入)\s*[：:])/gim;
  const inputs = [...source.matchAll(inputMarker)];
  const cases = [];

  for (let index = 0; index < inputs.length; index += 1) {
    const inputMatch = inputs[index];
    const inputStart = inputMatch.index + inputMatch[0].length;
    const nextInputStart = index + 1 < inputs.length ? inputs[index + 1].index : source.length;
    outputMarker.lastIndex = inputStart;
    const outputMatch = outputMarker.exec(source);
    if (!outputMatch || outputMatch.index >= nextInputStart) continue;

    const outputStart = outputMatch.index + outputMatch[0].length;
    outputEndMarker.lastIndex = outputStart;
    const endMatch = outputEndMarker.exec(source);
    const outputEnd = endMatch && endMatch.index < nextInputStart ? endMatch.index : nextInputStart;
    const input = text(source.slice(inputStart, outputMatch.index));
    const expectedOutput = text(source.slice(outputStart, outputEnd));
    if (!input && !expectedOutput) continue;
    cases.push({
      name: testcaseName(cases.length + 1),
      input,
      expectedOutput,
      source: LEETCODE_SOURCE
    });
  }
  return cases;
}

/**
 * Convert a page-collector payload into canonical test cases.  New captures
 * send structured `testCases`; old metadata with only `samples` is migrated
 * automatically so users do not lose their existing problems.
 */
function fromCapturePayload(payload, options = {}) {
  // Some page layouts expose legacy samples even when the structured parser
  // produces an empty array.  Prefer non-empty structured data, then recover
  // from samples rather than silently treating a transient parser miss as
  // proof that a problem has no examples.
  const structured = Array.isArray(payload?.testCases) ? payload.testCases : [];
  const raw = structured.length ? structured : parseLeetCodeSamples(payload?.samples);
  const capturedAt = text(payload?.capturedAt) || nowIso(options.now);
  return normalizeTestCases(raw.map((testCase, index) => ({
    ...testCase,
    id: text(testCase?.id) || captureId(payload, index, testCase),
    name: text(testCase?.name) || testcaseName(index + 1),
    source: LEETCODE_SOURCE,
    createdAt: text(testCase?.createdAt) || capturedAt
  })), { ...options, defaultSource: LEETCODE_SOURCE });
}

/**
 * Replace the captured LeetCode portion of a testcase list while retaining
 * every manually-created case.  Matching captured cases keep their existing
 * id/name/createdAt first by stable capture id, then by their testcase number
 * (so a changed example in position 001 updates testcase 001 instead of
 * needlessly deleting and recreating its AI scaffold block).
 *
 * The function is pure: callers can review/generate a scaffold from its
 * result before persisting it with saveTestCases().
 */
function mergeCaptureTestCases(existingValues, payload, options = {}) {
  const existing = normalizeTestCases(existingValues, options);
  const rawIncoming = fromCapturePayload(payload, options);
  const excludedLeetCodeIds = new Set(normalizeExcludedLeetCodeIds(options.excludedLeetCodeIds));
  const incoming = rawIncoming.filter((testCase) => !excludedLeetCodeIds.has(testCase.id));
  const manual = existing.filter((testCase) => testCase.source === MANUAL_SOURCE);
  const oldCaptured = existing.filter((testCase) => testCase.source === LEETCODE_SOURCE);

  // A capture with no recognizable Input/Output pair is normally a page
  // layout/loading problem, not evidence that every previously displayed
  // example disappeared.  Keep the last known captured cases in that state.
  // If rawIncoming was non-empty but all of it was explicitly deleted by the
  // user, we intentionally continue with an empty incoming list instead.
  if (!rawIncoming.length && oldCaptured.length) return existing;

  const oldById = new Map(oldCaptured.map((testCase) => [testCase.id, testCase]));
  const oldByName = new Map(oldCaptured.map((testCase) => [testCase.name, testCase]));
  const usedIds = new Set(manual.map((testCase) => testCase.id));
  const usedNumbers = new Set(manual.map((testCase) => testcaseNumber(testCase.name)).filter(Boolean));
  let fallbackNumber = 1;

  const captured = incoming.map((incomingCase) => {
    const previous = oldById.get(incomingCase.id) || oldByName.get(incomingCase.name);
    const sourceId = previous?.id || incomingCase.id;
    const id = uniqueId(sourceId, LEETCODE_SOURCE, usedIds, options.idFactory);
    usedIds.add(id);
    const preferredName = previous?.name || incomingCase.name;
    const name = normalizedName(preferredName, usedNumbers, fallbackNumber);
    fallbackNumber = Math.max(fallbackNumber, testcaseNumber(name) + 1);
    return {
      id,
      name,
      input: incomingCase.input,
      expectedOutput: incomingCase.expectedOutput,
      source: LEETCODE_SOURCE,
      createdAt: previous?.createdAt || incomingCase.createdAt
    };
  });

  // Captured cases intentionally come first in UI order, followed by stable
  // manual cases.  All IDs/names are unique at this point and no normalizer is
  // invoked again (which could otherwise renumber a preserved manual case).
  return [...captured, ...manual];
}

function testCasesPath(problemFolder) {
  if (typeof problemFolder !== 'string' || !problemFolder.trim()) {
    throw new Error('缺少题目目录，无法读取测试用例。');
  }
  return path.join(problemFolder, TEST_CASES_FILE);
}

function normalizeExcludedLeetCodeIds(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => text(value)).filter(Boolean))];
}

async function loadTestCaseState(problemFolder, options = {}) {
  const file = testCasesPath(problemFolder);
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return { testCases: [], excludedLeetCodeIds: [] };
    if (error instanceof SyntaxError) {
      throw new Error(`无法读取 ${TEST_CASES_FILE}：文件不是有效 JSON。`);
    }
    throw error;
  }
  // Accept an early array-only format as well as the versioned object.  This
  // makes future migrations inexpensive and avoids a breaking change for users.
  const values = Array.isArray(parsed) ? parsed : parsed?.testCases;
  if (!Array.isArray(values)) {
    throw new Error(`无法读取 ${TEST_CASES_FILE}：缺少 testCases 数组。`);
  }
  return {
    testCases: normalizeTestCases(values, options),
    // Deleted LeetCode examples are tombstoned so a later page re-capture
    // does not silently resurrect a test the user intentionally removed.
    excludedLeetCodeIds: normalizeExcludedLeetCodeIds(Array.isArray(parsed) ? [] : parsed?.excludedLeetCodeIds)
  };
}

async function loadTestCases(problemFolder, options = {}) {
  return (await loadTestCaseState(problemFolder, options)).testCases;
}

async function saveTestCases(problemFolder, values, options = {}) {
  const file = testCasesPath(problemFolder);
  const testCases = normalizeTestCases(values, options);
  // Callers that only replace visible cases should not accidentally erase
  // capture-deletion tombstones.  Supplying the option explicitly allows the
  // delete path to extend that list.
  const existingState = Object.prototype.hasOwnProperty.call(options, 'excludedLeetCodeIds')
    ? null
    : await loadTestCaseState(problemFolder, options);
  const excludedLeetCodeIds = normalizeExcludedLeetCodeIds(
    Object.prototype.hasOwnProperty.call(options, 'excludedLeetCodeIds')
      ? options.excludedLeetCodeIds
      : existingState.excludedLeetCodeIds
  );
  const document = {
    version: TEST_CASES_VERSION,
    updatedAt: nowIso(options.now),
    testCases,
    excludedLeetCodeIds
  };
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Write then rename so a VS Code crash never leaves a half-written JSON
  // document for the sidebar to parse on its next refresh.
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, file);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
  return testCases;
}

async function createTestCase(problemFolder, draft = {}, options = {}) {
  const values = draft && typeof draft === 'object' ? draft : {};
  if (!contentText(values.input) && !contentText(values.expectedOutput ?? values.output)) {
    throw new Error('请至少填写测试用例的输入或预期输出。');
  }
  const state = await loadTestCaseState(problemFolder, options);
  const current = state.testCases;
  const testCase = normalizeTestCase({
    ...values,
    // Manual additions use the next currently available testcase number.
    // Existing cases are never renamed; a number can be reused only after its
    // prior testcase has been deliberately deleted from both data and scaffold.
    name: nextTestcaseName(current),
    source: MANUAL_SOURCE,
    createdAt: text(values.createdAt) || nowIso(options.now)
  }, { ...options, defaultSource: MANUAL_SOURCE });
  let id = testCase.id;
  if (current.some((item) => item.id === id)) {
    let index = 2;
    const base = id;
    while (current.some((item) => item.id === id)) {
      id = `${base}-${index}`;
      index += 1;
    }
    testCase.id = id;
  }
  const testCases = await saveTestCases(problemFolder, [...current, testCase], {
    ...options,
    excludedLeetCodeIds: state.excludedLeetCodeIds
  });
  return { testCase: testCases.find((item) => item.id === testCase.id), testCases };
}

async function deleteTestCase(problemFolder, id, options = {}) {
  const requestedId = text(id);
  if (!requestedId) throw new Error('缺少要删除的测试用例 ID。');
  const state = await loadTestCaseState(problemFolder, options);
  const current = state.testCases;
  const index = current.findIndex((testCase) => testCase.id === requestedId);
  if (index < 0) throw new Error(`未找到测试用例：${requestedId}`);
  const [deleted] = current.splice(index, 1);
  const excludedLeetCodeIds = deleted.source === LEETCODE_SOURCE
    ? normalizeExcludedLeetCodeIds([...state.excludedLeetCodeIds, deleted.id])
    : state.excludedLeetCodeIds;
  const testCases = await saveTestCases(problemFolder, current, {
    ...options,
    excludedLeetCodeIds
  });
  return { deleted, testCases };
}

module.exports = {
  TEST_CASES_FILE,
  TEST_CASES_VERSION,
  LEETCODE_SOURCE,
  MANUAL_SOURCE,
  testcaseName,
  testcaseNumber,
  nextTestcaseName,
  normalizeTestCase,
  normalizeTestCases,
  parseLeetCodeSamples,
  fromCapturePayload,
  mergeCaptureTestCases,
  normalizeExcludedLeetCodeIds,
  loadTestCaseState,
  loadTestCases,
  saveTestCases,
  createTestCase,
  deleteTestCase
};
