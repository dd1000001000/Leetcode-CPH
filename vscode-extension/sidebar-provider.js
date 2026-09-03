'use strict';

// The webview owns presentation only. The extension host owns persistence,
// AI calls, process execution, and all secrets. No API key or raw provider
// response is ever sent into this browser context.
//
// Messages: ready, dismissNotice, addTestCase, updateTestCase, deleteTestCase,
// runTestCase, runAllTestCases, sync, configureAI, openBugReport.

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
    switch (message.type) {
      case 'addTestCase':
        return {};
      case 'updateTestCase':
        return {
          id,
          input: typeof message.input === 'string' ? message.input : '',
          expectedOutput: typeof message.expectedOutput === 'string' ? message.expectedOutput : ''
        };
      case 'deleteTestCase':
      case 'runTestCase':
        return { id };
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
    .ai-status, .scaffold-status, .edit-hint { color: var(--vscode-descriptionForeground); margin-top: 4px; line-height: 1.35; font-size: 11px; }
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
    .case-list { display: grid; gap: 8px; }
    .case { border: 1px solid var(--vscode-widget-border); border-radius: 5px; overflow: hidden; background: var(--vscode-editor-background); }
    .case-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 9px; background: var(--vscode-sideBarSectionHeader-background); border-bottom: 1px solid var(--vscode-widget-border); }
    .case-name { color: var(--vscode-textLink-foreground); font-weight: 650; }
    .case-actions { display: flex; gap: 5px; align-items: center; }
    .case-content { padding: 8px 9px; }
    .field-label { color: var(--vscode-descriptionForeground); display: block; margin: 0 0 3px; font-size: 11px; }
    textarea { display: block; resize: vertical; width: 100%; min-height: 54px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 3px; margin: 0 0 8px; padding: 6px; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
    textarea:focus, button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
    pre { margin: 0 0 8px; max-height: 120px; overflow: auto; padding: 7px; white-space: pre-wrap; word-break: break-word; color: var(--vscode-editor-foreground); background: var(--vscode-textCodeBlock-background); border-radius: 3px; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
    .icon-button, .small-button { min-width: 0; border: 0; border-radius: 3px; cursor: pointer; padding: 3px 6px; }
    .run-button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    .delete-button { color: var(--vscode-errorForeground); background: transparent; }
    .delete-button:hover { background: var(--vscode-toolbar-hoverBackground); }
    .run-result { margin-top: 2px; border-top: 1px solid var(--vscode-widget-border); padding-top: 8px; }
    .result-summary { display: block; margin-bottom: 5px; font-size: 11px; font-weight: 650; }
    .result-summary.passed { color: var(--vscode-testing-iconPassed); }
    .result-summary.failed, .result-summary.error { color: var(--vscode-testing-iconFailed); }
    .difference { color: var(--vscode-testing-iconFailed); }
    .difference.passed { color: var(--vscode-editorWarning-foreground); }
    .output-diff { display: grid; gap: 3px; margin-bottom: 8px; }
    .diff-row { border-left: 3px solid transparent; border-radius: 3px; padding: 4px 5px; background: var(--vscode-textCodeBlock-background); }
    .diff-row.changed { border-left-color: var(--vscode-editorWarning-foreground); color: var(--vscode-editorWarning-foreground); background: var(--vscode-editorWarning-background, var(--vscode-textCodeBlock-background)); }
    .diff-line-number { color: var(--vscode-descriptionForeground); display: block; font-size: 10px; margin-bottom: 2px; }
    .diff-value { display: block; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
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
    </div>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const state = { problem: null, testCases: [], busy: false, testcaseMutationBusy: false, runBusy: false, runningCaseId: '', testResults: {}, notice: '', noticeRevision: 0, error: '' };
    const elements = {
      title: document.getElementById('problem-title'), aiStatus: document.getElementById('ai-status'), scaffoldStatus: document.getElementById('scaffold-status'), notice: document.getElementById('notice'), noticeText: document.getElementById('notice-text'), noticeDismiss: document.getElementById('notice-dismiss'), error: document.getElementById('error'), empty: document.getElementById('empty'), list: document.getElementById('case-list'), add: document.getElementById('add-case'), runAll: document.getElementById('run-all'), sync: document.getElementById('sync'), configure: document.getElementById('configure-ai'), bug: document.getElementById('bug-report')
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
    function valueOf(testCase, keys) { for (const key of keys) if (typeof testCase[key] === 'string') return testCase[key]; return ''; }
    function hasRunnableData(input, expectedOutput) { return String(input == null ? '' : input) !== '' || String(expectedOutput == null ? '' : expectedOutput) !== ''; }
    // Keep edits outside extension-host state until the user explicitly saves
    // a card. State refreshes can happen for capture, AI work, or another
    // card's action; retaining drafts here prevents those refreshes from
    // silently replacing text that is still being edited.
    const drafts = new Map();
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
      elements.add.disabled = mutationLocked || !canMutate || draftLocked; elements.runAll.hidden = !scaffoldReady || !runnerSupported; elements.runAll.disabled = actionLocked || draftLocked || !testCases.some((testCase) => { const fields = persistedFields(testCase); return hasRunnableData(fields.input, fields.expectedOutput); }); elements.sync.disabled = Boolean(state.busy || state.testcaseMutationBusy || state.runBusy || problem.aiBusy) || draftLocked || !hasProblem || problem.canSync === false; elements.configure.disabled = Boolean(state.busy || state.testcaseMutationBusy || state.runBusy) || draftLocked; elements.bug.disabled = Boolean(state.busy || state.testcaseMutationBusy || state.runBusy) || draftLocked;
    }
    function postAction(type) { if (hasUnsavedDrafts(Array.isArray(state.testCases) ? state.testCases : [])) { showDraftWarning(); return; } vscode.postMessage({ type }); }
    function appendEditor(container, label, value, disabled) {
      const fieldLabel = document.createElement('label'); fieldLabel.className = 'field-label'; fieldLabel.textContent = label;
      const editor = document.createElement('textarea'); editor.value = value; editor.disabled = disabled; editor.placeholder = label === '输入' ? '填写传给解法的输入' : '填写预期输出'; container.append(fieldLabel, editor); return editor;
    }
    function appendReadOnly(container, label, value, className) {
      const fieldLabel = document.createElement('span'); fieldLabel.className = 'field-label' + (className ? ' ' + className : ''); fieldLabel.textContent = label;
      const code = document.createElement('pre'); code.textContent = value == null || value === '' ? '（空）' : String(value); container.append(fieldLabel, code);
    }
    function resultFor(testCase) { const all = state.testResults && typeof state.testResults === 'object' ? state.testResults : {}; return all[String(testCase.id)] || all[testCase.name] || null; }
    function appendOutputDiff(container, expectedValue, actualValue) {
      const expectedLines = String(expectedValue == null ? '' : expectedValue).replace(/\\r\\n?/g, '\\n').split('\\n');
      const actualLines = String(actualValue == null ? '' : actualValue).replace(/\\r\\n?/g, '\\n').split('\\n');
      const count = Math.max(expectedLines.length, actualLines.length);
      const diff = document.createElement('div'); diff.className = 'output-diff';
      for (let index = 0; index < count; index += 1) {
        const expected = index < expectedLines.length ? expectedLines[index] : '';
        const actual = index < actualLines.length ? actualLines[index] : '';
        const row = document.createElement('div'); row.className = 'diff-row' + (expected !== actual ? ' changed' : '');
        const number = document.createElement('span'); number.className = 'diff-line-number'; number.textContent = '第 ' + String(index + 1) + ' 行';
        const expectedLine = document.createElement('span'); expectedLine.className = 'diff-value'; expectedLine.textContent = '预期：' + (expected || '（空）');
        const actualLine = document.createElement('span'); actualLine.className = 'diff-value'; actualLine.textContent = '实际：' + (actual || '（空）');
        row.append(number, expectedLine, actualLine); diff.append(row);
      }
      container.append(diff);
    }
    function appendResult(container, testCase, result) {
      if (!result) return;
      const box = document.createElement('div'); box.className = 'run-result';
      const summary = document.createElement('span'); const status = result.status || (result.passed ? 'passed' : 'failed'); summary.className = 'result-summary ' + status;
      summary.textContent = status === 'passed' ? '运行结果：通过' : status === 'error' ? '运行失败：' + (result.error || '无法读取运行结果') : '运行结果：预期输出与实际输出不同'; box.append(summary);
      if (status !== 'error') {
        appendReadOnly(box, '实际输出', result.actualOutput);
        if (result.different || status !== 'passed') {
          const difference = document.createElement('span'); difference.className = 'field-label difference' + (status === 'passed' ? ' passed' : ''); difference.textContent = status === 'passed' ? '显示差异（脚手架判定通过）' : '差异（预期 / 实际）';
          box.append(difference); appendOutputDiff(box, valueOf(testCase, ['expectedOutput', 'expected', 'output']), result.actualOutput);
        }
      }
      container.append(box);
    }
    function postUpdate(testCase, inputEditor, outputEditor, initialInput, initialOutput) {
      if (inputEditor.value === initialInput && outputEditor.value === initialOutput) return false;
      vscode.postMessage({ type: 'updateTestCase', id: String(testCase.id), input: inputEditor.value, expectedOutput: outputEditor.value });
      return true;
    }
    function render() {
      const problem = state.problem || {}; const hasProblem = Boolean(problem.title); const language = problem.language ? ' · ' + problem.language : '';
      elements.title.textContent = hasProblem ? problem.title + language : '打开一个 LeetCode solution 文件以查看测试用例'; elements.aiStatus.textContent = problem.aiStatus || ''; elements.aiStatus.hidden = !problem.aiStatus; elements.scaffoldStatus.textContent = problem.scaffoldStatus || ''; elements.scaffoldStatus.hidden = !problem.scaffoldStatus; displayNotice(state.notice); displayMessage(elements.error, state.error);
      const testCases = Array.isArray(state.testCases) ? state.testCases : []; const mutationLocked = Boolean(state.busy || state.testcaseMutationBusy || problem.aiBusy); const actionLocked = Boolean(state.busy || state.testcaseMutationBusy || state.runBusy || problem.aiBusy); const canMutate = hasProblem; const scaffoldReady = Boolean(problem.scaffoldReady); const runnerSupported = Boolean(problem.runnerSupported); const draftLocked = hasUnsavedDrafts(testCases);
      elements.list.replaceChildren(); elements.empty.hidden = testCases.length > 0;
      testCases.forEach((rawTestCase, index) => {
        const testCase = rawTestCase || {}; const persisted = persistedFields(testCase); const draft = draftFor(testCase, persisted); const input = draft ? draft.input : persisted.input; const expected = draft ? draft.expectedOutput : persisted.expectedOutput; const key = draftKey(testCase);
        const card = document.createElement('article'); card.className = 'case'; const header = document.createElement('header'); header.className = 'case-header'; const name = document.createElement('span'); name.className = 'case-name'; name.textContent = testCaseName(testCase, index); const actions = document.createElement('div'); actions.className = 'case-actions';
        const run = document.createElement('button'); run.className = 'small-button run-button'; run.type = 'button'; run.textContent = state.runBusy && String(state.runningCaseId) === String(testCase.id) ? '运行中…' : '运行'; run.title = '运行此测试用例'; run.hidden = !runnerSupported; run.disabled = actionLocked || draftLocked || !scaffoldReady || !runnerSupported || !hasRunnableData(input, expected); run.addEventListener('click', () => { if (hasUnsavedDrafts(testCases)) return showDraftWarning(); vscode.postMessage({ type: 'runTestCase', id: String(testCase.id) }); });
        const remove = document.createElement('button'); remove.className = 'icon-button delete-button'; remove.type = 'button'; remove.textContent = '删除'; remove.title = '删除此测试用例'; remove.disabled = mutationLocked || draftLocked || !canMutate; remove.addEventListener('click', () => { if (hasUnsavedDrafts(testCases)) return showDraftWarning(); vscode.postMessage({ type: 'deleteTestCase', id: String(testCase.id) }); }); actions.append(run, remove); header.append(name, actions);
        const content = document.createElement('div'); content.className = 'case-content'; const inputEditor = appendEditor(content, '输入', input, mutationLocked || !canMutate); const outputEditor = appendEditor(content, '预期输出', expected, mutationLocked || !canMutate); const hint = document.createElement('div'); hint.className = 'edit-hint'; const save = document.createElement('button'); save.className = 'secondary small-button'; save.type = 'button'; save.textContent = '保存并更新'; content.append(hint, save);
        const refreshEditorState = () => {
          const dirty = inputEditor.value !== persisted.input || outputEditor.value !== persisted.expectedOutput;
          if (key) { if (dirty) drafts.set(key, { input: inputEditor.value, expectedOutput: outputEditor.value }); else drafts.delete(key); }
          hint.textContent = dirty ? '点击“保存并更新”后会自动更新测试脚手架。' : persisted.input || persisted.expectedOutput ? '修改测试用例后，请点击“保存并更新”。' : '请填写输入和预期输出，再点击“保存并更新”。';
          save.disabled = mutationLocked || !canMutate || !dirty;
          run.disabled = actionLocked || hasUnsavedDrafts(testCases) || !scaffoldReady || !hasRunnableData(inputEditor.value, outputEditor.value) || dirty;
          refreshGlobalControls();
        };
        save.addEventListener('click', () => {
          if (!postUpdate(testCase, inputEditor, outputEditor, persisted.input, persisted.expectedOutput)) return;
          save.disabled = true; inputEditor.disabled = true; outputEditor.disabled = true; run.disabled = true; remove.disabled = true;
        });
        inputEditor.addEventListener('input', refreshEditorState); outputEditor.addEventListener('input', refreshEditorState); refreshEditorState(); appendResult(content, testCase, resultFor(testCase)); card.append(header, content); elements.list.append(card);
      });
      refreshGlobalControls();
    }
    elements.noticeDismiss.addEventListener('click', () => dismissNotice(Number(state.noticeRevision || 0))); elements.add.addEventListener('click', () => postAction('addTestCase')); elements.runAll.addEventListener('click', () => postAction('runAllTestCases')); elements.sync.addEventListener('click', () => postAction('sync')); elements.configure.addEventListener('click', () => postAction('configureAI')); elements.bug.addEventListener('click', () => postAction('openBugReport'));
    window.addEventListener('message', (event) => { if (event.data?.type !== 'state' || !event.data.state) return; Object.assign(state, event.data.state); render(); }); render(); vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}

module.exports = { LeetCodeCphSidebarProvider, DEFAULT_STATE, getWebviewHtml };
