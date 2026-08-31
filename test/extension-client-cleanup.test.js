'use strict';
// Regression test: when requestBrowserApply() fails to write to a browser
// client, that client must be removed from ALL pending applies (not just from
// socketClients), so an earlier request still waiting on the same client fails
// immediately with "浏览器连接已断开" instead of hanging until the 10s timeout.
//
// Loads the real vscode-extension/extension.js in a vm sandbox (vscode/http
// stubbed, everything else real) so the actual sendSocket → removeClient →
// ApplyTracker wiring is exercised.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const source = fs.readFileSync(path.join(__dirname, '..', 'vscode-extension', 'extension.js'), 'utf8');
const { ApplyTracker } = require('../vscode-extension/apply-tracker');

function createSandbox() {
  const outputChannel = { appendLine() {} };
  const fakeServer = {
    on() { return fakeServer; },
    listen(_port, _host, callback) { if (callback) callback(); return fakeServer; },
    close(callback) { if (callback) callback(); return fakeServer; }
  };
  const vscodeStub = {
    workspace: {
      workspaceFolders: [{ uri: { fsPath: 'C:/fake' } }],
      rootPath: 'C:/fake',
      getConfiguration() {
        return { get: (key) => ({ port: 27121, outputDirectory: 'leetcode', openSolutionAfterCapture: true })[key] };
      }
    },
    window: {
      createOutputChannel: () => outputChannel,
      setStatusBarMessage: () => ({}),
      showErrorMessage: () => ({}),
      showWarningMessage: () => ({}),
      showTextDocument: async () => ({})
    },
    commands: { registerCommand: () => ({}) },
    Uri: { file: (value) => ({ fsPath: value }) }
  };
  const sandbox = {
    module: { exports: {} },
    console,
    Buffer,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    require: (name) => {
      if (name === 'vscode') return vscodeStub;
      if (name === 'http') return { createServer: () => fakeServer };
      if (name === 'crypto') return crypto;
      if (name === 'path') return path;
      if (name === 'fs/promises') return require('fs/promises');
      if (name === './apply-tracker') return { ApplyTracker };
      throw new Error(`Unexpected require: ${name}`);
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'extension.js' });
  return sandbox;
}

function makeFakeSocket() {
  const handlers = {};
  const socket = {
    writable: true,
    destroyed: false,
    failWrites: false,
    write(data) {
      if (this.failWrites) throw new Error('EPIPE: simulated write failure');
      return true;
    },
    setNoDelay() {},
    on(event, callback) { (handlers[event] ||= []).push(callback); },
    end() { socket.destroy(); },
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.writable = false;
      for (const callback of handlers.close || []) callback();
    }
  };
  return socket;
}

test('write failure to a client settles its other pending apply immediately', async () => {
  const sandbox = createSandbox();
  sandbox.activate({ subscriptions: { push() {} } });
  try {
    // Connect one browser client through the real WebSocket accept path.
    const socket = makeFakeSocket();
    sandbox.acceptWebSocket(
      { url: '/ws', headers: { upgrade: 'websocket', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } },
      socket
    );

    // Request A goes out successfully and stays pending on the client.
    const promiseA = sandbox.requestBrowserApply({ source: 'https://leetcode.cn/problems/two-sum/', title: 'A', language: 'cpp', code: 'int x;' });
    const aCheck = assert.rejects(promiseA, /浏览器连接已断开/);

    // Request B fails to write to the very same client; the cleanup must also
    // settle request A instead of leaving it to the 10s apply timeout.
    socket.failWrites = true;
    const started = Date.now();
    const promiseB = sandbox.requestBrowserApply({ source: 'https://leetcode.cn/problems/two-sum/', title: 'B', language: 'cpp', code: 'int y;' });
    const bCheck = assert.rejects(promiseB, /未连接 Edge 扩展/);

    await Promise.all([aCheck, bCheck]);
    assert.ok(Date.now() - started < 2_000, 'request A must fail fast, not wait for the 10s apply timeout');
    assert.equal(socket.destroyed, true, 'the failed client socket must be destroyed');
  } finally {
    await sandbox.deactivate();
  }
});
