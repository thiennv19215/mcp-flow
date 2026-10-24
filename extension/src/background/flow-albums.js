// Generation albums / photo organization (FEAT-10).
//
// Logic (adapted from the reference extension's album design, not its
// code): an album is a named, ordered list of image IDENTITIES — the
// Flow media id, display name, kind, owning project and thumbnail URL.
// The media itself stays where it already lives (the Flow library /
// project folders), so this store keeps metadata only; there is no blob
// store here. The same image may belong to many albums, an album may be
// empty, and the album cover is simply its first image.
//
// Album membership is a metadata layer over the same identities the
// reference picker already works with: "use as ref" on an album image
// returns the exact reference shape a Flow library pick produces
// (`albumImageToReference`), so it rides the existing attach path
// unchanged instead of inventing a second identity format.
//
// Store discipline mirrors the sibling stores (drafts, runs, history,
// tasks): versioned storage envelope, write chain with snapshots taken
// at write time, storage failures degrading to in-memory state.

const STORAGE_KEY = "flowMcpAlbumsV1";
const MAX_ALBUMS = 100;
const MAX_IMAGES_PER_ALBUM = 500;

const clone = value => structuredClone(value);
const asObject = value => (value && typeof value === "object" && !Array.isArray(value) ? value : null);

const albumError = (message, code) => Object.assign(new Error(message), { code });

// --- image identities ----------------------------------------------------------

// Bring any caller-supplied image (a Flow library asset, a generation
// result, a picker selection) into the stored identity shape. The media
// id is the one hard requirement: an album entry that cannot be pointed
// back at the Flow asset it names would be a dead record, so it is
// rejected here, at save time.
export function normalizeAlbumImage(input) {
  const source = asObject(input);
  const id = String(source?.id || source?.expectedId || "").trim();
  if (!id) {
    throw albumError("An album image needs a Flow media id.", "FLOW_ALBUM_IMAGE_INVALID");
  }
  const name = String(source?.name || "").trim() || id;
  return {
    id,
    name,
    kind: source?.kind === "video" ? "video" : "image",
    projectId: String(source?.projectId || "").trim() || null,
    thumbnailUrl: String(source?.thumbnailUrl || "").trim() || null,
    addedAt: Number.isFinite(source?.addedAt) ? source.addedAt : Date.now(),
  };
}

// The reference shape the picker builds for a Flow library asset —
// album "use as ref" returns the same shape so the attach path cannot
// tell (or care) where the identity came from. A caller-side project
// (the picker's current project) wins over the stored one when given.
export function albumImageToReference(image, { projectId } = {}) {
  const normalized = normalizeAlbumImage(image);
  return {
    source: "flow",
    projectId: projectId || normalized.projectId,
    id: normalized.id,
    name: normalized.name,
    kind: normalized.kind,
    assetName: `asset:${normalized.name}`,
    expectedId: normalized.id,
    thumbnailUrl: normalized.thumbnailUrl,
  };
}

// --- names -----------------------------------------------------------------------

function normalizeAlbumName(value) {
  const name = String(value ?? "").trim().replace(/\s+/g, " ");
  if (!name) {
    throw albumError("An album needs a non-empty name.", "FLOW_ALBUM_NAME_REQUIRED");
  }
  return name;
}

