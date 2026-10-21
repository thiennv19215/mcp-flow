import { readFlowDownloadChunk } from "./flow-download-relay.js";
import { ensureCorrelationObserver } from "./flow-observer-health.js";
import { inspectExtensionBuild } from "./flow-build-info.js";
import { decideDevExtensionReload } from "./dev-extension-reload.js";
import { flowDocumentMatchesLocale, flowProjectUrl, forceEnglishFlowUrl } from "./flow-locale.js";
import { FlowJobQueue } from "./flow-job-queue.js";
import { planFlowAgentBatch, planFlowBatch, planFlowContinue, planFlowEdit } from "./flow-workflows.js";
import "../build-revision.js";

const LOCAL_BRIDGE = "http://127.0.0.1:18899";
const defaults = { bridge: LOCAL_BRIDGE };
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
  "flow.frame.extract_last",
  "flow.queue.add", "flow.queue.generate", "flow.queue.edit", "flow.queue.continue", "flow.queue.agent",
  "flow.queue.get", "flow.queue.wait", "flow.queue.cancel", "flow.queue.retry", "flow.queue.metadata",
]);
const extensionQueueOperations = new Set([
  "flow.queue.add", "flow.queue.generate", "flow.queue.edit", "flow.queue.continue", "flow.queue.agent",
  "flow.queue.get", "flow.queue.wait", "flow.queue.cancel", "flow.queue.retry", "flow.queue.metadata",
]);
const extensionQueueJobOperations = new Set([
  "flow.generation.submit", "flow.edit.run", "flow.continue.run", "flow.agent.batch",
  "flow.character.create", "flow.character.edit",
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
        "build-revision.js",
        "content/shared/i18n.js",
        "content/shared/dom-utils.js",
        "content/providers/flow/core/selectors.js",
        "content/shared/activity-overlay.js",
        "content/shared/native-file-transfer.js",
        "content/providers/base/base-provider-driver.js",
        "content/providers/base/provider-registry.js",
        "content/providers/flow/core/navigation.js",
        "content/providers/flow/composer/flow-editor.js",
        "content/providers/flow/core/settings.js",
        "content/providers/flow/generation/image-settings.js",
        "content/providers/flow/generation/video-settings.js",
        "content/providers/flow/composer/reference-actions.js",
        "content/providers/flow/composer/voice-actions.js",
        "content/providers/flow/media/uploader.js",
        "content/providers/flow/generation/native-frame-picker.js",
        "content/providers/flow/compatibility/flow-components.js",
        "content/providers/flow/characters/flow-characters.js",
        "content/providers/flow/generation/tiles.js",
        "content/providers/flow/media/media-menu.js",
        "content/providers/flow/agent/flow-agent.js",
        "content/providers/flow/composer/prompt-operations.js",
        "content/providers/flow/composer/reference-operations.js",
        "content/providers/flow/media/upload-operations.js",
        "content/providers/flow/generation/generation-operations.js",
        "content/providers/flow/library/library-operations.js",
        "content/providers/flow/workflows/workflow-operations.js",
        "content/providers/flow/core/flow-driver.js",
        "content/dom-actions.js",
        "content/floating-tracker-flow.js",
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
async function execute(_ws, method, args = [], { queueOwner = false, connectorOwner = false } = {}) {
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
        const snapshot = payload.autoStart === false ? await flowJobQueue.snapshot() : await flowJobQueue.resume();
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
        const result = await flowJobQueue.cancel(id);
        if (!result) throw Object.assign(new Error(`No Flow queue job with id ${id}.`), { code: "FLOW_QUEUE_JOB_NOT_FOUND", outcome_unknown: false });
        return result;
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
function flowQueueSnapshot(snapshot) {
  return { ...snapshot, items: snapshot.jobs, queue: snapshot.jobs };
}
async function retryExtensionFlowJob(id) {
  const previous = await flowJobQueue.get(id);
  const previousResult = previous?.result?.result || previous?.result || {};
  if (previousResult.downloadError || previous?.metadata?.downloadError) {
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
function broadcastFlowQueue(snapshot, reason) {
  chrome.runtime.sendMessage({ type: "flow-queue:changed", snapshot: flowQueueSnapshot(snapshot), reason }).catch(() => {});
}
function flowResultMedia(value) {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value.media)) return value.media;
  if (value.portraitMedia && typeof value.portraitMedia === "object") return [value.portraitMedia];
  if (value.result && typeof value.result === "object") return flowResultMedia(value.result);
  return [];
}
const flowDownloadTitleKey = value => String(value || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
async function waitForQueueFlowDownload(beforeIds, title, timeoutMs = 12 * 60_000) {
  if (!chrome.downloads?.search) throw Object.assign(new Error("Chrome download tracking is unavailable; the generated media remains in Flow."), {
    code: "FLOW_DOWNLOAD_TRACKING_UNAVAILABLE", outcomeUnknown: false, outcome_unknown: false,
  });
  const deadline = Date.now() + timeoutMs;
  const titleKey = flowDownloadTitleKey(title);
  let lastNew = [];
  while (Date.now() < deadline) {
    const items = await chrome.downloads.search({ orderBy: ["-startTime"], limit: 100 });
    const newItems = items.filter(item => !beforeIds.has(item.id) && (flowUrl(item.referrer) || flowUrl(item.url) || flowUrl(item.finalUrl)));
    lastNew = newItems;
    const matching = titleKey
      ? newItems.filter(item => flowDownloadTitleKey(item.filename?.split(/[\\/]/).pop()).includes(titleKey))
      : [];
    if (matching.length > 1 || (!matching.length && newItems.length > 1)) {
      throw Object.assign(new Error(`Chrome reported multiple possible Flow downloads for "${title}"; refusing to attach an ambiguous file to this queue job. The media remains in Flow.`), {
        code: "FLOW_DOWNLOAD_AMBIGUOUS", outcomeUnknown: false, outcome_unknown: false,
      });
    }
    const candidates = matching.length === 1 ? matching : newItems.length === 1 ? newItems : [];
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
async function downloadQueueMedia(media, outputDir, fileStem, quality, invoke, hooks, sceneNumbers = []) {
  if (!chrome.downloads?.search) throw Object.assign(new Error("Chrome download tracking is unavailable; the generated media remains in Flow."), {
    code: "FLOW_DOWNLOAD_TRACKING_UNAVAILABLE", outcomeUnknown: false, outcome_unknown: false,
  });
  const browserDownloads = [];
  try {
    for (const [index, item] of media.entries()) {
      const title = String(item?.title || item?.name || "").trim();
      if (!title) throw Object.assign(new Error("Flow generated media without a title, so its download could not be matched safely. The media remains in Flow."), {
        code: "FLOW_DOWNLOAD_ASSET_TITLE_MISSING", outcomeUnknown: false, outcome_unknown: false,
      });
      const before = await chrome.downloads.search({ orderBy: ["-startTime"], limit: 100 });
      const beforeIds = new Set(before.map(download => download.id));
      await hooks.progress({ phase: "download", message: `Downloading ${title} from Flow…`, percent: 90 + Math.floor(index * 9 / Math.max(1, media.length)) });
      let triggered;
      try {
        triggered = await invoke("flow.asset.download", { id: item.id, name: title, quality });
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
        download = await waitForQueueFlowDownload(beforeIds, title, quality === "upscaled" ? 12 * 60_000 : 3 * 60_000);
      } catch (cause) {
        throw Object.assign(new Error(String(cause?.message || cause)), {
          code: cause?.code || "FLOW_DOWNLOAD_FAILED", outcomeUnknown: false, outcome_unknown: false,
        });
      }
      const sceneNumber = Number(sceneNumbers[index]);
      const outputStem = Number.isSafeInteger(sceneNumber) && sceneNumber > 0
        ? `scene-${String(sceneNumber).padStart(2, "0")}`
        : media.length > 1 ? `${fileStem}-v${index + 1}` : fileStem;
      browserDownloads.push({
        ...download,
        title,
        fileStem: outputStem,
      });
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
  const fileStem = job.metadata?.file_stem || payload.file_stem || params.file_stem;
  const submitOnly = payload.submitOnly === true || payload.submit_only === true || params.submit_only === true;
  if (submitOnly || typeof outputDir !== "string" || !outputDir || typeof fileStem !== "string" || !fileStem) return operationResult;
  const media = flowResultMedia(operationResult);
  if (!media.length) return operationResult;
  try {
    const sceneNumbers = Array.isArray(operationResult?.sceneNumbers) && operationResult.sceneNumbers.length === media.length
      ? operationResult.sceneNumbers
      : [];
    const browserDownloads = await downloadQueueMedia(media, outputDir, fileStem, params.download_quality || payload.download_quality || "original", invoke, hooks, sceneNumbers);
    return { ...operationResult, browserDownloads };
  } catch (error) {
    return {
      ...operationResult,
      ...(Array.isArray(error?.browserDownloads) && error.browserDownloads.length ? { browserDownloads: error.browserDownloads } : {}),
      downloadError: String(error?.message || error),
      downloadErrorCode: String(error?.code || "FLOW_DOWNLOAD_FAILED"),
    };
  }
}
async function runExtensionFlowJob(job, hooks) {
  const operation = job.operation || job.data?.operation;
  const payload = structuredClone(job.payload || job.data?.payload || {});
  const queuedOperations = new Set([
    ...extensionQueueJobOperations,
  ]);
  if (!queuedOperations.has(operation)) {
    throw Object.assign(new Error(`Unsupported extension queue operation: ${String(operation || "(missing)")}`), {
      code: "FLOW_QUEUE_OPERATION_UNSUPPORTED",
      outcome_unknown: false,
    });
  }
  const invoke = (name, body) => execute(null, "flow.dom.execute", [{
    op: "flowOperation",
    name,
    payload: body,
    id: `queue-${job.id}-${crypto.randomUUID()}`,
  }], { queueOwner: true });
  while (selectedTabId !== undefined && tabOperationActive(selectedTabId)) {
    if (hooks.signal.aborted) throw Object.assign(new Error("Queue stopped before Flow accepted this task."), { outcomeUnknown: false });
    await hooks.progress({ phase: "waiting", message: "Waiting for the active Flow operation to finish…" });
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  if (hooks.signal.aborted) throw Object.assign(new Error("Queue stopped before Flow accepted this task."), { outcomeUnknown: false });
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
  await hooks.progress({ phase: "submit", message: "Submitting to Google Flow…", percent: 5 });
  if (operation !== "flow.generation.submit") {
    try {
      const rawResult = await invoke(operation, payload);
      const result = await withQueueDownloads(job, payload, rawResult, invoke, hooks);
      await hooks.progress({ phase: "complete", message: "Flow operation completed.", percent: 100 });
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
    submitted = await invoke(operation, payload);
  } catch (error) {
    throw Object.assign(error, {
      outcomeUnknown: Boolean(error?.outcomeUnknown || error?.outcome_unknown),
      requestDispatched: Boolean(error?.requestDispatched),
    });
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
      throw Object.assign(new Error("Flow accepted the video request, but did not return a verifiable credit quote. Inspect Flow before retrying."), {
        code: "FLOW_SUBMIT_RECEIPT_INCOMPLETE", outcomeUnknown: true, outcome_unknown: true, requestDispatched: true, creditQuoteVerified: false,
      });
    }
    const maxCredits = payload.maxCredits ?? params.max_credits;
    if (Number.isFinite(Number(maxCredits)) && rawCredits > Number(maxCredits)) {
      throw Object.assign(new Error(`Flow dispatched a request quoted at ${rawCredits} credits, above max_credits=${maxCredits}; inspect Flow before retrying.`), {
        code: "FLOW_MAX_CREDITS_EXCEEDED", outcomeUnknown: true, outcome_unknown: true, requestDispatched: true, credits: rawCredits, creditQuoteVerified: true,
      });
    }
    quoteFields = { credits: rawCredits, creditQuoteVerified: true };
  }
  if (payload.submitOnly === true || payload.submit_only === true || params.submit_only === true) {
    await hooks.progress({ phase: "submitted", message: "Flow accepted the request; rendering was not awaited.", percent: 100 });
    return { completed: true, requestDispatched: true, ...quoteFields, result: { ...submitted, ...quoteFields } };
  }
  const count = Math.max(1, Number(payload.variants ?? payload.count ?? submitted?.expectedCount ?? 1));
  await hooks.progress({ phase: "render", message: "Submitted; waiting for Flow to finish rendering…", percent: 10 });
  let observed;
  try {
    observed = await invoke("flow.generation.observe", {
      before: submitted?.before || [],
      expectedCount: count,
      variants: count,
      correlationAttemptId: submitted?.correlationAttemptId,
      kind: payload.type || "image",
      retries: payload.retries,
      timeoutMs: payload.type === "video" ? 600_000 : 300_000,
    });
  } catch (error) {
    throw Object.assign(error, {
      outcomeUnknown: true,
      requestDispatched: true,
      code: error?.code || "FLOW_RENDER_OUTCOME_UNKNOWN",
    });
  }
  const operationResult = await withQueueDownloads(job, payload, { ...observed, ...quoteFields }, invoke, hooks);
  await hooks.progress({ phase: "complete", message: "Flow generation completed.", percent: 100 });
  return { completed: true, requestDispatched: true, ...quoteFields, result: operationResult };
}
const flowJobQueue = new FlowJobQueue(runExtensionFlowJob);
flowJobQueue.subscribe((snapshot, reason) => broadcastFlowQueue(snapshot, reason));
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
  if (typeof message?.type === "string" && message.type.startsWith("flow-queue:")) {
    if (_sender?.id !== chrome.runtime.id || _sender?.tab) {
      respond({ ok: false, error: { code: "FLOW_QUEUE_FORBIDDEN", message: "Flow queue controls are available only from the extension UI." } });
      return;
    }
    void (async () => {
      await flowJobQueue.ready;
      let snapshot;
      switch (message.type) {
        case "flow-queue:get":
          snapshot = await flowJobQueue.snapshot();
          break;
        case "flow-queue:add": {
          const source = message.job || {};
          await flowJobQueue.add({
            operation: source.operation,
            payload: source.payload,
            label: source.label || source.name,
          });
          snapshot = await flowJobQueue.snapshot();
          break;
        }
        case "flow-queue:pause":
          await flowJobQueue.pause();
          snapshot = await flowJobQueue.snapshot();
          break;
        case "flow-queue:resume":
          snapshot = await flowJobQueue.resume();
          break;
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
        case "flow-queue:retry":
          snapshot = (await retryExtensionFlowJob(String(message.id || message.taskId || ""))).snapshot;
          break;
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
      return { ok: true, ...flowQueueSnapshot(snapshot) };
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

    if (String(requestId || "").startsWith("queue-") && flowUrl(_sender.tab?.url) && _sender.tab?.id === selectedTabId) {
      respond({ ok: true, local: true });
      return;
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

