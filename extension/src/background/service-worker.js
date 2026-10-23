import { readFlowDownloadChunk } from "./flow-download-relay.js";
import { ensureCorrelationObserver } from "./flow-observer-health.js";
import { inspectExtensionBuild } from "./flow-build-info.js";
import { decideDevExtensionReload } from "./dev-extension-reload.js";
import { flowDocumentMatchesLocale, flowHomeUrl, flowLocaleFromUrl, flowProjectUrl, normalizeFlowLocale } from "./flow-locale.js";
import { FlowJobQueue } from "./flow-job-queue.js";
import { planFlowAgentBatch, planFlowBatch, planFlowContinue, planFlowEdit } from "./flow-workflows.js";
import "../build-revision.js";

const LOCAL_BRIDGE = "http://127.0.0.1:18899";
const defaults = { bridge: LOCAL_BRIDGE };
const flowUrl = url => /^https:\/\/flow\.google\.com\//.test(url || "");
const nativeFlowOperations = new Set([
  "flow.context", "flow.state", "flow.projects.list", "flow.project.create", "flow.project.open", "flow.assets.list", "flow.characters.list",
  "flow.generation.submit", "flow.generation.observe", "flow.generation.manual.confirm", "flow.generation.manual.cancel", "flow.references.attach", "flow.references.clear", "flow.references.remove", "flow.prompt.clear", "flow.voices.options",
  "flow.editor.get", "flow.editor.clear", "flow.prompt.insert", "flow.generation.settings.apply", "flow.page.settings.apply", "flow.tiles.enumerate", "flow.tiles.status", "flow.generation.wait", "flow.gallery.scan", "flow.components.list", "flow.components.select", "flow.generation.preflight",
  "flow.generation.observer.health",
  "flow.generation.upload.preflight",
  "flow.file.upload.begin", "flow.file.upload.chunk", "flow.file.upload.finish", "flow.file.upload.abort", "flow.media.upload",
  "flow.asset.download",
  "flow.downloads.read",
  "flow.asset.rename", "flow.asset.trash",
  "flow.character.create", "flow.character.edit", "flow.edit.run",
  "flow.continue.run", "flow.agent.batch",
  "flow.frame.extract_last",
  "flow.queue.add", "flow.queue.generate", "flow.queue.edit", "flow.queue.continue", "flow.queue.agent",
  "flow.queue.get", "flow.queue.wait", "flow.queue.cancel", "flow.queue.retry", "flow.queue.metadata",
  "flow.queue.manual.continue",
]);
const extensionQueueOperations = new Set([
  "flow.queue.add", "flow.queue.generate", "flow.queue.edit", "flow.queue.continue", "flow.queue.agent",
  "flow.queue.get", "flow.queue.wait", "flow.queue.cancel", "flow.queue.retry", "flow.queue.metadata", "flow.queue.manual.continue",
]);
const extensionQueueJobOperations = new Set([
  "flow.generation.submit", "flow.edit.run", "flow.continue.run", "flow.agent.batch",
  "flow.character.create", "flow.character.edit",
]);
const GENERATED_MEDIA_DOWNLOAD_OPERATION = "flow.queue.download-generated";
const queueDownloadEnqueues = new Map();
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
  "flow.generation.submit", "flow.generation.manual.confirm", "flow.edit.run", "flow.continue.run", "flow.agent.batch",
  "flow.character.create", "flow.character.edit",
]);
const correlationRequiredOperations = new Set([
  "flow.generation.submit", "flow.generation.manual.confirm", "flow.edit.run", "flow.continue.run", "flow.agent.batch",
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
  await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", files: ["content/bridge/flow-upload-main.js", "content/bridge/slate-bridge.js"] })
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
async function reinjectFlowContentScripts(tabId) {
  const flowScripts = (chrome.runtime.getManifest().content_scripts || []).filter(script =>
    script.matches?.some(match => match === "https://flow.google.com/*") && Array.isArray(script.js) && script.js.length,
  );
  if (!flowScripts.length) throw new Error("No Flow content scripts are declared in the extension manifest.");

  // Use the manifest as the single source of truth so retry injection cannot
  // drift from the installed content-script modules or their load order.
  for (const script of flowScripts) {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: script.world || "ISOLATED",
      files: script.js,
    });
  }
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

    // A Flow tab can predate extension installation/reload. Reinjection uses
    // the manifest declarations in order instead of a second hard-coded list.
    await reinjectFlowContentScripts(tabId).catch(error => {
      console.warn(`[ServiceWorker] Could not reinject Flow content scripts for tab ${tabId}: ${error?.message || error}`);
    });
    await new Promise(resolve => setTimeout(resolve, 200));
    return await chrome.tabs.sendMessage(tabId, message);
  }
}
function flowCommandResponseTimeoutMs(operation, command) {
  const payload = command?.payload && typeof command.payload === "object" ? command.payload : {};
  if (operation === "flow.generation.observe") {
    const requested = Number(payload.timeoutMs ?? payload.timeout_ms);
    const budget = Number.isFinite(requested) && requested > 0 ? requested : 300_000;
    return Math.min(12 * 60_000, Math.max(45_000, budget + 30_000));
  }
  if (["flow.generation.submit", "flow.generation.manual.confirm"].includes(operation)) return 150_000;
  if (["flow.edit.run", "flow.continue.run", "flow.agent.batch", "flow.character.create", "flow.character.edit"].includes(operation)) return 35 * 60_000;
  return 2 * 60_000;
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
async function waitForFlowProjectReady(tabId, projectId, signal, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  const expectedProjectId = String(projectId || "").toLowerCase();
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw Object.assign(new Error("Queue stopped while Flow was returning to the project editor."), {
        code: "FLOW_OPERATION_CANCELLED", outcome_unknown: false,
      });
    }
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || !flowUrl(tab.url)) {
      throw Object.assign(new Error("The Flow tab closed while returning to the project editor."), {
        code: "FLOW_SESSION_REQUIRED", outcome_unknown: false,
      });
    }
    const currentProjectId = flowProjectIdFromUrl(tab.url);
    const projectRoot = (() => {
      try { return /^\/project\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/i.test(new URL(tab.url).pathname); }
      catch { return false; }
    })();
    const projectMatches = expectedProjectId ? currentProjectId === expectedProjectId : Boolean(currentProjectId);
    if (tab.status === "complete" && projectRoot && projectMatches) {
      // Let Flow rehydrate its editor and content scripts after the route load.
      await new Promise(resolve => setTimeout(resolve, 400));
      const settled = await chrome.tabs.get(tabId).catch(() => null);
      if (settled?.status === "complete" && flowProjectIdFromUrl(settled.url) === currentProjectId && /^\/project\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/i.test(new URL(settled.url).pathname)) return settled;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw Object.assign(new Error("Flow did not finish returning to the queued project. The task was not submitted; resume after the project editor is ready."), {
    code: "FLOW_PROJECT_LOAD_FAILED", retryable: true, outcome_unknown: false,
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
  const locale = normalizeFlowLocale(await readFlowDocumentLanguage(selectedTabId)) || flowLocaleFromUrl(selected.url);
  const tab = await chrome.tabs.create({ url: flowHomeUrl(locale), active: false });
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
    const locale = normalizeFlowLocale(await readFlowDocumentLanguage(selectedTabId)) || flowLocaleFromUrl(selected.url);
    temporaryTab = await chrome.tabs.create({ url: flowHomeUrl(locale), active: false });
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
async function openFlowProject(projectId, requestedLanguage) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(projectId || ""))) {
    throw new Error("Invalid Flow project id.");
  }
  const selected = await chrome.tabs.get(selectedTabId);
  const requestedLocale = requestedLanguage == null || requestedLanguage === "" ? null : normalizeFlowLocale(requestedLanguage);
  if (requestedLanguage && !requestedLocale) throw new Error("Flow language must be a valid locale tag such as en or vi.");
  const language = requestedLocale || normalizeFlowLocale(await readFlowDocumentLanguage(selectedTabId)) || flowLocaleFromUrl(selected.url);
  const url = flowProjectUrl(projectId, language);
  await chrome.tabs.update(selectedTabId, { url });
  await waitForTabComplete(selectedTabId);
  if (language) await verifyFlowDocumentLocale(selectedTabId, language);
  else await readFlowDocumentLanguage(selectedTabId);
  return { opened: true, id: projectId, url, language: language || null };
}
async function ensureFlowTabLocale(tabId) {
  if (tabOperationActive(tabId)) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !flowUrl(tab.url)) return;
  if (tab.status === "loading") await waitForTabComplete(tabId);
  const loadedTab = await chrome.tabs.get(tabId).catch(() => tab);
  const currentUrl = loadedTab.url || tab.url;
  // Flow can change locale through its own controls/account preferences. Keep
  // the URL and rendered language as Flow left them instead of redirecting.
  return normalizeFlowLocale(await readFlowDocumentLanguage(tabId)) || flowLocaleFromUrl(currentUrl);
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
  // Flow operations and MCP use the local connector only. VPS credentials are
  // retained for account verification, never used to relay Flow work.
  const desiredBridge = LOCAL_BRIDGE;
  if (stored.backendMode !== "local" || stored.bridge !== desiredBridge) {
    stored.backendMode = "local";
    stored.bridge = desiredBridge;
    await chrome.storage.local.set({ backendMode: "local", bridge: desiredBridge });
  }
  return { ...defaults, ...stored, backendMode: "local", bridge: desiredBridge };
};

