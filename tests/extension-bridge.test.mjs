import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { BrowserModel } from '../dist/vendor/playwright/browserModel.js';
import { extensionSetWebSocket, extensionStatus, getExtensionPage } from '../dist/extension.js';

const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };

test('backend requires initialization and ignores close events from a replaced socket', async () => {
  class Socket extends EventEmitter {
    readyState = 1;
    close() { this.readyState = 3; this.emit('close'); }
    send() {}
    initialize() { this.emit('message', Buffer.from(JSON.stringify({ type: 'event', method: 'extension.initialized', params: [{ protocol: 2, version: '0.4.0' }] }))); }
  }
  const first = new Socket();
  extensionSetWebSocket(first);
  assert.equal(extensionStatus().connected, false);
  first.initialize();
  assert.equal(extensionStatus().connected, true);
  first.close();
  const second = new Socket();
  extensionSetWebSocket(second); second.initialize();
  first.emit('close');
  assert.equal(extensionStatus().connected, true);
  const extra = new Socket(); extensionSetWebSocket(extra);
  assert.equal(extra.readyState, 3);
  assert.equal(extensionStatus().connected, true);
  second.close();
  await assert.rejects(getExtensionPage(), /offline/);
});

test('official model routes child frames and invalidates sessions on detach', async () => {
  const calls = [], events = [];
  const model = new BrowserModel(async (method, args) => {
    calls.push({ method, args });
    if (args?.[1] === 'Target.getTargetInfo') return { targetInfo: { targetId: 'target-7', type: 'page', url: 'https://flow.google.com/project/example' } };
    return {};
  });
  model.connectOverCDP(message => events.push(message));
  model.onTabCreated({ id: 7 });
  assert.equal(calls.length, 0);
  await model.enableAutoAttach();
  const session = events.find(event => event.method === 'Target.attachedToTarget').params.sessionId;
  model.onDebuggerEvent({ tabId: 7 }, 'Target.attachedToTarget', { sessionId: 'child-1' });
  await model.sendCommand('child-1', 'Runtime.evaluate', { expression: '1' });
  assert.deepEqual(calls.at(-1).args[0], { tabId: 7, sessionId: 'child-1' });
  model.onDebuggerEvent({ tabId: 7, sessionId: 'child-1' }, 'Runtime.executionContextsCleared', {});
  assert.equal(events.at(-1).sessionId, 'child-1');
  model.onDebuggerDetach({ tabId: 7 });
  assert.equal(events.at(-1).method, 'Target.detachedFromTarget');
  await assert.rejects(model.sendCommand(session, 'Input.dispatchKeyEvent', {}), /No tab found/);
  await assert.rejects(model.sendCommand('child-1', 'Runtime.evaluate', {}), /No tab found/);
});

function workerHarness() {
  const sockets = [], sent = [], listeners = {};
  let resolveRuntime;
  const event = key => ({ addListener(fn) { listeners[key] = fn; } });
  class Socket {
    static OPEN = 1; static CONNECTING = 0;
    readyState = 0;
    constructor() { sockets.push(this); }
    send(value) { sent.push({ socket: this, ...JSON.parse(value) }); }
    open() { this.readyState = 1; this.onopen(); }
    close(code = 1000, reason = '') { this.readyState = 3; this.onclose?.({ code, reason }); }
    receive(value) { this.onmessage({ data: JSON.stringify(value) }); }
  }
  const chrome = {
    storage: { local: { get: async defaults => defaults }, session: { get: async () => ({}), set: async () => {}, remove: async () => {} }, onChanged: event('storage') },
    tabs: { query: async () => [{ id: 7, active: true, url: 'https://flow.google.com/project/example' }], onRemoved: event('removed') },
    debugger: {
      attach: async () => {}, detach: async () => {},
      sendCommand: async (_target, method) => method === 'Runtime.callFunctionOn' ? new Promise(resolve => { resolveRuntime = resolve; }) : {},
      onEvent: event('debuggerEvent'), onDetach: event('debuggerDetach'),
    },
    alarms: { create: async () => {}, onAlarm: event('alarm') },
    runtime: { getManifest: () => ({ version: '0.4.0' }), onInstalled: event('installed'), onStartup: event('startup'), onMessage: event('message') },
  };
  const context = vm.createContext({ chrome, WebSocket: Socket, URL, console, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {} });
  vm.runInContext(readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8'), context);
  return { sockets, sent, listeners, context, resolveRuntime: () => resolveRuntime({ result: true }) };
}

test('worker handshake precedes CDP; an awaited Runtime promise does not block input or events', async () => {
  const harness = workerHarness();
  await settle();
  const socket = harness.sockets[0]; socket.open();
  assert.deepEqual(harness.sent.slice(0, 2).map(message => message.method), ['chrome.tabs.onCreated', 'extension.initialized']);
  socket.receive({ type: 'command', id: '1', method: 'chrome.debugger.attach', args: [{ tabId: 7 }, '1.3'] });
  await settle();
  socket.receive({ type: 'command', id: '2', method: 'chrome.debugger.sendCommand', args: [{ tabId: 7 }, 'Runtime.callFunctionOn', {}] });
  socket.receive({ type: 'command', id: '3', method: 'chrome.debugger.sendCommand', args: [{ tabId: 7 }, 'Input.dispatchKeyEvent', { modifiers: 0 }] });
  harness.listeners.debuggerEvent({ tabId: 7 }, 'Runtime.executionContextsCleared', {});
  await settle();
  assert(harness.sent.some(message => message.id === '3' && message.result.ok));
  assert(!harness.sent.some(message => message.id === '2'));
  assert.equal(harness.sent.find(message => message.method === 'chrome.debugger.onEvent').params[1], 'Runtime.executionContextsCleared');
  harness.resolveRuntime(); await settle();
  assert(harness.sent.some(message => message.id === '2' && message.result.ok));
});

test('a late result from a closed worker connection cannot leak into its replacement', async () => {
  const harness = workerHarness(); await settle();
  const first = harness.sockets[0]; first.open();
  first.receive({ type: 'command', id: '1', method: 'chrome.debugger.attach', args: [{ tabId: 7 }, '1.3'] }); await settle();
  first.receive({ type: 'command', id: '2', method: 'chrome.debugger.sendCommand', args: [{ tabId: 7 }, 'Runtime.callFunctionOn', {}] }); await settle();
  first.close(); await settle();
  await vm.runInContext('connect()', harness.context); await settle();
  const second = harness.sockets[1]; second.open();
  harness.resolveRuntime(); await settle();
  assert(!harness.sent.some(message => message.id === '2'));
});
