# LeetCode CPH

[English](./README.md)

LeetCode CPH 通过浏览器扩展与 VS Code 插件配合，让你抓取 LeetCode 题目、在本地管理和运行测试用例，并把解答同步回已打开的题目页。

## 功能

- 把当前 LeetCode 题目和编辑器代码保存到以题目名称命名的文件夹：

  ```text
  <输出目录>/<题目名称>/
    solution.<语言后缀>
    main.<语言后缀>
    .leetcode_cph/
      metadata.json
      testcases.json
      backups/
  ```

  `solution.<语言后缀>` 是你的解答；`main.<语言后缀>` 是 AI 生成的本地测试入口，只有 AI 生成成功后才会创建。
- 支持配置 GLM、DeepSeek 或 Qwen；API Key 保存在 VS Code 的安全 Secret Storage 中。
- 使用用户配置的 AI 从已抓取题面中提取测试用例。未配置 API Key 时，插件不会自动提取或生成任何测试用例。
- 在 VS Code 左侧中文界面中查看、新增、编辑和删除 `testcase 001`、`testcase 002` 等测试用例。
- 一键新增空白用例。只有该新用例填写并首次保存，或者删除用例时，才会让 AI 更新 `main.<语言后缀>`。修改已有用例只保存数据并提醒可能需要重新编写脚手架。
- 可随时点击 **重新编写测试脚手架**。AI 正在提取用例或生成测试代码时，用例操作会被锁定。
- 直接在侧边栏单独运行一个用例或运行全部用例，并查看状态、预期输出和 `main.<语言后缀>` 返回的实际输出。
- 在侧边栏点击按钮，把当前 `solution.<语言后缀>` 同步到匹配的 LeetCode 题目页。旧的命令面板同步方式已移除。
- 从侧边栏直接打开项目的 GitHub Bug 反馈页面。

题目信息、可编辑测试用例和覆盖备份保存在每道题目录内的 `.leetcode_cph` 文件夹。API Key 仍只保存在 VS Code Secret Storage 中，绝不会写入该目录。如果不希望把本地测试状态提交到 Git，请在仓库忽略规则中加入 `**/.leetcode_cph/`。

## 安装

LeetCode CPH 需要同时安装浏览器扩展和 VS Code 插件。

### 安装 Edge 扩展

1. 在 Microsoft Edge 中打开 `edge://extensions`。
2. 开启“开发人员模式”。
3. 点击“加载解压缩的扩展”。
4. 选择本仓库的 [`edge-extension`](./edge-extension) 文件夹。

如果在 InPrivate 窗口中使用，请进入扩展详情并开启“允许 InPrivate 中使用”。
从旧版解压缩扩展升级时，请先点击“重新加载”。如果 VS Code 仍提示浏览器扩展未连接，请删除旧的解压缩扩展，并重新加载一次本目录。

### 安装 VS Code 插件

如果已经有 `.vsix` 安装包：

1. 在 VS Code 中打开“扩展”面板。
2. 点击 `...`，选择“从 VSIX 安装…” 。
3. 选择 `leetcode-cph-receiver-0.8.1.vsix`（或你构建的更新版本）。
4. 安装后重新加载 VS Code。

也可以在终端中安装：

```powershell
code --install-extension .\vscode-extension\leetcode-cph-receiver-0.8.1.vsix
```

如需从源码构建 VSIX，请运行：

```powershell
Set-Location .\vscode-extension
npx --yes @vscode/vsce@latest package --no-dependencies
```

生成的 `.vsix` 文件位于 `vscode-extension` 文件夹。

## 使用方法

### 1. 抓取题目

1. 在 VS Code 中打开一个工作区。
2. 在 Edge 中打开 LeetCode 题目，并选择需要的编辑器语言。
3. 点击浏览器工具栏中的 **LeetCode CPH Capture** 图标。
4. 插件会创建 `<输出目录>/<题目名称>/solution.<语言后缀>` 并在 VS Code 中打开。默认输出目录为 `leetcode`，可在 VS Code 设置中修改。

如果已经配置 AI Key，样例提取与 `main.<语言后缀>` 生成会在后台继续。任一任务进行期间，都不能新增、编辑或删除测试用例。

再次抓取题目时，会覆盖原测试记录并开始全新的 AI 提取；旧的自动用例、手动用例和删除记录都不会继续使用。同名但不同的题目也会直接替换原来的登记文件和记录，旧文件备份在 `.leetcode_cph/backups`。插件不会覆盖尚未保存的编辑器，请先保存或关闭文件再重新抓取。

此存储结构刻意不兼容旧版本。原 VS Code 扩展私有区域或题目根目录中的旧记录不会被读取或迁移；升级后请从浏览器重新抓取题目，以创建 `.leetcode_cph`。

### 2. 配置 AI 并管理测试用例

1. 在 VS Code 活动栏中打开 **LeetCode CPH**。
2. 点击 **配置 AI**，选择 GLM、DeepSeek 或 Qwen，并填写 API Key。
3. 抓取题目；所选 AI 会从题面中提取有原文依据的样例，并在 `solution.<语言后缀>` 旁创建 `main.<语言后缀>`。
4. 点击 **+新增测试用例** 创建空白卡片，填写输入和预期输出后，点击卡片顶部的 **保存**。首次保存时才会让 AI 更新 `main.<语言后缀>`。
5. 之后修改已有用例时只保存数据，不会自动调用 AI；侧边栏会提醒你可能需要点击 **重新编写测试脚手架**。删除用例仍会自动更新脚手架。

未配置 Key 时仍会保存题目和解答，但不会自动生成用例或 `main.<语言后缀>`。

### 3. 运行测试

- 点击用例上的 **运行**，只运行当前用例。
- 点击 **运行全部测试用例**，运行全部用例。
- 在用例卡片中查看状态、预期输出和实际输出。实际输出始终来自 `main.<语言后缀>` 返回的对应用例结果。

AI 生成的 `main.<语言后缀>` 是可执行代码，可在受信任的工作区中直接从侧边栏运行。

编译和运行错误会显示在侧边栏和 LeetCode CPH 输出频道中。运行失败不会自动把代码发给 AI，也不会自动改写 `main.<语言后缀>`，因为错误也可能来自用户解答。如确认是脚手架问题，请主动点击 **重新编写测试脚手架**。

### 4. 同步到 LeetCode

1. 保持匹配的 LeetCode 题目页在 Edge 中打开。
2. 确认网页编辑器语言与 `solution.<语言后缀>` 一致。
3. 在侧边栏点击 **同步代码到 LeetCode**。

同步时会使用当前编辑器中的代码，包括尚未保存的修改。

## 本地运行支持的语言

本地测试执行支持：

- C、C++、C#、Rust、Go、Haskell
- Python、Ruby、Java、JavaScript、TypeScript
- Kotlin、Swift、PHP、Scala

对应编译器或运行时需要已安装在本机，并能通过 `PATH` 调用。暂不支持 SQL 本地测试执行。

## 未关联的本地解答

如果工作区中已经存在 `solution.<语言后缀>`，但插件找不到同目录下有效的 `.leetcode_cph` 题目记录和来源 URL，该文件会被视为“未关联的本地解答”。此时只允许手动新增、编辑和删除测试用例；由于无法安全匹配题目，AI 提取、`main.<语言后缀>` 生成、本地运行和浏览器同步都会被禁用。

## 反馈

在侧边栏点击 **反馈 Bug**，或直接访问 [GitHub 仓库](https://github.com/dd1000001000/simple-leetcode-cph)。

## 许可证

[MIT](./LICENSE)
