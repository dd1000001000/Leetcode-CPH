const RECEIVER_URL = 'http://127.0.0.1:27121/capture';

async function setState(tabId, text, color, title) {
  await Promise.all([
    chrome.action.setBadgeText({ tabId, text }),
    chrome.action.setBadgeBackgroundColor({ tabId, color }),
    chrome.action.setTitle({ tabId, title })
  ]);
}

async function collect(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['page-collector.js'],
    world: 'MAIN'
  });
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
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
  return result.result.payload;
}

chrome.action.onClicked.addListener(async (tab) => {
  const tabId = tab.id;
  try {
    if (!tabId || !/^https:\/\/leetcode\.(cn|com)\//.test(tab.url || '')) {
      throw new Error('请先打开 leetcode.cn 或 leetcode.com 的题目页面。');
    }
    await setState(tabId, '...', '#1677ff', '正在带走题目和代码…');
    const payload = await collect(tabId);
    const response = await fetch(RECEIVER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `本地接收端返回 ${response.status}`);
    await setState(tabId, 'OK', '#137333', `已保存：${body.folder}`);
  } catch (error) {
    const message = error.message || '保存失败。';
    if (tabId) await setState(tabId, '!', '#b3261e', message);
  }
});
