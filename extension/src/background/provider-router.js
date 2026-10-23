// Background provider router (GPT-08).
//
// Logic (adapted from the reference provider design, not its code): queue
// operations are dispatched by their provider prefix. Each provider has a
// descriptor — tab URL patterns for find-or-create, the create (home) URL,
// the origin, the job-metadata keys that pin a job to its tab and target,
// and a targetDescriptor(job, tab) builder for the content-command target.
// The runner resolves the descriptor for a job's operation before anything
// else, so provider-specific pinning/validation hangs off the descriptor
// instead of hard-coded Flow checks.
//
// Flow's descriptor reproduces today's routing values exactly (the
// generalization wraps the Flow path, never rewrites it):
//   - tabUrlPatterns: the pattern chooseTab() queries today
//   - createUrl: flowHomeUrl() with no locale — the URL tabs.create opens
//   - origin / pin keys: the origin and the flowTabId / flowProjectId
//     metadata keys runExtensionFlowJob reads and writes today
//   - targetDescriptor: the _flowTarget literal the runner builds today,
//     key order included. The runner persists the resolved pins onto
//     job.metadata before invoking, so the descriptor reads them from
//     there; a target id absent from metadata comes out null (the caller
//     resolves URL fallbacks before constructing the target).
//
// ChatGPT is a no-project provider (GPT-13's requiresProject flag): its
// target pins metadata.providerTabId + metadata.conversationId and never
// carries a projectId. Its values come from what the repo already
// declares — the provider registry origin (https://chatgpt.com) and the
// §D.4 match pattern — with https://chatgpt.com/ as the create URL.
//
// Unknown prefixes throw the runner's existing typed unsupported error
// (same message, code and outcome_unknown as the allowlist check in
// runExtensionFlowJob), so resolving early changes nothing a caller can
// observe for operations the queue does not run yet.

const FLOW_ORIGIN = "https://flow.google.com";
const CHATGPT_ORIGIN = "https://chatgpt.com";

function pinnedMetadataValue(job, key) {
  const metadata = job?.metadata && typeof job.metadata === "object" ? job.metadata : {};
  return Object.prototype.hasOwnProperty.call(metadata, key) ? metadata[key] : null;
}

function flowTargetDescriptor(job, tab) {
  return {
    tabId: tab?.id,
    driverKey: "flow",
    origin: FLOW_ORIGIN,
    projectId: pinnedMetadataValue(job, "flowProjectId"),
  };
}

function chatgptTargetDescriptor(job, tab) {
  return {
    tabId: tab?.id,
    driverKey: "chatgpt",
    origin: CHATGPT_ORIGIN,
    conversationId: pinnedMetadataValue(job, "conversationId"),
  };
}

export const PROVIDER_DESCRIPTORS = Object.freeze([
  Object.freeze({
    key: "flow",
    operationPrefix: "flow.",
    origin: FLOW_ORIGIN,
    tabUrlPatterns: Object.freeze(["https://flow.google.com/*"]),
    createUrl: "https://flow.google.com/",
    requiresProject: true,
    tabIdMetadataKey: "flowTabId",
    targetMetadataKey: "flowProjectId",
    targetDescriptor: flowTargetDescriptor,
  }),
  Object.freeze({
    key: "chatgpt",
    operationPrefix: "chatgpt.",
    origin: CHATGPT_ORIGIN,
    tabUrlPatterns: Object.freeze(["*://chatgpt.com/*"]),
    createUrl: "https://chatgpt.com/",
    requiresProject: false,
    tabIdMetadataKey: "providerTabId",
    targetMetadataKey: "conversationId",
    targetDescriptor: chatgptTargetDescriptor,
  }),
]);

export function providerForOperation(operation) {
  if (typeof operation !== "string" || !operation) return null;
  return PROVIDER_DESCRIPTORS.find(descriptor => operation.startsWith(descriptor.operationPrefix)) || null;
}

export function resolveProviderForOperation(operation) {
  const descriptor = providerForOperation(operation);
  if (descriptor) return descriptor;
  throw Object.assign(new Error(`Unsupported extension queue operation: ${String(operation || "(missing)")}`), {
    code: "FLOW_QUEUE_OPERATION_UNSUPPORTED",
    outcome_unknown: false,
  });
}
