/*
 * DL-02 — Video watermark removal, page-context frame pipeline.
 *
 * Videos are cleaned FRAME-WISE in a page context (MAIN world), never in
 * the service worker (study W11): the queue/background only ever routes
 * a video clean here and records the outcome (see flow-queue-downloads.js
 * queueVideoWatermarkRoute).
 *
 * Pipeline (study W10 logic, implemented fresh):
 *   1. Refuse inputs over the 300 MB cap up front, with a typed error,
 *      before any decode/open.
 *   2. Ask the codec adapter for ~12 sample frames spread across the
 *      clip and locate the logo ANCHOR on them with the existing image
 *      pipeline (WatermarkRemover.locate — multi-variant, scale-aware).
 *      Samples vote: detections are grouped by position (3px buckets);
 *      the largest group wins, ties break to the highest NCC, and the
 *      group's highest-NCC point becomes the anchor. Zero detections
 *      across all samples is the no-watermark outcome: the ORIGINAL
 *      input is returned untouched and no encoder is ever created.
 *   3. Process every frame at the current anchor, reusing the image
 *      pipeline's decisions: gain is estimated by the remover
 *      (_estimateGain, DL-11 dual estimate), the reverse-alpha apply
 *      uses the anchor mask's own alpha data (the same blend formula
 *      WatermarkRemover.remove applies), dark denoise and edge
 *      smoothing are the remover's own passes, and verification is the
 *      remover's NCC (_nccAt) against its post-clean threshold.
 *   4. Re-detection rules (exact):
 *      - Pre-clean check: before cleaning a frame, its NCC at the
 *        current anchor is measured. If it falls below the detection
 *        threshold, the anchor is stale for this frame: re-detect with
 *        locate() on THIS frame. A found anchor replaces the current
 *        one and the frame is cleaned there; a miss means this frame
 *        carries no detectable logo and passes through with its
 *        original pixels (the old anchor is kept for later frames).
 *      - Post-clean check: if a cleaned frame's NCC after cleaning is
 *        still above minNccAfter, the frame is ROLLED BACK to its
 *        original pixels (never emitted as cleaned), a verification
 *        failure is counted, and the anchor is marked stale so the
 *        NEXT frame re-detects before cleaning.
 *      Re-detections are counted per frame that triggers one; when they
 *      exceed 25% of processed frames the result carries the
 *      `redetection_ratio_high` warning (the platform may have changed
 *      its watermark, per study W10).
 *   5. Audio packets are copied through UNTOUCHED: the session's packet
 *      list is handed to the mux step (encoder.finish) by reference and
 *      reported in the output bookkeeping; packets are never decoded or
 *      re-encoded here. Duration and track layout are likewise carried
 *      from the source metadata into the output bookkeeping verbatim.
 *   6. Video is re-encoded near the source bitrate (source bitrate x
 *      bitrateRatio, default ratio 1).
 *   7. Cancellation is checked BETWEEN frames (and before sampling /
 *      finalizing): on cancel the in-flight encode is aborted, finish()
 *      never runs, and the promise rejects with a typed error whose
 *      `output` is null — a truncated video is never presented as
 *      cleaned.
 *
 * Codec seam: demux/decode/encode/mux sit behind an injected adapter so
 * the pipeline logic is testable in Node with synthetic frames and fake
 * codecs — no real WebCodecs in tests. Adapter contract:
 *
 *   adapter.open(input, { signal }) -> session
 *   session.metadata = {
 *     sizeBytes?, durationMs,
 *     video: { width, height, codec, bitrateBps, fps, frameCount },
 *     audio: { codec, packetCount } | null,
 *     tracks: [{ kind, codec, ... }],
 *   }
 *   session.audioPackets = [opaque packet refs]   (copied, never read)
 *   session.sampleFrames(count) -> [{ index, timeMs, imageData }]
 *   session.frames() -> async iterable of { index, timeMs, imageData }
 *   session.createEncoder({ videoBitrateBps, codec, width, height, fps })
 *     -> { addFrame({ imageData, index, timeMs }), finish({ audioPackets,
 *          durationMs, tracks, mimeType }) -> output, abort() }
 *
 * imageData is any { width, height, data } frame (an ImageData in the
 * browser). Outcome vocabulary matches DL-03: "cleaned" / "original"
 * (+ reason) / "failed".
 */
