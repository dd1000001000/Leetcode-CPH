# LeetCode CPH

[简体中文](./README_zh.md)

LeetCode CPH helps you move smoothly between LeetCode and VS Code: capture a problem, use your AI provider to extract its examples, manage test cases from a sidebar, run them locally, and sync your local solution back to LeetCode.

## Features

- Capture the current LeetCode editor code as one readable, title-named file such as `1. Two Sum.py` in your VS Code workspace.
- Configure a GLM, DeepSeek, or Qwen API key. After capture, the selected AI extracts only explicit examples grounded in the captured problem text; without a configured key, no automatic test cases or scaffold are created.
- View and edit multiple test cases in the **LeetCode CPH** sidebar on the left side of VS Code. Cases are named `testcase 001`, `testcase 002`, and so on.
- Add a blank case with **+新增测试用例**, then fill in its input and expected output directly in the card.
- Keep the problem metadata, editable test cases, AI-generated scaffold, runtime copy, and backups in VS Code's workspace-private extension storage instead of cluttering the project folder.
- Automatically generate a private test scaffold after a successful AI extraction. Adding, editing, or deleting a case automatically updates that scaffold while the add button and all delete buttons are temporarily locked.
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
4. VS Code immediately saves the browser code as `<problem title>.<language extension>` and opens that file. Problem context and test data are stored privately. If an AI key is configured, example extraction and scaffold generation continue in the background; they do not delay the capture. Without a key, capture still saves the solution but creates no automatic cases or scaffold.

Re-capturing the same language refreshes the registered title-named file with the current browser code. If the saved local file differs, its previous contents are backed up in private extension storage. An unsaved local editor is never overwritten: save or close it before capturing again.

If two registered problems have the same title and language extension, the latest capture intentionally overwrites the shared title-named solution and replaces its active private record; no `(slug)` filename is created. The displaced record is retained only in the extension's private overwrite backup area.

### Manage test cases and generate tests

1. Open the title-named solution file created by LeetCode CPH.
2. Click the **LeetCode CPH** icon in the VS Code Activity Bar.
3. On first use, click **配置 AI** (Configure AI), choose GLM, DeepSeek, or Qwen, and enter an API key.
4. Capture the problem after the key is configured. AI extracts explicit examples from the saved problem context and automatically creates or refreshes the scaffold. Capture the problem again to retry a failed extraction or scaffold update.
5. Review or edit the case cards. Click **+新增测试用例** to add a blank card, then fill in its input and expected output. Click **保存并更新** to save the card and update the scaffold.
6. Use **运行** on a card or **运行全部测试用例** after the scaffold is generated. At run time the extension combines the saved visible solution with its private scaffold. The card shows the actual output and a clear expected/actual difference when they do not match.

Adding, editing, or deleting a test case automatically updates the test scaffold. During that update, the add button and every delete button are disabled. Save any manual changes to the scaffold before using those actions. You can still save a manual case before configuring a key, but the scaffold remains pending until you configure an AI provider and capture the problem again.

### Sync code to LeetCode

1. Keep the matching LeetCode problem page open.
2. Make sure its editor language matches the open local solution file.
3. Click **同步代码到 LeetCode** (Sync Code to LeetCode) in the sidebar.

The button uses the code currently open in VS Code, including unsaved edits. The former Command Palette sync command is no longer used.

## AI and data notes

- API keys are stored securely by VS Code and are not written to workspace files.
- Extracting examples sends the captured problem statement and example text to the AI provider you select. Generating or updating a scaffold also sends the current solution and testcase data. Please use the provider according to its terms and pricing.
- Re-capturing a problem saves the browser snapshot first, then re-extracts examples and refreshes a changed scaffold in the background. Previous saved solution and scaffold contents are backed up in private extension storage before replacement.
- Private problem/test state belongs to this VS Code workspace and is not committed to Git. Clearing VS Code workspace storage or uninstalling extension data can remove it; the visible title-named solution file remains in your workspace.
- A generated scaffold is executable local code. Run tests only in a trusted workspace; on the first run after generated code changes, use **查看测试代码** in the confirmation dialog if you want to inspect the private scaffold before approving it. Local execution uses your account's local permissions; it is not a sandbox.

## Troubleshooting

- If syncing fails, check that the Edge extension is enabled, the problem page is still open, and the browser language matches the local solution language.
- For an Edge InPrivate window, enable **Allow in InPrivate** in the extension details first.
- Folders created by versions before 0.5 are copied into private storage when that problem is captured again, but are not deleted automatically. After verifying the new title-named file and sidebar cases, you may archive the old folder yourself.

## Feedback

Use **反馈 Bug** (Report Bug) in the sidebar, or open the [GitHub repository](https://github.com/dd1000001000/simple-leetcode-cph) directly.

## License

[MIT](./LICENSE)
