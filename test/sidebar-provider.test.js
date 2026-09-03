'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { LeetCodeCphSidebarProvider, getWebviewHtml } = require('../vscode-extension/sidebar-provider');

function makeView() {
  const received = [];
  const disposables = [];
  let receiver;
  let disposeListener;
  return {
    webview: {
      options: undefined,
      html: '',
      postMessage: (message) => { received.push(message); return Promise.resolve(true); },
      onDidReceiveMessage: (listener) => {
        receiver = listener;
        const disposable = { dispose() {} };
        disposables.push(disposable);
        return disposable;
      }
    },
    onDidDispose: (listener) => {
      disposeListener = listener;
      const disposable = { dispose() {} };
      disposables.push(disposable);
      return disposable;
    },
    send: async (message) => receiver(message),
    dispose: () => disposeListener(),
    received,
    disposables
  };
}

test('sidebar provider renders a CSP-protected testcase UI', () => {
  const html = getWebviewHtml('nonce-for-test');
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /\+新增测试用例/);
  assert.doesNotMatch(html, /id="case-input"/);
  assert.doesNotMatch(html, /id="case-output"/);
  assert.match(html, /className = 'small-button save-button'/);
  assert.match(html, /save\.textContent = '保存'/);
  assert.match(html, /className = 'collapse-button'/);
  assert.match(html, /className = 'case-status '/);
  assert.match(html, /className = 'runtime'/);
  assert.match(html, /运行全部测试用例/);
  assert.match(html, /实际输出/);
  assert.doesNotMatch(html, /差异（预期 \/ 实际）/);
  assert.doesNotMatch(html, /appendOutputDiff/);
  assert.doesNotMatch(html, /diff-row/);
  assert.match(html, /同步代码到 LeetCode/);
  assert.match(html, /重新编写测试脚手架/);
  assert.match(html, /postAction\('regenerateScaffold'\)/);
  assert.match(html, /配置 AI/);
  assert.match(html, /反馈 Bug/);
  assert.match(html, /id="notice-dismiss"/);
  assert.match(html, /关闭通知/);
  assert.match(html, /dismissNotice\(Number\(state\.noticeRevision/);
});

test('sidebar provider forwards manual testcase and sidebar actions', async () => {
  const calls = [];
  const provider = new LeetCodeCphSidebarProvider({
    onReady: () => calls.push(['ready']),
    onDismissNotice: (payload) => { calls.push(['dismiss-notice', payload]); return { notice: '' }; },
    onAdd: (payload) => calls.push(['add', payload]),
    onUpdate: (payload) => calls.push(['update', payload]),
    onDelete: (payload) => calls.push(['delete', payload]),
    onRunTestCase: (payload) => calls.push(['run', payload]),
    onRunAllTestCases: (payload) => calls.push(['run-all', payload]),
    onSync: (payload) => calls.push(['sync', payload]),
    onRegenerate: (payload) => calls.push(['regenerate', payload]),
    onConfigure: () => calls.push(['configure']),
    onBugReport: () => calls.push(['bug'])
  });
  provider.setState({
    problem: { key: 'problem-a', title: '1. Two Sum', language: 'C++', aiStatus: '已配置 GLM' },
    testCases: [{ id: 'tc-1', input: '[2,7], 9', expectedOutput: '[0,1]' }]
  });
  const view = makeView();
  provider.resolveWebviewView(view);

  await view.send({ type: 'ready' });
  await view.send({ type: 'addTestCase', problemKey: 'problem-a', input: '1', expectedOutput: '1' });
  await view.send({ type: 'updateTestCase', id: 7, problemKey: 'problem-a', input: '2', expectedOutput: '4' });
  await view.send({ type: 'deleteTestCase', id: 7, problemKey: 'problem-a' });
  await view.send({ type: 'runTestCase', id: 'tc-1', problemKey: 'problem-a' });
  await view.send({ type: 'runAllTestCases', problemKey: 'problem-a' });
  await view.send({ type: 'sync', problemKey: 'problem-a' });
  await view.send({ type: 'regenerateScaffold', problemKey: 'problem-a' });
  await view.send({ type: 'configureAI' });
  await view.send({ type: 'openBugReport' });
  await view.send({ type: 'dismissNotice', revision: 7 });

  assert.deepEqual(calls, [
    ['ready'],
    ['add', { problemKey: 'problem-a' }],
    ['update', { id: '7', problemKey: 'problem-a', input: '2', expectedOutput: '4' }],
    ['delete', { id: '7', problemKey: 'problem-a' }],
    ['run', { id: 'tc-1', problemKey: 'problem-a' }],
    ['run-all', { problemKey: 'problem-a' }],
    ['sync', { problemKey: 'problem-a' }],
    ['regenerate', { problemKey: 'problem-a' }],
    ['configure'],
    ['bug'],
    ['dismiss-notice', { revision: 7 }]
  ]);
  assert.equal(view.webview.options.enableScripts, true);
  assert.equal(view.received.at(-1).state.problem.title, '1. Two Sum');
  assert.equal(view.received.at(-1).state.problem.aiStatus, '已配置 GLM');
  assert.equal(view.received.at(-1).state.testCases.length, 1);
  provider.dispose();
});

test('sidebar notice can be dismissed while another action is still in flight', async () => {
  let release;
  const calls = [];
  const provider = new LeetCodeCphSidebarProvider({
    onAdd: async () => new Promise((resolve) => { release = resolve; }),
    onDismissNotice: (payload) => { calls.push(payload); return { notice: '' }; }
  });
  provider.setState({ notice: 'AI 已完成。', noticeRevision: 11 });
  const view = makeView();
  provider.resolveWebviewView(view);

  const pendingAction = view.send({ type: 'addTestCase' });
  await Promise.resolve();
  await view.send({ type: 'dismissNotice', revision: 11 });
  assert.deepEqual(calls, [{ revision: 11 }]);
  assert.equal(view.received.at(-1).state.notice, '');
  release();
  await pendingAction;
  provider.dispose();
});

test('sidebar callback failures become a safe visible error state', async () => {
  const provider = new LeetCodeCphSidebarProvider({
    onSync: async () => { throw new Error('AI 服务不可用'); }
  });
  const view = makeView();
  provider.resolveWebviewView(view);
  await view.send({ type: 'sync' });
  assert.equal(view.received.at(-1).state.error, 'AI 服务不可用');
  assert.equal(view.received.at(-1).state.busy, false);
  provider.dispose();
});

test('sidebar ignores a duplicate action while the first action is still pending', async () => {
  let release;
  const calls = [];
  const provider = new LeetCodeCphSidebarProvider({
    onAdd: async (payload) => {
      calls.push(payload);
      await new Promise((resolve) => { release = resolve; });
    }
  });
  const view = makeView();
  provider.resolveWebviewView(view);
  const first = view.send({ type: 'addTestCase' });
  await Promise.resolve();
  const duplicate = view.send({ type: 'addTestCase' });
  release();
  await Promise.all([first, duplicate]);
  assert.deepEqual(calls, [{ problemKey: '' }]);
  provider.dispose();
});

test('sidebar rejects add, update, and delete messages while an AI job is active', async () => {
  const calls = [];
  const provider = new LeetCodeCphSidebarProvider({
    onAdd: () => calls.push('add'),
    onUpdate: () => calls.push('update'),
    onDelete: () => calls.push('delete')
  });
  provider.setState({ problem: { title: 'Two Sum', aiBusy: true } });
  const view = makeView();
  provider.resolveWebviewView(view);

  await view.send({ type: 'addTestCase' });
  await view.send({ type: 'updateTestCase', id: 'one', input: 'x', expectedOutput: 'y' });
  await view.send({ type: 'deleteTestCase', id: 'one' });

  assert.deepEqual(calls, []);
  assert.match(view.received.at(-1).state.error, /AI 正在.*请等待/);
  provider.dispose();
});
