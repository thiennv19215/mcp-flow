// Flow automation uses one stable English UI contract. Localized selector
// aliases remain useful for diagnostics, but navigation must stay in English.
export const FLOW_LOCALES = Object.freeze(["en"]);

export function normalizeFlowLocale(value) {
  return FLOW_LOCALES.includes(String(value || "").trim().toLowerCase())
    ? String(value).trim().toLowerCase()
    : null;
}

export function flowLocaleFromUrl(value) {
  try {
    return normalizeFlowLocale(new URL(value).searchParams.get("hl"));
  } catch {
    return null;
  }
}

export function flowDocumentMatchesLocale(documentLanguage, locale) {
  const expected = normalizeFlowLocale(locale);
  const actual = String(documentLanguage || "").trim().toLowerCase().split(/[-_]/, 1)[0];
  return Boolean(expected && actual === expected);
}

export function flowProjectUrl(projectId, locale = "en") {
  const language = normalizeFlowLocale(locale);
  if (!language) throw new Error("Flow automation language must be en.");
  const url = new URL(`https://flow.google.com/project/${projectId}`);
  url.searchParams.set("hl", "en");
  return url.href;
}

export function forceEnglishFlowUrl(value) {
  const url = new URL(value);
  if (url.origin !== "https://flow.google.com") throw new Error("Expected a Flow URL.");
  url.searchParams.set("hl", "en");
  return url.href;
}
