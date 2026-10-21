const REVISION_PATTERN = /^[a-f0-9]{64}$/i;

export function decideDevExtensionReload({ revision, buildRevision, reloadKey: reportedReloadKey, previousRevision, activeOperations = 0 }) {
  if (typeof revision !== 'string' || !REVISION_PATTERN.test(revision)) return { action: 'invalid' };
  const reloadKey = typeof reportedReloadKey === 'string' && REVISION_PATTERN.test(reportedReloadKey)
    ? reportedReloadKey.toLowerCase()
    : revision.toLowerCase();
  if (!previousRevision) return { action: 'initialize', reloadKey };
  // Older workers stored only the file fingerprint. Migrate after that worker
  // has already reloaded for the build change instead of causing a second reload.
  if (typeof buildRevision === 'string' && REVISION_PATTERN.test(buildRevision) &&
      previousRevision.toLowerCase() === buildRevision.toLowerCase()) return { action: 'migrate', reloadKey };
  if (previousRevision === reloadKey) return { action: 'current', reloadKey };
  if (activeOperations > 0) return { action: 'wait', reloadKey };
  return { action: 'reload', reloadKey };
}
