// ChatGPT generation outcome classifier (GPT-06).
//
// A pure state machine over wait-sample sequences. The content driver polls
// the new assistant turn and folds each observation in as a sample:
//
//   { streaming, textLength, imageCount, errorPresent, errorDetail }
//
// `streaming` is only ever false on an explicit observation — an absent flag
// means "still streaming", never "ended". `imageCount` counts *qualifying*
// (generated) images, as produced by result extraction, not raw renders.
// A sample may carry `deadlineReached: true` when the caller's wait budget
// fired alongside that observation.
//
// Decisions (exactly one, terminal):
//   success   — the stream ENDED with >= 1 qualifying image. Images seen
//               while the stream is still open never decide success.
//   text_only — the stream ended with text but zero qualifying images,
//               decided after a settle grace of consecutive stream-ended
//               samples (images may still land during the grace), or when
//               the deadline truncates the grace. Typed distinctly
//               (CHATGPT_TEXT_ONLY) — never folded into error/timeout.
//   error     — any sample with errorPresent decides immediately, in any
//               phase, carrying the sample's error detail. A stream that
//               ends with neither text nor images is the error NO_RESPONSE.
//   timeout   — the wait ended (deadline signal or sequence exhaustion)
//               with the stream still open.
//
// Every decision carries the diagnostic count bundle: samples seen, peak
// qualifying images, final text length / image count, stream state at the
// decision, the settle streak, and — when the samples provide them — the
// extraction counts (assistant/rendered/matched, per-selector, baseline).
//
// No timers, no DOM: callers drive the clock by pushing samples.
(function (root) {
  "use strict";

  const OUTCOME = Object.freeze({
    SUCCESS: "success",
    TEXT_ONLY: "text_only",
    ERROR: "error",
    TIMEOUT: "timeout",
  });

  const CODE = Object.freeze({
    TEXT_ONLY: "CHATGPT_TEXT_ONLY",
    NO_RESPONSE: "NO_RESPONSE",
    GENERATION_ERROR: "CHATGPT_GENERATION_ERROR",
    TIMEOUT: "CHATGPT_WAIT_TIMEOUT",
  });

  // Consecutive stream-ended samples required before a zero-image end of
  // stream is believed: images can render a beat after the stream flag
  // drops, so the first ended sample only opens the settle grace.
  const DEFAULT_SETTLE_SAMPLES = 2;

  const nonNegativeInt = (value) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
  };

  const normalizeSample = (raw) => {
    const source = raw && typeof raw === "object" ? raw : {};
    const errorDetail = source.errorDetail ?? source.error_detail ?? source.error ?? null;
    const sample = {
      // Stream end must be observed affirmatively; anything else streams.
      streaming: source.streaming !== false,
      textLength: nonNegativeInt(source.textLength ?? source.text_length),
      imageCount: nonNegativeInt(
        source.imageCount ?? source.qualifyingImageCount ?? source.image_count,
      ),
      errorPresent: source.errorPresent === true || source.error_present === true || errorDetail != null,
      errorDetail: errorDetail == null ? null : String(errorDetail),
      errorCode: typeof source.errorCode === "string" && source.errorCode ? source.errorCode : null,
      deadlineReached: source.deadlineReached === true || source.deadline_reached === true,
    };
    // Optional extraction counts (study B22 bundle). Passed through only
    // when the sample actually carries them; never fabricated here.
    if (source.assistantImageCount != null || source.assistant_image_count != null)
      sample.assistantImageCount = nonNegativeInt(source.assistantImageCount ?? source.assistant_image_count);
    if (source.renderedCount != null || source.rendered_count != null)
      sample.renderedCount = nonNegativeInt(source.renderedCount ?? source.rendered_count);
    if (source.matchedCount != null || source.matched_count != null)
      sample.matchedCount = nonNegativeInt(source.matchedCount ?? source.matched_count);
    if (source.perSelectorCounts && typeof source.perSelectorCounts === "object")
      sample.perSelectorCounts = { ...source.perSelectorCounts };
    else if (source.per_selector_counts && typeof source.per_selector_counts === "object")
      sample.perSelectorCounts = { ...source.per_selector_counts };
    if (source.baselineSourceCount != null || source.baseline_source_count != null)
      sample.baselineSourceCount = nonNegativeInt(source.baselineSourceCount ?? source.baseline_source_count);
    return sample;
  };

  function createOutcomeClassifier(options = {}) {
    const settleOption = Number(options?.settleSamples ?? options?.settle_samples);
    const settleSamples =
      Number.isFinite(settleOption) && settleOption >= 1
        ? Math.floor(settleOption)
        : DEFAULT_SETTLE_SAMPLES;

    let decision = null;
    let samplesSeen = 0;
    let peakImageCount = 0;
    let finalTextLength = 0;
    let finalImageCount = 0;
    let lastStreaming = null;
    let endedStreak = 0;
    let lastSample = null;

    const diagnostics = (endedBy) => {
      const bundle = {
        samples: samplesSeen,
        peakImageCount,
        finalTextLength,
        finalImageCount,
        streaming: lastStreaming,
        settleSamplesSeen: endedStreak,
        decidedAtSample: samplesSeen,
        endedBy,
      };
      if (lastSample) {
        for (const key of ["assistantImageCount", "renderedCount", "matchedCount", "perSelectorCounts", "baselineSourceCount"])
          if (lastSample[key] !== undefined) bundle[key] = lastSample[key];
      }
      return bundle;
    };

    const decide = (outcome, code, endedBy, error = null) => {
      decision = {
        outcome,
        code,
        imageCount: finalImageCount,
        textLength: finalTextLength,
        error,
        diagnostics: diagnostics(endedBy),
      };
      return decision;
    };

    // The wait is over (deadline signal or no more samples). A stream that
    // already ended is classified on its final state — only a still-open
    // stream can time out.
    const concludeWait = (endedBy) => {
      if (decision) return decision;
      if (lastSample && !lastSample.streaming && finalImageCount === 0) {
        if (finalTextLength > 0) return decide(OUTCOME.TEXT_ONLY, CODE.TEXT_ONLY, endedBy);
        return decide(OUTCOME.ERROR, CODE.NO_RESPONSE, endedBy);
      }
      return decide(OUTCOME.TIMEOUT, CODE.TIMEOUT, endedBy);
    };

    const push = (rawSample) => {
      if (decision) return decision;
      const sample = normalizeSample(rawSample);
      lastSample = sample;
      samplesSeen += 1;
      peakImageCount = Math.max(peakImageCount, sample.imageCount);
      finalTextLength = sample.textLength;
      finalImageCount = sample.imageCount;
      lastStreaming = sample.streaming;
      endedStreak = sample.streaming ? 0 : endedStreak + 1;

      // Error presence decides immediately, at any phase — including the
      // sample that ends the stream or carries images.
      if (sample.errorPresent)
        return decide(OUTCOME.ERROR, sample.errorCode || CODE.GENERATION_ERROR, "sample", sample.errorDetail);
      // Success requires the stream to have ENDED with a qualifying image.
      if (!sample.streaming && sample.imageCount >= 1)
        return decide(OUTCOME.SUCCESS, null, "sample");
      // Settled end of stream with zero qualifying images.
      if (!sample.streaming && endedStreak >= settleSamples) {
        if (sample.textLength > 0) return decide(OUTCOME.TEXT_ONLY, CODE.TEXT_ONLY, "sample");
        return decide(OUTCOME.ERROR, CODE.NO_RESPONSE, "sample");
      }
      // The caller's deadline fired alongside this sample: terminal checks
      // above already ran, so classify on the final stream state.
      if (sample.deadlineReached) return concludeWait("deadline");
      return null;
    };

    const finish = (endedBy = "sequence_end") => concludeWait(endedBy);

    return {
      push,
      finish,
      get decision() {
        return decision;
      },
    };
  }

  // Fold a whole sequence. `options.deadlineReached` records *why* sampling
  // stopped; an exhausted sequence without it is classified the same way
  // and reported with endedBy "sequence_end" instead of "deadline".
  function classifyOutcome(samples, options = {}) {
    const classifier = createOutcomeClassifier(options);
    for (const sample of Array.isArray(samples) ? samples : []) {
      const result = classifier.push(sample);
      if (result) return result;
    }
    return classifier.finish(options?.deadlineReached === true ? "deadline" : "sequence_end");
  }

  root.ChatGptOutcomeClassifier = {
    classifyOutcome,
    createOutcomeClassifier,
    OUTCOME,
    CODE,
    DEFAULT_SETTLE_SAMPLES,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
