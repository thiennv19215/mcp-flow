/** Safe observer evidence retained only for submits whose outcome is unknown. */
export interface SafeRequestDiagnostics {
  version: 1;
  count: number;
  events: Array<{
    observedAt: string | null;
    mediaType: "image" | "video" | "unknown";
    transport: "xhr" | "fetch" | "unknown";
    payloadVersion: number | null;
    payloadShape: string | null;
    pathClass: "image" | "video" | "other";
    pathRecognized: boolean;
    payloadMatched: boolean;
    fields: Record<string, boolean>;
    reasons: string[];
  }>;
}

export interface SafeUnknownSubmitDiagnostics {
  clickDelivered: boolean;
  observerReady: boolean;
  xhrHookActive: boolean;
  fetchHookActive: boolean;
  requestDiagnostics: SafeRequestDiagnostics;
}

const enumValue = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === "string" && allowed.includes(value as T) ? value as T : fallback;
const FIELD_KEYS = new Set(["shape", "prompt", "model", "quantity", "referenceIds", "project"]);
const REASON_CODES = new Set([
  "payload_unparsed", "payload_shape_mismatch", "quantity_mismatch", "prompt_mismatch",
  "model_mismatch", "reference_ids_mismatch", "project_mismatch", "request_path_unrecognized",
  "payload_match_failed", "retired_request_signature", "attempt_interfered",
  "request_cardinality_exhausted", "rpc_payload_unparsed",
]);

/** Rebuild the diagnostic object from a narrow allowlist; never forward arbitrary error data. */
export function sanitizeUnknownSubmitDiagnostics(value: unknown): SafeUnknownSubmitDiagnostics | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const raw = source.requestDiagnostics && typeof source.requestDiagnostics === "object" && !Array.isArray(source.requestDiagnostics)
    ? source.requestDiagnostics as Record<string, unknown>
    : {};
  const rawEvents = Array.isArray(raw.events) ? raw.events.slice(-32) : [];
  const events = rawEvents.map((item) => {
    const entry = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
    const rawFields = entry.fields && typeof entry.fields === "object" && !Array.isArray(entry.fields)
      ? Object.entries(entry.fields as Record<string, unknown>).slice(0, 32)
      : [];
    const fields: Record<string, boolean> = {};
    for (const [key, present] of rawFields) {
      if (FIELD_KEYS.has(key)) fields[key] = Boolean(present);
    }
    const observedAt = typeof entry.observedAt === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(entry.observedAt)
      ? entry.observedAt
      : null;
    return {
      observedAt,
      mediaType: enumValue(entry.mediaType, ["image", "video"] as const, "unknown"),
      transport: enumValue(entry.transport, ["xhr", "fetch"] as const, "unknown"),
      payloadVersion: Number.isSafeInteger(entry.payloadVersion) && Number(entry.payloadVersion) >= 0 && Number(entry.payloadVersion) <= 1000
        ? Number(entry.payloadVersion)
        : null,
      payloadShape: typeof entry.payloadShape === "string"
        ? entry.payloadShape.slice(0, 80).replace(/[^a-zA-Z0-9_.:-]/g, "") || null
        : null,
      pathClass: enumValue(entry.pathClass, ["image", "video", "other"] as const, "other"),
      pathRecognized: entry.pathRecognized === true,
      payloadMatched: entry.payloadMatched === true,
      fields,
      reasons: Array.isArray(entry.reasons)
        ? [...new Set(entry.reasons.filter((reason): reason is string => typeof reason === "string" && REASON_CODES.has(reason)))].slice(0, 16)
        : [],
    };
  });
  return {
    clickDelivered: source.clickDelivered === true,
    observerReady: source.observerReady === true,
    xhrHookActive: source.xhrHookActive === true,
    fetchHookActive: source.fetchHookActive === true,
    requestDiagnostics: { version: 1, count: events.length, events },
  };
}
