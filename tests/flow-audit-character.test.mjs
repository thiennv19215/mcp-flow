import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertCharacterNameAvailable,
  buildCharacterSnapshot,
  compareCharacterCreateSnapshots,
  runCharacterCreateAudit,
} from '../scripts/audit-native-character.mjs';

const projectId = 'e4bf4bae-626d-4718-a66a-cbdb04c8e6fa';
const firstId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';

function snapshot(characters, result = characters.length ? 'complete' : 'confirmed_empty') {
  return {
    projectId,
    scanComplete: true,
    characters,
  };
}

const completeScan = (result, nameCount, stableUuidCount = nameCount, scanComplete = true) => ({
  result, nameCount, stableUuidCount, scanComplete,
});

test('character snapshot requires complete-scan metadata and stable UUIDs before mutation', () => {
  const status = { flow: { projectId, characterListDiagnostics: completeScan('confirmed_empty', 0) } };
  assert.deepEqual(buildCharacterSnapshot([], status), snapshot([]));

  assert.throws(() => buildCharacterSnapshot([{ name: 'Existing' }], {
    flow: { projectId, characterListDiagnostics: completeScan('complete', 1, 0) },
  }), /characters\[0\]\.uuid\|id/);
  assert.throws(() => buildCharacterSnapshot([{ id: firstId, name: 'Existing' }], {
    flow: { projectId, characterListDiagnostics: completeScan('scanning', 1) },
  }), /result=complete\|confirmed_empty/);
  assert.throws(() => buildCharacterSnapshot([{ id: firstId, name: 'Existing' }], {
    flow: { projectId, characterListDiagnostics: completeScan('complete', 0) },
  }), /nameCount matching characters.length/);
  assert.throws(() => buildCharacterSnapshot([], {
    flow: { projectId, characterListDiagnostics: completeScan('confirmed_empty', 0, 0, false) },
  }), /scanComplete=true/);
  assert.throws(() => buildCharacterSnapshot([
    { id: firstId, name: 'First' },
    { uuid: firstId, name: 'Duplicate identity' },
  ], {
    flow: { projectId, characterListDiagnostics: completeScan('complete', 2) },
  }), /duplicate UUIDs/);
});

test('character create refuses a requested name already in the complete baseline', () => {
  assert.throws(() => assertCharacterNameAvailable(snapshot([{ id: firstId, name: 'MCP Character' }]), ' mcp   character '), /already appears 1 time/);
  assert.doesNotThrow(() => assertCharacterNameAvailable(snapshot([{ id: firstId, name: 'Other' }]), 'MCP Character'));
});

test('character create delta requires one exact-name new UUID and preserves every baseline UUID', () => {
  const before = snapshot([{ id: firstId, name: 'Existing' }]);
  const after = snapshot([
    { id: firstId, name: 'Existing' },
    { id: secondId, name: 'Requested Character' },
  ]);
  assert.deepEqual(compareCharacterCreateSnapshots(before, after, 'Requested Character'), {
    confirmed: true,
    baseline_ids_preserved: true,
    baseline_count: 1,
    after_count: 2,
    new_uuid_count: 1,
    exact_requested_name_new_uuid_count: 1,
    missing_baseline_uuid_count: 0,
    changed_baseline_name_count: 0,
    new_character_id: secondId,
  });
});

test('character create delta rejects default-name saves, duplicates, and changed baseline identities', () => {
  const before = snapshot([{ id: firstId, name: 'Existing' }]);
  const defaultName = snapshot([{ id: firstId, name: 'Existing' }, { id: secondId, name: 'Untitled character' }]);
  assert.equal(compareCharacterCreateSnapshots(before, defaultName, 'Requested Character').confirmed, false);

  const duplicateNew = snapshot([
    { id: firstId, name: 'Existing' },
    { id: secondId, name: 'Requested Character' },
    { id: '33333333-3333-4333-8333-333333333333', name: 'Requested Character' },
  ]);
  assert.equal(compareCharacterCreateSnapshots(before, duplicateNew, 'Requested Character').confirmed, false);

  const baselineChanged = snapshot([{ id: firstId, name: 'Changed' }, { id: secondId, name: 'Requested Character' }]);
  assert.equal(compareCharacterCreateSnapshots(before, baselineChanged, 'Requested Character').baseline_ids_preserved, false);
  assert.equal(compareCharacterCreateSnapshots(before, baselineChanged, 'Requested Character').confirmed, false);
});

test('character create records postflight after an API error and never retries the create call', async () => {
  const before = snapshot([{ id: firstId, name: 'Existing' }]);
  const after = snapshot([{ id: firstId, name: 'Existing' }, { id: secondId, name: 'Untitled character' }]);
  let snapshots = 0;
  let creates = 0;
  await assert.rejects(runCharacterCreateAudit({
    requestedName: 'Requested Character',
    readSnapshot: async () => snapshots++ === 0 ? before : after,
    create: async () => { creates++; throw new Error('Flow did not confirm requested name'); },
  }), error => error.outcome_unknown === true && error.diagnostics?.new_uuid_count === 1 && /Do not retry/.test(error.message));
  assert.equal(snapshots, 2);
  assert.equal(creates, 1);
});

test('character create refuses incomplete or cross-project snapshots', () => {
  assert.throws(() => compareCharacterCreateSnapshots({ ...snapshot([]), scanComplete: false }, snapshot([{ id: secondId, name: 'Requested Character' }]), 'Requested Character'), /complete before\/after library scans/);
  assert.throws(() => compareCharacterCreateSnapshots(snapshot([]), { ...snapshot([{ id: secondId, name: 'Requested Character' }]), projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, 'Requested Character'), /different Flow projects/);
});