function bridgeUrl(value) {
  const url = new URL(value);
  const local = ["127.0.0.1", "localhost"].includes(url.hostname) && url.port === "18899" && url.protocol === "http:";
  if (url.username || url.password || url.search || url.hash || !local) {
    throw new Error("Use the local MCP at http://127.0.0.1:18899.");
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
  const stored = await chrome.storage.session.get(["selectedFlowTabId", "targetFlowContext"]);
  const saved = stored.selectedFlowTabId;
  const active = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  // Keep one deliberate Flow target across focus changes. The active tab is
  // used only to establish a target when none exists; reconnect explicitly
  // reselects the currently active Flow tab.
  const tab = tabs.find(tab => tab.id === saved)
    || tabs.find(tab => tab.id === selectedTabId)
    || tabs.find(tab => active.some(item => item.id === tab.id))
    || tabs.find(tab => /\/project\/[0-9a-f-]{36}(?:\/|$)/i.test(new URL(tab.url).pathname))
    || tabs[0];
  if (!tab) throw new Error("Open a Google Flow tab to connect Flow MCP.");
  selectedTabId = tab.id;
  await chrome.storage.session.set({ selectedFlowTabId: tab.id, targetFlowContext: { tabId: tab.id, projectId: flowProjectIdFromUrl(tab.url) } });
  await prepareFlowTab(tab.id);
  return tab;
}
async function adoptFlowTab(tab, prepare = false) {
  if (!tab?.id || !flowUrl(tab.url)) return false;
  selectedTabId = tab.id;
  await chrome.storage.session.set({ selectedFlowTabId: tab.id, targetFlowContext: { tabId: tab.id, projectId: flowProjectIdFromUrl(tab.url) } });
  if (prepare) {
    await prepareFlowTab(tab.id);
  }
  if (bridgeConnected()) lastError = "";
  if (!bridgeConnected() && socket?.readyState !== WebSocket.CONNECTING) void connect();
  return true;
}
function flowProjectIdFromUrl(value) {
  try { return new URL(value).pathname.match(/\/project\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i)?.[1]?.toLowerCase() || null; }
  catch { return null; }
}
async function pinnedFlowTabId() {
  if (Number.isInteger(selectedTabId)) return selectedTabId;
  const stored = await chrome.storage.session.get("selectedFlowTabId");
  if (!Number.isInteger(stored.selectedFlowTabId)) return undefined;
  const tab = await chrome.tabs.get(stored.selectedFlowTabId).catch(() => null);
  if (!tab || !flowUrl(tab.url)) {
    await chrome.storage.session.remove(["selectedFlowTabId", "targetFlowContext"]);
    return undefined;
  }
  selectedTabId = tab.id;
  return selectedTabId;
}
async function execute(_ws, method, args = [], { queueOwner = false, connectorOwner = false, signal } = {}) {
  if (method === "flow.dom.execute") {
    const [command] = args;
    if (!command || typeof command !== "object" || typeof command.op !== "string") throw new Error("Invalid Flow DOM command");
    if (command.op !== "flowOperation" || !nativeFlowOperations.has(command.name)) {
      const error = new Error(`Native operation is not supported: ${String(command.name || command.op)}`);
      error.code = "NATIVE_CAPABILITY_UNSUPPORTED";
      error.retryable = true;
      throw error;
    }
    if (extensionQueueOperations.has(command.name)) {
      if (!connectorOwner) throw Object.assign(new Error("Queue bridge operations are available only through the local MCP connector."), {
        code: "FLOW_QUEUE_BRIDGE_FORBIDDEN", retryable: false, outcome_unknown: false,
      });
      const payload = command.payload && typeof command.payload === "object" ? command.payload : {};
      const id = String(payload.id ?? payload.job_id ?? "");
      if (["flow.queue.add", "flow.queue.generate", "flow.queue.edit", "flow.queue.continue", "flow.queue.agent"].includes(command.name)) {
        let plannedJobs;
        if (command.name === "flow.queue.generate") {
          plannedJobs = planFlowBatch(payload, {
            queue: await flowJobQueue.snapshot(), knownAssets: payload.knownAssets,
            outputAssets: payload.outputAssets,
            characterLooks: payload.characterLooks, techniques: payload.techniques,
            capabilityRegistry: payload.capabilityRegistry,
          }).jobs;
        } else if (command.name === "flow.queue.edit") {
          plannedJobs = [planFlowEdit(payload, { queue: await flowJobQueue.snapshot(), knownAssets: payload.knownAssets, outputAssets: payload.outputAssets }).job];
        } else if (command.name === "flow.queue.continue") {
          plannedJobs = [planFlowContinue(payload, { queue: await flowJobQueue.snapshot(), knownAssets: payload.knownAssets, outputAssets: payload.outputAssets }).job];
        } else if (command.name === "flow.queue.agent") {
          plannedJobs = [planFlowAgentBatch(payload, { queue: await flowJobQueue.snapshot(), knownAssets: payload.knownAssets, outputAssets: payload.outputAssets }).job];
        } else {
          const source = payload.job && typeof payload.job === "object" ? payload.job : payload;
          plannedJobs = [source];
        }
        const defaultFlowTarget = await captureFlowTargetMetadata();
        const batchId = crypto.randomUUID();
        const added = [];
        for (const [index, source] of plannedJobs.entries()) {
          const operation = String(source.operation || source.data?.operation || "flow.generation.submit");
          if (!extensionQueueJobOperations.has(operation)) throw Object.assign(new Error(`Unsupported queued Flow operation: ${operation}`), {
            code: "FLOW_QUEUE_OPERATION_UNSUPPORTED", retryable: false, outcome_unknown: false,
          });
          const jobPayload = source.payload ?? source.data?.payload;
          const workflow = jobPayload?.workflow || jobPayload?.params?.workflow || source.workflow || {};
          const previous = added[index - 1];
          const metadata = {
            source: 'mcp',
            ...(source.metadata ?? source.data?.metadata ?? {}),
            ...(source.metadata?.flowTabId === undefined && source.data?.metadata?.flowTabId === undefined ? defaultFlowTarget : {}),
            batchId,
            ...(workflow && Object.keys(workflow).length ? { workflow } : {}),
            ...(previous && workflow.dependency ? { dependsOnId: previous.id, dependencyType: workflow.dependency.type } : {}),
            ...(typeof jobPayload?.output_dir === "string" ? { output_dir: jobPayload.output_dir } : {}),
            ...(typeof jobPayload?.file_stem === "string" ? { file_stem: jobPayload.file_stem } : {}),
            ...(typeof jobPayload?.params?.output_dir === "string" ? { output_dir: jobPayload.params.output_dir } : {}),
            ...(typeof jobPayload?.params?.file_stem === "string" ? { file_stem: jobPayload.params.file_stem } : {}),
          };
          added.push(await flowJobQueue.add({
            id: source.id, operation, payload: jobPayload,
            label: source.label || source.name, metadata,
          }));
        }
        // Match the extension UI: adding work must not implicitly clear a
        // queue pause caused by an unresolved Flow page blocker or a manual
        // submit. Only an explicit Resume command may continue that queue.
        const beforeStart = await flowJobQueue.snapshot();
        const snapshot = payload.autoStart === false || beforeStart.isPaused || beforeStart.waitingForUser > 0
          ? beforeStart
          : await flowJobQueue.resume();
        const plannedOutputDir = plannedJobs[0]?.payload?.output_dir ?? plannedJobs[0]?.payload?.params?.output_dir ?? payload.output_dir;
        return { jobs: added, job: added.length === 1 ? added[0] : undefined, output_dir: plannedOutputDir, batchId, snapshot: flowQueueSnapshot(snapshot) };
      }
      if (command.name === "flow.queue.get") {
        if (!id) return flowQueueSnapshot(await flowJobQueue.snapshot());
        const result = await flowJobQueue.snapshotById(id);
        return { ...result, queue: flowQueueSnapshot(result.queue) };
      }
      if (command.name === "flow.queue.metadata") {
        if (!id) throw Object.assign(new Error("flow.queue.metadata requires an id."), { code: "FLOW_QUEUE_ID_REQUIRED", outcome_unknown: false });
        const job = await flowJobQueue.updateMetadata(id, payload.patch);
        if (!job) throw Object.assign(new Error(`No Flow queue job with id ${id}.`), { code: "FLOW_QUEUE_JOB_NOT_FOUND", outcome_unknown: false });
        return { job };
      }
      if (!id) throw Object.assign(new Error(`${command.name} requires an id.`), { code: "FLOW_QUEUE_ID_REQUIRED", outcome_unknown: false });
      if (command.name === "flow.queue.wait") {
        const timeoutMs = Number(payload.timeoutMs ?? payload.timeout_ms ?? 30_000);
        const result = await flowJobQueue.wait(id, timeoutMs);
        return { ...result, snapshot: flowQueueSnapshot(result.snapshot) };
      }
      if (command.name === "flow.queue.cancel") {
        const queuedJob = await flowJobQueue.get(id);
        const failedManual = await cancelManualWait(queuedJob);
        if (failedManual) return flowQueueSnapshot(failedManual);
        const result = await flowJobQueue.cancel(id);
        if (!result) throw Object.assign(new Error(`No Flow queue job with id ${id}.`), { code: "FLOW_QUEUE_JOB_NOT_FOUND", outcome_unknown: false });
        if (queuedJob?.status === "waiting_for_user") await flowJobQueue.resume();
        return result;
      }
      if (command.name === "flow.queue.manual.continue") {
        const snapshot = await flowJobQueue.continueManual(id);
        if (!snapshot) throw Object.assign(new Error(`Flow job ${id} is not waiting for a manual submit.`), { code: "FLOW_MANUAL_SUBMIT_NOT_WAITING", outcome_unknown: false });
        return flowQueueSnapshot(snapshot);
      }
      if (command.name === "flow.queue.retry") {
        return retryExtensionFlowJob(id);
      }
    }
    const queueSafeReads = new Set([
      "flow.context", "flow.state", "flow.projects.list", "flow.assets.list", "flow.characters.list",
      "flow.voices.options", "flow.generation.observe",
    ]);
    if (flowJobQueue?.running && !queueOwner && !queueSafeReads.has(command.name)) {
      throw Object.assign(new Error("The extension queue is using the Flow tab. Retry this operation after the active queue item finishes."), {
        code: "FLOW_TAB_BUSY",
        retryable: true,
        outcome_unknown: false,
      });
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
    if (!hasFlowTargetTab && !queueOwner && tabId !== selectedTabId) throw new Error("Native Flow command targets a tab other than the selected Flow tab");
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
      try { return await openFlowProject(command.payload?.projectId, command.payload?.language); }
      finally { leaveTabOperation(tabId); }
    }
    if (correlationRequiredOperations.has(operation)) await ensureCorrelationObserver(tabId);
    if (operation === "flow.generation.upload.preflight") await prepareFlowTab(tabId);
  const interactive = !["flow.state", "flow.assets.list", "flow.characters.list", "flow.voices.options", "flow.generation.observe", "flow.generation.upload.preflight", "flow.editor.get", "flow.tiles.enumerate", "flow.tiles.status", "flow.gallery.scan", "flow.components.list", "flow.file.upload.begin", "flow.file.upload.chunk", "flow.file.upload.finish", "flow.file.upload.abort"].includes(operation);
    const requestId = command.requestId ?? command.request_id ?? command.id ?? crypto.randomUUID();
    const activityKey = interactive ? beginInteractiveRequest(tabId, requestId) : undefined;
    let response;
    enterTabOperation(tabId);
    try {
      const targetTab = await chrome.tabs.get(tabId);
      const suppliedTarget = command._flowTarget || command.flowTarget || command._target || command.target || {};
      const guardedCommand = {
        ...command,
        id: requestId,
        _flowTarget: {
          ...suppliedTarget,
          tabId,
          driverKey: suppliedTarget.driverKey || "flow",
          origin: suppliedTarget.origin || "https://flow.google.com",
          ...(suppliedTarget.projectId !== undefined ? {} : { projectId: flowProjectIdFromUrl(targetTab.url) }),
        },
      };
      if (signal?.aborted) throw Object.assign(new Error("The Flow queue operation was cancelled before it started."), { code: "FLOW_OPERATION_CANCELLED", outcome_unknown: false });
      const cancelPageCommand = () => {
        void chrome.tabs.sendMessage(tabId, { type: "flow-mcp:cancel", requestId }).catch(() => {});
      };
      signal?.addEventListener("abort", cancelPageCommand, { once: true });
      if (signal?.aborted) cancelPageCommand();
      let responseTimer;
      let cancelGraceTimer;
      let rejectCancelled;
      const cancelledPromise = new Promise((_, reject) => { rejectCancelled = reject; });
      void cancelledPromise.catch(() => {});
      const onSignalAbort = () => rejectCancelled(Object.assign(new Error("Flow command was cancelled by the queue."), {
        code: "FLOW_OPERATION_CANCELLED",
        outcome_unknown: maybeSubmittedOperations.has(operation),
      }));
      signal?.addEventListener("abort", onSignalAbort, { once: true });
      if (signal?.aborted) onSignalAbort();
      try {
        if (signal?.aborted) throw Object.assign(new Error("The Flow queue operation was cancelled before it started."), {
          code: "FLOW_OPERATION_CANCELLED",
          outcome_unknown: false,
        });
        const message = {
          type: "flow-mcp:execute",
          command: { ...guardedCommand, jobId: command.jobId ?? command.job_id },
        };
        const responsePromise = sendFlowCommand(tabId, message);
        response = await Promise.race([
          responsePromise,
          cancelledPromise,
          new Promise((_, reject) => {
            responseTimer = setTimeout(() => {
              cancelPageCommand();
              cancelGraceTimer = setTimeout(() => {
                reject(Object.assign(new Error(`Flow did not return a response for ${operation} within its deadline, even after cancellation. The operation stopped waiting so the queue can continue.`), {
                  code: "FLOW_COMMAND_RESPONSE_TIMEOUT",
                  outcome_unknown: maybeSubmittedOperations.has(operation),
                }));
              }, 5_000);
            }, flowCommandResponseTimeoutMs(operation, command));
          }),
        ]);
      } finally {
        clearTimeout(responseTimer);
        clearTimeout(cancelGraceTimer);
        signal?.removeEventListener("abort", onSignalAbort);
        signal?.removeEventListener("abort", cancelPageCommand);
      }
    } catch (error) {
      const message = String(error?.message || error);
      const definitelyNotDelivered = /Receiving end does not exist|Could not establish connection/i.test(message);
      const explicitlySafe = error?.outcome_unknown === false || error?.outcomeUnknown === false;
      if (maybeSubmittedOperations.has(operation) && !definitelyNotDelivered && !explicitlySafe) {
        throw Object.assign(new Error(message), {
          name: error?.name || "Error",
          code: error?.code,
          retryable: Boolean(error?.retryable),
          outcome_unknown: true,
          noRetry: error?.noRetry === true,
          noReplay: error?.noReplay === true,
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
      error.noRetry = response?.error?.noRetry === true;
      error.noReplay = response?.error?.noReplay === true;
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
function flowQueueSnapshot(snapshot) {
  return { ...snapshot, items: snapshot.jobs, queue: snapshot.jobs };
}
async function captureFlowTargetMetadata() {
  try {
    const tab = await chooseTab();
    return { flowTabId: tab.id, flowProjectId: flowProjectIdFromUrl(tab.url) };
  } catch {
    return {};
  }
}
async function cancelManualWait(job) {
  if (job?.status !== "waiting_for_user" || job.operation !== "flow.generation.submit") return null;
  const prepared = job.result?.prepared || job.result;
  if (!prepared?.correlationAttemptId) {
    const error = Object.assign(new Error("The prepared Flow submit receipt is missing. Inspect Flow before retrying."), { code: "FLOW_MANUAL_SUBMIT_SESSION_LOST", outcome_unknown: true });
    return flowJobQueue.failManual(job.id, error);
  }
  const tabId = Number.isInteger(job.metadata?.flowTabId) ? job.metadata.flowTabId : selectedTabId;
  try {
    await execute(null, "flow.dom.execute", [{
      op: "flowOperation", name: "flow.generation.manual.cancel",
      payload: { attemptId: prepared.correlationAttemptId, expectedPrompt: prepared.prompt },
      ...(Number.isInteger(tabId) ? { tabId } : {}),
      id: `queue-${job.id}-manual-cancel-${crypto.randomUUID()}`,
    }], { queueOwner: true });
    return null;
  } catch (error) {
    if (error?.outcome_unknown || error?.outcomeUnknown) return flowJobQueue.failManual(job.id, error);
    throw error;
  }
}
async function retryExtensionFlowJob(id) {
  const previous = await flowJobQueue.get(id);
  const previousResult = previous?.result?.result || previous?.result || {};
  const previousErrorCode = String(previous?.errorCode || "").toUpperCase();
  if (previousResult.downloadError || previous?.metadata?.downloadError || previousErrorCode.includes("DOWNLOAD")) {
    throw Object.assign(new Error("This job generated media but its download failed. Download the existing Flow result; do not retry generation."), {
      code: "FLOW_QUEUE_DOWNLOAD_NOT_RETRYABLE", outcome_unknown: false,
    });
  }
  const failedScenes = Array.isArray(previousResult.failedScenes) ? previousResult.failedScenes.filter(Number.isSafeInteger) : [];
  if (previous?.operation === "flow.agent.batch" && previous.status === "completed" && failedScenes.length) {
    const originalParams = previous.payload?.params || {};
    const requestedNumbers = Array.isArray(previousResult.requestedSceneNumbers)
      ? previousResult.requestedSceneNumbers.map(Number)
      : (originalParams.agent_scenes || []).map((_, index) => Number(String(originalParams.file_stem || "scene-01").match(/\d+/)?.[0] || 1) + index);
    const requestedScenes = Array.isArray(originalParams.agent_scenes) ? originalParams.agent_scenes : [];
    const retryIndexes = failedScenes.map(number => requestedNumbers.indexOf(number)).filter(index => index >= 0 && index < requestedScenes.length);
    if (retryIndexes.length) {
      const payload = {
        ...previous.payload,
        params: {
          ...originalParams,
          agent_scenes: retryIndexes.map(index => requestedScenes[index]),
          agent_numbers: retryIndexes.map(index => requestedNumbers[index]),
        },
      };
      const job = await flowJobQueue.add({
        operation: "flow.agent.batch", payload,
        label: `Retry ${retryIndexes.length} failed Agent scene(s)`,
        metadata: { ...previous.metadata, retryOf: previous.id, retriedScenes: retryIndexes.map(index => requestedNumbers[index]) },
      });
      const snapshot = await flowJobQueue.resume();
      return { job, snapshot: flowQueueSnapshot(snapshot), retriedScenes: retryIndexes.map(index => requestedNumbers[index]) };
    }
  }
  const job = await flowJobQueue.retry(id);
  if (!job) throw Object.assign(new Error(`Flow queue job ${id} is not failed and cannot be retried.`), { code: "FLOW_QUEUE_NOT_RETRYABLE", outcome_unknown: false });
  const snapshot = await flowJobQueue.resume();
  return { job, snapshot: flowQueueSnapshot(snapshot) };
}
async function enqueueGeneratedMediaDownload(id) {
  const jobId = String(id || "").trim();
  if (!jobId) throw Object.assign(new Error("A Flow task ID is required to download its generated result."), { code: "FLOW_QUEUE_ID_REQUIRED" });
  const inFlight = queueDownloadEnqueues.get(jobId);
  if (inFlight) return inFlight;
  const request = (async () => {
    const sourceJob = await flowJobQueue.get(jobId);
    if (!sourceJob || !["completed", "failed"].includes(sourceJob.status)) {
      throw Object.assign(new Error("This Flow task has not finished yet."), { code: "FLOW_QUEUE_DOWNLOAD_SOURCE_UNAVAILABLE" });
    }
    const media = generatedMediaForQueueJob(sourceJob);
    if (!media.length) {
      throw Object.assign(new Error("This task has no verified generated Flow media available to download."), { code: "FLOW_QUEUE_DOWNLOAD_MEDIA_UNAVAILABLE" });
    }
    const jobs = await flowJobQueue.list();
    const activeDownload = jobs.find(job => job.operation === GENERATED_MEDIA_DOWNLOAD_OPERATION &&
      String(job.payload?.sourceJobId || "") === jobId && ["pending", "running"].includes(job.status));
    if (activeDownload) {
      await flowJobQueue.updateGeneratedMediaDownload(jobId, {
        state: activeDownload.status === "running" ? "downloading" : "queued",
        completed: Number(sourceJob.progress?.download?.completed) || 0,
        total: media.length,
      }, activeDownload.status === "running" ? "Downloading existing Flow results…" : "Download is already queued.");
      const snapshot = await flowJobQueue.snapshot();
      return { job: activeDownload, snapshot: flowQueueSnapshot(snapshot) };
    }
    const target = await captureFlowTargetMetadata();
    const sourceMetadata = sourceJob.metadata && typeof sourceJob.metadata === "object" ? sourceJob.metadata : {};
    const downloadMetadata = {
      source: sourceMetadata.source || "extension",
      ...target,
      ...(Number.isInteger(sourceMetadata.flowTabId) ? { flowTabId: sourceMetadata.flowTabId } : {}),
      ...(Object.prototype.hasOwnProperty.call(sourceMetadata, "flowProjectId") ? { flowProjectId: sourceMetadata.flowProjectId } : {}),
    };
    const downloadJob = await flowJobQueue.add({
      operation: GENERATED_MEDIA_DOWNLOAD_OPERATION,
      payload: { sourceJobId: jobId },
      label: `Download: ${sourceJob.label || media[0].title}`,
      metadata: {
        ...downloadMetadata,
        generatedMediaDownloadFor: jobId,
        generationResultCheckpoint: {
          media,
          quoteFields: {},
          recordedAt: Date.now(),
        },
      },
    });
    await flowJobQueue.updateGeneratedMediaDownload(jobId, {
      state: "queued", completed: 0, total: media.length,
    }, `Download queued for ${media.length} existing Flow result${media.length === 1 ? "" : "s"}.`);
    const beforeStart = await flowJobQueue.snapshot();
    const snapshot = beforeStart.isPaused || beforeStart.waitingForUser > 0
      ? beforeStart
      : await flowJobQueue.resume();
    return { job: downloadJob, snapshot: flowQueueSnapshot(snapshot) };
  })();
  queueDownloadEnqueues.set(jobId, request);
  try {
    return await request;
  } finally {
    if (queueDownloadEnqueues.get(jobId) === request) queueDownloadEnqueues.delete(jobId);
  }
}
function broadcastFlowQueue(snapshot, reason) {
  const message = { type: "flow-queue:changed", snapshot: flowQueueSnapshot(snapshot), reason };
  // runtime.sendMessage updates extension pages, but does not deliver to content
  // scripts. The floating tracker lives in the Flow tab, so broadcast there too.
  chrome.runtime.sendMessage(message).catch(() => {});
  void chrome.tabs.query({ url: "https://flow.google.com/*" }).then(tabs => Promise.allSettled(
    tabs.filter(tab => Number.isInteger(tab.id)).map(tab => chrome.tabs.sendMessage(tab.id, message)),
  )).catch(() => {});
}
function flowResultMedia(value) {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value.media)) return value.media;
  if (value.portraitMedia && typeof value.portraitMedia === "object") return [value.portraitMedia];
  if (value.result && typeof value.result === "object") return flowResultMedia(value.result);
  return [];
}
const flowDownloadTitleKey = value => String(value || "")
  .split(/[\\/]/).pop()
  .replace(/\.(?:png|jpe?g|webp|gif|mp4|webm|mov|zip)$/i, "")
  .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const pendingQueueFilenameOverrides = [];
function flowDownloadBasename(value) {
  return String(value || "").split(/[\\/]/).pop().trim();
}
function safeQueueFilenameStem(value) {
  let stem = flowDownloadBasename(value)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "");
  if (!stem || stem === "." || stem === "..") return "";
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(stem)) stem = `_${stem}`;
  return stem;
}
function queueDownloadExtension(downloadItem) {
  const nameExtension = flowDownloadBasename(downloadItem?.filename).match(/\.([a-z0-9]{1,10})$/i)?.[0];
  if (nameExtension && !/\.html?$/i.test(nameExtension)) return nameExtension.toLowerCase();
  const mime = String(downloadItem?.mime || "").split(";")[0].trim().toLowerCase();
  const byMime = new Map([
    ["image/jpeg", ".jpg"], ["image/png", ".png"], ["image/webp", ".webp"], ["image/gif", ".gif"],
    ["video/mp4", ".mp4"], ["video/webm", ".webm"], ["video/quicktime", ".mov"],
  ]);
  if (/\.html?$/i.test(nameExtension || "") && !byMime.has(mime)) return "";
  return byMime.get(mime) || nameExtension?.toLowerCase() || "";
}
function armQueueFilenameOverride({ jobId, flowMediaId, fileStem, flowTabId, flowProjectId, mediaKind, title }) {
  const stem = safeQueueFilenameStem(fileStem);
  if (!stem || !String(jobId || "").trim() || !Number.isInteger(flowTabId) || !flowMediaId) return null;
  const ticket = {
    jobId: String(jobId || ""),
    flowMediaId: String(flowMediaId),
    fileStem: stem,
    flowTabId,
    flowProjectId: String(flowProjectId || ""),
    mediaKind: String(mediaKind || "").toLowerCase() === "scene" ? "video" : String(mediaKind || "").toLowerCase(),
    title: String(title || "").trim(),
    armedAt: Date.now(),
    baselineAt: Date.now(),
    triggerStartedAt: null,
    triggerConfirmedAt: null,
    expiresAt: Date.now() + 5 * 60_000,
    downloadId: null,
    assignedFilename: null,
  };
  pendingQueueFilenameOverrides.push(ticket);
  return ticket;
}
function disarmQueueFilenameOverride(ticket) {
  const index = pendingQueueFilenameOverrides.indexOf(ticket);
  if (index >= 0) pendingQueueFilenameOverrides.splice(index, 1);
}
function queueDownloadProjectId(downloadItem) {
  const sourceUrl = `${downloadItem?.url || ""} ${downloadItem?.finalUrl || ""} ${downloadItem?.referrer || ""}`;
  return sourceUrl.match(/\/project\/([0-9a-f-]{36})(?:[/?#\s]|$)/i)?.[1]?.toLowerCase() || "";
}
function queueDownloadMatchesTicket(downloadItem, ticket, allowTabTimeMatch = false, allowProjectTimeMatch = false) {
  if (!downloadItem || !ticket) return false;
  const sourceUrl = `${downloadItem.url || ""} ${downloadItem.finalUrl || ""} ${downloadItem.referrer || ""}`.toLowerCase();
  const mediaIdMatch = sourceUrl.includes(ticket.flowMediaId.toLowerCase());
  const sameTab = downloadItem.tabId === ticket.flowTabId;
  const projectId = queueDownloadProjectId(downloadItem);
  if (projectId && ticket.flowProjectId && projectId !== ticket.flowProjectId.toLowerCase()) return false;
  // Chrome sometimes records a download initiated by Flow's own media pipeline
  // with tabId=-1 and an opaque CDN URL that omits the media UUID. In that case
  // the Flow project referrer plus the unique, post-trigger time window is the
  // available identity. Callers still reject multiple matches before attaching
  // any file to a queue task.
  if (!sameTab && !(mediaIdMatch && downloadItem.tabId === -1)) {
    if (!allowProjectTimeMatch || downloadItem.tabId !== -1 || !ticket.flowProjectId || projectId !== ticket.flowProjectId.toLowerCase()) return false;
    const startedAt = Date.parse(downloadItem.startTime || "");
    return Number.isFinite(startedAt) && startedAt >= ticket.baselineAt - 1_000;
  }
  if (mediaIdMatch) return true;
  if (!allowTabTimeMatch || !sameTab) return false;
  const startedAt = Date.parse(downloadItem.startTime || "");
  return Number.isFinite(startedAt) && startedAt >= ticket.baselineAt - 1_000;
}
function queueDownloadMatchesTriggeredFlowItem(downloadItem, ticket, title) {
  if (!downloadItem || !ticket || !Number.isInteger(downloadItem.tabId) || downloadItem.byExtensionId && downloadItem.byExtensionId !== chrome.runtime.id) return false;
  const projectId = queueDownloadProjectId(downloadItem);
  if (projectId && ticket.flowProjectId && projectId !== ticket.flowProjectId.toLowerCase()) return false;
  const sameFlowTab = downloadItem.tabId === ticket.flowTabId;
  const flowReferrer = flowUrl(downloadItem.referrer) || flowUrl(downloadItem.url) || flowUrl(downloadItem.finalUrl);
  // Some Flow downloads are surfaced by Chrome under a different tab (or
  // tabId=-1), even though the filename and timing identify the result. Require
  // a Flow referrer or matching project for those records; a pinned Flow tab is
  // itself sufficient provenance.
  if (!sameFlowTab && !(flowReferrer || (ticket.flowProjectId && projectId === ticket.flowProjectId.toLowerCase()))) return false;
  const parsedStartedAt = Date.parse(downloadItem.startTime || "");
  const startedAt = Number.isFinite(parsedStartedAt) ? parsedStartedAt : Date.now();
  const lowerBound = Number(ticket.triggerStartedAt) || Number(ticket.baselineAt);
  const upperBound = (Number(ticket.triggerConfirmedAt) || Date.now()) + 30_000;
  if (!Number.isFinite(startedAt) || startedAt < lowerBound - 1_500 || startedAt > upperBound) return false;
  const extension = queueDownloadExtension(downloadItem);
  const compatibleExtension = ticket.mediaKind === "video"
    ? [".mp4", ".webm", ".mov"].includes(extension)
    : ticket.mediaKind === "image" && [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(extension);
  if (!compatibleExtension) return false;
  const titleKey = flowDownloadTitleKey(title);
  const filenameKey = flowDownloadTitleKey(downloadItem.filename);
  // Flow's browser filename often appends a timestamp to the asset title.
  return Boolean(titleKey && filenameKey.startsWith(titleKey));
}
chrome.downloads?.onDeterminingFilename?.addListener((downloadItem, suggest) => {
  const now = Date.now();
  for (let i = pendingQueueFilenameOverrides.length - 1; i >= 0; i--) {
    if (pendingQueueFilenameOverrides[i].expiresAt < now) pendingQueueFilenameOverrides.splice(i, 1);
  }
  if (downloadItem?.byExtensionId && downloadItem.byExtensionId !== chrome.runtime.id) return;
  if (!Number.isInteger(downloadItem?.id) || !Number.isInteger(downloadItem?.tabId)) return;
  const sourceUrl = `${downloadItem.url || ""} ${downloadItem.finalUrl || ""} ${downloadItem.referrer || ""}`;
  const mediaIdCandidates = pendingQueueFilenameOverrides.filter(ticket =>
    sourceUrl.toLowerCase().includes(ticket.flowMediaId.toLowerCase())
  );
  // Prefer the exact media UUID when the CDN URL exposes it. Flow often omits
  // that UUID from browser download metadata, so fall back to the armed per-job
  // title plus media type, trigger time, and Flow tab/project provenance. This
  // captures Chrome's download ID at creation time instead of trying to infer it
  // later from a global downloads list.
  const exactCandidates = mediaIdCandidates.length
    ? mediaIdCandidates.filter(ticket => queueDownloadMatchesTicket(downloadItem, ticket))
    : [];
  if (exactCandidates.length > 1) return;
  const candidates = exactCandidates.length === 1
    ? exactCandidates
    : pendingQueueFilenameOverrides.filter(ticket => !ticket.downloadId && ticket.title &&
      queueDownloadMatchesTriggeredFlowItem(downloadItem, ticket, ticket.title));
  if (candidates.length !== 1) return;
  const ticket = candidates[0];
  const extension = queueDownloadExtension(downloadItem);
  if (!extension) return;
  ticket.downloadId = downloadItem.id;
  ticket.assignedFilename = `${ticket.fileStem}${extension}`;
  disarmQueueFilenameOverride(ticket);
  suggest({ filename: ticket.assignedFilename, conflictAction: "uniquify" });
});
async function waitForQueueFlowDownload(beforeIds, title, timeoutMs = 12 * 60_000, filenameTicket = null) {
  if (!chrome.downloads?.search) throw Object.assign(new Error("Chrome download tracking is unavailable; the generated media remains in Flow."), {
    code: "FLOW_DOWNLOAD_TRACKING_UNAVAILABLE", outcomeUnknown: false, outcome_unknown: false,
  });
  const deadline = Date.now() + timeoutMs;
  const titleKey = flowDownloadTitleKey(title);
  let lastNew = [];
  while (Date.now() < deadline) {
    if (Number.isInteger(filenameTicket?.downloadId)) {
      const [claimed] = await chrome.downloads.search({ id: filenameTicket.downloadId });
      if (claimed?.state === "interrupted") throw Object.assign(new Error(`Chrome download failed for "${title}": ${claimed.error || "unknown error"}. The media remains in Flow.`), {
        code: "FLOW_DOWNLOAD_FAILED", outcomeUnknown: false, outcome_unknown: false,
      });
      if (claimed?.state === "complete" && claimed.filename) return {
        id: claimed.id,
        filename: claimed.filename,
        matchedByQueueTicket: true,
        matchedBy: "download_id",
      };
    }
    const items = await chrome.downloads.search({ orderBy: ["-startTime"], limit: 100 });
    const newItems = items.filter(item => !beforeIds.has(item.id));
    if (filenameTicket) {
      let matching = newItems.filter(item => item.id === filenameTicket.downloadId || queueDownloadMatchesTicket(item, filenameTicket, true, true));
      let matchedByTriggeredFilename = false;
      if (!matching.length) {
        const triggeredMatches = newItems.filter(item => queueDownloadMatchesTriggeredFlowItem(item, filenameTicket, title));
        if (triggeredMatches.length === 1) {
          matching = triggeredMatches;
          matchedByTriggeredFilename = true;
        } else if (triggeredMatches.length > 1) {
          throw Object.assign(new Error(`Chrome reported multiple new ${filenameTicket.mediaKind || "Flow"} downloads matching "${title}" after the Flow download action; refusing to attach an ambiguous file to this job.`), {
            code: "FLOW_DOWNLOAD_AMBIGUOUS", outcomeUnknown: false, outcome_unknown: false,
          });
        }
      }
      lastNew = matching;
      if (matching.length > 1) {
        throw Object.assign(new Error(`Chrome reported multiple new downloads from the Flow queue tab for "${title}"; refusing to attach an ambiguous file to this job. The media remains in Flow.`), {
          code: "FLOW_DOWNLOAD_AMBIGUOUS", outcomeUnknown: false, outcome_unknown: false,
        });
      }
      const candidate = matching[0];
      if (candidate?.state === "interrupted") throw Object.assign(new Error(`Chrome download failed for "${title}": ${candidate.error || "unknown error"}. The media remains in Flow.`), {
        code: "FLOW_DOWNLOAD_FAILED", outcomeUnknown: false, outcome_unknown: false,
      });
      if (candidate?.state === "complete" && candidate.filename) return { id: candidate.id, filename: candidate.filename, matchedByQueueTicket: true, ...(matchedByTriggeredFilename ? { matchedBy: "triggered_flow_filename" } : {}) };
      await new Promise(resolve => setTimeout(resolve, 750));
      continue;
    }
    const flowItems = newItems.filter(item => flowUrl(item.referrer) || flowUrl(item.url) || flowUrl(item.finalUrl));
    lastNew = flowItems;
    const matching = titleKey
      ? flowItems.filter(item => flowDownloadTitleKey(item.filename) === titleKey)
      : [];
    if (flowItems.length > 1 || matching.length > 1) {
      throw Object.assign(new Error(`Chrome reported multiple possible Flow downloads for "${title}"; refusing to attach an ambiguous file to this queue job. The media remains in Flow.`), {
        code: "FLOW_DOWNLOAD_AMBIGUOUS", outcomeUnknown: false, outcome_unknown: false,
      });
    }
    if (Number.isInteger(filenameTicket?.downloadId)) {
      const exact = newItems.find(item => item.id === filenameTicket.downloadId);
      if (exact?.state === "interrupted") throw Object.assign(new Error(`Chrome download failed for "${title}": ${exact.error || "unknown error"}. The media remains in Flow.`), {
        code: "FLOW_DOWNLOAD_FAILED", outcomeUnknown: false, outcome_unknown: false,
      });
      if (exact?.state === "complete" && exact.filename) return { id: exact.id, filename: exact.filename };
      await new Promise(resolve => setTimeout(resolve, 750));
      continue;
    }
    // A lone new Flow download is not proof that it belongs to this task. Only
    // accept a unique filename match; otherwise leave the generated result in Flow.
    const candidates = flowItems.length === 1 && matching.length === 1 ? matching : [];
    const interrupted = candidates.find(item => item.state === "interrupted");
    if (interrupted) throw Object.assign(new Error(`Chrome download failed for "${title}": ${interrupted.error || "unknown error"}. The media remains in Flow.`), {
      code: "FLOW_DOWNLOAD_FAILED", outcomeUnknown: false, outcome_unknown: false,
    });
    const complete = candidates.find(item => item.state === "complete" && item.filename);
    if (complete) return { id: complete.id, filename: complete.filename };
    await new Promise(resolve => setTimeout(resolve, 750));
  }
  const active = lastNew.find(item => item.state === "in_progress");
  const detail = active ? `Chrome download ${active.bytesReceived || 0}/${active.totalBytes || "?"} bytes` : "Chrome did not report a new Flow download";
  throw Object.assign(new Error(`Flow media "${title}" was generated, but its browser download did not complete before the timeout (${detail}). The media remains in Flow.`), {
    code: "FLOW_DOWNLOAD_FAILED", outcomeUnknown: false, outcome_unknown: false,
  });
}
async function findExistingQueueFlowDownload(flowMediaId, flowTabId, flowProjectId) {
  if (!chrome.downloads?.search || !flowMediaId || !Number.isInteger(flowTabId)) return null;
  const ticket = {
    flowMediaId: String(flowMediaId),
    flowTabId,
    flowProjectId: String(flowProjectId || ""),
  };
  const items = await chrome.downloads.search({ query: [String(flowMediaId)], orderBy: ["-startTime"], limit: 100 });
  const matching = items.filter(item => queueDownloadMatchesTicket(item, ticket));
  // A completed exact-UUID download is already a successful hand-off. Reuse it
  // after a service-worker restart instead of starting a duplicate download.
  return matching.find(item => item.state === "complete") ||
    matching.find(item => item.state === "in_progress") ||
    matching.find(item => item.state === "interrupted") || null;
}
async function waitForExistingQueueFlowDownload(downloadId, flowMediaId, flowTabId, flowProjectId, title, timeoutMs = 3 * 60_000) {
  const ticket = { flowMediaId: String(flowMediaId), flowTabId, flowProjectId: String(flowProjectId || "") };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const items = await chrome.downloads.search({ id: downloadId });
    const item = items.find(candidate => candidate.id === downloadId);
    if (!item) throw Object.assign(new Error(`Chrome no longer reports the in-progress download for "${title}". The generated media remains in Flow.`), {
      code: "FLOW_DOWNLOAD_TRACKING_UNAVAILABLE", outcomeUnknown: false, outcome_unknown: false,
    });
    if (!queueDownloadMatchesTicket(item, ticket)) throw Object.assign(new Error(`Chrome download identity changed while resuming "${title}"; refusing to attach an unrelated file. The generated media remains in Flow.`), {
      code: "FLOW_DOWNLOAD_IDENTITY_MISMATCH", outcomeUnknown: false, outcome_unknown: false,
    });
    if (item.state === "interrupted") throw Object.assign(new Error(`Chrome download failed for "${title}": ${item.error || "unknown error"}. The media remains in Flow.`), {
      code: "FLOW_DOWNLOAD_FAILED", outcomeUnknown: false, outcome_unknown: false,
    });
    if (item.state === "complete" && item.filename) return { id: item.id, filename: item.filename, matchedByQueueTicket: true };
    await new Promise(resolve => setTimeout(resolve, 750));
  }
  throw Object.assign(new Error(`Chrome download for "${title}" was still in progress after the resume timeout. The generated media remains in Flow.`), {
    code: "FLOW_DOWNLOAD_FAILED", outcomeUnknown: false, outcome_unknown: false,
  });
}
async function downloadQueueMedia(media, outputDir, fileStem, quality, invoke, hooks, sceneNumbers = [], jobId = "", flowTabId, flowProjectId = "", generationState = null) {
  if (!chrome.downloads?.search) throw Object.assign(new Error("Chrome download tracking is unavailable; the generated media remains in Flow."), {
    code: "FLOW_DOWNLOAD_TRACKING_UNAVAILABLE", outcomeUnknown: false, outcome_unknown: false,
  });
  const browserDownloads = [];
  try {
    for (const [index, item] of media.entries()) {
      const title = String(item?.title || item?.name || "").trim();
      const flowMediaId = String(item?.id || "").trim();
      if (!title || !flowMediaId || flowMediaId.startsWith("title:")) throw Object.assign(new Error("Flow generated media without a verified task-owned media ID and title, so its download could not be matched safely. The media remains in Flow."), {
        code: "FLOW_DOWNLOAD_ASSET_TITLE_MISSING", outcomeUnknown: false, outcome_unknown: false,
      });
      if (media.slice(0, index).some(previous => String(previous?.id || "").toLowerCase() === flowMediaId.toLowerCase())) throw Object.assign(new Error(`Flow returned duplicate task media identity "${flowMediaId}"; refusing to download the same or ambiguous result twice. The media remains in Flow.`), {
        code: "FLOW_DOWNLOAD_MEDIA_ID_DUPLICATE", outcomeUnknown: false, outcome_unknown: false,
      });
      const sceneNumber = Number(sceneNumbers[index]);
      const outputStem = Number.isSafeInteger(sceneNumber) && sceneNumber > 0
        ? `scene-${String(sceneNumber).padStart(2, "0")}`
        : media.length > 1 ? `${fileStem}-v${index + 1}` : fileStem;
      const existing = await findExistingQueueFlowDownload(flowMediaId, flowTabId, flowProjectId);
      if (existing) {
        const resumed = existing.state === "in_progress"
          ? await waitForExistingQueueFlowDownload(existing.id, flowMediaId, flowTabId, flowProjectId, title, quality === "upscaled" ? 12 * 60_000 : 3 * 60_000)
          : existing.state === "complete" && existing.filename
            ? { id: existing.id, filename: existing.filename, matchedByQueueTicket: true }
            : null;
        if (resumed) {
          browserDownloads.push({
            ...resumed,
            downloadId: resumed.id,
            flowMediaId,
            taskId: String(jobId || "").trim() || undefined,
            title,
            filenameOverrideApplied: false,
            fileStem: outputStem,
          });
          continue;
        }
        // An interrupted Chrome download does not mean the Flow asset is gone.
        // Start a fresh, ticketed download below so the user can retry from the
        // queue without regenerating the media.
      }
      const before = await chrome.downloads.search({ orderBy: ["-startTime"], limit: 100 });
      const beforeIds = new Set(before.map(download => download.id));
      let filenameTicket = null;
      try {
        const itemKind = String(item?.kind || item?.type || "").toLowerCase();
        const mediaLabel = itemKind === "video" || itemKind === "scene" ? "video" : itemKind === "image" ? "image" : "media";
        await hooks.progress({
          phase: "download",
          message: `Downloading ${mediaLabel} ${index + 1}/${media.length} from Flow…`,
          percent: 90 + Math.floor(index * 9 / Math.max(1, media.length)),
          generation: generationState,
          download: { state: "downloading", completed: index, total: media.length, current: { id: flowMediaId, title } },
        });
        filenameTicket = armQueueFilenameOverride({
          jobId, flowMediaId, fileStem: outputStem, flowTabId, flowProjectId, mediaKind: itemKind, title,
        });
        if (!filenameTicket) throw Object.assign(new Error(`Could not safely arm the requested filename for task ${jobId || "(unknown)"} and Flow media ${flowMediaId}; no download was started.`), {
          code: "FLOW_DOWNLOAD_FILENAME_ARM_FAILED", outcomeUnknown: false, outcome_unknown: false,
        });
        let triggered;
        try {
          filenameTicket.triggerStartedAt = Date.now();
          triggered = await invoke("flow.asset.download", { id: item.id, name: title, quality });
          filenameTicket.triggerConfirmedAt = Date.now();
        } catch (cause) {
          throw Object.assign(new Error(`Flow generated "${title}", but did not start its download: ${String(cause?.message || cause)}. The media remains in Flow.`), {
            code: cause?.code || "FLOW_DOWNLOAD_TRIGGER_FAILED", outcomeUnknown: false, outcome_unknown: false,
          });
        }
        if (!triggered?.downloadTriggered) throw Object.assign(new Error(`Flow generated "${title}", but did not confirm that its download started. The media remains in Flow.`), {
          code: "FLOW_DOWNLOAD_TRIGGER_FAILED", outcomeUnknown: false, outcome_unknown: false,
        });
        let download;
        try {
          download = await waitForQueueFlowDownload(beforeIds, title, quality === "upscaled" ? 12 * 60_000 : 3 * 60_000, filenameTicket);
        } catch (cause) {
          throw Object.assign(new Error(String(cause?.message || cause)), {
            code: cause?.code || "FLOW_DOWNLOAD_FAILED", outcomeUnknown: false, outcome_unknown: false,
          });
        }
        if (filenameTicket.downloadId && filenameTicket.downloadId !== download.id) throw Object.assign(new Error(`Chrome returned a different download ID than the Flow queue ticket for "${title}"; refusing to attach an unrelated file to this job. The media remains in Flow.`), {
          code: "FLOW_DOWNLOAD_FILENAME_UNCONFIRMED", outcomeUnknown: false, outcome_unknown: false,
        });
        if (download.matchedByQueueTicket !== true && filenameTicket.downloadId !== download.id) throw Object.assign(new Error(`Chrome downloaded Flow media "${title}" but its exact queue download could not be confirmed; the original browser filename was preserved. The generated media remains in Flow.`), {
          code: "FLOW_DOWNLOAD_FILENAME_UNCONFIRMED", outcomeUnknown: false, outcome_unknown: false,
        });
        if (!filenameTicket.downloadId) filenameTicket.downloadId = download.id;
        const filenameOverrideApplied = Boolean(filenameTicket.assignedFilename && filenameTicket.downloadId === download.id);
        browserDownloads.push({
          ...download,
          // `id` remains Chrome's download ID for the backend's chunk relay.
          downloadId: download.id,
          flowMediaId,
          taskId: String(jobId || "").trim() || undefined,
          title,
          filenameOverrideApplied,
          fileStem: outputStem,
        });
      } finally {
        if (filenameTicket) disarmQueueFilenameOverride(filenameTicket);
      }
    }
  } catch (error) {
    error.browserDownloads = browserDownloads;
    throw error;
  }
  return browserDownloads;
}
async function withQueueDownloads(job, payload, operationResult, invoke, hooks) {
  const params = payload?.params && typeof payload.params === "object" ? payload.params : {};
  const outputDir = job.metadata?.output_dir || payload.output_dir || params.output_dir;
  const requestedFileStem = job.metadata?.file_stem || payload.file_stem || params.file_stem;
  const submitOnly = payload.submitOnly === true || payload.submit_only === true || params.submit_only === true;
  if (submitOnly) return operationResult;
  const media = flowResultMedia(operationResult);
  if (!media.length) return operationResult;
  // Jobs created directly from the sidebar do not have a native output_dir or
  // file_stem. They still need the same success -> download -> return flow as
  // MCP jobs, so use a safe metadata stem for both the browser download and
  // the later local copy.
  const kind = payload.type === "video" || params.type === "video" ? "video" : "image";
  const fallbackLabel = job.label || payload.prompt || params.prompt || `flow-${kind}`;
  const fallbackStem = String(fallbackLabel)
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 96);
  const fileStem = typeof requestedFileStem === "string" && requestedFileStem.trim()
    ? requestedFileStem.trim()
    : (fallbackStem || `flow-${kind}-${String(job.id || crypto.randomUUID()).slice(0, 8)}`);
  const generationState = {
    state: "completed",
    count: media.length,
    media: media.map(item => ({
      id: String(item?.id || ""),
      title: String(item?.title || item?.name || "").trim(),
      kind: String(item?.kind || item?.type || kind).toLowerCase(),
    })),
  };
  const autoDownloadValues = [payload.autoDownload, payload.auto_download, params.autoDownload, params.auto_download];
  const autoDownload = autoDownloadValues.some(value => value === false)
    ? false
    : autoDownloadValues.some(value => value === true) ? true : undefined;
  if (autoDownload === false) {
    await hooks.progress({
      phase: "generation_complete",
      message: `Flow generated ${media.length} result${media.length === 1 ? "" : "s"}. Automatic download is off.`,
      percent: 100,
      generation: generationState,
      download: { state: "skipped", completed: 0, total: media.length },
    });
    return { ...operationResult, autoDownload: false };
  }
  await hooks.progress({
    phase: "generation_complete",
    message: `Flow generation completed: ${media.length} result${media.length === 1 ? "" : "s"}. Starting download…`,
    percent: 89,
    generation: generationState,
    download: { state: "queued", completed: 0, total: media.length },
  });
  try {
    const sceneNumbers = Array.isArray(operationResult?.sceneNumbers) && operationResult.sceneNumbers.length === media.length
      ? operationResult.sceneNumbers
      : [];
    const browserDownloads = await downloadQueueMedia(media, outputDir || "", fileStem, params.download_quality || payload.download_quality || "original", invoke, hooks, sceneNumbers, job.id, job.metadata?.flowTabId, job.metadata?.flowProjectId, generationState);
    await hooks.progress({
      phase: "download_complete",
      message: `Flow generated and downloaded ${media.length} result${media.length === 1 ? "" : "s"}.`,
      percent: 99,
      generation: generationState,
      download: { state: "completed", completed: media.length, total: media.length },
    });
    return { ...operationResult, browserDownloads };
  } catch (error) {
    // Generation succeeded independently of the optional browser download.
    // Preserve that success and report the separate download outcome.
    const downloadedCount = Array.isArray(error?.browserDownloads) ? error.browserDownloads.length : 0;
    try {
      await hooks.progress({
        phase: "download_failed",
        message: `Flow created ${media.length} result${media.length === 1 ? "" : "s"}, but download stopped at ${downloadedCount}/${media.length}: ${String(error?.message || error).slice(0, 700)}`,
        percent: 90 + Math.floor(downloadedCount * 9 / Math.max(1, media.length)),
        generation: generationState,
        download: { state: "failed", completed: downloadedCount, total: media.length, error: String(error?.message || error).slice(0, 700) },
      });
    } catch (progressError) {
      console.warn("[FlowQueue] Could not persist generated/download stage details:", progressError?.message || progressError);
    }
    return {
      ...operationResult,
      browserDownloads: Array.isArray(error?.browserDownloads) ? error.browserDownloads : [],
      downloadError: String(error?.message || error).slice(0, 700),
      downloadErrorCode: String(error?.code || "FLOW_DOWNLOAD_FAILED"),
    };
  }
}
function queueCompletionProgress(result, message) {
  if (result?.downloadError) {
    return {
      phase: "download_failed",
      message: `${message} Automatic download failed; the generated media is still available in Flow.`,
      percent: 100,
    };
  }
  if (result?.autoDownload === false) {
    return { phase: "complete", message: `${message} Automatic download is off.`, percent: 100 };
  }
  return { phase: "complete", message, percent: 100 };
}
function generatedMediaForQueueJob(job) {
  const checkpointMedia = job?.metadata?.generationResultCheckpoint?.media;
  const result = job?.result?.result || job?.result || {};
  const media = Array.isArray(checkpointMedia) && checkpointMedia.length ? checkpointMedia : flowResultMedia(result);
  return media.map(item => ({
    id: String(item?.id || "").trim(),
    title: String(item?.title || item?.name || "").trim(),
    kind: String(item?.kind || item?.type || "").toLowerCase() === "scene" ? "video" : String(item?.kind || item?.type || "").toLowerCase(),
  })).filter(item => item.id && item.title && ["image", "video"].includes(item.kind));
}
async function downloadGeneratedQueueJob(job, payload, invoke, hooks) {
  const sourceId = String(payload?.sourceJobId || "").trim();
  const sourceJob = sourceId ? await flowJobQueue.get(sourceId) : null;
  if (!sourceJob || !["completed", "failed"].includes(sourceJob.status)) {
    throw Object.assign(new Error("The original Flow task is missing or has not finished yet."), { code: "FLOW_QUEUE_DOWNLOAD_SOURCE_UNAVAILABLE", outcomeUnknown: false });
  }
  const media = generatedMediaForQueueJob(sourceJob);
  if (!media.length) {
    throw Object.assign(new Error("This Flow task has no verified generated media to download."), { code: "FLOW_QUEUE_DOWNLOAD_MEDIA_UNAVAILABLE", outcomeUnknown: false });
  }
  const params = sourceJob.payload?.params && typeof sourceJob.payload.params === "object" ? sourceJob.payload.params : {};
  const requestedFileStem = sourceJob.metadata?.file_stem || sourceJob.payload?.file_stem || params.file_stem;
  const kind = media[0].kind;
  const fallbackLabel = sourceJob.label || sourceJob.payload?.prompt || `flow-${kind}`;
  const fallbackStem = String(fallbackLabel)
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 96);
  const fileStem = typeof requestedFileStem === "string" && requestedFileStem.trim()
    ? requestedFileStem.trim()
    : (fallbackStem || `flow-${kind}-${String(sourceJob.id).slice(0, 8)}`);
  const generation = { state: "completed", count: media.length, media };
  const setSourceDownload = (state, completed, message, current) => flowJobQueue.updateGeneratedMediaDownload(sourceJob.id, {
    state, completed, total: media.length, ...(current ? { current } : {}),
  }, message);
  await setSourceDownload("downloading", 0, `Downloading ${media.length} existing Flow result${media.length === 1 ? "" : "s"}…`);
  const progressHooks = {
    signal: hooks.signal,
    progress: async progress => {
      await hooks.progress(progress);
      if (progress?.download) {
        const state = progress.download.state;
        const completed = Number(progress.download.completed) || 0;
        const current = progress.download.current;
        await setSourceDownload(state, completed, progress.message || "Downloading existing Flow results…", current);
      }
    },
  };
  const operationResult = sourceJob.result?.result || sourceJob.result || {};
  const sceneNumbers = Array.isArray(operationResult?.sceneNumbers) && operationResult.sceneNumbers.length === media.length
    ? operationResult.sceneNumbers
    : [];
  try {
    const browserDownloads = await downloadQueueMedia(
      media,
      sourceJob.metadata?.output_dir || sourceJob.payload?.output_dir || params.output_dir || "",
      fileStem,
      params.download_quality || sourceJob.payload?.download_quality || "original",
      invoke,
      progressHooks,
      sceneNumbers,
      sourceJob.id,
      job.metadata?.flowTabId,
      job.metadata?.flowProjectId,
      generation,
    );
    await setSourceDownload("completed", media.length, `Downloaded ${media.length} existing Flow result${media.length === 1 ? "" : "s"}.`);
    return { completed: true, downloadOnly: true, sourceJobId: sourceJob.id, browserDownloads };
  } catch (error) {
    const completed = Array.isArray(error?.browserDownloads) ? error.browserDownloads.length : 0;
    await setSourceDownload("failed", completed, `Download failed at ${completed}/${media.length}: ${String(error?.message || error).slice(0, 700)}.`);
    throw Object.assign(error, { outcomeUnknown: false, requestDispatched: false, retryable: false });
  }
}
async function runExtensionFlowJob(job, hooks) {
  const operation = job.operation || job.data?.operation;
  const payload = structuredClone(job.payload || job.data?.payload || {});
  const queuedOperations = new Set([
    ...extensionQueueJobOperations,
    GENERATED_MEDIA_DOWNLOAD_OPERATION,
  ]);
  if (!queuedOperations.has(operation)) {
    throw Object.assign(new Error(`Unsupported extension queue operation: ${String(operation || "(missing)")}`), {
      code: "FLOW_QUEUE_OPERATION_UNSUPPORTED",
      outcome_unknown: false,
    });
  }
  let pinnedTabId = Number.isInteger(job.metadata?.flowTabId) ? job.metadata.flowTabId : selectedTabId;
  let pinnedProjectId = Object.prototype.hasOwnProperty.call(job.metadata || {}, "flowProjectId") ? job.metadata.flowProjectId : undefined;
  if (!Number.isInteger(pinnedTabId)) pinnedTabId = (await chooseTab()).id;
  const pinnedTab = await chrome.tabs.get(pinnedTabId).catch(() => null);
  if (!pinnedTab || !flowUrl(pinnedTab.url)) throw new Error("The Flow tab pinned to this queue item is no longer open.");
  if (pinnedProjectId === undefined) pinnedProjectId = flowProjectIdFromUrl(pinnedTab.url);
  if (job.metadata?.flowTabId !== pinnedTabId || !Object.prototype.hasOwnProperty.call(job.metadata || {}, "flowProjectId")) {
    await flowJobQueue.updateMetadata(job.id, { flowTabId: pinnedTabId, flowProjectId: pinnedProjectId });
  }
  job.metadata = { ...(job.metadata || {}), flowTabId: pinnedTabId, flowProjectId: pinnedProjectId };
  const invokeOnce = (name, body) => execute(null, "flow.dom.execute", [{
      op: "flowOperation",
      name,
      payload: body,
      tabId: pinnedTabId,
      _flowTarget: { tabId: pinnedTabId, driverKey: "flow", origin: "https://flow.google.com", projectId: pinnedProjectId },
      jobId: job.id,
      id: `queue-${job.id}-${crypto.randomUUID()}`,
    }], { queueOwner: true, signal: hooks.signal });
  const invoke = async (name, body) => {
    try {
      return await invokeOnce(name, body);
    } catch (error) {
      // navigation.js throws this exact pre-submit signal after requesting a
      // return to the pinned project root. Wait for Flow to reload, then retry
      // that DOM command once so a route transition does not strand the queue.
      const wasNotDispatched = error?.outcomeUnknown !== true && error?.outcome_unknown !== true &&
        error?.requestDispatched !== true && error?.request_dispatched !== true;
      if (error?.code !== "FLOW_PROJECT_NAVIGATING" || !wasNotDispatched || error?.noRetry === true || error?.noReplay === true) throw error;
      await hooks.progress({ phase: "recovering", message: "Flow is returning to this queue's project; waiting before retrying the current DOM step…" });
      await waitForFlowProjectReady(pinnedTabId, pinnedProjectId, hooks.signal);
      return invokeOnce(name, body);
    }
  };
  while (tabOperationActive(pinnedTabId)) {
    if (hooks.signal.aborted) throw Object.assign(new Error("Queue stopped before Flow accepted this task."), { outcomeUnknown: false });
    await hooks.progress({ phase: "waiting", message: "Waiting for the active operation in this task's Flow tab to finish…" });
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  if (hooks.signal.aborted) throw Object.assign(new Error("Queue stopped before Flow accepted this task."), { outcomeUnknown: false });
  if (operation === GENERATED_MEDIA_DOWNLOAD_OPERATION) {
    return downloadGeneratedQueueJob(job, payload, invoke, hooks);
  }
  if (job.metadata?.dependsOnId) {
    const previous = await flowJobQueue.get(job.metadata.dependsOnId);
    if (!previous || previous.status !== "completed") {
      throw Object.assign(new Error(`This scene depends on previous queue job ${job.metadata.dependsOnId}, which did not complete.`), {
        code: "FLOW_SCENE_DEPENDENCY_FAILED", outcome_unknown: false,
      });
    }
    const result = previous.result?.result || previous.result || {};
    const media = result.media || result.result?.media || [];
    const dependency = job.metadata.dependencyType;
    if (!Array.isArray(media) || !media.length || !media[0]?.title) {
      throw Object.assign(new Error("The previous scene completed without a resolvable Flow media asset; dependent work was not submitted."), {
        code: "FLOW_SCENE_DEPENDENCY_ASSET_MISSING", outcome_unknown: false,
      });
    }
    if (dependency === "reference_previous") {
      if (media[0].kind !== "image") throw Object.assign(new Error("reference_previous requires the previous scene to produce an image."), {
        code: "FLOW_SCENE_DEPENDENCY_KIND_MISMATCH", outcome_unknown: false,
      });
      const reference = { assetName: media[0].title, ...(media[0].id ? { expectedId: media[0].id } : {}) };
      payload.attachments = [reference, ...(Array.isArray(payload.attachments) ? payload.attachments : [])].slice(0, 3);
    } else if (dependency === "chain_previous") {
      if (media[0].kind !== "video") throw Object.assign(new Error("chain_previous requires the previous scene to produce a video."), {
        code: "FLOW_SCENE_DEPENDENCY_KIND_MISMATCH", outcome_unknown: false,
      });
      const frame = await invoke("flow.frame.extract_last", { assetName: media[0].title });
      payload.firstFrame = { assetName: frame.title, expectedId: frame.id };
      // Flow Frames mode cannot be combined with ingredient references. Match the old MCP behavior, which skipped them.
      delete payload.attachments;
    }
  }
  if (operation === "flow.generation.submit" && Array.isArray(job.metadata?.generationResultCheckpoint?.media)) {
    const checkpoint = job.metadata.generationResultCheckpoint;
    const recoveredResult = {
      media: checkpoint.media,
      ...(checkpoint.quoteFields && typeof checkpoint.quoteFields === "object" ? checkpoint.quoteFields : {}),
      recoveredAfterWorkerRestart: true,
    };
    await hooks.progress({
      phase: "generation_complete",
      message: `Flow confirmed ${checkpoint.media.length} generated result${checkpoint.media.length === 1 ? "" : "s"}; resuming the remaining queue steps.`,
      percent: 89,
      generation: { state: "completed", count: checkpoint.media.length, media: checkpoint.media },
    });
    const operationResult = await withQueueDownloads(job, payload, recoveredResult, invoke, hooks);
    await hooks.progress(queueCompletionProgress(operationResult, "Flow generation completed."));
    return { completed: true, requestDispatched: true, ...checkpoint.quoteFields, result: operationResult };
  }
  await hooks.progress({ phase: "submit", message: "Submitting to Google Flow…", percent: 5 });
  if (operation !== "flow.generation.submit") {
    try {
      const rawResult = await invoke(operation, payload);
      const result = await withQueueDownloads(job, payload, rawResult, invoke, hooks);
      await hooks.progress(queueCompletionProgress(result, "Flow operation completed."));
      return { completed: true, operation, requestDispatched: Boolean(result?.requestDispatched), result };
    } catch (error) {
      throw Object.assign(error, {
        outcomeUnknown: Boolean(error?.outcomeUnknown || error?.outcome_unknown),
        requestDispatched: Boolean(error?.requestDispatched),
      });
    }
  }
  let submitted;
  try {
    const savedObservation = job.metadata?.generationObservation;
    if (savedObservation?.correlationAttemptId && !savedObservation.submitOnly) {
      submitted = {
        submitted: true,
        before: savedObservation.before || [],
        type: savedObservation.kind,
        expectedCount: savedObservation.expectedCount,
        correlationAttemptId: savedObservation.correlationAttemptId,
        credits: savedObservation.credits,
        requestDispatched: true,
      };
    } else if (job.metadata?.manualSubmitPhase === "confirm") {
      const prepared = job.result?.prepared || job.result;
      const confirmation = await invoke("flow.generation.manual.confirm", {
        attemptId: prepared?.correlationAttemptId,
        prepared,
      });
      if (confirmation?.waitingForUser === true) {
        await hooks.progress({ phase: "waiting_for_user", message: "Click Create in the Flow tab, then choose Continue in the extension queue." });
        return { waitingForUser: true, phase: "confirm", prepared, flowTabId: pinnedTabId };
      }
      submitted = confirmation;
    } else {
      submitted = await invoke(operation, payload);
    }
  } catch (error) {
    throw Object.assign(error, {
      outcomeUnknown: Boolean(error?.outcomeUnknown || error?.outcome_unknown),
      requestDispatched: Boolean(error?.requestDispatched),
    });
  }
  if (submitted?.preparedForManualSubmit === true) {
    await hooks.progress({ phase: "waiting_for_user", message: "Prompt and settings are ready in Flow. Click Create there, then choose Continue in the extension queue." });
    return { waitingForUser: true, phase: "prepared", prepared: submitted, flowTabId: pinnedTabId };
  }
  if (submitted?.submitted === false) {
    throw Object.assign(new Error("Flow did not confirm the generation request; the task can be retried safely."), {
      code: "FLOW_SUBMIT_NOT_CONFIRMED",
      outcomeUnknown: false,
    });
  }
  const params = payload.params && typeof payload.params === "object" ? payload.params : {};
  const isVideo = payload.type === "video" || params.type === "video";
  let quoteFields = {};
  if (isVideo) {
    const rawCredits = submitted?.credits;
    if (typeof rawCredits !== "number" || !Number.isFinite(rawCredits)) {
      const maxCredits = payload.maxCredits ?? params.max_credits;
      if (maxCredits !== undefined && maxCredits !== null) {
        throw Object.assign(new Error("Flow accepted the video request, but its credit quote could not be verified against max_credits. Inspect Flow before retrying."), {
          code: "FLOW_SUBMIT_RECEIPT_INCOMPLETE", outcomeUnknown: true, outcome_unknown: true, requestDispatched: true, creditQuoteVerified: false,
        });
      }
      // Some Flow video modes do not render a readable quote. A missing quote
      // must not turn an already-dispatched generation into a failed queue job
      // when the caller did not request a maxCredits safety limit.
      quoteFields = { creditQuoteVerified: false };
    } else {
      const maxCredits = payload.maxCredits ?? params.max_credits;
      if (Number.isFinite(Number(maxCredits)) && rawCredits > Number(maxCredits)) {
        throw Object.assign(new Error(`Flow dispatched a request quoted at ${rawCredits} credits, above max_credits=${maxCredits}; inspect Flow before retrying.`), {
          code: "FLOW_MAX_CREDITS_EXCEEDED", outcomeUnknown: true, outcome_unknown: true, requestDispatched: true, credits: rawCredits, creditQuoteVerified: true,
        });
      }
      quoteFields = { credits: rawCredits, creditQuoteVerified: true };
    }
  }
  if (payload.submitOnly === true || payload.submit_only === true || params.submit_only === true) {
    await hooks.progress({ phase: "submitted", message: "Flow accepted the request; rendering was not awaited.", percent: 100 });
    return { completed: true, requestDispatched: true, ...quoteFields, result: { ...submitted, ...quoteFields } };
  }
  const observation = {
    before: Array.isArray(submitted?.before) ? submitted.before : [],
    kind: isVideo ? "video" : "image",
    expectedCount: Math.max(1, Number(submitted?.expectedCount ?? payload.variants ?? payload.count ?? 1)),
    correlationAttemptId: String(submitted?.correlationAttemptId || ""),
    credits: Number.isFinite(submitted?.credits) ? submitted.credits : null,
    timeoutMs: isVideo ? 600_000 : 300_000,
  };
  if (observation.correlationAttemptId) {
    await flowJobQueue.checkpointGenerationObservation(job.id, observation);
    await flowJobQueue.updateMetadata(job.id, { generationQuoteFields: quoteFields });
    job.metadata = { ...(job.metadata || {}), generationObservation: observation, generationQuoteFields: quoteFields };
  }
  const count = Math.max(1, Number(observation.expectedCount || payload.variants || payload.count || 1));
  await hooks.progress({ phase: "render", message: "Submitted; waiting for Flow to finish rendering…", percent: 10 });
  let observed;
  try {
    observed = await invoke("flow.generation.observe", {
      before: observation.before,
      expectedCount: count,
      variants: count,
      correlationAttemptId: observation.correlationAttemptId,
      kind: observation.kind,
      retries: payload.retries,
      timeoutMs: observation.timeoutMs,
    });
  } catch (error) {
    throw Object.assign(error, {
      outcomeUnknown: true,
      requestDispatched: true,
      code: error?.code || "FLOW_RENDER_OUTCOME_UNKNOWN",
    });
  }
  if (Array.isArray(observed?.media) && observed.media.length) {
    await flowJobQueue.checkpointGenerationResult(job.id, observed.media).catch(error => {
      console.warn("[FlowQueue] Could not persist the worker-side generation result checkpoint:", error?.message || error);
    });
  }
  const operationResult = await withQueueDownloads(job, payload, { ...observed, ...quoteFields }, invoke, hooks);
  await hooks.progress(queueCompletionProgress(operationResult, "Flow generation completed."));
  return { completed: true, requestDispatched: true, ...quoteFields, result: operationResult };
}
// Keep a small cooldown between generations to avoid hammering Flow while
// removing most of the previous 5–10 second idle wait between queued jobs.
const flowJobQueue = new FlowJobQueue(runExtensionFlowJob, { minDelayMs: 1_000, maxDelayMs: 2_000 });
flowJobQueue.subscribe((snapshot, reason) => {
  broadcastFlowQueue(snapshot, reason);
  // Failures during queue preflight happen before the download runner can mark
  // the source item. Repair its state from the durable download job outcome.
  if (!["job-finished", "attention-required", "paused"].includes(reason)) return;
  for (const downloadJob of snapshot.jobs || []) {
    if (downloadJob.operation !== GENERATED_MEDIA_DOWNLOAD_OPERATION || downloadJob.status !== "failed") continue;
    const sourceJob = (snapshot.jobs || []).find(job => job.id === String(downloadJob.payload?.sourceJobId || ""));
    const state = String(sourceJob?.progress?.download?.state || "");
    if (!sourceJob || !["queued", "downloading"].includes(state)) continue;
    const media = generatedMediaForQueueJob(sourceJob);
    void flowJobQueue.updateGeneratedMediaDownload(sourceJob.id, {
      state: "failed", completed: 0, total: media.length || 1,
    }, `Download task failed: ${String(downloadJob.error || "Flow download did not complete.").slice(0, 700)}`)
      .catch(error => console.warn("[FlowQueue] Could not update failed manual-download state:", error?.message || error));
  }
});
void flowJobQueue.ready.then(() => flowJobQueue.resumeRecovered()).catch(error => {
  console.error("[FlowQueue] Could not resume a checkpointed job after worker restart:", error?.message || error);
});
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
        const error = new Error(detail.error || `Local MCP returned HTTP ${response.status}.`);
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
  throw lastFailure || new Error("Could not send a message to the local MCP host.");
}
function applyBackendEvent(message) {
  if (message?.type === "event" && message.method === "flow.selectors.sync") {
    const payload = message.params?.[0];
    if (payload && typeof payload === "object") {
      console.log("[Flow MCP] Dynamic selectors sync received from the local MCP host");
      chrome.storage.local.set({ flow_remote_selectors: payload });
    }
  }
}
function dispatchCommand(command, sendResult) {
  const commandId = command.id ?? command.request_id ?? command.requestId;
  if (commandId === undefined || commandId === null) throw new Error("Command is missing request id");
  // Keep the receive loop responsive while a page operation waits.
  void execute(null, command.method, command.args, { connectorOwner: true }).then(
    value => sendResult({ type: "result", id: commandId, result: { ok: true, value } }),
    error => sendResult({ type: "result", id: commandId, result: { ok: false, error: { code: error?.code || "EXTENSION_COMMAND_FAILED", message: String(error?.message || error), retryable: Boolean(error?.retryable), outcome_unknown: Boolean(error?.outcome_unknown), noRetry: error?.noRetry === true, noReplay: error?.noReplay === true, ...(error?.diagnostics ? { diagnostics: error.diagnostics } : {}) } } }),
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
          if (httpSession === session) lastError = `Command result could not reach the local MCP host: ${String(error?.message || error)}`;
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
    // Older local MCP builds may route unknown paths through their Studio token guard.
    if (response.status === 401 && detail.error === "Missing or wrong token.") return false;
    throw new Error(detail.error || `Backend connection failed (HTTP ${response.status}).`);
  }
  const connection = await response.json().catch(() => ({}));
  if (typeof connection.session_id !== "string" || !connection.session_id) throw new Error("Local MCP did not return a connector session. Update the local MCP and try again.");
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
    const token = "";
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
      // Retry slowly when another connector temporarily owns the local MCP socket.
      scheduleReconnect(close.code === 1008 ? 10_000 : undefined);
    };
    ws.onerror = () => {
      bridgeTransport = "disconnected";
      lastError = `Cannot connect to the local MCP at ${new URL(settings.bridge).origin}. Start it if you need AI access.`;
      ws.close();
    };
  } catch (error) {
    bridgeTransport = "disconnected";
    lastError = `Cannot connect to the local MCP${backendOrigin ? ` at ${backendOrigin}` : ""}: ${String(error?.message || error)}`;
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
    void chrome.storage.session.remove(["selectedFlowTabId", "targetFlowContext"]);
    // Keep the WebSocket alive and attach it to another remaining Flow tab.
    void chooseTab().catch(error => { lastError = String(error?.message || error); });
  }
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  void (async () => {
    const pinned = await pinnedFlowTabId();
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tabId === pinned && flowUrl(tab?.url)) await prepareFlowTab(tabId);
    else if (!Number.isInteger(pinned) && flowUrl(tab?.url)) await adoptFlowTab(tab, true);
  })().catch(() => {});
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url && tabId === selectedTabId && !flowUrl(changeInfo.url)) {
    selectedTabId = undefined;
    void chrome.storage.session.remove(["selectedFlowTabId", "targetFlowContext"]);
    void chooseTab().catch(error => { lastError = String(error?.message || error); });
    return;
  }
  if (flowUrl(tab.url) && tabId === selectedTabId) {
    void chrome.storage.session.set({ targetFlowContext: { tabId, projectId: flowProjectIdFromUrl(tab.url) } });
    if (changeInfo.url) void prepareFlowTab(tabId).catch(error => { lastError = String(error?.message || error); });
  } else if (flowUrl(tab.url) && selectedTabId === undefined) {
    // A Flow URL change may switch hl to a non-English locale. Prepare it at
    // once; prepareFlowTab/ensureFlowTabLocale guard active operations so an
    // in-flight submit is never interrupted. A later API call also prepares
    // the tab before acting if this update arrived during an operation.
    void pinnedFlowTabId().then(pinned => {
      if (!Number.isInteger(pinned)) return adoptFlowTab(tab, Boolean(changeInfo.url));
      if (tabId === pinned && changeInfo.url) return prepareFlowTab(tabId);
      return undefined;
    }).catch(error => { lastError = String(error?.message || error); });
  }
});
chrome.tabs.onCreated.addListener(tab => {
  if (tab.active && flowUrl(tab.url)) void pinnedFlowTabId().then(pinned => {
    if (!Number.isInteger(pinned)) return adoptFlowTab(tab, true);
    return undefined;
  }).catch(error => { lastError = String(error?.message || error); });
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
  if (typeof message?.type === "string" && message.type.startsWith("flow-queue:")) {
    // The Flow page tracker can control visible queue tasks and request a
    // download for a verified generated result. Keep generation and other queue
    // mutations restricted to extension UI pages.
    const readOnlyQueueState = message.type === "flow-queue:get";
    const trackerQueueAction = ["flow-queue:pause", "flow-queue:resume", "flow-queue:stop", "flow-queue:remove", "flow-queue:download"].includes(message.type);
    if (_sender?.id !== chrome.runtime.id || (_sender?.tab && !readOnlyQueueState && !trackerQueueAction)) {
      respond({ ok: false, error: { code: "FLOW_QUEUE_FORBIDDEN", message: "Flow queue controls are available only from the extension UI." } });
      return;
    }
    void (async () => {
      await flowJobQueue.ready;
      let snapshot;
      let addedJob;
      switch (message.type) {
        case "flow-queue:get":
          snapshot = await flowJobQueue.snapshot();
          break;
        case "flow-queue:add": {
          const source = message.job || {};
          addedJob = await flowJobQueue.add({
            operation: source.operation,
            payload: source.payload,
            label: source.label || source.name,
            metadata: { source: "extension", ...await captureFlowTargetMetadata(), ...(source.metadata || {}) },
          });
          // Adding from the create form always enqueues first, then starts or
          // resumes the sequential worker. Keep a manual-submit pause intact so
          // the user can finish that confirmation before later jobs proceed.
          const beforeStart = await flowJobQueue.snapshot();
          snapshot = message.autoStart === false || beforeStart.isPaused || beforeStart.waitingForUser > 0
            ? beforeStart
            : await flowJobQueue.resume();
          break;
        }
        case "flow-queue:add-batch": {
          const source = Array.isArray(message.jobs) ? message.jobs : [];
          const metadata = { source: "extension", ...await captureFlowTargetMetadata() };
          addedJob = await flowJobQueue.addBatch(source.map(job => ({
            operation: job?.operation,
            payload: job?.payload,
            label: job?.label || job?.name,
            metadata: { ...metadata, ...(job?.metadata || {}) },
          })), {
            batchId: message.batchId,
            batchLabel: message.batchLabel,
          });
          const beforeStart = await flowJobQueue.snapshot();
          snapshot = message.autoStart === false || beforeStart.isPaused || beforeStart.waitingForUser > 0
            ? beforeStart
            : await flowJobQueue.resume();
          break;
        }
        case "flow-queue:pause":
          await flowJobQueue.pause();
          snapshot = await flowJobQueue.snapshot();
          break;
        case "flow-queue:resume":
          snapshot = await flowJobQueue.resume();
          break;
        case "flow-queue:manual-continue":
          snapshot = await flowJobQueue.continueManual(String(message.id || message.taskId || ""));
          if (!snapshot) throw Object.assign(new Error("This Flow job is not waiting for your manual submit."), { code: "FLOW_MANUAL_SUBMIT_NOT_WAITING" });
          break;
        case "flow-queue:cancel": {
          const id = String(message.id || message.taskId || "");
          const queuedJob = await flowJobQueue.get(id);
          const failedManual = await cancelManualWait(queuedJob);
          if (failedManual) { snapshot = failedManual; break; }
          const result = await flowJobQueue.cancel(id);
          if (!result) throw Object.assign(new Error(`No Flow job with id ${id}.`), { code: "FLOW_QUEUE_JOB_NOT_FOUND" });
          snapshot = queuedJob?.status === "waiting_for_user" ? await flowJobQueue.resume() : await flowJobQueue.snapshot();
          break;
        }
        case "flow-queue:stop":
          snapshot = await flowJobQueue.stop();
          break;
        case "flow-queue:clear":
          snapshot = await flowJobQueue.clear();
          break;
        case "flow-queue:remove":
          await flowJobQueue.remove(String(message.id || message.taskId || ""));
          snapshot = await flowJobQueue.snapshot();
          break;
        case "flow-queue:download": {
          const result = await enqueueGeneratedMediaDownload(String(message.id || message.taskId || ""));
          addedJob = result.job;
          snapshot = result.snapshot;
          break;
        }
        case "flow-queue:retry":
          snapshot = (await retryExtensionFlowJob(String(message.id || message.taskId || ""))).snapshot;
          break;
        case "flow-queue:retry-batch": {
          const result = await flowJobQueue.retryBatch(String(message.batchId || ""));
          const beforeStart = await flowJobQueue.snapshot();
          snapshot = !result.retried.length || beforeStart.isPaused || beforeStart.waitingForUser > 0
            ? beforeStart
            : await flowJobQueue.resume();
          return { ok: true, retried: result.retried, skipped: result.skipped, ...flowQueueSnapshot(snapshot) };
        }
        case "flow-queue:reorder": {
          const jobs = await flowJobQueue.list();
          const id = String(message.id || message.taskId || jobs[Number(message.fromIndex)]?.id || "");
          await flowJobQueue.reorder(id, Number(message.toIndex));
          snapshot = await flowJobQueue.snapshot();
          break;
        }
        default:
          throw Object.assign(new Error(`Unsupported Flow queue action: ${message.type}`), { code: "FLOW_QUEUE_ACTION_UNSUPPORTED" });
      }
      return { ok: true, ...(addedJob ? (Array.isArray(addedJob) ? { addedJobs: addedJob } : { job: addedJob }) : {}), ...flowQueueSnapshot(snapshot) };
    })().then(respond).catch(error => respond({
      ok: false,
      error: { code: error?.code || "FLOW_QUEUE_FAILED", message: String(error?.message || error) },
    }));
    return true;
  }
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

    if (String(requestId || "").startsWith("queue-") && flowUrl(_sender.tab?.url)) {
      const queueJobId = String(message.jobId ?? message.job_id ?? "").trim();
      if (queueJobId) {
        const progressMessage = String(message.progress || "Flow đang xử lý…");
        const progressPercent = progressMessage.match(/(?:^|\D)(\d{1,3})\s*%(?:\D|$)/)?.[1];
        void (async () => {
          if (message.generationObservation && typeof message.generationObservation === "object") {
            await flowJobQueue.checkpointGenerationObservation(queueJobId, message.generationObservation);
          }
          if (message.generationResult && Array.isArray(message.generationResult.media)) {
            await flowJobQueue.checkpointGenerationResult(queueJobId, message.generationResult.media);
          } else if (!message.generationObservation) {
            await flowJobQueue.updateProgress(queueJobId, {
              phase: "render",
              message: progressMessage,
              ...(progressPercent !== undefined ? { percent: Math.max(0, Math.min(100, Number(progressPercent))) } : {}),
            });
          }
          respond({ ok: true, local: true, checkpointed: Boolean(message.generationObservation || message.generationResult) });
        })().catch(error => respond({ ok: false, error: String(error?.message || error) }));
      }
      if (!queueJobId) respond({ ok: false, error: "FLOW_QUEUE_JOB_ID_MISSING" });
      return true;
    }

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
      const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const flowTabs = await chrome.tabs.query({ url: "https://flow.google.com/*" });
      const activeFlowTab = flowTabs.find(tab => activeTabs.some(active => active.id === tab.id));
      if (activeFlowTab) await adoptFlowTab(activeFlowTab, true);
      else await chooseTab();
      clearTimeout(reconnectTimer); reconnectTimer = undefined;
      stopHttpSession();
      bridgeTransport = "disconnected";
      const previousSocket = socket;
      socket = null;
      clearInterval(heartbeat);
      if (previousSocket) previousSocket.close(1000, "User reconnect");
      await connect();
      respond({ ok: true });
    })().catch(error => respond({ ok: false, error: String(error?.message || error) }));
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

