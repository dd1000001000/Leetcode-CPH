# LeetCode CPH

[简体中文](./README_zh.md)

LeetCode CPH connects a browser extension with a VS Code extension so you can capture a LeetCode problem, manage and run test cases locally, and sync your solution back to the open problem page.

## Features

- Capture the current LeetCode problem and editor code into a title-named folder in your workspace:

  ```text
  <output directory>/<problem title>/
    solution.<ext>
    main.<ext>
    .leetcode_cph/
      metadata.json
      testcases.json
      backups/
  ```

  `solution.<ext>` is your answer. `main.<ext>` is the AI-generated local test entry point and is created only after AI generation succeeds.
- Configure GLM, DeepSeek, or Qwen. API keys are saved in VS Code's secure Secret Storage.
- Use the configured AI to extract test cases from the captured problem. Without an API key, the extension does not automatically extract or generate any test cases.
- View, add, edit, and delete cases such as `testcase 001` and `testcase 002` in the Chinese VS Code sidebar UI.
- Create a blank case with one click. AI updates `main.<ext>` only when that new case is filled and saved, or when a case is deleted. Editing an existing case only saves the data and shows a reminder that the scaffold may need to be regenerated.
- Regenerate `main.<ext>` at any time with **重新编写测试脚手架**. Test-case controls are locked while AI extraction or scaffold generation is in progress.
- Run one case or all cases directly from the sidebar. Each card shows its status, expected output, and the actual output returned by `main.<ext>`.
- Sync the current `solution.<ext>` code to the matching open LeetCode page with the sidebar button. The former Command Palette sync command is no longer used.
- Open the project's GitHub issue page from the sidebar.

Problem metadata, editable test-case data, and overwrite backups are kept in the problem's `.leetcode_cph` folder. API keys remain in VS Code Secret Storage and are never written there. Add `**/.leetcode_cph/` to your repository's ignore rules if you do not want local test state committed.

## Installation

LeetCode CPH requires both the browser extension and the VS Code extension.

### Install the Edge extension

1. Open `edge://extensions` in Microsoft Edge.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose this repository's [`edge-extension`](./edge-extension) folder.

If you use an InPrivate window, open the extension details and enable **Allow in InPrivate**.
When upgrading an older unpacked copy, select **Reload**. If VS Code still reports that the browser extension is disconnected, remove the old unpacked entry and load this folder again once.

### Install the VS Code extension

If you already have a `.vsix` package:

1. Open the **Extensions** view in VS Code.
2. Select `...` and then **Install from VSIX...**.
3. Choose `leetcode-cph-receiver-0.8.0.vsix` (or the newer package you built).
4. Reload VS Code after installation.

You can also install it from a terminal:

```powershell
code --install-extension .\vscode-extension\leetcode-cph-receiver-0.8.0.vsix
```

To build the VSIX from source, run:

```powershell
Set-Location .\vscode-extension
npx --yes @vscode/vsce@latest package --no-dependencies
```

The generated `.vsix` file is placed in the `vscode-extension` folder.

## Usage

### 1. Capture a problem

1. Open a workspace in VS Code.
2. Open a LeetCode problem in Edge and select the desired editor language.
3. Click the **LeetCode CPH Capture** browser-extension icon.
4. The extension creates `<output directory>/<problem title>/solution.<ext>` and opens it in VS Code. The default output directory is `leetcode` and can be changed in VS Code settings.

If an AI key is configured, example extraction and `main.<ext>` generation continue in the background. While either job is running, test cases cannot be added, edited, or deleted.

Capturing a problem again replaces its recorded test state and starts a fresh AI extraction; old automatic and manual cases and deletion history are not reused. A different problem with the same title also replaces the prior registered files and state. Previous registered files are backed up under `.leetcode_cph/backups`. Unsaved editors are not overwritten; save or close them and capture again.

This storage layout is intentionally incompatible with older releases. Existing records in VS Code's former private extension storage or in legacy problem-folder files are not imported; capture the problem again to create `.leetcode_cph`.

### 2. Configure AI and manage test cases

1. Open the **LeetCode CPH** view in the VS Code Activity Bar.
2. Select **配置 AI**, choose GLM, DeepSeek, or Qwen, and enter an API key.
3. Capture the problem. The selected AI extracts grounded examples and creates `main.<ext>` beside `solution.<ext>`.
4. Select **+新增测试用例** to create an empty card. Fill its input and expected output, then select **保存** in the card header. The first save generates the updated `main.<ext>`.
5. Later edits to an existing case are saved without calling AI. The sidebar reminds you that you may need to select **重新编写测试脚手架**. Deleting a case updates the scaffold automatically.

If no key is configured, capture still saves the problem and solution, but no cases or `main.<ext>` are generated automatically.

### 3. Run tests

- Select **运行** on a case to run only that case.
- Select **运行全部测试用例** to run all cases.
- Review the status, expected output, and actual output in each card. Actual output always comes from the corresponding result emitted by `main.<ext>`.

The generated `main.<ext>` is executable code and can be run directly from the sidebar in a trusted workspace.

Compile and runtime failures are shown in the sidebar and the LeetCode CPH output channel. A failed run never sends code to AI or rewrites `main.<ext>` automatically, because the failure may be in the solution rather than the scaffold. If the scaffold itself needs replacement, select **重新编写测试脚手架** yourself.

### 4. Sync to LeetCode

1. Keep the matching LeetCode problem page open in Edge.
2. Make sure the browser editor language matches `solution.<ext>`.
3. Select **同步代码到 LeetCode** in the sidebar.

The current editor contents, including unsaved changes, are sent to the matching page.

## Supported local languages

Local test execution supports:

- C, C++, C#, Rust, Go, Haskell
- Python, Ruby, Java, JavaScript, TypeScript
- Kotlin, Swift, PHP, Scala

The required compiler or runtime must be installed locally and available through `PATH`. SQL test execution is not supported.

## Unlinked local solutions

If a workspace already contains `solution.<ext>` but the extension cannot find a valid sibling `.leetcode_cph` record and source URL, the file is treated as an unlinked local solution. You may manually add, edit, and delete test cases, but AI extraction, `main.<ext>` generation, local execution, and browser sync are disabled because the problem cannot be matched safely.

## Feedback

Use **反馈 Bug** in the sidebar or visit the [GitHub repository](https://github.com/dd1000001000/simple-leetcode-cph).

## License

[MIT](./LICENSE)
