# LeetCode CPH：Edge + VS Code

在力扣题页点击一次，就把题目、题面、样例和当前编辑器里的代码保存到当前 VS Code 工作区。

## 安装

1. 在 Edge 打开 `edge://extensions`，启用“开发人员模式”，选择“加载解压缩的扩展”，并选择 [`edge-extension`](./edge-extension) 文件夹。
2. 在 VS Code 中打开 [`vscode-extension`](./vscode-extension) 文件夹，按 `F5` 启动“扩展开发宿主”；或者使用 `vsce package` 打出 VSIX 后安装。
3. 在这个扩展开发宿主窗口中打开你的刷题工作区。接收服务会自动监听 `http://127.0.0.1:27121`。
4. 打开力扣题页并在编辑器中写代码，点击 Edge 工具栏的 **LeetCode CPH Capture**，选择“带走当前题目和代码”。

每题会写入工作区的 `leetcode/<题号-题名>/`：

- `solution.<语言扩展名>`：当前编辑器代码
- `README.md`：题面和样例
- `metadata.json`：原始抓取数据与来源链接

## 设置

VS Code 设置中可修改：

- `leetcodeCph.port`：本地端口，默认 `27121`（需同时修改 Edge 扩展的 `popup.js`）。
- `leetcodeCph.outputDirectory`：输出目录，默认 `leetcode`。
- `leetcodeCph.openSolutionAfterCapture`：收到后自动打开解答文件，默认开启。

## 说明

插件仅向本机 `127.0.0.1` 发数据。它优先读取 LeetCode 的 Monaco 编辑器模型；页面改版时会尝试 textarea、CodeMirror 和编辑器 DOM 作为回退方式。
