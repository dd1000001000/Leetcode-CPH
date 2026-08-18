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

  function code() {
    // LeetCode currently uses Monaco in many views. Its model contains the full,
    // non-virtualised text; the DOM fallback supports older CodeMirror layouts.
    try {
      const models = window.monaco?.editor?.getModels?.() || [];
      const values = models.map((model) => model.getValue()).filter(Boolean);
      if (values.length) return values.sort((a, b) => b.length - a.length)[0];
    } catch (_) { /* Fall through to DOM readers. */ }

    const textarea = document.querySelector('[data-cy="code-editor"] textarea, .monaco-editor textarea, textarea');
    if (textarea?.value?.trim()) return textarea.value;
    const codeMirror = document.querySelector('.CodeMirror-code')?.innerText;
    if (codeMirror?.trim()) return codeMirror;
    const monacoLines = [...document.querySelectorAll('.monaco-editor .view-line')]
      .map((line) => line.innerText).join('\n');
    return monacoLines.trim();
  }

  function language() {
    const selected = text('[data-cy="lang-select"]') || text('[class*="lang"] button') || attr('select', 'value');
    return clean(selected);
  }

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
