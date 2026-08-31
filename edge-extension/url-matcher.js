// 共享的力扣题目 URL 匹配逻辑。
//
// 由 edge-extension/background.js 通过 importScripts('url-matcher.js') 加载；
// Node 测试环境（test/url-matcher.test.js）中也可直接 require。
// 规则：
// - 候选 URL 必须是 LeetCode 域名（leetcode.com / leetcode.cn / leetcode-cn.com，
//   均接受可选的 www. 前缀）。
// - 域名统一去掉 www. 前缀、转小写后再比较。
// - 题目身份只取 /problems/<slug>，因此 /description/、/submissions/、
//   /solutions/、/solution/<id>/ 等路径变体归并为同一道题。
// - 匹配排序分：2 = 同域同题（最优先）；1 = 跨域同题；0 = 不匹配。

(() => {
  'use strict';

  const LEETCODE_HOST_RE = /^(?:www\.)?leetcode(?:-cn)?\.(?:com|cn)$/i;

  function normalizeHost(host) {
    return String(host || '').toLowerCase().replace(/^www\./, '');
  }

  function isLeetCodeUrl(value) {
    try {
      return LEETCODE_HOST_RE.test(new URL(value).host);
    } catch (_) {
      return false;
    }
  }

  function problemSlug(value) {
    try {
      const match = new URL(value).pathname.match(/\/problems\/([^/?#]+)/);
      return match ? decodeURIComponent(match[1]).toLowerCase() : '';
    } catch (_) {
      return '';
    }
  }

  function matchScore(source, tabUrl) {
    const sourceSlug = problemSlug(source);
    if (!sourceSlug) return 0;
    if (problemSlug(tabUrl) !== sourceSlug) return 0;
    if (!isLeetCodeUrl(source) || !isLeetCodeUrl(tabUrl)) return 0;
    let sourceHost = '';
    let tabHost = '';
    try {
      sourceHost = normalizeHost(new URL(source).host);
      tabHost = normalizeHost(new URL(tabUrl).host);
    } catch (_) {
      return 0;
    }
    return sourceHost === tabHost ? 2 : 1;
  }

  const api = { LEETCODE_HOST_RE, normalizeHost, isLeetCodeUrl, problemSlug, matchScore };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.LeetCodeUrlMatcher = api;
})();
