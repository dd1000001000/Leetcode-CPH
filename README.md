# LeetCode CPH

[简体中文](./README_zh.md)

LeetCode CPH helps you move smoothly between LeetCode and VS Code: capture a problem, use your AI provider to extract its examples, manage test cases from a sidebar, run them locally, and sync your local solution back to LeetCode.

## Features

- Capture the current LeetCode problem statement and editor code into your VS Code workspace.
- Configure a GLM, DeepSeek, or Qwen API key. After capture, the selected AI extracts only explicit examples grounded in the captured problem text; without a configured key, no automatic test cases or scaffold are created.
- View and edit multiple test cases in the **LeetCode CPH** sidebar on the left side of VS Code. Cases are named `testcase 001`, `testcase 002`, and so on.
- Add a blank case with **+新增测试用例**, then fill in its input and expected output directly in the card.
- Automatically generate a local test scaffold after a successful AI extraction. Adding, editing, or deleting a case automatically updates that scaffold while the add button and all delete buttons are temporarily locked. An existing saved scaffold is backed up as `testcase.*.bak` before AI replacement.
- Run one test case or all test cases from the sidebar, and compare each expected output with the actual output. Local execution currently supports Python and JavaScript scaffolds.
- Sync the current local solution to an open LeetCode problem page from the sidebar.
- Open the GitHub issue repository directly from the sidebar.

## Installation

### 1. Install the Edge extension

1. Open `edge://extensions` in Edge.
2. Turn on **Developer mode**.
3. Select **Load unpacked** and choose this repository's [`edge-extension`](./edge-extension) folder.

### 2. Install the VS Code extension

If you already have a VSIX file:

1. Open the **Extensions** view in VS Code.
2. Select `...` in the upper-right corner and choose **Install from VSIX...**.
3. Choose the `leetcode-cph-receiver-*.vsix` file.
4. Run **Developer: Reload Window** after installation.

To create a VSIX from source, run this from the repository root:

```powershell
Set-Location .\vscode-extension
npx --yes @vscode/vsce@latest package --no-dependencies
```

The generated VSIX is placed in `vscode-extension`. You can also install it through the VS Code command-line tool:

```powershell
code --install-extension .\leetcode-cph-receiver-<version>.vsix
```

Replace `<version>` with the generated version number, then reload VS Code.

## How to use it

### Capture a problem

1. Open your practice workspace in VS Code.
2. Open a LeetCode problem in Edge and select the language you want in the web editor.
3. Click the **LeetCode CPH Capture** icon in the Edge toolbar.
4. VS Code saves the problem and current code, then opens the corresponding `solution.*` file. If an AI key is configured, it also extracts source-grounded examples and creates the first `testcase.*` scaffold automatically. Without a key, capture still saves the problem but creates no automatic cases or scaffold.

### Manage test cases and generate tests

1. Open the problem's `solution.*` file, or its generated `testcase.*` file.
2. Click the **LeetCode CPH** icon in the VS Code Activity Bar.
3. On first use, click **配置 AI** (Configure AI), choose GLM, DeepSeek, or Qwen, and enter an API key.
4. Capture the problem after the key is configured. AI extracts explicit examples from the saved problem context and automatically creates or refreshes the scaffold. Capture the problem again to retry a failed extraction or scaffold update.
5. Review or edit the case cards. Click **+新增测试用例** to add a blank card, then fill in its input and expected output. Click **保存并更新** to save the card and update the scaffold.
6. Use **运行** on a card or **运行全部测试用例** after the scaffold is generated. The card shows the actual output and a clear expected/actual difference when they do not match.

Adding, editing, or deleting a test case automatically updates the test scaffold. During that update, the add button and every delete button are disabled. Save any manual changes to the scaffold before using those actions. You can still save a manual case before configuring a key, but the scaffold remains pending until you configure an AI provider and capture the problem again.

### Sync code to LeetCode

1. Keep the matching LeetCode problem page open.
2. Make sure its editor language matches the local `solution.*` language.
3. Click **同步代码到 LeetCode** (Sync Code to LeetCode) in the sidebar.

The button uses the code currently open in VS Code, including unsaved edits. The former Command Palette sync command is no longer used.

## AI and data notes

- API keys are stored securely by VS Code and are not written to workspace files.
- Extracting examples sends the captured problem statement and example text to the AI provider you select. Generating or updating a scaffold also sends the current solution and testcase data. Please use the provider according to its terms and pricing.
- Re-capturing a problem automatically re-extracts examples and refreshes a changed scaffold. The previous saved scaffold is retained as `testcase.*.bak` before replacement.
- A generated scaffold is executable local code. Run tests only in a trusted workspace, review `testcase.*` before running it, and confirm the first run after generated code changes. Local execution uses your account's local permissions; it is not a sandbox.

## Troubleshooting

- If syncing fails, check that the Edge extension is enabled, the problem page is still open, and the browser language matches the local solution language.
- For an Edge InPrivate window, enable **Allow in InPrivate** in the extension details first.

## Feedback

Use **反馈 Bug** (Report Bug) in the sidebar, or open the [GitHub repository](https://github.com/dd1000001000/simple-leetcode-cph) directly.

## License

[MIT](./LICENSE)
