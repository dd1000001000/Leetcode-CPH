const RECEIVER_URL = 'http://127.0.0.1:27121/capture';
const SOCKET_URL = 'ws://127.0.0.1:27121/ws';
let receiverSocket;
let reconnectTimer;

async function setState(tabId, text, color, title) {
  await Promise.all([
    chrome.action.setBadgeText({ tabId, text }),
    chrome.action.setBadgeBackgroundColor({ tabId, color }),
    chrome.action.setTitle({ tabId, title })
  ]);
}

function sendSocket(message) {
  if (receiverSocket?.readyState === WebSocket.OPEN) {
    receiverSocket.send(JSON.stringify(message));
    return true;
  }
  return false;
}

function connectReceiver() {
  if (receiverSocket?.readyState === WebSocket.OPEN || receiverSocket?.readyState === WebSocket.CONNECTING) return;
  clearTimeout(reconnectTimer);
  try {
    receiverSocket = new WebSocket(SOCKET_URL);
    receiverSocket.addEventListener('open', () => sendSocket({ type: 'hello', client: 'edge-extension' }));
    receiverSocket.addEventListener('message', async (event) => {
      try {
        await handleReceiverMessage(JSON.parse(event.data));
      } catch (error) {
        console.warn('LeetCode CPH receiver message failed:', error);
      }
    });
    receiverSocket.addEventListener('close', () => {
      receiverSocket = undefined;
      reconnectTimer = setTimeout(connectReceiver, 5000);
    });
    receiverSocket.addEventListener('error', () => receiverSocket?.close());
  } catch (_) {
    reconnectTimer = setTimeout(connectReceiver, 5000);
  }
}

function canonicalProblemUrl(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
  } catch (_) {
    return '';
  }
}

function problemSlug(value) {
  try {
    const match = new URL(value).pathname.match(/\/problems\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]).toLowerCase() : '';
  } catch (_) {
    return '';
  }
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

const LEETCODE_TAB_RE = /^https:\/\/leetcode(-cn)?\.(cn|com)\//;
// Prefer `tab.pendingUrl` over `tab.url`: while a tab is navigating, `url`
// still points at the previous page (or about:blank) and would hide the
// LeetCode destination the user just opened.
const tabTargetUrl = (tab) => tab.pendingUrl || tab.url || '';

async function applyCodeToMatchingTab(message) {
  const targetUrl = canonicalProblemUrl(message.source);
  const targetSlug = problemSlug(message.source);
  let focusedWindowId;
  try {
    focusedWindowId = (await chrome.windows.getLastFocused())?.id;
  } catch (_) { /* Fall back to tab flags only. */ }
  const byRecency = (left, right) => {
    const timeDiff = (right.lastAccessed || 0) - (left.lastAccessed || 0);
    if (timeDiff) return timeDiff;
    const score = (tab) =>
      (tab.windowId && tab.windowId === focusedWindowId ? 2 : 0) +
      (tab.active || tab.highlighted ? 1 : 0);
    return score(right) - score(left);
  };

  let tab;
  let matches = [];
  // The page may have just been opened and the tab is still navigating, so
  // re-query briefly before giving up; a fast sync right after opening the
  // page should still succeed.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const tabs = await chrome.tabs.query({});
    // Only LeetCode problem tabs are candidates. `tab.url` / `tab.pendingUrl`
    // can be missing for some tab states, in which case the tab cannot match.
    const candidates = tabs.filter((candidate) => LEETCODE_TAB_RE.test(tabTargetUrl(candidate)));
    // Prefer an exact URL match; otherwise fall back to matching the problem
    // slug, which tolerates different domains (leetcode.cn / leetcode.com /
    // leetcode-cn.com) and page shapes (/problems/xxx/, /problems/xxx/description/,
    // /solutions/, ...).
    const exactMatches = candidates
      .filter((candidate) => canonicalProblemUrl(tabTargetUrl(candidate)) === targetUrl)
      .sort(byRecency);
    const slugMatches = candidates
      .filter((candidate) => targetSlug && problemSlug(tabTargetUrl(candidate)) === targetSlug)
      .sort(byRecency);
    matches = exactMatches.length ? exactMatches : slugMatches;
    if (matches.length) {
      // For duplicate tabs, only the most recently active one is changed.
      tab = matches[0];
      break;
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 600));
  }
  if (!tab) throw new Error('未找到打开中的对应力扣题目页。请确认题目页已加载完成；若刚打开页面，请稍候重试。');
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['page-collector.js'],
    world: 'MAIN'
  });
  const [applyResult] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    args: [message.code, message.language],
    func: (code, language) => window.__LEETCODE_CPH_APPLY_CODE__?.(code, language)
  });
  if (!applyResult?.result?.ok) throw new Error(applyResult?.result?.error || '浏览器未能写入代码。');
  await setState(tab.id, 'OK', '#137333', `已从 VS Code 同步：${message.title || '当前解答'}`);
  return { tabId: tab.id, title: tab.title || '', language: applyResult.result.language, duplicates: matches.length - 1 };
}

async function handleReceiverMessage(message) {
  if (message?.type === 'ping') return sendSocket({ type: 'pong' });
  if (message?.type !== 'applyCode' || !message.requestId) return;
  try {
    const result = await applyCodeToMatchingTab(message);
    sendSocket({ type: 'applyResult', requestId: message.requestId, ok: true, result });
  } catch (error) {
    sendSocket({ type: 'applyResult', requestId: message.requestId, ok: false, error: error.message || '同步失败。' });
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  const tabId = tab.id;
  try {
    if (!tabId || !LEETCODE_TAB_RE.test(tab.url || '')) {
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

chrome.runtime.onStartup.addListener(connectReceiver);
chrome.runtime.onInstalled.addListener(connectReceiver);
chrome.alarms.create('leetcode-cph-receiver-heartbeat', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'leetcode-cph-receiver-heartbeat') {
    connectReceiver();
    sendSocket({ type: 'ping' });
  }
});
connectReceiver();
