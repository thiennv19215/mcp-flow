import { readFlowDownloadChunk } from "./flow-download-relay.js";
import { ensureCorrelationObserver } from "./flow-observer-health.js";
import { inspectExtensionBuild } from "./flow-build-info.js";
import { decideDevExtensionReload } from "./dev-extension-reload.js";
import { flowDocumentMatchesLocale, flowProjectUrl, forceEnglishFlowUrl } from "./flow-locale.js";
import "../build-revision.js";

const LOCAL_BRIDGE = "http://127.0.0.1:18897";
const defaults = { bridge: "https://mcp.shopcongngheso5.io.vn" };
const flowUrl = url => /^https:\/\/flow\.google\.com\//.test(url || "");
const nativeFlowOperations = new Set([
  "flow.context", "flow.state", "flow.projects.list", "flow.project.create", "flow.project.open", "flow.assets.list", "flow.characters.list",
  "flow.generation.submit", "flow.generation.observe", "flow.references.attach", "flow.references.clear", "flow.prompt.clear", "flow.voices.options",
  "flow.generation.observer.health",
  "flow.generation.upload.preflight",
  "flow.file.upload.begin", "flow.file.upload.chunk", "flow.file.upload.finish", "flow.file.upload.abort", "flow.media.upload",
  "flow.asset.download",
  "flow.downloads.read",
  "flow.asset.rename", "flow.asset.trash",
  "flow.character.create", "flow.character.edit", "flow.edit.run",
  "flow.continue.run", "flow.agent.batch",
]);
let socket = null;
let httpSession = null;
let bridgeTransport = "disconnected";
let opening = false;
let reconnectTimer;
let reconnectAttempt = 0;
let heartbeat;
let selectedTabId;
let lastError = "";
let progressReceiptSequence = 0;
let lastProgressDiagnostic = null;
const activeInteractiveRequests = new Map();
const activeInteractiveCounts = new Map();
const reloadedUploadBridgeTabs = new Set();
const reloadedSubmitCleanupTabs = new Set();
const tabPreparations = new Map();
const activeTabOperations = new Map();
let devReloadCheckInProgress = false;
const maybeSubmittedOperations = new Set([
  "flow.generation.submit", "flow.edit.run", "flow.continue.run", "flow.agent.batch",
  "flow.character.create", "flow.character.edit",
]);
const correlationRequiredOperations = new Set([
  "flow.generation.submit", "flow.edit.run", "flow.continue.run", "flow.agent.batch",
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
async function checkDevExtensionReload() {
  if (devReloadCheckInProgress) return;
  devReloadCheckInProgress = true;
  try {
    const storageKeys = ["flowMcpDevReloadRevision", "flowMcpDevReloadRefreshPending"];
    const stored = await chrome.storage.local.get(storageKeys);
    if (stored.flowMcpDevReloadRefreshPending) {
      await chrome.storage.local.remove("flowMcpDevReloadRefreshPending");
      const tabs = await chrome.tabs.query({ url: "https://flow.google.com/*" });
      await Promise.all(tabs.map(tab => tab.id === undefined ? Promise.resolve() : chrome.tabs.reload(tab.id).catch(() => {})));
    }

    let response;
    try {
      response = await fetch("http://127.0.0.1:18898/status", { cache: "no-store", signal: AbortSignal.timeout(1500) });
    } catch {
      return;
    }
    if (!response.ok) return;
    const decision = decideDevExtensionReload({
      ...await response.json(),
      previousRevision: stored.flowMcpDevReloadRevision,
      activeOperations: activeTabOperations.size,
    });
    if (decision.action === "initialize" || decision.action === "migrate") {
      await chrome.storage.local.set({ flowMcpDevReloadRevision: decision.reloadKey });
      return;
    }
    if (decision.action !== "reload") return;

    await chrome.storage.local.set({
      flowMcpDevReloadRevision: decision.reloadKey,
      flowMcpDevReloadRefreshPending: true,
    });
    chrome.runtime.reload();
  } finally {
    devReloadCheckInProgress = false;
  }
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
        "content/providers/flow/FlowGenerationOperations.js",
        "content/providers/flow/FlowLibraryOperations.js",
        "content/providers/flow/FlowWorkflowOperations.js",
        "content/providers/flow/FlowDriver.js",
        "content/dom-actions.js",
      ],
    }).catch(() => {});
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      files: [
        "content/bridge/flow-upload-main.js",
        "content/bridge/flow-correlation-observer.js",
        "content/bridge/slate-bridge.js",
      ],
    }).catch(error => {
      console.warn(`[ServiceWorker] Could not reinject Flow MAIN-world bridges for tab ${tabId}: ${error?.message || error}`);
    });
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
async function createFlowProject() {
  const selected = await chrome.tabs.get(selectedTabId);
  if (!flowUrl(selected.url)) throw new Error("The selected tab is no longer a Flow tab. Reconnect the extension.");
  const fromProject = /\/project\/[0-9a-f-]{36}(?:\/|$)/i.test(new URL(selected.url).pathname);
  let tabId = selectedTabId;
  let temporaryTab = null;
  if (fromProject) {
    temporaryTab = await chrome.tabs.create({ url: "https://flow.google.com/?hl=en", active: false });
    tabId = temporaryTab.id;
    await waitForTabComplete(tabId);
    await new Promise(resolve => setTimeout(resolve, 700));
  }
  try {
    const response = await sendFlowCommand(tabId, {
      type: "flow-mcp:execute",
      command: { op: "flowOperation", name: "flow.project.create", payload: {} },
    });
    if (!response?.ok) {
      const error = new Error(response?.error?.message || response?.error || "Could not create a Flow project.");
      error.code = response?.error?.code || "FLOW_CREATE_PROJECT_FAILED";
      error.retryable = Boolean(response?.error?.retryable);
      error.outcome_unknown = Boolean(response?.error?.outcome_unknown);
      throw error;
    }
    return response.value;
  } finally {
    if (temporaryTab) await chrome.tabs.remove(temporaryTab.id).catch(() => {});
  }
}
async function readFlowDocumentLanguage(tabId) {
  return chrome.scripting.executeScript({
    target: { tabId },
    func: () => String(document.documentElement?.lang || ""),
  }).then(results => String(results?.[0]?.result || "")).catch(() => "");
}
async function verifyFlowDocumentLocale(tabId, locale, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let actual = "";
  do {
    actual = await readFlowDocumentLanguage(tabId);
    if (flowDocumentMatchesLocale(actual, locale)) return actual;
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  const error = new Error(`Flow did not render the requested ${locale} interface (document language: ${actual || "unavailable"}). The page locale could not be verified.`);
  error.code = "FLOW_LOCALE_MISMATCH";
  error.retryable = true;
  error.outcome_unknown = false;
  error.expectedLocale = locale;
  error.actualLocale = actual || null;
  throw error;
}
async function openFlowProject(projectId, requestedLanguage = "en") {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(projectId || ""))) {
    throw new Error("Invalid Flow project id.");
  }
  if (requestedLanguage !== "en") throw new Error("Flow automation supports English only (language: en).");
  const language = "en";
  const url = flowProjectUrl(projectId, language);
  await chrome.tabs.update(selectedTabId, { url });
  await waitForTabComplete(selectedTabId);
  await verifyFlowDocumentLocale(selectedTabId, language);
  return { opened: true, id: projectId, url, language };
}
async function ensureFlowTabLocale(tabId) {
  if (tabOperationActive(tabId)) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !flowUrl(tab.url)) return;
  if (tab.status === "loading") await waitForTabComplete(tabId);
  const loadedTab = await chrome.tabs.get(tabId).catch(() => tab);
  const currentUrl = loadedTab.url || tab.url;
  const locale = "en";
  const documentLanguage = await readFlowDocumentLanguage(tabId);
  const englishUrl = forceEnglishFlowUrl(currentUrl);
  if (englishUrl !== currentUrl || !flowDocumentMatchesLocale(documentLanguage, locale)) {
    await chrome.tabs.update(tabId, { url: englishUrl });
    await waitForTabComplete(tabId);
  }
  await verifyFlowDocumentLocale(tabId, locale);
}
async function prepareFlowTab(tabId) {
  if (tabOperationActive(tabId)) return;
  const existing = tabPreparations.get(tabId);
  if (existing) return existing;
  const preparation = (async () => {
    if (tabOperationActive(tabId)) return;
    await ensureFlowTabLocale(tabId);
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
  const stored = await chrome.storage.local.get(null);
  // Existing profiles without a mode switch to this repository's local MCP.
  // Signing in from options.js explicitly selects the VPS again.
  const backendMode = stored.backendMode === "vps" ? "vps" : "local";
  const desiredBridge = backendMode === "local" ? LOCAL_BRIDGE : defaults.bridge;
  if (stored.backendMode !== backendMode || stored.bridge !== desiredBridge) {
    stored.backendMode = backendMode;
    stored.bridge = desiredBridge;
    await chrome.storage.local.set({ backendMode, bridge: desiredBridge });
  }
  let bridgeUrl;
  try { bridgeUrl = new URL(desiredBridge); } catch { throw new Error("Bridge URL is invalid"); }
  if (backendMode === "vps" && stored.deviceToken && stored.tokenBridgeOrigin !== bridgeUrl.origin) {
    await chrome.storage.local.remove(["deviceToken", "deviceId", "tokenBridgeOrigin"]);
    delete stored.deviceToken;
    delete stored.deviceId;
    delete stored.tokenBridgeOrigin;
  }
  return { ...defaults, ...stored, backendMode, bridge: desiredBridge };
};

function bridgeUrl(value) {
  const url = new URL(value);
  const configuredVps = url.hostname === "mcp.shopcongngheso5.io.vn";
  const local = ["127.0.0.1", "localhost"].includes(url.hostname) && url.port === "18897" && url.protocol === "http:";
  if (url.username || url.password || url.search || url.hash || !(local || (configuredVps && url.protocol === "https:"))) {
    throw new Error("Use the local MCP at http://127.0.0.1:18897 or the configured HTTPS VPS backend.");
  }
  return url;
}
function endpoint(value, token) {
  const url = bridgeUrl(value);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws/bridge";
  url.search = "";
  if (token) url.searchParams.set("token", token);
  return url.href;
}
function send(ws, message) { if (ws === socket && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); }
function bridgeConnected() {
  return bridgeTransport === "http-poll"
    ? Boolean(httpSession && !httpSession.stopped)
    : socket?.readyState === WebSocket.OPEN;
}
async function event(method, params) {
  if (httpSession && !httpSession.stopped) {
    return postHttpMessage(httpSession, "/api/extension/progress", { ...params[0], method, session_id: httpSession.sessionId }, { timeoutMs: 2500, retries: 1 });
  }
  if (socket) {
    send(socket, { type: "event", method, params });
    return { transport: "websocket", sent: socket.readyState === WebSocket.OPEN };
  }
  throw new Error("No active Flow bridge transport.");
}
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
  if (bridgeConnected()) lastError = "";
  if (!bridgeConnected() && socket?.readyState !== WebSocket.CONNECTING) void connect();
  return true;
}
async function execute(_ws, method, args = []) {
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
    if (operation === "flow.generation.observer.health") {
      if (tabOperationActive(tabId)) {
        throw Object.assign(new Error("Flow is processing another operation in this tab; observer health was not changed."), {
          code: "FLOW_TAB_BUSY", retryable: true, outcome_unknown: false,
        });
      }
      enterTabOperation(tabId);
      try {
        const health = await ensureCorrelationObserver(tabId);
        const extensionBuild = await inspectExtensionBuild(tabId);
        return { ...health, extensionBuild };
      }
      finally { leaveTabOperation(tabId); }
    }
    if (operation === "flow.projects.list") return listFlowProjects();
    if (operation === "flow.project.create") {
      if (tabOperationActive(tabId)) {
        throw Object.assign(new Error("Flow is processing another operation in the selected tab. Try creating the project again when it finishes."), {
          code: "FLOW_TAB_BUSY", retryable: true, outcome_unknown: false,
        });
      }
      enterTabOperation(tabId);
      try { return await createFlowProject(); }
      finally { leaveTabOperation(tabId); }
    }
    if (operation === "flow.project.open") {
      if (tabOperationActive(tabId)) {
        throw Object.assign(new Error("Flow is processing another operation in the selected tab. Try opening the project again when it finishes."), {
          code: "FLOW_TAB_BUSY", retryable: true, outcome_unknown: false,
        });
      }
      enterTabOperation(tabId);
      try { return await openFlowProject(command.payload?.projectId, command.payload?.language ?? "en"); }
      finally { leaveTabOperation(tabId); }
    }
    if (correlationRequiredOperations.has(operation)) await ensureCorrelationObserver(tabId);
    if (operation === "flow.generation.upload.preflight") await prepareFlowTab(tabId);
    const interactive = !["flow.state", "flow.assets.list", "flow.characters.list", "flow.voices.options", "flow.generation.observe", "flow.generation.upload.preflight", "flow.file.upload.begin", "flow.file.upload.chunk", "flow.file.upload.finish", "flow.file.upload.abort"].includes(operation);
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
      // Preserve page-side diagnostics through the extension relay. The native
      // queue applies its own narrow allowlist before storing any receipt.
      if (response?.error?.diagnostics && typeof response.error.diagnostics === "object") {
        error.diagnostics = response.error.diagnostics;
      }
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
      bytesReceived: item.bytesReceived, totalBytes: item.totalBytes, url: item.url, finalUrl: item.finalUrl, referrer: item.referrer,
    }));
  }
  if (method === "flow.downloads.read") {
    return readFlowDownloadChunk(args[0]);
  }
  throw new Error(`Unsupported connector method: ${method}`);
}
async function fetchBackend(url, token, body, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    return await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal, cache: "no-store" });
  } finally { clearTimeout(timer); }
}
async function postHttpMessage(session, path, body, options = {}) {
  let lastFailure;
  const retries = Math.max(1, Number(options.retries) || 3);
  const timeoutMs = Math.max(250, Number(options.timeoutMs) || 15_000);
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const response = await fetchBackend(`${session.bridge}${path}`, session.token, body, timeoutMs);
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        const error = new Error(detail.error || `Backend returned HTTP ${response.status}.`);
        error.status = response.status;
        if (response.status < 500 || attempt === 2) throw error;
        lastFailure = error;
      } else return { transport: "http-poll", httpStatus: response.status, body: await response.json().catch(() => ({})) };
    } catch (error) {
      lastFailure = error;
      if (error?.status && error.status < 500) throw error;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw lastFailure || new Error("Could not send a message to the backend.");
}
function applyBackendEvent(message) {
  if (message?.type === "event" && message.method === "flow.selectors.sync") {
    const payload = message.params?.[0];
    if (payload && typeof payload === "object") {
      console.log("[Flow MCP] Dynamic selectors sync received from backend");
      chrome.storage.local.set({ flow_remote_selectors: payload });
    }
  }
}
function dispatchCommand(command, sendResult) {
  const commandId = command.id ?? command.request_id ?? command.requestId;
  if (commandId === undefined || commandId === null) throw new Error("Command is missing request id");
  // Keep the receive loop responsive while a page operation waits.
  void execute(null, command.method, command.args).then(
    value => sendResult({ type: "result", id: commandId, result: { ok: true, value } }),
    error => sendResult({ type: "result", id: commandId, result: { ok: false, error: { code: error?.code || "EXTENSION_COMMAND_FAILED", message: String(error?.message || error), retryable: Boolean(error?.retryable), outcome_unknown: Boolean(error?.outcome_unknown), ...(error?.diagnostics ? { diagnostics: error.diagnostics } : {}) } } }),
  );
}
async function pollHttp(session) {
  while (httpSession === session && !session.stopped) {
    const controller = new AbortController();
    session.pollAbort = controller;
    const timer = setTimeout(() => controller.abort(), 35_000);
    try {
      const headers = { "content-type": "application/json" };
      if (session.token) headers.authorization = `Bearer ${session.token}`;
      const response = await fetch(`${session.bridge}/api/extension/poll`, {
        method: "POST", headers, body: JSON.stringify({ wait_ms: 20_000, session_id: session.sessionId }), signal: controller.signal, cache: "no-store",
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        throw new Error(detail.error || `Backend polling failed (HTTP ${response.status}).`);
      }
      const payload = await response.json();
      const message = payload?.message;
      if (message?.type === "event") applyBackendEvent(message);
      else if (message?.type === "command") dispatchCommand(message, result => {
        void postHttpMessage(session, "/api/extension/result", { id: String(result.id), result: result.result, session_id: session.sessionId }).catch(error => {
          if (httpSession === session) lastError = `Command result could not reach backend: ${String(error?.message || error)}`;
        });
      });
    } finally {
      clearTimeout(timer);
      if (session.pollAbort === controller) session.pollAbort = null;
    }
  }
}
function stopHttpSession() {
  if (!httpSession) return;
  httpSession.stopped = true;
  httpSession.pollAbort?.abort();
  httpSession = null;
}
async function connectHttp(settings, token) {
  const bridge = new URL(settings.bridge).origin;
  const response = await fetchBackend(`${bridge}/api/extension/connect`, token, {
    protocol: 3,
    version: chrome.runtime.getManifest().version,
    capabilities: [...nativeFlowOperations].map(name => `flow.native.${name.slice(5)}`),
  });
  if (response.status === 404 || response.status === 405) return false;
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    // The previous backend routes unknown bearer-authenticated paths through
    // its Studio-token guard and answers with this legacy 401 body.
    if (response.status === 401 && detail.error === "Missing or wrong token.") return false;
    throw new Error(detail.error || `Backend connection failed (HTTP ${response.status}).`);
  }
  const connection = await response.json().catch(() => ({}));
  if (typeof connection.session_id !== "string" || !connection.session_id) throw new Error("Backend did not return a connector session. Update the backend and try again.");
  const session = { bridge, token, sessionId: connection.session_id, stopped: false, pollAbort: null };
  httpSession = session;
  bridgeTransport = "http-poll";
  reconnectAttempt = 0;
  lastError = "";
  void pollHttp(session).catch(error => {
    if (httpSession !== session || session.stopped) return;
    stopHttpSession();
    bridgeTransport = "disconnected";
    lastError = `HTTPS polling disconnected: ${String(error?.message || error)}`;
    scheduleReconnect();
  });
  try {
    const selectors = await fetch(`${bridge}/api/flow-selectors`, { cache: "no-store" }).then(r => r.ok ? r.json() : null);
    if (selectors && typeof selectors === "object" && Object.keys(selectors).length > 0) {
      await chrome.storage.local.set({ flow_remote_selectors: selectors });
    }
  } catch (_) {}
  return true;
}
function scheduleReconnect(delayMs) {
  if (reconnectTimer) return;
  const backoff = Math.min(1500 * (2 ** reconnectAttempt++), 30_000);
  reconnectTimer = setTimeout(() => { reconnectTimer = undefined; void connect(); }, delayMs ?? backoff);
}
async function connect() {
  if (opening || bridgeConnected() || socket?.readyState === WebSocket.CONNECTING) return;
  opening = true;
  lastError = "";
  let backendOrigin = "";
  try {
    const settings = await config();
    backendOrigin = new URL(settings.bridge).origin;
    const token = settings.backendMode === "vps" && settings.tokenBridgeOrigin === backendOrigin
      ? settings.deviceToken
      : "";
    stopHttpSession();
    const httpConnected = await connectHttp(settings, token);
    if (httpConnected) return;
    // Older backends do not expose the HTTPS poll API yet. Keep the existing
    // WebSocket path available until that backend has been upgraded.
    const ws = new WebSocket(endpoint(settings.bridge, token));
    socket = ws;
    ws.onopen = () => {
      if (socket !== ws) return;
      bridgeTransport = "websocket";
      reconnectAttempt = 0;
      lastError = "";
      send(ws, { type: "event", method: "extension.initialized", params: [{ protocol: 2, version: chrome.runtime.getManifest().version, capabilities: [...nativeFlowOperations].map(name => `flow.native.${name.slice(5)}`) }] });
      try {
        const bridgeOrigin = new URL(settings.bridge).origin;
        fetch(`${bridgeOrigin}/api/flow-selectors`)
          .then(r => r.ok ? r.json() : null)
          .then(data => {
            if (data && typeof data === "object" && Object.keys(data).length > 0) {
              chrome.storage.local.set({ flow_remote_selectors: data });
            }
          })
          .catch(() => {});
      } catch (_) {}
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
      if (command.type === "event") { applyBackendEvent(command); return; }
      if (command.type !== "command") return;
      try { dispatchCommand(command, result => send(ws, result)); }
      catch (error) { ws.close(1002, String(error?.message || error)); }
    };
    ws.onclose = close => {
      if (socket !== ws) return;
      socket = null;
      bridgeTransport = "disconnected";
      clearInterval(heartbeat);
      const intentionalClose = ["User reconnect", "Bridge URL changed"].includes(close.reason);
      lastError = intentionalClose ? "" : close.reason || lastError || "Backend disconnected";
      // Retry slowly when another connector temporarily owns the backend socket.
      scheduleReconnect(close.code === 1008 ? 10_000 : undefined);
    };
    ws.onerror = () => {
      bridgeTransport = "disconnected";
      lastError = `Cannot connect to backend at ${new URL(settings.bridge).origin}. Sign in to the account, then check the VPS HTTPS/WSS connection.`;
      ws.close();
    };
  } catch (error) {
    bridgeTransport = "disconnected";
    lastError = `Cannot connect to backend${backendOrigin ? ` at ${backendOrigin}` : ""}: ${String(error?.message || error)}`;
    scheduleReconnect();
  }
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
    // A Flow URL change may switch hl to a non-English locale. Prepare it at
    // once; prepareFlowTab/ensureFlowTabLocale guard active operations so an
    // in-flight submit is never interrupted. A later API call also prepares
    // the tab before acting if this update arrived during an operation.
    void adoptFlowTab(tab, Boolean(changeInfo.url)).catch(error => { lastError = String(error?.message || error); });
  }
});
chrome.tabs.onCreated.addListener(tab => {
  if (tab.active && flowUrl(tab.url)) void adoptFlowTab(tab, true).catch(error => { lastError = String(error?.message || error); });
});
chrome.runtime.onInstalled.addListener(() => { chrome.alarms.create("flow-mcp-connect", { periodInMinutes: 0.5 }); void connect(); void checkDevExtensionReload(); });
chrome.runtime.onStartup.addListener(() => { chrome.alarms.create("flow-mcp-connect", { periodInMinutes: 0.5 }); void connect(); void checkDevExtensionReload(); });
chrome.alarms.onAlarm.addListener(() => { void connect(); void checkDevExtensionReload(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.bridge) return;
  clearTimeout(reconnectTimer); reconnectTimer = undefined;
  stopHttpSession();
  bridgeTransport = "disconnected";
  const previousSocket = socket;
  socket = null;
  clearInterval(heartbeat);
  if (previousSocket) previousSocket.close(1000, "Bridge URL changed");
  void connect();
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
    const receiptId = ++progressReceiptSequence;

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
    lastProgressDiagnostic = {
      receiptId, receivedAt: new Date().toISOString(), requestId: String(requestId ?? ""), tabId,
      flowUrl: flowUrl(_sender.tab?.url), isInteractive, isSelectedFlowTab, acceptedByWorker: Boolean(ok),
      progress: String(message.progress || "").slice(0, 240), transport: bridgeTransport,
      backendState: ok ? "pending" : "rejected_by_worker",
    };
    if (!ok) { respond({ ok: false, receiptId, diagnostic: lastProgressDiagnostic }); return; }
    const diagnostic = lastProgressDiagnostic;
    void event("extension.progress", [{ requestId: String(requestId), jobId: message.jobId ?? message.job_id, tabId, progress: message.progress }])
      .then(receipt => {
        const matched = receipt?.transport === "http-poll" ? receipt.body?.matched : undefined;
        const backendState = receipt?.transport !== "http-poll"
          ? "socket_send_attempted"
          : matched === true
            ? "backend_matched_pending_command"
            : matched === false
              ? "backend_received_unmatched_request"
              : "backend_ack_match_unreported";
        const completed = { ...diagnostic, backendState, backendMatchedRequest: matched, httpStatus: receipt?.httpStatus, forwardedAt: new Date().toISOString() };
        if (lastProgressDiagnostic?.receiptId === receiptId) lastProgressDiagnostic = completed;
        respond({ ok: true, receiptId, diagnostic: completed });
      })
      .catch(error => {
        const detail = String(error?.message || error);
        if (httpSession) lastError = `Progress could not reach backend: ${detail}`;
        const failed = { ...diagnostic, backendState: "forward_failed", backendError: detail.slice(0, 300), forwardedAt: new Date().toISOString() };
        if (lastProgressDiagnostic?.receiptId === receiptId) lastProgressDiagnostic = failed;
        respond({ ok: true, receiptId, diagnostic: failed });
      });
    return true;
  }
  if (message?.type === "flow-mcp:progress-diagnostics") {
    respond({ ok: true, diagnostic: lastProgressDiagnostic });
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
    Promise.all([config(), chrome.tabs.query({ url: "https://flow.google.com/*" })]).then(([c, tabs]) => respond({ configured: true, bridge: c.bridge, flowTabs: tabs.length, selectedTabId, connected: bridgeConnected(), transport: bridgeTransport, wsConnected: bridgeConnected(), error: lastError }));
    return true;
  }
  if (message?.type === "flow-mcp:connect") {
    void (async () => {
      await chrome.storage.session.remove("selectedFlowTabId");
      clearTimeout(reconnectTimer); reconnectTimer = undefined;
      stopHttpSession();
      bridgeTransport = "disconnected";
      const previousSocket = socket;
      socket = null;
      clearInterval(heartbeat);
      if (previousSocket) previousSocket.close(1000, "User reconnect");
      await connect();
      respond({ ok: true });
    })();
    return true;
  }
});
// Tự động mở Sidebar khi click vào action icon trên toolbar
if (chrome.sidePanel?.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(err => {
    console.warn("[SidePanel] setPanelBehavior failed, falling back to onClicked:", err);
  });
}
if (chrome.action?.onClicked) {
  chrome.action.onClicked.addListener(async (tab) => {
    if (chrome.sidePanel?.open && tab?.id) {
      try {
        await chrome.sidePanel.open({ tabId: tab.id });
      } catch (_) {
        try {
          await chrome.sidePanel.open({ windowId: tab.windowId });
        } catch (e) {
          console.error("[SidePanel] Failed to open side panel:", e);
        }
      }
    }
  });
}

void chrome.alarms.create("flow-mcp-connect", { periodInMinutes: 0.5 });
void connect();
void checkDevExtensionReload();

