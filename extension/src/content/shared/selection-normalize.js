// FEAT-06 — Character/voice selection normalization layer (study #18).
//
// Logic (implemented fresh from the reference's registry design, not its
// code): characters and voices are Flow-native entities scraped from the
// Flow page into a cached list. A selection, wherever it is stored — gen
// settings, a batch snapshot, a workflow node — is normalized through ONE
// function shared by the sidebar modal, queue payloads and the MCP
// workflow planners:
//
//   - accepts a slug string, a JSON string, a single object, an array of
//     any of those, or node/settings wrapper shapes
//     ({character: …}, {settings: {…}}, {node: {value: …}}, a shaped
//     {primary, selections} payload, …);
//   - resolves each entry against the cached list to fill
//     name / thumbnail / search_value (characters) from the catalog;
//   - dedupes by slug, first occurrence wins;
//   - shapes the generation payload as primary = first selection plus
//     the full selections list.
//
// An entry that matches nothing in the catalog passes through with only
// the fields it carried, marked resolved:false — the layer never
// fabricates catalog data for an unknown slug. Voices mirror the same
// rules over local/scraped voice lists (bare names or {name} records);
// the reference's server-fetched base voice catalog stays blocked
// (FEAT-B6) and is deliberately not reproduced here.
//
// The module is pure: no DOM, no storage, no network. Catalog entries are
// accepted in the reference shape {slug, search_value, name, thumbnail}
// and in this repo's own scraper shape {name, uuid, thumbnailUrl}.

