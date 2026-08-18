const statusElement = document.getElementById('status');
const captureButton = document.getElementById('capture');

function setStatus(message, kind = '') {
  statusElement.textContent = message;
  statusElement.className = kind;
}

captureButton.addEventListener('click', async () => {
  captureButton.disabled = true;
  setStatus('正在读取题目和编辑器…');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https:\/\/leetcode\.(cn|com)\//.test(tab.url || '')) {
      throw new Error('请先打开 leetcode.cn 或 leetcode.com 的题目页面。');
    }

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['page-collector.js'],
      world: 'MAIN'
    });
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: () => {
        try {
          return { ok: true, payload: window.__LEETCODE_CPH_COLLECT__?.() };
        } catch (error) {
          return { ok: false, error: error.message || '未能读取题目页面。' };
        }
      }
    });
    if (!result?.result?.ok || !result.result.payload) {
      throw new Error(result?.result?.error || '未能读取题目页面。');
    }

    const response = await fetch('http://127.0.0.1:27121/capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result.result.payload)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `本地接收端返回 ${response.status}`);

    setStatus(`已保存：${body.folder}`, 'success');
  } catch (error) {
    setStatus(error.message || '发送失败。', 'error');
  } finally {
    captureButton.disabled = false;
  }
});
