import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, extname, join } from "node:path";
import { castDirForContext, HOME_DIR } from "./paths.js";
import { currentDeviceContext } from "./request-context.js";
import type { CharacterParams, NativeMedia } from "./types.js";
import type { Job } from "./job-types.js";
import { nativeOperation, requireCapabilities } from "./flow.js";
import { stageNativeMedia, cleanStagedFiles } from "./flow-transfer.js";
import { downloadNativeResults, extensionOf, nativeDownloadIds, waitForNativeDownload } from "./native-downloads.js";

const ASSET_PREFIX = "asset:";
const normalizeCharacterName = (name: string): string => name.replace(/\s+/g, " ").trim().toLowerCase();
const looksFile = () => {
  const context = currentDeviceContext();
  return context ? join(HOME_DIR, "users", context.userId, context.deviceId, "characters.json") : join(HOME_DIR, "characters.json");
};

export const loadLooks = (): Record<string, string> => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(looksFile(), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([name, look]) => [normalizeCharacterName(name), look.trim()])
      .filter(([name]) => Boolean(name))) as Record<string, string>;
  } catch { return {}; }
};

export const characterLook = (name: string): string | undefined => {
  const key = normalizeCharacterName(name);
  return key ? loadLooks()[key] : undefined;
};

export function rememberCharacter(name: string, look: string): void {
  const key = normalizeCharacterName(name);
  if (!key) throw new Error("Character name is required to remember its appearance.");
  const file = looksFile();
  mkdirSync(dirname(file), { recursive: true });
  const looks = loadLooks();
  const description = String(look || "").trim();
  if (description) looks[key] = description;
  else delete looks[key];
  writeFileSync(file, JSON.stringify(looks, null, 2));
}

export async function createCharacter(c: CharacterParams, job?: Job): Promise<{ name: string; url: string; portrait?: string; cleanupWarning?: string }> {
  if (!c.image && !c.describe) throw new Error("Pass either an image or a description for the character.");
  const flowContext = job ?? ({} as Job);
  const localImage = Boolean(c.image && !c.image.startsWith(ASSET_PREFIX));
  if (localImage) {
    try {
      const info = statSync(c.image!);
      if (!info.isFile() || info.size < 1 || info.size > 25 * 1024 * 1024 || ![".png", ".jpg", ".jpeg", ".webp", ".gif", ".heic", ".heif", ".avif"].includes(extname(c.image!).toLowerCase())) {
        throw new Error("Character images must be PNG, JPG, JPEG, WebP, GIF, HEIC, HEIF or AVIF files up to 25 MiB.");
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Character images")) throw error;
      throw new Error(`Character image file not found or unreadable: ${c.image}`);
    }
  }
  requireCapabilities("flow.native.character.create");
  const stagedDirs: string[] = [];
  let stagedTransferId: string | undefined;
  try {
    let character = c;
    if (localImage) {
      requireCapabilities("flow.native.generation.upload.preflight");
      await nativeOperation("flow.generation.upload.preflight", {}, "flow.native.generation.upload.preflight", flowContext, 10_000);
      const staged = await stageNativeMedia(c.image!, `fm-${randomUUID().replace(/-/g, "").slice(0, 12)}-character${extname(c.image!).toLowerCase()}`, stagedDirs, flowContext);
      stagedTransferId = staged.transferId;
      character = { ...c, image: staged } as unknown as CharacterParams;
    }
    const result = await nativeOperation<{ name: string; url: string; portraitMedia?: NativeMedia; cleanupWarning?: string }>("flow.character.create", { character }, "flow.native.character.create", flowContext, 10 * 60_000);
    let portrait: string | undefined;
    if (result.portraitMedia) {
      const dir = castDirForContext();
      try { portrait = (await downloadNativeResults([result.portraitMedia], dir, c.name.replace(/[^\w.-]+/g, "_"), "original", flowContext))[0]; }
      catch { /* The character is saved in Flow; its portrait can be fetched with the edit tool. */ }
    } else if (localImage) {
      const dir = castDirForContext();
      mkdirSync(dir, { recursive: true });
      portrait = join(dir, `${c.name.replace(/[^\w.-]+/g, "_")}${extname(c.image!).toLowerCase()}`);
      copyFileSync(c.image!, portrait);
    }
    if (c.describe) rememberCharacter(c.name, c.describe);
    if (job) job.progress = undefined;
    return { name: result.name, url: result.url, portrait, ...(result.cleanupWarning ? { cleanupWarning: result.cleanupWarning } : {}) };
  } finally {
    if (stagedTransferId) await nativeOperation("flow.file.upload.abort", { transferId: stagedTransferId }, "flow.native.file.upload.abort", flowContext, 10_000).catch(() => {});
    cleanStagedFiles(stagedDirs);
  }
}

export async function editCharacter(name: string, change?: string, job?: Job, rename?: string): Promise<{ name: string; portrait?: string; note?: string; cleanupWarning?: string }> {
  requireCapabilities("flow.native.character.edit");
  const flowContext = job ?? ({} as Job);
  const before = await nativeDownloadIds();
  const result = await nativeOperation<{ name: string; downloadTriggered?: boolean; note?: string; cleanupWarning?: string }>(
    "flow.character.edit", { name, change, rename, timeoutMs: 4 * 60_000 }, "flow.native.character.edit", flowContext, 5 * 60_000,
  );
  let portrait: string | undefined;
  let note = result.note;
  if (result.downloadTriggered) {
    try {
      const file = await waitForNativeDownload(before, 90_000, progress => { if (job) job.progress = progress; });
      const dir = castDirForContext();
      mkdirSync(dir, { recursive: true });
      portrait = join(dir, `${(rename || name).replace(/[^\w.-]+/g, "_")}${extensionOf(file.filename)}`);
      copyFileSync(file.filename, portrait);
    } catch (error) {
      note = `${change ? `${name} was changed in Flow, but the new` : "The"} portrait could not be saved (${error instanceof Error ? error.message : String(error)}). Call flow_character_edit with just the name to save it.`;
    }
  }
  if (job) job.progress = undefined;
  return { name: rename || name, portrait, note, ...(result.cleanupWarning ? { cleanupWarning: result.cleanupWarning } : {}) };
}
