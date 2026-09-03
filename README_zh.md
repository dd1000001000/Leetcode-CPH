# LeetCode CPH

[English](./README.md)

LeetCode CPH 让你在 LeetCode 网页和 VS Code 之间快速切换：抓取题目、借助你的 AI 配置提取样例、在侧边栏管理与运行测试用例，并把本地代码同步回 LeetCode。

## 功能

- 一键抓取当前 LeetCode 题目的题面和编辑器代码到 VS Code 工作区。
- 配置 GLM、DeepSeek 或 Qwen 的 API Key 后，抓取题目时会由所选 AI 从已保存题面中提取有原文依据的明确样例；未配置 Key 时不会自动生成测试用例或测试脚手架。
- 在 VS Code 左侧的 **LeetCode CPH** 侧边栏查看和编辑多组测试用例；测试名称按 `testcase 001`、`testcase 002` 的形式编号。
- 点击 **+新增测试用例** 创建输入和预期输出均为空的用例，并直接在卡片内填写内容。
- 成功提取样例后自动生成本地测试脚手架；新增、编辑或删除测试用例时会自动更新脚手架，更新期间新增按钮和所有删除按钮会暂时置灰。AI 覆盖已有已保存脚手架前会先备份为 `testcase.*.bak`。
- 在侧边栏中单独运行一个测试用例或运行全部测试用例，并查看实际输出与预期输出的差异。目前本地运行支持 Python 与 JavaScript 脚手架。
- 在侧边栏点击按钮，将当前本地解答同步回已打开的 LeetCode 页面。
- 侧边栏内提供 GitHub Bug 反馈入口。

## 安装

### 1. 安装 Edge 扩展

1. 在 Edge 地址栏打开 `edge://extensions`。
2. 开启“开发人员模式”。
3. 点击“加载解压缩的扩展”，选择本仓库的 [`edge-extension`](./edge-extension) 文件夹。

### 2. 安装 VS Code 插件

如果已有 VSIX 安装包：

1. 在 VS Code 打开“扩展”面板。
2. 点击右上角 `...`，选择 **从 VSIX 安装…**。
3. 选择 `leetcode-cph-receiver-*.vsix` 文件。
4. 安装完成后执行 **Developer: Reload Window** 重载 VS Code。

如果需要从源码生成 VSIX，在项目根目录运行：

```powershell
Set-Location .\vscode-extension
npx --yes @vscode/vsce@latest package --no-dependencies
```

生成的 VSIX 会位于 `vscode-extension` 文件夹中。也可以使用 VS Code 命令行工具安装：

```powershell
code --install-extension .\leetcode-cph-receiver-<version>.vsix
```

将 `<version>` 替换为实际生成的版本号，并在安装后重载 VS Code。

## 使用方法

### 抓取题目

1. 在 VS Code 中打开你的刷题工作区。
2. 在 Edge 打开 LeetCode 题目页，并在网页编辑器中选择要使用的语言。
3. 点击 Edge 工具栏中的 **LeetCode CPH Capture** 图标。
4. VS Code 会保存题目和当前代码，并打开对应的 `solution.*` 文件。若已配置 AI Key，还会自动提取有原文依据的样例并生成首个 `testcase.*` 脚手架；未配置 Key 时仍会保存题目，但不会自动创建测试用例或脚手架。

### 管理测试用例与生成测试代码

1. 打开题目对应的 `solution.*` 文件，或生成后的 `testcase.*` 文件。
2. 点击 VS Code 左侧活动栏的 **LeetCode CPH** 图标。
3. 首次使用时，点击 **配置 AI**，选择 GLM、DeepSeek 或 Qwen，并填写 API Key。
4. 配置 Key 后重新抓取题目。AI 会从已保存的题面中提取明确样例，并自动创建或更新脚手架。若提取或生成失败，重新抓取题目即可重试。
5. 在卡片中查看或修改测试用例。点击 **+新增测试用例** 会创建空白卡片；填写后点击 **保存并更新**，插件会保存该卡片并更新脚手架。
6. 脚手架生成后，可点击单个卡片的 **运行**，或点击 **运行全部测试用例**。不一致时卡片会显示实际输出和预期/实际差异。

之后每次新增、编辑或删除测试用例，插件都会自动更新测试脚手架；更新期间新增按钮和所有删除按钮都会暂时置灰。若你正在手动编辑测试脚手架，请先保存再执行这些操作。未配置 Key 时也可以先保存手动测试用例，但脚手架会保持待更新状态；配置 AI 后重新抓取题目即可生成。

### 同步代码到 LeetCode

1. 保持对应的 LeetCode 题目页处于打开状态。
2. 确认网页编辑器语言与本地 `solution.*` 的语言一致。
3. 在侧边栏点击 **同步代码到 LeetCode**。

同步按钮会使用当前编辑器中的代码，即使该文件尚未保存。旧的命令面板同步方式不再使用。

## AI 与数据提示

- API Key 会安全保存在 VS Code 中，不会写入工作区文件。
- 提取样例时，会向你选择的 AI Provider 发送已抓取的题面与样例文本；生成或更新脚手架时，还会发送当前解答和测试用例。请根据其服务条款和计费规则使用。
- 重新抓取同一道题会自动重新提取样例并更新发生变化的脚手架；覆盖前会把旧的已保存脚手架保留为 `testcase.*.bak`。
- 测试脚手架是可执行的本地代码。请只在受信任的工作区运行，并在运行前审阅 `testcase.*`；生成或变更后的首次运行需要确认。它会以你本机账户的权限运行，不是沙箱环境。

## 常见问题

- 若同步失败，请确认 Edge 扩展已启用、题目页仍然打开，并且网页语言与本地语言一致。
- 若题目页位于 Edge InPrivate 窗口，请在扩展详情中开启“允许 InPrivate 中使用”。

## 反馈

可在侧边栏点击 **反馈 Bug**，或直接前往 [GitHub 仓库](https://github.com/dd1000001000/simple-leetcode-cph) 提交问题。

## License

[MIT](./LICENSE)
