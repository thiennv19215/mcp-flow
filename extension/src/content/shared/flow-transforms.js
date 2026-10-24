// FEAT-11 — Shared single-image transform engine (study B6: Angles #10,
// Effects #11).
//
// Logic (implemented fresh from the reference's design, not its code):
// the reference ships two separate-looking tools — multi-angle views and
// image effects — that are really ONE engine. A preset is a prompt
// template plus, per parameter, a keyword map keyed by NUMERIC anchors.
// Building a prompt substitutes, for each parameter, the phrase of the
// anchor NEAREST to the requested value; a parameter whose nearest phrase
// is empty (or that was given no usable value) has its slot stripped from
// the template, so the prompt never carries leftover placeholders or
// dangling punctuation. Execution is a single image job with the source
// image as the sole reference, submitted through the existing queue —
// this module only shapes that job payload.
//
// The vendor's preset catalogs are server content and stay blocked
// (FEAT-B2). The starter set below is LOCALLY AUTHORED (our own prompt
// wording) and every preset is flagged `locallyAuthored: true`.
//
// The module is pure: no DOM, no storage, no network. It attaches to the
// global root like the other content/shared modules so the sidebar, the
// Flow content world and tests all share the same implementation.

(() => {
  "use strict";

  const root = typeof globalThis !== "undefined" ? globalThis : (typeof window !== "undefined" ? window : self);

  const isRecord = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const cleanString = value => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");

  // --- Anchor maps -----------------------------------------------------
  // A param's keyword map is accepted as an object keyed by numeric
  // strings ({ "45": "…" }) or as [value, phrase] pairs; internally it is
  // a list of [number, phrase] sorted ascending by anchor value.

  function normalizeAnchorMap(map) {
    if (!map) return [];
    const entries = Array.isArray(map)
      ? map.map(pair => (Array.isArray(pair) ? [Number(pair[0]), cleanString(pair[1])] : [Number.NaN, ""]))
      : Object.entries(map).map(([key, phrase]) => [Number(key), cleanString(phrase)]);
    return entries
      .filter(([value]) => Number.isFinite(value))
      .sort((a, b) => a[0] - b[0]);
  }

  // The phrase of the anchor nearest to `value`. An exact anchor returns
  // its own phrase; a value between two anchors takes the closer one (an
  // exact midpoint takes the LOWER anchor, deterministically); a value
  // outside the anchored range clamps to the boundary anchor's phrase —
  // which is how intensity words behave at the ends of their range. An
  // empty map, or a non-numeric value, yields "" (the slot is stripped).
  function nearestAnchorPhrase(anchorMap, value) {
    const anchors = normalizeAnchorMap(anchorMap);
    const numeric = Number(value);
    if (!anchors.length || !Number.isFinite(numeric)) return "";
    let best = anchors[0];
    for (const entry of anchors) {
      if (Math.abs(entry[0] - numeric) < Math.abs(best[0] - numeric)) best = entry;
    }
    return best[1];
  }

  // --- Prompt building -------------------------------------------------

  const SLOT_PATTERN = /\{([A-Za-z][\w-]*)\}/g;

  // Substitute every {param} slot with its nearest-anchor phrase, then
  // clean up: stripped slots leave no double spaces, no space before
  // punctuation and no dangling separators behind.
  function buildTransformPrompt(preset, values = {}) {
    if (!isRecord(preset) || typeof preset.template !== "string") return "";
    const params = isRecord(preset.params) ? preset.params : {};
    const substituted = preset.template.replace(SLOT_PATTERN, (match, name) => {
      const param = params[name];
      if (!param) return "";
      return nearestAnchorPhrase(param.anchors, values?.[name]);
    });
    return substituted
      .replace(/\s+/g, " ")
      .replace(/\s+([,.;:!?])/g, "$1")
      .replace(/,\s*,/g, ",")
      .replace(/^[\s,;]+/, "")
      .replace(/[\s,;]+$/, "")
      .trim();
  }

  // --- Starter presets (locally authored — NOT the vendor catalog) -----

  const TILT_ANCHORS = {
    "-30": "The camera shoots from a low angle, looking up.",
    "0": "The camera sits at eye level.",
    "30": "The camera shoots from a high angle, looking down.",
  };

  const INTENSITY_ANCHORS = {
    "0": "",
    "40": "Apply it subtly.",
    "70": "Apply it clearly.",
    "100": "Apply it dramatically.",
  };

  const KEEP_IDENTICAL = "Keep the subject, outfit, colors, lighting and background identical to the reference image.";
  const KEEP_COMPOSITION = "Keep the composition, subject and details unchanged.";

  const TRANSFORM_PRESETS = [
    {
      id: "angles-orbit",
      family: "angles",
      name: "Orbit view",
      locallyAuthored: true,
      template: `Recreate the same subject from a new camera angle. {azimuth} {tilt} {zoom} ${KEEP_IDENTICAL}`,
      params: {
        azimuth: {
          label: "Góc ngang (độ)",
          default: 0,
          anchors: {
            "-90": "The camera sees the subject from the left side, in profile.",
            "-45": "The camera sees the subject from a three-quarter left angle.",
            "0": "The camera faces the subject straight from the front.",
            "45": "The camera sees the subject from a three-quarter right angle.",
            "90": "The camera sees the subject from the right side, in profile.",
            "180": "The camera is directly behind the subject.",
          },
        },
        tilt: { label: "Góc dọc (độ)", default: 0, anchors: TILT_ANCHORS },
        zoom: {
          label: "Khung hình (×)",
          default: 1,
          anchors: {
            "0.5": "Frame it as a wide shot showing the full scene.",
            "1": "",
            "2": "Frame it as a close-up on the subject.",
          },
        },
      },
    },
    {
      id: "angles-back",
      family: "angles",
      name: "Back view",
      locallyAuthored: true,
      template: `Show the same subject from behind. {azimuth} {tilt} ${KEEP_IDENTICAL}`,
      params: {
        azimuth: {
          label: "Góc ngang (độ)",
          default: 180,
          anchors: {
            "-135": "The camera is behind the subject, three-quarters to the left.",
            "180": "The camera is directly behind the subject.",
            "135": "The camera is behind the subject, three-quarters to the right.",
          },
        },
        tilt: { label: "Góc dọc (độ)", default: 0, anchors: TILT_ANCHORS },
      },
    },
    {
      id: "effects-grade",
      family: "effects",
      name: "Color grade",
      locallyAuthored: true,
      template: `Restyle this photo with a new color grade. {look} {intensity} ${KEEP_COMPOSITION}`,
      params: {
        look: {
          label: "Kiểu màu",
          default: 0,
          anchors: {
            "0": "Give it warm golden-hour tones.",
            "1": "Give it a cool teal-and-orange cinema grade.",
            "2": "Give it soft pastel colors.",
            "3": "Convert it to high-contrast black and white.",
            "4": "Give it a vintage film look with gentle grain.",
          },
        },
        intensity: { label: "Cường độ (%)", default: 70, anchors: INTENSITY_ANCHORS },
      },
    },
    {
      id: "effects-mood",
      family: "effects",
      name: "Mood & light",
      locallyAuthored: true,
      template: `Change the mood and lighting of this photo. {look} {intensity} ${KEEP_COMPOSITION}`,
      params: {
        look: {
          label: "Ánh sáng",
          default: 0,
          anchors: {
            "0": "Use a dreamy soft glow.",
            "1": "Use moody low-key lighting with deep shadows.",
            "2": "Use bright, airy daylight.",
            "3": "Use neon night lighting.",
          },
        },
        intensity: { label: "Cường độ (%)", default: 70, anchors: INTENSITY_ANCHORS },
      },
    },
  ];

  const presetById = new Map(TRANSFORM_PRESETS.map(preset => [preset.id, preset]));

  function listTransformPresets(family) {
    const wanted = cleanString(family).toLowerCase();
    return TRANSFORM_PRESETS.filter(preset => !wanted || preset.family === wanted);
  }

  function getTransformPreset(presetId) {
    return presetById.get(cleanString(presetId)) || null;
  }

  // --- Execution contract ----------------------------------------------
  // ONE image job through the existing queue, the source image as the
  // SOLE reference (payload.attachments has exactly one entry, passed
  // through verbatim — the queue's own upload/attach path owns it from
  // there). Submit-only semantics of the queue are untouched.

  function buildTransformJob({ presetId, preset: presetInput, values = {}, source, model, aspectRatio } = {}) {
    const preset = isRecord(presetInput) ? presetInput : getTransformPreset(presetId);
    if (!preset) {
      throw Object.assign(new Error("Transform preset not found."), { code: "FLOW_TRANSFORM_PRESET_NOT_FOUND" });
    }
    const ref = isRecord(source) ? source : null;
    const hasIdentity = Boolean(ref && (cleanString(ref.assetName) || cleanString(ref.transferId)));
    if (!hasIdentity) {
      throw Object.assign(new Error("A transform needs exactly one source image."), { code: "FLOW_TRANSFORM_SOURCE_REQUIRED" });
    }
    const prompt = buildTransformPrompt(preset, values);
    return {
      operation: "flow.generation.submit",
      payload: {
        type: "image",
        prompt,
        attachments: [ref],
        variants: 1,
        count: 1,
        ...(cleanString(model) ? { model: cleanString(model) } : {}),
        ...(cleanString(aspectRatio) ? { aspectRatio: cleanString(aspectRatio), aspect_ratio: cleanString(aspectRatio) } : {}),
      },
      label: `[IMAGE] ${preset.name}: ${prompt.slice(0, 80)}`,
      metadata: {
        source: "extension",
        transform: {
          presetId: preset.id,
          family: preset.family,
          params: isRecord(values) ? { ...values } : {},
        },
      },
    };
  }

  root.FlowTransforms = Object.freeze({
    nearestAnchorPhrase,
    buildTransformPrompt,
    listTransformPresets,
    getTransformPreset,
    buildTransformJob,
    TRANSFORM_PRESETS: Object.freeze(TRANSFORM_PRESETS),
  });
})();
