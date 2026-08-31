'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const matcher = require('../edge-extension/url-matcher');

test('isLeetCodeUrl accepts LeetCode domains with and without www.', () => {
  for (const url of [
    'https://leetcode.com/problems/two-sum/',
    'https://leetcode.cn/problems/two-sum/description/',
    'https://www.leetcode.com/problems/two-sum/',
    'https://www.leetcode.cn/problems/two-sum/'
  ]) {
    assert.equal(matcher.isLeetCodeUrl(url), true, url);
  }
});

test('legacy leetcode-cn.com is rejected, consistent with manifest host_permissions', () => {
  for (const url of [
    'https://leetcode-cn.com/problems/two-sum/',
    'https://www.leetcode-cn.com/problems/two-sum/',
    'https://leetcode-cn.com/problems/two-sum/description/'
  ]) {
    assert.equal(matcher.isLeetCodeUrl(url), false, url);
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

test('pathRank prefers the standard page, then /description/, then subpages', () => {
  const rank = matcher.pathRank;
  assert.equal(rank('https://leetcode.cn/problems/two-sum/'), 0);
  assert.equal(rank('https://leetcode.cn/problems/two-sum'), 0);
  assert.equal(rank('https://leetcode.com/problems/two-sum/?envType=x'), 0, 'query strings ignored');
  assert.equal(rank('https://leetcode.cn/problems/two-sum/description/'), 1);
  assert.equal(rank('https://leetcode.cn/problems/two-sum/description'), 1, 'trailing slash normalized');
  assert.equal(rank('https://leetcode.cn/problems/two-sum/submissions/'), 2);
  assert.equal(rank('https://leetcode.cn/problems/two-sum/solutions/'), 2);
  assert.equal(rank('https://leetcode.cn/problems/two-sum/solutions/1'), 2);
  assert.equal(rank('https://leetcode.cn/problems/two-sum/solution/123/some-title/'), 2);
  assert.equal(rank('https://leetcode.cn/problemset/all/'), Infinity);
  assert.equal(rank('not a url'), Infinity);
});

test('combined ranking: same-domain first, then path rank, then recency', () => {
  // Mirrors background.js applyCodeToMatchingTab ordering: score (2 = same
  // domain, 1 = cross domain) → pathRank (lower wins) → recency.
  const source = 'https://leetcode.cn/problems/two-sum/description/';
  const byRecency = (left, right) => (right.lastAccessed - left.lastAccessed);
  const tabs = [
    { id: 1, url: 'https://leetcode.com/problems/two-sum/', lastAccessed: 900 },  // cross-domain standard page, most recent
    { id: 2, url: 'https://leetcode.cn/problems/two-sum/description/', lastAccessed: 100 }, // same-domain description, recent
    { id: 3, url: 'https://leetcode.cn/problems/two-sum/', lastAccessed: 50 }       // same-domain standard page, oldest
  ];
  const order = tabs
    .map((candidate) => ({ candidate, score: matcher.matchScore(source, candidate.url) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => {
      const scoreDiff = right.score - left.score;
      if (scoreDiff) return scoreDiff;
      const rankDiff = matcher.pathRank(left.candidate.url) - matcher.pathRank(right.candidate.url);
      return rankDiff || byRecency(left.candidate, right.candidate);
    })
    .map((entry) => entry.candidate.id);
  assert.deepEqual(order, [3, 2, 1], 'standard page beats recent /description/; same-domain beats recent cross-domain');
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
