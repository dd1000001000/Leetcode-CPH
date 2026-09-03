'use strict';

// The webview owns presentation only. The extension host owns persistence,
// AI calls, process execution, and all secrets. No API key or raw provider
// response is ever sent into this browser context.
//
// Messages: ready, dismissNotice, addTestCase, updateTestCase, deleteTestCase,
// runTestCase, runAllTestCases, sync, regenerateScaffold, configureAI,
// openBugReport.

const DEFAULT_STATE = Object.freeze({
  problem: null,
  testCases: [],
  busy: false,
  testcaseMutationBusy: false,
  runBusy: false,
  runningCaseId: '',
  testResults: {},
  notice: '',
  noticeRevision: 0,
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
    webview.options = { enableScripts: true, localResourceRoots: [] };
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

  // State can be set before the view is opened; it will be rendered when the
  // user opens the Activity Bar view.
  setState(nextState = {}) {
    const problem = nextState.problem === null
      ? null
      : { ...(this._state.problem || {}), ...(nextState.problem || {}) };
    this._state = {
      ...this._state,
      ...nextState,
      problem,
      testCases: Array.isArray(nextState.testCases) ? nextState.testCases : this._state.testCases,
      testResults: nextState.testResults && typeof nextState.testResults === 'object'
        ? nextState.testResults
        : this._state.testResults
    };
    this._postState();
  }

  async _receiveMessage(message) {
    if (!message || typeof message.type !== 'string') return;
    const handlers = {
      ready: this._callbacks.onReady,
      dismissNotice: this._callbacks.onDismissNotice || (() => ({ notice: '' })),
      addTestCase: this._callbacks.onAdd,
      updateTestCase: this._callbacks.onUpdate,
      deleteTestCase: this._callbacks.onDelete,
      runTestCase: this._callbacks.onRunTestCase,
      runAllTestCases: this._callbacks.onRunAllTestCases,
      sync: this._callbacks.onSync,
      regenerateScaffold: this._callbacks.onRegenerate,
      configureAI: this._callbacks.onConfigure,
      openBugReport: this._callbacks.onBugReport
    };
    const handler = handlers[message.type];
    if (typeof handler !== 'function') return;

    const testcaseMutation = message.type === 'addTestCase'
      || message.type === 'updateTestCase'
      || message.type === 'deleteTestCase';
    if (testcaseMutation && this._state.problem?.aiBusy) {
      this.setState({ error: 'AI 正在提取测试用例或更新 main 测试代码，请等待完成后再修改。' });
      return;
    }

    // A disabled button alone cannot prevent two queued postMessage events.
    // The host additionally serializes mutations per problem; this guard keeps
    // the webview from issuing a duplicate action before its next render.
    const isAction = message.type !== 'ready' && message.type !== 'dismissNotice';
    if (isAction && this._actionInFlight) return;
    if (isAction) this._actionInFlight = true;
    try {
      const statePatch = await handler(this._payloadFor(message));
      if (statePatch && typeof statePatch === 'object') this.setState(statePatch);
    } catch (error) {
      this.setState({
        busy: false,
        testcaseMutationBusy: false,
        runBusy: false,
        runningCaseId: '',
        error: error?.message || '操作失败，请稍后重试。'
      });
    } finally {
      if (isAction) this._actionInFlight = false;
    }
  }

  _payloadFor(message) {
    const id = typeof message.id === 'string' || typeof message.id === 'number' ? String(message.id) : '';
    const problemKey = typeof message.problemKey === 'string' ? message.problemKey : '';
    switch (message.type) {
      case 'addTestCase':
        return { problemKey };
      case 'updateTestCase':
        return {
          id,
          problemKey,
          input: typeof message.input === 'string' ? message.input : '',
          expectedOutput: typeof message.expectedOutput === 'string' ? message.expectedOutput : ''
        };
      case 'deleteTestCase':
      case 'runTestCase':
        return { id, problemKey };
      case 'runAllTestCases':
      case 'sync':
      case 'regenerateScaffold':
        return { problemKey };
      case 'dismissNotice':
        return { revision: Number.isSafeInteger(message.revision) ? message.revision : -1 };
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
  // No user-provided content is interpolated into this string. All testcase
  // values are rendered through textContent/value, never innerHTML.
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
    body { margin: 0; padding: 12px; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
    button, textarea { font: inherit; }
    .header { margin-bottom: 12px; }
    h1 { font-size: 15px; margin: 0 0 5px; font-weight: 650; }
    .problem-title { color: var(--vscode-descriptionForeground); display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
    .ai-status, .scaffold-status { color: var(--vscode-descriptionForeground); margin-top: 4px; line-height: 1.35; font-size: 11px; }
    .scaffold-status { color: var(--vscode-editorWarning-foreground); font-weight: 650; }
    .message { display: none; border-radius: 4px; margin: 0 0 10px; padding: 8px; line-height: 1.4; }
    .message.visible { display: block; }
    .message.notice { align-items: flex-start; gap: 8px; background: var(--vscode-inputValidation-infoBackground); border: 1px solid var(--vscode-inputValidation-infoBorder); }
    .message.notice.visible { display: flex; }
    .notice-text { flex: 1; min-width: 0; white-space: pre-wrap; }
    .notice-dismiss { flex: 0 0 auto; width: 20px; height: 20px; min-width: 20px; padding: 0; border: 0; border-radius: 3px; color: var(--vscode-foreground); background: transparent; cursor: pointer; font-size: 16px; line-height: 18px; }
    .notice-dismiss:hover { background: var(--vscode-toolbar-hoverBackground); }
    .message.error { background: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder); }
    .empty { color: var(--vscode-descriptionForeground); border: 1px dashed var(--vscode-widget-border); border-radius: 5px; padding: 14px 10px; text-align: center; line-height: 1.45; }
    .case-list { display: grid; gap: 7px; }
    .case { border: 1px solid var(--vscode-widget-border); border-radius: 3px; overflow: hidden; background: var(--vscode-editor-background); }
    .case-header { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-height: 38px; padding: 5px 6px; background: var(--vscode-sideBarSectionHeader-background); border-bottom: 1px solid var(--vscode-widget-border); }
    .collapse-button { flex: 0 0 auto; min-width: 22px; width: 22px; height: 24px; padding: 0; border: 0; color: var(--vscode-textLink-foreground); background: transparent; cursor: pointer; font-size: 16px; line-height: 22px; }
    .collapse-button:hover { background: var(--vscode-toolbar-hoverBackground); }
    .case-name { flex: 1 1 48px; min-width: 0; overflow: hidden; color: var(--vscode-textLink-foreground); font-weight: 700; white-space: nowrap; text-overflow: ellipsis; }
    .case-status { flex: 0 0 auto; font-weight: 700; white-space: nowrap; }
    .case-status.passed { color: var(--vscode-testing-iconPassed, #73c991); }
    .case-status.failed, .case-status.error { color: var(--vscode-testing-iconFailed, #f14c4c); }
    .runtime { flex: 0 0 auto; border-radius: 4px; padding: 2px 5px; color: var(--vscode-descriptionForeground); background: var(--vscode-badge-background); font-size: 10px; white-space: nowrap; }
    .case-actions { display: flex; flex: 0 0 auto; margin-left: auto; justify-content: flex-end; gap: 5px; align-items: center; }
    .case-content { padding: 8px 9px 2px; }
    .case.collapsed .case-header { border-bottom: 0; }
    .field-label { color: var(--vscode-foreground); display: block; margin: 0 0 3px; font-size: 11px; font-weight: 650; }
    textarea { display: block; resize: vertical; width: 100%; min-height: 58px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 2px; margin: 0 0 9px; padding: 6px; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
    textarea:focus, button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
    pre { margin: 0 0 9px; max-height: 160px; overflow: auto; padding: 7px; white-space: pre-wrap; word-break: break-word; color: var(--vscode-editor-foreground); background: var(--vscode-textCodeBlock-background); border: 1px solid var(--vscode-input-border); border-radius: 2px; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
    .icon-button, .small-button { min-width: 0; border: 0; border-radius: 3px; cursor: pointer; padding: 4px 7px; }
    .save-button { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    .run-button { min-width: 30px; color: #fff; background: #4f8f25; font-size: 15px; }
    .run-button:hover { background: #5da52c; }
    .delete-button { min-width: 30px; color: #fff; background: #c72d4c; font-size: 14px; }
    .delete-button:hover { background: #da3456; }
    .actions { display: grid; grid-template-columns: 1fr; gap: 7px; margin-top: 14px; }
    button.primary, button.secondary, button.success { border: 0; border-radius: 3px; cursor: pointer; min-height: 30px; padding: 5px 9px; }
    button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    button.primary:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button.success { color: #fff; background: #388a25; font-weight: 650; }
    button.success:hover { background: #2e731f; }
    button:disabled { cursor: default; opacity: .55; }
    .footer { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin-top: 14px; }
    .footer-wide { grid-column: 1 / -1; }
    .scaffold { margin-top: 14px; width: 100%; }
    .sync { margin-top: 8px; width: 100%; font-size: 13px; font-weight: 650; }
    @media (max-width: 280px) {
      .case-actions { flex-basis: calc(100% - 28px); margin-left: 28px; }
      .case-header { row-gap: 4px; }
    }
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
    <div id="notice" class="message notice" role="status">
      <span id="notice-text" class="notice-text"></span>
      <button id="notice-dismiss" class="notice-dismiss" type="button" title="关闭通知" aria-label="关闭通知">×</button>
    </div>
    <div id="error" class="message error" role="alert"></div>
    <section aria-label="测试用例">
      <div id="empty" class="empty">当前题目还没有测试用例。配置 AI 后可从题面提取测试用例，或点击下方按钮新增。</div>
      <div id="case-list" class="case-list"></div>
    </section>
    <div class="actions">
      <button id="run-all" class="primary" type="button">运行全部测试用例</button>
      <button id="add-case" class="success" type="button">+新增测试用例</button>
    </div>
    <button id="sync" class="primary sync" type="button">同步代码到 LeetCode</button>
    <div class="footer">
      <button id="configure-ai" class="secondary" type="button">配置 AI</button>
      <button id="bug-report" class="secondary" type="button">反馈 Bug</button>
      <button id="regenerate-scaffold" class="secondary footer-wide" type="button">重新编写测试脚手架</button>
    </div>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const state = { problem: null, testCases: [], busy: false, testcaseMutationBusy: false, runBusy: false, runningCaseId: '', testResults: {}, notice: '', noticeRevision: 0, error: '' };
    const elements = {
      title: document.getElementById('problem-title'), aiStatus: document.getElementById('ai-status'), scaffoldStatus: document.getElementById('scaffold-status'), notice: document.getElementById('notice'), noticeText: document.getElementById('notice-text'), noticeDismiss: document.getElementById('notice-dismiss'), error: document.getElementById('error'), empty: document.getElementById('empty'), list: document.getElementById('case-list'), add: document.getElementById('add-case'), runAll: document.getElementById('run-all'), sync: document.getElementById('sync'), configure: document.getElementById('configure-ai'), bug: document.getElementById('bug-report'), regenerate: document.getElementById('regenerate-scaffold')
    };
    function displayMessage(element, text) { element.textContent = text || ''; element.classList.toggle('visible', Boolean(text)); }
    let dismissedNoticeRevision = null;
    function dismissNotice(revision) {
      if (!state.notice || revision !== Number(state.noticeRevision || 0)) return;
      dismissedNoticeRevision = revision;
      elements.notice.classList.remove('visible'); elements.noticeText.textContent = '';
      vscode.postMessage({ type: 'dismissNotice', revision });
    }
    function displayNotice(text) {
      const revision = Number(state.noticeRevision || 0); const visible = Boolean(text) && dismissedNoticeRevision !== revision;
      elements.noticeText.textContent = visible ? text : ''; elements.notice.classList.toggle('visible', visible);
    }
    function testCaseName(testCase, index) { return testCase.name || ('testcase ' + String(index + 1).padStart(3, '0')); }
    function displayedTestCaseName(testCase, index) {
      const persistentName = testCaseName(testCase, index);
      return /^testcase\\s*0*\\d+$/i.test(persistentName) ? 'TC ' + String(index + 1) : persistentName;
    }
    function valueOf(testCase, keys) { for (const key of keys) if (typeof testCase[key] === 'string') return testCase[key]; return ''; }
    function hasRunnableData(input, expectedOutput) { return String(input == null ? '' : input) !== '' || String(expectedOutput == null ? '' : expectedOutput) !== ''; }
    // Keep edits outside extension-host state until the user explicitly saves
    // a card. State refreshes can happen for capture, AI work, or another
    // card's action; retaining drafts here prevents those refreshes from
    // silently replacing text that is still being edited.
    const drafts = new Map();
    const collapsedCases = new Set();
    function draftScope() { return String(state.problem && state.problem.key || ''); }
    function draftKey(testCase) {
      const scope = draftScope();
      return scope && testCase && testCase.id != null ? scope + '\u0000' + String(testCase.id) : '';
    }
    function persistedFields(testCase) { return { input: valueOf(testCase || {}, ['input', 'arguments']), expectedOutput: valueOf(testCase || {}, ['expectedOutput', 'expected', 'output']) }; }
    function draftFor(testCase, persisted) {
      const key = draftKey(testCase); const draft = key ? drafts.get(key) : null;
      if (!draft) return null;
      if (draft.input === persisted.input && draft.expectedOutput === persisted.expectedOutput) { drafts.delete(key); return null; }
      return draft;
    }
    function hasUnsavedDrafts(testCases) {
      const scope = draftScope();
      if (!scope) return false;
      const prefix = scope + '\u0000';
      const activeIds = new Set();
      for (const testCase of testCases) {
        const key = draftKey(testCase); if (!key) continue;
        activeIds.add(key); draftFor(testCase, persistedFields(testCase));
      }
      // Keep drafts belonging to another problem. VS Code refreshes the
      // sidebar whenever the active editor changes, and dropping all IDs that
      // are not in the newly active problem would silently erase a user's
      // unsaved card edits when they switch away and back.
      for (const key of drafts.keys()) if (key.startsWith(prefix) && !activeIds.has(key)) drafts.delete(key);
      return [...drafts.keys()].some((key) => activeIds.has(key));
    }
    function showDraftWarning() { displayMessage(elements.error, '请先保存或还原正在编辑的测试用例，再执行其他操作。'); }
    function refreshGlobalControls() {
      const problem = state.problem || {}; const hasProblem = Boolean(problem.title); const testCases = Array.isArray(state.testCases) ? state.testCases : [];
      const mutationLocked = Boolean(state.busy || state.testcaseMutationBusy || problem.aiBusy); const actionLocked = Boolean(state.busy || state.testcaseMutationBusy || state.runBusy || problem.aiBusy); const canMutate = hasProblem; const scaffoldReady = Boolean(problem.scaffoldReady); const runnerSupported = Boolean(problem.runnerSupported); const draftLocked = hasUnsavedDrafts(testCases);
      elements.add.disabled = mutationLocked || !canMutate || draftLocked; elements.runAll.hidden = !scaffoldReady || !runnerSupported; elements.runAll.disabled = actionLocked || draftLocked || !testCases.some((testCase) => { const fields = persistedFields(testCase); return hasRunnableData(fields.input, fields.expectedOutput); }); elements.sync.disabled = Boolean(state.busy || state.testcaseMutationBusy || state.runBusy || problem.aiBusy) || draftLocked || !hasProblem || problem.canSync === false; elements.configure.disabled = Boolean(state.busy || state.testcaseMutationBusy || state.runBusy) || draftLocked; elements.bug.disabled = Boolean(state.busy || state.testcaseMutationBusy || state.runBusy) || draftLocked; elements.regenerate.disabled = actionLocked || draftLocked || !hasProblem || testCases.length === 0 || problem.canRegenerateScaffold === false;
    }
    function postAction(type) { if (hasUnsavedDrafts(Array.isArray(state.testCases) ? state.testCases : [])) { showDraftWarning(); return; } vscode.postMessage({ type, problemKey: draftScope() }); }
    function appendEditor(container, label, value, disabled, editorId) {
      const fieldLabel = document.createElement('label'); fieldLabel.className = 'field-label'; fieldLabel.textContent = label; fieldLabel.htmlFor = editorId;
      const editor = document.createElement('textarea'); editor.id = editorId; editor.value = value; editor.disabled = disabled; editor.placeholder = label === '输入' ? '填写传给解法的输入' : '填写预期输出'; container.append(fieldLabel, editor); return editor;
    }
    function appendReadOnly(container, label, value, className, outputId) {
      const fieldLabel = document.createElement('span'); fieldLabel.id = outputId + '-label'; fieldLabel.className = 'field-label' + (className ? ' ' + className : ''); fieldLabel.textContent = label;
      const code = document.createElement('pre'); code.id = outputId; code.setAttribute('aria-labelledby', fieldLabel.id); code.textContent = value == null || value === '' ? '（空）' : String(value); container.append(fieldLabel, code);
    }
    function resultFor(testCase) { const all = state.testResults && typeof state.testResults === 'object' ? state.testResults : {}; return all[String(testCase.id)] || all[testCase.name] || null; }
    function resultStatus(result) {
      if (!result) return null;
      const status = result.status || (result.passed ? 'passed' : 'failed');
      return { status, text: status === 'passed' ? '通过' : status === 'error' ? '运行错误' : '失败' };
    }
    function resultRuntime(result) {
      if (!result) return '';
      const value = Number(result.durationMs ?? result.runtimeMs ?? result.elapsedMs);
      return Number.isFinite(value) && value >= 0 ? Math.round(value) + 'ms' : '';
    }
    function appendResult(container, result, fieldPrefix) {
      if (!result) return;
      const status = resultStatus(result)?.status;
      if (Object.prototype.hasOwnProperty.call(result, 'actualOutput')) {
        appendReadOnly(container, '实际输出', result.actualOutput, '', fieldPrefix + '-actual');
      }
      if (status === 'error') appendReadOnly(container, '运行错误', result.error || '无法读取运行结果', '', fieldPrefix + '-error');
    }
    function postUpdate(testCase, inputEditor, outputEditor, initialInput, initialOutput) {
      if (inputEditor.value === initialInput && outputEditor.value === initialOutput) return false;
      vscode.postMessage({ type: 'updateTestCase', id: String(testCase.id), problemKey: draftScope(), input: inputEditor.value, expectedOutput: outputEditor.value });
      return true;
    }
    function render() {
      const problem = state.problem || {}; const hasProblem = Boolean(problem.title); const language = problem.language ? ' · ' + problem.language : '';
      elements.title.textContent = hasProblem ? problem.title + language : '打开一个 LeetCode solution 文件以查看测试用例'; elements.aiStatus.textContent = problem.aiStatus || ''; elements.aiStatus.hidden = !problem.aiStatus; elements.scaffoldStatus.textContent = problem.scaffoldStatus || ''; elements.scaffoldStatus.hidden = !problem.scaffoldStatus; displayNotice(state.notice); displayMessage(elements.error, state.error);
      const testCases = Array.isArray(state.testCases) ? state.testCases : []; const mutationLocked = Boolean(state.busy || state.testcaseMutationBusy || problem.aiBusy); const actionLocked = Boolean(state.busy || state.testcaseMutationBusy || state.runBusy || problem.aiBusy); const canMutate = hasProblem; const scaffoldReady = Boolean(problem.scaffoldReady); const runnerSupported = Boolean(problem.runnerSupported); const draftLocked = hasUnsavedDrafts(testCases);
      elements.list.replaceChildren(); elements.empty.hidden = testCases.length > 0;
      testCases.forEach((rawTestCase, index) => {
        const testCase = rawTestCase || {}; const persisted = persistedFields(testCase); const draft = draftFor(testCase, persisted); const input = draft ? draft.input : persisted.input; const expected = draft ? draft.expectedOutput : persisted.expectedOutput; const key = draftKey(testCase); const collapseKey = key || draftScope() + '\u0000index-' + String(index); const result = resultFor(testCase); const statusInfo = resultStatus(result); const runtime = resultRuntime(result);
        const card = document.createElement('article'); card.className = 'case'; const header = document.createElement('header'); header.className = 'case-header'; const content = document.createElement('div'); content.className = 'case-content';
        const collapse = document.createElement('button'); collapse.className = 'collapse-button'; collapse.type = 'button'; collapse.title = '折叠测试用例'; collapse.setAttribute('aria-label', '折叠测试用例');
        const name = document.createElement('span'); name.className = 'case-name'; name.textContent = displayedTestCaseName(testCase, index); name.title = testCaseName(testCase, index);
        if (statusInfo) { const status = document.createElement('span'); status.className = 'case-status ' + statusInfo.status; status.textContent = statusInfo.text; header.append(collapse, name, status); } else header.append(collapse, name);
        if (runtime) { const duration = document.createElement('span'); duration.className = 'runtime'; duration.textContent = runtime; header.append(duration); }
        const actions = document.createElement('div'); actions.className = 'case-actions';
        const save = document.createElement('button'); save.className = 'small-button save-button'; save.type = 'button'; save.textContent = '保存'; save.title = '保存此测试用例';
        const run = document.createElement('button'); run.className = 'small-button run-button'; run.type = 'button'; run.textContent = state.runBusy && String(state.runningCaseId) === String(testCase.id) ? '…' : '▶'; run.title = '运行此测试用例'; run.setAttribute('aria-label', '运行此测试用例'); run.hidden = !runnerSupported; run.disabled = actionLocked || draftLocked || !scaffoldReady || !runnerSupported || !hasRunnableData(input, expected); run.addEventListener('click', () => { if (hasUnsavedDrafts(testCases)) return showDraftWarning(); vscode.postMessage({ type: 'runTestCase', id: String(testCase.id), problemKey: draftScope() }); });
        const remove = document.createElement('button'); remove.className = 'icon-button delete-button'; remove.type = 'button'; remove.textContent = '🗑'; remove.title = '删除此测试用例'; remove.setAttribute('aria-label', '删除此测试用例'); remove.disabled = mutationLocked || draftLocked || !canMutate; remove.addEventListener('click', () => { if (hasUnsavedDrafts(testCases)) return showDraftWarning(); vscode.postMessage({ type: 'deleteTestCase', id: String(testCase.id), problemKey: draftScope() }); }); actions.append(save, run, remove); header.append(actions);
        const setCollapsed = (collapsed) => { card.classList.toggle('collapsed', collapsed); content.hidden = collapsed; collapse.textContent = collapsed ? '⌄' : '⌃'; collapse.title = collapsed ? '展开测试用例' : '折叠测试用例'; collapse.setAttribute('aria-label', collapse.title); collapse.setAttribute('aria-expanded', String(!collapsed)); };
        setCollapsed(collapsedCases.has(collapseKey)); collapse.addEventListener('click', () => { const collapsed = !content.hidden; if (collapsed) collapsedCases.add(collapseKey); else collapsedCases.delete(collapseKey); setCollapsed(collapsed); });
        const fieldPrefix = 'case-' + String(index); const inputEditor = appendEditor(content, '输入', input, mutationLocked || !canMutate, fieldPrefix + '-input'); const outputEditor = appendEditor(content, '预期输出', expected, mutationLocked || !canMutate, fieldPrefix + '-expected'); appendResult(content, result, fieldPrefix);
        const refreshEditorState = () => {
          const dirty = inputEditor.value !== persisted.input || outputEditor.value !== persisted.expectedOutput;
          if (key) { if (dirty) drafts.set(key, { input: inputEditor.value, expectedOutput: outputEditor.value }); else drafts.delete(key); }
          save.disabled = mutationLocked || !canMutate || !dirty;
          run.disabled = actionLocked || hasUnsavedDrafts(testCases) || !scaffoldReady || !hasRunnableData(inputEditor.value, outputEditor.value) || dirty;
          remove.disabled = mutationLocked || !canMutate || hasUnsavedDrafts(testCases);
          refreshGlobalControls();
        };
        save.addEventListener('click', () => {
          if (!postUpdate(testCase, inputEditor, outputEditor, persisted.input, persisted.expectedOutput)) return;
          save.disabled = true; inputEditor.disabled = true; outputEditor.disabled = true; run.disabled = true; remove.disabled = true;
        });
        inputEditor.addEventListener('input', refreshEditorState); outputEditor.addEventListener('input', refreshEditorState); refreshEditorState(); card.append(header, content); elements.list.append(card);
      });
      refreshGlobalControls();
    }
    elements.noticeDismiss.addEventListener('click', () => dismissNotice(Number(state.noticeRevision || 0))); elements.add.addEventListener('click', () => postAction('addTestCase')); elements.runAll.addEventListener('click', () => postAction('runAllTestCases')); elements.sync.addEventListener('click', () => postAction('sync')); elements.regenerate.addEventListener('click', () => postAction('regenerateScaffold')); elements.configure.addEventListener('click', () => postAction('configureAI')); elements.bug.addEventListener('click', () => postAction('openBugReport'));
    window.addEventListener('message', (event) => { if (event.data?.type !== 'state' || !event.data.state) return; Object.assign(state, event.data.state); render(); }); render(); vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}

module.exports = { LeetCodeCphSidebarProvider, DEFAULT_STATE, getWebviewHtml };