// Album names are unique case-insensitively (the study's "unique name"
// rule): a colliding name gains a counter suffix instead of failing, so
// saving the same name twice keeps two findable albums. `exclude` lets
// a rename keep its own current name.
export function uniquifyAlbumName(name, existingNames, { exclude = null } = {}) {
  const base = normalizeAlbumName(name);
  const taken = new Set(
    (Array.isArray(existingNames) ? existingNames : [])
      .map(entry => String(entry || "").trim().toLowerCase())
      .filter(Boolean),
  );
  if (exclude) taken.delete(String(exclude).trim().toLowerCase());
  if (!taken.has(base.toLowerCase())) return base;
  for (let counter = 2; ; counter += 1) {
    const candidate = `${base} (${counter})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

// --- store -------------------------------------------------------------------------

export class FlowAlbums {
  constructor({ storage = globalThis.chrome?.storage?.local, storageKey = STORAGE_KEY, maxAlbums = MAX_ALBUMS } = {}) {
    if (!storage?.get || !storage?.set) throw new TypeError("FlowAlbums requires chrome.storage.local or a compatible storage adapter.");
    this.storage = storage;
    this.storageKey = storageKey;
    this.maxAlbums = Math.max(1, Number(maxAlbums) || MAX_ALBUMS);
    this.albums = [];
    this.writeChain = Promise.resolve();
    this.persistQueued = false;
    this.ready = this.#restore();
  }

  async #restore() {
    try {
      const stored = await this.storage.get(this.storageKey);
      const state = stored?.[this.storageKey];
      if (state && state.version === 1 && Array.isArray(state.albums)) {
        this.albums = state.albums
          .filter(entry => entry && typeof entry.id === "string" && typeof entry.name === "string" && Array.isArray(entry.images))
          .slice(0, this.maxAlbums)
          .map(entry => ({
            ...clone(entry),
            images: entry.images
              .filter(image => image && typeof image.id === "string")
              .slice(0, MAX_IMAGES_PER_ALBUM)
              .map(image => clone(image)),
          }));
      }
    } catch {
      // A corrupt or unavailable store must not wedge every album
      // operation behind a rejected ready promise; start empty instead.
      this.albums = [];
    }
    return this.#presentList();
  }

  // Batched writes, same discipline as the sibling stores: the snapshot
  // is taken when the chained write actually runs.
  #schedulePersist() {
    if (this.persistQueued) return this.writeChain;
    this.persistQueued = true;
    this.writeChain = this.writeChain.catch(() => {}).then(async () => {
      this.persistQueued = false;
      const snapshot = { version: 1, updatedAt: Date.now(), albums: clone(this.albums) };
      await this.storage.set({ [this.storageKey]: snapshot });
    }).catch(() => {});
    return this.writeChain;
  }

  async flush() {
    await this.ready;
    await this.writeChain;
  }

  #find(id) {
    return this.albums.find(entry => entry.id === String(id)) || null;
  }

  #require(id) {
    const album = this.#find(id);
    if (!album) throw albumError(`No album with id ${id}.`, "FLOW_ALBUM_NOT_FOUND");
    return album;
  }

  // The presented shape adds the two derived facts the Photos tab keys
  // on — membership count and the cover (first image) — without storing
  // either, so they can never drift from the ordered image list.
  #present(album) {
    const presented = clone(album);
    presented.imageCount = album.images.length;
    presented.cover = album.images.length ? clone(album.images[0]) : null;
    return presented;
  }

  #presentList() {
    return this.albums.map(album => this.#present(album));
  }

  async list() {
    await this.ready;
    return this.#presentList();
  }

  async get(id) {
    await this.ready;
    const album = this.#find(id);
    return album ? this.#present(album) : null;
  }

  async create({ name } = {}) {
    await this.ready;
    const now = Date.now();
    const album = {
      id: crypto.randomUUID(),
      version: 1,
      name: uniquifyAlbumName(name, this.albums.map(entry => entry.name)),
      images: [],
      createdAt: now,
      updatedAt: now,
    };
    this.albums.unshift(album);
    while (this.albums.length > this.maxAlbums) this.albums.pop();
    this.#schedulePersist();
    return this.#present(album);
  }

  async rename(id, name) {
    await this.ready;
    const album = this.#require(id);
    album.name = uniquifyAlbumName(name, this.albums.map(entry => entry.name), { exclude: album.name });
    album.updatedAt = Date.now();
    this.#schedulePersist();
    return this.#present(album);
  }

  async remove(id) {
    await this.ready;
    const index = this.albums.findIndex(entry => entry.id === String(id));
    if (index < 0) return false;
    this.albums.splice(index, 1);
    this.#schedulePersist();
    return true;
  }

  // Append one image identity, preserving album order. Re-adding an
  // image that is already a member is an idempotent no-op: membership
  // is a set keyed by media id, order is first-add order.
  async addImage(albumId, image) {
    await this.ready;
    const album = this.#require(albumId);
    const normalized = normalizeAlbumImage(image);
    if (!album.images.some(entry => entry.id === normalized.id)) {
      album.images.push(normalized);
      if (album.images.length > MAX_IMAGES_PER_ALBUM) {
        album.images.splice(0, album.images.length - MAX_IMAGES_PER_ALBUM);
      }
      album.updatedAt = Date.now();
      this.#schedulePersist();
    }
    return this.#present(album);
  }

  // Remove one membership; the remaining images keep their order.
  // Removing an id that is not a member changes nothing (and does not
  // touch updatedAt).
  async removeImage(albumId, imageId) {
    await this.ready;
    const album = this.#require(albumId);
    const index = album.images.findIndex(entry => entry.id === String(imageId));
    if (index >= 0) {
      album.images.splice(index, 1);
      album.updatedAt = Date.now();
      this.#schedulePersist();
    }
    return this.#present(album);
  }
}