(() => {
  "use strict";

  const root = typeof globalThis !== "undefined" ? globalThis : (typeof window !== "undefined" ? window : self);

  const isRecord = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const cleanString = value => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");

  // Canonical comparison key for names: whitespace-collapsed, case-folded.
  const nameKey = value => cleanString(value).toLocaleLowerCase();

  // Canonical slug: accent-folded (NFKD + combining-mark strip, đ/Đ do
  // not decompose so they are mapped first), lowercased, every run of
  // non-alphanumerics becomes one dash.
  function slugifySelectionName(value) {
    return String(value || "")
      .replace(/đ/g, "d").replace(/Đ/g, "D")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "") // combining diacritical marks
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  // --- Catalog -------------------------------------------------------------
  // A catalog entry canonicalized once, then indexed under every key a
  // stored selection might use to point at it: its slug, its display
  // name, and (for characters) its entity uuid.

  function canonicalCatalogEntry(raw, kind) {
    if (typeof raw === "string") {
      const name = cleanString(raw);
      return name ? { slug: slugifySelectionName(name), name } : null;
    }
    if (!isRecord(raw)) return null;
    const name = cleanString(raw.name || raw.title);
    const slug = cleanString(raw.slug) || (name ? slugifySelectionName(name) : "");
    if (!slug && !name) return null;
    if (kind === "voice") {
      return {
        slug, name,
        ...(raw.id || raw.uuid ? { id: String(raw.id || raw.uuid) } : {}),
      };
    }
    return {
      slug, name,
      ...(cleanString(raw.search_value || raw.searchValue) ? { search_value: cleanString(raw.search_value || raw.searchValue) } : {}),
      ...(cleanString(raw.thumbnail || raw.thumbnailUrl || raw.thumb) ? { thumbnail: cleanString(raw.thumbnail || raw.thumbnailUrl || raw.thumb) } : {}),
      ...(raw.uuid || raw.id ? { uuid: String(raw.uuid || raw.id) } : {}),
    };
  }

  function indexSelectionCatalog(catalog, kind = "character") {
    const index = new Map();
    const entries = Array.isArray(catalog) ? catalog : (catalog ? [catalog] : []);
    for (const raw of entries) {
      const entry = canonicalCatalogEntry(raw, kind);
      if (!entry) continue;
      const keys = [];
      if (entry.slug) keys.push(`slug:${entry.slug}`);
      if (entry.name) keys.push(`name:${nameKey(entry.name)}`);
      if (entry.search_value) keys.push(`name:${nameKey(entry.search_value)}`);
      const identity = kind === "voice" ? entry.id : entry.uuid;
      if (identity) keys.push(`id:${String(identity).toLocaleLowerCase()}`);
      for (const key of keys) if (!index.has(key)) index.set(key, entry);
    }
    return index;
  }

  // --- Selection input -----------------------------------------------------
  // Stored selections arrive in many shapes. Collection flattens any of
  // them into raw item descriptors {slug?, name?, search_value?,
  // thumbnail?, uuid?} without judging them; resolution happens after.

  function descriptorFromRecord(record, kind) {
    if (!isRecord(record)) return null;
    const descriptor = {};
    if (cleanString(record.slug)) descriptor.slug = cleanString(record.slug);
    const name = cleanString(record.name || record.title);
    if (name) descriptor.name = name;
    const searchValue = cleanString(record.search_value || record.searchValue);
    if (searchValue) descriptor.search_value = searchValue;
    if (kind === "character") {
      const thumbnail = cleanString(record.thumbnail || record.thumbnailUrl || record.thumb);
      if (thumbnail) descriptor.thumbnail = thumbnail;
      const uuid = cleanString(record.uuid || record.expectedId || record.id);
      if (uuid) descriptor.uuid = uuid;
    } else {
      const id = cleanString(record.id || record.uuid);
      if (id) descriptor.id = id;
    }
    return Object.keys(descriptor).length ? descriptor : null;
  }

  const WRAPPER_KEYS = {
    character: ["selections", "characters", "character", "selectedCharacter", "selection", "primary", "settings", "node", "value"],
    voice: ["selections", "voices", "voice", "selectedVoice", "selection", "primary", "settings", "node", "value"],
  };

  function collectItems(input, kind, out) {
    if (input === null || input === undefined) return;
    if (typeof input === "string") {
      const text = input.trim();
      if (!text) return;
      if (text.startsWith("{") || text.startsWith("[")) {
        try {
          collectItems(JSON.parse(text), kind, out);
          return;
        } catch { /* not JSON after all — fall through as a plain string */ }
      }
      const prefix = kind === "voice" ? /^voice:/i : /^character:/i;
      if (prefix.test(text)) {
        const name = cleanString(text.replace(prefix, ""));
        if (name) out.push({ name });
        return;
      }
      // A bare string that is already slug-shaped is a stored slug;
      // anything else is a display name. Both resolve through the same
      // index, and the passthrough shape differs (slug-only vs named).
      if (slugifySelectionName(text) === text) out.push({ slug: text });
      else out.push({ name: cleanString(text) });
      return;
    }
    if (Array.isArray(input)) {
      for (const item of input) collectItems(item, kind, out);
      return;
    }
    if (isRecord(input)) {
      const descriptor = descriptorFromRecord(input, kind);
      if (descriptor) {
        out.push(descriptor);
        return;
      }
      for (const key of WRAPPER_KEYS[kind]) {
        if (input[key] !== undefined) {
          collectItems(input[key], kind, out);
          return;
        }
      }
    }
    // Numbers, booleans and identifier-less objects contribute nothing.
  }

  // --- Resolution ----------------------------------------------------------

  function lookupCatalog(descriptor, index) {
    if (descriptor.slug && index.has(`slug:${descriptor.slug}`)) return index.get(`slug:${descriptor.slug}`);
    const identity = descriptor.uuid || descriptor.id;
    if (identity && index.has(`id:${String(identity).toLocaleLowerCase()}`)) return index.get(`id:${String(identity).toLocaleLowerCase()}`);
    const nameLike = descriptor.name || descriptor.search_value;
    if (nameLike) {
      if (index.has(`name:${nameKey(nameLike)}`)) return index.get(`name:${nameKey(nameLike)}`);
      const slug = slugifySelectionName(nameLike);
      if (slug && index.has(`slug:${slug}`)) return index.get(`slug:${slug}`);
    }
    if (descriptor.slug) {
      // A stored slug may be the slugified display name of a catalog
      // entry that carries no explicit slug field.
      if (index.has(`name:${descriptor.slug.replace(/-/g, " ")}`)) return index.get(`name:${descriptor.slug.replace(/-/g, " ")}`);
    }
    return null;
  }

  function resolveDescriptor(descriptor, index, kind) {
    const found = lookupCatalog(descriptor, index);
    if (kind === "voice") {
      if (found) {
        return {
          slug: found.slug || descriptor.slug || slugifySelectionName(found.name || descriptor.name || ""),
          name: found.name || descriptor.name || "",
          ...(found.id || descriptor.id ? { id: found.id || descriptor.id } : {}),
          resolved: true,
        };
      }
      return {
        slug: descriptor.slug || slugifySelectionName(descriptor.name || ""),
        ...(descriptor.name ? { name: descriptor.name } : {}),
        ...(descriptor.id ? { id: descriptor.id } : {}),
        resolved: false,
      };
    }
    if (found) {
      const name = found.name || descriptor.name || "";
      return {
        slug: found.slug || descriptor.slug || slugifySelectionName(name),
        name,
        // search_value falls back to the display name — the same
        // fallback the composer applies at attach time
        // (reference-actions: `value.search_value || name`).
        search_value: found.search_value || descriptor.search_value || name,
        ...(found.thumbnail || descriptor.thumbnail ? { thumbnail: found.thumbnail || descriptor.thumbnail } : {}),
        ...(found.uuid || descriptor.uuid ? { uuid: found.uuid || descriptor.uuid } : {}),
        resolved: true,
      };
    }
    return {
      slug: descriptor.slug || slugifySelectionName(descriptor.name || descriptor.search_value || ""),
      ...(descriptor.name ? { name: descriptor.name } : {}),
      ...(descriptor.search_value ? { search_value: descriptor.search_value } : {}),
      ...(descriptor.thumbnail ? { thumbnail: descriptor.thumbnail } : {}),
      ...(descriptor.uuid ? { uuid: descriptor.uuid } : {}),
      resolved: false,
    };
  }

  function normalizeSelection(input, catalog, kind) {
    const items = [];
    collectItems(input, kind, items);
    const index = indexSelectionCatalog(catalog, kind);
    const seen = new Set();
    const entries = [];
    for (const descriptor of items) {
      const entry = resolveDescriptor(descriptor, index, kind);
      const dedupeKey = entry.slug || entry.uuid || entry.id || nameKey(entry.name || "");
      if (!dedupeKey || seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      entries.push(entry);
    }
    return entries;
  }

  const normalizeCharacterSelection = (input, catalog) => normalizeSelection(input, catalog, "character");
  const normalizeVoiceSelection = (input, catalog) => normalizeSelection(input, catalog, "voice");

  // The generation payload takes the first selection as the primary plus
  // the full selections list.
  const shapePayload = entries => ({ primary: entries[0] || null, selections: entries });
  const shapeCharacterSelectionPayload = (input, catalog) => shapePayload(normalizeCharacterSelection(input, catalog));
  const shapeVoiceSelectionPayload = (input, catalog) => shapePayload(normalizeVoiceSelection(input, catalog));

  root.FlowSelectionNormalize = Object.freeze({
    slugifySelectionName,
    indexSelectionCatalog,
    normalizeCharacterSelection,
    normalizeVoiceSelection,
    shapeCharacterSelectionPayload,
    shapeVoiceSelectionPayload,
  });
})();
