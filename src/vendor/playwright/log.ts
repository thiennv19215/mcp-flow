// Local logging adapter for the vendored Playwright relay.
export function logUnhandledError(error: unknown): void { console.error("[Flow extension relay]", error); }
