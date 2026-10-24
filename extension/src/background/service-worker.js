import { readFlowDownloadChunk } from "./flow-download-relay.js";
import { ensureCorrelationObserver } from "./flow-observer-health.js";
import { inspectExtensionBuild } from "./flow-build-info.js";
import { decideDevExtensionReload } from "./dev-extension-reload.js";
import { flowDocumentMatchesLocale, flowHomeUrl, flowLocaleFromUrl, flowProjectUrl, normalizeFlowLocale } from "./flow-locale.js";
import { FlowJobQueue } from "./flow-job-queue.js";
import { resolveProviderForOperation } from "./provider-router.js";
import { runChatGptQueueJob } from "./chatgpt-queue-runner.js";
import { loadChatGptCapabilityRegistry } from "./chatgpt-capabilities.js";
import { FlowBatchDrafts, materializeDraftJobs } from "./flow-batch-drafts.js";
import { FlowHistory, buildJobFromRecord } from "./flow-history.js";
import { FlowBatchRuns } from "./flow-batch-runs.js";
import { FlowWorkflowGraphRuns } from "./flow-workflow-graph.js";
import { FlowExecutionLock } from "./flow-execution-lock.js";
import { FlowTaskLists, expandTasksToJobs, requiresSequential } from "./flow-task-lists.js";
import { FlowAlbums } from "./flow-albums.js";
import { FlowWorkflowTemplates } from "./flow-workflow-templates.js";
import { FlowGenTemplates } from "./flow-gen-templates.js";
import { buildAssistantRequest, parseAssistantReply, parseImageToPromptReply } from "./flow-prompt-assistant.js";
import { FlowMediaCatalog } from "./flow-media-catalog.js";
import { revalidateJobReferences } from "./flow-ref-preflight.js";
import { FlowBridgeClient, readBridgeConfig, postHttpMessage } from "./flow-bridge-client.js";
import { planFlowAgentBatch, planFlowBatch, planFlowContinue, planFlowEdit } from "./flow-workflows.js";
import {
  initQueueDownloadListeners,
  withQueueDownloads,
  downloadGeneratedQueueJob,
  queueCompletionProgress,
  flowResultMedia,
} from "./flow-queue-downloads.js";
import "../build-revision.js";

initQueueDownloadListeners();

const LOCAL_BRIDGE = "http://127.0.0.1:18899";
const defaults = { bridge: LOCAL_BRIDGE };
const isFlowMediaHost = hostname => {
  const host = String(hostname || "").toLowerCase();
  return host === "flow.google.com" || host.endsWith(".flow.google.com") ||
    host === "labs.google" || host.endsWith(".labs.google") ||
    host === "storage.googleapis.com" || host.endsWith(".storage.googleapis.com") ||
    host === "googleusercontent.com" || host.endsWith(".googleusercontent.com") ||
    host === "googleapis.com" || host.endsWith(".googleapis.com") ||
    host === "usercontent.goog" || host.endsWith(".usercontent.goog");
};
const flowUrl = url => {
  try {
    const raw = String(url || "");
    if (!raw) return false;
    if (raw.startsWith("blob:")) return raw.includes("flow.google.com") || raw.includes("labs.google");
    return isFlowMediaHost(new URL(raw).hostname);
  } catch { return false; }
};
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
  "flow.queue.manual.continue", "flow.queue.workflow",
]);
const extensionQueueOperations = new Set([
  "flow.queue.add", "flow.queue.generate", "flow.queue.edit", "flow.queue.continue", "flow.queue.agent",
  "flow.queue.get", "flow.queue.wait", "flow.queue.cancel", "flow.queue.retry", "flow.queue.metadata", "flow.queue.manual.continue",
  "flow.queue.workflow",
]);
const extensionQueueJobOperations = new Set([
  "flow.generation.submit", "flow.edit.run", "flow.continue.run", "flow.agent.batch",
  "flow.character.create", "flow.character.edit",
]);
const GENERATED_MEDIA_DOWNLOAD_OPERATION = "flow.queue.download-generated";
const queueDownloadEnqueues = new Map();
let socket = null;
let httpSession = null;
let selectedTabId;
let lastError = "";
let progressReceiptSequence = 0;
let uiDispatchSequence = 0;
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
const config = readBridgeConfig;

function bridgeConnected() { return bridgeClient.isConnected(); }
function event(method, params) { return bridgeClient.sendEvent(method, params); }
function connect() { return bridgeClient.connect(); }

