const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function missingFieldError(fields) {
  return new Error(`Character create E2E stopped before mutation; API snapshot is missing required field(s): ${fields.join(", ")}. No character was created.`);
}

export function buildCharacterSnapshot(characters, status, expectedProjectId) {
  const missing = [];
  const entries = Array.isArray(characters) ? characters : characters?.characters;
  const flow = status?.flow;
  const diagnostics = flow?.characterListDiagnostics;
  if (!Array.isArray(entries)) missing.push("characters array");
  if (!flow || typeof flow !== "object") missing.push("status.flow");
  if (typeof flow?.projectId !== "string" || !UUID_RE.test(flow.projectId)) missing.push("status.flow.projectId");
  if (!diagnostics || typeof diagnostics !== "object") missing.push("status.flow.characterListDiagnostics");
  if (!['complete', 'confirmed_empty'].includes(diagnostics?.result)) missing.push("status.flow.characterListDiagnostics.result=complete|confirmed_empty");
  if (diagnostics?.scanComplete !== true) missing.push("status.flow.characterListDiagnostics.scanComplete=true");
  if (!Number.isSafeInteger(diagnostics?.nameCount) || diagnostics.nameCount < 0) missing.push("status.flow.characterListDiagnostics.nameCount");
  if (!Number.isSafeInteger(diagnostics?.stableUuidCount) || diagnostics.stableUuidCount < 0) missing.push("status.flow.characterListDiagnostics.stableUuidCount");
  if (Array.isArray(entries) && Number.isSafeInteger(diagnostics?.nameCount) && diagnostics.nameCount !== entries.length) {
    missing.push("status.flow.characterListDiagnostics.nameCount matching characters.length");
  }
  if (missing.length) throw missingFieldError(missing);
  if (expectedProjectId && flow.projectId !== expectedProjectId) {
    throw new Error("Character create E2E stopped before mutation; project changed between the library snapshots. No character was created.");
  }

  const normalized = [];
  for (let index = 0; index < entries.length; index++) {
    const item = entries[index];
    if (!item || typeof item !== "object" || typeof item.name !== "string" || !item.name.trim()) {
      missing.push(`characters[${index}].name`);
      continue;
    }
    const id = item.uuid ?? item.id;
    if (typeof id !== "string" || !UUID_RE.test(id)) {
      missing.push(`characters[${index}].uuid|id (stable UUID)`);
      continue;
    }
    normalized.push({ id: id.toLowerCase(), name: item.name.trim() });
  }
  if (missing.length) throw missingFieldError(missing);
  if (diagnostics.stableUuidCount !== normalized.length) {
    throw missingFieldError(["status.flow.characterListDiagnostics.stableUuidCount matching characters.length"]);
  }
  const ids = normalized.map(item => item.id);
  if (new Set(ids).size !== ids.length) throw new Error("Character create E2E stopped before mutation; character snapshot contains duplicate UUIDs. No character was created.");
  if (diagnostics.nameCount !== normalized.length) throw missingFieldError(["complete character identity list matching nameCount"]);

  return {
    projectId: flow.projectId,
    scanComplete: true,
    characters: normalized,
  };
}

export function assertCharacterNameAvailable(snapshot, requestedName) {
  const wanted = String(requestedName || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
  if (!wanted) throw new Error("Character create E2E requires a non-empty requested name; no character was created.");
  const matches = snapshot.characters.filter(item => item.name.replace(/\s+/g, " ").trim().toLocaleLowerCase() === wanted);
  if (matches.length) throw new Error(`Character create E2E stopped before mutation; the requested name already appears ${matches.length} time(s) in the complete library. No character was created.`);
}

export function compareCharacterCreateSnapshots(before, after, requestedName) {
  if (!before?.scanComplete || !after?.scanComplete) throw new Error("Character create E2E could not prove complete before/after library scans; do not retry until checking Flow.");
  if (!before.projectId || before.projectId !== after.projectId) throw new Error("Character create E2E snapshots belong to different Flow projects; do not retry until checking Flow.");
  const beforeById = new Map(before.characters.map(item => [item.id, item]));
  const afterById = new Map(after.characters.map(item => [item.id, item]));
  const missingBaselineIds = [...beforeById.keys()].filter(id => !afterById.has(id));
  const changedBaselineIds = [...beforeById].filter(([id, item]) => afterById.has(id) && afterById.get(id).name !== item.name).map(([id]) => id);
  const newCharacters = after.characters.filter(item => !beforeById.has(item.id));
  const exactRequested = newCharacters.filter(item => item.name === String(requestedName || "").trim());
  const confirmed = missingBaselineIds.length === 0 && changedBaselineIds.length === 0 && newCharacters.length === 1 && exactRequested.length === 1;
  return {
    confirmed,
    baseline_ids_preserved: missingBaselineIds.length === 0 && changedBaselineIds.length === 0,
    baseline_count: before.characters.length,
    after_count: after.characters.length,
    new_uuid_count: newCharacters.length,
    exact_requested_name_new_uuid_count: exactRequested.length,
    missing_baseline_uuid_count: missingBaselineIds.length,
    changed_baseline_name_count: changedBaselineIds.length,
    new_character_id: confirmed ? exactRequested[0].id : null,
  };
}

export async function runCharacterCreateAudit({ requestedName, readSnapshot, create }) {
  const before = await readSnapshot();
  assertCharacterNameAvailable(before, requestedName);
  let created;
  let createError = null;
  try { created = await create(); }
  catch (error) { createError = String(error?.message || error); }

  let after;
  try { after = await readSnapshot(before.projectId); }
  catch (error) {
    throw Object.assign(new Error(`Character create API may have changed Flow, but the complete post-create library snapshot failed (${String(error?.message || error)}). Do not retry before checking Flow.`), {
      outcome_unknown: true,
      diagnostics: { baseline_count: before.characters.length, project_id_match_required: before.projectId },
    });
  }

  const delta = compareCharacterCreateSnapshots(before, after, requestedName);
  if (createError) {
    throw Object.assign(new Error(`Character create API returned an error after a possible side effect (${createError}); identity delta confirmed=${delta.confirmed}. Do not retry before checking Flow.`), {
      outcome_unknown: true,
      diagnostics: delta,
    });
  }
  if (!delta.confirmed) {
    throw Object.assign(new Error("Character create API returned, but the complete library snapshots did not confirm exactly one new UUID with the requested name while preserving all baseline UUIDs. Do not retry before checking Flow."), {
      outcome_unknown: true,
      diagnostics: delta,
    });
  }
  return { created, before, after, delta };
}
