'use strict';

// The sidebar deliberately owns presentation only.  The extension host wires
// its callbacks to the capture store, AI testcase service, and browser sync
// service.  Keeping that boundary here makes the Webview safe to reuse and
// prevents secrets or API keys from ever being exposed to browser JavaScript.
//
// Messages sent by this provider:
//   ready
//   addTestCase    { input, expectedOutput }
//   deleteTestCase { id }
//   generateScaffold
//   sync
//   configureAI
//   openBugReport
//
// State accepted by setState:
// {
//   problem: { title, source, language, aiStatus, scaffoldStatus },
//   testCases: [{ id, name, input, expectedOutput }],
//   busy: boolean,
//   notice: string,
//   error: string
// }

const DEFAULT_STATE = Object.freeze({
  problem: null,
  testCases: [],
  busy: false,
  notice: '',
  error: ''
});

class LeetCodeCphSidebarProvider {
  static viewType = 'leetcodeCph.sidebar';

  constructor(callbacks = {}) {
    this._callbacks = callbacks;
    this._view = undefined;
    this._state = { ...DEFAULT_STATE };
    this._disposables = [];
    this._actionInFlight = false;
  }

  resolveWebviewView(webviewView) {
    this._disposeViewListeners();
    this._view = webviewView;
    const { webview } = webviewView;
    webview.options = {
      enableScripts: true,
      // There are no local resources in this view.  Keeping this empty makes
      // the CSP below both simpler and more restrictive.
      localResourceRoots: []
    };
    webview.html = getWebviewHtml(createNonce());
    this._disposables.push(
      webview.onDidReceiveMessage((message) => this._receiveMessage(message)),
      webviewView.onDidDispose(() => {
        this._disposeViewListeners();
        this._view = undefined;
      })
    );
    this._postState();
  }

  dispose() {
    this._disposeViewListeners();
    this._view = undefined;
  }

  // Can be called before the user has opened the sidebar; its state will be
  // delivered as soon as resolveWebviewView runs.
  setState(nextState = {}) {
    const problem = nextState.problem === null
      ? null
      : { ...(this._state.problem || {}), ...(nextState.problem || {}) };
    this._state = {
      ...this._state,
      ...nextState,
      problem,
      testCases: Array.isArray(nextState.testCases) ? nextState.testCases : this._state.testCases
    };
    this._postState();
  }

  async _receiveMessage(message) {
    if (!message || typeof message.type !== 'string') return;
    const handlers = {
      ready: this._callbacks.onReady,
      addTestCase: this._callbacks.onAdd,
      deleteTestCase: this._callbacks.onDelete,
      generateScaffold: this._callbacks.onGenerateScaffold,
      sync: this._callbacks.onSync,
      configureAI: this._callbacks.onConfigure,
      openBugReport: this._callbacks.onBugReport
    };
    const handler = handlers[message.type];
    if (typeof handler !== 'function') return;

    // Rendering a disabled button is helpful UX, but two postMessage events
    // can still arrive before the first render reaches the webview.  The
    // extension host performs the authoritative per-problem serialization;
    // this guard avoids issuing duplicate UI actions in that narrow window.
    const isAction = message.type !== 'ready';
    if (isAction && this._actionInFlight) return;
    if (isAction) this._actionInFlight = true;

    const payload = this._payloadFor(message);
    try {
      // Callbacks may either update the provider themselves or return a state
      // patch, which is convenient for small handlers and tests.
      const statePatch = await handler(payload);
      if (statePatch && typeof statePatch === 'object') this.setState(statePatch);
    } catch (error) {
      this.setState({
        busy: false,
        error: error?.message || '操作失败，请稍后重试。'
      });
    } finally {
      if (isAction) this._actionInFlight = false;
    }
  }

  _payloadFor(message) {
    switch (message.type) {
      case 'addTestCase':
        return {
          input: typeof message.input === 'string' ? message.input : '',
          expectedOutput: typeof message.expectedOutput === 'string' ? message.expectedOutput : ''
        };
      case 'deleteTestCase':
        return { id: typeof message.id === 'string' || typeof message.id === 'number' ? String(message.id) : '' };
      default:
        return undefined;
    }
  }

  _postState() {
    if (!this._view) return;
    void this._view.webview.postMessage({ type: 'state', state: this._state });
  }

  _disposeViewListeners() {
    for (const disposable of this._disposables.splice(0)) disposable.dispose();
  }
}

function createNonce() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let index = 0; index < 32; index += 1) value += alphabet[Math.floor(Math.random() * alphabet.length)];
  return value;
}

