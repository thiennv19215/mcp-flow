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

export interface SafeFlowOperationDiagnostics {
  locale: "en" | "vi" | "unknown";
  activeCategory: "all" | "characters" | "voices" | "uploads" | "ingredients" | "unknown";
  categoriesScanned: Array<"all" | "uploads">;
  categorySelected: boolean;
  searchLabelRecognized: boolean;
  searchLabel: "search assets" | "tìm kiếm nội dung nghe nhìn" | "tìm kiếm nội dung" | "tìm kiếm" | "search" | null;
  searchResultsVerified: boolean;
  optionCount: number;
  pages: number;
  endReached: boolean;
  optionLabelHashes: string[];
  exactTargetFound: boolean;
  scrollOwnerCount: number;
  scrollOwnerDepth: number | null;
  scrollClientHeight: number;
  scrollHeight: number;
  scrollTop: number;
  tileActionAttempted: boolean;
  tileActionStep: "queued" | "menu_missing" | "menu_owned" | "action_clicked" | "chip_confirmed" | null;
  tileActionMenuObserved: boolean;
  errorCode: string | null;
  quoteDiagnostics?: {
    candidateCount: number;
    reasonCodes: Array<"english_will_use" | "vietnamese_use" | "unrecognized_credit_text" | "no_candidate">;
  };
}

/** Keep pre-dispatch picker diagnostics small and free of user asset data. */
export function sanitizeFlowOperationDiagnostics(value: unknown): SafeFlowOperationDiagnostics | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const source = input.operationDiagnostics && typeof input.operationDiagnostics === "object" && !Array.isArray(input.operationDiagnostics)
    ? input.operationDiagnostics as Record<string, unknown>
    : input;
  const labels = new Set(["search assets", "tìm kiếm nội dung nghe nhìn", "tìm kiếm nội dung", "tìm kiếm", "search"]);
  const errorCode = typeof source.errorCode === "string" && /^FLOW_[A-Z0-9_]{1,80}$/.test(source.errorCode)
    ? source.errorCode
    : null;
  const boundedCount = (entry: unknown, max: number): number => Number.isSafeInteger(entry) && Number(entry) >= 0 && Number(entry) <= max ? Number(entry) : 0;
  const rawQuote = input.quoteDiagnostics && typeof input.quoteDiagnostics === "object" && !Array.isArray(input.quoteDiagnostics)
    ? input.quoteDiagnostics as Record<string, unknown>
    : source.quoteDiagnostics && typeof source.quoteDiagnostics === "object" && !Array.isArray(source.quoteDiagnostics)
      ? source.quoteDiagnostics as Record<string, unknown>
      : null;
  const quoteDiagnostics = rawQuote ? {
    candidateCount: boundedCount(rawQuote.candidateCount, 100),
    reasonCodes: Array.isArray(rawQuote.reasonCodes)
      ? [...new Set(rawQuote.reasonCodes.filter((reason): reason is "english_will_use" | "vietnamese_use" | "unrecognized_credit_text" | "no_candidate" =>
        reason === "english_will_use" || reason === "vietnamese_use" || reason === "unrecognized_credit_text" || reason === "no_candidate"))].slice(0, 4)
      : [],
  } : undefined;
  return {
    locale: source.locale === "en" || source.locale === "vi" ? source.locale : "unknown",
    activeCategory: source.activeCategory === "all" || source.activeCategory === "characters" || source.activeCategory === "voices" || source.activeCategory === "uploads" || source.activeCategory === "ingredients"
      ? source.activeCategory : "unknown",
    categoriesScanned: Array.isArray(source.categoriesScanned)
      ? [...new Set(source.categoriesScanned.filter((entry): entry is "all" | "uploads" => entry === "all" || entry === "uploads"))].slice(0, 2)
      : [],
    categorySelected: source.categorySelected === true,
    searchLabelRecognized: source.searchLabelRecognized === true,
    searchLabel: typeof source.searchLabel === "string" && labels.has(source.searchLabel) ? source.searchLabel as SafeFlowOperationDiagnostics["searchLabel"] : null,
    searchResultsVerified: source.searchResultsVerified === true,
    optionCount: boundedCount(source.optionCount, 500),
    pages: boundedCount(source.pages, 60),
    endReached: source.endReached === true,
    optionLabelHashes: Array.isArray(source.optionLabelHashes)
      ? [...new Set(source.optionLabelHashes.filter((entry): entry is string => typeof entry === "string" && /^h-[0-9a-f]{8}$/.test(entry)))].slice(0, 60)
      : [],
    exactTargetFound: source.exactTargetFound === true,
    scrollOwnerCount: boundedCount(source.scrollOwnerCount, 16),
    scrollOwnerDepth: Number.isInteger(source.scrollOwnerDepth) && Number(source.scrollOwnerDepth) >= -5 && Number(source.scrollOwnerDepth) <= 1
      ? Number(source.scrollOwnerDepth) : null,
    scrollClientHeight: boundedCount(source.scrollClientHeight, 10000),
    scrollHeight: boundedCount(source.scrollHeight, 10000),
    scrollTop: boundedCount(source.scrollTop, 10000),
    tileActionAttempted: source.tileActionAttempted === true,
    tileActionStep: source.tileActionStep === "queued" || source.tileActionStep === "menu_missing" || source.tileActionStep === "menu_owned" || source.tileActionStep === "action_clicked" || source.tileActionStep === "chip_confirmed"
      ? source.tileActionStep : null,
    tileActionMenuObserved: source.tileActionMenuObserved === true,
    errorCode,
    ...(quoteDiagnostics ? { quoteDiagnostics } : {}),
  };
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
