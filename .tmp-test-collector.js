// Temporary assertion script for edge-extension/page-collector.js problem
// identity extraction (problemSlug / problemUrl) across page variants.
// Loads the real content script in a vm sandbox with document/location stubs.
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('edge-extension/page-collector.js', 'utf8');

let passed = 0;
let failed = 0;
function assert(name, condition, detail) {
  if (condition) { passed += 1; console.log(`PASS ${name}`); }
  else { failed += 1; console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`); }
}

function makeSandbox(pathname, href) {
  const sandbox = {
    console,
    URL,
    decodeURIComponent,
    setTimeout,
    clearTimeout,
    location: { href, pathname, protocol: 'https:', host: 'leetcode.cn' },
    document: {
      querySelector: () => null,
      querySelectorAll: () => [],
      title: '合并两个有序数组 - 力扣（LeetCode）'
    },
    monaco: undefined,
    HTMLTextAreaElement: function () {},
    Event: function () {}
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox;
}

const cases = [
  { name: 'description', pathname: '/problems/merge-sorted-array/description/', href: 'https://leetcode.cn/problems/merge-sorted-array/description/?envType=study-plan-v2&envId=top-interview-150' },
  { name: 'solutions', pathname: '/problems/merge-sorted-array/solutions/', href: 'https://leetcode.cn/problems/merge-sorted-array/solutions/?envType=study-plan-v2&envId=top-interview-150' },
  { name: 'submissions', pathname: '/problems/merge-sorted-array/submissions/', href: 'https://leetcode.cn/problems/merge-sorted-array/submissions/?envType=study-plan-v2&envId=top-interview-150' },
  { name: 'single solution article', pathname: '/problems/merge-sorted-array/solution/123456/some-title/', href: 'https://leetcode.cn/problems/merge-sorted-array/solution/123456/some-title/' }
];

const payloads = [];
for (const c of cases) {
  const sandbox = makeSandbox(c.pathname, c.href);
  const payload = sandbox.window.__LEETCODE_CPH_COLLECT__();
  payloads.push({ name: c.name, payload });
  assert(`${c.name}: payload has problemSlug`, 'problemSlug' in payload && payload.problemSlug === 'merge-sorted-array', JSON.stringify(payload.problemSlug));
  assert(`${c.name}: payload has problemUrl`, 'problemUrl' in payload && payload.problemUrl === 'https://leetcode.cn/problems/merge-sorted-array/', JSON.stringify(payload.problemUrl));
  assert(`${c.name}: source keeps raw href`, payload.source === c.href, JSON.stringify(payload.source));
  assert(`${c.name}: title still collected`, typeof payload.title === 'string' && payload.title.length > 0, JSON.stringify(payload.title));
  assert(`${c.name}: code/language fields present`, 'code' in payload && 'language' in payload && 'capturedAt' in payload);
}

const slugs = new Set(payloads.map((p) => p.payload.problemSlug));
const urls = new Set(payloads.map((p) => p.payload.problemUrl));
assert('all four variants share one slug', slugs.size === 1, JSON.stringify([...slugs]));
assert('all four variants share one problemUrl', urls.size === 1, JSON.stringify([...urls]));

// Non-problem pages must not produce a false identity.
const empty = makeSandbox('/problemset/all/', 'https://leetcode.cn/problemset/all/').window.__LEETCODE_CPH_COLLECT__();
assert('problemset page: empty problemSlug', empty.problemSlug === '', JSON.stringify(empty.problemSlug));
assert('problemset page: empty problemUrl', empty.problemUrl === '', JSON.stringify(empty.problemUrl));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
