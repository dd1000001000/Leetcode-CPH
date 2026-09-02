# LeetCode CPH

[简体中文](./README_zh.md)

LeetCode CPH helps you move smoothly between LeetCode and VS Code: capture a problem and its examples, manage test cases from a sidebar, generate test scaffolds with AI, and sync your local solution back to LeetCode.

## Features

- Capture the current LeetCode problem statement, examples, and editor code into your VS Code workspace.
- View multiple test cases in the **LeetCode CPH** sidebar on the left side of VS Code.
- Add or delete test cases manually. Cases are named `testcase 001`, `testcase 002`, and so on.
- Configure a GLM, DeepSeek, or Qwen API key to generate or update a local test scaffold.
- Automatically update the test scaffold when a test case is added or deleted.
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
4. VS Code saves the problem and current code, then opens the corresponding `solution.*` file.

### Manage test cases and generate tests

1. Open the problem's `solution.*` file, or its generated `testcase.*` file.
2. Click the **LeetCode CPH** icon in the VS Code Activity Bar.
3. Review the examples captured from LeetCode. Add a case by entering its input and expected output, or delete a case you no longer need.
4. On first use, click **配置 AI** (Configure AI), choose GLM, DeepSeek, or Qwen, and enter an API key.
5. Click **生成/更新测试脚手架** (Generate/Update Test Scaffold) to create test code for the current problem.

After that, adding or deleting a test case automatically updates the test scaffold. Save any manual changes to the scaffold before using those actions.

### Sync code to LeetCode

1. Keep the matching LeetCode problem page open.
2. Make sure its editor language matches the local `solution.*` language.
3. Click **同步代码到 LeetCode** (Sync Code to LeetCode) in the sidebar.

The button uses the code currently open in VS Code, including unsaved edits. The former Command Palette sync command is no longer used.

## AI and data notes

- API keys are stored securely by VS Code and are not written to workspace files.
- Generating a test scaffold sends the problem statement, current solution, and test cases to the AI provider you select. Please use the provider according to its terms and pricing.
- If examples on LeetCode change after you capture the problem again, the sidebar will ask you to update the test scaffold.

## Troubleshooting

- If syncing fails, check that the Edge extension is enabled, the problem page is still open, and the browser language matches the local solution language.
- For an Edge InPrivate window, enable **Allow in InPrivate** in the extension details first.

## Feedback

Use **反馈 Bug** (Report Bug) in the sidebar, or open the [GitHub repository](https://github.com/dd1000001000/simple-leetcode-cph) directly.

## License

[MIT](./LICENSE)
