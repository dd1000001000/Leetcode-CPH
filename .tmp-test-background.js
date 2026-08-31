// Temporary assertion script for edge-extension/background.js matching logic.
// Loads the real service-worker file in a vm sandbox with chrome/WebSocket stubs.
const fs = require('fs');
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
vm.createContext(sandbox);
vm.runInContext(source, sandbox);

let passed = 0;
let failed = 0;
function assert(name, condition, detail) {
  if (condition) { passed += 1; console.log(`PASS ${name}`); }
  else { failed += 1; console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`); }
}

// problemSlug unit checks
assert('slug: case normalization', sandbox.problemSlug('https://leetcode.cn/problems/Two-Sum/description/?envType=x') === 'two-sum');
assert('slug: same slug across domains', sandbox.problemSlug('https://leetcode.com/problems/two-sum/') === sandbox.problemSlug('https://leetcode.cn/problems/two-sum/description/'));
assert('slug: non-problem URL returns empty', sandbox.problemSlug('https://leetcode.cn/problemset/') === '');

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
  // Exact canonical match preferred over slug-only tab.
  let r = await runApply('https://leetcode.cn/problems/two-sum/description/?envType=x', [
    { id: 1, url: 'https://leetcode.cn/problems/two-sum/description/', lastAccessed: 100 },
    { id: 2, url: 'https://leetcode.cn/problems/two-sum/', lastAccessed: 200 }
  ]);
  assert('exact match preferred over slug-only tab', r.ok && r.result.tabId === 1, JSON.stringify(r));

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

  // Recency: most recently accessed tab wins among slug matches.
  r = await runApply('https://leetcode.com/problems/two-sum/', [
    { id: 7, url: 'https://leetcode.cn/problems/two-sum/', lastAccessed: 100 },
    { id: 8, url: 'https://leetcode.cn/problems/two-sum/description/', lastAccessed: 900 }
  ]);
  assert('recency sort picks most recent', r.ok && r.result.tabId === 8, JSON.stringify(r));

  // Non-leetcode tabs are excluded.
  r = await runApply('https://leetcode.cn/problems/two-sum/', [
    { id: 9, url: 'https://example.com/other', lastAccessed: 999 }
  ]);
  assert('non-leetcode tabs excluded', !r.ok, JSON.stringify(r));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
