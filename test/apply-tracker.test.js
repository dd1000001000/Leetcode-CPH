'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ApplyTracker } = require('../vscode-extension/apply-tracker');

let requestCounter = 0;

function makeClient(name) {
  const socket = { destroyed: false, destroy() { this.destroyed = true; } };
  return { socket, name };
}

function createRequest(tracker, clients) {
  const requestId = `req-${requestCounter += 1}`;
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  tracker.create(requestId, clients, {
    onSuccess: resolvePromise,
    onFailure: rejectPromise,
    onTimeout: () => rejectPromise(new Error('TIMEOUT'))
  });
  return { requestId, promise };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

test('single client disconnect fails fast without waiting for the timeout', async () => {
  const tracker = new ApplyTracker({ timeoutMs: 60_000 });
  const client = makeClient('c1');
  const { promise } = createRequest(tracker, [client]);
  const started = Date.now();
  tracker.handleClientClosed(client);
  await assert.rejects(promise, /浏览器连接已断开/);
  assert.ok(Date.now() - started < 2_000, 'must fail fast instead of waiting for the 60s timeout');
  assert.equal(tracker.pendingApplies.size, 0);
});

test('one of two clients disconnecting keeps the request pending until the other succeeds', async () => {
  const tracker = new ApplyTracker({ timeoutMs: 60_000 });
  const c1 = makeClient('c1');
  const c2 = makeClient('c2');
  const { requestId, promise } = createRequest(tracker, [c1, c2]);
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  tracker.handleClientClosed(c1);
  await tick();
  assert.equal(settled, false, 'request must stay pending after one client disconnects');
  tracker.handleApplyResult(c2, { requestId, ok: true, result: { tabId: 7 } });
  assert.deepEqual(await promise, { tabId: 7 });
  assert.equal(tracker.pendingApplies.size, 0);
});

test('all clients disconnecting fails the request fast', async () => {
  const tracker = new ApplyTracker({ timeoutMs: 60_000 });
  const c1 = makeClient('c1');
  const c2 = makeClient('c2');
  const { promise } = createRequest(tracker, [c1, c2]);
  const started = Date.now();
  tracker.handleClientClosed(c1);
  tracker.handleClientClosed(c2);
  await assert.rejects(promise, /浏览器连接已断开/);
  assert.ok(Date.now() - started < 2_000, 'must fail fast instead of waiting for the 60s timeout');
  assert.equal(tracker.pendingApplies.size, 0);
});

test('duplicate failure messages settle the request exactly once', async () => {
  const tracker = new ApplyTracker({ timeoutMs: 60_000 });
  const client = makeClient('c1');
  const { requestId, promise } = createRequest(tracker, [client]);
  tracker.handleApplyResult(client, { requestId, ok: false, error: 'first failure' });
  await assert.rejects(promise, /first failure/);
  assert.equal(
    tracker.handleApplyResult(client, { requestId, ok: false, error: 'duplicate' }),
    false,
    'a duplicate failure message must be a no-op'
  );
  assert.equal(tracker.pendingApplies.size, 0);
});

test('ok:false from one of two clients keeps the request pending; the last failure rejects', async () => {
  const tracker = new ApplyTracker({ timeoutMs: 60_000 });
  const c1 = makeClient('c1');
  const c2 = makeClient('c2');
  const { requestId, promise } = createRequest(tracker, [c1, c2]);
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  tracker.handleApplyResult(c1, { requestId, ok: false, error: 'language mismatch' });
  await tick();
  assert.equal(settled, false, 'one failed client must not fail the whole request while others await');
  tracker.handleApplyResult(c2, { requestId, ok: false, error: 'editor not found' });
  await assert.rejects(promise, /editor not found/);
});

test('ok:true completes the request immediately, ignoring remaining clients', async () => {
  const tracker = new ApplyTracker({ timeoutMs: 60_000 });
  const c1 = makeClient('c1');
  const c2 = makeClient('c2');
  const { requestId, promise } = createRequest(tracker, [c1, c2]);
  tracker.handleApplyResult(c1, { requestId, ok: true, result: { tabId: 3 } });
  assert.deepEqual(await promise, { tabId: 3 });
  assert.equal(tracker.pendingApplies.size, 0);
});

test('timeout destroys unresponsive clients and rejects', async () => {
  const tracker = new ApplyTracker({ timeoutMs: 30 });
  const client = makeClient('c1');
  const { promise } = createRequest(tracker, [client]);
  await assert.rejects(promise, /TIMEOUT/);
  assert.equal(client.socket.destroyed, true);
  assert.equal(tracker.pendingApplies.size, 0);
});
