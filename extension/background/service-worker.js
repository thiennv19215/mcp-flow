const defaults = { bridge: "http://127.0.0.1:8799" };
const protocol = 2;
const flowUrl = url => /^https:\/\/(flow\.google\.com|labs\.google\/fx)\//.test(url || "");
let socket = null;
let opening = false;
let reconnectTimer;
let heartbeat;
let selectedTabId;
let lastError = "";
let interactionActive = false;
async function ensureActivityOverlay(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content/activity-overlay.js"] });
}
function showActivity(active) {
  interactionActive = active;
  if (selectedTabId !== undefined && chrome.tabs.sendMessage) {
    const tabId = selectedTabId;
    void (async () => {
      if (active) await ensureActivityOverlay(tabId);
      await chrome.tabs.sendMessage(tabId, { type: "flow-mcp:activity", active: interactionActive && selectedTabId === tabId });
    })().catch(() => {});
  }
}
let cleanup = Promise.resolve();
const attached = new Set();
const attaching = new Map();
const config = async () => ({ ...defaults, ...(await chrome.storage.local.get(defaults)) });

function endpoint(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("Bridge URL must be localhost HTTP(S)");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws/bridge";
  url.search = "";
  return url.href;
}
function send(ws, message) { if (ws === socket && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); }
function event(method, params) { if (socket) send(socket, { type: "event", method, params }); }
async function release() {
  showActivity(false);
  const tabs = [...attached];
  attached.clear();
  await Promise.allSettled(tabs.map(tabId => chrome.debugger.detach({ tabId })));
}
async function chooseTab() {
  const tabs = await chrome.tabs.query({ url: ["https://flow.google.com/*", "https://labs.google/fx/*"] });
  const saved = (await chrome.storage.session.get("selectedFlowTabId")).selectedFlowTabId;
  const active = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = tabs.find(tab => tab.id === saved) || tabs.find(tab => active.some(item => item.id === tab.id)) || (tabs.length === 1 ? tabs[0] : null);
  if (!tab) throw new Error("Open a Flow project, keep that tab active, then click Connect in this popup.");
  selectedTabId = tab.id;
  await chrome.storage.session.set({ selectedFlowTabId: tab.id });
  return tab;
}
async function attach(ws, target, version) {
  if (target?.tabId !== selectedTabId) throw new Error("Debugger target is not the selected Flow tab");
  if (attached.has(target.tabId)) return;
  if (attaching.has(target.tabId)) return attaching.get(target.tabId);
  const task = (async () => {
    try {
      await chrome.debugger.attach(target, version);
    } catch (error) {
      // Reclaim only an attachment that this extension can already command.
      // Detaching it resets old Runtime contexts before Playwright initializes.
      if (!/already attached|another debugger/i.test(String(error?.message || error))) throw error;
      await chrome.debugger.sendCommand(target, "Target.getTargetInfo", {});
      await chrome.debugger.detach(target);
      await chrome.debugger.attach(target, version);
    }
    if (socket !== ws || ws.readyState !== WebSocket.OPEN) {
      await chrome.debugger.detach(target).catch(() => {});
      throw new Error("Connection closed during debugger attach");
    }
    attached.add(target.tabId);
  })().finally(() => attaching.delete(target.tabId));
  attaching.set(target.tabId, task);
  return task;
}
async function execute(ws, method, args = []) {
  if (method === "flow.downloads.recent") {
    if (!chrome.downloads) throw new Error("Reload Flow MCP Connector 0.4.1 to enable download tracking.");
    const items = await chrome.downloads.search({ orderBy: ["-startTime"], limit: 100 });
    return items.filter(item => flowUrl(item.referrer) || flowUrl(item.url)).map(item => ({
      id: item.id, filename: item.filename, state: item.state, error: item.error,
      bytesReceived: item.bytesReceived, totalBytes: item.totalBytes,
    }));
  }
  if (method === "chrome.debugger.attach") return attach(ws, ...args);
  if (method === "chrome.debugger.sendCommand") {
    if (args[0]?.tabId !== selectedTabId || !attached.has(selectedTabId)) throw new Error("Debugger session is no longer attached. Reconnect the connector before retrying.");
    if (interactionActive && ["Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Input.dispatchTouchEvent", "Input.insertText", "Input.imeSetComposition"].includes(args[1])) {
      await ensureActivityOverlay(selectedTabId);
      const timed = args[1].startsWith("Input.dispatch");
      // A historical timestamp distinguishes our CDP event from current
      // physical input without changing its coordinates, key, or modifiers.
      const timestamp = timed ? (Date.now() - 60_000) / 1000 : undefined;
      const ack = await chrome.tabs.sendMessage(selectedTabId, {
        type:"flow-mcp:allow-input", timestamp,
        text:["Input.dispatchKeyEvent", "Input.insertText", "Input.imeSetComposition"].includes(args[1]),
      });
      if (!ack?.ok) throw new Error("Input guard is unavailable. Reload the Flow tab before continuing.");
      if (timed) args = [args[0], args[1], { ...args[2], timestamp }];
    }
    const result = await chrome.debugger.sendCommand(...args);
    if (args[1] === "Emulation.setFocusEmulationEnabled" && !args[0]?.sessionId) showActivity(Boolean(args[2]?.enabled));
    return result;
  }
  if (method === "chrome.debugger.detach") {
    if (args[0]?.tabId !== selectedTabId) throw new Error("Invalid target");
    showActivity(false);
    attached.delete(selectedTabId);
    return chrome.debugger.detach(...args);
  }
  if (method === "chrome.tabs.remove") {
    if (args[0] !== selectedTabId) throw new Error("Invalid target");
    return chrome.tabs.remove(args[0]);
  }
  throw new Error(`Unsupported connector method: ${method}`);
}
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = undefined; void connect(); }, 1500);
}
async function connect() {
  if (opening || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
  opening = true;
  try {
    await cleanup;
    const tab = await chooseTab();
    const ws = new WebSocket(endpoint((await config()).bridge));
    socket = ws;
    ws.onopen = () => {
      if (socket !== ws) return;
      lastError = "";
      // Seed the official tab model before it starts Playwright auto-attach.
      send(ws, { type: "event", method: "chrome.tabs.onCreated", params: [tab] });
      send(ws, { type: "event", method: "extension.initialized", params: [{ protocol, version: chrome.runtime.getManifest().version }] });
      heartbeat = setInterval(() => send(ws, { type: "ping" }), 20_000);
    };
    ws.onmessage = message => {
      if (socket !== ws) return;
      let command;
      try { command = JSON.parse(message.data); } catch { ws.close(1002, "Invalid JSON"); return; }
      if (command.type !== "command") return;
      // Do not await a CDP command in a receive loop. Events and other commands
      // must continue while Runtime.callFunctionOn awaits a page promise.
      void execute(ws, command.method, command.args).then(
        value => send(ws, { type: "result", id: command.id, result: { ok: true, value } }),
        error => send(ws, { type: "result", id: command.id, result: { ok: false, error: String(error?.message || error) } }),
      );
    };
    ws.onclose = close => {
      if (socket !== ws) return;
      socket = null;
      clearInterval(heartbeat);
      lastError = close.reason || "Backend disconnected";
      cleanup = release();
      if (close.code !== 1008) scheduleReconnect();
    };
    ws.onerror = () => { lastError = "Cannot connect to the local backend"; ws.close(); };
  } catch (error) { lastError = String(error?.message || error); scheduleReconnect(); }
  finally { opening = false; }
}
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId === selectedTabId) event("chrome.debugger.onEvent", [source, method, params]);
});
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === selectedTabId) showActivity(false);
  attached.delete(source.tabId);
  if (source.tabId === selectedTabId) event("chrome.debugger.onDetach", [source, reason]);
});
chrome.tabs.onRemoved.addListener((tabId, info) => {
  attached.delete(tabId);
  if (tabId === selectedTabId) { event("chrome.tabs.onRemoved", [tabId, info]); selectedTabId = undefined; }
});
chrome.runtime.onInstalled.addListener(() => { chrome.alarms.create("flow-mcp-connect", { periodInMinutes: 0.5 }); void connect(); });
chrome.runtime.onStartup.addListener(() => { chrome.alarms.create("flow-mcp-connect", { periodInMinutes: 0.5 }); void connect(); });
chrome.alarms.onAlarm.addListener(() => void connect());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.bridge) return;
  clearTimeout(reconnectTimer); reconnectTimer = undefined;
  if (socket) socket.close(1000, "Bridge URL changed");
  else void connect();
});
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type === "flow-mcp:preview") {
    void (async () => {
      if (selectedTabId === undefined) throw new Error("Connect a Flow tab first.");
      await ensureActivityOverlay(selectedTabId);
      await chrome.tabs.sendMessage(selectedTabId, { type: "flow-mcp:activity-preview" });
      respond({ ok:true });
    })().catch(error => respond({ error: String(error?.message || error) }));
    return true;
  }
  if (message?.type === "flow-mcp:activity-state") {
    respond({ active: _sender.tab?.id === selectedTabId && attached.has(selectedTabId) && socket?.readyState === WebSocket.OPEN && interactionActive });
    return;
  }
  if (message?.type === "flow-mcp:status") {
    Promise.all([config(), chrome.tabs.query({ url: ["https://flow.google.com/*", "https://labs.google/fx/*"] })]).then(([c, tabs]) => respond({ configured: true, bridge: c.bridge, flowTabs: tabs.length, selectedTabId, wsConnected: socket?.readyState === WebSocket.OPEN, error: lastError }));
    return true;
  }
  if (message?.type === "flow-mcp:connect") {
    void (async () => {
      await chrome.storage.session.remove("selectedFlowTabId");
      if (socket) socket.close(1000, "User reconnect"); else await connect();
      respond({ ok: true });
    })();
    return true;
  }
});
void chrome.alarms.create("flow-mcp-connect", { periodInMinutes: 0.5 });
void connect();