const bridgeClient = new FlowBridgeClient({
  onCommand: command => new Promise((resolve, reject) => {
    dispatchCommand(command, res => {
      if (res?.result?.ok) resolve(res.result.value);
      else reject(res?.result?.error || new Error("Command failed"));
    });
  }),
  getSelectedTabId: () => selectedTabId,
  getCapabilities: () => [...nativeFlowOperations].map(name => `flow.native.${name.slice(5)}`),
});
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
        // Build every job input before enqueueing anything. Ids are minted
        // up front (same rule the queue applies: caller id wins) so workflow
        // dependency metadata can point at the previous job's id before the
        // batch is admitted.
        const jobIds = plannedJobs.map(source => source.id || crypto.randomUUID());
        const jobInputs = plannedJobs.map((source, index) => {
          const operation = String(source.operation || source.data?.operation || "flow.generation.submit");
          if (!extensionQueueJobOperations.has(operation)) throw Object.assign(new Error(`Unsupported queued Flow operation: ${operation}`), {
            code: "FLOW_QUEUE_OPERATION_UNSUPPORTED", retryable: false, outcome_unknown: false,
          });
          const jobPayload = source.payload ?? source.data?.payload;
          const workflow = jobPayload?.workflow || jobPayload?.params?.workflow || source.workflow || {};
          const previousId = index > 0 ? jobIds[index - 1] : undefined;
          const metadata = {
            source: 'mcp',
            ...(source.metadata ?? source.data?.metadata ?? {}),
            ...(source.metadata?.flowTabId === undefined && source.data?.metadata?.flowTabId === undefined ? defaultFlowTarget : {}),
            batchId,
            ...(workflow && Object.keys(workflow).length ? { workflow } : {}),
            ...(previousId && workflow.dependency ? { dependsOnId: previousId, dependencyType: workflow.dependency.type } : {}),
            ...(typeof jobPayload?.output_dir === "string" ? { output_dir: jobPayload.output_dir } : {}),
            ...(typeof jobPayload?.file_stem === "string" ? { file_stem: jobPayload.file_stem } : {}),
            ...(typeof jobPayload?.params?.output_dir === "string" ? { output_dir: jobPayload.params.output_dir } : {}),
            ...(typeof jobPayload?.params?.file_stem === "string" ? { file_stem: jobPayload.params.file_stem } : {}),
          };
          return {
            id: jobIds[index], operation, payload: jobPayload,
            label: source.label || source.name, metadata,
          };
        });
        // Admit the submission atomically: a multi-job batch goes through
        // addBatch, which validates ids and preflights every job before any
        // of them enters the queue. Enqueueing one-by-one here would leave
        // earlier jobs queued (and spending credits) when a later job fails,
        // even though the caller is told the whole submission failed.
        const added = jobInputs.length === 0
          ? []
          : jobInputs.length === 1
            ? [await flowJobQueue.add(jobInputs[0])]
            : await flowJobQueue.addBatch(jobInputs, { batchId });
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
      // FEAT-07: run a node-graph workflow on the queue. The graph is
      // validated and compiled by the run store; the first runnable
      // level is enqueued now and later levels follow from the queue
      // snapshot fold in the subscribe callback.
      if (command.name === "flow.queue.workflow") {
        if (!payload.graph || typeof payload.graph !== "object") {
          throw Object.assign(new Error("flow.queue.workflow requires a graph document."), { code: "FLOW_QUEUE_INVALID", outcome_unknown: false });
        }
        const { run, toEnqueue } = await flowWorkflowGraphRuns.create({
          graph: payload.graph,
          project: payload.project,
          outputDir: payload.output_dir || payload.project,
        });
        const { added, snapshot } = await enqueueWorkflowGraphJobs(toEnqueue, { target: queueTargetMetadata(command) });
        if (payload.autoStart !== false && snapshot.status !== "paused" && snapshot.status !== "waiting_for_user") {
          await flowJobQueue.resume();
        }
        return { run, jobs: added, snapshot: flowQueueSnapshot(snapshot) };
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

// GPT-10: transport for provider content commands that cannot ride the
// Flow-only execute() path (its tab validation is Flow-URL based). Sends
// the same flow-mcp:execute envelope execute() builds, unwraps the
// content response with the same error rehydration, and mirrors
// execute()'s cancellation + delivery discipline for the one
// maybe-submitted provider operation (chatgpt.generation.submit): an
// abort or an ambiguous transport failure may have sent the message, so
// it is reported outcome_unknown; a definitely undelivered command is
// not.
async function sendProviderCommand(tabId, command, signal) {
  const maybeSubmitted = command?.name === "chatgpt.generation.submit";
  const cancelPageCommand = () => {
    void chrome.tabs.sendMessage(tabId, { type: "flow-mcp:cancel", requestId: command?.id }).catch(() => {});
  };
  const cancelledError = () => Object.assign(new Error("Provider command was cancelled by the queue."), {
    code: "FLOW_OPERATION_CANCELLED",
    outcome_unknown: maybeSubmitted,
  });
  if (signal?.aborted) {
    cancelPageCommand();
    throw cancelledError();
  }
  let rejectCancelled;
  const cancelledPromise = new Promise((_, reject) => { rejectCancelled = reject; });
  void cancelledPromise.catch(() => {});
  const onAbort = () => {
    cancelPageCommand();
    rejectCancelled(cancelledError());
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  let response;
  try {
    response = await Promise.race([
      sendFlowCommand(tabId, { type: "flow-mcp:execute", command }),
      cancelledPromise,
    ]);
  } catch (error) {
    const message = String(error?.message || error);
    const definitelyNotDelivered = /Receiving end does not exist|Could not establish connection/i.test(message);
    const explicitlySafe = error?.outcome_unknown === false || error?.outcomeUnknown === false;
    if (maybeSubmitted && !definitelyNotDelivered && !explicitlySafe) {
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
    signal?.removeEventListener("abort", onAbort);
  }
  if (!response?.ok) {
    const error = new Error(response?.error?.message || response?.error || "Provider DOM command failed");
    error.code = response?.error?.code || "FLOW_DOM_FAILED";
    error.retryable = Boolean(response?.error?.retryable);
    error.outcome_unknown = Boolean(response?.error?.outcome_unknown);
    error.noRetry = response?.error?.noRetry === true;
    error.noReplay = response?.error?.noReplay === true;
    // Preserve page-side diagnostics through the extension relay.
    if (response?.error?.diagnostics && typeof response.error.diagnostics === "object") {
      error.diagnostics = response.error.diagnostics;
    }
    throw error;
  }
  return response.value;
}

// GPT-10: production dependencies for the ChatGPT queue runner branch —
// real chrome.tabs find-or-create driven by the GPT-08 descriptor, the
// queue's own metadata store for pins, and the provider command
// transport above.
function chatGptQueueRunnerDeps() {
  return {
    tabs: {
      query: async patterns => {
        const groups = await Promise.all(patterns.map(url => chrome.tabs.query({ url })));
        const byId = new Map();
        for (const tab of groups.flat()) if (Number.isInteger(tab?.id)) byId.set(tab.id, tab);
        return [...byId.values()];
      },
      get: tabId => chrome.tabs.get(tabId).catch(() => null),
      create: url => chrome.tabs.create({ url }),
    },
    waitForTabComplete: tabId => waitForTabComplete(tabId, 30_000).catch(() => {}),
    sendCommand: (tabId, command, signal) => sendProviderCommand(tabId, command, signal),
    updateMetadata: (jobId, patch) => flowJobQueue.updateMetadata(jobId, patch),
  };
}

async function runExtensionFlowJob(job, hooks) {
  const operation = job.operation || job.data?.operation;
  // Provider dispatch (GPT-08): resolve the operation's provider
  // descriptor up front. Unknown prefixes throw the same typed
  // unsupported-operation error the allowlist check below has always
  // thrown, so this only routes — the per-provider runner branches
  // (GPT-10) hang off the descriptor, and Flow jobs flow through the
  // unchanged path below.
  const descriptor = resolveProviderForOperation(operation);
  if (descriptor.key === "chatgpt") {
    // GPT-10: ChatGPT jobs run through the provider runner branch
    // (chatgpt-queue-runner.js); the Flow path below is unchanged.
    return runChatGptQueueJob(job, hooks, chatGptQueueRunnerDeps());
  }
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
    return downloadGeneratedQueueJob(job, payload, invoke, hooks, flowJobQueue);
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
        // SW-FWD (VID-02): carry the restored checkpoint's dispatch stamp
        // through the rebuilt receipt so it can reach the observe payload
        // below; without it a resumed observe gets a fresh render window
        // instead of the time remaining from the original dispatch.
        ...(savedObservation.dispatchedAt ? { dispatchedAt: savedObservation.dispatchedAt } : {}),
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
    ...(submitted?.dispatchedAt ? { dispatchedAt: submitted.dispatchedAt } : {}),
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
      // SW-FWD (VID-02): forward the dispatch stamp so observe anchors
      // its deadline at dispatch. Absent on legacy paths, where this
      // payload stays exactly as it was before.
      ...(observation.dispatchedAt ? { dispatchedAt: observation.dispatchedAt } : {}),
    });
  } catch (error) {
    throw Object.assign(error, {
      outcomeUnknown: true,
      requestDispatched: true,
      code: error?.code || "FLOW_RENDER_OUTCOME_UNKNOWN",
    });
  }
  if (Array.isArray(observed?.media) && observed.media.length) {
    // SW-FWD (VID-01): forward a partial result's failed outputs into the
    // checkpoint as the extras argument, passed through exactly as observe
    // produced them (the queue checkpoint owns normalization), so a worker
    // death after observe loses neither half of the outcome. Results
    // without failed outputs pass no extras argument, exactly as before.
    await flowJobQueue.checkpointGenerationResult(job.id, observed.media, ...(Array.isArray(observed.failedOutputs) && observed.failedOutputs.length ? [{ failedOutputs: observed.failedOutputs }] : [])).catch(error => {
      console.warn("[FlowQueue] Could not persist the worker-side generation result checkpoint:", error?.message || error);
    });
  }
  const operationResult = await withQueueDownloads(job, payload, { ...observed, ...quoteFields }, invoke, hooks);
  await hooks.progress(queueCompletionProgress(operationResult, "Flow generation completed."));
  return { completed: true, requestDispatched: true, ...quoteFields, result: operationResult };
}
const flowMediaCatalog = new FlowMediaCatalog();
// IMG-04: resolve the project a queued job targets, read-only, mirroring
// where the runner pins it: the job metadata first (captured at enqueue
// time or pinned by a previous attempt), then the pinned or selected Flow
// tab's URL. Deliberately no chooseTab() here — choosing a tab prepares
// and may adopt it, a side effect a drain-time lookup must not have; with
// no resolvable target the catalog leg simply abstains.
async function queueJobProjectId(job) {
  const metadata = job && typeof job.metadata === "object" && job.metadata ? job.metadata : {};
  if (typeof metadata.flowProjectId === "string" && metadata.flowProjectId) return metadata.flowProjectId.toLowerCase();
  const tabId = Number.isInteger(metadata.flowTabId) ? metadata.flowTabId : selectedTabId;
  if (!Number.isInteger(tabId)) return null;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return tab && flowUrl(tab.url) ? flowProjectIdFromUrl(tab.url) : null;
}
// IMG-04: the queue-level reference revalidation pass, wired with the
// dependencies the worker can supply faithfully. The worker owns the
// IMG-03 media catalog, so the catalog leg resolves here directly — same
// query shape as the content-stage pass (project, expected id, name).
// The other two legs cannot be supplied faithfully at drain time:
// - Existence: the only page scan reachable from the worker
//   (flow.assets.list) actively scrolls the media grid of whichever
//   project the tab currently shows for up to 25 s, and the queue drains
//   before the runner pins and navigates the tab to this job's project —
//   a negative could condemn an asset that exists in the target project,
//   and for an uploaded ref the failure would be unrecoverable at this
//   level. Follow the content pass's own degrade discipline instead: an
//   absence that cannot be proven is not an absence, so this leg reports
//   "exists" and the content-stage pass re-checks against the live grid
//   on the right project before any settings/prompt work.
// - Re-upload: no content operation re-uploads retained staged bytes by
//   catalog identity — flow.media.upload requires the original transfer
//   id and the exact staged file name, and a queued library ref carries
//   neither. The by-name retained-bytes recovery exists only inside the
//   submit path, so recovery stays with the content-stage pass and this
//   leg reports "bytes not retained".
function createQueueRefPreflight(environment) {
  const catalog = environment && environment.catalog ? environment.catalog : null;
  const projectIdForJob = environment && typeof environment.projectIdForJob === "function" ? environment.projectIdForJob : async () => null;
  return job => revalidateJobReferences(job, {
    catalogLookup: async ref => {
      if (!catalog) return null;
      const projectId = await projectIdForJob(job);
      if (!projectId) return null;
      return catalog.lookup({
        projectId,
        ...(ref.expectedId ? { mediaId: ref.expectedId } : {}),
        name: ref.assetName,
      });
    },
    assetExists: async () => true,
    reupload: async () => null,
  });
}
// FEAT-11b: production wiring for the FEAT-11 cross-engine execution
// lock. The worker owns ONE gate over ONE FlowExecutionLock; transform
// jobs are identified solely by the metadata.transform stamp that
// buildTransformJob (content/shared/flow-transforms.js) already writes,
// so ordinary queue jobs are never affected. The gate is deliberately
// self-contained so tests can extract and exercise it against the real
// lock:
//   - admissionRefusal(jobs): the UI add paths consult it BEFORE
//     enqueueing; while one family holds the lock, a submission
//     carrying another family's transform is refused with a typed
//     payload (owner + canStopCurrent) instead of being queued to run
//     over it. Same-family and non-transform submissions always pass.
//   - observeSnapshot(snapshot): folds queue snapshots into the lock —
//     a family acquires when its first transform job is seen running
//     and releases when its last running transform job leaves the
//     running state (any terminal status). A cross-family overlap that
//     somehow happens anyway (jobs queued before the holder started,
//     worker-restart recovery) is NOT seized: it is surfaced as a
//     conflict in status() and the waiting family acquires on the
//     first snapshot after the holder releases.
//   - requestStop / stopRequestFor: a blocked engine records a stop
//     request on the lock; the snapshot fold surfaces it on the
//     running job's durable record at the queue's own generation
//     checkpoints (see the subscribe callback) — the request is
//     observed, never enforced by seizing the job.
function createTransformExecutionGate(lock) {
  let runningFamilies = new Set();
  let conflict = null;

  function familyOf(job) {
    const transform = job?.metadata?.transform;
    if (!transform || typeof transform !== "object") return null;
    const family = typeof transform.family === "string" ? transform.family.trim().toLowerCase() : "";
    return family || null;
  }

  function admissionRefusal(jobs) {
    const current = lock.current();
    if (!current) return null;
    const foreign = (Array.isArray(jobs) ? jobs : []).some(job => {
      const family = familyOf(job);
      return family !== null && family !== current.owner;
    });
    if (!foreign) return null;
    return {
      code: "FLOW_TRANSFORM_EXECUTION_LOCKED",
      message: `A ${current.owner} transform is still running; a different transform family cannot start over it. Wait for it to finish or ask it to stop.`,
      owner: current.owner,
      since: current.since,
      canStopCurrent: true,
    };
  }

  function observeSnapshot(snapshot) {
    const runningNow = new Set();
    for (const job of snapshot?.jobs || []) {
      if (job?.status !== "running") continue;
      const family = familyOf(job);
      if (family) runningNow.add(family);
    }
    // Release first: a family whose last running transform job left
    // frees the lock inside this same fold, so a waiting family that
    // is already running (the conflict case) acquires immediately
    // below instead of one snapshot later.
    for (const family of runningFamilies) {
      if (!runningNow.has(family) && lock.isHeldBy(family)) lock.release(family);
    }
    conflict = null;
    for (const family of runningNow) {
      const result = lock.acquire(family);
      if (!result.ok) conflict = { family, owner: result.owner, since: result.since, canStopCurrent: true };
    }
    runningFamilies = runningNow;
  }

  function requestStop(requestedBy) {
    return lock.requestStop(typeof requestedBy === "string" ? requestedBy.trim().toLowerCase() : "");
  }

  function stopRequestFor(family) {
    return family && lock.isHeldBy(family) ? lock.stopRequested() : null;
  }

  function status() {
    const current = lock.current();
    return {
      held: Boolean(current),
      owner: current?.owner ?? null,
      since: current?.since ?? null,
      stopRequested: lock.stopRequested(),
      conflict,
      runningFamilies: [...runningFamilies],
    };
  }

  return { familyOf, admissionRefusal, observeSnapshot, requestStop, stopRequestFor, status };
}
// Keep a small cooldown between generations to avoid hammering Flow while
// removing most of the previous 5–10 second idle wait between queued jobs.
const flowJobQueue = new FlowJobQueue(runExtensionFlowJob, {
  minDelayMs: 1_000,
  maxDelayMs: 2_000,
  // Admission preflight reads the same capability registry the sidebar and
  // content scripts validate against, so a batch is checked as a whole
  // before its first job can spend credits.
  loadCapabilityRegistry: async () => {
    try {
      const response = await fetch(chrome.runtime.getURL("flow-model-capabilities.json"));
      return response.ok ? await response.json() : null;
    } catch {
      return null;
    }
  },
  // GPT-09/GPT-10: ChatGPT admission preflight reads the packaged
  // ChatGPT capability registry. The shared loader never throws — a null
  // registry skips validation, mirroring the Flow loader's discipline.
  loadChatGptCapabilityRegistry: () => loadChatGptCapabilityRegistry(),
  // IMG-04: revalidate generation references at job start against the
  // worker's media catalog (see createQueueRefPreflight for exactly which
  // legs are live at this level and which stay with the content stage).
  refPreflight: createQueueRefPreflight({ catalog: flowMediaCatalog, projectIdForJob: queueJobProjectId }),
});
// FEAT-07: enqueue one workflow graph handout (a level's worth of
// compiled jobs, or a single node) and bind the minted runtime ids back
// into the run record. Ids are minted up front, same as the generate
// bridge path, so the admission mapping is exact. A failed enqueue
// releases the handout so the next fold retries instead of wedging.
async function enqueueWorkflowGraphJobs(entries, { target = {} } = {}) {
  const list = Array.isArray(entries) ? entries.filter(entry => entry?.job) : [];
  if (!list.length) return { added: [], snapshot: flowJobQueue.getSnapshot() };
  const runId = list[0].job.metadata?.workflowGraphRunId || null;
  const jobs = list.map(entry => ({
    id: crypto.randomUUID(),
    operation: entry.job.operation,
    label: entry.job.label,
    payload: entry.job.payload,
    metadata: {
      source: "extension",
      ...target,
      ...(entry.job.metadata || {}),
    },
  }));
  try {
    const added = jobs.length === 1
      ? [await flowJobQueue.add(jobs[0])]
      : await flowJobQueue.addBatch(jobs, { batchId: runId });
    if (runId) {
      await flowWorkflowGraphRuns.recordAdmission(runId, {
        batchId: runId,
        mapping: jobs.map((job, index) => ({ nodeId: list[index].nodeId, jobId: job.id })),
      });
    }
    return { added, snapshot: flowJobQueue.getSnapshot() };
  } catch (error) {
    if (runId) await flowWorkflowGraphRuns.releaseEnqueue(runId, list.map(entry => entry.nodeId)).catch(() => {});
    throw error;
  }
}

