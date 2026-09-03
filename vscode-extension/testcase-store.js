'use strict';

// The test-case model deliberately has no vscode dependency.  The sidebar,
// capture receiver, and AI scaffold service can all use the same small API
// without reaching into each other's state.
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const TEST_CASES_FILE = 'testcases.json';
const TEST_CASES_VERSION = 3;
// `leetcode` is retained only to recognize data saved by older extension
// versions.  Those entries came from a brittle page regex and are never used
// as a source for new automatic cases.
const LEETCODE_SOURCE = 'leetcode';
// `ai` means an explicit page example extracted by the user's configured LLM.
// It is distinct from manual input and from legacy raw-DOM `leetcode` data.
const AI_SOURCE = 'ai';
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
  if (value === LEETCODE_SOURCE || value === AI_SOURCE || value === MANUAL_SOURCE) return value;
  return fallback === LEETCODE_SOURCE || fallback === AI_SOURCE ? fallback : MANUAL_SOURCE;
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
  const prefix = source === AI_SOURCE ? AI_SOURCE : source === LEETCODE_SOURCE ? LEETCODE_SOURCE : MANUAL_SOURCE;
  return `${prefix}-${suffix}`;
}

function extractionProblemKey(payload) {
  // Do not include capturedAt or the site host: refreshing the same problem
  // through leetcode.com / leetcode.cn should preserve its captured identity.
  const source = text(payload?.problemUrl || payload?.source);
  const sourceSlug = source.match(/\/problems\/([^/?#]+)/i)?.[1] || '';
  return text(payload?.problemSlug || sourceSlug || source).toLowerCase();
}

function hashedAiIdentity(kind, payload, parts) {
  const contents = [extractionProblemKey(payload), kind, ...parts].join('\u0000');
  const digest = crypto.createHash('sha256').update(contents).digest('hex').slice(0, 16);
  return `${AI_SOURCE}-${kind}-${digest}`;
}

function extractionId(payload, testCase) {
  // Prefer the AI's verified verbatim evidence as identity. Parsing details
  // (for example whitespace or a corrected output representation) can change
  // while the page example is still the same. A deletion tombstone must keep
  // suppressing that same source example after a later re-extraction.
  const evidence = contentText(testCase?.evidence).replace(/\s+/g, ' ').trim();
  // Old records/tests without evidence retain the content-based identity.
  // The identity intentionally has no array position, so reordering examples
  // cannot resurrect a testcase that the user explicitly removed.
  if (evidence) return hashedAiIdentity('evidence', payload, [evidence]);
  return contentExtractionId(payload, testCase);
}

// Evidence is the primary identity because an AI can correct whitespace or
// formatting while referring to the exact same source excerpt.  Persist a
// second content alias too: models may choose a longer/shorter valid evidence
// span on the next extraction, and a deleted testcase must not reappear just
// because that free-form span changed.
function contentExtractionId(payload, testCase) {
  const input = contentText(testCase?.input).replace(/\s+/g, ' ').trim();
  const output = contentText(testCase?.expectedOutput ?? testCase?.output).replace(/\s+/g, ' ').trim();
  return hashedAiIdentity('content', payload, [input, output]);
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
      const aiContentId = source === AI_SOURCE ? text(value.aiContentId) : '';
      return {
        id,
        name,
        input: contentText(value.input),
        expectedOutput: contentText(value.expectedOutput ?? value.output),
        source,
        createdAt: text(value.createdAt) || createdAt,
        ...(aiContentId ? { aiContentId } : {})
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
 * Convert JSON already validated by the AI service into the persisted testcase
 * shape.  It deliberately never reads `payload.testCases` or `payload.samples`:
 * those fields are raw page context, not a trustworthy testcase source.
 */
function fromAiExtraction(payload, extractedValues, options = {}) {
  if (!Array.isArray(extractedValues)) return [];
  const capturedAt = text(payload?.capturedAt) || nowIso(options.now);
  return normalizeTestCases(extractedValues.map((testCase, index) => ({
    input: contentText(testCase?.input),
    expectedOutput: contentText(testCase?.expectedOutput ?? testCase?.output),
    // A model is not allowed to select a persistent id, source, or testcase
    // name.  The extension owns all three so mutations remain deterministic.
    id: extractionId(payload, testCase),
    aiContentId: contentExtractionId(payload, testCase),
    name: testcaseName(index + 1),
    source: AI_SOURCE,
    createdAt: capturedAt
  })), { ...options, defaultSource: AI_SOURCE });
}

/**
 * Backwards-compatible entry point for callers that pass a capture payload.
 * Only `aiTestCases` (written after a successful user-key-backed extraction)
 * is accepted.  Legacy raw DOM `testCases` and `samples` are intentionally
 * ignored, including during metadata migration.
 */
function fromCapturePayload(payload, options = {}) {
  return fromAiExtraction(payload, payload?.aiTestCases, options);
}

/**
 * Merge an AI extraction into the automatic portion of the testcase list.
 * `extractedValues === undefined` means no AI request was made (for example,
 * no key is configured), so existing AI cases remain but legacy raw-DOM cases
 * are dropped.  An explicit empty array means the model found no examples and
 * therefore replaces existing AI cases with zero automatic cases.
 */
function mergeAiExtractedTestCases(existingValues, payload, extractedValues, options = {}) {
  const existing = normalizeTestCases(existingValues, options);
  const manual = existing.filter((testCase) => testCase.source === MANUAL_SOURCE);
  const oldAi = existing.filter((testCase) => testCase.source === AI_SOURCE);
  const excludedAiIds = new Set(normalizeExcludedAiIds(options.excludedAiIds));

  if (extractedValues === undefined) {
    // Never keep legacy `leetcode` values here: they originated from page DOM
    // parsing and must not reappear in the sidebar after this migration.
    return [...oldAi, ...manual];
  }

  // An empty model response is ambiguous: it can mean a problem truly has no
  // examples, but it can also be a transient extraction miss. Preserve prior
  // verified AI cases rather than silently deleting them. A fresh problem
  // still stays empty, and callers may re-extract at any time.
  if (!extractedValues.length && oldAi.length) return [...oldAi, ...manual];

  const incoming = fromAiExtraction(payload, extractedValues, options)
    .filter((testCase) => !excludedAiIds.has(testCase.id) && !excludedAiIds.has(testCase.aiContentId));
  const oldById = new Map(oldAi.map((testCase) => [testCase.id, testCase]));
  const oldByContentIdentity = new Map(oldAi
    .filter((testCase) => testCase.aiContentId)
    .map((testCase) => [testCase.aiContentId, testCase]));
  const oldByName = new Map(oldAi.map((testCase) => [testCase.name, testCase]));
  const usedIds = new Set(manual.map((testCase) => testCase.id));
  const usedNumbers = new Set(manual.map((testCase) => testcaseNumber(testCase.name)).filter(Boolean));
  let fallbackNumber = 1;

  const extracted = incoming.map((incomingCase) => {
    const previous = oldById.get(incomingCase.id)
      || oldByContentIdentity.get(incomingCase.aiContentId)
      || oldByName.get(incomingCase.name);
    const id = uniqueId(previous?.id || incomingCase.id, AI_SOURCE, usedIds, options.idFactory);
    usedIds.add(id);
    const name = normalizedName(previous?.name || incomingCase.name, usedNumbers, fallbackNumber);
    fallbackNumber = Math.max(fallbackNumber, testcaseNumber(name) + 1);
    return {
      id,
      name,
      input: incomingCase.input,
      expectedOutput: incomingCase.expectedOutput,
      source: AI_SOURCE,
      createdAt: previous?.createdAt || incomingCase.createdAt,
      aiContentId: incomingCase.aiContentId
    };
  });

  return [...extracted, ...manual];
}

// Retain the old export name while making the safe, AI-only behavior the
// default for any caller that has not yet moved to the explicit helper.
function mergeCaptureTestCases(existingValues, payload, options = {}) {
  return mergeAiExtractedTestCases(existingValues, payload, payload?.aiTestCases, options);
}

function testCasesPath(problemFolder) {
  if (typeof problemFolder !== 'string' || !problemFolder.trim()) {
    throw new Error('缺少题目目录，无法读取测试用例。');
  }
  return path.join(problemFolder, TEST_CASES_FILE);
}

function normalizeExcludedIds(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => text(value)).filter(Boolean))];
}

function normalizeExcludedAiIds(values) {
  return normalizeExcludedIds(values);
}

function normalizeExcludedLeetCodeIds(values) {
  return normalizeExcludedIds(values);
}

async function loadTestCaseState(problemFolder, options = {}) {
  const file = testCasesPath(problemFolder);
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return { testCases: [], excludedAiIds: [], excludedLeetCodeIds: [] };
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
    // AI-extracted cases are tombstoned so a later extraction does not silently
    // resurrect a test the user intentionally removed.  Keep legacy tombstones
    // solely to safely read older files.
    excludedAiIds: normalizeExcludedAiIds(Array.isArray(parsed) ? [] : parsed?.excludedAiIds),
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
  // deletion tombstones.  Supplying a list explicitly allows the delete path
  // to extend that list; the other list is still retained from disk.
  const hasAiIds = Object.prototype.hasOwnProperty.call(options, 'excludedAiIds');
  const hasLegacyIds = Object.prototype.hasOwnProperty.call(options, 'excludedLeetCodeIds');
  const existingState = hasAiIds && hasLegacyIds ? null : await loadTestCaseState(problemFolder, options);
  const excludedAiIds = normalizeExcludedAiIds(hasAiIds ? options.excludedAiIds : existingState.excludedAiIds);
  const excludedLeetCodeIds = normalizeExcludedLeetCodeIds(hasLegacyIds ? options.excludedLeetCodeIds : existingState.excludedLeetCodeIds);
  const document = {
    version: TEST_CASES_VERSION,
    updatedAt: nowIso(options.now),
    testCases,
    excludedAiIds,
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
    excludedAiIds: state.excludedAiIds,
    excludedLeetCodeIds: state.excludedLeetCodeIds
  });
  return { testCase: testCases.find((item) => item.id === testCase.id), testCases };
}

/**
 * Change editable test data without allowing a webview to alter testcase
 * identity, ordering, or source metadata.  Editing an AI/legacy case makes it
 * manual so a later automatic extraction cannot overwrite the user's work.
 */
async function updateTestCase(problemFolder, id, draft = {}, options = {}) {
  const requestedId = text(id);
  if (!requestedId) throw new Error('缺少要更新的测试用例 ID。');
  if (!draft || typeof draft !== 'object') throw new TypeError('测试用例更新内容无效。');
  const state = await loadTestCaseState(problemFolder, options);
  const index = state.testCases.findIndex((testCase) => testCase.id === requestedId);
  if (index < 0) throw new Error(`未找到测试用例：${requestedId}`);

  const current = state.testCases[index];
  const hasInput = Object.prototype.hasOwnProperty.call(draft, 'input');
  const hasOutput = Object.prototype.hasOwnProperty.call(draft, 'expectedOutput') || Object.prototype.hasOwnProperty.call(draft, 'output');
  if (hasInput && typeof draft.input !== 'string') throw new TypeError('测试用例输入必须是文本。');
  const outputValue = Object.prototype.hasOwnProperty.call(draft, 'expectedOutput') ? draft.expectedOutput : draft.output;
  if (hasOutput && typeof outputValue !== 'string') throw new TypeError('测试用例预期输出必须是文本。');

  const next = {
    ...current,
    input: hasInput ? contentText(draft.input) : current.input,
    expectedOutput: hasOutput ? contentText(outputValue) : current.expectedOutput,
    source: MANUAL_SOURCE
  };
  // An edited AI case is now user-owned.  Tombstone its original automatic
  // identities so an unchanged future extraction does not add a duplicate
  // next to the edited manual testcase even if the model chooses a different
  // valid evidence span next time.
  const excludedAiIds = current.source === AI_SOURCE
    ? normalizeExcludedAiIds([...state.excludedAiIds, current.id, current.aiContentId])
    : state.excludedAiIds;
  const values = [...state.testCases];
  values[index] = next;
  const testCases = await saveTestCases(problemFolder, values, {
    ...options,
    excludedAiIds,
    excludedLeetCodeIds: state.excludedLeetCodeIds
  });
  return { previous: current, testCase: testCases.find((testCase) => testCase.id === requestedId), testCases };
}

async function deleteTestCase(problemFolder, id, options = {}) {
  const requestedId = text(id);
  if (!requestedId) throw new Error('缺少要删除的测试用例 ID。');
  const state = await loadTestCaseState(problemFolder, options);
  const current = state.testCases;
  const index = current.findIndex((testCase) => testCase.id === requestedId);
  if (index < 0) throw new Error(`未找到测试用例：${requestedId}`);
  const [deleted] = current.splice(index, 1);
  const excludedAiIds = deleted.source === AI_SOURCE
    ? normalizeExcludedAiIds([...state.excludedAiIds, deleted.id, deleted.aiContentId])
    : state.excludedAiIds;
  const excludedLeetCodeIds = deleted.source === LEETCODE_SOURCE
    ? normalizeExcludedLeetCodeIds([...state.excludedLeetCodeIds, deleted.id])
    : state.excludedLeetCodeIds;
  const testCases = await saveTestCases(problemFolder, current, {
    ...options,
    excludedAiIds,
    excludedLeetCodeIds
  });
  return { deleted, testCases };
}

module.exports = {
  TEST_CASES_FILE,
  TEST_CASES_VERSION,
  LEETCODE_SOURCE,
  AI_SOURCE,
  MANUAL_SOURCE,
  testcaseName,
  testcaseNumber,
  nextTestcaseName,
  normalizeTestCase,
  normalizeTestCases,
  parseLeetCodeSamples,
  fromAiExtraction,
  fromCapturePayload,
  mergeAiExtractedTestCases,
  mergeCaptureTestCases,
  normalizeExcludedAiIds,
  normalizeExcludedLeetCodeIds,
  loadTestCaseState,
  loadTestCases,
  saveTestCases,
  createTestCase,
  updateTestCase,
  deleteTestCase
};
