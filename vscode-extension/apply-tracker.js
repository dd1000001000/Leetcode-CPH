'use strict';

// 一次“回传代码到浏览器”请求的等待状态跟踪。
//
// 生命周期规则（修复单 client 断线导致整次同步干等 10 秒的问题）：
// - 每个请求维护 awaitingClients: Set<client>，初始为所有成功发出消息的客户端。
// - 某个 client 断开（close/error）或返回 ok:false 时，仅把它从集合中移除。
// - 仅当集合清空时才快速失败；任一成功结果（ok:true）立即完成整个请求。
// - 超时只作为最终兜底：到时后销毁仍未响应的连接并触发 onTimeout。

const APPLY_TIMEOUT_MS = 10_000;

class ApplyTracker {
  constructor({ timeoutMs = APPLY_TIMEOUT_MS, log = () => {} } = {}) {
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.pendingApplies = new Map();
  }

  create(requestId, sentClients, { onSuccess, onFailure, onTimeout }) {
    const pending = {
      requestId,
      awaitingClients: new Set(sentClients),
      done: false,
      timeout: null,
      onSuccess,
      onFailure,
      onTimeout
    };
    pending.timeout = setTimeout(() => {
      if (pending.done) return;
      this._settle(pending, () => {
        // A client that never answered is a zombie (for example a service
        // worker the browser terminated); drop it so the next sync fails fast
        // instead of hanging again, and the Edge extension reconnects cleanly.
        for (const client of pending.awaitingClients) {
          if (!client.socket.destroyed) {
            this.log('Dropping unresponsive browser client after apply timeout.');
            client.socket.destroy();
          }
        }
        pending.onTimeout();
      });
    }, this.timeoutMs);
    this.pendingApplies.set(requestId, pending);
    return pending;
  }

  // 处理浏览器端 applyResult 消息：ok:true 立即完成；ok:false 仅移除该 client，
  // 直到等待集合清空才以最后一个失败原因快速失败。
  handleApplyResult(client, message) {
    const pending = this.pendingApplies.get(message.requestId);
    if (!pending || pending.done) return false;
    pending.awaitingClients.delete(client);
    if (message.ok) {
      this._settle(pending, () => pending.onSuccess(message.result));
      return true;
    }
    if (pending.awaitingClients.size === 0) {
      this._settle(pending, () => pending.onFailure(new Error(message.error || '浏览器同步失败。')));
      return true;
    }
    return false;
  }

  // client 连接关闭/出错时调用：仅把该 client 从各请求的等待集合中移除，
  // 某个请求的集合清空即快速失败。
  handleClientClosed(client) {
    for (const pending of this.pendingApplies.values()) {
      if (pending.done) continue;
      if (!pending.awaitingClients.delete(client)) continue;
      if (pending.awaitingClients.size === 0) {
        this._settle(pending, () => pending.onFailure(new Error('浏览器连接已断开，请确认 Edge 扩展仍在运行后重试。')));
      }
    }
  }

  disposeAll(message) {
    for (const pending of [...this.pendingApplies.values()]) {
      this._settle(pending, () => pending.onFailure(new Error(message)));
    }
  }

  _settle(pending, settle) {
    if (pending.done) return;
    pending.done = true;
    clearTimeout(pending.timeout);
    this.pendingApplies.delete(pending.requestId);
    settle();
  }
}

module.exports = { ApplyTracker, APPLY_TIMEOUT_MS };
