// Keep Flow's locale optional. Google Flow reads `hl` from the URL when set,
// and otherwise uses the account/browser language preference.
export const FLOW_LOCALES = Object.freeze(["en", "vi"]);

export function normalizeFlowLocale(value) {
  const locale = String(value || "").trim().replaceAll("_", "-").toLowerCase();
  return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(locale) ? locale : null;
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
  // An omitted or unavailable requested locale means Flow owns language
  // selection; do not reject a valid rendered locale in that case.
  return expected ? actual === expected.split("-", 1)[0] : Boolean(actual);
}

export function flowHomeUrl(locale) {
  const url = new URL("https://flow.google.com/");
  const language = normalizeFlowLocale(locale);
  if (locale != null && locale !== "" && !language) throw new Error("Flow language must be a valid locale tag such as en or vi.");
  if (language) url.searchParams.set("hl", language);
  return url.href;
}

export function flowProjectUrl(projectId, locale) {
  const language = normalizeFlowLocale(locale);
  if (locale != null && locale !== "" && !language) throw new Error("Flow language must be a valid locale tag such as en or vi.");
  const url = new URL(`https://flow.google.com/project/${projectId}`);
  if (language) url.searchParams.set("hl", language);
  return url.href;
}
