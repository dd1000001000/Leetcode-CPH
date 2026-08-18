(() => {
  const text = (selector) => document.querySelector(selector)?.innerText?.trim() || '';
  const attr = (selector, name) => document.querySelector(selector)?.getAttribute(name) || '';
  const clean = (value) => value.replace(/\u00a0/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  function title() {
    const heading = text('[data-cy="question-title"]') || text('h1');
    const browserTitle = document.title.replace(/\s*-\s*LeetCode.*$/i, '').trim();
    return clean(heading || browserTitle || 'Untitled Problem');
  }

  function problemId(problemTitle) {
    const fromPath = location.pathname.match(/problems\/([^/]+)/)?.[1];
    const fromTitle = problemTitle.match(/^(\d+)\s*[.、]/)?.[1];
    return fromTitle || fromPath || '';
  }

  function description() {
    const candidates = [
      '[data-track-load="description_content"]',
      '[data-cy="question-content"]',
      '.question-content__JfgR',
      '[class*="description"]'
    ];
    for (const selector of candidates) {
      const value = text(selector);
      if (value.length > 20) return clean(value);
    }
    return '';
  }

  function samples(problemText) {
    const blocks = [...document.querySelectorAll('pre')]
      .map((node) => clean(node.innerText || ''))
      .filter((value) => /^(输入|输出|Input|Output)[：:]/im.test(value));
    if (blocks.length) return blocks.join('\n\n');
    const matched = problemText.match(/(?:示例|Example)[\s\S]{0,2500}/i);
    return matched ? matched[0] : '';
  }

  function editorModel() {
    try {
      const models = window.monaco?.editor?.getModels?.() || [];
      const values = models.map((model) => model.getValue()).filter(Boolean);
      if (values.length) {
        const longest = values.sort((a, b) => b.length - a.length)[0];
        return models.find((model) => model.getValue() === longest) || null;
      }
    } catch (_) { /* Fall through to DOM readers. */ }
    return null;
  }

  function code() {
    // LeetCode currently uses Monaco in many views. Its model contains the full,
    // non-virtualised text; the DOM fallback supports older CodeMirror layouts.
    const model = editorModel();
    if (model) return model.getValue();

    const textarea = document.querySelector('[data-cy="code-editor"] textarea, .monaco-editor textarea, textarea');
    if (textarea?.value?.trim()) return textarea.value;
    const codeMirror = document.querySelector('.CodeMirror-code')?.innerText;
    if (codeMirror?.trim()) return codeMirror;
    const monacoLines = [...document.querySelectorAll('.monaco-editor .view-line')]
      .map((line) => line.innerText).join('\n');
    return monacoLines.trim();
  }

  function language() {
    const knownLanguages = new Set([
      'c++', 'java', 'python3', 'python', 'javascript', 'typescript', 'c#', 'c',
      'go', 'kotlin', 'swift', 'rust', 'ruby', 'php', 'dart', 'scala', 'cangjie'
    ]);
    // LeetCode's current language picker is a Radix dialog trigger. Its direct
    // text is the selected language (for example, the button in the page is
    // `<button aria-haspopup="dialog">C++ ...</button>`).
    const dialogLanguage = [...document.querySelectorAll('button[aria-haspopup="dialog"]')]
      .map((button) => clean(button.innerText || ''))
      .find((value) => knownLanguages.has(value.toLowerCase()));
    if (dialogLanguage) return dialogLanguage;

    const selectors = [
      '[data-cy="lang-select"]',
      '[data-cy="lang-select"] button',
      '[data-cy="code-editor"] [aria-label*="language" i]',
      '[data-cy="code-editor"] [class*="lang-select"]',
      '[data-cy="code-editor"] [class*="language-select"]',
      '[data-cy="code-editor"] select'
    ];
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      const selected = element?.value || element?.getAttribute('data-value') || element?.innerText;
      if (selected?.trim()) return clean(selected);
    }
    return '';
  }

  function languageKey(value) {
    const normalized = String(value || '').toLowerCase().replace(/[\s.()_-]/g, '');
    if (/^c\+\+\d*$/.test(normalized)) return 'cpp';
    if (/^python\d*$/.test(normalized)) return 'python';
    if (/^java\d*$/.test(normalized)) return 'java';
    if (/^(go|golang)\d*$/.test(normalized)) return 'go';
    if (/^(csharp|c#)\d*$/.test(normalized)) return 'csharp';
    return normalized;
  }

  window.__LEETCODE_CPH_APPLY_CODE__ = (newCode, expectedLanguage) => {
    if (typeof newCode !== 'string') return { ok: false, error: '接收到的代码不是文本。' };
    const pageLanguage = language();
    if (expectedLanguage && pageLanguage && languageKey(expectedLanguage) !== languageKey(pageLanguage)) {
      return { ok: false, error: `浏览器当前语言为 ${pageLanguage}，本地代码语言为 ${expectedLanguage}；未写入。` };
    }

    const model = editorModel();
    if (model) {
      model.setValue(newCode);
      return { ok: true, language: pageLanguage || expectedLanguage || 'unknown' };
    }

    const textarea = document.querySelector('[data-cy="code-editor"] textarea, .monaco-editor textarea, textarea');
    if (textarea) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter ? setter.call(textarea, newCode) : (textarea.value = newCode);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, language: pageLanguage || expectedLanguage || 'unknown' };
    }
    return { ok: false, error: '未找到力扣代码编辑器。' };
  };

  window.__LEETCODE_CPH_COLLECT__ = () => {
      const problemTitle = title();
      const problemText = description();
      return {
        source: location.href,
        title: problemTitle,
        problemId: problemId(problemTitle),
        description: problemText,
        samples: samples(problemText),
        code: code(),
        language: language(),
        capturedAt: new Date().toISOString()
      };
  };
})();
