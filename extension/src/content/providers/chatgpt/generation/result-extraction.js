(function (root) {
  'use strict';

  // GPT-04 — ChatGPT result extraction (study behavior B21).
  //
  // Given a completed assistant turn element, collect the generated image
  // URLs. Candidates are classified through three tiers, in precedence
  // order:
  //   1. generated-image — the image carries an explicit generated marker
  //      (a generated-alt prefix, a data-generated attribute, or a
  //      generated data-testid);
  //   2. result-image    — the URL is an app content/file URL (the
  //      backend-api estuary-content or files path);
  //   3. cdn-image       — the URL is served from the provider CDN host
  //      (oaiusercontent).
  // An image matched by a higher tier is never re-reported by a lower one.
  //
  // Exclusions (positive signals only; an image with no exclusion signal
  // that matches a tier is included):
  //   - blurred placeholders: a blur utility class (blur, blur-md, ...),
  //     a blur() filter in the style attribute/property, or a
  //     data-placeholder / data-blurred attribute;
  //   - uploaded references, via the alt-text heuristic: generated images
  //     carry a recognizable generated-alt prefix, while refs keep a
  //     file-name alt (e.g. "photo.png") or an empty alt. An explicit
  //     generated marker overrides the ref classification.
  //
  // Results are ordered generated-first (stable within each group), then
  // deduped by the file id embedded in the URL (the "file_…"/"file-…"
  // token, separator-normalized), falling back to the full URL.
  //
  // DOM access stays behind a minimal injectable surface: the caller may
  // pass { queryAll(element, selector) }; by default the turn element's
  // own querySelectorAll is used. Nothing here touches the global document
  // at import time, and malformed subtrees never throw.

  const TIERS = Object.freeze(['generated-image', 'result-image', 'cdn-image']);

  const GENERATED_ALT_PATTERNS = Object.freeze([/^generated image\b/i]);
  const FILENAME_ALT_PATTERN = /\.(?:png|jpe?g|webp|gif|bmp|heic|avif|svg)$/i;
  const RESULT_PATH_PATTERN = /\/backend-api\/(?:estuary\/content|files?\/)/i;
  const CDN_HOST_PATTERN = /(?:^|[./])oaiusercontent\.com(?:[/?#]|$)/i;
  const FILE_ID_PATTERN = /file[-_]([0-9a-zA-Z]+)/;
  const FILE_ID_PARAM_PATTERN = /[?&]id=(file[-_][0-9a-zA-Z]+)/i;
  const BLUR_CLASS_PATTERN = /(?:^|[\s_-])blur(?:$|[\s_-]|\[)/;

  const attr = (element, name) => {
    try {
      if (!element || typeof element.getAttribute !== 'function') return null;
      const value = element.getAttribute(name);
      return typeof value === 'string' ? value : null;
    } catch {
      return null;
    }
  };

  const imageUrl = (img) => {
    const src = attr(img, 'src');
    if (src && src.trim()) return src.trim();
    try {
      if (typeof img?.src === 'string' && img.src.trim()) return img.src.trim();
    } catch { /* fall through */ }
    const dataSrc = attr(img, 'data-src');
    return dataSrc && dataSrc.trim() ? dataSrc.trim() : '';
  };

  const fileIdFromUrl = (url) => {
    if (typeof url !== 'string' || !url) return null;
    try {
      const param = FILE_ID_PARAM_PATTERN.exec(url);
      const raw = param ? param[1] : (FILE_ID_PATTERN.exec(url)?.[0] ?? null);
      if (!raw) return null;
      const match = FILE_ID_PATTERN.exec(raw);
      return match ? match[1].toLowerCase() : null;
    } catch {
      return null;
    }
  };

  const hasGeneratedAlt = (alt) =>
    typeof alt === 'string' && GENERATED_ALT_PATTERNS.some((pattern) => pattern.test(alt.trim()));

  const hasExplicitGeneratedMarker = (img) => {
    const generated = attr(img, 'data-generated');
    if (generated !== null && generated.trim().toLowerCase() !== 'false') return true;
    const testId = attr(img, 'data-testid');
    return typeof testId === 'string' && /generated/i.test(testId);
  };

  const isBlurredPlaceholder = (img) => {
    const className = attr(img, 'class');
    if (className && BLUR_CLASS_PATTERN.test(className)) return true;
    const styleAttr = attr(img, 'style');
    if (styleAttr && /blur\s*\(/i.test(styleAttr)) return true;
    try {
      const filter = img?.style?.filter;
      if (typeof filter === 'string' && /blur\s*\(/i.test(filter)) return true;
    } catch { /* guarded property access only */ }
    return attr(img, 'data-placeholder') !== null || attr(img, 'data-blurred') !== null;
  };

  const isUploadedRef = (img, alt, generatedAlt, explicitMarker) => {
    if (generatedAlt || explicitMarker) return false;
    const trimmed = typeof alt === 'string' ? alt.trim() : '';
    if (trimmed === '') return true; // empty-alt siblings classify as refs
    return FILENAME_ALT_PATTERN.test(trimmed);
  };

  const tierFor = (url, generatedAlt, explicitMarker) => {
    if (generatedAlt || explicitMarker) return 'generated-image';
    if (RESULT_PATH_PATTERN.test(url)) return 'result-image';
    if (CDN_HOST_PATTERN.test(url)) return 'cdn-image';
    return null;
  };

  const defaultQueryAll = (element, selector) => element.querySelectorAll(selector);

  const extractImages = (turn, deps = {}) => {
    const queryAll = typeof deps?.queryAll === 'function' ? deps.queryAll : defaultQueryAll;
    let candidates;
    try {
      if (!turn) return [];
      candidates = queryAll(turn, 'img');
    } catch {
      return [];
    }
    if (!candidates || typeof candidates.length !== 'number') return [];

    const entries = [];
    for (const img of Array.from(candidates)) {
      try {
        if (!img) continue;
        const url = imageUrl(img);
        if (!url || /^data:/i.test(url)) continue; // not a page URL result
        if (isBlurredPlaceholder(img)) continue;
        const alt = attr(img, 'alt');
        const generatedAlt = hasGeneratedAlt(alt);
        const explicitMarker = hasExplicitGeneratedMarker(img);
        if (isUploadedRef(img, alt, generatedAlt, explicitMarker)) continue;
        const tier = tierFor(url, generatedAlt, explicitMarker);
        if (!tier) continue; // unrelated image: no tier claims it
        entries.push({
          url,
          tier,
          generatedAlt,
          generated: generatedAlt || explicitMarker,
          fileId: fileIdFromUrl(url),
        });
      } catch {
        continue; // a malformed image must not sink the whole extraction
      }
    }

    // Generated-first ordering, stable within each group.
    const ordered = [
      ...entries.filter((entry) => entry.generated),
      ...entries.filter((entry) => !entry.generated),
    ];

    const seen = new Set();
    const deduped = [];
    for (const entry of ordered) {
      const key = entry.fileId ? `file:${entry.fileId}` : `url:${entry.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(Object.freeze({
        url: entry.url,
        tier: entry.tier,
        generatedAlt: entry.generatedAlt,
        fileId: entry.fileId,
      }));
    }
    return deduped;
  };

  const extractImageUrls = (turn, deps = {}) => extractImages(turn, deps).map((entry) => entry.url);

  root.ChatGptResultExtraction = Object.freeze({
    extractImages,
    extractImageUrls,
    fileIdFromUrl,
    TIERS,
  });
})(globalThis);
