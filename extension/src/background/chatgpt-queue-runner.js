// Background ChatGPT queue runner (GPT-10).
//
// Logic (adapted from the reference provider design, not its code): the
// queue is provider-agnostic and the runner is injected, so a ChatGPT job
// drains through a provider branch of the runner — resolve the GPT-08
// descriptor for the job's operation, find-or-create the provider tab
// from the descriptor's URL patterns / create URL, pin the job to the tab
// and conversation under the descriptor's metadata keys, then run the
// submit → observe split the study prescribes (§D.1), mirroring the Flow
// generation path's shapes and failure discipline:
//
//   - submit returns a receipt { turnId, conversationId, baselineId };
//     the job result records { imageUrls, altPrompt?, text?, turnId,
//     conversationId, conversationUrl } from the observe result (§D.2).
//   - a submit whose outcome cannot be determined is NEVER replayed:
//     the content op is invoked exactly once for the job and the failure
//     keeps the outcome-unknown flags the content layer reported, so the
//     queue's generic policy parks the job for inspection instead of
//     risking a duplicate message.
//   - an unclassified observe failure is stamped outcome-unknown (the
//     submit was confirmed; only the render is unreadable), exactly like
//     the Flow runner's observe catch.
//   - a typed provider outcome (CHATGPT_* codes, GPT-06/GPT-07 taxonomy)
//     passes through UNTOUCHED: it carries its own outcome semantics
//     (e.g. CHATGPT_TEXT_ONLY is a known terminal outcome), and stamping
//     dispatch markers on it would flip it to outcome-unknown in the
//     queue's mayHaveDispatched accounting.
//   - retry policy is the queue's alone: this runner declares no budget;
//     a job's own payload.retries (or the queue cap) governs retries of
//     explicitly retryable failures.
//
// The content command rides the existing flow-mcp:execute envelope as an
// op:"flowOperation" command whose _flowTarget is the descriptor's target
// ({ tabId, driverKey: "chatgpt", origin, conversationId } — never a
// projectId), which is what the content-side BaseProviderDriver validates
// (GPT-13). All chrome access is injected as deps so the runner is
// testable against fake tabs + fake content responses; service-worker.js
// supplies the production deps.

import { resolveProviderForOperation } from "./provider-router.js";
import { CHATGPT_GENERATION_OPERATION } from "./chatgpt-queue-preflight.js";

const CHATGPT_OBSERVE_OPERATION = "chatgpt.generation.observe";

function unsupportedOperationError(operation) {
  return Object.assign(new Error(`Unsupported extension queue operation: ${String(operation || "(missing)")}`), {
    code: "FLOW_QUEUE_OPERATION_UNSUPPORTED",
    outcome_unknown: false,
  });
}

function providerTabMatches(descriptor, tab) {
  if (!tab || typeof tab.url !== "string") return false;
  try {
    return new URL(tab.url).origin === descriptor.origin;
  } catch {
    return false;
  }
}

// The conversation a tab currently shows, mirroring how the Flow runner
// derives the project id from the pinned tab's URL when job metadata does
// not carry one yet.
function conversationIdFromUrl(value) {
  try {
    return new URL(value).pathname.match(/\/c\/([0-9a-zA-Z][0-9a-zA-Z-]{2,})(?:\/|$)/)?.[1] || null;
  } catch {
    return null;
  }
}