function getWebviewHtml(nonce) {
  // No user-controlled data is interpolated into this document.  Testcases
  // arrive through postMessage and are rendered via textContent below.
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>LeetCode CPH</title>
  <style nonce="${nonce}">
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 12px;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    button, textarea {
      font: inherit;
    }
    .header { margin-bottom: 12px; }
    h1 { font-size: 15px; margin: 0 0 5px; font-weight: 650; }
    .problem-title {
      color: var(--vscode-descriptionForeground);
      display: -webkit-box;
      overflow: hidden;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
    }
    .ai-status {
      color: var(--vscode-descriptionForeground);
      margin-top: 4px;
      line-height: 1.35;
      font-size: 11px;
    }
    .scaffold-status {
      color: var(--vscode-editorWarning-foreground);
      margin-top: 4px;
      line-height: 1.35;
      font-size: 11px;
      font-weight: 650;
    }
    .message {
      display: none;
      border-radius: 4px;
      margin: 0 0 10px;
      padding: 8px;
      line-height: 1.4;
    }
    .message.visible { display: block; }
    .message.notice {
      background: var(--vscode-inputValidation-infoBackground);
      border: 1px solid var(--vscode-inputValidation-infoBorder);
    }
    .message.error {
      background: var(--vscode-inputValidation-errorBackground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
    }
    .empty {
      color: var(--vscode-descriptionForeground);
      border: 1px dashed var(--vscode-widget-border);
      border-radius: 5px;
      padding: 14px 10px;
      text-align: center;
      line-height: 1.45;
    }
    .case-list { display: grid; gap: 8px; }
    .case {
      border: 1px solid var(--vscode-widget-border);
      border-radius: 5px;
      overflow: hidden;
      background: var(--vscode-editor-background);
    }
    .case-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 8px 9px;
      background: var(--vscode-sideBarSectionHeader-background);
      border-bottom: 1px solid var(--vscode-widget-border);
    }
    .case-name { color: var(--vscode-textLink-foreground); font-weight: 650; }
    .icon-button {
      min-width: 0;
      color: var(--vscode-errorForeground);
      background: transparent;
      border: 0;
      border-radius: 3px;
      cursor: pointer;
      padding: 3px 5px;
    }
    .icon-button:hover { background: var(--vscode-toolbar-hoverBackground); }
    .case-content { padding: 8px 9px; }
    .field-label { color: var(--vscode-descriptionForeground); display: block; margin-bottom: 3px; font-size: 11px; }
    pre {
      margin: 0 0 9px;
      max-height: 120px;
      overflow: auto;
      padding: 7px;
      white-space: pre-wrap;
      word-break: break-word;
      color: var(--vscode-editor-foreground);
      background: var(--vscode-textCodeBlock-background);
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
    }
    pre:last-child { margin-bottom: 0; }
    .new-case {
      margin-top: 14px;
      padding-top: 12px;
      border-top: 1px solid var(--vscode-widget-border);
    }
    h2 { font-size: 13px; margin: 0 0 8px; }
    textarea {
      display: block;
      resize: vertical;
      width: 100%;
      min-height: 62px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 3px;
      margin: 0 0 8px;
      padding: 6px;
    }
    textarea:focus, button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
    .button-row { display: grid; grid-template-columns: 1fr; gap: 7px; margin-top: 8px; }
    button.primary, button.secondary {
      border: 0;
      border-radius: 3px;
      cursor: pointer;
      min-height: 30px;
      padding: 5px 9px;
    }
    button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    button.primary:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button:disabled { cursor: default; opacity: .55; }
    .footer { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin-top: 14px; }
    .scaffold { margin-top: 14px; width: 100%; }
    .sync { margin-top: 8px; width: 100%; font-size: 13px; font-weight: 650; }
  </style>
</head>
<body>
  <main>
    <div class="header">
      <h1>LeetCode 测试用例</h1>
      <div id="problem-title" class="problem-title">打开一个 LeetCode solution 文件以查看测试用例</div>
      <div id="ai-status" class="ai-status" hidden></div>
      <div id="scaffold-status" class="scaffold-status" hidden></div>
    </div>
    <div id="notice" class="message notice" role="status"></div>
    <div id="error" class="message error" role="alert"></div>
    <section aria-label="测试用例">
      <div id="empty" class="empty">当前题目还没有测试用例。<br>可在下方手动添加。</div>
      <div id="case-list" class="case-list"></div>
    </section>
    <section class="new-case" aria-labelledby="new-case-heading">
      <h2 id="new-case-heading">新增测试用例</h2>
      <label class="field-label" for="case-input">输入</label>
      <textarea id="case-input" placeholder="例如：[2,7,11,15], 9"></textarea>
      <label class="field-label" for="case-output">预期输出</label>
      <textarea id="case-output" placeholder="例如：[0,1]"></textarea>
      <button id="add-case" class="secondary" type="button">新增测试用例</button>
    </section>
    <button id="generate-scaffold" class="secondary scaffold" type="button">生成/更新测试脚手架</button>
    <button id="sync" class="primary sync" type="button">同步代码到 LeetCode</button>
    <div class="footer">
      <button id="configure-ai" class="secondary" type="button">配置 AI</button>
      <button id="bug-report" class="secondary" type="button">反馈 Bug</button>
    </div>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const state = { problem: null, testCases: [], busy: false, notice: '', error: '' };
    const elements = {
      title: document.getElementById('problem-title'),
      aiStatus: document.getElementById('ai-status'),
      scaffoldStatus: document.getElementById('scaffold-status'),
      notice: document.getElementById('notice'),
      error: document.getElementById('error'),
      empty: document.getElementById('empty'),
      list: document.getElementById('case-list'),
      input: document.getElementById('case-input'),
      output: document.getElementById('case-output'),
      add: document.getElementById('add-case'),
      generate: document.getElementById('generate-scaffold'),
      sync: document.getElementById('sync'),
      configure: document.getElementById('configure-ai'),
      bug: document.getElementById('bug-report')
    };

    function displayMessage(element, text) {
      element.textContent = text || '';
      element.classList.toggle('visible', Boolean(text));
    }

    function testCaseName(testCase, index) {
      return testCase.name || ('testcase ' + String(index + 1).padStart(3, '0'));
    }

    function testCaseValue(testCase, keys) {
      for (const key of keys) {
        if (typeof testCase[key] === 'string') return testCase[key];
      }
      return '';
    }

    function appendValue(container, label, value) {
      const fieldLabel = document.createElement('span');
      fieldLabel.className = 'field-label';
      fieldLabel.textContent = label;
      const code = document.createElement('pre');
      code.textContent = value || '（空）';
      container.append(fieldLabel, code);
    }

    function render() {
      const problem = state.problem || {};
      const language = problem.language ? ' · ' + problem.language : '';
      elements.title.textContent = problem.title ? problem.title + language : '打开一个 LeetCode solution 文件以查看测试用例';
      elements.aiStatus.textContent = problem.aiStatus || '';
      elements.aiStatus.hidden = !problem.aiStatus;
      elements.scaffoldStatus.textContent = problem.scaffoldStatus || '';
      elements.scaffoldStatus.hidden = !problem.scaffoldStatus;
      displayMessage(elements.notice, state.notice);
      displayMessage(elements.error, state.error);
      elements.list.replaceChildren();
      const testCases = Array.isArray(state.testCases) ? state.testCases : [];
      elements.empty.hidden = testCases.length > 0;
      testCases.forEach((rawTestCase, index) => {
        const testCase = rawTestCase || {};
        const card = document.createElement('article');
        card.className = 'case';
        const header = document.createElement('header');
        header.className = 'case-header';
        const name = document.createElement('span');
        name.className = 'case-name';
        name.textContent = testCaseName(testCase, index);
        const remove = document.createElement('button');
        remove.className = 'icon-button';
        remove.type = 'button';
        remove.textContent = '删除';
        remove.title = '删除此测试用例';
        remove.disabled = Boolean(state.busy);
        remove.addEventListener('click', () => {
          vscode.postMessage({ type: 'deleteTestCase', id: String(testCase.id ?? index) });
        });
        header.append(name, remove);
        const content = document.createElement('div');
        content.className = 'case-content';
        appendValue(content, '输入', testCaseValue(testCase, ['input', 'arguments']));
        appendValue(content, '预期输出', testCaseValue(testCase, ['expectedOutput', 'expected', 'output']));
        card.append(header, content);
        elements.list.append(card);
      });
      const disabled = Boolean(state.busy);
      elements.input.disabled = disabled;
      elements.output.disabled = disabled;
      elements.add.disabled = disabled;
      elements.generate.disabled = disabled;
      elements.sync.disabled = disabled;
      elements.configure.disabled = disabled;
      elements.bug.disabled = disabled;
    }

    elements.add.addEventListener('click', () => {
      vscode.postMessage({
        type: 'addTestCase',
        input: elements.input.value,
        expectedOutput: elements.output.value
      });
    });
    elements.generate.addEventListener('click', () => vscode.postMessage({ type: 'generateScaffold' }));
    elements.sync.addEventListener('click', () => vscode.postMessage({ type: 'sync' }));
    elements.configure.addEventListener('click', () => vscode.postMessage({ type: 'configureAI' }));
    elements.bug.addEventListener('click', () => vscode.postMessage({ type: 'openBugReport' }));
    window.addEventListener('message', (event) => {
      if (event.data?.type !== 'state' || !event.data.state) return;
      Object.assign(state, event.data.state);
      render();
    });
    render();
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}

module.exports = { LeetCodeCphSidebarProvider, DEFAULT_STATE, getWebviewHtml };