(() => {
  "use strict";

  const root = globalThis;
  if (root.VideoWatermarkCleaner?.version >= 1) return;

  const MAX_INPUT_BYTES = 300 * 1024 * 1024;
  const DEFAULT_SAMPLE_FRAMES = 12;
  const MAX_SAMPLE_FRAMES = 32;
  const REDETECTION_WARNING_RATIO = 0.25;

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function typedError(code, message, extra = {}) {
    return Object.assign(new Error(message), { code, output: null, ...extra });
  }

  function resolveInputSizeBytes(input) {
    if (!input || typeof input !== "object") return null;
    const candidates = [input.size, input.sizeBytes, input.byteLength, input.bytes?.length, input.data?.length];
    for (const candidate of candidates) {
      if (Number.isFinite(candidate) && candidate >= 0) return candidate;
    }
    return null;
  }

  function asImageData(frame) {
    const image = frame?.imageData || frame?.frame || frame;
    if (!image || !image.width || !image.height || !image.data) return null;
    if (typeof ImageData !== "undefined" && image instanceof ImageData) return image;
    if (typeof ImageData !== "undefined") {
      try { return new ImageData(new Uint8ClampedArray(image.data), image.width, image.height); } catch (_) { return image; }
    }
    return image;
  }

  // Mask alpha with WatermarkRemover's own semantics (values >1 are
  // 0-255, otherwise 0-1; clamped to 0.98 so the reverse blend never
  // divides by ~0).
  function maskAlphaAt(mask, x, y) {
    if (!mask || x < 0 || y < 0 || x >= mask.width || y >= mask.height) return 0;
    const value = Number(mask.data[y * mask.width + x]) || 0;
    return clamp(value > 1 ? value / 255 : value, 0, 0.98);
  }

  function pickRemover(options) {
    if (options.remover) return options.remover;
    const Remover = root.WatermarkRemover;
    if (typeof Remover === "function") {
      const removerOptions = options.removerOptions || options.config || {};
      return new Remover({
        ...(options.mask ? { mask: options.mask } : {}),
        ...(options.variants ? { variants: options.variants } : {}),
        ...(options.nccThreshold !== undefined ? { nccThreshold: options.nccThreshold } : {}),
        ...(options.minNccAfter !== undefined ? { minNccAfter: options.minNccAfter } : {}),
        ...removerOptions,
      });
    }
    return null;
  }

  async function cleanVideo(input, options = {}) {
    const signal = options.signal || null;
    const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
    const progress = event => { try { onProgress?.(event); } catch (_) {} };
    const throwIfCancelled = framesProcessed => {
      if (signal?.aborted) {
        throw typedError("FLOW_VIDEO_WATERMARK_CANCELLED", "Video watermark cleaning was cancelled.", { framesProcessed });
      }
    };

    // Config (the flowWatermark family — see watermark-config.js): the
    // sample count, a possibly lower local input cap, and the bitrate
    // ratio. The 300 MB ceiling is hard: no config value can raise it.
    const rawSampleCount = Number(options.sampleFrameCount ?? options.videoSampleFrames);
    const sampleFrameCount = Number.isFinite(rawSampleCount) && rawSampleCount > 0
      ? clamp(Math.round(rawSampleCount), 1, MAX_SAMPLE_FRAMES)
      : DEFAULT_SAMPLE_FRAMES;
    const rawMaxBytes = Number(options.maxInputBytes ?? options.videoMaxInputBytes);
    const maxInputBytes = Number.isFinite(rawMaxBytes) && rawMaxBytes > 0
      ? Math.min(MAX_INPUT_BYTES, rawMaxBytes)
      : MAX_INPUT_BYTES;
    const rawRatio = Number(options.bitrateRatio ?? options.videoBitrateRatio);
    const bitrateRatio = Number.isFinite(rawRatio) && rawRatio >= 0.1 && rawRatio <= 2 ? rawRatio : 1;

    // (1) Up-front cap: refuse before the adapter is even opened.
    const declaredSize = resolveInputSizeBytes(input);
    if (declaredSize !== null && declaredSize > maxInputBytes) {
      throw typedError("FLOW_VIDEO_WATERMARK_INPUT_TOO_LARGE",
        `Video is ${declaredSize} bytes, over the ${maxInputBytes}-byte cleaning limit; refusing before decode.`,
        { sizeBytes: declaredSize, maxInputBytes });
    }
    throwIfCancelled(0);

    const adapter = options.adapter || createBrowserAdapter();
    if (!adapter || typeof adapter.open !== "function") {
      throw typedError("FLOW_VIDEO_CODEC_UNAVAILABLE", "No video codec adapter is available in this page context.");
    }
    const remover = pickRemover(options);
    if (!remover || typeof remover.locate !== "function") {
      throw typedError("FLOW_VIDEO_WATERMARK_REMOVER_UNAVAILABLE", "The image watermark pipeline (WatermarkRemover) is not available in this page context.");
    }
    const nccThreshold = Number(options.nccThreshold ?? remover.options?.nccThreshold) || 0.68;
    const minNccAfter = Number(options.minNccAfter ?? remover.options?.minNccAfter) || 0.25;

    let session;
    try {
      session = await adapter.open(input, { signal });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error) throw error;
      throw typedError("FLOW_VIDEO_CODEC_UNAVAILABLE", `The video codec adapter could not open the input: ${String(error?.message || error)}`, { cause: error });
    }
    const metadata = session?.metadata || {};
    // The cap still applies when only the opened metadata knows the size:
    // refuse before any sampling/decoding work happens.
    if (Number.isFinite(metadata.sizeBytes) && metadata.sizeBytes > maxInputBytes) {
      throw typedError("FLOW_VIDEO_WATERMARK_INPUT_TOO_LARGE",
        `Video is ${metadata.sizeBytes} bytes, over the ${maxInputBytes}-byte cleaning limit; refusing before decode.`,
        { sizeBytes: metadata.sizeBytes, maxInputBytes });
    }
    throwIfCancelled(0);

    // (2) Anchor from ~12 samples, by vote.
    const samples = typeof session.sampleFrames === "function" ? await session.sampleFrames(sampleFrameCount) : [];
    throwIfCancelled(0);
    const groups = new Map();
    let detections = 0;
    for (const sample of samples || []) {
      const image = asImageData(sample);
      if (!image) continue;
      const point = remover.locate(image);
      if (!point) continue;
      detections += 1;
      const key = `${point.variant || ""}|${Math.round(point.x / 3)}|${Math.round(point.y / 3)}|${point.scale || 1}`;
      const group = groups.get(key) || { count: 0, best: null };
      group.count += 1;
      if (!group.best || point.ncc > group.best.ncc) group.best = point;
      groups.set(key, group);
    }
    if (!detections) {
      // No watermark on any sample: the honest no-watermark outcome.
      // The original input is returned untouched; no encoder exists.
      return {
        status: "original",
        reason: "not_found",
        ok: true,
        changed: false,
        applied: false,
        output: input,
        anchor: null,
        stats: {
          sampleCount: (samples || []).length,
          detections: 0,
          framesProcessed: 0,
          framesCleaned: 0,
          framesWithoutWatermark: 0,
          verificationFailures: 0,
          redetections: 0,
          redetectionRatio: 0,
        },
        audio: { copiedPackets: 0, untouched: true },
        durationMs: Number.isFinite(metadata.durationMs) ? metadata.durationMs : null,
        tracks: Array.isArray(metadata.tracks) ? metadata.tracks : [],
      };
    }
    let winningGroup = null;
    for (const group of groups.values()) {
      if (!winningGroup || group.count > winningGroup.count ||
          (group.count === winningGroup.count && group.best.ncc > winningGroup.best.ncc)) {
        winningGroup = group;
      }
    }
    let anchor = normalizeAnchor(winningGroup.best, remover);
    if (!anchor.mask) {
      return {
        status: "failed", reason: "mask_not_configured", ok: false, changed: false, applied: false, output: null,
        anchor: null,
        stats: { sampleCount: (samples || []).length, detections, framesProcessed: 0, framesCleaned: 0, framesWithoutWatermark: 0, verificationFailures: 0, redetections: 0, redetectionRatio: 0 },
        audio: { copiedPackets: 0, untouched: true },
        durationMs: Number.isFinite(metadata.durationMs) ? metadata.durationMs : null,
        tracks: Array.isArray(metadata.tracks) ? metadata.tracks : [],
      };
    }
    progress({ phase: "sampling", sampleCount: (samples || []).length, detections, anchor: publicAnchor(anchor) });

    function normalizeAnchor(point, removerInstance) {
      return {
        x: point.x,
        y: point.y,
        ncc: point.ncc,
        gain: point.gain,
        variant: point.variant ?? null,
        scale: point.scale ?? 1,
        mask: point.mask || removerInstance.mask || options.mask || null,
      };
    }
    function publicAnchor(value) {
      return { x: value.x, y: value.y, ncc: value.ncc, variant: value.variant, scale: value.scale };
    }

    // Anchored per-frame cleaning, built on the remover's own gain
    // estimation, denoise, edge smoothing and NCC verification; only the
    // reverse-alpha apply loop itself is local (the same blend formula
    // WatermarkRemover.remove applies with the anchor's mask + gain).
    function cleanAtAnchor(image, currentAnchor) {
      if (typeof remover._nccAt !== "function") {
        // A remover without the internal surface: fall back to its full
        // remove() decision (detect -> remove -> verify) for this frame.
        const result = remover.remove(image, currentAnchor.mask);
        if (result?.changed) return { image: result.image, nccAfter: result.nccAfter ?? 0, gain: result.gain };
        return { image, nccAfter: result?.nccAfter ?? Number.POSITIVE_INFINITY, gain: currentAnchor.gain };
      }
      const mask = currentAnchor.mask;
      const gain = typeof remover._estimateGain === "function"
        ? remover._estimateGain(image, mask, currentAnchor.x, currentAnchor.y)
        : (currentAnchor.gain ?? 1);
      const cleaned = typeof ImageData !== "undefined"
        ? new ImageData(new Uint8ClampedArray(image.data), image.width, image.height)
        : { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) };
      for (let my = 0; my < mask.height; my++) {
        for (let mx = 0; mx < mask.width; mx++) {
          const alpha = clamp(maskAlphaAt(mask, mx, my) * gain, 0, 0.98);
          if (alpha < 0.01) continue;
          const x = Math.round(currentAnchor.x + mx);
          const y = Math.round(currentAnchor.y + my);
          if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue;
          const offset = (y * image.width + x) * 4;
          for (let channel = 0; channel < 3; channel++) {
            cleaned.data[offset + channel] = clamp((cleaned.data[offset + channel] - 255 * alpha) / Math.max(0.02, 1 - alpha), 0, 255);
          }
        }
      }
      remover._applyDarkDenoise?.(cleaned, image, mask, currentAnchor);
      remover._smoothPatchEdges?.(cleaned, mask, currentAnchor);
      const nccAfter = remover._nccAt(cleaned, mask, currentAnchor.x, currentAnchor.y);
      return { image: cleaned, nccAfter, gain };
    }

    function locateAnchorOn(image) {
      const point = remover.locate(image);
      if (!point) return null;
      const candidate = normalizeAnchor(point, remover);
      return candidate.mask ? candidate : null;
    }

    // (5/6) Encoder: near source bitrate; audio packets pass to the mux
    // step by reference at finish() and are never touched here.
    const audioPackets = Array.isArray(session.audioPackets)
      ? session.audioPackets
      : (Array.isArray(metadata.audioPackets) ? metadata.audioPackets : []);
    const tracks = Array.isArray(metadata.tracks) ? metadata.tracks : [];
    const durationMs = Number.isFinite(metadata.durationMs) ? metadata.durationMs : null;
    const videoMeta = metadata.video || {};
    const sourceBitrate = Number(videoMeta.bitrateBps);
    const videoBitrateBps = Number.isFinite(sourceBitrate) && sourceBitrate > 0
      ? Math.round(sourceBitrate * bitrateRatio)
      : undefined;
    if (typeof session.createEncoder !== "function") {
      throw typedError("FLOW_VIDEO_CODEC_UNAVAILABLE", "The video codec adapter cannot encode in this page context.");
    }
    const encoder = await session.createEncoder({
      videoBitrateBps,
      codec: videoMeta.codec,
      width: videoMeta.width,
      height: videoMeta.height,
      fps: videoMeta.fps,
    });
    const totalFrames = Number.isFinite(videoMeta.frameCount) && videoMeta.frameCount > 0 ? videoMeta.frameCount : null;

    const stats = {
      sampleCount: (samples || []).length,
      detections,
      framesProcessed: 0,
      framesCleaned: 0,
      framesWithoutWatermark: 0,
      verificationFailures: 0,
      redetections: 0,
      redetectionRatio: 0,
    };
    let anchorStale = false;

    try {
      const iterable = typeof session.frames === "function" ? session.frames() : [];
      for await (const frame of iterable) {
        // Cancellation is honored between frames, before any work on
        // the next one.
        throwIfCancelled(stats.framesProcessed);
        const image = asImageData(frame);
        if (!image) { stats.framesProcessed += 1; continue; }

        if (anchorStale) {
          // Post-clean failure on the previous frame marked the anchor
          // stale: re-detect before cleaning this one.
          stats.redetections += 1;
          const relocated = locateAnchorOn(image);
          if (relocated) anchor = relocated;
          anchorStale = false;
        }

        // Pre-clean anchor verification.
        let preNcc = typeof remover._nccAt === "function"
          ? remover._nccAt(image, anchor.mask, anchor.x, anchor.y)
          : anchor.ncc;
        if (preNcc < nccThreshold) {
          stats.redetections += 1;
          const relocated = locateAnchorOn(image);
          if (!relocated) {
            // No detectable logo on this frame: original pixels pass.
            await encoder.addFrame({ imageData: image, index: frame.index, timeMs: frame.timeMs });
            stats.framesProcessed += 1;
            stats.framesWithoutWatermark += 1;
            progress({ phase: "cleaning", framesProcessed: stats.framesProcessed, totalFrames, percent: totalFrames ? Math.round(stats.framesProcessed * 100 / totalFrames) : null });
            continue;
          }
          anchor = relocated;
          preNcc = anchor.ncc;
        }

        const cleaned = cleanAtAnchor(image, anchor);
        if (cleaned.nccAfter > minNccAfter) {
          // Post-clean verification drop: roll this frame back to its
          // original pixels and re-detect for subsequent frames.
          stats.verificationFailures += 1;
          anchorStale = true;
          await encoder.addFrame({ imageData: image, index: frame.index, timeMs: frame.timeMs });
        } else {
          await encoder.addFrame({ imageData: cleaned.image, index: frame.index, timeMs: frame.timeMs });
          stats.framesCleaned += 1;
        }
        stats.framesProcessed += 1;
        progress({ phase: "cleaning", framesProcessed: stats.framesProcessed, totalFrames, percent: totalFrames ? Math.round(stats.framesProcessed * 100 / totalFrames) : null });
      }
    } catch (error) {
      // Cancel (or a codec failure mid-stream): abort the encode and
      // produce NO output.
      try { await encoder.abort?.(); } catch (_) {}
      throw error;
    }
    throwIfCancelled(stats.framesProcessed);

    if (stats.framesProcessed > 0) stats.redetectionRatio = stats.redetections / stats.framesProcessed;
    const warning = stats.redetectionRatio > REDETECTION_WARNING_RATIO ? "redetection_ratio_high" : null;

    if (stats.framesCleaned === 0) {
      try { await encoder.abort?.(); } catch (_) {}
      return {
        status: "failed",
        reason: stats.framesWithoutWatermark === stats.framesProcessed ? "not_found" : "verification_failed",
        ok: false,
        changed: false,
        applied: false,
        output: null,
        anchor: publicAnchor(anchor),
        stats,
        ...(warning ? { warning } : {}),
        audio: { copiedPackets: 0, untouched: true },
        durationMs,
        tracks,
      };
    }

    progress({ phase: "finalizing", framesProcessed: stats.framesProcessed, totalFrames });
    const finished = await encoder.finish({
      audioPackets,
      durationMs,
      tracks,
      mimeType: metadata.mimeType || "video/mp4",
    });
    // Output bookkeeping: duration + track layout + the untouched audio
    // packet list are the SOURCE's, whatever the encoder returned.
    let output = finished;
    if (output && typeof output === "object") {
      output = { ...output, audioPackets, durationMs, tracks };
    }
    return {
      status: "cleaned",
      ok: true,
      changed: true,
      applied: true,
      output,
      anchor: publicAnchor(anchor),
      stats,
      ...(warning ? { warning } : {}),
      audio: { copiedPackets: audioPackets.length, untouched: true, codec: metadata.audio?.codec || null },
      durationMs,
      tracks,
    };
  }

  /*
   * Production adapter factory. This environment has no container
   * demuxer: copying audio packets through untouched and decoding an
   * MP4/WebM container both require one (a mediabunny-style library),
   * injected here as `env.demuxer` with the adapter session contract
   * above. Without it — or without any codec surface at all — open()
   * fails CLOSED with FLOW_VIDEO_CODEC_UNAVAILABLE instead of faking a
   * clean. When a demuxer is injected, its session is used verbatim
   * (its frames are already page-context ImageData frames).
   */
  function createBrowserAdapter(env) {
    const scope = env && typeof env === "object" ? env : root;
    return {
      async open(input, context = {}) {
        if (typeof scope.demuxer?.open === "function") {
          return scope.demuxer.open(input, context);
        }
        throw typedError("FLOW_VIDEO_CODEC_UNAVAILABLE",
          "Video cleaning needs a page-context container demuxer plus WebCodecs (none is bundled); refusing rather than returning an uncleaned file as cleaned.");
      },
    };
  }

  root.VideoWatermarkCleaner = Object.freeze({
    version: 1,
    MAX_INPUT_BYTES,
    DEFAULT_SAMPLE_FRAMES,
    cleanVideo,
    createCleaner: (defaults = {}) => ({
      cleanVideo: (input, options = {}) => cleanVideo(input, { ...defaults, ...options }),
    }),
    createBrowserAdapter,
  });
})();