export async function runChatGptQueueJob(job, hooks, deps) {
  const operation = job?.operation || job?.data?.operation;
  const descriptor = resolveProviderForOperation(operation);
  if (descriptor.key !== "chatgpt" || operation !== CHATGPT_GENERATION_OPERATION) {
    throw unsupportedOperationError(operation);
  }
  if (!deps || typeof deps.sendCommand !== "function" || !deps.tabs ||
    typeof deps.tabs.query !== "function" || typeof deps.tabs.get !== "function" ||
    typeof deps.tabs.create !== "function") {
    throw new TypeError("runChatGptQueueJob requires deps { tabs: { query, get, create }, sendCommand }.");
  }
  const updateMetadata = typeof deps.updateMetadata === "function" ? deps.updateMetadata : async () => {};
  const waitForTabComplete = typeof deps.waitForTabComplete === "function" ? deps.waitForTabComplete : async () => {};
  const randomId = typeof deps.randomId === "function" ? deps.randomId : () => globalThis.crypto.randomUUID();
  const progress = typeof hooks?.progress === "function" ? hooks.progress : async () => {};
  const signal = hooks?.signal;

  const payload = structuredClone(job?.payload || job?.data?.payload || {});
  const metadata = job?.metadata && typeof job.metadata === "object" ? job.metadata : {};
  const tabIdKey = descriptor.tabIdMetadataKey;
  const targetKey = descriptor.targetMetadataKey;

  // Tab resolution: the pinned tab first (validated against the provider
  // origin — a pin whose tab was closed or navigated away is stale), then
  // any open provider tab, then create one at the descriptor's home URL.
  let tab = null;
  if (Number.isInteger(metadata[tabIdKey])) {
    const pinned = await deps.tabs.get(metadata[tabIdKey]).catch(() => null);
    if (providerTabMatches(descriptor, pinned)) tab = pinned;
  }
  if (!tab) {
    const candidates = await deps.tabs.query(descriptor.tabUrlPatterns).catch(() => []);
    tab = (Array.isArray(candidates) ? candidates : [])
      .find(candidate => providerTabMatches(descriptor, candidate)) || null;
  }
  if (!tab) {
    tab = await deps.tabs.create(descriptor.createUrl);
    if (tab && Number.isInteger(tab.id)) await waitForTabComplete(tab.id).catch(() => {});
  }
  if (!tab || !Number.isInteger(tab.id)) {
    throw Object.assign(new Error("No ChatGPT tab is available for this queue item, and one could not be opened."), {
      code: "CHATGPT_TAB_UNAVAILABLE", retryable: true, outcome_unknown: false,
    });
  }

  // Pins: persist the tab actually used, plus the conversation when it is
  // known (metadata first, tab URL as the fallback — the Flow runner's
  // URL-fallback discipline). The receipt below may refine the
  // conversation pin to the one the submit actually landed in.
  let pinnedConversationId = Object.prototype.hasOwnProperty.call(metadata, targetKey)
    ? metadata[targetKey]
    : conversationIdFromUrl(tab.url);
  if (typeof pinnedConversationId !== "string" || !pinnedConversationId) pinnedConversationId = null;
  const pinPatch = {};
  if (metadata[tabIdKey] !== tab.id) pinPatch[tabIdKey] = tab.id;
  if (!Object.prototype.hasOwnProperty.call(metadata, targetKey) && pinnedConversationId) {
    pinPatch[targetKey] = pinnedConversationId;
  }
  if (Object.keys(pinPatch).length) await updateMetadata(job.id, pinPatch);
  job.metadata = { ...metadata, ...pinPatch };

  const targetFor = conversationId => descriptor.targetDescriptor(
    { ...job, metadata: { ...job.metadata, [targetKey]: conversationId } },
    tab,
  );
  const invoke = (name, body, target) => deps.sendCommand(tab.id, {
    op: "flowOperation",
    name,
    payload: body,
    tabId: tab.id,
    _flowTarget: target,
    jobId: job.id,
    id: `queue-${job.id}-${randomId()}`,
  }, signal);

  if (signal?.aborted) {
    throw Object.assign(new Error("Queue stopped before ChatGPT accepted this task."), { outcomeUnknown: false });
  }

  await progress({ phase: "submit", message: "Submitting to ChatGPT…", percent: 5 });
  let submitted;
  try {
    submitted = await invoke(operation, payload, targetFor(pinnedConversationId));
  } catch (error) {
    // Mirror the Flow runner's submit catch: normalize the outcome flags
    // the content layer reported instead of inventing new ones. An
    // outcome-unknown submit ends here — exactly one content invocation.
    throw Object.assign(error, {
      outcomeUnknown: Boolean(error?.outcomeUnknown || error?.outcome_unknown),
      requestDispatched: Boolean(error?.requestDispatched || error?.request_dispatched),
    });
  }
  const turnId = typeof submitted?.turnId === "string" && submitted.turnId ? submitted.turnId : null;
  if (!turnId) {
    // Mirrors FLOW_SUBMIT_RECEIPT_INCOMPLETE: the request was dispatched
    // but the receipt cannot be observed or safely replayed.
    throw Object.assign(new Error("ChatGPT accepted the request, but its submit receipt did not include a turn id. Inspect ChatGPT before retrying."), {
      code: "CHATGPT_SUBMIT_RECEIPT_INCOMPLETE", outcomeUnknown: true, outcome_unknown: true, requestDispatched: true,
    });
  }
  const receiptConversationId = typeof submitted?.conversationId === "string" && submitted.conversationId
    ? submitted.conversationId
    : null;
  const conversationId = receiptConversationId || pinnedConversationId;
  if (conversationId && job.metadata[targetKey] !== conversationId) {
    await updateMetadata(job.id, { [targetKey]: conversationId });
    job.metadata = { ...job.metadata, [targetKey]: conversationId };
  }

  await progress({ phase: "render", message: "Submitted; waiting for ChatGPT to finish rendering…", percent: 10 });
  let observed;
  try {
    observed = await invoke(CHATGPT_OBSERVE_OPERATION, {
      turnId,
      conversationId,
      baselineId: typeof submitted?.baselineId === "string" ? submitted.baselineId : null,
      ...(Number.isFinite(payload.timeoutMs) && payload.timeoutMs > 0 ? { timeoutMs: payload.timeoutMs } : {}),
    }, targetFor(conversationId));
  } catch (error) {
    if (String(error?.code || "").startsWith("CHATGPT_")) {
      // Typed provider outcome: passes through untouched (see header).
      throw error;
    }
    throw Object.assign(error, {
      outcomeUnknown: true,
      requestDispatched: true,
      code: error?.code || "CHATGPT_RENDER_OUTCOME_UNKNOWN",
    });
  }

  const observedResult = observed && typeof observed === "object" ? observed : {};
  const result = {
    imageUrls: Array.isArray(observedResult.imageUrls) ? [...observedResult.imageUrls] : [],
    ...(typeof observedResult.altPrompt === "string" ? { altPrompt: observedResult.altPrompt } : {}),
    ...(typeof observedResult.text === "string" ? { text: observedResult.text } : {}),
    turnId,
    conversationId,
    ...(conversationId ? { conversationUrl: `${descriptor.origin}/c/${conversationId}` } : {}),
  };
  await progress({ phase: "generation_complete", message: "ChatGPT generation completed.", percent: 100 });
  return { completed: true, requestDispatched: true, result };
}

export function createChatGptQueueRunner(deps) {
  return (job, hooks) => runChatGptQueueJob(job, hooks, deps);
}
