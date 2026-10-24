import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HOME_DIR } from "./paths.js";

const normalizeCharacterName = (name: string): string => name.replace(/\s+/g, " ").trim().toLowerCase();
const looksFile = () => join(HOME_DIR, "characters.json");

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

// FEAT-06: the canonical selection slug, derived exactly like the
// shared normalization layer (extension/src/content/shared/
// selection-normalize.js) derives it, so a stored selection slug names
// the same character on the MCP side as in the extension.
// Audit cluster E: the extension is the source of truth, so this uses
// toLocaleLowerCase() exactly like slugifySelectionName — toLowerCase()
// diverges from it under tr/az ambient locales (I -> ı vs i).
export const characterSlug = (name: string): string => String(name || "")
  .replace(/đ/g, "d").replace(/Đ/g, "D")
  .normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLocaleLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "");

const lookForName = (raw: string, looks: Record<string, string>): string | undefined => {
  const value = String(raw || "").replace(/^character:/i, "").trim();
  if (!value) return undefined;
  const key = normalizeCharacterName(value);
  if (looks[key]) return looks[key];
  // A selection slug ("anh-hung") resolves to the look stored under the
  // character's display name by comparing canonical slugs.
  const slug = characterSlug(value);
  if (!slug) return undefined;
  for (const [storedName, look] of Object.entries(looks)) {
    if (characterSlug(storedName) === slug) return look;
  }
  return undefined;
};

export const characterLook = (name: string): string | undefined => {
  return name ? lookForName(name, loadLooks()) : undefined;
};

// FEAT-06: resolve a character look from a stored selection in any of
// the shapes the shared normalization layer accepts — a slug string, a
// JSON string, a single selection object, an array, or node/settings
// wrappers. The first entry that resolves wins; unknown selections
// return undefined (nothing is invented for them).
const selectionIdentifiers = (selection: unknown): string[] => {
  if (typeof selection === "string") {
    const text = selection.trim();
    if (!text) return [];
    if (text.startsWith("{") || text.startsWith("[")) {
      try { return selectionIdentifiers(JSON.parse(text)); }
      catch { return [text]; }
    }
    return [text];
  }
  if (Array.isArray(selection)) return selection.flatMap(selectionIdentifiers);
  if (selection && typeof selection === "object") {
    const record = selection as Record<string, unknown>;
    const direct = [record.name, record.slug, record.search_value, record.searchValue]
      .find((value): value is string => typeof value === "string" && Boolean(value.trim()));
    if (direct) return [direct];
    for (const key of ["selections", "characters", "character", "selectedCharacter", "selection", "primary", "settings", "node", "value"]) {
      if (record[key] !== undefined) return selectionIdentifiers(record[key]);
    }
  }
  return [];
};

export const characterLookForSelection = (selection: unknown, looks: Record<string, string> = loadLooks()): string | undefined => {
  for (const identifier of selectionIdentifiers(selection)) {
    const look = lookForName(identifier, looks);
    if (look) return look;
  }
  return undefined;
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
