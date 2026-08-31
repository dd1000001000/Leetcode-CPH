# LeetCode CPH：Edge + VS Code

在力扣题页点击一次，就把题目、题面、样例和当前编辑器里的代码保存到当前 VS Code 工作区。

## 安装

1. 在 Edge 打开 `edge://extensions`，启用“开发人员模式”，选择“加载解压缩的扩展”，并选择 [`edge-extension`](./edge-extension) 文件夹。
2. 在 VS Code 中打开 [`vscode-extension`](./vscode-extension) 文件夹，按 `F5` 启动“扩展开发宿主”；或者使用 `vsce package` 打出 VSIX 后安装。
3. 在这个扩展开发宿主窗口中打开你的刷题工作区。接收服务会自动监听 `http://127.0.0.1:27121`。
4. 打开力扣题页并在编辑器中写代码，直接点击 Edge 工具栏的 **LeetCode CPH Capture** 图标。

图标角标会反馈结果：`...` 表示正在保存，`OK` 表示完成，`!` 表示失败；将鼠标悬停在图标上可查看原因或保存目录。

每题会写入工作区的 `leetcode/<题号-题名>/`：

- `solution.<语言扩展名>`：当前编辑器代码
- `README.md`：题面和样例
- `metadata.json`：原始抓取数据与来源链接

## 从 VS Code 回传代码到浏览器

1. 保持对应题目的 LeetCode 页面处于打开状态，并在网页中选择与本地代码相同的语言。
2. 在 VS Code 打开该题目目录中的 `solution.*`，可以是未保存的编辑内容。
3. 按 `Ctrl+Shift+P`，运行 **LeetCode CPH: Send Current Solution to Browser**。

扩展会读取同目录 `metadata.json` 中的题目链接，只把代码写回对应题目。若同一题在多个 Edge 窗口/标签页中打开，会优先选择标准题页、其次 `/description/`、再是其他子页面，路径等级相同才取最近活动的一个（详见下文“URL 兼容范围”）；若浏览器语言与本地抓取语言不一致，扩展会拒绝同步，避免覆盖错误语言的编辑器。

若提示“浏览器扩展未连接”或同步超时，通常只是 Edge 扩展的服务进程处于休眠：扩展每 30 秒会自动重连，等待约半分钟重试即可；仍失败时可在 `edge://extensions` 重新加载扩展。

## 设置

VS Code 设置中可修改：

- `leetcodeCph.port`：本地端口，默认 `27121`（需同时修改 Edge 扩展的 `background.js`）。
- `leetcodeCph.outputDirectory`：输出目录，默认 `leetcode`。
- `leetcodeCph.openSolutionAfterCapture`：收到后自动打开解答文件，默认开启。

网页中选中的语言会决定解答文件后缀，例如 `C++17` → `solution.cpp`、`Python3` → `solution.py`、`Java 17` → `solution.java`。未能识别的语言会保存为 `solution.txt`。

## 说明

插件仅向本机 `127.0.0.1` 发数据。它优先读取 LeetCode 的 Monaco 编辑器模型；页面改版时会尝试 textarea、CodeMirror 和编辑器 DOM 作为回退方式。

## URL 兼容范围

- 支持的力扣域名：`leetcode.com`、`leetcode.cn`，均接受可选的 `www.` 前缀；旧域名 `leetcode-cn.com` 不再支持（与扩展 `manifest.json` 的 `host_permissions` 保持一致）。
- 同一道题的所有路径变体视为同一道题：`/problems/<slug>/`、`/description/`、`/submissions/`、`/solutions/`、`/solution/<id>/` 等。
- 从 VS Code 回传代码时优先匹配与 `metadata.json` 中来源**同域同题**的标签页，找不到时才匹配**跨域同题**的标签页。
- 同域同题的多个标签页按页面路径优先级选择：标准题页 `/problems/<slug>/` 优先，其次 `/description/`，再是 `/submissions/`、`/solutions/`、`/solution/<id>/` 等子页面；路径等级相同才按最近访问时间（以及当前窗口/活动标签）选择，其余同题标签页不计入改动。

## InPrivate 窗口

Edge 的 InPrivate 窗口默认不加载扩展。若需要在 InPrivate 中抓取或回传代码，请在 `edge://extensions` 的扩展详情中打开“允许 InPrivate 中使用”开关，然后重新打开 InPrivate 窗口。若 InPrivate 页面上扩展角标不生效，请先检查该开关。

## 开发与测试

- 运行全部测试（共享 URL matcher 与 WebSocket 生命周期）：`node --test test/`（或 `npm test`）。
- 原有临时校验脚本（在 vm 沙箱中加载真实扩展文件）：`node .tmp-test-background.js`、`node .tmp-test-collector.js`。

## License

[MIT](./LICENSE)
