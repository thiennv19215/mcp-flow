export type FlowErrorCategory =
  | "quota"
  | "rate_limit"
  | "session"
  | "download"
  | "generation"
  | "extension"
  | "unsupported"
  | "unknown";

export type FlowErrorPolicy = {
  category: FlowErrorCategory;
  retryable: boolean;
  autoRetry: boolean;
  cooldownMs: number;
  outcomeUnknown: boolean;
};

type ErrorLike = { code?: unknown; message?: unknown; category?: unknown; retryable?: unknown; outcome_unknown?: unknown } | null;
const SECOND = 1000;

export function classifyFlowFailure(error: unknown): FlowErrorPolicy {
  const value = error && typeof error === "object" ? error as ErrorLike : null;
  const code = String(value?.code ?? "").toUpperCase();
  const message = String(value?.message ?? error ?? "");
  const text = `${code} ${message}`.toLowerCase();
  const outcomeUnknown = value?.outcome_unknown === true;

  if (/quota|credit|daily generation limit/.test(text) || code === "FLOW_QUOTA_EXCEEDED") {
    return { category: "quota", retryable: false, autoRetry: false, cooldownMs: 0, outcomeUnknown };
  }
  if (/rate.?limit|resource_exhausted|too many requests/.test(text) || code === "FLOW_RATE_LIMIT") {
    const seconds = message.match(/(?:retry|try again|wait)(?:\s+in)?\s+(\d{1,3})\s*(?:s|sec|seconds?)/i)?.[1];
    const cooldownMs = Math.max(15, Math.min(300, Number(seconds ?? 30))) * SECOND;
    const safe = !outcomeUnknown;
    return { category: "rate_limit", retryable: safe, autoRetry: safe, cooldownMs, outcomeUnknown };
  }
  if (/auth|sign.?in|login|session expired|not signed in|flow_not_ready|flow_project_required/.test(text)) {
    return { category: "session", retryable: !outcomeUnknown, autoRetry: false, cooldownMs: 0, outcomeUnknown };
  }
  if (/download|chrome download|media remains in flow/.test(text) || code.includes("DOWNLOAD")) {
    return { category: "download", retryable: !outcomeUnknown, autoRetry: false, cooldownMs: 0, outcomeUnknown };
  }
  if (/native_capability_unsupported|flow_model_unsupported|flow_invalid_argument|unsupported/.test(text)) {
    return { category: "unsupported", retryable: false, autoRetry: false, cooldownMs: 0, outcomeUnknown };
  }
  if (/extension|websocket|connector offline|connector disconnected/.test(text) || code.startsWith("EXTENSION_")) {
    return { category: "extension", retryable: !outcomeUnknown, autoRetry: false, cooldownMs: 0, outcomeUnknown };
  }
  if (/flow_generation/.test(text) || /flow_operation_timeout/.test(text) || /agent finished without creating/i.test(message)) {
    const safeAgentRetry = /agent finished without creating/i.test(message) && !outcomeUnknown;
    return { category: "generation", retryable: value?.retryable === true || safeAgentRetry, autoRetry: safeAgentRetry, cooldownMs: 0, outcomeUnknown };
  }
  return {
    category: (typeof value?.category === "string" && ["quota", "rate_limit", "session", "download", "generation", "extension", "unsupported"].includes(value.category)
      ? value.category as FlowErrorCategory : "unknown"),
    retryable: value?.retryable === true && !outcomeUnknown,
    autoRetry: false,
    cooldownMs: 0,
    outcomeUnknown,
  };
}
