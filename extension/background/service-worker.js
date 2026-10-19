const defaults = { bridge: "http://127.0.0.1:18899" };
const flowUrl = url => /^https:\/\/(flow\.google\.com|labs\.google\/fx)\//.test(url || "");
const nativeFlowOperations = new Set([
  "flow.context", "flow.state", "flow.projects.list", "flow.project.open", "flow.assets.list", "flow.characters.list",
  "flow.generation.submit", "flow.generation.observe",
  "flow.generation.upload.preflight",
  "flow.file.upload.begin", "flow.file.upload.chunk", "flow.file.upload.finish", "flow.file.upload.abort", "flow.media.upload",
  "flow.asset.download",
  "flow.asset.rename", "flow.asset.trash",
  "flow.character.create", "flow.character.edit", "flow.edit.run",
  "flow.continue.run", "flow.agent.batch",
]);
let socket = null;
let opening = false;
let reconnectTimer;
let reconnectAttempt = 0;
let heartbeat;
let selectedTabId;
let lastError = "";
let interactionActive = false;
async function ensureActivityOverlay(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content/activity-overlay.js"] });
}
async function ensureFlowSubmitBridge(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", files: ["content/flow-submit-main.js"] });
  await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", files: ["content/flow-upload-main.js"] });
  const readBridge = () => chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => ({
      version: window.__flowMcpSubmitBridge?.version,
      installedReadyState: window.__flowMcpSubmitBridge?.installedReadyState,
      uploadVersion: window.__flowMcpUploadBridge?.version,
    }),
  }).then(results => results?.[0]?.result || {});
  const readUploadClientVersion = () => chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    func: () => globalThis.FlowNativeFileTransfer?.version || 0,
  }).then(results => results?.[0]?.result || 0);
  let bridge = await readBridge();
  let uploadClientVersion = await readUploadClientVersion();
  if (bridge.version === 3 && bridge.uploadVersion === 4 && bridge.installedReadyState === "loading" && uploadClientVersion === 4) return;

  // Extension updates do not run document_start scripts inside already-open tabs.
  // Reload once so Flow registers its click handlers after our MAIN-world hook.
  const loaded = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("Flow did not finish reloading to initialize its submit bridge. Keep the project tab open and retry."));
    }, 30_000);
    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
  await chrome.tabs.reload(tabId);
  await loaded;
  const verifyDeadline = Date.now() + 10_000;
  do {
    bridge = await readBridge();
    uploadClientVersion = await readUploadClientVersion();
    if (bridge.version === 3 && bridge.uploadVersion === 4 && bridge.installedReadyState === "loading" && uploadClientVersion === 4) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < verifyDeadline);
  if (bridge.version !== 3 || bridge.uploadVersion !== 4 || bridge.installedReadyState !== "loading" || uploadClientVersion !== 4) {
    throw new Error("Flow upload bridge or content client did not initialize at the expected version. Reload the Flow extension and project tab.");
  }
}
async function sendFlowCommand(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    if (!/Receiving end does not exist|Could not establish connection/i.test(String(error?.message || error))) throw error;
    const tab = await chrome.tabs.get(tabId);
    if (!flowUrl(tab.url)) throw error;
    // A Flow tab can predate extension installation/reload, leaving no content
    // script listener in that tab. Inject the declared scripts in manifest order
    // and retry once instead of making the user reload the whole Flow page.
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [
        "content/activity-overlay.js",
        "content/native-file-transfer.js",
        "content/flow-page-driver.js",
        "content/flow-driver-registry.js",
        "content/flow-v2-driver.js",
        "content/character-actions.js",
        "content/image-actions.js",
        "content/video-actions.js",
        "content/dom-actions.js",
      ],
    });
    await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", files: ["content/flow-upload-main.js"] });
    return chrome.tabs.sendMessage(tabId, message);
  }
}
async function waitForTabComplete(tabId, timeoutMs = 45_000) {
  const existing = await chrome.tabs.get(tabId).catch(() => null);
  if (existing?.status === "complete") return existing;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("Flow did not finish loading its project page."));
    }, timeoutMs);
    const onUpdated = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(tab);
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}
async function listFlowProjects() {
  const selected = await chrome.tabs.get(selectedTabId);
  if (!flowUrl(selected.url)) throw new Error("The selected tab is no longer a Flow tab. Reconnect the extension.");
  const scan = async tabId => {
    const response = await sendFlowCommand(tabId, { type: "flow-mcp:execute", command: { op: "flowOperation", name: "flow.projects.list", payload: {} } });
    if (!response?.ok) {
      const error = new Error(response?.error?.message || response?.error || "Could not scan Flow projects.");
      error.code = response?.error?.code || "FLOW_PROJECT_SCAN_FAILED";
      error.retryable = Boolean(response?.error?.retryable);
      throw error;
    }
    return response.value;
  };
  if (!/\/project\/[0-9a-f-]{36}(?:\/|$)/i.test(new URL(selected.url).pathname)) {
    return scan(selectedTabId);
  }
  const tab = await chrome.tabs.create({ url: "https://flow.google.com/?hl=en", active: false });
  try {
    await waitForTabComplete(tab.id);
    await new Promise(resolve => setTimeout(resolve, 700));
    return await scan(tab.id);
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}
async function openFlowProject(projectId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(projectId || ""))) {
    throw new Error("Invalid Flow project id.");
  }
  const url = `https://flow.google.com/project/${projectId}?hl=en`;
  await chrome.tabs.update(selectedTabId, { url });
  await waitForTabComplete(selectedTabId);
  return { opened: true, id: projectId, url };
}
async function ensureEnglishFlowTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!flowUrl(tab.url)) return;
  const currentLanguage = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => document.documentElement.lang,
  }).then(results => String(results?.[0]?.result || "")).catch(() => "");
  const url = new URL(tab.url);
  if (url.searchParams.get("hl") === "en" && /^en\b/i.test(currentLanguage)) return;
  url.searchParams.set("hl", "en");
  const loaded = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("Flow did not finish reloading in English. Keep the project tab open and retry."));
    }, 30_000);
    const onUpdated = (updatedTabId, changeInfo, updatedTab) => {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(updatedTab);
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
  if (url.href === tab.url) await chrome.tabs.reload(tabId);
  else await chrome.tabs.update(tabId, { url: url.href });
  await loaded;
  for (let attempt = 0; attempt < 10; attempt++) {
    const language = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.documentElement.lang,
    }).then(results => String(results?.[0]?.result || "")).catch(() => "");
    if (/^en\b/i.test(language)) return;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error("Flow reloaded, but its interface is not in English. Check the Flow language setting and retry.");
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
const config = async () => {
  const stored = await chrome.storage.local.get(defaults);
  if (["http://127.0.0.1:8799", "http://localhost:8799"].includes(stored.bridge)) {
    stored.bridge = defaults.bridge;
    await chrome.storage.local.set({ bridge: stored.bridge });
  }
  return { ...defaults, ...stored };
};

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
async function chooseTab() {
  const tabs = await chrome.tabs.query({ url: ["https://flow.google.com/*", "https://labs.google/fx/*"] });
  const saved = (await chrome.storage.session.get("selectedFlowTabId")).selectedFlowTabId;
  const active = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  // Prefer the Flow tab the user is looking at. A saved tab is only a fallback;
  // it may have been closed or left behind after a browser/extension restart.
  const tab = tabs.find(tab => active.some(item => item.id === tab.id))
    || tabs.find(tab => tab.id === saved)
    || tabs.find(tab => tab.id === selectedTabId)
    || tabs.find(tab => /\/project\/[0-9a-f-]{36}(?:\/|$)/i.test(new URL(tab.url).pathname))
    || tabs[0];
  if (!tab) throw new Error("Open a Google Flow tab to connect Flow MCP.");
  selectedTabId = tab.id;
  await chrome.storage.session.set({ selectedFlowTabId: tab.id });
  await ensureEnglishFlowTab(tab.id);
  await ensureFlowSubmitBridge(tab.id);
  return tab;
}
async function adoptFlowTab(tab, prepare = false) {
  if (!tab?.id || !flowUrl(tab.url)) return false;
  selectedTabId = tab.id;
  await chrome.storage.session.set({ selectedFlowTabId: tab.id });
  if (prepare) {
    await ensureEnglishFlowTab(tab.id);
    await ensureFlowSubmitBridge(tab.id);
  }
  if (socket?.readyState === WebSocket.OPEN) lastError = "";
  if (socket?.readyState !== WebSocket.OPEN && socket?.readyState !== WebSocket.CONNECTING) void connect();
  return true;
}
async function execute(ws, method, args = []) {
  if (method === "flow.dom.execute") {
    const [command] = args;
    if (!command || typeof command !== "object" || typeof command.op !== "string") throw new Error("Invalid Flow DOM command");
    if (command.op !== "flowOperation" || !nativeFlowOperations.has(command.name)) {
      const error = new Error(`Native operation is not supported: ${String(command.name || command.op)}`);
      error.code = "NATIVE_CAPABILITY_UNSUPPORTED";
      error.retryable = true;
      throw error;
    }
    const requestedTabId = command.tabId ?? command.tab_id;
    let tabId = requestedTabId === undefined ? selectedTabId : requestedTabId;
    if (tabId === undefined) tabId = (await chooseTab()).id;
    else {
      const selectedTab = await chrome.tabs.get(tabId).catch(() => null);
      if (!selectedTab || !flowUrl(selectedTab.url)) {
        if (requestedTabId !== undefined) throw new Error("Native Flow command targets a tab that is no longer open.");
        tabId = (await chooseTab()).id;
      }
    }
    if (tabId !== selectedTabId) throw new Error("Native Flow command targets a tab other than the selected Flow tab");
    if (tabId === undefined) throw new Error("No Flow tab is selected");
    const operation = command.name;
    if (operation === "flow.generation.upload.preflight") await ensureFlowSubmitBridge(tabId);
    if (operation === "flow.projects.list") return listFlowProjects();
    if (operation === "flow.project.open") return openFlowProject(command.payload?.projectId);
  const interactive = !["flow.state", "flow.assets.list", "flow.characters.list", "flow.generation.observe", "flow.generation.upload.preflight", "flow.file.upload.begin", "flow.file.upload.chunk", "flow.file.upload.finish", "flow.file.upload.abort"].includes(operation);
    if (interactive) showActivity(true);
    let response;
    try {
      response = await sendFlowCommand(tabId, {
        type: "flow-mcp:execute",
        command: { ...command, id: command.requestId ?? command.request_id ?? command.id, jobId: command.jobId ?? command.job_id },
      });
    } finally {
      if (interactive) showActivity(false);
    }
    if (!response?.ok) {
      const error = new Error(response?.error?.message || response?.error || "Flow DOM command failed");
      error.code = response?.error?.code || "FLOW_DOM_FAILED";
      error.retryable = Boolean(response?.error?.retryable);
      error.outcome_unknown = Boolean(response?.error?.outcome_unknown);
      throw error;
    }
    return response.value;
  }
  if (method === "flow.downloads.recent") {
    if (!chrome.downloads) throw new Error("Reload Flow MCP Connector 0.4.1 to enable download tracking.");
    const items = await chrome.downloads.search({ orderBy: ["-startTime"], limit: 100 });
    return items.filter(item => flowUrl(item.referrer) || flowUrl(item.url)).map(item => ({
      id: item.id, filename: item.filename, state: item.state, error: item.error,
      bytesReceived: item.bytesReceived, totalBytes: item.totalBytes,
    }));
  }
  throw new Error(`Unsupported connector method: ${method}`);
}
function scheduleReconnect(delayMs) {
  if (reconnectTimer) return;
  const backoff = Math.min(1500 * (2 ** reconnectAttempt++), 30_000);
  reconnectTimer = setTimeout(() => { reconnectTimer = undefined; void connect(); }, delayMs ?? backoff);
}
async function connect() {
  if (opening || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
  opening = true;
  try {
    await chooseTab();
    const ws = new WebSocket(endpoint((await config()).bridge));
    socket = ws;
    ws.onopen = () => {
      if (socket !== ws) return;
      reconnectAttempt = 0;
      lastError = "";
      send(ws, { type: "event", method: "extension.initialized", params: [{ protocol: 2, version: chrome.runtime.getManifest().version, capabilities: [...nativeFlowOperations].map(name => `flow.native.${name.slice(5)}`) }] });
      heartbeat = setInterval(() => send(ws, { type: "ping" }), 20_000);
    };
    ws.onmessage = message => {
      if (socket !== ws) return;
      let command;
      try { command = JSON.parse(message.data); } catch { ws.close(1002, "Invalid JSON"); return; }
      if (command.type !== "command") return;
      const commandId = command.id ?? command.request_id ?? command.requestId;
      if (commandId === undefined || commandId === null) { ws.close(1002, "Command is missing request id"); return; }
      // Keep the socket receive loop responsive while a page operation waits.
      void execute(ws, command.method, command.args).then(
        value => send(ws, { type: "result", id: commandId, result: { ok: true, value } }),
        error => send(ws, { type: "result", id: commandId, result: { ok: false, error: { code: error?.code || "EXTENSION_COMMAND_FAILED", message: String(error?.message || error), retryable: Boolean(error?.retryable), outcome_unknown: Boolean(error?.outcome_unknown) } } }),
      );
    };
    ws.onclose = close => {
      if (socket !== ws) return;
      socket = null;
      clearInterval(heartbeat);
      lastError = close.reason || "Backend disconnected";
      showActivity(false);
      // Retry slowly when another connector temporarily owns the backend socket.
      scheduleReconnect(close.code === 1008 ? 10_000 : undefined);
    };
    ws.onerror = () => { lastError = "Cannot connect to the local backend"; ws.close(); };
  } catch (error) { lastError = String(error?.message || error); scheduleReconnect(); }
  finally { opening = false; }
}
chrome.tabs.onRemoved.addListener((tabId, info) => {
  if (tabId === selectedTabId) {
    showActivity(false);
    selectedTabId = undefined;
    void chrome.storage.session.remove("selectedFlowTabId");
    // Keep the WebSocket alive and attach it to another remaining Flow tab.
    void chooseTab().catch(error => { lastError = String(error?.message || error); });
  }
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  void chrome.tabs.get(tabId).then(tab => adoptFlowTab(tab, true)).catch(() => {});
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url && tabId === selectedTabId && !flowUrl(changeInfo.url)) {
    selectedTabId = undefined;
    void chrome.storage.session.remove("selectedFlowTabId");
    void chooseTab().catch(error => { lastError = String(error?.message || error); });
    return;
  }
  if (flowUrl(tab.url) && (tab.active || selectedTabId === undefined)) {
    void adoptFlowTab(tab, tab.active).catch(error => { lastError = String(error?.message || error); });
  }
});
chrome.tabs.onCreated.addListener(tab => {
  if (tab.active && flowUrl(tab.url)) void adoptFlowTab(tab, true).catch(error => { lastError = String(error?.message || error); });
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
  if (message?.type === "flow-mcp:ensure-active-tab") {
    void (async () => {
      const tabId = _sender.tab?.id;
      if (tabId === undefined || tabId !== selectedTabId) throw new Error("The download request did not come from the selected Flow tab.");
      await chrome.tabs.update(tabId, { active: true });
      respond({ ok: true });
    })().catch(error => respond({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  if (message?.type === "flow-mcp:progress") {
    const requestId = message.requestId ?? message.request_id ?? message.commandId ?? message.command_id;
    const tabId = _sender.tab?.id;
    const ok = tabId === selectedTabId && (typeof requestId === "string" || typeof requestId === "number");
    if (ok) event("extension.progress", [{ requestId: String(requestId), jobId: message.jobId ?? message.job_id, tabId, progress: message.progress }]);
    respond({ ok });
    return;
  }
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
    respond({ active: _sender.tab?.id === selectedTabId && socket?.readyState === WebSocket.OPEN && interactionActive });
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

