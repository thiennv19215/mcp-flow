export type FlowErrorCategory =
  | "quota"
  | "rate_limit"
  | "session"
  | "captcha"
  | "policy"
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
  const foldedText = text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[đĐ]/g, "d");
  const searchableText = `${text} ${foldedText}`;
  const outcomeUnknown = value?.outcome_unknown === true;

  if (/quota|credit|daily generation limit|khong du (?:tin dung|diem tin dung)|het (?:han muc|tin dung|luot tao)|vuot(?: qua)? han muc|gioi han tao hang ngay/.test(searchableText) || code === "FLOW_QUOTA_EXCEEDED") {
    return { category: "quota", retryable: false, autoRetry: false, cooldownMs: 0, outcomeUnknown };
  }
  if (/rate.?limit|resource_exhausted|too many requests|gioi han (?:tan suat|yeu cau)|qua nhieu yeu cau|he thong dang ban/.test(searchableText) || code === "FLOW_RATE_LIMIT") {
    const seconds = message.match(/(?:retry|try again|wait|thu lai)(?:\s+in|\s+sau)?\s+(\d{1,3})\s*(?:s|sec|seconds?|giay)/i)?.[1];
    const cooldownMs = Math.max(15, Math.min(300, Number(seconds ?? 30))) * SECOND;
    const safe = !outcomeUnknown;
    return { category: "rate_limit", retryable: safe, autoRetry: safe, cooldownMs, outcomeUnknown };
  }
  if (/auth|sign.?in|login|session expired|not signed in|flow_session_required|flow_not_ready|flow_project_required|vui long dang nhap|hay dang nhap|can dang nhap|phien dang nhap het han|chua dang nhap/.test(searchableText)) {
    return { category: "session", retryable: !outcomeUnknown, autoRetry: false, cooldownMs: 0, outcomeUnknown };
  }
  if (/flow_unusual_activity|bot.?detected|captcha|unusual activity|suspicious activity|hoat dong bat thuong|xac minh.*captcha/.test(searchableText)) {
    return { category: "captcha", retryable: false, autoRetry: false, cooldownMs: 0, outcomeUnknown };
  }
  if (/flow_policy_violation|content.?blocked|policy violation|safety guidelines|sexually_explicit|child_safety|vi pham (?:chinh sach|nguyen tac)|chinh sach an toan|noi dung khong an toan|cau lenh khong hop le/.test(searchableText)) {
    return { category: "policy", retryable: false, autoRetry: false, cooldownMs: 0, outcomeUnknown };
  }
  if (/flow_project_load_failed|flow_media_viewer_open|flow_screen_not_ready|du an (?:khong ton tai|khong kha dung)|khong the tai (?:du an|project)|khong tim thay du an/.test(searchableText)) {
    return { category: "generation", retryable: value?.retryable === true && !outcomeUnknown, autoRetry: false, cooldownMs: 0, outcomeUnknown };
  }
  if (/download|chrome download|media remains in flow/.test(text) || code.includes("DOWNLOAD")) {
    return { category: "download", retryable: !outcomeUnknown, autoRetry: false, cooldownMs: 0, outcomeUnknown };
  }
  if (/native_capability_unsupported|flow_model_unsupported|flow_invalid_argument|unsupported/.test(text)) {
    return { category: "unsupported", retryable: false, autoRetry: false, cooldownMs: 0, outcomeUnknown };
  }
  if (/extension|websocket|connector offline|connector disconnected|flow_screen_preflight_unavailable/.test(text) || code.startsWith("EXTENSION_")) {
    return { category: "extension", retryable: !outcomeUnknown, autoRetry: false, cooldownMs: 0, outcomeUnknown };
  }
  if (/flow_generation/.test(text) || /flow_operation_timeout/.test(text) || /agent finished without creating/i.test(message)) {
    const safeAgentRetry = /agent finished without creating/i.test(message) && !outcomeUnknown;
    return { category: "generation", retryable: value?.retryable === true || safeAgentRetry, autoRetry: safeAgentRetry, cooldownMs: 0, outcomeUnknown };
  }
  return {
    category: (typeof value?.category === "string" && ["quota", "rate_limit", "session", "captcha", "policy", "download", "generation", "extension", "unsupported"].includes(value.category)
      ? value.category as FlowErrorCategory : "unknown"),
    retryable: value?.retryable === true && !outcomeUnknown,
    autoRetry: false,
    cooldownMs: 0,
    outcomeUnknown,
  };
}
