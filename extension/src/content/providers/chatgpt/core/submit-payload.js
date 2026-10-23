(function (root) {
  "use strict";

  // GPT-02 — ChatGPT submit payload builder.
  //
  // Logic (adapted from the reference provider design, not its code): the
  // queue payload for a ChatGPT generation job is turned into the content
  // command the driver executes by a PURE builder, so every normalization
  // decision is made once, early, and is testable without a page:
  //
  //   prompt          carried verbatim — the submitted prompt is exactly
  //                   the job's prompt; the builder never mutates it.
  //   ratio           normalized early from many spellings to one of five
  //                   semantic buckets (study B17), using GPT-01's
  //                   semantics (see the ratio section below).
  //   model           passthrough — admission/preflight owns validation;
  //                   the builder carries what it is given.
  //   fallbackPrefix  defaulted here ("Generate an image of: " when
  //                   nothing supplies one) so the driver can fall back to
  //                   prefixing the prompt if image-mode activation fails
  //                   at runtime (B17). The builder defaults the VALUE; it
  //                   does not prepend it — applying it is the driver's
  //                   runtime decision.
  //   refs            GPT-03's resolution output {refs, rejected, capped}
  //                   carried through untouched. The builder NEVER
  //                   re-resolves: raw `attachments` on the payload are not
  //                   consulted, so a library/ID reference can never slip
  //                   in through this path.
  //   timeoutMs       resolved from the payload, else from the timing
  //                   config. A missing or invalid timing value is a
  //                   TYPED CONFIG ERROR thrown immediately (B4): a
  //                   missing config must never become a hang, and an
  //                   explicitly invalid payload value is never silently
  //                   replaced by a config value.

  const OPERATION = "chatgpt.generation.submit";

  // B17: the reference driver's fallback prefix when the Create-image
  // toggle cannot be activated.
  const DEFAULT_FALLBACK_PREFIX = "Generate an image of: ";

  const TIMING_CONFIG_ERROR_CODE = "CHATGPT_TIMING_CONFIG_INVALID";

  // The timing config must be "present and in range" (B4): any positive
  // whole millisecond count up to a 30-minute ceiling. The ceiling exists
  // so a corrupt config (e.g. a value in seconds, or unbounded) fails fast
  // instead of parking a queue job for hours.
  const MAX_TIMEOUT_MS = 1_800_000;

  // --- Ratio semantics -------------------------------------------------
  //
  // GPT-01 owns these tables on the background side
  // (extension/src/background/chatgpt-capabilities.js). A content module
  // cannot import a background module, so the builder resolves the bucket
  // with this precedence:
  //   1. an injected normalizer (options.normalizeRatio) — the caller can
  //      hand in GPT-01's own normalizeChatGptRatio;
  //   2. a semantics map read from the registry object passed in
  //      (options.registry / options.ratioSemantics), fed to the built-in
  //      algorithm below;
  //   3. the built-in tables, which are DATA-IDENTICAL copies of GPT-01's
  //      CHATGPT_RATIO_SEMANTICS / RATIO_LABELS (same canonicalization,
  //      same label set, same square default). If GPT-01's tables ever
  //      change, these copies must change with them.

  const RATIO_SEMANTICS = Object.freeze({
    "16:9": "widescreen",
    "9:16": "story",
    "1:1": "square",
    "4:3": "landscape",
    "3:4": "portrait",
  });

  const SUPPORTED_RATIOS = Object.freeze(["16:9", "9:16", "1:1", "4:3", "3:4"]);

  // ChatGPT's image mode falls back to a square render when no ratio is
  // requested, so the default bucket is square (1:1) — as in GPT-01.
  const DEFAULT_RATIO_SEMANTIC = "square";

  const RATIO_LABELS = Object.freeze({
    widescreen: "widescreen",
    "wide screen": "widescreen",
    wide: "widescreen",
    "man hinh rong": "widescreen",
    "kho rong": "widescreen",
    story: "story",
    stories: "story",
    "cau chuyen": "story",
    square: "square",
    vuong: "square",
    "hinh vuong": "square",
    landscape: "landscape",
    horizontal: "landscape",
    ngang: "landscape",
    "kho ngang": "landscape",
    "nam ngang": "landscape",
    portrait: "portrait",
    vertical: "portrait",
    doc: "portrait",
    "kho doc": "portrait",
    "nam doc": "portrait",
    "chan dung": "portrait",
  });

  function gcd(a, b) {
    return b === 0 ? a : gcd(b, a % b);
  }

  function canonicalRatioSpelling(width, height) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
    const divisor = gcd(width, height);
    return `${width / divisor}:${height / divisor}`;
  }

  function stripDiacritics(text) {
    return text
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/đ/g, "d")
      .replace(/Đ/g, "D");
  }

  function normalizeLabelText(value) {
    return stripDiacritics(String(value).normalize("NFKC").trim().toLowerCase()).replace(/\s+/g, " ");
  }

  // Data-identical mirror of GPT-01's normalizeChatGptRatio: canonical
  // spellings, separator variants, reducible spellings, semantic words and
  // localized labels all land in one of the five buckets; an
  // already-normalized bucket passes through unchanged (idempotent);
  // unknown input returns the square default. Never throws.
  function normalizeRatio(value, semantics = RATIO_SEMANTICS) {
    if (typeof value !== "string") return DEFAULT_RATIO_SEMANTIC;
    const map = semantics && typeof semantics === "object" ? semantics : RATIO_SEMANTICS;
    const text = value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
    if (!text) return DEFAULT_RATIO_SEMANTIC;

    const numeric = text.match(/(\d+)\s*[:x\/-]\s*(\d+)/);
    if (numeric) {
      const canonical = canonicalRatioSpelling(Number(numeric[1]), Number(numeric[2]));
      if (canonical) return typeof map[canonical] === "string" ? map[canonical] : DEFAULT_RATIO_SEMANTIC;
    }

    const label = RATIO_LABELS[normalizeLabelText(text)];
    return label || DEFAULT_RATIO_SEMANTIC;
  }

  // The canonical "W:H" spelling for a raw ratio input: the reduced
  // numeric spelling when the input carries one, else the first supported
  // spelling whose bucket (in the effective semantics) is the normalized
  // bucket, else null.
  function canonicalSpellingFor(value, bucket, semantics) {
    if (typeof value === "string") {
      const numeric = value.normalize("NFKC").trim().toLowerCase().match(/(\d+)\s*[:x\/-]\s*(\d+)/);
      if (numeric) {
        const canonical = canonicalRatioSpelling(Number(numeric[1]), Number(numeric[2]));
        if (canonical) return canonical;
      }
    }
    for (const spelling of SUPPORTED_RATIOS) {
      if (semantics && semantics[spelling] === bucket) return spelling;
    }
    return null;
  }

  function semanticsFrom(options) {
    if (options.ratioSemantics && typeof options.ratioSemantics === "object") {
      return options.ratioSemantics;
    }
    const registry = options.registry;
    if (registry && typeof registry === "object") {
      if (registry.defaults && typeof registry.defaults === "object"
        && registry.defaults.ratioSemantics && typeof registry.defaults.ratioSemantics === "object") {
        return registry.defaults.ratioSemantics;
      }
      if (registry.ratioSemantics && typeof registry.ratioSemantics === "object") {
        return registry.ratioSemantics;
      }
    }
    return RATIO_SEMANTICS;
  }

  // --- Typed timing-config error ----------------------------------------

  function timingConfigError(field, value, reason) {
    const error = new Error(
      `ChatGPT submit requires a valid timing config: ${field} ${reason}. ` +
      "A missing or invalid timing config fails fast instead of hanging a wait loop.",
    );
    error.name = "ChatGptTimingConfigError";
    error.code = TIMING_CONFIG_ERROR_CODE;
    error.retryable = false;
    error.outcome_unknown = false;
    error.noRetry = true;
    error.diagnostics = { field, reason };
    if (value !== undefined) {
      error.diagnostics.value = typeof value === "number" || typeof value === "string"
        ? String(value)
        : typeof value;
    }
    return error;
  }

  function validateTimeout(value, field) {
    if (typeof value !== "number") throw timingConfigError(field, value, "must be a number of milliseconds");
    if (!Number.isFinite(value)) throw timingConfigError(field, value, "must be finite");
    if (value <= 0 || value > MAX_TIMEOUT_MS) {
      throw timingConfigError(field, value, `must be in the range (0, ${MAX_TIMEOUT_MS}] milliseconds`);
    }
    const resolved = Math.floor(value);
    if (resolved < 1) throw timingConfigError(field, value, "must resolve to at least 1 millisecond");
    return resolved;
  }

  const firstPresent = (...values) => values.find(value => value !== undefined && value !== null);
  const asObject = value => (value && typeof value === "object" && !Array.isArray(value) ? value : {});

  // Resolution order: the payload's own timeout wins; the timing config
  // (options.timing, then options.timeoutMs / options.config) is consulted
  // only when the payload carries none. A present-but-invalid value at the
  // level actually consulted is fatal — it is never skipped over in favor
  // of a lower-precedence source.
  function resolveTimeoutMs(payload, options) {
    const payloadTimeout = firstPresent(payload.timeoutMs, payload.timeout_ms);
    if (payloadTimeout !== undefined) return validateTimeout(payloadTimeout, "timeoutMs");

    const timing = asObject(options.timing);
    const config = asObject(options.config);
    const configTimeout = firstPresent(
      timing.timeoutMs,
      timing.timeout_ms,
      options.timeoutMs,
      config.timeoutMs,
      config.timeout_ms,
    );
    if (configTimeout === undefined) {
      throw timingConfigError(
        "timeoutMs",
        undefined,
        "is missing from the payload and no timing config was supplied",
      );
    }
    return validateTimeout(configTimeout, "timeoutMs");
  }

  // --- Small field helpers ------------------------------------------------

  const firstUsableString = (...values) => {
    for (const value of values) {
      if (typeof value === "string" && value.trim().length > 0) return value.trim();
    }
    return null;
  };

  // The fallback prefix is carried verbatim (its trailing space is
  // meaningful); only blank/non-string candidates are skipped.
  const firstUsablePrefix = (...values) => {
    for (const value of values) {
      if (typeof value === "string" && value.trim().length > 0) return value;
    }
    return null;
  };

  // GPT-03's output is the only refs source: options first, then a result
  // stashed on the payload. It must have the contract shape ({refs: [...]})
  // to count — anything else is treated as "no resolution was supplied".
  function refsSourceFrom(payload, options) {
    for (const candidate of [options.refsResult, options.refs, payload.refsResult, payload.refs]) {
      if (candidate && typeof candidate === "object" && Array.isArray(candidate.refs)) return candidate;
    }
    return null;
  }

  /**
   * Builds the ChatGPT content command from a queue payload.
   *
   * @param {object} queuePayload {prompt, ratio, model?, timeoutMs?, ...}
   * @param {object} [options] {refsResult|refs, registry|ratioSemantics,
   *   normalizeRatio?, timing|timeoutMs|config, fallbackPrefix?,
   *   conversationId?}
   * @returns the content command for `chatgpt.generation.submit`.
   * @throws a typed CHATGPT_TIMING_CONFIG_INVALID error when no valid
   *   timeout can be resolved.
   */
  function buildSubmitPayload(queuePayload, options = {}) {
    const payload = asObject(queuePayload);
    const opts = asObject(options);
    const config = asObject(opts.config);

    const timeoutMs = resolveTimeoutMs(payload, opts);

    const semantics = semanticsFrom(opts);
    const bucket = typeof opts.normalizeRatio === "function"
      ? opts.normalizeRatio(payload.ratio, semantics)
      : normalizeRatio(payload.ratio, semantics);
    const ratio = typeof bucket === "string" && bucket ? bucket : DEFAULT_RATIO_SEMANTIC;
    const ratioSpelling = canonicalSpellingFor(payload.ratio, ratio, semantics);

    const imageMode = payload.imageMode !== false && payload.image_mode !== false;
    const fallbackPrefix = imageMode
      ? firstUsablePrefix(
          payload.fallbackPrefix,
          payload.fallback_prefix,
          opts.fallbackPrefix,
          config.fallbackPrefix,
          config.fallback_prefix,
        ) || DEFAULT_FALLBACK_PREFIX
      : null;

    const refsSource = refsSourceFrom(payload, opts);

    return {
      operation: OPERATION,
      prompt: typeof payload.prompt === "string"
        ? payload.prompt
        : payload.prompt == null ? "" : String(payload.prompt),
      ratio,
      ratioSpelling,
      model: firstUsableString(payload.model, payload.modelId, payload.model_id),
      imageMode,
      fallbackPrefix,
      refs: refsSource ? [...refsSource.refs] : [],
      refRejections: refsSource && Array.isArray(refsSource.rejected) ? [...refsSource.rejected] : [],
      refsCapped: refsSource ? refsSource.capped === true : false,
      timeoutMs,
      conversationId: firstUsableString(payload.conversationId, payload.conversation_id, opts.conversationId),
    };
  }

  root.ChatGptSubmitPayload = Object.freeze({
    buildSubmitPayload,
    normalizeRatio,
    OPERATION,
    DEFAULT_FALLBACK_PREFIX,
    TIMING_CONFIG_ERROR_CODE,
    MAX_TIMEOUT_MS,
    RATIO_SEMANTICS,
  });
})(globalThis);
