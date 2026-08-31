// 共享的力扣题目 URL 匹配逻辑。
//
// 由 edge-extension/background.js 通过 importScripts('url-matcher.js') 加载；
// Node 测试环境（test/url-matcher.test.js）中也可直接 require。
// 规则：
// - 候选 URL 必须是 LeetCode 域名（leetcode.com / leetcode.cn，均接受可选的
//   www. 前缀）。旧域名 leetcode-cn.com 已不再支持，与 manifest.json 的
//   host_permissions 保持一致。
// - 域名统一去掉 www. 前缀、转小写后再比较。
// - 题目身份只取 /problems/<slug>，因此 /description/、/submissions/、
//   /solutions/、/solution/<id>/ 等路径变体归并为同一道题。
// - 匹配排序分：2 = 同域同题（最优先）；1 = 跨域同题；0 = 不匹配。
// - pathRank 在同分标签内再排序：标准题页 /problems/<slug>/ 最优（0），
//   其次 /description/（1），再是 /submissions/ /solutions/ /solution/<id>/
//   等子页面（2）；非题目 URL 为 Infinity，永远排最后。

(() => {
  'use strict';

  const LEETCODE_HOST_RE = /^(?:www\.)?leetcode\.(?:com|cn)$/i;

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

  // 同题页面内的路径优先级（数值越小越优先）：
  //   0 = /problems/<slug>/ 标准题页（最优先）
  //   1 = /problems/<slug>/description/
  //   2 = /problems/<slug>/submissions|solutions|solution/<id>/… 等子页面
  //   Infinity = 非题目 URL（不会进入候选）
  function pathRank(value) {
    try {
      const pathname = new URL(value).pathname;
      const match = pathname.match(/^\/problems\/([^/?#]+)/);
      if (!match) return Infinity;
      const rest = pathname.slice(match[0].length).replace(/\/+$/, '');
      if (rest === '') return 0;
      if (rest === '/description') return 1;
      return 2;
    } catch (_) {
      return Infinity;
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

  const api = { LEETCODE_HOST_RE, normalizeHost, isLeetCodeUrl, problemSlug, pathRank, matchScore };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.LeetCodeUrlMatcher = api;
})();
