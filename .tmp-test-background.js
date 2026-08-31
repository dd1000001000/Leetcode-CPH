// Temporary assertion script for edge-extension/background.js matching logic.
// Loads the real service-worker file in a vm sandbox with chrome/WebSocket stubs.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync('edge-extension/background.js', 'utf8');

const noop = () => {};
let testTabs = [];

class WebSocketStub {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  constructor() {
    this.readyState = WebSocketStub.CLOSED;
    this.addEventListener = noop;
  }
  close() {}
  send() {}
}

const chromeStub = {
  action: {
    setBadgeText: async () => {},
    setBadgeBackgroundColor: async () => {},
    setTitle: async () => {},
    onClicked: { addListener: noop }
  },
  tabs: {
    query: async () => testTabs,
    reload: async () => {},
    get: async () => ({ status: 'complete' })
  },
  windows: { getLastFocused: async () => ({ id: 1 }) },
  scripting: {
    executeScript: async () => [{ result: { ok: true, language: 'C++' } }]
  },
  runtime: { onStartup: { addListener: noop }, onInstalled: { addListener: noop } },
  alarms: { create: noop, onAlarm: { addListener: noop } }
};

const sandbox = {
  chrome: chromeStub,
  WebSocket: WebSocketStub,
  URL,
  console,
  setTimeout,
  clearTimeout,
  fetch: async () => ({ ok: false, status: 0, json: async () => ({}) })
};
// background.js loads the shared matcher via importScripts('url-matcher.js');
// mirror that inside the sandbox by running the real file in the same context.
sandbox.importScripts = (file) => {
  vm.runInContext(fs.readFileSync(path.join('edge-extension', file), 'utf8'), sandbox, { filename: file });
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox);

let passed = 0;
let failed = 0;
function assert(name, condition, detail) {
  if (condition) { passed += 1; console.log(`PASS ${name}`); }
  else { failed += 1; console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`); }
}

// Shared matcher (url-matcher.js) problemSlug unit checks
const { problemSlug, isLeetCodeUrl } = sandbox.LeetCodeUrlMatcher;
assert('slug: case normalization', problemSlug('https://leetcode.cn/problems/Two-Sum/description/?envType=x') === 'two-sum');
assert('slug: same slug across domains', problemSlug('https://leetcode.com/problems/two-sum/') === problemSlug('https://leetcode.cn/problems/two-sum/description/'));
assert('slug: non-problem URL returns empty', problemSlug('https://leetcode.cn/problemset/') === '');
assert('legacy leetcode-cn.com rejected (matches manifest host_permissions)', !isLeetCodeUrl('https://leetcode-cn.com/problems/two-sum/'));

async function runApply(sourceUrl, tabs) {
  testTabs = tabs;
  try {
    const result = await sandbox.applyCodeToMatchingTab({ source: sourceUrl, code: 'x', language: 'C++', title: 'T' });
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

(async () => {
  // Same-domain same-problem: the standard /problems/<slug>/ page wins over a
  // more recent /description/ tab (path rank beats recency).
  let r = await runApply('https://leetcode.cn/problems/two-sum/description/?envType=x', [
    { id: 1, url: 'https://leetcode.cn/problems/two-sum/description/', lastAccessed: 900 },
    { id: 2, url: 'https://leetcode.cn/problems/two-sum/', lastAccessed: 100 }
  ]);
  assert('path rank: standard page beats more recent /description/', r.ok && r.result.tabId === 2, JSON.stringify(r));
  assert('duplicates count all same-problem tabs', r.ok && r.result.duplicates === 1, JSON.stringify(r));

  // Equal path rank: recency picks the winner.
  r = await runApply('https://leetcode.cn/problems/two-sum/description/', [
    { id: 1, url: 'https://leetcode.cn/problems/two-sum/description/', lastAccessed: 100 },
    { id: 2, url: 'https://leetcode.cn/problems/two-sum/description/', lastAccessed: 200 }
  ]);
  assert('equal path rank tie-breaks by recency', r.ok && r.result.tabId === 2, JSON.stringify(r));

  // Slug fallback: no /description/ variant.
  r = await runApply('https://leetcode.cn/problems/two-sum/description/?envType=x', [
    { id: 2, url: 'https://leetcode.cn/problems/two-sum/', lastAccessed: 200 }
  ]);
  assert('slug fallback: /problems/xxx/ matches', r.ok && r.result.tabId === 2, JSON.stringify(r));

  // Slug fallback: solutions subpage.
  r = await runApply('https://leetcode.cn/problems/two-sum/description/', [
    { id: 3, url: 'https://leetcode.cn/problems/two-sum/solutions/1', lastAccessed: 300 }
  ]);
  assert('slug fallback: /solutions/ subpage matches', r.ok && r.result.tabId === 3, JSON.stringify(r));

  // Slug fallback: cross domain.
  r = await runApply('https://leetcode.com/problems/two-sum/', [
    { id: 4, url: 'https://leetcode.cn/problems/two-sum/description/', lastAccessed: 400 }
  ]);
  assert('slug fallback: cn vs com domains match', r.ok && r.result.tabId === 4, JSON.stringify(r));

  // pendingUrl fallback when url is missing.
  r = await runApply('https://leetcode.cn/problems/two-sum/description/', [
    { id: 5, url: undefined, pendingUrl: 'https://leetcode.cn/problems/two-sum/', lastAccessed: 500 }
  ]);
  assert('pendingUrl used when url missing', r.ok && r.result.tabId === 5, JSON.stringify(r));

  // Different slug does NOT match.
  r = await runApply('https://leetcode.cn/problems/two-sum/', [
    { id: 6, url: 'https://leetcode.cn/problems/two-sum-ii/', lastAccessed: 600 }
  ]);
  assert('different slug does not match', !r.ok, JSON.stringify(r));

  // Path rank beats recency even across domains: an old standard page wins
  // over a recent /description/ tab.
  r = await runApply('https://leetcode.com/problems/two-sum/', [
    { id: 7, url: 'https://leetcode.cn/problems/two-sum/', lastAccessed: 100 },
    { id: 8, url: 'https://leetcode.cn/problems/two-sum/description/', lastAccessed: 900 }
  ]);
  assert('path rank beats recency across variants', r.ok && r.result.tabId === 7, JSON.stringify(r));

  // Same-domain (score 2) outranks a more recent cross-domain (score 1) tab.
  r = await runApply('https://leetcode.cn/problems/two-sum/', [
    { id: 11, url: 'https://leetcode.com/problems/two-sum/', lastAccessed: 999 },
    { id: 12, url: 'https://leetcode.cn/problems/two-sum/description/', lastAccessed: 10 }
  ]);
  assert('same-domain beats more recent cross-domain', r.ok && r.result.tabId === 12, JSON.stringify(r));

  // Non-leetcode tabs are excluded.
  r = await runApply('https://leetcode.cn/problems/two-sum/', [
    { id: 9, url: 'https://example.com/other', lastAccessed: 999 }
  ]);
  assert('non-leetcode tabs excluded', !r.ok, JSON.stringify(r));

  // www. prefix is normalized away, so www pages are valid candidates.
  r = await runApply('https://leetcode.com/problems/two-sum/', [
    { id: 10, url: 'https://www.leetcode.com/problems/two-sum/description/', lastAccessed: 1000 }
  ]);
  assert('www. prefix treated as same domain', r.ok && r.result.tabId === 10, JSON.stringify(r));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
