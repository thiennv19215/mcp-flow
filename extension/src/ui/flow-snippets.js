(function attachFlowSnippets(root) {
  "use strict";

  // FEAT-04 — Snippets with {{variables}} + addon prompts (study B4).
  //
  // The flat saved-prompts store (chrome.storage.local key
  // "flowMcpSavedPrompts", legacy entries {id, name, prompt, createdAt})
  // upgrades IN PLACE to snippets {id, title, content, category, tags,
  // variables}. Variables are always derived from the content's
  // {{name}} placeholders — never trusted from storage. The sidebar's
  // insert path collects a value per variable and fills every
  // occurrence; one selected addon/style snippet is appended at
  // batch-build time only, so stored prompts never carry addon text.

  const SNIPPETS_STORAGE_KEY = "flowMcpSavedPrompts";
  const SNIPPET_LIMIT = 100;

  function variablePattern() {
    return /\{\{\s*([^{}]+?)\s*\}\}/g;
  }

  function extractSnippetVariables(content) {
    const text = typeof content === "string" ? content : "";
    const names = [];
    const seen = new Set();
    for (const match of text.matchAll(variablePattern())) {
      const name = String(match[1] || "").trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
    return names;
  }

  function fillSnippetContent(content, values) {
    const text = typeof content === "string" ? content : "";
    const provided = values && typeof values === "object" ? values : {};
    return text.replace(variablePattern(), (whole, rawName) => {
      const name = String(rawName || "").trim();
      if (!name || !Object.prototype.hasOwnProperty.call(provided, name)) return whole;
      const value = provided[name];
      if (value === null || value === undefined) return whole;
      return String(value);
    });
  }

  function normalizeSnippetTags(tags) {
    const list = Array.isArray(tags) ? tags
      : (typeof tags === "string" ? tags.split(",") : []);
    const seen = new Set();
    const normalized = [];
    for (const tag of list) {
      const value = String(tag ?? "").trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      normalized.push(value);
    }
    return normalized;
  }

  function isLegacySnippetEntry(entry) {
    return !!entry && typeof entry === "object"
      && typeof entry.content !== "string"
      && (typeof entry.prompt === "string" || typeof entry.name === "string");
  }

  // Canonical snippet shape from either a snippet or a legacy flat
  // prompt. Returns null when there is no usable content.
  function normalizeSnippet(entry) {
    if (!entry || typeof entry !== "object") return null;
    const content = typeof entry.content === "string" ? entry.content
      : (typeof entry.prompt === "string" ? entry.prompt : "");
    if (!content.trim()) return null;
    const title = (typeof entry.title === "string" && entry.title.trim()) ? entry.title.trim()
      : (typeof entry.name === "string" && entry.name.trim()) ? entry.name.trim()
        : content.slice(0, 36);
    return {
      id: typeof entry.id === "string" ? entry.id : "",
      title,
      content,
      category: typeof entry.category === "string" ? entry.category.trim() : "",
      tags: normalizeSnippetTags(entry.tags),
      variables: extractSnippetVariables(content),
      createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : 0,
    };
  }

  function createSnippet(input, idFactory) {
    const snippet = normalizeSnippet(input);
    if (!snippet) return null;
    let id = "";
    if (typeof idFactory === "function") {
      try { id = String(idFactory() || ""); } catch { id = ""; }
    }
    snippet.id = id || `snippet-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    if (!snippet.createdAt) snippet.createdAt = Date.now();
    return snippet;
  }

  // Batch-build-time composition ONLY: appends the addon text to a
  // prompt being submitted. Never call this on a stored snippet.
  function applySnippetAddon(promptText, addonText) {
    const prompt = typeof promptText === "string" ? promptText : "";
    const addon = typeof addonText === "string" ? addonText.trim() : "";
    if (!addon) return prompt;
    if (!prompt.trim()) return addon;
    return `${prompt}\n\n${addon}`;
  }

  class FlowSnippetStore {
    constructor({ storage, key = SNIPPETS_STORAGE_KEY, limit = SNIPPET_LIMIT, idFactory } = {}) {
      if (!storage || typeof storage.get !== "function" || typeof storage.set !== "function") {
        throw new Error("FlowSnippetStore requires a chrome.storage-like area with get/set.");
      }
      this.storage = storage;
      this.key = key;
      this.limit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : SNIPPET_LIMIT;
      this.idFactory = idFactory;
    }

    async readRaw() {
      const result = await this.storage.get(this.key);
      const value = result?.[this.key];
      return Array.isArray(value) ? value : [];
    }

    async writeAll(snippets) {
      await this.storage.set({ [this.key]: snippets });
    }

    // Reads every entry as a snippet. Legacy flat entries are upgraded
    // and the upgraded list is written back once (the in-place
    // upgrade), so storage converges to the snippet shape.
    async list() {
      const raw = await this.readRaw();
      const snippets = [];
      let changed = false;
      for (const entry of raw) {
        const snippet = normalizeSnippet(entry);
        if (!snippet) { changed = true; continue; }
        if (!snippet.id) {
          snippet.id = `snippet-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
          changed = true;
        }
        if (isLegacySnippetEntry(entry) || JSON.stringify(entry) !== JSON.stringify(snippet)) changed = true;
        snippets.push(snippet);
      }
      const capped = snippets.slice(0, this.limit);
      if (capped.length !== snippets.length) changed = true;
      if (changed) await this.writeAll(capped);
      return capped;
    }

    async get(id) {
      const snippets = await this.list();
      return snippets.find(snippet => snippet.id === String(id)) || null;
    }

    async add(input) {
      const snippet = createSnippet(input, this.idFactory);
      if (!snippet) {
        throw Object.assign(new Error("Snippet content is required."), { code: "FLOW_SNIPPET_CONTENT_REQUIRED" });
      }
      const existing = await this.list();
      // Same semantics as the legacy save: one entry per content,
      // newest first, capped.
      const next = [snippet, ...existing.filter(item => item.content !== snippet.content)].slice(0, this.limit);
      await this.writeAll(next);
      return snippet;
    }

    async update(id, patch) {
      const snippets = await this.list();
      const index = snippets.findIndex(snippet => snippet.id === String(id));
      if (index < 0) return null;
      const merged = normalizeSnippet({ ...snippets[index], ...(patch || {}), id: snippets[index].id, createdAt: snippets[index].createdAt });
      if (!merged) return null;
      snippets[index] = merged;
      await this.writeAll(snippets);
      return merged;
    }

    async remove(id) {
      const snippets = await this.list();
      const next = snippets.filter(snippet => snippet.id !== String(id));
      if (next.length === snippets.length) return false;
      await this.writeAll(next);
      return true;
    }
  }

  root.FlowSnippets = {
    SNIPPETS_STORAGE_KEY,
    SNIPPET_LIMIT,
    extractSnippetVariables,
    fillSnippetContent,
    normalizeSnippet,
    normalizeSnippetTags,
    isLegacySnippetEntry,
    createSnippet,
    applySnippetAddon,
    FlowSnippetStore,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
