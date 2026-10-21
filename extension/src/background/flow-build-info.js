const REVISION_PATTERN = /^[a-f0-9]{64}$/i;

function normalizeRevision(value) {
  return typeof value === 'string' && REVISION_PATTERN.test(value) ? value.toLowerCase() : null;
}

export async function inspectExtensionBuild(tabId, {
  scripting = globalThis.chrome?.scripting,
  backgroundRevision = globalThis.__flowMcpExtensionBuildRevision,
  fetchImpl = globalThis.fetch,
} = {}) {
  const background = normalizeRevision(backgroundRevision);
  let content = null;
  let watcher = null;

  if (Number.isInteger(tabId) && tabId >= 0 && scripting?.executeScript) {
    try {
      const result = await scripting.executeScript({
        target: { tabId },
        world: 'ISOLATED',
        func: () => globalThis.__flowMcpExtensionBuildRevision || null,
      });
      content = normalizeRevision(result?.[0]?.result);
    } catch {}
  }

  if (typeof fetchImpl === 'function') {
    try {
      const response = await fetchImpl('http://127.0.0.1:18898/status', {
        cache: 'no-store',
        signal: AbortSignal.timeout(1500),
      });
      if (response.ok) {
        const status = await response.json();
        watcher = normalizeRevision(status?.buildRevision) || normalizeRevision(status?.revision);
      }
    } catch {}
  }

  const revisions = [background, content, watcher];
  const matchesWatcher = revisions.every(value => value !== null) && revisions.every(value => value === watcher);
  return {
    status: matchesWatcher ? 'current' : revisions.every(value => value !== null) ? 'mismatch' : 'unavailable',
    matchesWatcher,
    backgroundRevision: background,
    contentRevision: content,
    watcherRevision: watcher,
  };
}