const flowBatchDrafts = new FlowBatchDrafts();
const flowHistory = new FlowHistory();
const flowBatchRuns = new FlowBatchRuns();
const flowWorkflowGraphRuns = new FlowWorkflowGraphRuns();
const flowTransformGate = createTransformExecutionGate(new FlowExecutionLock());
const flowTaskLists = new FlowTaskLists();
const flowAlbums = new FlowAlbums();
const flowWorkflowTemplates = new FlowWorkflowTemplates();
const flowGenTemplates = new FlowGenTemplates();
flowJobQueue.subscribe((snapshot, reason) => {
  broadcastFlowQueue(snapshot, reason);
  // FEAT-01: every finished generation lands in the structured history
  // store. Recording is deduped per finished attempt inside the store
  // and must never disturb the queue path, so failures stay silent here.
  void flowHistory.observeSnapshot(snapshot).catch(error => {
    console.warn("[FlowHistory] Could not record finished queue jobs:", error?.message || error);
  });
  // FEAT-02: the same snapshots fold into the active batch run's
  // receipts, so a run record always reflects what the queue actually
  // did. Folding is serialized inside the store and, like history
  // recording, must never disturb the queue path.
  void flowBatchRuns.observeSnapshot(snapshot).catch(error => {
    console.warn("[FlowBatchRuns] Could not fold the queue snapshot into the active run:", error?.message || error);
  });
  // FEAT-07: the same snapshots fold into active workflow graph runs;
  // each fold may release the next level's jobs, which are enqueued
  // right away. Enqueueing re-emits a snapshot, and the run store's
  // handout flag flips synchronously inside the fold, so this cannot
  // double-enqueue or loop.
  void flowWorkflowGraphRuns.observeSnapshot(snapshot).then(results => {
    for (const result of results) {
      if (result.finalizeState) console.info(`[FlowWorkflowGraph] Run ${result.run.id} finalized as ${result.finalizeState}`);
      if (!result.toEnqueue?.length) continue;
      void enqueueWorkflowGraphJobs(result.toEnqueue, {}).then(({ snapshot: next }) => {
        if (snapshot.status !== "paused" && snapshot.status !== "waiting_for_user" && next.status !== "running" && !next.paused) flowJobQueue.resume();
      }).catch(error => console.warn("[FlowWorkflowGraph] Could not enqueue the next workflow level:", error?.message || error));
    }
  }).catch(error => {
    console.warn("[FlowWorkflowGraph] Could not fold the queue snapshot into workflow runs:", error?.message || error);
  });
  // FEAT-11b: the same snapshots drive the transform execution lock —
  // a family acquires when its first transform job starts running and
  // releases when its last one ends. Pure in-memory bookkeeping; a
  // failure here must never disturb the queue path either.
  try {
    flowTransformGate.observeSnapshot(snapshot);
  } catch (error) {
    console.warn("[FlowTransformLock] Could not fold the queue snapshot into the execution lock:", error?.message || error);
  }
  // FEAT-11b: at the queue's own generation checkpoints, surface a
  // pending stop request on the running transform job's durable
  // record, where the lock owner sees it next to the job itself. The
  // stamp is bookkeeping only — nothing here cancels or seizes the
  // job; honoring the request stays the owner's decision (let it
  // finish, or cancel through the regular queue path, whose terminal
  // snapshot then releases the lock). The stamp is idempotent per
  // request, and stamping re-emits as "metadata-updated", which is
  // not a checkpoint reason, so this cannot loop.
  if (reason === "generation-observation-checkpoint" || reason === "generation-result-checkpoint") {
    for (const job of snapshot.jobs || []) {
      if (job?.status !== "running") continue;
      const stop = flowTransformGate.stopRequestFor(flowTransformGate.familyOf(job));
      if (!stop) continue;
      const stamped = job.metadata?.transformStopRequested;
      if (stamped?.requestedBy === stop.requestedBy && stamped?.at === stop.at) continue;
      void flowJobQueue.updateMetadata(job.id, { transformStopRequested: stop }).catch(error => {
        console.warn("[FlowTransformLock] Could not stamp the stop request on the running job:", error?.message || error);
      });
    }
  }
  // FEAT-05: the same snapshots write task-run results back onto the
  // saved tasks that produced them, through the same FEAT-02 fold.
  void flowTaskLists.observeSnapshot(snapshot).catch(error => {
    console.warn("[FlowTaskLists] Could not write task results back from the queue snapshot:", error?.message || error);
  });
  // FEAT-12b: regen receipts fold into the batch runs that already
  // finalized (a regeneration is enqueued after its run closed, so the
  // FEAT-02 fold above never sees its receipt land). Serialized inside
  // the store behind the active-run fold; failures stay silent here
  // for the same reason as the other folds.
  void flowBatchRuns.foldRegenReceipts(snapshot).catch(error => {
    console.warn("[FlowBatchRuns] Could not fold regen receipts into finalized runs:", error?.message || error);
  });
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
// FEAT-02: turn an enqueued draft run into a persistent batch run
// record — create the record from the exact job inputs that were
// enqueued, claim it, and write the index-aligned admission mapping
// from the jobs the queue actually accepted. Callers treat failures as
// bookkeeping failures: when the claim conflicts (another batch is
// still active) the created record is removed again, so an untracked
// run never leaves an orphan record behind.
async function trackDraftRun(draft, jobs, addedJobs, batchId) {
  const run = await flowBatchRuns.create({ draftId: draft.id, label: draft.label, items: jobs });
  try {
    const claim = await flowBatchRuns.claim(run.id, run.revision);
    const mapping = addedJobs.map((job, position) => ({ index: claim.indexes[position], jobId: job.id }));
    return await flowBatchRuns.recordAdmission(run.id, { batchId: batchId || null, kind: "initial", mapping });
  } catch (error) {
    await flowBatchRuns.remove(run.id).catch(() => {});
    throw error;
  }
}
void flowJobQueue.ready.then(() => flowJobQueue.resumeRecovered()).catch(error => {
  console.error("[FlowQueue] Could not resume a checkpointed job after worker restart:", error?.message || error);
});
function dispatchCommand(command, sendResult) {
  const commandId = command.id ?? command.request_id ?? command.requestId;
  if (commandId === undefined || commandId === null) throw new Error("Command is missing request id");
  // Keep the receive loop responsive while a page operation waits.
  void execute(null, command.method, command.args, { connectorOwner: true }).then(
    value => sendResult({ type: "result", id: commandId, result: { ok: true, value } }),
    error => sendResult({ type: "result", id: commandId, result: { ok: false, error: { code: error?.code || "EXTENSION_COMMAND_FAILED", message: String(error?.message || error), retryable: Boolean(error?.retryable), outcome_unknown: Boolean(error?.outcome_unknown), noRetry: error?.noRetry === true, noReplay: error?.noReplay === true, ...(error?.diagnostics ? { diagnostics: error.diagnostics } : {}) } } }),
  );
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
  bridgeClient.disconnect("Bridge URL changed");
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
          const jobInput = {
            // Preserve a client-assigned job id: chained submissions name
            // their jobs up front and reference them from dependsOnId, so
            // dropping the id would orphan every dependency edge.
            ...(typeof source.id === "string" && source.id ? { id: source.id } : {}),
            operation: source.operation,
            payload: source.payload,
            label: source.label || source.name,
            metadata: { source: "extension", ...await captureFlowTargetMetadata(), ...(source.metadata || {}) },
          };
          // FEAT-11b: while one transform family holds the execution
          // lock, a different family's transform is refused here with
          // the typed lock payload instead of being queued to run over
          // it. The refusal is returned, not thrown, so its typed
          // fields (owner, canStopCurrent) survive the response path.
          const lockRefusal = flowTransformGate.admissionRefusal([jobInput]);
          if (lockRefusal) return { ok: false, error: lockRefusal, transformLock: flowTransformGate.status() };
          addedJob = await flowJobQueue.add(jobInput);
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
          const jobInputs = source.map(job => ({
            ...(typeof job?.id === "string" && job.id ? { id: job.id } : {}),
            operation: job?.operation,
            payload: job?.payload,
            label: job?.label || job?.name,
            metadata: { ...metadata, ...(job?.metadata || {}) },
          }));
          // FEAT-11b: the same transform-lock admission as
          // flow-queue:add — a batch carrying a foreign-family
          // transform is refused whole, before anything is enqueued.
          const lockRefusal = flowTransformGate.admissionRefusal(jobInputs);
          if (lockRefusal) return { ok: false, error: lockRefusal, transformLock: flowTransformGate.status() };
          addedJob = await flowJobQueue.addBatch(jobInputs, {
            batchId: message.batchId,
            batchLabel: message.batchLabel,
          });
          const beforeStart = await flowJobQueue.snapshot();
          snapshot = message.autoStart === false || beforeStart.isPaused || beforeStart.waitingForUser > 0
            ? beforeStart
            : await flowJobQueue.resume();
          break;
        }
        case "flow-queue:transform-lock":
          // FEAT-11b: read-only view of the transform execution lock —
          // current holder, any pending stop request, and any live
          // cross-family conflict the snapshot fold has surfaced.
          return { ok: true, transformLock: flowTransformGate.status() };
        case "flow-queue:transform-lock-stop": {
          // FEAT-11b: a blocked transform engine asks the running one
          // to stop. This only RECORDS the request on the lock: the
          // snapshot fold surfaces it on the running job's record at
          // the queue's generation checkpoints and the owner decides
          // whether to honor it — nothing is seized or cancelled here.
          const stopResult = flowTransformGate.requestStop(String(message.family || message.requestedBy || ""));
          return { ok: true, stop: stopResult, transformLock: flowTransformGate.status() };
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
  if (typeof message?.type === "string" && message.type.startsWith("flow-batch:")) {
    if (_sender?.id !== chrome.runtime.id || _sender?.tab) {
      respond({ ok: false, error: { code: "FLOW_BATCH_FORBIDDEN", message: "Batch drafts are available only from the extension UI." } });
      return;
    }
    void (async () => {
      await flowBatchDrafts.ready;
      switch (message.type) {
        case "flow-batch:list":
          return { ok: true, drafts: await flowBatchDrafts.list() };
        case "flow-batch:save": {
          const draft = await flowBatchDrafts.save({ id: message.id, label: message.label, jobs: message.jobs });
          return { ok: true, draft, drafts: await flowBatchDrafts.list() };
        }
        case "flow-batch:remove": {
          const removed = await flowBatchDrafts.remove(String(message.id || ""));
          return { ok: true, removed, drafts: await flowBatchDrafts.list() };
        }
        case "flow-batch:run": {
          const draftId = String(message.id || "");
          if (!flowBatchDrafts.beginRun(draftId)) {
            throw Object.assign(new Error("This batch draft is already being queued."), { code: "FLOW_BATCH_DRAFT_RUN_IN_PROGRESS" });
          }
          try {
            const draft = await flowBatchDrafts.get(draftId);
            if (!draft) throw Object.assign(new Error(`No batch draft with id ${message.id}.`), { code: "FLOW_BATCH_DRAFT_NOT_FOUND" });
            const target = await captureFlowTargetMetadata();
            const jobs = materializeDraftJobs(draft).map(job => ({
              ...job,
              // The current tab/project target wins over any target metadata
              // stored with the draft: a draft runs here and now.
              metadata: { source: "extension", ...(job.metadata || {}), ...target },
            }));
            let snapshot;
            let runBatchId = null;
            let addedJobs = [];
            if (jobs.length === 1) {
              const added = await flowJobQueue.add(jobs[0]);
              addedJobs = [added];
              runBatchId = added?.batch?.batchId || null;
              snapshot = await flowJobQueue.snapshot();
            } else {
              const added = await flowJobQueue.addBatch(jobs, { batchLabel: draft.label });
              addedJobs = added;
              runBatchId = added[0]?.batch?.batchId || null;
              snapshot = await flowJobQueue.snapshot();
            }
            // Bookkeeping must not misreport a successful enqueue as failed.
            const updated = await flowBatchDrafts.recordRun(draft.id, runBatchId).catch(() => draft);
            // FEAT-02: the run also becomes a persistent batch run record
            // whose receipts fold from queue snapshots. Tracking is
            // bookkeeping — it must never fail a successful enqueue.
            await trackDraftRun(draft, jobs, addedJobs, runBatchId).catch(error => {
              console.warn("[FlowBatchRuns] Could not track this draft run:", error?.message || error);
            });
            snapshot = message.autoStart === false || snapshot.isPaused || snapshot.waitingForUser > 0
              ? snapshot
              : await flowJobQueue.resume();
            return { ok: true, draft: updated, drafts: await flowBatchDrafts.list(), ...flowQueueSnapshot(snapshot) };
          } finally {
            flowBatchDrafts.endRun(draftId);
          }
        }
        default:
          throw Object.assign(new Error(`Unsupported batch draft action: ${message.type}`), { code: "FLOW_BATCH_ACTION_UNSUPPORTED" });
      }
    })().then(respond).catch(error => respond({
      ok: false,
      error: { code: error?.code || "FLOW_BATCH_FAILED", message: String(error?.message || error) },
    }));
    return true;
  }
  if (typeof message?.type === "string" && message.type.startsWith("flow-history:")) {
    if (_sender?.id !== chrome.runtime.id || _sender?.tab) {
      respond({ ok: false, error: { code: "FLOW_HISTORY_FORBIDDEN", message: "Generation history is available only from the extension UI." } });
      return;
    }
    void (async () => {
      await flowHistory.ready;
      switch (message.type) {
        case "flow-history:list":
          return { ok: true, records: await flowHistory.list(message.filter || {}) };
        case "flow-history:remove": {
          const removed = await flowHistory.remove(String(message.id || ""));
          return { ok: true, removed, records: await flowHistory.list() };
        }
        case "flow-history:clear": {
          await flowHistory.clear();
          return { ok: true, records: [] };
        }
        case "flow-history:rerun": {
          const record = await flowHistory.get(String(message.id || ""));
          if (!record) throw Object.assign(new Error(`No history record with id ${message.id}.`), { code: "FLOW_HISTORY_NOT_FOUND" });
          // The job is rebuilt from the record's stored snapshot — refs
          // ride the saved payload, never a fresh library lookup. Like a
          // draft run, the current tab/project target wins over the
          // target metadata captured when the original job ran.
          const target = await captureFlowTargetMetadata();
          const built = buildJobFromRecord(record);
          const job = {
            ...built,
            metadata: { source: "extension", ...(built.metadata || {}), ...target },
          };
          await flowJobQueue.add(job);
          let snapshot = await flowJobQueue.snapshot();
          snapshot = message.autoStart === false || snapshot.isPaused || snapshot.waitingForUser > 0
            ? snapshot
            : await flowJobQueue.resume();
          return { ok: true, record, ...flowQueueSnapshot(snapshot) };
        }
        default:
          throw Object.assign(new Error(`Unsupported history action: ${message.type}`), { code: "FLOW_HISTORY_ACTION_UNSUPPORTED" });
      }
    })().then(respond).catch(error => respond({
      ok: false,
      error: { code: error?.code || "FLOW_HISTORY_FAILED", message: String(error?.message || error) },
    }));
    return true;
  }
  if (typeof message?.type === "string" && message.type.startsWith("flow-tasks:")) {
    if (_sender?.id !== chrome.runtime.id || _sender?.tab) {
      respond({ ok: false, error: { code: "FLOW_TASKS_FORBIDDEN", message: "Saved tasks are available only from the extension UI." } });
      return;
    }
    void (async () => {
      await flowTaskLists.ready;
      switch (message.type) {
        case "flow-tasks:list": {
          const hasFilter = Boolean(message.query || message.projectId || message.provider);
          const tasks = hasFilter
            ? await flowTaskLists.search({ query: message.query || "", projectId: message.projectId || null, provider: message.provider || null })
            : await flowTaskLists.list();
          return { ok: true, tasks };
        }
        case "flow-tasks:create": {
          const task = await flowTaskLists.create({ name: message.name, config: message.config });
          return { ok: true, task, tasks: await flowTaskLists.list() };
        }
        case "flow-tasks:update": {
          const task = await flowTaskLists.update(String(message.id || ""), { name: message.name, config: message.config });
          return { ok: true, task, tasks: await flowTaskLists.list() };
        }
        case "flow-tasks:duplicate": {
          const task = await flowTaskLists.duplicate(String(message.id || ""));
          return { ok: true, task, tasks: await flowTaskLists.list() };
        }
        case "flow-tasks:remove": {
          const removed = await flowTaskLists.remove(String(message.id || ""));
          return { ok: true, removed, tasks: await flowTaskLists.list() };
        }
        case "flow-tasks:run": {
          // Run one, a selection, or all: the ids resolve against the
          // store, and a task already mid-run is skipped (reported, not
          // silently dropped) instead of being enqueued twice.
          const all = await flowTaskLists.list();
          const wanted = message.all === true
            ? all.map(task => task.id)
            : (Array.isArray(message.ids) ? message.ids.map(id => String(id || "")) : [String(message.id || "")]);
          const selected = [];
          const skipped = [];
          for (const id of wanted) {
            const task = all.find(entry => entry.id === id);
            if (!task) { skipped.push({ taskId: id, reason: "not_found" }); continue; }
            if (task.activeRun) { skipped.push({ taskId: id, reason: "run_in_progress" }); continue; }
            selected.push(task);
          }
          // The per-task run locks are claimed synchronously, before
          // anything is enqueued, so two panels racing the same task
          // cannot both spend its credits.
          const claimed = [];
          for (const task of selected) {
            if (flowTaskLists.beginRun(task.id)) claimed.push(task);
            else skipped.push({ taskId: task.id, reason: "run_in_progress" });
          }
          if (!claimed.length) {
            throw Object.assign(new Error("No selected task is ready to run."), { code: "FLOW_TASK_RUN_EMPTY" });
          }
          try {
            // The forced-sequential verdict travels with the response:
            // the queue drains serially in enqueue order either way, so
            // the verdict is surfaced for the panel, not re-implemented.
            const verdict = requiresSequential(claimed);
            const target = await captureFlowTargetMetadata();
            const { jobs, segments } = expandTasksToJobs(claimed);
            const stamped = jobs.map(job => ({
              ...job,
              // The current tab/project target wins over any target
              // metadata stored with the task: a task runs here and now.
              metadata: { source: "extension", ...(job.metadata || {}), ...target },
            }));
            let addedJobs;
            let runBatchId = null;
            if (stamped.length === 1) {
              const added = await flowJobQueue.add(stamped[0]);
              addedJobs = [added];
              runBatchId = added?.batch?.batchId || null;
            } else {
              addedJobs = await flowJobQueue.addBatch(stamped, { batchLabel: "Saved tasks" });
              runBatchId = addedJobs[0]?.batch?.batchId || null;
            }
            // Bookkeeping must not misreport a successful enqueue as
            // failed: each segment's admitted jobs become that task's
            // fold target for the write-back.
            let offset = 0;
            for (const [position, segment] of segments.entries()) {
              const slice = addedJobs.slice(offset, offset + segment.jobCount);
              offset += segment.jobCount;
              await flowTaskLists.recordTaskRun(claimed[position].id, { jobs: slice, batchId: runBatchId }).catch(error => {
                console.warn("[FlowTaskLists] Could not record this task run:", error?.message || error);
              });
            }
            let snapshot = await flowJobQueue.snapshot();
            snapshot = message.autoStart === false || snapshot.isPaused || snapshot.waitingForUser > 0
              ? snapshot
              : await flowJobQueue.resume();
            return {
              ok: true,
              tasks: await flowTaskLists.list(),
              skipped,
              sequential: verdict.sequential,
              sequentialReasons: verdict.reasons,
              ...flowQueueSnapshot(snapshot),
            };
          } finally {
            for (const task of claimed) flowTaskLists.endRun(task.id);
          }
        }
        default:
          throw Object.assign(new Error(`Unsupported saved task action: ${message.type}`), { code: "FLOW_TASKS_ACTION_UNSUPPORTED" });
      }
    })().then(respond).catch(error => respond({
      ok: false,
      error: { code: error?.code || "FLOW_TASKS_FAILED", message: String(error?.message || error) },
    }));
    return true;
  }
  if (typeof message?.type === "string" && message.type.startsWith("flow-albums:")) {
    if (_sender?.id !== chrome.runtime.id || _sender?.tab) {
      respond({ ok: false, error: { code: "FLOW_ALBUMS_FORBIDDEN", message: "Albums are available only from the extension UI." } });
      return;
    }
    void (async () => {
      await flowAlbums.ready;
      switch (message.type) {
        case "flow-albums:list": {
          return { ok: true, albums: await flowAlbums.list() };
        }
        case "flow-albums:create": {
          const album = await flowAlbums.create({ name: message.name });
          return { ok: true, album, albums: await flowAlbums.list() };
        }
        case "flow-albums:rename": {
          const album = await flowAlbums.rename(String(message.id || ""), message.name);
          return { ok: true, album, albums: await flowAlbums.list() };
        }
        case "flow-albums:remove": {
          const removed = await flowAlbums.remove(String(message.id || ""));
          return { ok: true, removed, albums: await flowAlbums.list() };
        }
        case "flow-albums:add-image": {
          const album = await flowAlbums.addImage(String(message.albumId || ""), message.image);
          return { ok: true, album, albums: await flowAlbums.list() };
        }
        case "flow-albums:remove-image": {
          const album = await flowAlbums.removeImage(String(message.albumId || ""), String(message.imageId || ""));
          return { ok: true, album, albums: await flowAlbums.list() };
        }
        default:
          throw Object.assign(new Error(`Unsupported album action: ${message.type}`), { code: "FLOW_ALBUMS_ACTION_UNSUPPORTED" });
      }
    })().then(respond).catch(error => respond({
      ok: false,
      error: { code: error?.code || "FLOW_ALBUMS_FAILED", message: String(error?.message || error) },
    }));
    return true;
  }
  if (typeof message?.type === "string" && message.type.startsWith("flow-workflow-templates:")) {
    if (_sender?.id !== chrome.runtime.id || _sender?.tab) {
      respond({ ok: false, error: { code: "FLOW_WORKFLOW_TEMPLATES_FORBIDDEN", message: "Workflow templates are available only from the extension UI." } });
      return;
    }
    void (async () => {
      await flowWorkflowTemplates.ready;
      switch (message.type) {
        case "flow-workflow-templates:list":
          return { ok: true, templates: await flowWorkflowTemplates.list({ category: message.category || "", search: message.search || "" }) };
        case "flow-workflow-templates:save": {
          const template = await flowWorkflowTemplates.save(message.graph, {
            name: message.name, description: message.description, category: message.category,
          });
          return { ok: true, template, templates: await flowWorkflowTemplates.list() };
        }
        case "flow-workflow-templates:instantiate": {
          const graph = await flowWorkflowTemplates.instantiate(String(message.id || ""), { name: message.name });
          return { ok: true, graph };
        }
        case "flow-workflow-templates:export": {
          const document = await flowWorkflowTemplates.exportTemplate(String(message.id || ""));
          return { ok: true, document };
        }
        case "flow-workflow-templates:import": {
          const template = await flowWorkflowTemplates.importTemplate(message.document);
          return { ok: true, template, templates: await flowWorkflowTemplates.list() };
        }
        case "flow-workflow-templates:remove": {
          const removed = await flowWorkflowTemplates.remove(String(message.id || ""));
          return { ok: true, removed, templates: await flowWorkflowTemplates.list() };
        }
        default:
          throw Object.assign(new Error(`Unsupported workflow template action: ${message.type}`), { code: "FLOW_WORKFLOW_TEMPLATES_ACTION_UNSUPPORTED" });
      }
    })().then(respond).catch(error => respond({
      ok: false,
      error: { code: error?.code || "FLOW_WORKFLOW_TEMPLATES_FAILED", message: String(error?.message || error) },
    }));
    return true;
  }
  if (typeof message?.type === "string" && message.type.startsWith("flow-gen-templates:")) {
    if (_sender?.id !== chrome.runtime.id || _sender?.tab) {
      respond({ ok: false, error: { code: "FLOW_GEN_TEMPLATES_FORBIDDEN", message: "Generation templates are available only from the extension UI." } });
      return;
    }
    void (async () => {
      await flowGenTemplates.ready;
      switch (message.type) {
        case "flow-gen-templates:list":
          return { ok: true, templates: await flowGenTemplates.list({ search: message.search || "" }) };
        case "flow-gen-templates:save": {
          const template = await flowGenTemplates.save(message.state, { name: message.name });
          return { ok: true, template, templates: await flowGenTemplates.list() };
        }
        case "flow-gen-templates:apply": {
          const job = await flowGenTemplates.apply(String(message.id || ""));
          return { ok: true, job };
        }
        case "flow-gen-templates:remove": {
          const removed = await flowGenTemplates.remove(String(message.id || ""));
          return { ok: true, removed, templates: await flowGenTemplates.list() };
        }
        default:
          throw Object.assign(new Error(`Unsupported generation template action: ${message.type}`), { code: "FLOW_GEN_TEMPLATES_ACTION_UNSUPPORTED" });
      }
    })().then(respond).catch(error => respond({
      ok: false,
      error: { code: error?.code || "FLOW_GEN_TEMPLATES_FAILED", message: String(error?.message || error) },
    }));
    return true;
  }
  if (typeof message?.type === "string" && message.type.startsWith("flow-prompt-assistant:")) {
    if (_sender?.id !== chrome.runtime.id || _sender?.tab) {
      respond({ ok: false, error: { code: "FLOW_PROMPT_ASSISTANT_FORBIDDEN", message: "The prompt assistant is available only from the extension UI." } });
      return;
    }
    void (async () => {
      switch (message.type) {
        case "flow-prompt-assistant:build": {
          const built = buildAssistantRequest({ format: message.format || "single-en", idea: message.idea, options: message.options || {} });
          return { ok: true, formatId: built.formatId, text: built.text };
        }
        case "flow-prompt-assistant:parse": {
          const parsed = parseAssistantReply(message.text);
          return { ok: true, prompts: parsed.prompts, raw: parsed.raw };
        }
        case "flow-prompt-assistant:parse-i2p": {
          const result = parseImageToPromptReply(message.text);
          return { ok: true, result };
        }
        default:
          throw Object.assign(new Error(`Unsupported prompt assistant action: ${message.type}`), { code: "FLOW_PROMPT_ASSISTANT_ACTION_UNSUPPORTED" });
      }
    })().then(respond).catch(error => respond({
      ok: false,
      error: { code: error?.code || "FLOW_PROMPT_ASSISTANT_FAILED", message: String(error?.message || error) },
    }));
    return true;
  }
  if (typeof message?.type === "string" && message.type.startsWith("flow-batch-runs:")) {
    if (_sender?.id !== chrome.runtime.id || _sender?.tab) {
      respond({ ok: false, error: { code: "FLOW_BATCH_RUNS_FORBIDDEN", message: "Batch runs are available only from the extension UI." } });
      return;
    }
    void (async () => {
      await flowBatchRuns.ready;
      switch (message.type) {
        case "flow-batch-runs:list":
          return { ok: true, runs: await flowBatchRuns.list() };
        case "flow-batch-runs:get":
          return { ok: true, run: await flowBatchRuns.get(String(message.id || "")) };
        case "flow-batch-runs:remove": {
          const removed = await flowBatchRuns.remove(String(message.id || ""));
          return { ok: true, removed, runs: await flowBatchRuns.list() };
        }
        case "flow-batch-runs:create": {
          const draftId = String(message.id || "");
          if (!flowBatchDrafts.beginRun(draftId)) {
            throw Object.assign(new Error("This batch draft is already being queued."), { code: "FLOW_BATCH_DRAFT_RUN_IN_PROGRESS" });
          }
          try {
            const draft = await flowBatchDrafts.get(draftId);
            if (!draft) throw Object.assign(new Error(`No batch draft with id ${message.id}.`), { code: "FLOW_BATCH_DRAFT_NOT_FOUND" });
            const target = await captureFlowTargetMetadata();
            const jobs = materializeDraftJobs(draft).map(job => ({
              ...job,
              // The current tab/project target wins over any target
              // metadata stored with the draft: a draft runs here and now.
              metadata: { source: "extension", ...(job.metadata || {}), ...target },
            }));
            const run = await flowBatchRuns.create({ draftId: draft.id, label: draft.label, items: jobs });
            try {
              // The claim gates the enqueue: a conflicting active batch
              // surfaces before a single credit can be spent.
              const claim = await flowBatchRuns.claim(run.id, run.revision);
              let addedJobs = [];
              let runBatchId = null;
              if (jobs.length === 1) {
                const added = await flowJobQueue.add(jobs[0]);
                addedJobs = [added];
                runBatchId = added?.batch?.batchId || null;
              } else {
                runBatchId = crypto.randomUUID();
                addedJobs = await flowJobQueue.addBatch(jobs, { batchId: runBatchId, batchLabel: draft.label });
              }
              const mapping = addedJobs.map((job, position) => ({ index: claim.indexes[position], jobId: job.id }));
              const admitted = await flowBatchRuns.recordAdmission(run.id, { batchId: runBatchId, kind: "initial", mapping });
              // Bookkeeping must not misreport a successful enqueue as failed.
              const updated = await flowBatchDrafts.recordRun(draft.id, runBatchId).catch(() => draft);
              let snapshot = await flowJobQueue.snapshot();
              snapshot = message.autoStart === false || snapshot.isPaused || snapshot.waitingForUser > 0
                ? snapshot
                : await flowJobQueue.resume();
              return { ok: true, run: admitted, draft: updated, drafts: await flowBatchDrafts.list(), runs: await flowBatchRuns.list(), ...flowQueueSnapshot(snapshot) };
            } catch (error) {
              // The claim admitted nothing — drop the record again so a
              // failed start leaves no orphan run behind.
              await flowBatchRuns.remove(run.id).catch(() => {});
              throw error;
            }
          } finally {
            flowBatchDrafts.endRun(draftId);
          }
        }
        case "flow-batch-runs:resume": {
          const runId = String(message.id || "");
          const current = await flowBatchRuns.get(runId);
          if (!current) throw Object.assign(new Error(`No batch run with id ${message.id}.`), { code: "FLOW_BATCH_RUN_NOT_FOUND" });
          // Index validation and the single-active invariant run inside
          // the store before anything is enqueued.
          const resumed = await flowBatchRuns.resume(runId, {
            indexes: Array.isArray(message.indexes) ? message.indexes : undefined,
            expectedRevision: message.expectedRevision,
          });
          const target = await captureFlowTargetMetadata();
          const jobs = materializeDraftJobs({ jobs: resumed.jobs }).map(job => ({
            ...job,
            metadata: { source: "extension", ...(job.metadata || {}), ...target },
          }));
          let admitted;
          try {
            let addedJobs = [];
            let runBatchId = null;
            if (jobs.length === 1) {
              const added = await flowJobQueue.add(jobs[0]);
              addedJobs = [added];
              runBatchId = added?.batch?.batchId || null;
            } else {
              runBatchId = crypto.randomUUID();
              addedJobs = await flowJobQueue.addBatch(jobs, { batchId: runBatchId, batchLabel: current.label });
            }
            const mapping = addedJobs.map((job, position) => ({ index: resumed.indexes[position], jobId: job.id }));
            admitted = await flowBatchRuns.recordAdmission(runId, { batchId: runBatchId, kind: "resume", mapping });
          } catch (error) {
            // The enqueue failed after the claim: hand the claim back so
            // the run returns to its finalized state instead of wedging
            // the scheduler behind a phantom active batch.
            await flowBatchRuns.releaseClaim(runId).catch(() => {});
            throw error;
          }
          let snapshot = await flowJobQueue.snapshot();
          snapshot = message.autoStart === false || snapshot.isPaused || snapshot.waitingForUser > 0
            ? snapshot
            : await flowJobQueue.resume();
          return { ok: true, run: admitted, runs: await flowBatchRuns.list(), ...flowQueueSnapshot(snapshot) };
        }
        default:
          throw Object.assign(new Error(`Unsupported batch run action: ${message.type}`), { code: "FLOW_BATCH_RUNS_ACTION_UNSUPPORTED" });
      }
    })().then(respond).catch(error => respond({
      ok: false,
      error: { code: error?.code || "FLOW_BATCH_RUNS_FAILED", message: String(error?.message || error) },
    }));
    return true;
  }
  if (typeof message?.type === "string" && message.type.startsWith("flow-media-catalog:")) {
    // The catalog is written and read by the Flow tab's content scripts
    // (upload receipts register identities; reference resolution looks them
    // up) and by extension UI pages. Foreign extensions are rejected, and
    // a tab sender must be a Flow tab — the same discipline the
    // flow-queue/flow-batch handlers apply to their senders.
    if (_sender?.id !== chrome.runtime.id || (_sender?.tab && !flowUrl(_sender.tab.url))) {
      respond({ ok: false, error: { code: "FLOW_MEDIA_CATALOG_FORBIDDEN", message: "The media catalog is available only to this extension's Flow tabs and UI pages." } });
      return;
    }
    void (async () => {
      await flowMediaCatalog.ready;
      switch (message.type) {
        case "flow-media-catalog:record":
          return { ok: true, entry: await flowMediaCatalog.record(message.entry || {}) };
        case "flow-media-catalog:lookup":
          return { ok: true, entry: await flowMediaCatalog.lookup(message.query || {}) };
        case "flow-media-catalog:list":
          return { ok: true, entries: await flowMediaCatalog.list(message.projectId) };
        default:
          throw Object.assign(new Error(`Unsupported media catalog action: ${message.type}`), { code: "FLOW_MEDIA_CATALOG_ACTION_UNSUPPORTED" });
      }
    })().then(respond).catch(error => respond({
      ok: false,
      error: { code: error?.code || "FLOW_MEDIA_CATALOG_FAILED", message: String(error?.message || error) },
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
      progress: String(message.progress || "").slice(0, 240), transport: bridgeClient.getStatus().transport,
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
    // Dispatch runs an operation directly against the Flow tab, bypassing
    // the queue (no preflight, no pause state, no retry budget). Like the
    // flow-batch:* handlers, it is restricted to this extension's own UI
    // pages; a content script in a tab must never reach it.
    if (_sender?.id !== chrome.runtime.id || _sender?.tab) {
      respond({ ok: false, error: { code: "FLOW_DISPATCH_FORBIDDEN", message: "Flow dispatch is available only from the extension UI." } });
      return true;
    }
    void (async () => {
      const { operation, payload } = message;
      const command = {
        op: "flowOperation",
        name: operation,
        payload: payload || {},
        // The sequence suffix keeps ids unique for dispatches minted in the
        // same millisecond; begin/end interactive-request tracking keys off
        // this id, so a collision would leak the count and stick the
        // activity overlay on.
        id: `ui-${Date.now()}-${++uiDispatchSequence}`,
      };
      const result = await execute(null, "flow.dom.execute", [command]);
      respond({ ok: true, value: result });
    })().catch(err => {
      respond({ ok: false, error: { message: err?.message || String(err), code: err?.code || "DISPATCH_FAILED" } });
    });
    return true;
  }
  if (message?.type === "flow-mcp:status") {
    Promise.all([config(), chrome.tabs.query({ url: "https://flow.google.com/*" })]).then(([c, tabs]) => respond({ configured: true, bridge: c.bridge, flowTabs: tabs.length, selectedTabId, connected: bridgeConnected(), transport: bridgeClient.getStatus().transport, wsConnected: bridgeConnected(), error: lastError }));
    return true;
  }
  if (message?.type === "flow-mcp:connect") {
    void (async () => {
      const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const flowTabs = await chrome.tabs.query({ url: "https://flow.google.com/*" });
      const activeFlowTab = flowTabs.find(tab => activeTabs.some(active => active.id === tab.id));
      if (activeFlowTab) await adoptFlowTab(activeFlowTab, true);
      else await chooseTab();
      bridgeClient.disconnect("User reconnect");
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

