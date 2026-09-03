'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'edge-extension', 'page-collector.js'), 'utf8');

function collectFromPreBlocks(preBlocks) {
  const sandbox = {
    console,
    URL,
    decodeURIComponent,
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
        : []
    },
    HTMLTextAreaElement: function HTMLTextAreaElement() {},
    Event: function Event() {}
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'page-collector.js' });
  return sandbox.window.__LEETCODE_CPH_COLLECT__();
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
