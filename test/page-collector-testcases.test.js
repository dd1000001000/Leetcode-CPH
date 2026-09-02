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

test('page collector emits a structured testcase for every LeetCode example block', () => {
  const payload = collectFromPreBlocks([
    'Example 1:\nInput: nums = [2,7,11,15], target = 9\nOutput: [0,1]\nExplanation: nums[0] + nums[1] == 9.',
    '示例 2：\n输入：nums = [3,2,4], target = 6\n输出：[1,2]\n解释：nums[1] + nums[2] == 6。'
  ]);

  assert.equal(payload.samples.includes('Explanation'), true, 'raw samples are retained for README compatibility');
  assert.deepEqual(JSON.parse(JSON.stringify(payload.testCases)), [
    { name: 'testcase 001', input: 'nums = [2,7,11,15], target = 9', expectedOutput: '[0,1]', source: 'leetcode' },
    { name: 'testcase 002', input: 'nums = [3,2,4], target = 6', expectedOutput: '[1,2]', source: 'leetcode' }
  ]);
});

test('page collector has an empty structured list when a page has no examples', () => {
  const payload = collectFromPreBlocks([]);
  assert.deepEqual(JSON.parse(JSON.stringify(payload.testCases)), []);
});
