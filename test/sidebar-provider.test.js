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
  assert.match(html, /新增测试用例/);
  assert.match(html, /生成\/更新测试脚手架/);
  assert.match(html, /同步代码到 LeetCode/);
  assert.match(html, /配置 AI/);
  assert.match(html, /反馈 Bug/);
  assert.doesNotMatch(html, /运行全部/);
});

test('sidebar provider forwards manual testcase and sidebar actions', async () => {
  const calls = [];
  const provider = new LeetCodeCphSidebarProvider({
    onReady: () => calls.push(['ready']),
    onAdd: (payload) => calls.push(['add', payload]),
    onDelete: (payload) => calls.push(['delete', payload]),
    onGenerateScaffold: () => calls.push(['generate']),
    onSync: () => calls.push(['sync']),
    onConfigure: () => calls.push(['configure']),
    onBugReport: () => calls.push(['bug'])
  });
  provider.setState({
    problem: { title: '1. Two Sum', language: 'C++', aiStatus: '已配置 GLM' },
    testCases: [{ id: 'tc-1', input: '[2,7], 9', expectedOutput: '[0,1]' }]
  });
  const view = makeView();
  provider.resolveWebviewView(view);

  await view.send({ type: 'ready' });
  await view.send({ type: 'addTestCase', input: '1', expectedOutput: '1' });
  await view.send({ type: 'deleteTestCase', id: 7 });
  await view.send({ type: 'generateScaffold' });
  await view.send({ type: 'sync' });
  await view.send({ type: 'configureAI' });
  await view.send({ type: 'openBugReport' });

  assert.deepEqual(calls, [
    ['ready'],
    ['add', { input: '1', expectedOutput: '1' }],
    ['delete', { id: '7' }],
    ['generate'],
    ['sync'],
    ['configure'],
    ['bug']
  ]);
  assert.equal(view.webview.options.enableScripts, true);
  assert.equal(view.received.at(-1).state.problem.title, '1. Two Sum');
  assert.equal(view.received.at(-1).state.problem.aiStatus, '已配置 GLM');
  assert.equal(view.received.at(-1).state.testCases.length, 1);
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
  const first = view.send({ type: 'addTestCase', input: '1', expectedOutput: '1' });
  await Promise.resolve();
  const duplicate = view.send({ type: 'addTestCase', input: '2', expectedOutput: '2' });
  release();
  await Promise.all([first, duplicate]);
  assert.deepEqual(calls, [{ input: '1', expectedOutput: '1' }]);
  provider.dispose();
});
