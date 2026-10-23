(function (root) {
  "use strict";

  // GPT-03 — ChatGPT reference resolution contract.
  //
  // Logic (adapted from the reference provider design, not its code): for
  // the ChatGPT provider, reference images are uploaded payloads, never
  // library references. This module is the gate that enforces the split:
  // it builds the ref payload list ONLY from staged-file records that
  // already carry their bytes (a base64 string, a base64 data URL, or a
  // byte array). Any ID-only input — a bare library/tile/media ID, a URL
  // without a payload, an id-shaped descriptor object — is dropped with a
  // per-item rejection marker and is NEVER resolved against any library
  // (there is deliberately no library lookup in this module at all).
  // Accepted payloads keep their input order and are capped at
  // maxRefImages, supplied by the caller from the capability registry
  // (GPT-01); excess payloads are dropped as over_cap, first-N wins.
  //
  // The function is pure and defensive: malformed records are dropped
  // with reasons, never thrown on.

  const REJECTION_REASONS = Object.freeze({
    // A scalar passed directly — a bare ID or URL, not a record.
    BARE_REFERENCE: "bare_reference",
    // Not a record at all (null, undefined, array, function, ...).
    MALFORMED_RECORD: "malformed_record",
    // A record object carrying no payload field — the ID-only case.
    MISSING_PAYLOAD: "missing_payload",
    // A payload field is present but unusable (bad base64, wrong type).
    INVALID_PAYLOAD: "invalid_payload",
    // A valid payload dropped because maxRefImages was already reached.
    OVER_CAP: "over_cap",
  });

  const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
  const DATA_URL_PATTERN = /^data:([^;,]*?)?(;base64)?,([\s\S]*)$/i;
  const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  const isNonEmptyString = value => typeof value === "string" && value.trim().length > 0;

  const firstString = (record, keys) => {
    for (const key of keys) {
      if (isNonEmptyString(record[key])) return record[key].trim();
    }
    return null;
  };

  // Validates a raw base64 string; returns the whitespace-stripped form or
  // null. Charset + padding placement + a plausible length only — the gate
  // admits payloads, it does not decode them.
  const cleanBase64 = value => {
    const compact = value.replace(/\s+/g, "");
    if (!compact || compact.length % 4 === 1 || !BASE64_PATTERN.test(compact)) return null;
    return compact;
  };

  // Extracts { base64, mime } from a data URL, or null when the value is
  // not a base64 data URL. The mime is null when the URL declares none.
  const parseDataUrl = value => {
    const match = DATA_URL_PATTERN.exec(value.trim());
    if (!match || !match[2]) return null;
    const base64 = cleanBase64(match[3]);
    if (!base64) return null;
    return { base64, mime: isNonEmptyString(match[1]) ? match[1].trim() : null };
  };

  // A base64 field may hold either raw base64 or a whole data URL.
  const parseBase64Field = value => {
    if (/^data:/i.test(value.trim())) return parseDataUrl(value);
    const base64 = cleanBase64(value);
    return base64 ? { base64, mime: null } : null;
  };

  const encodeBase64 = bytes => {
    const parts = [];
    for (let i = 0; i < bytes.length; i += 3) {
      const hasSecond = i + 1 < bytes.length;
      const hasThird = i + 2 < bytes.length;
      const triple = (bytes[i] << 16) | ((hasSecond ? bytes[i + 1] : 0) << 8) | (hasThird ? bytes[i + 2] : 0);
      parts.push(
        BASE64_ALPHABET[(triple >> 18) & 63] +
        BASE64_ALPHABET[(triple >> 12) & 63] +
        (hasSecond ? BASE64_ALPHABET[(triple >> 6) & 63] : "=") +
        (hasThird ? BASE64_ALPHABET[triple & 63] : "=")
      );
    }
    return parts.join("");
  };

  // Converts a bytes payload (typed-array view, ArrayBuffer, or a plain
  // array of byte values) to a Uint8Array, or null when the value is not
  // usable bytes. Realm-agnostic checks (ArrayBuffer.isView / toString
  // tag) so records assembled in another frame or test realm still count.
  const toBytes = value => {
    if (ArrayBuffer.isView(value)) {
      if (value.byteLength === 0) return null;
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    if (Object.prototype.toString.call(value) === "[object ArrayBuffer]") {
      if (value.byteLength === 0) return null;
      return new Uint8Array(value);
    }
    if (Array.isArray(value)) {
      if (value.length === 0) return null;
      for (const byte of value) {
        if (!Number.isInteger(byte) || byte < 0 || byte > 255) return null;
      }
      return Uint8Array.from(value);
    }
    return null;
  };

  // Returns one of:
  //   { payload: { base64, mime } }  — the record carries a usable payload
  //   { reason }                     — why the record cannot become a ref
  const extractPayload = record => {
    if (record.base64 !== undefined && record.base64 !== null) {
      if (typeof record.base64 !== "string") return { reason: REJECTION_REASONS.INVALID_PAYLOAD };
      const payload = parseBase64Field(record.base64);
      return payload ? { payload } : { reason: REJECTION_REASONS.INVALID_PAYLOAD };
    }
    if (record.dataUrl !== undefined && record.dataUrl !== null) {
      if (typeof record.dataUrl !== "string") return { reason: REJECTION_REASONS.INVALID_PAYLOAD };
      const payload = parseDataUrl(record.dataUrl);
      return payload ? { payload } : { reason: REJECTION_REASONS.INVALID_PAYLOAD };
    }
    if (record.data_url !== undefined && record.data_url !== null) {
      if (typeof record.data_url !== "string") return { reason: REJECTION_REASONS.INVALID_PAYLOAD };
      const payload = parseDataUrl(record.data_url);
      return payload ? { payload } : { reason: REJECTION_REASONS.INVALID_PAYLOAD };
    }
    if (record.bytes !== undefined && record.bytes !== null) {
      const bytes = toBytes(record.bytes);
      return bytes
        ? { payload: { base64: encodeBase64(bytes), mime: null } }
        : { reason: REJECTION_REASONS.INVALID_PAYLOAD };
    }
    return { reason: REJECTION_REASONS.MISSING_PAYLOAD };
  };

  const classifyNonRecord = item => {
    if (item === null || item === undefined) return REJECTION_REASONS.MALFORMED_RECORD;
    const type = typeof item;
    if (type === "string" || type === "number" || type === "boolean" || type === "bigint") {
      return REJECTION_REASONS.BARE_REFERENCE;
    }
    return REJECTION_REASONS.MALFORMED_RECORD;
  };

  // Only a finite, non-negative number caps the list; anything else (the
  // registry always supplies a real cap) means "no cap" rather than a
  // surprise rejection of every ref.
  const normalizeCap = options => {
    const cap = options && typeof options === "object" ? options.maxRefImages : undefined;
    return typeof cap === "number" && Number.isFinite(cap) && cap >= 0 ? Math.floor(cap) : Infinity;
  };

  /**
   * Builds the ChatGPT ref payload list from staged-file records.
   *
   * @param {Array} records staged-file records and/or arbitrary ref descriptors.
   * @param {{maxRefImages?: number}} [options] cap from the capability registry.
   * @returns {{refs: Array<{fileId: string|null, base64: string, name: string|null, type: string}>,
   *            rejected: Array<{index: number, reason: string}>, capped: boolean}}
   */
  function resolveRefs(records, options = {}) {
    const refs = [];
    const rejected = [];
    let capped = false;
    if (records === null || records === undefined) return { refs, rejected, capped };
    const items = Array.isArray(records) ? records : [records];
    const cap = normalizeCap(options);

    items.forEach((item, index) => {
      try {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          rejected.push({ index, reason: classifyNonRecord(item) });
          return;
        }
        const { payload, reason } = extractPayload(item);
        if (!payload) {
          rejected.push({ index, reason });
          return;
        }
        if (refs.length >= cap) {
          capped = true;
          rejected.push({ index, reason: REJECTION_REASONS.OVER_CAP });
          return;
        }
        refs.push({
          fileId: firstString(item, ["fileId", "transferId", "id"]),
          base64: payload.base64,
          name: firstString(item, ["name", "fileName"]),
          type: firstString(item, ["type", "mimeType"]) || payload.mime || "application/octet-stream",
        });
      } catch {
        rejected.push({ index, reason: REJECTION_REASONS.MALFORMED_RECORD });
      }
    });

    return { refs, rejected, capped };
  }

  root.ChatGptRefResolution = Object.freeze({
    resolveRefs,
    REJECTION_REASONS,
  });
})(globalThis);
