// ChatGPT baseline snapshot + diff.
//
// ChatGPT result capture has no network/API signal to correlate against:
// the content driver snapshots the conversation (turn identities + image
// URLs per turn) immediately before submission, and every later result
// attribution is a diff against that pre-submit baseline. This module is
// the pure logic for that: building snapshots (from plain turn data or
// from the DOM through an injected image extractor) and diffing a later
// snapshot against the baseline to find the new turns and exactly the new
// result images.
//
// Turn identity: an element attribute wins whenever one exists —
// `data-turn-id`, then `id`, then `data-message-id` — because attributes
// survive the re-renders ChatGPT performs while streaming. A positional
// identity (`turn:<index>`) is only a fallback for elements carrying no
// identity attribute at all.
//
// Image identity: an image is keyed by the file id embedded in its URL
// when one is present (the same dedupe discipline as result extraction),
// otherwise by the full URL. A re-signed URL or a different host form
// carrying the same file id is therefore the SAME image, and a baseline
// image is never reported as new — even if its turn re-renders, moves, or
// the image is quoted inside a different turn.
//
// Images on user turns are never result images: a user turn's images are
// the uploaded references, so the diff reports the turn itself (submit
// confirmation needs it) but excludes its images from the new-image set.
//
// Everything here degrades instead of throwing: malformed snapshots,
// turns, or extractor results coerce to empty data.
(() => {
  "use strict";
  const root = globalThis;

  // Provisional turn-element selector chain (values to be confirmed by the
  // live-DOM pass; the chain order is the logic): identity-bearing turns
  // first, then the conversation-turn test id, then bare articles.
  const TURN_SELECTORS = ["[data-turn-id]", '[data-testid^="conversation-turn"]', "article"];
  const FILE_ID_PATTERN = /file[-_]([A-Za-z0-9]+)/;

  const fileIdFromUrl = (url) => {
    if (typeof url !== "string" || !url) return null;
    const match = FILE_ID_PATTERN.exec(url);
    return match ? match[1] : null;
  };

  const imageKey = (url) => {
    const id = fileIdFromUrl(url);
    return id ? `file:${id}` : `url:${url}`;
  };

  const normalizeRole = (value) => {
    if (typeof value !== "string") return "unknown";
    const role = value.trim().toLowerCase();
    if (role === "user") return "user";
    if (role === "assistant") return "assistant";
    return "unknown";
  };

  const cleanUrls = (value) => {
    if (!Array.isArray(value)) return [];
    const urls = [];
    const seen = new Set();
    for (const entry of value) {
      if (typeof entry !== "string" || !entry) continue;
      const key = imageKey(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      urls.push(entry);
    }
    return urls;
  };

  const normalizeTurn = (raw, index) => {
    if (!raw || typeof raw !== "object") return null;
    const id = typeof raw.id === "string" && raw.id ? raw.id : `turn:${index}`;
    const imageUrls = cleanUrls(raw.imageUrls);
    return { id, role: normalizeRole(raw.role), imageUrls, imageKeys: imageUrls.map(imageKey) };
  };

  const buildSnapshot = (turns) => {
    const imageKeys = [];
    const seen = new Set();
    for (const turn of turns) {
      for (const key of turn.imageKeys) {
        if (seen.has(key)) continue;
        seen.add(key);
        imageKeys.push(key);
      }
    }
    return {
      version: 1,
      turns,
      turnIds: turns.map((turn) => turn.id),
      imageKeys,
    };
  };

  const emptySnapshot = () => buildSnapshot([]);

  const snapshotFromTurns = (turnData) => {
    if (!Array.isArray(turnData)) return emptySnapshot();
    const turns = [];
    turnData.forEach((raw, index) => {
      const turn = normalizeTurn(raw, index);
      if (turn) turns.push(turn);
    });
    return buildSnapshot(turns);
  };

  const normalizeSnapshot = (input) => {
    if (!input || typeof input !== "object" || !Array.isArray(input.turns)) return emptySnapshot();
    return snapshotFromTurns(input.turns);
  };

  const diffSnapshots = (baselineInput, currentInput) => {
    const baseline = normalizeSnapshot(baselineInput);
    const current = normalizeSnapshot(currentInput);
    const baselineTurnIds = new Set(baseline.turnIds);
    const baselineImageKeys = new Set(baseline.imageKeys);
    const newTurns = current.turns
      .filter((turn) => !baselineTurnIds.has(turn.id))
      .map((turn) => ({ id: turn.id, role: turn.role, imageUrls: [...turn.imageUrls] }));
    const newImages = [];
    const reported = new Set();
    for (const turn of current.turns) {
      if (turn.role === "user") continue;
      turn.imageUrls.forEach((url, position) => {
        const key = turn.imageKeys[position];
        if (baselineImageKeys.has(key) || reported.has(key)) return;
        reported.add(key);
        newImages.push({ url, key, turnId: turn.id, role: turn.role });
      });
    }
    return { newTurns, newImages, newImageUrls: newImages.map((image) => image.url) };
  };

  // ---------------------------------------------------------------------
  // DOM snapshot builder. The image extractor is injected (production
  // wiring passes result extraction's URL extractor); the default is a
  // plain <img> scan of the turn element.
  // ---------------------------------------------------------------------

  const readAttribute = (element, name) => {
    try {
      const value = element?.getAttribute?.(name);
      return typeof value === "string" && value ? value : null;
    } catch {
      return null;
    }
  };

  const turnIdentity = (element, index) =>
    readAttribute(element, "data-turn-id") ||
    readAttribute(element, "id") ||
    readAttribute(element, "data-message-id") ||
    `turn:${index}`;

  const turnRole = (element) => {
    const direct = readAttribute(element, "data-turn") || readAttribute(element, "data-message-author-role");
    if (direct) return normalizeRole(direct);
    try {
      const inner = element?.querySelector?.("[data-message-author-role]");
      const role = inner ? readAttribute(inner, "data-message-author-role") : null;
      if (role) return normalizeRole(role);
    } catch {
      /* fall through to unknown */
    }
    return "unknown";
  };

  const defaultExtractImageUrls = (element) => {
    const images = element?.querySelectorAll?.("img") || [];
    const urls = [];
    for (const image of images) {
      const url = image?.currentSrc || image?.src || readAttribute(image, "src");
      if (typeof url === "string" && url) urls.push(url);
    }
    return urls;
  };

  const coerceExtractedUrls = (extracted) => {
    if (!extracted || typeof extracted[Symbol.iterator] !== "function") return [];
    const urls = [];
    for (const entry of extracted) {
      if (typeof entry === "string") urls.push(entry);
      else if (entry && typeof entry === "object") {
        const url = entry.url || entry.src || entry.currentSrc;
        if (typeof url === "string" && url) urls.push(url);
      }
    }
    return urls;
  };

  const findTurnElements = (rootNode) => {
    for (const selector of TURN_SELECTORS) {
      try {
        const found = rootNode.querySelectorAll(selector);
        const elements = found ? [...found] : [];
        if (elements.length) return elements;
      } catch {
        /* try the next selector in the chain */
      }
    }
    return [];
  };

  const captureBaseline = (rootNode, options = {}) => {
    if (!rootNode || typeof rootNode.querySelectorAll !== "function") return emptySnapshot();
    const extractor =
      typeof options?.extractImageUrls === "function"
        ? options.extractImageUrls
        : typeof options?.extractImages === "function"
          ? options.extractImages
          : null;
    const elements = findTurnElements(rootNode);
    const turnData = [];
    elements.forEach((element, index) => {
      try {
        let imageUrls;
        if (extractor) {
          try {
            imageUrls = coerceExtractedUrls(extractor(element));
          } catch {
            imageUrls = [];
          }
        } else {
          imageUrls = defaultExtractImageUrls(element);
        }
        turnData.push({ id: turnIdentity(element, index), role: turnRole(element), imageUrls });
      } catch {
        /* one unreadable turn must not lose the whole snapshot */
      }
    });
    return snapshotFromTurns(turnData);
  };

  const ChatGptBaseline = Object.freeze({
    captureBaseline,
    snapshotFromTurns,
    normalizeSnapshot,
    diffSnapshots,
    emptySnapshot,
    fileIdFromUrl,
    imageKey,
    TURN_SELECTORS: Object.freeze([...TURN_SELECTORS]),
  });
  root.ChatGptBaseline = ChatGptBaseline;
})();
