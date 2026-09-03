'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'edge-extension', 'page-collector.js'), 'utf8');

function collectFromEnvironment({ preBlocks = [], document: documentOverrides = {}, monaco } = {}) {
  const sandbox = {
    console,
    URL,
    decodeURIComponent,
    getComputedStyle: () => ({ visibility: 'visible' }),
    location: {
      href: 'https://leetcode.com/problems/two-sum/description/',
      pathname: '/problems/two-sum/description/',
      protocol: 'https:',
      host: 'leetcode.com'
    },
    document: {
      title: 'Two Sum - LeetCode',
      querySelector: () => null,
      querySelectorAll: (selector) => selector === 'pre'
        ? preBlocks.map((innerText) => ({ innerText }))
        : [],
      ...documentOverrides
    },
    HTMLTextAreaElement: function HTMLTextAreaElement() {},
    Event: function Event() {}
  };
  if (monaco) sandbox.monaco = monaco;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'page-collector.js' });
  return sandbox.window.__LEETCODE_CPH_COLLECT__();
}

function collectFromPreBlocks(preBlocks) {
  return collectFromEnvironment({ preBlocks });
}

test('page collector preserves raw examples as AI context but never emits parsed testcase data', () => {
  const payload = collectFromPreBlocks([
    'Example 1:\nInput: nums = [2,7,11,15], target = 9\nOutput: [0,1]\nExplanation: nums[0] + nums[1] == 9.',
    '示例 2：\n输入：nums = [3,2,4], target = 6\n输出：[1,2]\n解释：nums[1] + nums[2] == 6。'
  ]);

  assert.match(payload.samples, /Explanation/);
  assert.match(payload.samples, /示例 2/);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'testCases'), false);
});

test('page collector has no synthetic testcase list when a page has no examples', () => {
  const payload = collectFromPreBlocks([]);
  assert.equal(payload.samples, '');
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'testCases'), false);
});

test('page collector prefers the currently focused Monaco editor over other models', () => {
  const backgroundModel = {
    getValue: () => '// unrelated and deliberately longer Monaco model\nconst hidden = true;\n'
  };
  const focusedModel = {
    getValue: () => 'class Solution:\n    pass\n'
  };
  const payload = collectFromEnvironment({
    monaco: {
      editor: {
        getEditors: () => [
          {
            hasTextFocus: () => false,
            getDomNode: () => null,
            getModel: () => backgroundModel
          },
          {
            hasTextFocus: () => true,
            getDomNode: () => null,
            getModel: () => focusedModel
          }
        ],
        getModels: () => [backgroundModel, focusedModel]
      }
    }
  });

  assert.equal(payload.code, 'class Solution:\n    pass\n');
  assert.equal(payload.editorReady, true);
});

test('page collector does not mistake an unrelated page textarea for the code editor', () => {
  const ordinaryTextarea = { value: 'this is a discussion reply, not solution code' };
  const payload = collectFromEnvironment({
    document: {
      querySelector: (selector) => selector === 'textarea' ? ordinaryTextarea : null
    }
  });

  assert.equal(payload.code, '');
  assert.equal(payload.editorReady, false);
});

test('editorReady is true when an empty LeetCode editor is mounted', () => {
  const payload = collectFromEnvironment({
    document: {
      querySelector: (selector) => selector === '[data-cy="code-editor"] textarea, .monaco-editor textarea'
        ? { value: '' }
        : null
    }
  });

  assert.equal(payload.code, '');
  assert.equal(payload.editorReady, true);
});
