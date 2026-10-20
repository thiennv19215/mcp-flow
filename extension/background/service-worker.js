const defaults = { bridge: "http://127.0.0.1:18899" };
const flowUrl = url => /^https:\/\/flow\.google\.com\//.test(url || "");
const nativeFlowOperations = new Set([
  "flow.context", "flow.state", "flow.projects.list", "flow.project.open", "flow.assets.list", "flow.characters.list",
  "flow.generation.submit", "flow.generation.observe", "flow.references.attach",
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
const activeInteractiveRequests = new Map();
const activeInteractiveCounts = new Map();
const reloadedUploadBridgeTabs = new Set();
const reloadedSubmitCleanupTabs = new Set();
const tabPreparations = new Map();
const activeTabOperations = new Map();
const maybeSubmittedOperations = new Set([
  "flow.generation.submit", "flow.edit.run", "flow.continue.run", "flow.agent.batch",
  "flow.character.create", "flow.character.edit",
]);
const tabOperationActive = tabId => (activeTabOperations.get(tabId) || 0) > 0;
function enterTabOperation(tabId) {
  activeTabOperations.set(tabId, (activeTabOperations.get(tabId) || 0) + 1);
}
function leaveTabOperation(tabId) {
  const remaining = (activeTabOperations.get(tabId) || 1) - 1;
  if (remaining > 0) activeTabOperations.set(tabId, remaining);
  else activeTabOperations.delete(tabId);
}
async function ensureActivityOverlay(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content/shared/activity-overlay.js"] });
}
async function reloadFlowTabOnce(tabId) {
  let loadTimedOut = false;
  const loaded = new Promise(resolve => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      loadTimedOut = true;
      resolve();
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
  return loadTimedOut;
}
async function clearStaleFlowSubmitBridge(tabId) {
  if (tabOperationActive(tabId)) return;
  const installed = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => Boolean(window.__flowMcpSubmitBridge),
  }).then(results => Boolean(results?.[0]?.result)).catch(() => false);
  if (!installed || reloadedSubmitCleanupTabs.has(tabId)) return;
  const cleanupState = await chrome.storage.session.get("reloadedSubmitCleanupTabIds");
  const reloadedTabIds = Array.isArray(cleanupState.reloadedSubmitCleanupTabIds) ? cleanupState.reloadedSubmitCleanupTabIds : [];
  if (reloadedTabIds.includes(tabId)) {
    reloadedSubmitCleanupTabs.add(tabId);
    return;
  }
  // A prior MAIN-world bridge patches EventTarget.prototype for the lifetime of its
  // document. Reload once to discard that document before running native operations.
  reloadedSubmitCleanupTabs.add(tabId);
  await chrome.storage.session.set({ reloadedSubmitCleanupTabIds: [...reloadedTabIds, tabId] });
  await reloadFlowTabOnce(tabId);
}
async function ensureFlowUploadBridge(tabId) {
  if (tabOperationActive(tabId)) return;
  let injectionError = "";
  await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", files: ["content/bridge/flow-upload-main.js"] })
    .catch(error => { injectionError = [injectionError, String(error?.message || error)].filter(Boolean).join("; "); });
  const readBridge = () => chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => ({
      uploadVersion: window.__flowMcpUploadBridge?.version,
    }),
  }).then(results => results?.[0]?.result || {});
  const readUploadClientVersion = () => chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    func: () => globalThis.FlowNativeFileTransfer?.version || 0,
  }).then(results => results?.[0]?.result || 0);
  let uploadBridge = await readBridge();
  let uploadClientVersion = await readUploadClientVersion();
  const uploadBridgeReady = () => uploadBridge.uploadVersion >= 8 && uploadClientVersion >= 8;
  if (uploadBridgeReady()) { reloadedUploadBridgeTabs.delete(tabId); return; }

  // Prevent infinite reload loop: reload at most once per tab lifecycle
  if (reloadedUploadBridgeTabs.has(tabId)) {
    throw new Error(`Flow upload bridge is unavailable after a reload (upload=${uploadBridge.uploadVersion ?? "missing"}, client=${uploadClientVersion}). Reload the Flow MCP extension and Flow tab.${injectionError ? ` Injection error: ${injectionError}` : ""}`);
  }
  reloadedUploadBridgeTabs.add(tabId);

  // Extension updates do not run document_start scripts inside already-open tabs.
  const loadTimedOut = await reloadFlowTabOnce(tabId);
  const verifyDeadline = Date.now() + 10_000;
  do {
    uploadBridge = await readBridge();
    uploadClientVersion = await readUploadClientVersion();
    if (uploadBridgeReady()) { reloadedUploadBridgeTabs.delete(tabId); return; }
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < verifyDeadline);
  throw new Error(`Flow upload bridge failed to initialize after reloading the tab (upload=${uploadBridge.uploadVersion ?? "missing"}, client=${uploadClientVersion}).${loadTimedOut ? " The tab did not finish loading within 30 seconds." : ""}${injectionError ? ` Injection error: ${injectionError}` : ""}`);
}
async function sendFlowCommand(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    const errMsg = String(error?.message || error);
    const isDisconnected = /Receiving end does not exist|Could not establish connection|message channel closed|message port closed|closed before a response was received/i.test(errMsg);
    if (!isDisconnected) throw error;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || !flowUrl(tab.url)) throw error;

    console.info(`[ServiceWorker] Flow tab ${tabId} content script disconnected (${errMsg}); reinjecting and retrying...`);
    // Tab might be in the middle of loading or was reloaded
    await waitForTabComplete(tabId, 15_000).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 300));

    // A Flow tab can predate extension installation/reload, leaving no content
    // script listener in that tab. Inject the declared scripts in manifest order
    // and retry once instead of making the user reload the whole Flow page.
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [
        "content/shared/I18n.js",
        "content/shared/dom-utils.js",
        "content/shared/activity-overlay.js",
        "content/shared/native-file-transfer.js",
        "content/providers/BaseProviderDriver.js",
        "content/providers/ProviderRegistry.js",
        "content/providers/flow/FlowNavigation.js",
        "content/providers/flow/FlowEditor.js",
        "content/providers/flow/FlowSettings.js",
        "content/providers/flow/FlowComponents.js",
        "content/providers/flow/FlowCharacters.js",
        "content/providers/flow/FlowTiles.js",
        "content/providers/flow/FlowMediaMenu.js",
        "content/providers/flow/FlowAgent.js",
        "content/providers/flow/FlowDriver.js",
        "content/dom-actions.js",
      ],
    }).catch(() => {});
    await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", files: ["content/bridge/flow-upload-main.js"] }).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 200));
    return await chrome.tabs.sendMessage(tabId, message);
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
  if (tabOperationActive(tabId)) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !flowUrl(tab.url)) return;
  const url = new URL(tab.url);
  if (url.searchParams.get("hl") === "en") return;
  // SPA routes may drop hl even though the interface is already English.
  // Rewriting that URL reloads the page and destroys in-flight content commands.
  const language = await chrome.scripting.executeScript({ target: { tabId }, func: () => document.documentElement.lang })
    .then(results => String(results?.[0]?.result || "")).catch(() => "");
  if (/^en\b/i.test(language) || tab.status === "loading") return;
  url.searchParams.set("hl", "en");
  await chrome.tabs.update(tabId, { url: url.href });
  await waitForTabComplete(tabId).catch(() => {});
}
async function prepareFlowTab(tabId) {
  if (tabOperationActive(tabId)) return;
  const existing = tabPreparations.get(tabId);
  if (existing) return existing;
  const preparation = (async () => {
    if (tabOperationActive(tabId)) return;
    await ensureEnglishFlowTab(tabId);
    if (tabOperationActive(tabId)) return;
    await clearStaleFlowSubmitBridge(tabId);
    if (tabOperationActive(tabId)) return;
    await ensureFlowUploadBridge(tabId);
  })();
  tabPreparations.set(tabId, preparation);
  try { await preparation; }
  finally { if (tabPreparations.get(tabId) === preparation) tabPreparations.delete(tabId); }
}
function showActivity(tabId, active) {
  if (!Number.isInteger(tabId) || !chrome.tabs.sendMessage) return;
  void (async () => {
    if (active) await ensureActivityOverlay(tabId);
    await chrome.tabs.sendMessage(tabId, { type: "flow-mcp:activity", active });
  })().catch(() => {});
}
function beginInteractiveRequest(tabId, requestId) {
  const key = typeof requestId === "string" || typeof requestId === "number" ? String(requestId) : Symbol("interactive-flow-request");
  activeInteractiveRequests.set(key, tabId);
  activeInteractiveCounts.set(tabId, (activeInteractiveCounts.get(tabId) || 0) + 1);
  showActivity(tabId, true);
  return key;
}
function endInteractiveRequest(key, tabId) {
  if (activeInteractiveRequests.get(key) !== tabId) return;
  activeInteractiveRequests.delete(key);
  const remaining = (activeInteractiveCounts.get(tabId) || 1) - 1;
  if (remaining > 0) activeInteractiveCounts.set(tabId, remaining);
  else {
    activeInteractiveCounts.delete(tabId);
    showActivity(tabId, false);
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
  const tabs = await chrome.tabs.query({ url: "https://flow.google.com/*" });
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
  await prepareFlowTab(tab.id);
  return tab;
}
async function adoptFlowTab(tab, prepare = false) {
  if (!tab?.id || !flowUrl(tab.url)) return false;
  selectedTabId = tab.id;
  await chrome.storage.session.set({ selectedFlowTabId: tab.id });
  if (prepare) {
    await prepareFlowTab(tab.id);
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
    const flowTarget = command._flowTarget;
    const hasFlowTargetTab = flowTarget && Object.prototype.hasOwnProperty.call(flowTarget, "tabId");
    const flowTargetTabId = flowTarget?.tabId;
    if (hasFlowTargetTab && (!Number.isInteger(flowTargetTabId) || flowTargetTabId < 0)) {
      throw new Error("The native Flow target has an invalid tab id.");
    }
    const requestedTabId = command.tabId ?? command.tab_id;
    let tabId = hasFlowTargetTab ? flowTargetTabId : requestedTabId === undefined ? selectedTabId : requestedTabId;
    if (tabId === undefined) tabId = (await chooseTab()).id;
    else {
      const selectedTab = await chrome.tabs.get(tabId).catch(() => null);
      if (!selectedTab || !flowUrl(selectedTab.url)) {
        if (hasFlowTargetTab) throw new Error("The native Flow target tab is no longer open or is no longer a Flow tab.");
        if (requestedTabId !== undefined) throw new Error("Native Flow command targets a tab that is no longer open.");
        tabId = (await chooseTab()).id;
      }
    }
    if (!hasFlowTargetTab && tabId !== selectedTabId) throw new Error("Native Flow command targets a tab other than the selected Flow tab");
    if (tabId === undefined) throw new Error("No Flow tab is selected");
    const operation = command.name;
    const pendingPreparation = tabPreparations.get(tabId);
    if (pendingPreparation) await pendingPreparation;
    if (operation === "flow.projects.list") return listFlowProjects();
    if (operation === "flow.project.open") {
      if (tabOperationActive(tabId)) {
        throw Object.assign(new Error("Flow is processing another operation in the selected tab. Try opening the project again when it finishes."), {
          code: "FLOW_TAB_BUSY", retryable: true, outcome_unknown: false,
        });
      }
      enterTabOperation(tabId);
      try { return await openFlowProject(command.payload?.projectId); }
      finally { leaveTabOperation(tabId); }
    }
    if (operation === "flow.generation.upload.preflight") await prepareFlowTab(tabId);
    const interactive = !["flow.state", "flow.assets.list", "flow.characters.list", "flow.generation.observe", "flow.generation.upload.preflight", "flow.file.upload.begin", "flow.file.upload.chunk", "flow.file.upload.finish", "flow.file.upload.abort"].includes(operation);
    const requestId = command.requestId ?? command.request_id ?? command.id;
    const activityKey = interactive ? beginInteractiveRequest(tabId, requestId) : undefined;
    let response;
    enterTabOperation(tabId);
    try {
      response = await sendFlowCommand(tabId, {
        type: "flow-mcp:execute",
        command: { ...command, id: command.requestId ?? command.request_id ?? command.id, jobId: command.jobId ?? command.job_id },
      });
    } catch (error) {
      const message = String(error?.message || error);
      const definitelyNotDelivered = /Receiving end does not exist|Could not establish connection/i.test(message);
      if (maybeSubmittedOperations.has(operation) && !definitelyNotDelivered) {
        throw Object.assign(new Error(message), {
          name: error?.name || "Error",
          code: error?.code,
          retryable: Boolean(error?.retryable),
          outcome_unknown: true,
        });
      }
      throw error;
    } finally {
      leaveTabOperation(tabId);
      if (interactive) endInteractiveRequest(activityKey, tabId);
    }
    if (!response?.ok) {
      const error = new Error(response?.error?.message || response?.error || "Flow DOM command failed");
      error.code = response?.error?.code || "FLOW_DOM_FAILED";
      error.retryable = Boolean(response?.error?.retryable);
      error.outcome_unknown = Boolean(response?.error?.outcome_unknown);
      throw error;
    }
    if (operation === "flow.context" && response.value && typeof response.value === "object") {
      return { ...response.value, tabId };
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
      heartbeat = setInterval(() => {
        send(ws, { type: "ping" });
        if (selectedTabId) {
          chrome.tabs.get(selectedTabId).catch(() => {});
        }
      }, 20_000);
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
      // Retry slowly when another connector temporarily owns the backend socket.
      scheduleReconnect(close.code === 1008 ? 10_000 : undefined);
    };
    ws.onerror = () => { lastError = "Cannot connect to the local backend"; ws.close(); };
  } catch (error) { lastError = String(error?.message || error); scheduleReconnect(); }
  finally { opening = false; }
}
chrome.tabs.onRemoved.addListener((tabId, info) => {
  reloadedUploadBridgeTabs.delete(tabId);
  reloadedSubmitCleanupTabs.delete(tabId);
  void chrome.storage.session.get("reloadedSubmitCleanupTabIds").then(state => {
    const ids = Array.isArray(state.reloadedSubmitCleanupTabIds) ? state.reloadedSubmitCleanupTabIds : [];
    if (ids.includes(tabId)) return chrome.storage.session.set({ reloadedSubmitCleanupTabIds: ids.filter(id => id !== tabId) });
  }).catch(() => {});
  if (tabId === selectedTabId) {
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
    // Selection can follow SPA navigation without preparing/reloading that document.
    void adoptFlowTab(tab, false).catch(error => { lastError = String(error?.message || error); });
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
      if (!Number.isInteger(tabId) || tabId < 0) throw new Error("The download request did not come from an open Flow tab.");
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab || !flowUrl(tab.url)) throw new Error("The download request did not come from an open Flow tab.");
      await chrome.tabs.update(tabId, { active: true });
      await adoptFlowTab(tab, false);
      respond({ ok: true });
    })().catch(error => respond({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  if (message?.type === "flow-mcp:progress") {
    const requestId = message.requestId ?? message.request_id ?? message.commandId ?? message.command_id;
    const tabId = _sender.tab?.id;

    // Broadcast to UI pages (sidebar, popup) for real-time progress display
    chrome.runtime.sendMessage({
      type: "flow-mcp:progress-broadcast",
      requestId: String(requestId || ""),
      jobId: message.jobId ?? message.job_id,
      progress: message.progress,
    }).catch(() => {});

    const isInteractive = activeInteractiveRequests.get(String(requestId)) === tabId;
    const isSelectedFlowTab = tabId !== undefined && tabId === selectedTabId;
    const ok = flowUrl(_sender.tab?.url) && (typeof requestId === "string" || typeof requestId === "number")
      && (isInteractive || isSelectedFlowTab);
    if (ok) event("extension.progress", [{ requestId: String(requestId), jobId: message.jobId ?? message.job_id, tabId, progress: message.progress }]);
    respond({ ok: Boolean(ok) });
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
    const tabId = _sender.tab?.id;
    respond({ active: flowUrl(_sender.tab?.url) && (activeInteractiveCounts.get(tabId) || 0) > 0 });
    return;
  }
  if (message?.type === "flow-mcp:dispatch") {
    void (async () => {
      const { operation, payload } = message;
      const command = {
        op: "flowOperation",
        name: operation,
        payload: payload || {},
        id: "ui-" + Date.now(),
      };
      const result = await execute(null, "flow.dom.execute", [command]);
      respond({ ok: true, value: result });
    })().catch(err => {
      respond({ ok: false, error: { message: err?.message || String(err), code: err?.code || "DISPATCH_FAILED" } });
    });
    return true;
  }
  if (message?.type === "flow-mcp:status") {
    Promise.all([config(), chrome.tabs.query({ url: "https://flow.google.com/*" })]).then(([c, tabs]) => respond({ configured: true, bridge: c.bridge, flowTabs: tabs.length, selectedTabId, wsConnected: socket?.readyState === WebSocket.OPEN, error: lastError }));
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

