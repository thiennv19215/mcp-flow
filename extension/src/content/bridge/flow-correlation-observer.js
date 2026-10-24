(function () {
  "use strict";
  const VERSION = 1;
  const OBSERVER_REVISION = 24;
  const codec = window.FlowV2CorrelationCodec || null;
  const ARM = "TOBY_FLOW_CORRELATION_ARM";
  const ARM_V2 = "TOBY_FLOW_V2_CORRELATION_ARM";
  const DISARM = "TOBY_FLOW_CORRELATION_DISARM";
  const DISARM_V2 = "TOBY_FLOW_V2_CORRELATION_DISARM";
  const HEALTH_READ = "TOBY_FLOW_CORRELATION_HEALTH_READ";
  const HEALTH_RESPONSE = "TOBY_FLOW_CORRELATION_HEALTH_RESPONSE";
  const RECEIPT = "TOBY_FLOW_CORRELATION_RECEIPT";
  const RECEIPT_V2 = "TOBY_FLOW_V2_CORRELATION_RECEIPT";
  const MEDIA_IDENTITIES = "TOBY_FLOW_MEDIA_IDENTITIES";
  const MEDIA_IDENTITIES_V2 = "TOBY_FLOW_V2_MEDIA_IDENTITIES";
  const MEDIA_IDENTITIES_READ = "TOBY_FLOW_MEDIA_IDENTITIES_READ";
  const MEDIA_IDENTITIES_READ_V2 = "TOBY_FLOW_V2_MEDIA_IDENTITIES_READ";
  const mediaIdentities = new Map();
  const mediaIdentityTypes = new Map();
  let mediaIdentityProject = null;
  const old = window.__tobyFlowCorrelationObserver || window.__tobyFlowV2CorrelationObserver;
  if (old?.health) {
    try {
      if (old.health()?.activeAttempts !== 0) return;
    } catch (_) {
      return;
    }
  }
  const retired = old?.retired || { entries: [], saturated: false };
  retired.requestSignatures || (retired.requestSignatures = []);
  retired.completedDispatches || (retired.completedDispatches = []);
  for (const entry of retired.entries || []) {
    if (
      entry?.mediaType === "image" &&
      (!Array.isArray(entry.expectedMediaReferenceIds) ||
        !Array.isArray(entry.expectedCharacterIds))
    )
      entry.refMatchVersion = 0;
  }
  // M-D: drop TTL-expired retired entries carried over a re-injection.
  // Entries without expiresAt predate the TTL and are kept (fail-closed).
  retired.entries = (retired.entries || []).filter(
    (entry) => !(Number.isFinite(entry?.expiresAt) && entry.expiresAt <= Date.now())
  );
  if (old?.dispose) {
    try {
      old.dispose();
    } catch (_) {}
  }
  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;
  const nativeFetch = typeof window.fetch === "function" ? window.fetch : null;
  const attempts = new Map();
  const xhrState = new WeakMap();
  let diagnosticBudget = 12;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const ERROR_CODE_RE =
    /^(?:PUBLIC_ERROR(?:_[A-Z0-9]+)*|SEXUALLY_EXPLICIT|CHILD_SAFETY|[A-Z][A-Z0-9_]*(?:_ERROR|_FAILED|_FAILURE))$/;
  const BATCHEXECUTE_PATH = "/_/AiSandboxAngularFrontend/data/batchexecute";
  const REQUEST_DIAGNOSTIC_TTL_MS = 15 * 60_000;
  // M-D: a retired fingerprint entry blocks an identical re-arm in the
  // same tab. That block must be bounded, not permanent: a dispatch that
  // genuinely ended ambiguously (click delivered, outcome unknown) keeps
  // the conservative block for one TTL window, after which a retry may
  // arm again. Entries recorded before this TTL existed carry no
  // expiresAt and are kept (fail-closed for pre-fix sessions).
  const RETIRED_ENTRY_TTL_MS = 15 * 60_000;
  const pruneRetiredEntries = () => {
    const now = Date.now();
    retired.entries = (retired.entries || []).filter(
      (entry) => !(Number.isFinite(entry?.expiresAt) && entry.expiresAt <= now)
    );
  };
  const REQUEST_DIAGNOSTIC_MAX = 32;
  const REQUEST_DIAGNOSTIC_PER_ATTEMPT_MAX = 12;
  const safeRequestPath = (value) => {
    try {
      const url = new URL(String(value || ""), location.href);
      if (url.origin !== location.origin) return null;
      return url.pathname.split("/").map((part) => {
        if (!part) return part;
        if (["_", "AiSandboxAngularFrontend", "data", "batchexecute", "flow", "project", "u", "api", "v1", "rpc", ":id", ":uuid", ":segment"].includes(part)) return part;
        if (part === "0") return ":id";
        if (UUID_RE.test(part)) return ":uuid";
        if (/^[0-9]+$/.test(part)) return ":id";
        return ":segment";
      }).join("/").slice(0, 180);
    } catch (_) {
      return null;
    }
  };
  const safeRequestRpcId = (value) => typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value)
    ? value
    : null;
  const payloadShape = (value, depth = 0, budget = { remaining: 48 }) => {
    if (--budget.remaining < 0) return { type: "truncated" };
    if (value === null) return { type: "null" };
    if (Array.isArray(value)) {
      const result = { type: "array", length: value.length };
      if (depth < 4) result.items = value.slice(0, 12).map((item) => payloadShape(item, depth + 1, budget));
      return result;
    }
    if (typeof value === "string") return { type: "string", length: Math.min(value.length, 1_000_000) };
    if (typeof value === "number") return { type: Number.isFinite(value) ? "number" : "nonfinite_number" };
    if (typeof value === "boolean") return { type: "boolean" };
    if (typeof value === "object") return { type: "object", keyCount: Math.min(Object.keys(value).length, 128) };
    return { type: typeof value };
  };
  const DIAGNOSTIC_REASON_CODES = new Set([
    "payload_unparsed", "payload_shape_mismatch", "quantity_mismatch", "prompt_mismatch",
    "model_mismatch", "reference_ids_mismatch", "project_mismatch", "request_path_unrecognized",
    "payload_match_failed", "retired_request_signature", "attempt_interfered",
    "request_cardinality_exhausted", "rpc_payload_unparsed", "completed_dispatch_replay",
  ]);
  const ownData = (value, key) => {
    if (!value || typeof value !== "object") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value")
      ? descriptor.value
      : undefined;
  };
  const sanitizePayloadShape = (shape, depth = 0, budget = { remaining: 48 }) => {
    if (!shape || typeof shape !== "object" || --budget.remaining < 0) return null;
    const type = ownData(shape, "type");
    if (["truncated", "null", "number", "nonfinite_number", "boolean", "unparsed_body"].includes(type))
      return { type };
    if (type === "string") {
      const length = ownData(shape, "length");
      return Number.isInteger(length) && length >= 0 && length <= 1_000_000 ? { type, length } : null;
    }
    if (type === "object") {
      const keyCount = ownData(shape, "keyCount");
      return Number.isInteger(keyCount) && keyCount >= 0 && keyCount <= 128 ? { type, keyCount } : null;
    }
    if (type !== "array") return null;
    const length = ownData(shape, "length");
    if (!Number.isInteger(length) || length < 0 || length > 1_000_000) return null;
    const result = { type, length };
    const items = ownData(shape, "items");
    if (items !== undefined) {
      const itemLength = ownData(items, "length");
      if (depth >= 4 || !Array.isArray(items) || !Number.isInteger(itemLength) || itemLength < 0 || itemLength > 12) return null;
      result.items = [];
      for (let index = 0; index < itemLength; index++) {
        const item = ownData(items, String(index));
        const sanitized = sanitizePayloadShape(item, depth + 1, budget);
        if (!sanitized) return null;
        result.items.push(sanitized);
      }
    }
    return result;
  };
  const sanitizeRequestDiagnosticEvent = (entry, cutoff = Date.now() - REQUEST_DIAGNOSTIC_TTL_MS) => {
    try {
      if (!entry || typeof entry !== "object") return null;
      const observedAt = ownData(entry, "observedAt");
      const attemptId = ownData(entry, "attemptId");
      const mediaType = ownData(entry, "mediaType");
      const transport = ownData(entry, "transport");
      const rawPath = ownData(entry, "path");
      const rawRpcId = ownData(entry, "rpcId");
      const payloadVersion = ownData(entry, "payloadVersion");
      const rawShape = ownData(entry, "payloadShape");
      const pathRecognized = ownData(entry, "pathRecognized");
      const payloadMatched = ownData(entry, "payloadMatched");
      const rawFields = ownData(entry, "fields");
      const rawReasons = ownData(entry, "reasons");
      if (!Number.isFinite(observedAt) || observedAt < cutoff || observedAt > Date.now() + 60_000 ||
          typeof attemptId !== "string" || !UUID_RE.test(attemptId) ||
          !["image", "video"].includes(mediaType) || !["fetch", "xhr"].includes(transport) ||
          (rawPath !== null && typeof rawPath !== "string") ||
          (rawRpcId !== null && typeof rawRpcId !== "string") ||
          !["unknown", "image_rows_v1", "video_inputs_v1"].includes(payloadVersion) ||
          typeof pathRecognized !== "boolean" || typeof payloadMatched !== "boolean" ||
          !rawFields || typeof rawFields !== "object" || !Array.isArray(rawReasons) || rawReasons.length > 32) return null;
      const path = rawPath === null ? null : safeRequestPath(rawPath);
      const rpcId = rawRpcId === null ? null : safeRequestRpcId(rawRpcId);
      const sanitizedShape = sanitizePayloadShape(rawShape);
      if ((rawPath !== null && path === null) || (rawRpcId !== null && rpcId === null) || !sanitizedShape) return null;
      const fieldNames = ["shape", "prompt", "model", "quantity", "referenceIds", "project"];
      const nullableFields = new Set(["prompt", "model", "quantity", "referenceIds", "project"]);
      const fields = {};
      for (const name of fieldNames) {
        const field = ownData(rawFields, name);
        if (typeof field !== "boolean" && !(field === null && nullableFields.has(name))) return null;
        fields[name] = field;
      }
      const reasons = [];
      const seenReasons = new Set();
      for (let index = 0; index < rawReasons.length && reasons.length < 8; index++) {
        const reason = ownData(rawReasons, String(index));
        if (typeof reason !== "string" || seenReasons.has(reason)) continue;
        if (DIAGNOSTIC_REASON_CODES.has(reason)) {
          reasons.push(reason);
          seenReasons.add(reason);
        } else if (/^weak_match:(quantity|refs)$/.test(reason)) {
          // Videofix M-C: the weak-match reason is one of two fixed field
          // names, never free text, so it passes the same allowlist
          // discipline as the dropped-references count above.
          reasons.push(reason);
          seenReasons.add(reason);
        } else if (/^dropped_references:[1-9][0-9]*$/.test(reason)) {
          // Audit cluster B: the drop count is part of the reason code,
          // so the fixed allowlist above would strip it and the panel
          // would never show the loss. The strict numeric shape keeps
          // the allowlist's protection: only a positive integer count
          // passes, never free text.
          reasons.push(reason);
          seenReasons.add(reason);
        }
      }
      return { observedAt, attemptId, mediaType, transport, path, rpcId, payloadVersion, payloadShape: sanitizedShape, pathRecognized, payloadMatched, fields, reasons };
    } catch (_) {
      return null;
    }
  };
  const sanitizeRequestDiagnosticEvents = (events) => {
    const cutoff = Date.now() - REQUEST_DIAGNOSTIC_TTL_MS;
    const perAttempt = new Map();
    const retained = [];
    try {
      const eventCount = ownData(events, "length");
      if (!Array.isArray(events) || !Number.isSafeInteger(eventCount) || eventCount < 0 || eventCount > 1_000_000) return retained;
      const oldestIndex = Math.max(0, eventCount - REQUEST_DIAGNOSTIC_MAX * 4);
      for (let index = eventCount - 1; index >= oldestIndex && retained.length < REQUEST_DIAGNOSTIC_MAX; index--) {
        const event = sanitizeRequestDiagnosticEvent(ownData(events, String(index)), cutoff);
        if (!event) continue;
        const count = perAttempt.get(event.attemptId) || 0;
        if (count >= REQUEST_DIAGNOSTIC_PER_ATTEMPT_MAX) continue;
        perAttempt.set(event.attemptId, count + 1);
        retained.push(event);
      }
      return retained.reverse();
    } catch (_) {
      return [];
    }
  };
  let previousRequestDiagnosticStore;
  try { previousRequestDiagnosticStore = old?.requestDiagnosticStore; } catch (_) {}
  let requestDiagnosticStore = { version: 1, events: [] };
  try {
    const previousVersion = ownData(previousRequestDiagnosticStore, "version");
    const previousEvents = ownData(previousRequestDiagnosticStore, "events");
    if (previousVersion === 1 && Array.isArray(previousEvents))
      requestDiagnosticStore = { version: 1, events: sanitizeRequestDiagnosticEvents(previousEvents) };
  } catch (_) {}
  const pruneRequestDiagnostics = () => {
    requestDiagnosticStore.events = sanitizeRequestDiagnosticEvents(requestDiagnosticStore.events);
  };
  const requestDiagnosticFields = (attempt, payload) => {
    const rows = attempt.mediaType === "image" ? payload?.[1] : payload?.[0];
    const quantity = Array.isArray(rows) && rows.length === attempt.expectedQuantity &&
      (attempt.mediaType !== "image" || payload?.[2] === 1);
    const shape = attempt.mediaType === "image"
      ? payload?.[0] === null && Array.isArray(rows) && rows.every((row) => Array.isArray(row) && typeof row?.[5] === "string" && Array.isArray(row?.[8]?.[0]) && row[8][0].length > 0)
      : Array.isArray(rows) && rows.length > 0 && rows.every((row) => !!decodeVideoInputRow(row));
    let prompt = false;
    if (attempt.mediaType === "image") {
      const promptRows = Array.isArray(rows) ? rows.map((row) => row?.[8]?.[0]) : [];
      prompt = promptRows.length > 0 && promptRows.every((nodes) => {
        if (!Array.isArray(nodes) || !nodes.length) return false;
        if (attempt.structuredPromptFingerprint) {
          const structured = decodeStructuredNodes(nodes);
          return !!structured && structured.fingerprint === attempt.structuredPromptFingerprint &&
            structured.voiceIds.length === 0 && exactRefsMatch(structured.characterIds, attempt.expectedCharacterIds);
        }
        return nodes.every((node) => Array.isArray(node) && typeof node[0] === "string" && node.slice(1).every((part) => part == null)) &&
          promptFingerprint(nodes.map((node) => node[0]).join("")) === attempt.promptFingerprint;
      });
    } else {
      const plain = plainInputSummary(payload);
      const fingerprint = plain?.fingerprint || null;
      const structured = structuredInputFingerprints(payload);
      prompt = attempt.expectedVoiceCount > 0
        ? Array.isArray(rows) && rows.length > 0 && rows.every((row) => {
          const decoded = decodeVideoInputRow(row);
          const nodes = videoInputNodes(row);
          const parsed = decodeStructuredNodes(nodes);
          return !!decoded && !!parsed && parsed.textFingerprint === attempt.promptFingerprint &&
            parsed.voiceIds.length === attempt.expectedVoiceCount && exactRefsMatch(parsed.characterIds, attempt.expectedCharacterIds);
        })
        : attempt.structuredPromptFingerprint
        ? structured.length > 0 && structured.every((value) => value === attempt.structuredPromptFingerprint)
        : fingerprint === attempt.promptFingerprint;
    }
    const expectedModel = attempt.mediaType === "image" ? attempt.expectedImageModelKey : attempt.expectedVideoModelKey;
    const model = expectedModel
      ? Array.isArray(rows) && rows.length > 0 && rows.every((row) => attempt.mediaType === "image" ? row?.[5] === expectedModel : decodeVideoInputRow(row)?.model === expectedModel)
      : null;
    const referenceIds = attempt.mediaType === "image"
      ? Array.isArray(rows) && rows.length > 0 && rows.every((row) => {
        const mediaRows = row?.[2] == null ? [] : row[2];
        const characterRows = row?.[10] == null ? [] : row[10];
        if (!Array.isArray(mediaRows) || mediaRows.some((ref) => !Array.isArray(ref) || typeof ref[0] !== "string" || !UUID_RE.test(ref[0]))) return false;
        if (!Array.isArray(characterRows) || characterRows.some((ref) => !Array.isArray(ref) || ref.length !== 1 || typeof ref[0] !== "string" || !UUID_RE.test(ref[0]))) return false;
        const mediaIds = mediaRows.map((ref) => ref[0]);
        const characterIds = characterRows.map((ref) => ref[0]);
        const mediaMatch = attempt.unverifiedMediaCount > 0
          ? attempt.expectedMediaReferenceIds.every((id) => mediaIds.includes(id)) && mediaIds.length === attempt.expectedMediaReferenceIds.length + attempt.unverifiedMediaCount
          : exactRefsMatch(mediaIds, attempt.expectedMediaReferenceIds);
        const characterMatch = attempt.expectedGlobalCharacter === true
          ? attempt.expectedCharacterIds.length === 0 && characterIds.length === globalCharacterCount(attempt) && normalizedRefs(characterIds).length === characterIds.length
          : exactRefsMatch(characterIds, attempt.expectedCharacterIds);
        return mediaMatch && characterMatch;
      }) && (attempt.unverifiedMediaCount > 0 || refsMatch([...attempt.expectedMediaReferenceIds, ...attempt.expectedCharacterIds], attempt.expectedReferenceIds))
      : Array.isArray(rows) && rows.length > 0 && rows.every((row) => {
        const decoded = decodeVideoInputRow(row);
        return !!decoded && attemptRefsMatch(decoded.refs, attempt);
      });
    const projectValues = attempt.mediaType === "image"
      ? Array.isArray(rows) ? rows.flatMap((row) => [payload?.[3]?.[5], row?.[7]?.[5]]) : []
      : [payload?.[1]?.[5]];
    const project = projectValues.every((value) => typeof value !== "string" || !UUID_RE.test(value) || value === attempt.projectId);
    const droppedReferences = attempt.mediaType === "video" && Array.isArray(rows)
      ? rows.reduce((total, row) => total + (decodeVideoInputRow(row)?.droppedReferences || 0), 0)
      : 0;
    const reasons = [];
    if (!shape) reasons.push("payload_shape_mismatch");
    if (!quantity) reasons.push("quantity_mismatch");
    if (!prompt) reasons.push("prompt_mismatch");
    if (model === false) reasons.push("model_mismatch");
    if (!referenceIds) reasons.push("reference_ids_mismatch");
    if (!project) reasons.push("project_mismatch");
    // The panel renders the request event's reasons, so a dropped
    // reference surfaces there as dropped_references:<n> instead of
    // vanishing silently behind shape=true.
    if (droppedReferences > 0) reasons.push(`dropped_references:${droppedReferences}`);
    return { shape, prompt, model, quantity, referenceIds, project, droppedReferences, reasons };
  };
  const recordRequestDiagnostic = (attempt, call, transport, requestPath, reasons = []) => {
    pruneRequestDiagnostics();
    const attemptEventCount = requestDiagnosticStore.events.filter((entry) => entry.attemptId === attempt.attemptId).length;
    if (attemptEventCount >= REQUEST_DIAGNOSTIC_PER_ATTEMPT_MAX) return;
    const fields = call?.payload ? requestDiagnosticFields(attempt, call.payload) : {
      shape: false, prompt: null, model: null, quantity: null, referenceIds: null, project: null, reasons: ["payload_unparsed"],
    };
    const callReasons = [...new Set([...fields.reasons, ...reasons])].slice(0, 8);
    let payloadVersion = "unknown";
    if (attempt.mediaType === "image" && call?.payload?.[0] === null && Array.isArray(call.payload?.[1]) && call.payload?.[2] === 1) payloadVersion = "image_rows_v1";
    else if (attempt.mediaType === "video" && Array.isArray(call?.payload?.[0]) && call.payload[0].some((row) => !!decodeVideoInputRow(row))) payloadVersion = "video_inputs_v1";
    requestDiagnosticStore.events.push({
      observedAt: Date.now(),
      attemptId: attempt.attemptId,
      mediaType: attempt.mediaType,
      transport: transport === "fetch" ? "fetch" : "xhr",
      path: safeRequestPath(requestPath),
      rpcId: safeRequestRpcId(call?.rpcId),
      payloadVersion,
      payloadShape: call?.payload ? payloadShape(call.payload) : { type: "unparsed_body" },
      pathRecognized: !reasons.includes("request_path_unrecognized"),
      payloadMatched: !!call?.payload && attemptMatchesPayload(call.payload, attempt),
      fields: { shape: fields.shape, prompt: fields.prompt, model: fields.model, quantity: fields.quantity, referenceIds: fields.referenceIds, project: fields.project },
      reasons: callReasons,
    });
    pruneRequestDiagnostics();
  };
  const recordUnmatchedTransport = (requestPath, transport, raw, reason = "request_path_unrecognized") => {
    const active = [...attempts.values()];
    if (!active.length) return;
    const calls = parseCalls(raw);
    if (calls.length) {
      for (const attempt of active)
        for (const call of calls.slice(0, 8)) recordRequestDiagnostic(attempt, call, transport, requestPath, [reason]);
      return;
    }
    for (const attempt of active) recordRequestDiagnostic(attempt, null, transport, requestPath, [reason, "payload_unparsed"]);
  };
  const recordUnmatchedTransportAsync = async (requestPath, transport, raw, reason = "request_path_unrecognized") => {
    const active = [...attempts.values()];
    if (!active.length) return;
    const calls = raw == null ? [] : await parseCallsAsync(raw).catch(() => []);
    if (calls.length) {
      for (const attempt of active)
        for (const call of calls.slice(0, 8)) recordRequestDiagnostic(attempt, call, transport, requestPath, [reason]);
      return;
    }
    for (const attempt of active) recordRequestDiagnostic(attempt, null, transport, requestPath, [reason, "payload_unparsed"]);
  };
  const projectId = () => {
    const parts = location.pathname.split("/").filter(Boolean);
    const projectAt = parts.indexOf("project");
    if (projectAt < 0 || projectAt !== parts.length - 2) return null;
    const prefix = parts.slice(0, projectAt);
    let accountSeen = false;
    let localeSeen = false;
    for (let i = 0; i < prefix.length; i++) {
      if (prefix[i] === "u" && !accountSeen && /^\d+$/.test(prefix[i + 1] || "")) {
        accountSeen = true;
        i++;
        continue;
      }
      if (!localeSeen && /^[a-z]{2,3}(?:-[a-z]{2,4})?$/i.test(prefix[i])) {
        localeSeen = true;
        continue;
      }
      return null;
    }
    const value = parts[projectAt + 1] || "";
    return UUID_RE.test(value) ? value : null;
  };
  const isFlowBatchExecuteUrl = (value) => {
    try {
      const url = new URL(value || "", location.href);
      if (url.origin !== location.origin) return false;
      if (url.pathname === BATCHEXECUTE_PATH) return true;
      const parts = location.pathname.split("/").filter(Boolean);
      const projectAt = parts.indexOf("project");
      if (projectAt <= 0) return false;
      const routePrefix = parts.slice(0, projectAt);
      if (url.pathname === `/${routePrefix.join("/")}${BATCHEXECUTE_PATH}`) return true;
      return (
        routePrefix[0] === "u" &&
        /^\d+$/.test(routePrefix[1] || "") &&
        url.pathname === `/u/${routePrefix[1]}${BATCHEXECUTE_PATH}`
      );
    } catch (_) {
      return false;
    }
  };
  const identityFingerprintLocal = (values) => {
    const input = [...new Set(values || [])].sort().join("|");
    let hash = 2166136261;
    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return `id-${(hash >>> 0).toString(16).padStart(8, "0")}`;
  };
  const requestPayloadFingerprint = (payload) => {
    let serialized;
    try { serialized = JSON.stringify(payload); } catch (_) { return null; }
    if (typeof serialized !== "string") return null;
    let hashA = 2166136261;
    let hashB = 2246822519;
    for (let i = 0; i < serialized.length; i++) {
      const code = serialized.charCodeAt(i);
      hashA = Math.imul(hashA ^ code, 16777619);
      hashB = Math.imul(hashB ^ code, 3266489917);
    }
    return `request-v2:${serialized.length}:${(hashA >>> 0).toString(16)}:${(hashB >>> 0).toString(16)}`;
  };
  const identityFingerprint = codec?.identityFingerprint || identityFingerprintLocal;
  const normalizePromptLocal = (value) =>
    String(value || "")
      .normalize("NFKC")
      .trim()
      .replace(/\s+/g, " ");
  const normalizePrompt = codec?.normalizePrompt || normalizePromptLocal;
  const promptFingerprint = codec?.promptFingerprint || ((value) => identityFingerprint([normalizePrompt(value)]));
  const videoInputNodesLocal = (row) => {
    const canonical = row?.[0]?.[2]?.[0];
    if (Array.isArray(canonical) && canonical.length) return canonical;
    const edit = row?.[1]?.[2]?.[0];
    if (
      row?.[0]?.[0] == null &&
      UUID_RE.test(row?.[0]?.[1] || "") &&
      Number.isInteger(row[0][2]) &&
      Number.isInteger(row[0][3]) &&
      row[0][2] >= 0 &&
      row[0][3] > row[0][2] &&
      typeof row[2] === "string" &&
      Array.isArray(edit) &&
      edit.length
    )
      return edit;
    const observedEightField = row?.[2]?.[0];
    return Array.isArray(observedEightField) && observedEightField.length
      ? observedEightField
      : null;
  };
  const videoInputNodes = codec?.videoInputNodes || videoInputNodesLocal;
  const decodeStructuredNodesLocal = (nodes) => {
    if (!Array.isArray(nodes) || !nodes.length) return null;
    const normalize = (value) =>
      String(value || "")
        .normalize("NFKC")
        .trim()
        .replace(/\s+/g, " ");
    const parts = [];
    const characterIds = [];
    const voiceIds = [];
    for (const node of nodes) {
      if (!Array.isArray(node)) return null;
      if (typeof node[0] === "string" && node.slice(1).every((value) => value == null)) {
        if (parts[parts.length - 1]?.kind === "text") parts[parts.length - 1].text += node[0];
        else parts.push({ kind: "text", text: node[0] });
        continue;
      }
      if (
        node[0] != null ||
        !Array.isArray(node[1]) ||
        node.slice(2).some((value) => value != null)
      )
        return null;
      const ref = node[1];
      if (ref[0] != null) return null;
      let kind, pair;
      if (Array.isArray(ref[1]) && ref.slice(2).every((value) => value == null)) {
        kind = "voice";
        pair = ref[1];
      } else if (
        ref[1] == null &&
        Array.isArray(ref[2]) &&
        ref.slice(3).every((value) => value == null)
      ) {
        kind = "character";
        pair = ref[2];
      } else return null;
      if (
        typeof pair[0] !== "string" ||
        typeof pair[1] !== "string" ||
        pair.slice(2).some((value) => value != null)
      )
        return null;
      if (kind === "character" ? !UUID_RE.test(pair[0]) : !/^voices\/[a-z0-9_-]+$/i.test(pair[0]))
        return null;
      const id = pair[0].toLowerCase();
      parts.push({ kind, id });
      if (kind === "character") characterIds.push(id);
      else voiceIds.push(id);
    }
    if (!parts.some((part) => part.kind !== "text")) return null;
    return {
      fingerprint: promptFingerprint(
        JSON.stringify(
          parts
            .filter((part) => part.kind !== "text" || normalize(part.text))
            .map((part) =>
              part.kind === "text" ? { kind: "text", text: normalize(part.text) } : part
            )
        )
      ),
        textFingerprint: promptFingerprint(parts.filter((part) => part.kind === "text").map((part) => normalize(part.text)).join("")),
      characterIds: normalizedRefs(characterIds),
      voiceIds: [...new Set(voiceIds)].sort(),
    };
  };
  const decodeStructuredNodes = codec?.decodeStructuredNodes || decodeStructuredNodesLocal;
  const structuredInputFingerprints = (payload) => {
    if (!Array.isArray(payload?.[0]) || !payload[0].length) return [];
    return payload[0].map(
      (row) => decodeStructuredNodes(videoInputNodes(row))?.fingerprint || null
    );
  };
  const videoRowModelRatioLocal = (row) => {
    // Mirror of the codec's positional decode (see flow-v2-correlation-codec):
    // the model key is the string at [2], [1] or [4], the ratio enum follows.
    if (typeof row?.[2] === "string") return { model: row[2], ratio: row[3] };
    if (typeof row?.[1] === "string") return { model: row[1], ratio: row[2] };
    if (typeof row?.[4] === "string") return { model: row[4], ratio: row[5] };
    return null;
  };
  const plainInputSummaryLocal = (payload) => {
    const rows = payload?.[0];
    if (!Array.isArray(rows) || !rows.length) return null;
    const values = rows.map((row) => {
      const nodes = videoInputNodes(row);
      if (
        !Array.isArray(nodes) ||
        !nodes.length ||
        nodes.some(
          (node) =>
            !Array.isArray(node) ||
            typeof node[0] !== "string" ||
            node.slice(1).some((v) => v != null)
        )
      )
        return null;
      const normalized = normalizePrompt(nodes.map((node) => node[0]).join(""));
      const decoded = videoRowModelRatioLocal(row);
      return {
        fingerprint: promptFingerprint(normalized),
        anchorFingerprint: promptFingerprint(normalized.slice(0, 512)),
        normalizedLength: normalized.length,
        model: decoded && decoded.model ? decoded.model : null,
        ratio: decoded && Number.isInteger(decoded.ratio) && decoded.ratio >= 1 ? decoded.ratio : null,
      };
    });
    if (!values.every((value) => value && value.fingerprint === values[0].fingerprint)) return null;
    const summary = {
      fingerprint: values[0].fingerprint,
      anchorFingerprint: values[0].anchorFingerprint,
      normalizedLength: values[0].normalizedLength,
    };
    // VID-03 (mirror of the codec summary): carry the wire model key and
    // ratio enum only when every row decodes the same value; otherwise the
    // key stays absent, which matchers treat as "don't care".
    if (values.every((value) => value.model !== null && value.model === values[0].model)) summary.model = values[0].model;
    if (values.every((value) => value.ratio !== null && value.ratio === values[0].ratio)) summary.ratio = values[0].ratio;
    return summary;
  };
  const plainInputSummary = codec?.plainInputSummary || plainInputSummaryLocal;
  const plainInputFingerprint = (payload) => plainInputSummary(payload)?.fingerprint || null;
  const normalizedRefs = (ids) =>
    [...new Set((ids || []).map((id) => String(id).toLowerCase()))].sort();
  const refsMatch = (actual, expected) =>
    actual.every((id) => typeof id === "string" && UUID_RE.test(id)) &&
    JSON.stringify(normalizedRefs(actual)) === JSON.stringify(normalizedRefs(expected));
  const exactRefsMatch = (actual, expected) =>
    Array.isArray(actual) &&
    Array.isArray(expected) &&
    actual.length === normalizedRefs(actual).length &&
    expected.length === normalizedRefs(expected).length &&
    refsMatch(actual, expected);
  const globalCharacterCount = (attempt) =>
    attempt.expectedGlobalCharacter === true
      ? Math.max(1, Number(attempt.expectedGlobalCharacterCount) || 1)
      : 0;
  const attemptRefsMatch = (actual, attempt) => {
    if (attempt.unverifiedMediaCount > 0) {
      const actualIds = normalizedRefs(actual);
      const expectedIds = normalizedRefs(attempt.expectedReferenceIds);
      const extraCount = globalCharacterCount(attempt) + attempt.unverifiedMediaCount;
      return (
        actual.every((id) => typeof id === "string" && UUID_RE.test(id)) &&
        actual.length === actualIds.length &&
        actualIds.length === expectedIds.length + extraCount &&
        expectedIds.every((id) => actualIds.includes(id))
      );
    }
    if (attempt.expectedGlobalCharacter !== true)
      return refsMatch(actual, attempt.expectedReferenceIds);
    const actualIds = normalizedRefs(actual);
    const expectedIds = normalizedRefs(attempt.expectedReferenceIds);
    return (
      actual.every((id) => typeof id === "string" && UUID_RE.test(id)) &&
      actual.length === actualIds.length &&
      actualIds.length === expectedIds.length + globalCharacterCount(attempt) &&
      expectedIds.every((id) => actualIds.includes(id))
    );
  };
  const decodeVideoInputRow = (row) => {
    if (!Array.isArray(row) || !videoInputNodes(row)) return null;
    let model,
      ratio,
      referenceSlots,
      entitySlot = null;
    if (typeof row[2] === "string") {
      model = row[2];
      ratio = row[3];
      if (row[0]?.[0] == null && UUID_RE.test(row[0]?.[1] || "")) {
        referenceSlots = [row[0], row[8]];
      } else if (Array.isArray(row[0]) && row[0].every((entry) => Array.isArray(entry))) {
        // row[0] is a reference LIST (frame refs, then the prompt nodes
        // nested as a structural entry): it used to fall into the else
        // branch below and its refs were never read at all. Read the
        // list as an extra slot, keeping the proven row[1]/row[9] slots
        // exactly as before; no further slot is guessed.
        referenceSlots = [row[0], row[1]];
        entitySlot = row[9];
      } else {
        referenceSlots = [row[1]];
        entitySlot = row[9];
      }
    } else if (typeof row[1] === "string") {
      model = row[1];
      ratio = row[2];
      referenceSlots = [row[3], row[4], row[5], row[6]];
    } else if (typeof row[4] === "string") {
      model = row[4];
      ratio = row[5];
      referenceSlots = [row[3]];
    } else return null;
    if (!Number.isInteger(ratio) || ratio < 1) return null;
    const refs = [];
    let droppedReferences = 0;
    for (const slot of referenceSlots) {
      if (slot == null) continue;
      if (!Array.isArray(slot)) return null;
      if (slot[0] == null && typeof slot[1] === "string" && UUID_RE.test(slot[1])) {
        refs.push(slot[1]);
        continue;
      }
      if (!slot.length || !slot.every((ref) => Array.isArray(ref))) continue;
      for (const ref of slot) {
        // A list slot can carry structural (non-reference) entries — e.g.
        // the prompt nodes nested in a row[0] list. Those are not
        // references at all and are skipped silently, not counted.
        if (Array.isArray(ref[0])) continue;
        const id = ref[0] == null ? ref[1] : ref[0];
        if (typeof id !== "string" || !UUID_RE.test(id)) {
          // One bad entry used to drop the WHOLE list while decode
          // still reported shape=true — a silent reference loss. Keep
          // every valid ref and count only the bad entries, so the
          // panel can show exactly what was dropped.
          droppedReferences += 1;
          continue;
        }
        refs.push(id);
      }
    }
    if (entitySlot != null) {
      if (!Array.isArray(entitySlot)) return null;
      for (const ref of entitySlot) {
        if (
          !Array.isArray(ref) ||
          ref.length !== 1 ||
          typeof ref[0] !== "string" ||
          !UUID_RE.test(ref[0])
        )
          return null;
        refs.push(ref[0]);
      }
    }
    for (const node of videoInputNodes(row) || []) {
      const characterId = node?.[1]?.[2]?.[0];
      if (typeof characterId === "string" && UUID_RE.test(characterId)) refs.push(characterId);
    }
    return { model, ratio, refs, droppedReferences };
  };
  const requestVariants = (attempt) => {
    const refs =
      attempt.refMatchVersion === 1 && Array.isArray(attempt.expectedReferenceIds)
        ? normalizedRefs(attempt.expectedReferenceIds)
        : null;
    const model =
      attempt.mediaType === "image" ? attempt.expectedImageModelKey : attempt.expectedVideoModelKey;
    const variants = [
      {
        kind: attempt.structuredPromptFingerprint ? "structured" : "plain",
        hash: attempt.structuredPromptFingerprint || attempt.promptFingerprint,
        model,
        ratio: attempt.expectedVideoRatioEnum,
        refs,
        globalCharacter: globalCharacterCount(attempt),
      },
    ];
    if (
      attempt.structuredPromptFingerprint &&
      attempt.normalizedVoiceFingerprint &&
      attempt.normalizedVideoModelKey &&
      (!refs || refs.length === 0)
    )
      variants.push({
        kind: "plain",
        hash: attempt.normalizedVoiceFingerprint,
        model: attempt.normalizedVideoModelKey,
        ratio: attempt.expectedVideoRatioEnum,
        refs,
      });
    return variants;
  };
  const attemptsOverlap = (left, right) =>
    left.mediaType === right.mediaType &&
    (left.mediaType === "image" || left.expectedQuantity === right.expectedQuantity) &&
    requestVariants(left).some((a) =>
      requestVariants(right).some(
        (b) =>
          a.kind === b.kind &&
          a.hash === b.hash &&
          (!a.model || !b.model || a.model === b.model) &&
          (!a.ratio || !b.ratio || a.ratio === b.ratio) &&
          a.globalCharacter === b.globalCharacter &&
          (!a.refs || !b.refs || JSON.stringify(a.refs) === JSON.stringify(b.refs))
      )
    );
  const imageInputMatches = (payload, attempt) => {
    const rows = payload?.[1];
    if (
      payload?.[0] != null ||
      payload?.[2] !== 1 ||
      !Array.isArray(rows) ||
      rows.length !== attempt.expectedQuantity
    )
      return false;
    if (attempt.unverifiedMediaCount === 0) {
      if (
        !refsMatch(
          [...attempt.expectedMediaReferenceIds, ...attempt.expectedCharacterIds],
          attempt.expectedReferenceIds
        )
      )
        return false;
    }
    return rows.every((row) => {
      const nodes = row?.[8]?.[0];
      if (typeof row?.[5] !== "string" || !Array.isArray(nodes) || !nodes.length) return false;
      if (attempt.expectedImageModelKey && row[5] !== attempt.expectedImageModelKey) return false;
      for (const declared of [payload?.[3]?.[5], row?.[7]?.[5]]) {
        if (
          typeof declared === "string" &&
          UUID_RE.test(declared) &&
          declared !== attempt.projectId
        )
          return false;
      }
      if (
        row[2] != null &&
        (!Array.isArray(row[2]) ||
          row[2].some(
            (ref) => !Array.isArray(ref) || typeof ref[0] !== "string" || !UUID_RE.test(ref[0])
          ))
      )
        return false;
      const mediaRefs = (row[2] || []).map((ref) => ref[0]);
      if (attempt.unverifiedMediaCount > 0) {
        const hasAllExpected = attempt.expectedMediaReferenceIds.every((id) => mediaRefs.includes(id));
        const countMatches = mediaRefs.length === attempt.expectedMediaReferenceIds.length + attempt.unverifiedMediaCount;
        if (!hasAllExpected || !countMatches) return false;
      } else {
        if (!exactRefsMatch(mediaRefs, attempt.expectedMediaReferenceIds)) return false;
      }
      const declaredCharacters = row[10] == null ? [] : row[10];
      if (
        !Array.isArray(declaredCharacters) ||
        declaredCharacters.some(
          (ref) =>
            !Array.isArray(ref) ||
            ref.length !== 1 ||
            typeof ref[0] !== "string" ||
            !UUID_RE.test(ref[0])
        )
      )
        return false;
      const declaredCharacterIds = declaredCharacters.map((ref) => ref[0]);
      if (attempt.expectedGlobalCharacter === true) {
        if (
          attempt.expectedCharacterIds.length !== 0 ||
          declaredCharacterIds.length !== globalCharacterCount(attempt) ||
          normalizedRefs(declaredCharacterIds).length !== declaredCharacterIds.length
        )
          return false;
      } else if (!exactRefsMatch(declaredCharacterIds, attempt.expectedCharacterIds)) return false;
      if (attempt.structuredPromptFingerprint) {
        const structured = decodeStructuredNodes(nodes);
        return (
          !!structured &&
          structured.fingerprint === attempt.structuredPromptFingerprint &&
          structured.voiceIds.length === 0 &&
          exactRefsMatch(structured.characterIds, attempt.expectedCharacterIds)
        );
      }
      if (
        (!attempt.expectedGlobalCharacter && attempt.expectedCharacterIds.length > 0) ||
        nodes.some(
          (node) =>
            !Array.isArray(node) ||
            typeof node[0] !== "string" ||
            node.slice(1).some((value) => value != null)
        )
      )
        return false;
      return promptFingerprint(nodes.map((node) => node[0]).join("")) === attempt.promptFingerprint;
    });
  };
  const attemptMatchesPayload = (payload, attempt) => {
    if (attempt.mediaType === "image") return imageInputMatches(payload, attempt);
    const declaredProject = payload?.[1]?.[5];
    if (
      typeof declaredProject === "string" &&
      UUID_RE.test(declaredProject) &&
      declaredProject !== attempt.projectId
    )
      return false;
    const plainSummary = plainInputSummary(payload);
    const plain = plainSummary?.fingerprint || null;
    const row = payload?.[0]?.[0];
    if (attempt.mediaType === "video") {
      const rows = payload?.[0];
      if (!Array.isArray(rows) || !rows.length || rows.length > attempt.expectedQuantity)
        return false;
      for (const input of rows) {
        const decoded = decodeVideoInputRow(input);
        if (!decoded || typeof decoded.model !== "string") return false;
        const expected =
          plain && attempt.structuredPromptFingerprint
            ? attempt.normalizedVideoModelKey
            : attempt.expectedVideoModelKey;
        if (expected && decoded.model !== expected) return false;
        if (attempt.expectedVideoRatioEnum && decoded.ratio !== attempt.expectedVideoRatioEnum)
          return false;
        if (!attemptRefsMatch(decoded.refs, attempt)) return false;
      }
      if (rows.length !== attempt.expectedQuantity) return false;
    }
    if (attempt.expectedVoiceCount > 0) {
      if (attempt.mediaType !== "video") return false;
      return payload[0].every((input) => {
        const decoded = decodeVideoInputRow(input);
        const parsed = decodeStructuredNodes(videoInputNodes(input));
        return !!decoded && !!parsed && parsed.textFingerprint === attempt.promptFingerprint &&
          parsed.voiceIds.length === attempt.expectedVoiceCount && exactRefsMatch(parsed.characterIds, attempt.expectedCharacterIds);
      });
    }
    if (!attempt.structuredPromptFingerprint) {
      if (plain === attempt.promptFingerprint) return true;
      return (
        !!attempt.promptAnchorFingerprint &&
        attempt.promptNormalizedLength > 4096 &&
        plainSummary?.anchorFingerprint === attempt.promptAnchorFingerprint &&
        plainSummary.normalizedLength > 0 &&
        plainSummary.normalizedLength <= attempt.promptNormalizedLength
      );
    }
    const fingerprints = structuredInputFingerprints(payload);
    if (
      fingerprints.length &&
      fingerprints.every((value) => value === attempt.structuredPromptFingerprint)
    )
      return true;
    return (
      !!attempt.normalizedVoiceFingerprint &&
      !!attempt.normalizedVideoModelKey &&
      attempt.mediaType === "video" &&
      payload?.[1]?.[5] === attempt.projectId &&
      payload[0].length === 1 &&
      plain === attempt.normalizedVoiceFingerprint
    );
  };
  // Videofix M-C: prompt-only verdict for video attempts, mirroring the
  // prompt branches of attemptMatchesPayload without the row checks. The
  // prompt is the identity anchor of a weak match and is never waived.
  const videoPromptMatches = (payload, attempt) => {
    const plainSummary = plainInputSummary(payload);
    const plain = plainSummary?.fingerprint || null;
    if (!attempt.structuredPromptFingerprint) {
      if (plain === attempt.promptFingerprint) return true;
      return (
        !!attempt.promptAnchorFingerprint &&
        attempt.promptNormalizedLength > 4096 &&
        plainSummary?.anchorFingerprint === attempt.promptAnchorFingerprint &&
        plainSummary.normalizedLength > 0 &&
        plainSummary.normalizedLength <= attempt.promptNormalizedLength
      );
    }
    const fingerprints = structuredInputFingerprints(payload);
    if (
      fingerprints.length &&
      fingerprints.every((value) => value === attempt.structuredPromptFingerprint)
    )
      return true;
    return (
      !!attempt.normalizedVoiceFingerprint &&
      !!attempt.normalizedVideoModelKey &&
      attempt.mediaType === "video" &&
      payload?.[1]?.[5] === attempt.projectId &&
      payload[0].length === 1 &&
      plain === attempt.normalizedVoiceFingerprint
    );
  };
  // Videofix M-C: weak acceptance for requestSeen. Returns the single
  // deviating field group ("quantity" | "refs"), or false when the
  // request is not a weak match. Rules:
  // - video only, non-voice attempts only (voice jobs keep strict matching);
  // - the prompt must match exactly, and the project gate still applies;
  // - model and ratio are HARD requirements, never weak deviations:
  //   they determine the output media, so a different model/ratio is a
  //   different generation (VID-03 pins this as identity), and the
  //   observer has no wire-key registry to tell a renamed key for the
  //   same model apart from a genuinely different model — the label
  //   alias table cannot serve as one, since it lumps every veo variant
  //   together. Narrowing weak matching to quantity/refs keeps the
  //   rescue for Flow repackaging a request (split/merge rows, injected
  //   refs) without ever claiming media the job did not ask for;
  // - refs may only deviate as a superset: every expected id present, all
  //   ids valid UUIDs, at most 2 injected extras beyond the counts the
  //   strict matcher already allows (global character + unverified).
  // A wholly different prompt, a replaced ref set, a different model or
  // ratio, or two simultaneous deviations are all still rejected, so an
  // unrelated request can never be claimed by an attempt through this
  // branch.
  const attemptVideoWeakMatch = (payload, attempt) => {
    if (attempt.mediaType !== "video" || attempt.expectedVoiceCount > 0) return false;
    const rows = payload?.[0];
    if (!Array.isArray(rows) || !rows.length) return false;
    if (!videoPromptMatches(payload, attempt)) return false;
    const declaredProject = payload?.[1]?.[5];
    if (
      typeof declaredProject === "string" &&
      UUID_RE.test(declaredProject) &&
      declaredProject !== attempt.projectId
    )
      return false;
    const plainSummary = plainInputSummary(payload);
    const plain = plainSummary?.fingerprint || null;
    const expectedModel =
      plain && attempt.structuredPromptFingerprint
        ? attempt.normalizedVideoModelKey
        : attempt.expectedVideoModelKey;
    let modelOk = true;
    let ratioOk = true;
    const allRefs = [];
    for (const input of rows) {
      const decoded = decodeVideoInputRow(input);
      if (!decoded || typeof decoded.model !== "string") return false;
      if (expectedModel && decoded.model !== expectedModel) modelOk = false;
      if (attempt.expectedVideoRatioEnum && decoded.ratio !== attempt.expectedVideoRatioEnum)
        ratioOk = false;
      allRefs.push(...decoded.refs);
    }
    // Model and ratio are output identity (see above): any deviation
    // here rejects outright, whatever the other fields say.
    if (!modelOk || !ratioOk) return false;
    const quantityOk = rows.length === attempt.expectedQuantity;
    const refsStrict = attemptRefsMatch(allRefs, attempt);
    // A superset deviation is a weak acceptance, NOT a failure entry: the
    // caller must report "refs" for it, while a hard refs failure (a
    // replaced set, a subset, bad ids) must never report "refs" — it is
    // a rejection, not a weak match. Keeping the two separate is what
    // stops a replaced reference set from claiming the attempt.
    let refsWeak = false;
    if (!refsStrict) {
      const actualIds = normalizedRefs(allRefs);
      const expectedIds = normalizedRefs(attempt.expectedReferenceIds);
      const allowed =
        expectedIds.length + globalCharacterCount(attempt) + (attempt.unverifiedMediaCount || 0);
      refsWeak =
        allRefs.every((id) => typeof id === "string" && UUID_RE.test(id)) &&
        actualIds.length === allRefs.length &&
        expectedIds.every((id) => actualIds.includes(id)) &&
        actualIds.length > allowed &&
        actualIds.length <= allowed + 2;
    }
    const failures = [
      !quantityOk ? "quantity" : null,
      !refsStrict && !refsWeak ? "refs" : null,
    ].filter(Boolean);
    if (failures.length === 0) return refsWeak ? "refs" : false;
    // A lone "refs" entry is a hard refs failure, never a weak reason;
    // and any hard failure combined with a weak refs deviation is two
    // deviations, not one. Only a lone quantity deviation is a weak
    // match (besides the refs-superset case above).
    if (failures.length === 1 && !refsWeak && failures[0] !== "refs") return failures[0];
    return false;
  };
  // Videofix M-C: the single generation-request claim check, used both
  // by candidacy (eligibleAttempt) and by the fetch/XHR begin gates, so a
  // weak match is never claimed in one place and demoted in the other.
  const attemptClaimsGenerationRequest = (payload, attempt) =>
    attemptMatchesPayload(payload, attempt) || attemptVideoWeakMatch(payload, attempt) !== false;
  const videoInputDiagnostic = (payload, attempt) => {
    if (attempt.mediaType !== "video" || !Array.isArray(payload?.[0]) || !payload[0].length)
      return null;
    const summary = plainInputSummary(payload);
    let quantity = payload[0].length;
    const models = [];
    const ratios = [];
    const refs = [];
    let droppedReferenceCount = 0;
    for (const input of payload[0]) {
      const decoded = decodeVideoInputRow(input);
      if (!decoded || typeof decoded.model !== "string") return null;
      models.push(decoded.model);
      ratios.push(decoded.ratio);
      refs.push(...decoded.refs);
      droppedReferenceCount += decoded.droppedReferences || 0;
    }
    const actualRefs = normalizedRefs(
      refs.filter((id) => typeof id === "string" && UUID_RE.test(id))
    );
    const expectedRefs = normalizedRefs(attempt.expectedReferenceIds);
    return {
      promptExact: summary?.fingerprint === attempt.promptFingerprint,
      promptAnchorMatched:
        !!attempt.promptAnchorFingerprint &&
        summary?.anchorFingerprint === attempt.promptAnchorFingerprint,
      actualPromptLength: summary?.normalizedLength || 0,
      modelMatched:
        !attempt.expectedVideoModelKey ||
        models.every((model) => model === attempt.expectedVideoModelKey),
      ratioMatched:
        !attempt.expectedVideoRatioEnum ||
        ratios.every((ratio) => ratio === attempt.expectedVideoRatioEnum),
      quantityMatched: quantity === attempt.expectedQuantity,
      referencesMatched: attemptRefsMatch(actualRefs, attempt),
      actualReferenceCount: actualRefs.length,
      expectedReferenceCount: expectedRefs.length + globalCharacterCount(attempt) + (attempt.unverifiedMediaCount || 0),
      droppedReferenceCount,
    };
  };
  const imageInputDiagnostic = (payload, attempt) => {
    if (attempt.mediaType !== "image") return null;
    const row = payload?.[1]?.[0];
    if (!Array.isArray(row)) return null;
    const mediaRefs = (row[2] || [])
      .map((ref) => ref?.[0])
      .filter((id) => typeof id === "string" && UUID_RE.test(id));
    const characterRefs = (row[10] || [])
      .map((ref) => ref?.[0])
      .filter((id) => typeof id === "string" && UUID_RE.test(id));
    const mediaMatch = attempt.unverifiedMediaCount > 0
      ? attempt.expectedMediaReferenceIds.every((id) => mediaRefs.includes(id)) && mediaRefs.length === attempt.expectedMediaReferenceIds.length + attempt.unverifiedMediaCount
      : exactRefsMatch(mediaRefs, attempt.expectedMediaReferenceIds);
    return {
      referencesMatched:
        mediaMatch &&
        (attempt.expectedGlobalCharacter === true
          ? attempt.expectedCharacterIds.length === 0 &&
            characterRefs.length === globalCharacterCount(attempt) &&
            normalizedRefs(characterRefs).length === characterRefs.length
          : exactRefsMatch(characterRefs, attempt.expectedCharacterIds)),
      actualReferenceCount: mediaRefs.length + characterRefs.length,
      expectedReferenceCount:
        attempt.expectedMediaReferenceIds.length +
        attempt.expectedCharacterIds.length +
        globalCharacterCount(attempt) +
        (attempt.unverifiedMediaCount || 0),
    };
  };
  const retireUnbound = (attempt) => {
    for (const signature of attempt.completedNoOwnership ? [] : attempt.requestSignatures || []) {
      if (retired.requestSignatures.includes(signature)) continue;
      if (retired.requestSignatures.length >= 256) retired.saturated = true;
      else retired.requestSignatures.push(signature);
    }
    if (attempt.requestCount >= attempt.requestCardinality) return;
    // M-D: bound the block — expired entries leave before the cap check
    // so a stale block cannot wedge the list at 256 forever.
    pruneRetiredEntries();
    if (retired.entries.length >= 256) {
      retired.saturated = true;
      return;
    }
    retired.entries.push({
      expiresAt: Date.now() + RETIRED_ENTRY_TTL_MS,
      projectId: attempt.projectId,
      mediaType: attempt.mediaType,
      expectedQuantity: attempt.expectedQuantity,
      promptFingerprint: attempt.promptFingerprint,
      generationFingerprint: attempt.generationFingerprint,
      structuredPromptFingerprint: attempt.structuredPromptFingerprint,
      normalizedVoiceFingerprint: attempt.normalizedVoiceFingerprint,
      expectedImageModelKey: attempt.expectedImageModelKey,
      expectedReferenceIds: attempt.expectedReferenceIds,
      expectedMediaReferenceIds: attempt.expectedMediaReferenceIds,
      expectedCharacterIds: attempt.expectedCharacterIds,
      expectedGlobalCharacter: attempt.expectedGlobalCharacter === true,
      expectedGlobalCharacterCount: globalCharacterCount(attempt),
      refMatchVersion: attempt.refMatchVersion,
      expectedVideoModelKey: attempt.expectedVideoModelKey,
      expectedVideoRatioEnum: attempt.expectedVideoRatioEnum,
      normalizedVideoModelKey: attempt.normalizedVideoModelKey,
    });
  };
  const emit = (attempt, stage, detail = {}) => {
    const payload = {
      schemaVersion: VERSION,
      nonce: attempt.nonce,
      attemptId: attempt.attemptId,
      stage,
      mediaType: attempt.mediaType,
      expectedQuantity: attempt.expectedQuantity,
      generationFingerprint: attempt.generationFingerprint || null,
      projectId: projectId(),
      observedAt: Date.now(),
      ...detail,
    };
    window.dispatchEvent(new CustomEvent(RECEIPT, { detail: payload }));
    window.dispatchEvent(new CustomEvent(RECEIPT_V2, { detail: payload }));
  };
  const parseCalls = (raw, context = {}) => {
    try {
      let fReq = null;
      if (typeof FormData !== "undefined" && raw instanceof FormData) {
        const value = raw.get("f.req");
        fReq = typeof value === "string" ? value : null;
      } else if (raw instanceof URLSearchParams) {
        fReq = raw.get("f.req");
      } else if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) {
        const bytes =
          raw instanceof ArrayBuffer
            ? new Uint8Array(raw)
            : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
        fReq = new URLSearchParams(new TextDecoder().decode(bytes)).get("f.req");
      } else {
        fReq = new URLSearchParams(typeof raw === "string" ? raw : String(raw || "")).get("f.req");
      }
      const envelope = JSON.parse(fReq || "null");
      return (Array.isArray(envelope?.[0]) ? envelope[0] : []).filter(Array.isArray).map((row) => ({
        rpcId: typeof row[0] === "string" ? row[0] : null,
        requestPath: context.requestPath || null,
        transport: context.transport || null,
        payload: (() => {
          try {
            return typeof row[1] === "string" ? JSON.parse(row[1]) : row[1];
          } catch (_) {
            return null;
          }
        })(),
      }));
    } catch (_) {
      return [];
    }
  };
  const parseCallsAsync = async (raw, immediate = parseCalls(raw), context = {}) => {
    if (immediate.length > 0) return immediate;
    try {
      if (typeof Blob !== "undefined" && raw instanceof Blob) {
        return parseCalls(await raw.text(), context);
      }
      if (raw && typeof raw.text === "function") {
        return parseCalls(await raw.text(), context);
      }
    } catch (_) {}
    return [];
  };
  const decodeResponse = (text, rootsOnly = false) => {
    if (text && typeof text === "object") {
      const decoded2 = [];
      const walk2 = (value, depth = 0) => {
        if (depth > 24) return;
        if (
          typeof value === "string" &&
          (value.trim().startsWith("[") || value.trim().startsWith("{"))
        ) {
          try {
            const parsed = JSON.parse(value);
            decoded2.push(parsed);
            walk2(parsed, depth + 1);
          } catch (_) {}
        } else if (Array.isArray(value)) value.forEach((v) => walk2(v, depth + 1));
        else if (value && typeof value === "object")
          Object.values(value).forEach((v) => walk2(v, depth + 1));
      };
      walk2(text);
      return { roots: [text], decoded: decoded2 };
    }
    const roots = [];
    for (const line of String(text || "").split(/\r?\n/)) {
      const s = line.trim();
      if (!s.startsWith("[") && !s.startsWith("{")) continue;
      try {
        roots.push(JSON.parse(s));
      } catch (_) {}
    }
    const decoded = [];
    if (rootsOnly) return { roots, decoded };
    const walk = (value, depth = 0) => {
      if (depth > 24) return;
      if (typeof value === "string" && (value.startsWith("[") || value.startsWith("{"))) {
        try {
          const parsed = JSON.parse(value);
          decoded.push(parsed);
          walk(parsed, depth + 1);
        } catch (_) {}
      } else if (Array.isArray(value)) value.forEach((v) => walk(v, depth + 1));
      else if (value && typeof value === "object")
        Object.values(value).forEach((v) => walk(v, depth + 1));
    };
    roots.forEach((root) => walk(root));
    return { roots, decoded };
  };
  const MEDIA_SCHEMA = "TOBY_FLOW_NATIVE_MEDIA_SCHEMA";
  const MEDIA_SCHEMA_READ = "TOBY_FLOW_NATIVE_MEDIA_SCHEMA_READ";
  const MEDIA_RESPONSE_MAX_CHARS = 8 * 1024 * 1024;
  const MEDIA_IDENTITY_MAX_ALIASES = 4096;
  let mediaLimitDiagnosticBudget = 4;
  let mediaSchema = null,
    mediaSchemaFingerprint = null,
    mediaSchemaEpoch = 0;
  const mediaSchemaSession = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
  const pendingMediaResponses = [];
  let pendingMediaBytes = 0,
    lastNativeMediaResponse = null;
  const mediaPath = (value, path) => {
    for (const index of path) {
      if (!Array.isArray(value)) return void 0;
      value = value[index];
    }
    return value;
  };
  const validateMediaSchema = (value) => {
    const only = (object, keys) =>
      object &&
      typeof object === "object" &&
      !Array.isArray(object) &&
      Object.keys(object).every((key) => keys.includes(key));
    if (
      !only(value, [
        "version",
        "enabled",
        "collection_path",
        "uuid_path",
        "project_path",
        "generation_path",
        "details_path",
        "media_types",
      ]) ||
      value.version !== 1 ||
      typeof value.enabled !== "boolean"
    )
      return null;
    if (!value.enabled) return { version: 1, enabled: false };
    const path = (p) =>
      Array.isArray(p) &&
      p.length > 0 &&
      p.length <= 8 &&
      p.every((index) => Number.isInteger(index) && index >= 0 && index <= 128);
    const fields = [
      "collection_path",
      "uuid_path",
      "project_path",
      "generation_path",
      "details_path",
    ];
    if (
      fields.some((key) => !path(value[key])) ||
      !Array.isArray(value.media_types) ||
      value.media_types.length !== 2 ||
      new Set(value.media_types.map((type) => type?.type)).size !== 2
    )
      return null;
    const kinds = ["string", "integer", "positive_integer", "positive_integer_pair"];
    for (const type of value.media_types) {
      if (
        !only(type, ["type", "rules", "asb_url_paths"]) ||
        !["image", "video"].includes(type?.type) ||
        !Array.isArray(type.rules) ||
        !type.rules.length ||
        type.rules.length > 8 ||
        !Array.isArray(type.asb_url_paths) ||
        !type.asb_url_paths.length ||
        type.asb_url_paths.length > 8 ||
        type.asb_url_paths.some((p) => !path(p))
      )
        return null;
      for (const rule of type.rules)
        if (
          !only(rule, ["all"]) ||
          !Array.isArray(rule?.all) ||
          !rule.all.length ||
          rule.all.length > 8 ||
          rule.all.some(
            (check) =>
              !only(check, ["path", "kind"]) || !path(check?.path) || !kinds.includes(check?.kind)
          )
        )
          return null;
    }
    return {
      version: 1,
      enabled: true,
      ...Object.fromEntries(fields.map((key) => [key, [...value[key]]])),
      media_types: value.media_types.map((type) => ({
        type: type.type,
        asb_url_paths: type.asb_url_paths.map((p) => [...p]),
        rules: type.rules.map((rule) => ({
          all: rule.all.map((check) => ({ path: [...check.path], kind: check.kind })),
        })),
      })),
    };
  };
  const matchesMediaCheck = (row, check) => {
    const value = mediaPath(row, check.path);
    if (check.kind === "string") return typeof value === "string";
    if (check.kind === "integer") return Number.isInteger(value);
    if (check.kind === "positive_integer") return Number.isInteger(value) && value > 0;
    return (
      Array.isArray(value) && value.length === 2 && value.every((n) => Number.isInteger(n) && n > 0)
    );
  };
  const publishMediaIdentities = () => {
    if (mediaIdentityProject !== projectId()?.toLowerCase()) return;
    window.dispatchEvent(
      new CustomEvent(MEDIA_IDENTITIES, {
        detail: {
          projectId: mediaIdentityProject,
          schemaEpoch: mediaSchemaSession + "." + mediaSchemaEpoch,
          entries: [...mediaIdentities].map(([asb, mediaUuid]) => ({
            asb,
            mediaUuid,
            mediaType: mediaIdentityTypes.get(asb),
          })),
        },
      })
    );
  };
  const observeMediaIdentities = (text, status) => {
    if (disposed || status < 200 || status >= 300 || typeof text !== "string") return;
    if (text.length > MEDIA_RESPONSE_MAX_CHARS) {
      if (mediaLimitDiagnosticBudget-- > 0)
        console.info(
          "[FlowNativeMediaIdentity] response rejected",
          JSON.stringify({
            reason: "response_size_limit",
            characters: text.length,
            maxCharacters: MEDIA_RESPONSE_MAX_CHARS,
          })
        );
      return;
    }
    const currentProject = projectId()?.toLowerCase();
    if (!UUID_RE.test(currentProject || "")) return;
    if (!mediaSchema) {
      pendingMediaResponses.push({ text, status, project: currentProject });
      pendingMediaBytes += text.length;
      while (pendingMediaResponses.length > 8 || pendingMediaBytes > MEDIA_RESPONSE_MAX_CHARS)
        pendingMediaBytes -= pendingMediaResponses.shift().text.length;
      return;
    }
    if (!mediaSchema.enabled) return;
    if (mediaIdentityProject !== currentProject) {
      mediaIdentities.clear();
      mediaIdentityTypes.clear();
      lastNativeMediaResponse = null;
      mediaIdentityProject = currentProject;
    }
    const parsed = decodeResponse(text, true);
    let remaining = 2e4,
      changed = false;
    const audit = {
      rpcIds: new Set(),
      rows: 0,
      imageRows: 0,
      videoRows: 0,
      untypedRows: 0,
      conflicts: 0,
      cappedAliases: 0,
    };
    const walk = (value, depth = 0) => {
      if (--remaining < 0 || depth > 24 || !Array.isArray(value)) return null;
      const rowUuid = mediaPath(value, mediaSchema.uuid_path),
        rowProject = mediaPath(value, mediaSchema.project_path);
      const rowGeneration = mediaPath(value, mediaSchema.generation_path),
        details = mediaPath(value, mediaSchema.details_path);
      const matched = mediaSchema.media_types.filter((type) =>
        type.rules.some((rule) => rule.all.every((check) => matchesMediaCheck(value, check)))
      );
      const mediaType = matched.length === 1 ? matched[0].type : null;
      const isVideo = mediaType === "video",
        isImage = mediaType === "image";
      if (
        UUID_RE.test(rowUuid || "") &&
        rowProject?.toLowerCase?.() === currentProject &&
        UUID_RE.test(rowGeneration || "") &&
        Array.isArray(details)
      ) {
        audit.rows++;
        if (isVideo) audit.videoRows++;
        else if (isImage) audit.imageRows++;
        else audit.untypedRows++;
      }
      if (
        UUID_RE.test(rowUuid || "") &&
        rowProject?.toLowerCase?.() === currentProject &&
        UUID_RE.test(rowGeneration || "") &&
        Array.isArray(details) &&
        mediaType
      ) {
        let orderedAsb = null;
        for (const path of matched[0].asb_url_paths) {
          const url = mediaPath(value, path);
          if (typeof url !== "string") continue;
          const match = url.match(
            /^https:\/\/(?:flow\.google\.com|lh3\.googleusercontent\.com)\/asb\/([A-Za-z0-9_-]{32,1024})(?:=[A-Za-z0-9,=_-]+)?(?:\?[^#]*)?$/
          );
          if (!match) continue;
          const asb = match[1],
            uuid = rowUuid.toLowerCase();
          if (!orderedAsb) orderedAsb = asb;
          if (mediaIdentities.has(asb)) {
            const oldUuid = mediaIdentities.get(asb);
            if (
              (oldUuid !== uuid || mediaIdentityTypes.get(asb) !== mediaType) &&
              oldUuid !== null
            ) {
              mediaIdentities.set(asb, null);
              changed = true;
              audit.conflicts++;
            }
          } else if (mediaIdentities.size < MEDIA_IDENTITY_MAX_ALIASES) {
            mediaIdentities.set(asb, uuid);
            mediaIdentityTypes.set(asb, mediaType);
            changed = true;
          } else audit.cappedAliases++;
        }
        return orderedAsb;
      }
      return null;
    };
    const walkFrame = (frame, depth = 0) => {
      if (--remaining < 0 || depth > 6 || !Array.isArray(frame)) return;
      if (frame[0] === "wrb.fr" && typeof frame[2] === "string") {
        if (typeof frame[1] === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(frame[1]))
          audit.rpcIds.add(frame[1]);
        try {
          const body = JSON.parse(frame[2]);
          const rows = mediaPath(body, mediaSchema.collection_path);
          if (Array.isArray(rows)) {
            for (const row of rows) walk(row);
          }
        } catch (_) {}
        return;
      }
      for (const entry of frame) if (Array.isArray(entry)) walkFrame(entry, depth + 1);
    };
    for (const root of parsed.roots) walkFrame(root);
    if (
      audit.rows &&
      (!lastNativeMediaResponse ||
        audit.rows >= Math.floor(Number(lastNativeMediaResponse.rows || 0) * 0.8))
    ) {
      lastNativeMediaResponse = { text, status, project: currentProject, rows: audit.rows };
    }
    if (audit.rows)
      console.info(
        "[FlowNativeMediaIdentity] response",
        JSON.stringify({
          projectId: currentProject,
          rpcIds: [...audit.rpcIds],
          rows: audit.rows,
          imageRows: audit.imageRows,
          videoRows: audit.videoRows,
          untypedRows: audit.untypedRows,
          aliases: mediaIdentities.size,
          conflicts: audit.conflicts,
          changed,
          responseCharacters: text.length,
          cappedAliases: audit.cappedAliases,
          budgetExhausted: remaining < 0,
        })
      );
    if (changed) {
      console.info(
        "[FlowMediaIdentity] project media identities observed",
        JSON.stringify({ projectId: currentProject, count: mediaIdentities.size })
      );
      publishMediaIdentities();
    }
  };
  const onMediaSchema = (event) => {
    const next = validateMediaSchema(event.detail),
      fingerprint = JSON.stringify(next);
    if (fingerprint === mediaSchemaFingerprint) return;
    mediaSchema = next;
    mediaSchemaFingerprint = fingerprint;
    mediaSchemaEpoch++;
    mediaIdentities.clear();
    mediaIdentityTypes.clear();
    mediaIdentityProject = projectId()?.toLowerCase() || null;
    publishMediaIdentities();
    console.info(
      "[FlowNativeMediaIdentity] server schema applied",
      JSON.stringify({
        schemaEpoch: mediaSchemaEpoch,
        valid: !!next,
        enabled: next?.enabled === true,
        buffered: pendingMediaResponses.length,
        replayAvailable: !!lastNativeMediaResponse,
      })
    );
    if (!next?.enabled) return;
    const replay = [...pendingMediaResponses];
    pendingMediaResponses.length = 0;
    pendingMediaBytes = 0;
    if (
      lastNativeMediaResponse &&
      !replay.some((record) => record.text === lastNativeMediaResponse.text)
    )
      replay.push(lastNativeMediaResponse);
    for (const record of replay)
      if (record.project === projectId()?.toLowerCase())
        observeMediaIdentities(record.text, record.status);
  };
  window.addEventListener(MEDIA_SCHEMA, onMediaSchema);
  window.addEventListener(MEDIA_IDENTITIES_READ, publishMediaIdentities);
  const collectMachineData = (value) => {
    const identities = new Set();
    const errors = new Set();
    const walk = (v, depth = 0) => {
      if (depth > 28) return;
      if (typeof v === "string") {
        if (UUID_RE.test(v)) identities.add(v.toLowerCase());
        else if (ERROR_CODE_RE.test(v)) {
          errors.add(v);
        }
      } else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1));
      else if (v && typeof v === "object") Object.values(v).forEach((x) => walk(x, depth + 1));
    };
    walk(value);
    return { identities: [...identities].slice(0, 32), errorCodes: [...errors].slice(0, 12) };
  };
  const matchingRpcResponse = (parsed, rpcId) => {
    const codes = new Set();
    const payloads = [];
    let matched = false;
    const visit = (node, depth = 0) => {
      if (depth > 12 || !Array.isArray(node)) return;
      if (node[0] === "wrb.fr" && node[1] === rpcId) {
        matched = true;
        for (const payload of [node[2], node[5]]) {
          if (payload == null) continue;
          payloads.push(payload);
        }
        return;
      }
      for (const child of node) visit(child, depth + 1);
    };
    for (const root of parsed?.roots || []) visit(root);
    const data = decodeResponse(payloads);
    for (const code of collectMachineData(data).errorCodes) codes.add(code);
    return { matched, errorCodes: [...codes].slice(0, 12), data };
  };
  const extractCorrelationData = (value, mediaType, terminalOnly = false) => {
    const operationIds = new Set();
    const mediaIds = new Set();
    const children = new Map();
    const mediaUrls = (row, mediaId) => {
      const urls = {};
      const visit = (node, depth = 0) => {
        if (depth > 28) return;
        if (typeof node === "string") {
          try {
            const url = new URL(node);
            if (url.protocol !== "https:" || url.hostname !== "flow-content.google") return;
            if (url.pathname.toLowerCase() === `/image/${mediaId}`) urls.thumbnail = node;
            if (url.pathname.toLowerCase() === `/video/${mediaId}`) urls.video_url = node;
          } catch (_) {}
        } else if (Array.isArray(node)) node.forEach((value2) => visit(value2, depth + 1));
      };
      visit(row);
      return urls;
    };
    const addChild = (
      operationId,
      mediaId,
      status = "completed",
      errorCodes = [],
      preview = {}
    ) => {
      const operation = String(operationId).toLowerCase();
      const media = mediaId ? String(mediaId).toLowerCase() : null;
      operationIds.add(operation);
      if (media) mediaIds.add(media);
      children.set(`${operation}:${media || status}`, {
        operationId: operation,
        mediaId: media,
        status,
        errorCodes: [...new Set(errorCodes)].slice(0, 12),
        ...preview,
      });
    };
    const findTerminalVideoId = (value2) => {
      let found = null;
      const visit = (node, depth = 0) => {
        if (found || depth > 16) return;
        if (typeof node === "string") {
          const match = node.match(
            /\/video\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i
          );
          if (match) found = match[1].toLowerCase();
        } else if (Array.isArray(node)) node.forEach((item) => visit(item, depth + 1));
        else if (node && typeof node === "object")
          Object.values(node).forEach((item) => visit(item, depth + 1));
      };
      visit(value2);
      return found;
    };
    const isVideoGenerationMetadata = (row) => {
      const details = row?.[3];
      const timestamp = (value2) =>
        Array.isArray(value2) && value2.length === 2 && value2.every(Number.isInteger);
      return (
        Array.isArray(details) &&
        details.length === 7 &&
        typeof details[0] === "string" &&
        timestamp(details[1]) &&
        details[2] == null &&
        details[3] == null &&
        UUID_RE.test(details[4] || "") &&
        UUID_RE.test(details[5] || "") &&
        timestamp(details[6])
      );
    };
    const isVideoOperationRow = (row) => {
      if (!UUID_RE.test(row[0] || "") || !UUID_RE.test(row[1] || "") || !UUID_RE.test(row[2] || ""))
        return false;
      if (row[3] === "CAE") return true;
      return (
        row[3] == null &&
        row[4] == null &&
        Array.isArray(row[5]?.[6]?.[2]) &&
        Array.isArray(row[7]?.[0]) &&
        typeof row[7][0][12] === "string" &&
        row[7][0][12].length > 0 &&
        row[5]?.[6]?.[1]?.[0]?.[0] === row[7][0][12] &&
        Array.isArray(row[7]?.[2]) &&
        row[7][2].length === 1 &&
        row[7][2][0] === row[0]
      );
    };
    const walk = (v, depth = 0) => {
      if (depth > 28) return false;
      if (Array.isArray(v)) {
        let nestedChildEvidence = false;
        for (const child of v) nestedChildEvidence = walk(child, depth + 1) || nestedChildEvidence;
        let childEvidence = false;
        if (mediaType === "video" && isVideoOperationRow(v)) {
          const terminalMediaId = findTerminalVideoId(v);
          const rowErrors = collectMachineData(v).errorCodes;
          if (!terminalOnly) addChild(v[0], v[2], "accepted");
          else if (terminalMediaId)
            addChild(v[0], terminalMediaId, "completed", [], mediaUrls(v, terminalMediaId));
          else if (rowErrors.length > 0) addChild(v[0], null, "failed", rowErrors);
          else addChild(v[0], v[2], "processing");
          childEvidence = true;
        }
        if (
          mediaType === "video" &&
          UUID_RE.test(String(v[0] || "")) &&
          v[1] == null &&
          v[2] == null &&
          v[3] != null &&
          UUID_RE.test(String(v[4] || "")) &&
          !isVideoGenerationMetadata(v) &&
          !nestedChildEvidence
        ) {
          const childErrors = collectMachineData(v[3]).errorCodes;
          addChild(
            v[0],
            null,
            "failed",
            childErrors.length > 0 ? childErrors : ["PROVIDER_TERMINAL_FAILURE"]
          );
          childEvidence = true;
        }
        if (
          mediaType === "video" &&
          terminalOnly &&
          UUID_RE.test(String(v[0] || "")) &&
          v[1] == null &&
          v[2] == null &&
          v[3] == null &&
          v[4] == null
        ) {
          const pollErrors = collectMachineData(v.slice(5)).errorCodes;
          if (pollErrors.length > 0) {
            addChild(v[0], null, "failed", pollErrors);
            childEvidence = true;
          }
        }
        if (
          mediaType === "image" &&
          UUID_RE.test(String(v[0] || "")) &&
          v[1] == null &&
          UUID_RE.test(String(v[2] || "")) &&
          v[3] == null &&
          Array.isArray(v[6])
        ) {
          addChild(v[2], v[0], "completed", [], mediaUrls(v, String(v[0]).toLowerCase()));
          childEvidence = true;
        }
        return childEvidence || nestedChildEvidence;
      } else if (v && typeof v === "object") {
        let childEvidence = false;
        for (const child of Object.values(v))
          childEvidence = walk(child, depth + 1) || childEvidence;
        return childEvidence;
      }
      return false;
    };
    walk(value);
    return {
      operationIds: [...operationIds],
      mediaIds: [...mediaIds],
      children: [...children.values()],
    };
  };
  const summarizeInput = (payload) => {
    const fields = [];
    const visit = (value, path, depth) => {
      if (fields.length >= 16 || depth > 16) return;
      if (typeof value === "string")
        fields.push({
          path,
          length: value.length,
          normalizedLength: value.normalize("NFKC").trim().replace(/\s+/g, " ").length,
          fingerprint: promptFingerprint(value),
        });
      else if (Array.isArray(value))
        value.slice(0, 16).forEach((child, index) => visit(child, path + "." + index, depth + 1));
    };
    if (Array.isArray(payload?.[0])) visit(payload[0], "0", 0);
    return fields;
  };
  const transportSignature = (payload) => {
    const ids = [];
    if (payload?.[0] == null && Array.isArray(payload?.[1])) {
      for (const row of payload[1]) {
        if (
          typeof row?.[5] === "string" &&
          UUID_RE.test(row?.[12] || "") &&
          UUID_RE.test(row?.[13] || "")
        )
          ids.push(row[12]);
      }
      if (UUID_RE.test(payload?.[4]?.[0] || "")) ids.push(payload[4][0]);
    } else if (Array.isArray(payload?.[0])) {
      for (const row of payload[0]) {
        if (!Array.isArray(row)) continue;
        for (const slot of row.slice(1)) {
          if (
            Array.isArray(slot) &&
            slot.length === 6 &&
            slot.slice(0, 4).every((value) => value == null) &&
            UUID_RE.test(slot[4] || "") &&
            UUID_RE.test(slot[5] || "")
          )
            ids.push(slot[4]);
        }
      }
      if (UUID_RE.test(payload?.[2]?.[0] || "") && [1, 2].includes(payload[2][1]))
        ids.push(payload[2][0]);
    }
    return ids.length ? "request-v1:" + identityFingerprint(ids) : null;
  };
  const eligibleAttempt = (call) => {
    const machineIds = collectMachineData(call.payload).identities;
    const signature = transportSignature(call.payload);
    if (
      signature &&
      (retired.requestSignatures.includes(signature) ||
        retired.requestSignatures.includes(identityFingerprint(machineIds)))
    ) {
      for (const attempt of attempts.values())
        recordRequestDiagnostic(attempt, call, call.transport, call.requestPath, ["retired_request_signature"]);
      return null;
    }
    const now = Date.now();
    retired.completedDispatches = retired.completedDispatches.filter(entry => entry.expiresAt > now);
    const payloadFingerprint = requestPayloadFingerprint(call.payload);
    const staleDispatch = payloadFingerprint && retired.completedDispatches.some(entry =>
      entry.projectId === projectId() && entry.payloadFingerprint === payloadFingerprint);
    if (staleDispatch) {
      for (const attempt of attempts.values()) {
        if (!attemptMatchesPayload(call.payload, attempt)) continue;
        attempt.interfered = true;
        recordRequestDiagnostic(attempt, call, call.transport, call.requestPath, ["completed_dispatch_replay"]);
        emit(attempt, "acceptance_unknown", { reason: "completed_dispatch_replay" });
      }
      return null;
    }
    const strictCandidates = [];
    const weakCandidates = [];
    for (const [id, attempt] of attempts) {
      if (now > attempt.expiresAt || attempt.projectId !== projectId()) {
        retireUnbound(attempt);
        attempts.delete(id);
      }
    }
    for (const attempt of attempts.values()) {
      if (attempt.interfered || attempt.requestCount >= attempt.requestCardinality) {
        recordRequestDiagnostic(attempt, call, call.transport, call.requestPath, [
          attempt.interfered ? "attempt_interfered" : "request_cardinality_exhausted",
        ]);
        continue;
      }
      const structured = attempt.structuredPromptFingerprint
        ? structuredInputFingerprints(call.payload)
        : [];
      const promptMatched = attemptMatchesPayload(call.payload, attempt);
      // Videofix M-C: a quantity split/merge or a Flow-injected ref set,
      // with an exact prompt and exact model/ratio, is still this
      // attempt's request. It claims the request like a strict match,
      // but the receipt carries the weak reason so the panel and
      // diagnostics can tell the two apart.
      const weakReason = !promptMatched ? attemptVideoWeakMatch(call.payload, attempt) : false;
      const matched = promptMatched || weakReason !== false;
      recordRequestDiagnostic(
        attempt,
        call,
        call.transport,
        call.requestPath,
        matched ? (weakReason ? [`weak_match:${weakReason}`] : []) : ["payload_match_failed"]
      );
      if (!promptMatched && (attempt.bridgeInputDiagnostics || 0) < 2) {
        const mismatch = videoInputDiagnostic(call.payload, attempt);
        if (mismatch) {
          attempt.bridgeInputDiagnostics = (attempt.bridgeInputDiagnostics || 0) + 1;
          emit(attempt, "input_seen", mismatch);
        }
      }
      if ((attempt.inputDiagnostics || 0) < 6 && Array.isArray(call.payload?.[0])) {
        attempt.inputDiagnostics = (attempt.inputDiagnostics || 0) + 1;
        console.info(
          "[FlowCorrelationInput] " +
            JSON.stringify({
              attempt: attempt.attemptId.slice(0, 8),
              rpcId: call.rpcId,
              expectedFingerprint: attempt.promptFingerprint,
              expectedStructuredFingerprint: attempt.structuredPromptFingerprint || null,
              structuredFingerprints: structured,
              promptMatched,
              fields: summarizeInput(call.payload),
            })
        );
      }
      if (!matched) continue;
      if (weakReason) weakCandidates.push({ attempt, reason: weakReason });
      else strictCandidates.push(attempt);
    }
    // Videofix M-C (VID-03): a strict claim always beats weak claims, so
    // model/ratio separation between overlapping attempts survives — a
    // request one attempt matches exactly is never stolen by, or
    // interfered with, another attempt's weak claim. Weak claims only
    // compete when no strict claim exists. The weak reason is attached
    // to the winner only, so a dropped weak candidate never leaves a
    // stale reason on an attempt that later matches strictly.
    let winners = strictCandidates.length ? strictCandidates : weakCandidates.map(entry => entry.attempt);
    const winnerWeakReason = strictCandidates.length || weakCandidates.length !== 1 ? false : weakCandidates[0].reason;
    winners = winners.filter(attempt => {
      if (
        retired.saturated ||
        retired.entries.some(
          (entry) =>
            entry.mediaType === attempt.mediaType &&
            (entry.refMatchVersion === 1
              ? attemptMatchesPayload(call.payload, entry)
              : attemptsOverlap(entry, attempt))
        )
      ) {
        attempt.interfered = true;
        emit(attempt, "acceptance_unknown", { reason: "ambiguous_retired_request" });
        return false;
      }
      return true;
    });
    if (winners.length > 1) {
      // One dispatched request matches several live attempts and cannot be
      // attributed safely. Surface it as interference — the same treatment
      // as the retired-overlap case above — instead of letting every
      // candidate expire as if nothing was sent.
      for (const attempt of winners) {
        attempt.interfered = true;
        recordRequestDiagnostic(attempt, call, call.transport, call.requestPath, ["attempt_interfered"]);
        emit(attempt, "acceptance_unknown", { reason: "ambiguous_live_request" });
      }
      return null;
    }
    if (winners.length !== 1) return null;
    if (winnerWeakReason) winners[0].weakMatchReason = winnerWeakReason;
    else delete winners[0].weakMatchReason;
    return winners[0];
  };
  const matchGenerationCall = (calls) => {
    const matches = [];
    for (const call of calls) {
      const attempt = eligibleAttempt(call);
      if (attempt) matches.push({ call, attempt });
    }
    return matches.length === 1 ? matches[0] : null;
  };
  const matchFollowupCalls = (calls) => {
    const now = Date.now();
    const matchedByAttempt = new Map();
    for (const call of calls) {
      const identities = new Set(collectMachineData(call.payload).identities);
      if (identities.size === 0) continue;
      for (const [id, attempt] of attempts) {
        if (now > attempt.expiresAt || attempt.projectId !== projectId()) {
          retireUnbound(attempt);
          attempts.delete(id);
          continue;
        }
        if (!attempt.correlationIdentities?.some((identity) => identities.has(identity))) continue;
        matchedByAttempt.set(attempt.attemptId, { call, attempt });
      }
    }
    return [...matchedByAttempt.values()];
  };
  const matchObservedCalls = (calls) => {
    const generation = matchGenerationCall(calls);
    return generation ? [generation] : matchFollowupCalls(calls);
  };
  const beginObservedRequest = (attempt, call) => {
    const requestOrdinal = attempt.requestCount++;
    attempt.completedRequestFingerprint = requestPayloadFingerprint(call.payload);
    const requestMachine = collectMachineData(call.payload);
    const inputDiagnostic =
      attempt.mediaType === "image"
        ? imageInputDiagnostic(call.payload, attempt)
        : videoInputDiagnostic(call.payload, attempt);
    const signature = transportSignature(call.payload);
    if (signature) (attempt.requestSignatures || (attempt.requestSignatures = [])).push(signature);
    emit(attempt, "request_seen", {
      rpcId: call.rpcId,
      requestOrdinal,
      requestCardinality: attempt.requestCardinality,
      matchKind: attempt.weakMatchReason
        ? `weak_${attempt.weakMatchReason}`
        : attempt.structuredPromptFingerprint
          ? plainInputFingerprint(call.payload)
            ? "normalized_voice_text"
            : "structured_ids"
          : "plain_text",
      ...(attempt.weakMatchReason ? { weakMatchReason: attempt.weakMatchReason } : {}),
      requestIdentityCount: requestMachine.identities.length,
      requestIdentityFingerprint: identityFingerprint(requestMachine.identities),
      requestIdentityTokens: requestMachine.identities
        .map((value) => identityFingerprint([value]))
        .slice(0, 16),
      ...(inputDiagnostic || {}),
    });
    return {
      attempt,
      rpcId: call.rpcId,
      requestOrdinal,
      requestIdentities: requestMachine.identities,
      kind: "generation",
    };
  };
  const beginFollowupRequest = (attempt, call) => ({
    attempt,
    rpcId: call.rpcId,
    requestOrdinal: null,
    requestIdentities: collectMachineData(call.payload).identities,
    kind: "followup",
  });
  const finishObservedRequest = (state, transport, responseText, httpStatus = 0) => {
    if (attempts.get(state.attempt.attemptId) !== state.attempt) return;
    const parsed = transport === "load" ? decodeResponse(responseText) : null;
    const rpcResponse = matchingRpcResponse(parsed, state.rpcId);
    const machine = collectMachineData(rpcResponse.data);
    const correlation = parsed
      ? extractCorrelationData(rpcResponse.data, state.attempt.mediaType, state.kind === "followup")
      : { operationIds: [], mediaIds: [], children: [] };
    if (
      state.kind === "generation" &&
      state.attempt.mediaType === "image" &&
      state.attempt.expectedQuantity === 1 &&
      state.attempt.requestCardinality === 1 &&
      transport === "load" &&
      httpStatus >= 200 &&
      httpStatus < 300 &&
      rpcResponse.matched &&
      correlation.children.length === 0 &&
      correlation.operationIds.length === 0
    ) {
      state.attempt.completedNoOwnership = true;
    }
    if (state.kind === "followup") {
      const owned = new Set(state.attempt.correlationIdentities || []);
      correlation.children = correlation.children.filter(
        (child) => owned.has(child.operationId) || (child.mediaId && owned.has(child.mediaId))
      );
      correlation.operationIds = [
        ...new Set(correlation.children.map((child) => child.operationId)),
      ];
      correlation.mediaIds = [
        ...new Set(correlation.children.map((child) => child.mediaId).filter(Boolean)),
      ];
    }
    let currentChildren = correlation.children;
    const hasTerminalChild = currentChildren.some((child) =>
      ["completed", "failed"].includes(child.status)
    );
    if (state.kind === "followup" && !hasTerminalChild) {
      currentChildren = currentChildren.filter((child) => {
        const changed = state.attempt.lastChildStatuses.get(child.operationId) !== child.status;
        if (changed) state.attempt.lastChildStatuses.set(child.operationId, child.status);
        return changed;
      });
      correlation.children = currentChildren;
      correlation.operationIds = [...new Set(currentChildren.map((child) => child.operationId))];
      correlation.mediaIds = [
        ...new Set(currentChildren.map((child) => child.mediaId).filter(Boolean)),
      ];
    }
    if (state.kind === "followup" && hasTerminalChild) {
      for (const child of currentChildren.filter((entry) =>
        ["completed", "failed"].includes(entry.status)
      )) {
        state.attempt.terminalChildren.set(child.operationId, child);
        state.attempt.lastChildStatuses.set(child.operationId, child.status);
      }
      const processingByOperation = new Map(
        currentChildren
          .filter(
            (child) =>
              child.status === "processing" &&
              !state.attempt.terminalChildren.has(child.operationId)
          )
          .map((child) => [child.operationId, child])
      );
      correlation.children = [
        ...state.attempt.terminalChildren.values(),
        ...processingByOperation.values(),
      ];
      correlation.operationIds = [
        ...new Set(correlation.children.map((child) => child.operationId)),
      ];
      correlation.mediaIds = [
        ...new Set(
          correlation.children
            .filter((child) => child.status === "completed" && child.mediaId)
            .map((child) => child.mediaId)
        ),
      ];
    }
    const requestSet = new Set(state.requestIdentities || []);
    const hasFollowupEvidence = state.kind !== "followup" || correlation.children.length > 0;
    if (!hasFollowupEvidence) return;
    const stage =
      state.kind === "followup"
        ? hasTerminalChild
          ? "result_seen"
          : "poll_seen"
        : transport === "load"
          ? "response_seen"
          : "acceptance_unknown";
    const failedChildren = correlation.children.filter((child) => child.status === "failed");
    if (failedChildren.length) {
      console.warn(
        "[FlowProviderFailureAudit]",
        JSON.stringify({
          attempt: state.attempt.attemptId.slice(0, 8),
          rpcId: state.rpcId,
          stage,
          rpcResponseMatched: rpcResponse.matched,
          httpStatus: Number(httpStatus) || 0,
          expectedOutputs: state.attempt.expectedQuantity,
          failedOutputs: failedChildren.length,
          errorCodes: [...new Set(failedChildren.flatMap((child) => child.errorCodes))].slice(
            0,
            12
          ),
        })
      );
    }
    emit(state.attempt, stage, {
      rpcId: state.rpcId,
      requestOrdinal: state.requestOrdinal,
      transport,
      httpStatus: Number(httpStatus) || 0,
      identityCandidates: machine.identities.filter((id) => !requestSet.has(id)),
      responseIdentityCount: machine.identities.length,
      responseCharacters: typeof responseText === "string" ? responseText.length : 0,
      responseRootCount: Array.isArray(parsed?.roots) ? parsed.roots.length : 0,
      responseDecodedCount: Array.isArray(parsed?.decoded) ? parsed.decoded.length : 0,
      operationIds: correlation.operationIds,
      mediaIds: correlation.mediaIds,
      children: correlation.children,
      errorCodes: machine.errorCodes,
      terminalErrorCodes: correlation.children.length === 0 ? rpcResponse.errorCodes : [],
      rpcResponseMatched: rpcResponse.matched,
      reason:
        state.kind === "generation" && transport === "load" && !correlation.children.length
          ? "generation_response_missing_ownership"
          : null,
    });
    if (state.kind === "generation" && transport === "load") {
      state.attempt.correlationIdentities = [
        ...new Set([...correlation.operationIds, ...correlation.mediaIds]),
      ];
    }
    if (
      state.kind === "followup" &&
      state.attempt.terminalChildren.size >= state.attempt.expectedQuantity
    ) {
      retireUnbound(state.attempt);
      attempts.delete(state.attempt.attemptId);
    } else if (state.kind === "generation" && state.attempt.mediaType === "image") {
      state.attempt.responsesSeen = (state.attempt.responsesSeen || 0) + 1;
      if (state.attempt.responsesSeen >= state.attempt.requestCardinality) {
        retireUnbound(state.attempt);
        attempts.delete(state.attempt.attemptId);
      }
    }
  };
  const onArm = (event) => {
    const d = event.detail || {};
    if (
      d.schemaVersion !== VERSION ||
      typeof d.nonce !== "string" ||
      typeof d.attemptId !== "string"
    )
      return;
    if (!["image", "video"].includes(d.mediaType) || d.projectId !== projectId()) return;
    if (!/^id-[0-9a-f]{8}$/.test(d.promptFingerprint || "")) return;
    const expectedVoiceCount = Math.max(0, Math.min(1, Number(d.expectedVoiceCount) || 0));
    if (expectedVoiceCount > 0 && d.mediaType !== "video") return;
    if (
      d.structuredPromptFingerprint != null &&
      !/^id-[0-9a-f]{8}$/.test(d.structuredPromptFingerprint)
    )
      return;
    const expectedQuantity = Math.max(1, Math.min(16, Number(d.expectedQuantity) || 1));
    const generationFingerprint = codec?.generationFingerprint
      ? codec.generationFingerprint({
          prompt: d.prompt || d.promptText || d.promptFingerprint,
          promptFingerprint: d.promptFingerprint,
          model: d.mediaType === "image" ? d.expectedImageModelKey : d.expectedVideoModelKey,
          ratio: d.expectedVideoRatioEnum,
          referenceIds: d.expectedMediaReferenceIds,
          characterIds: d.expectedCharacterIds,
        })
      : null;
    const previous = attempts.get(d.attemptId);
    if (previous) retireUnbound(previous);
    attempts.set(d.attemptId, {
      nonce: d.nonce,
      attemptId: d.attemptId,
      projectId: d.projectId,
      mediaType: d.mediaType,
      expectedQuantity,
      promptFingerprint: d.promptFingerprint,
      generationFingerprint,
      expectedVoiceCount,
      promptAnchorFingerprint: /^id-[0-9a-f]{8}$/.test(d.promptAnchorFingerprint || "")
        ? d.promptAnchorFingerprint
        : null,
      promptNormalizedLength: Math.max(0, Math.min(1e6, Number(d.promptNormalizedLength) || 0)),
      refMatchVersion: 1,
      structuredPromptFingerprint: d.structuredPromptFingerprint || null,
      normalizedVoiceFingerprint: /^id-[0-9a-f]{8}$/.test(d.normalizedVoiceFingerprint || "")
        ? d.normalizedVoiceFingerprint
        : null,
      expectedReferenceIds: Array.isArray(d.expectedReferenceIds)
        ? d.expectedReferenceIds
            .filter((id) => typeof id === "string" && UUID_RE.test(id))
            .slice(0, 32)
            .map((id) => id.toLowerCase())
        : [],
      expectedMediaReferenceIds: Array.isArray(d.expectedMediaReferenceIds)
        ? d.expectedMediaReferenceIds
            .filter((id) => typeof id === "string" && UUID_RE.test(id))
            .slice(0, 32)
            .map((id) => id.toLowerCase())
        : [],
      expectedCharacterIds: Array.isArray(d.expectedCharacterIds)
        ? d.expectedCharacterIds
            .filter((id) => typeof id === "string" && UUID_RE.test(id))
            .slice(0, 32)
            .map((id) => id.toLowerCase())
        : [],
      expectedGlobalCharacter: d.expectedGlobalCharacter === true,
      expectedGlobalCharacterCount: Math.max(
        0,
        Number(d.expectedGlobalCharacterCount) || (d.expectedGlobalCharacter === true ? 1 : 0)
      ),
      unverifiedMediaCount: Math.max(0, Number(d.unverifiedMediaCount) || 0),
      expectedImageModelKey:
        typeof d.expectedImageModelKey === "string" &&
        /^[a-zA-Z0-9_-]{1,128}$/.test(d.expectedImageModelKey)
          ? d.expectedImageModelKey
          : null,
      expectedVideoModelKey:
        typeof d.expectedVideoModelKey === "string" &&
        /^[a-zA-Z0-9_-]{1,128}$/.test(d.expectedVideoModelKey)
          ? d.expectedVideoModelKey
          : null,
      expectedVideoRatioEnum:
        d.expectedVideoRatioEnum != null && Number.isInteger(Number(d.expectedVideoRatioEnum))
          ? Math.max(1, Math.min(16, Number(d.expectedVideoRatioEnum)))
          : null,
      normalizedVideoModelKey:
        typeof d.normalizedVideoModelKey === "string" &&
        /^[a-zA-Z0-9_-]{1,128}$/.test(d.normalizedVideoModelKey)
          ? d.normalizedVideoModelKey
          : null,
      requestCardinality: 1,
      strictDispatch: d.strictDispatch === true,
      interfered: false,
      requestCount: 0,
      terminalChildren: new Map(),
      lastChildStatuses: new Map(),
      expiresAt: Date.now() + Math.max(5e3, Math.min(9e5, Number(d.ttlMs) || 6e4)),
    });
    console.info("[FlowCorrelationObserver] armed", {
      attempt: d.attemptId.slice(0, 8),
      mediaType: d.mediaType,
      expectedQuantity,
      promptFingerprint: d.promptFingerprint,
      xhrHookActive: XMLHttpRequest.prototype.send === patchedSend,
      fetchHookActive: fetchHookActiveNow(),
    });
    // M-D: expired retired entries must not block a re-arm.
    pruneRetiredEntries();
    const conflict =
      retired.saturated ||
      retired.entries.some(
        (entry) =>
          entry.projectId === d.projectId && attemptsOverlap(entry, attempts.get(d.attemptId))
      );
    if (conflict) attempts.get(d.attemptId).interfered = true;
    emit(attempts.get(d.attemptId), "armed", {
      structuredPromptVersion: 2,
      observerRevision: OBSERVER_REVISION,
      generationFingerprint,
      xhrHookActive:
        XMLHttpRequest.prototype.open === patchedOpen &&
        XMLHttpRequest.prototype.send === patchedSend,
      fetchHookActive: fetchHookActiveNow(),
      reason: conflict ? "ambiguous_retired_request" : null,
    });
  };
  const onDisarm = (event) => {
    const d = event.detail || {};
    const attempt = attempts.get(d.attemptId);
    if (attempt && attempt.nonce === d.nonce) {
      const completedDispatch = d.completedDispatch === true &&
        attempt.requestCount >= attempt.requestCardinality;
      if (completedDispatch && attempt.completedRequestFingerprint) {
        const now = Date.now();
        retired.completedDispatches = (retired.completedDispatches || []).filter(entry => entry.expiresAt > now);
        if (retired.completedDispatches.length >= 128) retired.completedDispatches.shift();
        retired.completedDispatches.push({
          projectId: attempt.projectId,
          payloadFingerprint: attempt.completedRequestFingerprint,
          expiresAt: now + 15 * 60_000,
        });
      }
      // M-D: the isolated side now reports what the dispatch wait actually
      // observed. "none" (click delivered, zero signal) and "rejected"
      // (Flow displayed an error) with no request observed mean nothing
      // is in flight, so retiring would only wedge the identical retry
      // until a tab reload. Any other outcome — including a legacy
      // disarm with no outcome — keeps the conservative retire, and a
      // request already observed always retires (the ambiguous case).
      else if (!completedDispatch && d.discardOnStop !== true && (d.dispatched !== false || attempt.requestCount > 0) &&
        !((d.dispatchOutcome === "none" || d.dispatchOutcome === "rejected") && attempt.requestCount === 0))
        retireUnbound(attempt);
      attempts.delete(d.attemptId);
    }
  };
  const onTrustedInteraction = (event) => {
    if (event.isTrusted !== true) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest?.(".ProseMirror[contenteditable='true'], [data-slate-editor='true']")) return;
    for (const attempt of attempts.values()) {
      if (
        !attempt.strictDispatch ||
        attempt.requestCount >= attempt.requestCardinality ||
        attempt.interfered
      )
        continue;
      attempt.manualInteractionCount = Math.min(100, (attempt.manualInteractionCount || 0) + 1);
      attempt.interfered = true;
      emit(attempt, "acceptance_unknown", { reason: "trusted_interaction_before_request" });
      if (attempt.manualInteractionCount <= 2)
        console.info(
          "[FlowCorrelationObserver] trusted interaction observed while awaiting exact request",
          {
            attempt: attempt.attemptId.slice(0, 8),
            eventType: event.type,
            manualInteractionCount: attempt.manualInteractionCount,
          }
        );
    }
  };
  window.addEventListener("pointerdown", onTrustedInteraction, true);
  window.addEventListener("keydown", onTrustedInteraction, true);
  window.addEventListener(ARM, onArm);
  window.addEventListener(ARM_V2, onArm);
  window.addEventListener(DISARM, onDisarm);
  window.addEventListener(DISARM_V2, onDisarm);
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    let absolute = String(url || "");
    try {
      absolute = new URL(absolute, location.href).href;
    } catch (_) {}
    xhrState.set(this, { url: absolute, method: String(method || "GET").toUpperCase() });
    return Reflect.apply(nativeOpen, this, [method, url, ...rest]);
  };
  XMLHttpRequest.prototype.send = function (body) {
    try {
      const state = xhrState.get(this) || {};
      const requestPath = safeRequestPath(state.url);
      const recognizedBatch = isFlowBatchExecuteUrl(state.url);
      if (attempts.size > 0 && state.method === "POST" && requestPath && !recognizedBatch)
        recordUnmatchedTransport(requestPath, "xhr", body);
      if (recognizedBatch) {
        this.addEventListener(
          "load",
          () => {
            try {
              observeMediaIdentities(this.responseText, Number(this.status) || 0);
            } catch (_) {}
          },
          { once: true }
        );
        if (attempts.size > 0) {
          const calls = parseCalls(body, { requestPath, transport: "xhr" });
          if (!calls.length) recordUnmatchedTransport(requestPath, "xhr", body, "rpc_payload_unparsed");
          if (attempts.size > 0 && diagnosticBudget-- > 0) {
            const bodyType = body == null ? "null" : body.constructor?.name || typeof body;
            console.info(
              "[FlowCorrelationObserver] batchexecute observed",
              JSON.stringify({
                bodyType,
                parsedRpcIds: calls.map((call) => call.rpcId).filter(Boolean),
                xhrHookActive: XMLHttpRequest.prototype.send === patchedSend,
              })
            );
          }
          const matchedSync = calls.length > 0 ? matchObservedCalls(calls) : [];
          const beginMatches = (matches) =>
            matches.map((matched) =>
              matched.attempt.requestCount < matched.attempt.requestCardinality &&
              attemptClaimsGenerationRequest(matched.call.payload, matched.attempt)
                ? beginObservedRequest(matched.attempt, matched.call)
                : beginFollowupRequest(matched.attempt, matched.call)
            );
          if (matchedSync.length > 0) state.requestStates = beginMatches(matchedSync);
          const observedPromise =
            calls.length > 0
              ? Promise.resolve(matchedSync)
              : parseCallsAsync(body, calls, { requestPath, transport: "xhr" }).then(matchObservedCalls);
          let terminal = false;
          observedPromise
            .then((matches) => {
              if (!matches?.length || state.requestStates) return;
              state.requestStates = beginMatches(matches);
            })
            .catch(() => {});
          const finishWithOwnedState = (transport) => {
            if (terminal) return;
            const finishNow = () => {
              const requestStates = state.requestStates;
              if (!requestStates?.length || terminal) return;
              terminal = true;
              let responsePayload = "";
              if (transport === "load") {
                try {
                  responsePayload = this.responseText;
                } catch (_) {}
                if (!responsePayload) {
                  try {
                    responsePayload = this.response;
                  } catch (_) {}
                }
              }
              for (const requestState of requestStates) {
                finishObservedRequest(
                  requestState,
                  transport,
                  responsePayload,
                  Number(this.status) || 0
                );
              }
            };
            if (state.requestStates) finishNow();
            else observedPromise.then(finishNow).catch(() => {});
          };
          this.addEventListener("load", () => finishWithOwnedState("load"), { once: true });
          ["error", "abort", "timeout"].forEach((type) =>
            this.addEventListener(type, () => finishWithOwnedState(type), { once: true })
          );
        }
      }
    } catch (_) {}
    return Reflect.apply(nativeSend, this, [body]);
  };
  if (nativeFetch)
    window.fetch = function (...args) {
      let body = null;
      let observeBatchResponse = false;
      let observeSameOriginPost = false;
      let requestPath = null;
      try {
        const input = args[0];
        const url = typeof input === "string" || input instanceof URL ? String(input) : input?.url;
        const method = args[1]?.method || input?.method || "GET";
        const parsedUrl = new URL(String(url || ""), location.href);
        observeSameOriginPost = String(method).toUpperCase() === "POST" && parsedUrl.origin === location.origin;
        requestPath = observeSameOriginPost ? safeRequestPath(parsedUrl.href) : null;
        observeBatchResponse =
          observeSameOriginPost && isFlowBatchExecuteUrl(url);
        if (observeSameOriginPost && attempts.size > 0) {
          body =
            args[1]?.body != null
              ? args[1].body
              : typeof Request !== "undefined" && input instanceof Request
                ? input.clone()
                : null;
        }
      } catch (_) {
        body = null;
        observeBatchResponse = false;
        observeSameOriginPost = false;
        requestPath = null;
      }
      const result = Reflect.apply(nativeFetch, this, args);
      if (!observeBatchResponse) {
        if (observeSameOriginPost && attempts.size > 0 && requestPath)
          void recordUnmatchedTransportAsync(requestPath, "fetch", body).catch(() => {});
        return result;
      }
      const statesPromise =
        body == null
          ? recordUnmatchedTransportAsync(requestPath, "fetch", null, "rpc_payload_unparsed").then(() => [])
          : Promise.resolve()
              .then(() => parseCallsAsync(body, parseCalls(body, { requestPath, transport: "fetch" }), { requestPath, transport: "fetch" }))
              .then((calls) => {
                if (!calls.length) {
                  for (const attempt of attempts.values()) recordRequestDiagnostic(attempt, null, "fetch", requestPath, ["rpc_payload_unparsed"]);
                  return [];
                }
                return matchObservedCalls(calls).map(({ call, attempt }) =>
                  attempt.requestCount < attempt.requestCardinality &&
                  attemptClaimsGenerationRequest(call.payload, attempt)
                    ? beginObservedRequest(attempt, call)
                    : beginFollowupRequest(attempt, call)
                );
              })
              .catch(() => []);
      Promise.resolve(result)
        .then(
          async (response) => {
            let responseTextPromise;
            try {
              responseTextPromise = response.clone().text();
            } catch (_) {
              responseTextPromise = Promise.resolve("");
            }
            let responseText = "";
            try {
              responseText = await responseTextPromise;
            } catch (_) {}
            try {
              observeMediaIdentities(responseText, Number(response.status) || 0);
            } catch (_) {}
            const states = await statesPromise;
            for (const state of states)
              finishObservedRequest(state, "load", responseText, Number(response.status) || 0);
          },
          async () => {
            const states = await statesPromise;
            for (const state of states) finishObservedRequest(state, "error", "", 0);
          }
        )
        .catch(() => {});
      return result;
    };
  // The fetch hook is intact while window.fetch is this observer's patched
  // function — or the media interceptor's wrapper around it. The
  // interceptor loads after this observer (manifest order) and wraps fetch
  // to post-process media downloads; it tags its wrapper with the exact
  // function it wrapped (__flowMcpWrappedFetch), and calls still flow
  // through this observer's hook, so the hook must report active.
  function fetchHookActiveNow() {
    if (!nativeFetch) return false;
    if (window.fetch === patchedFetch) return true;
    return typeof window.fetch === "function" && window.fetch.__flowMcpWrappedFetch === patchedFetch;
  }
  let disposed = false;
  const dispose = () => {
    disposed = true;
    window.removeEventListener(ARM, onArm);
    window.removeEventListener(ARM_V2, onArm);
    window.removeEventListener(DISARM, onDisarm);
    window.removeEventListener(DISARM_V2, onDisarm);
    window.removeEventListener(HEALTH_READ, onHealthRead);
    window.removeEventListener(MEDIA_IDENTITIES_READ, publishMediaIdentities);
    window.removeEventListener(MEDIA_IDENTITIES_READ_V2, publishMediaIdentities);
    window.removeEventListener(MEDIA_SCHEMA, onMediaSchema);
    pendingMediaResponses.length = 0;
    pendingMediaBytes = 0;
    lastNativeMediaResponse = null;
    mediaIdentities.clear();
    mediaIdentityTypes.clear();
    if (XMLHttpRequest.prototype.open === patchedOpen) XMLHttpRequest.prototype.open = nativeOpen;
    if (XMLHttpRequest.prototype.send === patchedSend) XMLHttpRequest.prototype.send = nativeSend;
    if (nativeFetch && window.fetch === patchedFetch) window.fetch = nativeFetch;
    for (const attempt of attempts.values()) retireUnbound(attempt);
    attempts.clear();
  };
  const patchedOpen = XMLHttpRequest.prototype.open;
  const patchedSend = XMLHttpRequest.prototype.send;
  const patchedFetch = window.fetch;
  const observerHealth = () => {
    const now = Date.now();
    for (const [id, attempt] of attempts) {
      if (now > attempt.expiresAt) {
        retireUnbound(attempt);
        attempts.delete(id);
      }
    }
    const xhrHookActive =
      XMLHttpRequest.prototype.open === patchedOpen &&
      XMLHttpRequest.prototype.send === patchedSend;
    const fetchHookActive = fetchHookActiveNow();
    pruneRequestDiagnostics();
    const requestDiagnostics = requestDiagnosticStore.events.map((entry) => ({
      observedAt: entry.observedAt,
      attemptId: entry.attemptId,
      mediaType: entry.mediaType,
      transport: entry.transport,
      path: entry.path,
      rpcId: entry.rpcId,
      payloadVersion: entry.payloadVersion,
      payloadShape: entry.payloadShape,
      pathRecognized: entry.pathRecognized,
      payloadMatched: entry.payloadMatched,
      fields: { ...entry.fields },
      reasons: [...entry.reasons],
    }));
    return {
      ready: !disposed && xhrHookActive && (!nativeFetch || fetchHookActive),
      version: VERSION,
      observerRevision: OBSERVER_REVISION,
      structuredPromptVersion: 2,
      projectId: projectId(),
      activeAttempts: attempts.size,
      retiredCount: retired.entries.length,
      retiredSaturated: retired.saturated,
      requestDiagnostics: { version: 1, count: requestDiagnostics.length, events: requestDiagnostics },
      xhrHookActive,
      fetchHookActive,
    };
  };
  const onHealthRead = (event) => {
    const nonce = event?.detail?.nonce;
    if (typeof nonce !== "string" || nonce.length < 8 || nonce.length > 128) return;
    window.dispatchEvent(new CustomEvent(HEALTH_RESPONSE, {
      detail: { nonce, ...observerHealth() },
    }));
  };
  window.addEventListener(HEALTH_READ, onHealthRead);
  const observerInstance = Object.freeze({
    version: VERSION,
    observerRevision: OBSERVER_REVISION,
    dispose,
    retired,
    requestDiagnosticStore,
    health: observerHealth,
  });
  window.__tobyFlowCorrelationObserver = observerInstance;
  window.__tobyFlowV2CorrelationObserver = observerInstance;
  window.dispatchEvent(new CustomEvent(MEDIA_SCHEMA_READ));
})();
