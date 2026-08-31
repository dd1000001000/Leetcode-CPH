'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const matcher = require('../edge-extension/url-matcher');

test('isLeetCodeUrl accepts LeetCode domains with and without www.', () => {
  for (const url of [
    'https://leetcode.com/problems/two-sum/',
    'https://leetcode.cn/problems/two-sum/description/',
    'https://www.leetcode.com/problems/two-sum/',
    'https://www.leetcode.cn/problems/two-sum/',
    'https://leetcode-cn.com/problems/two-sum/',
    'https://www.leetcode-cn.com/problems/two-sum/'
  ]) {
    assert.equal(matcher.isLeetCodeUrl(url), true, url);
  }
});

test('isLeetCodeUrl rejects non-LeetCode hosts', () => {
  for (const url of [
    'https://example.com/problems/two-sum/',
    'https://leetcode.com.evil.example/x',
    'http://leetcode.com.evil.com/',
    'not a url',
    ''
  ]) {
    assert.equal(matcher.isLeetCodeUrl(url), false, String(url));
  }
});

test('normalizeHost strips www. and lowercases', () => {
  assert.equal(matcher.normalizeHost('www.LeetCode.com'), 'leetcode.com');
  assert.equal(matcher.normalizeHost('leetcode.cn'), 'leetcode.cn');
  assert.equal(matcher.normalizeHost('www.leetcode-cn.com'), 'leetcode-cn.com');
});

test('problemSlug covers path variants and normalizes case', () => {
  const slug = matcher.problemSlug;
  assert.equal(slug('https://leetcode.cn/problems/Two-Sum/description/?envType=x'), 'two-sum');
  assert.equal(slug('https://leetcode.com/problems/two-sum/'), 'two-sum');
  assert.equal(slug('https://leetcode.cn/problems/two-sum/submissions/'), 'two-sum');
  assert.equal(slug('https://leetcode.cn/problems/two-sum/solutions/1'), 'two-sum');
  assert.equal(slug('https://leetcode.cn/problems/two-sum/solution/123/some-title/'), 'two-sum');
  assert.equal(slug('https://leetcode.cn/problemset/'), '');
  assert.equal(slug('not a url'), '');
});

test('matchScore ranks same-domain same-problem above cross-domain same-problem', () => {
  const source = 'https://leetcode.cn/problems/two-sum/description/?envType=x';
  assert.equal(matcher.matchScore(source, 'https://leetcode.cn/problems/two-sum/'), 2);
  assert.equal(matcher.matchScore(source, 'https://leetcode.cn/problems/two-sum/submissions/'), 2);
  assert.equal(matcher.matchScore(source, 'https://www.leetcode.cn/problems/two-sum/'), 2, 'www. normalized to the same domain');
  assert.equal(matcher.matchScore(source, 'https://leetcode.com/problems/two-sum/'), 1);
  assert.equal(matcher.matchScore(source, 'https://leetcode.cn/problems/two-sum-ii/'), 0);
  assert.equal(matcher.matchScore(source, 'https://example.com/problems/two-sum/'), 0);
  assert.equal(matcher.matchScore('https://leetcode.cn/problemset/', 'https://leetcode.cn/problems/two-sum/'), 0, 'non-problem source never matches');
});
