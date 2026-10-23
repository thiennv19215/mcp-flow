// Per-project media catalog for Flow assets (IMG-03).
//
// Logic (adapted from the reference extension's media registry design, not
// its code): an upload resolves the asset's canonical identity — persistent
// media id, media UUID, project, thumbnail — at upload time and registers
// it here. Later identity resolutions (attach, revalidation, downloads)
// consult this catalog before paying for a DOM grid scan, and keep working
// after the tile has been virtualized or detached from the page.
//
// Persistence discipline mirrors FlowBatchDrafts: a synchronous snapshot
// chained onto a rejection-guarded write chain, and a restore that
// degrades to an empty catalog instead of wedging every operation behind
// a rejected promise. The catalog is advisory metadata only: a missing or
// stale entry can cost a fallback DOM scan, never a wrong identity —
// attach still verifies the resolved identity on the page itself.

const STORAGE_KEY = "flowMcpMediaCatalogV1";
export const FLOW_MEDIA_CATALOG_MAX_ENTRIES = 500;

const clone = value => structuredClone(value);

const cleanString = (value, max = 2048) => {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text.slice(0, max) : null;
};

function normalizeEntry(input) {
  if (!input || typeof input !== "object") return null;
  const projectId = cleanString(input.projectId, 128);
  const mediaId = cleanString(input.mediaId, 1100);
  const uuid = cleanString(input.uuid, 128)?.toLowerCase() || null;
  // An entry is only useful if later lookups can find the asset again:
  // it needs its project plus at least one durable identity.
  if (!projectId || (!mediaId && !uuid)) return null;
  const thumbnailUrl = cleanString(input.thumbnailUrl, 4096);
  return {
    projectId,
    mediaId,
    uuid,
    uploadName: cleanString(input.uploadName, 512),
    originalName: cleanString(input.originalName, 512),
    name: cleanString(input.name, 512),
    thumbnailUrl: thumbnailUrl && /^https?:\/\//i.test(thumbnailUrl) ? thumbnailUrl : null,
    kind: cleanString(input.kind, 32),
  };
}

// Two records describe the same asset when they share a project and any
// durable identity — the persistent media id, or the canonical UUID when
// the id form differs between observations (asb: id vs resolved UUID).
function sameAsset(a, b) {
  if (a.projectId !== b.projectId) return false;
  if (a.mediaId && b.mediaId && a.mediaId === b.mediaId) return true;
  if (a.uuid && b.uuid && a.uuid === b.uuid) return true;
  return false;
}

export class FlowMediaCatalog {
  constructor({ storage = globalThis.chrome?.storage?.local, storageKey = STORAGE_KEY, maxEntries = FLOW_MEDIA_CATALOG_MAX_ENTRIES } = {}) {
    if (!storage?.get || !storage?.set) throw new TypeError("FlowMediaCatalog requires chrome.storage.local or a compatible storage adapter.");
    this.storage = storage;
    this.storageKey = storageKey;
    this.maxEntries = Math.max(1, Math.floor(Number(maxEntries)) || FLOW_MEDIA_CATALOG_MAX_ENTRIES);
    this.entries = [];
    this.writeChain = Promise.resolve();
    this.ready = this.#restore();
  }

  async #restore() {
    try {
      const stored = await this.storage.get(this.storageKey);
      const state = stored?.[this.storageKey];
      if (state && state.version === 1 && Array.isArray(state.entries)) {
        this.entries = state.entries.map(entry => normalizeEntry(entry)).filter(Boolean)
          .map(entry => ({ ...entry, recordedAt: Number(entry.recordedAt) || 0 }));
      }
    } catch {
      // A corrupt or unavailable store must not wedge catalog operations;
      // start empty — lookups simply miss and callers fall back to the DOM.
      this.entries = [];
    }
    // Return the array directly: list() awaits this.ready, which is this
    // very promise — calling it here would deadlock the store.
    return clone(this.entries);
  }

  async #persist() {
    // Snapshot synchronously, then chain the write (same discipline as
    // the drafts store): concurrent records mutate the in-memory array
    // between awaits, and unordered storage writes could persist a stale
    // state over a fresher one. The catch guard keeps one rejected write
    // from poisoning every later write for the worker's lifetime.
    const snapshot = { version: 1, updatedAt: Date.now(), entries: clone(this.entries) };
    this.writeChain = this.writeChain.catch(() => {}).then(() => this.storage.set({ [this.storageKey]: snapshot }));
    return this.writeChain;
  }

  async record(input) {
    await this.ready;
    const entry = normalizeEntry(input);
    if (!entry) return null;
    const existingIndex = this.entries.findIndex(candidate => sameAsset(candidate, entry));
    let stored;
    if (existingIndex >= 0) {
      // Merge: fields the new observation carries win; fields it omits
      // keep their previously resolved values. The merged entry becomes
      // the most recent one.
      const previous = this.entries[existingIndex];
      stored = { ...previous };
      for (const [key, value] of Object.entries(entry)) {
        if (value !== null && value !== undefined) stored[key] = value;
      }
      this.entries.splice(existingIndex, 1);
    } else {
      stored = entry;
    }
    stored.recordedAt = Date.now();
    this.entries.push(stored);
    // Bounded size, oldest-first eviction (recordedAt order == array
    // order, since merges re-append).
    while (this.entries.length > this.maxEntries) this.entries.shift();
    await this.#persist();
    return clone(stored);
  }

  async lookup(query = {}) {
    await this.ready;
    const projectId = cleanString(query?.projectId, 128);
    if (!projectId) return null;
    const mediaId = cleanString(query?.mediaId, 1100);
    const uuid = cleanString(query?.uuid, 128)?.toLowerCase() || null;
    const uploadName = cleanString(query?.uploadName, 512);
    const name = cleanString(query?.name, 512);
    const inProject = this.entries.filter(entry => entry.projectId === projectId);
    // Identity strength order: the persistent media id and the canonical
    // UUID are interchangeable keys for the same record (a query may
    // carry either form); names are weaker fallbacks.
    const byIdentity = inProject.find(entry =>
      (mediaId && (entry.mediaId === mediaId || entry.uuid === mediaId)) ||
      (uuid && (entry.uuid === uuid || entry.mediaId === uuid)));
    if (byIdentity) return clone(byIdentity);
    if (uploadName) {
      const byUploadName = inProject.find(entry => entry.uploadName === uploadName);
      if (byUploadName) return clone(byUploadName);
    }
    if (name) {
      const byName = inProject.find(entry => entry.name === name || entry.originalName === name);
      if (byName) return clone(byName);
    }
    return null;
  }

  async list(projectId) {
    await this.ready;
    const entries = projectId
      ? this.entries.filter(entry => entry.projectId === String(projectId))
      : this.entries;
    return clone(entries);
  }
}
