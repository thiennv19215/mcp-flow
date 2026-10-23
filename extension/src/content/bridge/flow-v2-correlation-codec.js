/*
 * Google Flow V2 request codec.
 *
 * This file is deliberately independent from the network hook. It only
 * normalizes prompt/reference data and decodes the small RPC row shapes that
 * the observer needs for correlation. Keeping this contract separate makes it
 * possible to update Flow's payload layout without touching XHR/fetch wiring.
 */
(() => {
  "use strict";

  const root = globalThis;
  if (root.FlowV2CorrelationCodec?.version >= 1) return;

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function normalizePrompt(value) {
    return String(value || "")
      .normalize("NFKC")
      .trim()
      .replace(/\s+/g, " ");
  }

  function normalizedRefs(ids) {
    return [...new Set((ids || []).map(id => String(id).toLowerCase()))].sort();
  }

  function fnv1a(value, seed = 2166136261) {
    let hash = seed >>> 0;
    const input = String(value || "");
    for (let index = 0; index < input.length; index++) {
      hash = Math.imul(hash ^ input.charCodeAt(index), 16777619);
    }
    return hash >>> 0;
  }

  function identityFingerprint(values) {
    const input = [...new Set(values || [])].sort().join("|");
    return `id-${fnv1a(input).toString(16).padStart(8, "0")}`;
  }

  function promptFingerprint(value) {
    return identityFingerprint([normalizePrompt(value)]);
  }

  function generationFingerprint({ prompt, promptFingerprint: promptToken, model, ratio, referenceIds, characterIds } = {}) {
    return identityFingerprint([
      `prompt:${promptToken || normalizePrompt(prompt)}`,
      `model:${String(model || "").trim().toLowerCase()}`,
      `ratio:${String(ratio ?? "").trim()}`,
      `refs:${normalizedRefs(referenceIds).join(",")}`,
      `characters:${normalizedRefs(characterIds).join(",")}`,
    ]);
  }

  function videoInputNodes(row) {
    const canonical = row?.[0]?.[2]?.[0];
    if (Array.isArray(canonical) && canonical.length) return canonical;
    const edit = row?.[1]?.[2]?.[0];
    if (
      row?.[0]?.[0] == null &&
      UUID_RE.test(row?.[0]?.[1] || "") &&
      Number.isInteger(row?.[0]?.[2]) &&
      Number.isInteger(row?.[0]?.[3]) &&
      row[0][2] >= 0 &&
      row[0][3] > row[0][2] &&
      typeof row[2] === "string" &&
      Array.isArray(edit) &&
      edit.length
    ) return edit;
    const observedEightField = row?.[2]?.[0];
    return Array.isArray(observedEightField) && observedEightField.length ? observedEightField : null;
  }

  function decodeStructuredNodes(nodes) {
    if (!Array.isArray(nodes) || !nodes.length) return null;
    const parts = [];
    const characterIds = [];
    const voiceIds = [];
    for (const node of nodes) {
      if (!Array.isArray(node)) return null;
      if (typeof node[0] === "string" && node.slice(1).every(value => value == null)) {
        if (parts[parts.length - 1]?.kind === "text") parts[parts.length - 1].text += node[0];
        else parts.push({ kind: "text", text: node[0] });
        continue;
      }
      if (node[0] != null || !Array.isArray(node[1]) || node.slice(2).some(value => value != null)) return null;
      const ref = node[1];
      let kind;
      let pair;
      if (Array.isArray(ref[1]) && ref.slice(2).every(value => value == null)) {
        kind = "voice";
        pair = ref[1];
      } else if (ref[1] == null && Array.isArray(ref[2]) && ref.slice(3).every(value => value == null)) {
        kind = "character";
        pair = ref[2];
      } else return null;
      if (typeof pair[0] !== "string" || typeof pair[1] !== "string" || pair.slice(2).some(value => value != null)) return null;
      if (kind === "character" ? !UUID_RE.test(pair[0]) : !/^voices\/[a-z0-9_-]+$/i.test(pair[0])) return null;
      const id = pair[0].toLowerCase();
      parts.push({ kind, id });
      if (kind === "character") characterIds.push(id);
      else voiceIds.push(id);
    }
    if (!parts.some(part => part.kind !== "text")) return null;
    const canonicalParts = parts
      .filter(part => part.kind !== "text" || normalizePrompt(part.text))
      .map(part => part.kind === "text" ? { kind: "text", text: normalizePrompt(part.text) } : part);
    return {
      fingerprint: promptFingerprint(JSON.stringify(canonicalParts)),
      textFingerprint: promptFingerprint(parts.filter(part => part.kind === "text").map(part => normalizePrompt(part.text)).join("")),
      characterIds: normalizedRefs(characterIds),
      voiceIds: [...new Set(voiceIds)].sort(),
    };
  }

  function videoRowModelRatio(row) {
    // Positional wire layout, mirroring the observer's row decode: the model
    // key is the string at [2], [1] or [4], with the ratio enum immediately
    // after it. Any other shape means the row carries no readable pair.
    if (typeof row?.[2] === "string") return { model: row[2], ratio: row[3] };
    if (typeof row?.[1] === "string") return { model: row[1], ratio: row[2] };
    if (typeof row?.[4] === "string") return { model: row[4], ratio: row[5] };
    return null;
  }

  function plainInputSummary(payload) {
    const rows = payload?.[0];
    if (!Array.isArray(rows) || !rows.length) return null;
    const values = rows.map(row => {
      const nodes = videoInputNodes(row);
      if (!Array.isArray(nodes) || !nodes.length || nodes.some(node => !Array.isArray(node) || typeof node[0] !== "string" || node.slice(1).some(value => value != null))) return null;
      const normalized = normalizePrompt(nodes.map(node => node[0]).join(""));
      const decoded = videoRowModelRatio(row);
      return {
        fingerprint: promptFingerprint(normalized),
        anchorFingerprint: promptFingerprint(normalized.slice(0, 512)),
        normalizedLength: normalized.length,
        model: decoded && decoded.model ? decoded.model : null,
        ratio: decoded && Number.isInteger(decoded.ratio) && decoded.ratio >= 1 ? decoded.ratio : null,
      };
    });
    if (!values.every(value => value && value.fingerprint === values[0].fingerprint)) return null;
    const summary = {
      fingerprint: values[0].fingerprint,
      anchorFingerprint: values[0].anchorFingerprint,
      normalizedLength: values[0].normalizedLength,
    };
    // VID-03: the summary also carries the wire model key and ratio enum
    // when every row decodes the same value. Disagreement between rows or an
    // unreadable field leaves the key absent, which consumers treat as
    // "don't care" — the same contract as an arm without expectations.
    if (values.every(value => value.model !== null && value.model === values[0].model)) summary.model = values[0].model;
    if (values.every(value => value.ratio !== null && value.ratio === values[0].ratio)) summary.ratio = values[0].ratio;
    return summary;
  }

  function classifyError(value) {
    const code = String(value || "").trim().toUpperCase();
    return /^(?:PUBLIC_ERROR(?:_[A-Z0-9]+)*|SEXUALLY_EXPLICIT|CHILD_SAFETY|[A-Z][A-Z0-9_]*(?:_ERROR|_FAILED|_FAILURE))$/.test(code)
      ? code
      : null;
  }

  root.FlowV2CorrelationCodec = Object.freeze({
    version: 1,
    UUID_RE,
    normalizePrompt,
    normalizedRefs,
    fnv1a,
    identityFingerprint,
    promptFingerprint,
    generationFingerprint,
    videoInputNodes,
    decodeStructuredNodes,
    plainInputSummary,
    classifyError,
  });
})();
