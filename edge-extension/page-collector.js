(() => {
  const text = (selector) => document.querySelector(selector)?.innerText?.trim() || '';
  const attr = (selector, name) => document.querySelector(selector)?.getAttribute(name) || '';
  const clean = (value) => value.replace(/\u00a0/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  function questionLinkText() {
    const link = [...document.querySelectorAll('a[href^="/problems/"]')]
      .find((element) => /^\d+\s*[.、]/.test((element.innerText || '').trim()));
    return clean(link?.innerText || '');
  }

  function title() {
    const heading = questionLinkText() || text('[data-cy="question-title"]') || text('h1');
    const browserTitle = document.title.replace(/\s*-\s*LeetCode.*$/i, '').trim();
    return clean(heading || browserTitle || 'Untitled Problem');
  }

  function problemId(problemTitle) {
    const fromQuestionLink = questionLinkText().match(/^(\d+)\s*[.、]/)?.[1];
    const fromPath = location.pathname.match(/problems\/([^/]+)/)?.[1];
    const fromTitle = problemTitle.match(/^(\d+)\s*[.、]/)?.[1];
    return fromQuestionLink || fromTitle || fromPath || '';
  }

  // 题目在力扣上有多个页面变体（/description、/solutions、/submissions、
  // /solution/<id> 等），但都对应同一道题。slug 只从 /problems/<slug> 提取，
  // 忽略后续段与查询参数，因此三个变体得到同一身份。
  function problemSlug() {
    const match = location.pathname.match(/\/problems\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]).toLowerCase() : '';
  }

  function problemUrl(slug) {
    if (!slug) return '';
    try {
      return `${location.protocol}//${location.host}/problems/${slug}/`;
    } catch (_) {
      return '';
    }
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
      // Some layouts put "Example 1:" before the Input line inside the same
      // <pre>; accept a label anywhere at the beginning of a line instead of
      // requiring it to be the first character of the block.
      .filter((value) => /(?:^|\n)\s*(?:输入|输出|Input|Output)\s*[：:]/im.test(value));
    if (blocks.length) return blocks.join('\n\n');
    const matched = problemText.match(/(?:示例|Example)[\s\S]{0,2500}/i);
    return matched ? matched[0] : '';
  }

  function testcaseName(index) {
    return `testcase ${String(index + 1).padStart(3, '0')}`;
  }

  // LeetCode renders examples as <pre> blocks on most pages.  Their exact
  // surrounding markup changes fairly often, but the Input/Output labels are
  // stable in both the Chinese and English sites.  Keep the values as text:
  // the VS Code extension deliberately lets the selected AI turn those
  // language-neutral values into a language-specific test scaffold later.
  function testCasesFromSamples(value) {
    const source = clean(String(value || ''));
    if (!source) return [];

    const inputMarker = /(?:^|\n)\s*(?:Input|输入)\s*[：:]\s*/gim;
    const outputMarker = /(?:^|\n)\s*(?:Output|输出)\s*[：:]\s*/gim;
    // Stop the expected output before prose that belongs to the example, or
    // before the next example.  The labels intentionally include the common
    // English and Chinese variants used by LeetCode.
    const outputEndMarker = /(?:^|\n)\s*(?:(?:Explanation|Constraints?|Follow[- ]?up|Notes?|Note|Example)\b|(?:解释|约束条件|提示|进阶|注意|示例)\s*[：:]|(?:Input|输入)\s*[：:])/gim;
    const inputMatches = [...source.matchAll(inputMarker)];
    const cases = [];

    for (let index = 0; index < inputMatches.length; index += 1) {
      const inputMatch = inputMatches[index];
      const inputStart = inputMatch.index + inputMatch[0].length;
      const nextInputStart = index + 1 < inputMatches.length ? inputMatches[index + 1].index : source.length;
      outputMarker.lastIndex = inputStart;
      const outputMatch = outputMarker.exec(source);
      if (!outputMatch || outputMatch.index >= nextInputStart) continue;

      const outputStart = outputMatch.index + outputMatch[0].length;
      outputEndMarker.lastIndex = outputStart;
      const outputEndMatch = outputEndMarker.exec(source);
      const outputEnd = outputEndMatch && outputEndMatch.index < nextInputStart
        ? outputEndMatch.index
        : nextInputStart;
      const input = clean(source.slice(inputStart, outputMatch.index));
      const expectedOutput = clean(source.slice(outputStart, outputEnd));
      if (!input && !expectedOutput) continue;
      cases.push({
        name: testcaseName(cases.length),
        input,
        expectedOutput,
        source: 'leetcode'
      });
    }
    return cases;
  }

  function testCases(problemText) {
    return testCasesFromSamples(samples(problemText));
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
      const slug = problemSlug();
      const problemSamples = samples(problemText);
      return {
        source: location.href,
        problemSlug: slug,
        problemUrl: problemUrl(slug),
        title: problemTitle,
        problemId: problemId(problemTitle),
        description: problemText,
        samples: problemSamples,
        // `samples` remains for backward compatibility and README rendering.
        // `testCases` is the structured, editable source of truth used by the
        // VS Code sidebar and testcase persistence layer.
        testCases: testCasesFromSamples(problemSamples),
        code: code(),
        language: language(),
        capturedAt: new Date().toISOString()
      };
  };
})();
