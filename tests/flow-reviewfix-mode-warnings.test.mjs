import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Review round 3, item S3 — selecting Ingredients mode was optional with
// console-only warnings: a disabled/absent/unconfirmed mode control just
// console.warned and continued, so the user and the panel never saw that
// the video might not be in Ingredients mode (the fail-closed guard below
// — no "Add ingredients" button means FLOW_ASSET_PICKER_MISSING — still
// applies, so no wrong-mode video is produced; the gap is visibility).
//
// The fix adds an options.modeWarnings collector: the optional branches
// of selectAndConfirmMode push their warning into it (when present) in
// addition to console.warn, and prepareNativeVideoSettings passes a
// collector through the Ingredients call and includes it in the
// "completed" preparation diagnostics result — which the existing
// inspector (inspectVideoPreparationDiagnostics -> flowState
// videoSettingsDiagnostics.lastResult) already surfaces.
// ---------------------------------------------------------------------------

function loadVideoSettings() {
  const source = readFileSync(new URL('../extension/src/content/providers/flow/generation/video-settings.js', import.meta.url), 'utf8');
  const warnings = [];
  const context = vm.createContext({
    document: { querySelectorAll: () => [] },
    console: { warn: (message) => { warnings.push(String(message)); } },
    FlowSettings: {
      checkPreparation: () => {},
      waitPreparation: async () => {},
      foldLabel: (value) => String(value || '').trim().toLowerCase(),
      isNavControl: () => false,
    },
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
  });
  vm.runInContext(source, context);
  return { selectAndConfirmMode: context.FlowSettings.selectAndConfirmMode, consoleWarnings: warnings, source };
}

test('S3: an unconfirmed-optional Ingredients mode selection is collected into modeWarnings, not just the console', async () => {
  const { selectAndConfirmMode, consoleWarnings } = loadVideoSettings();
  // An empty stub document means exactModeControl finds nothing: the
  // "no explicit control" optional branch.
  const modeWarnings = [];
  await selectAndConfirmMode('Ingredients', false, { optional: true, modeWarnings });
  assert.equal(modeWarnings.length, 1, 'the optional branch must record its warning for the job diagnostics');
  assert.match(modeWarnings[0], /Ingredients/, 'the warning names the mode');
  assert.ok(consoleWarnings.length >= 1, 'the console warning is kept alongside the collector');
});

test('S3: prepareNativeVideoSettings wires the collector into the completed diagnostics result', () => {
  const { source } = loadVideoSettings();
  const prepareStart = source.indexOf('async function prepareNativeVideoSettings(');
  assert.notEqual(prepareStart, -1, 'prepareNativeVideoSettings must exist');
  const prepareBody = source.slice(prepareStart, source.indexOf('const FlowVideoActions', prepareStart));
  assert.match(prepareBody, /modeWarnings\s*=\s*\[\]/,
    'prepare must create a modeWarnings collector');
  assert.match(prepareBody, /selectAndConfirmMode\("Ingredients", false, \{[^}]*modeWarnings/,
    'prepare must pass the collector into the Ingredients mode call');
  assert.match(prepareBody, /modeWarnings\.length \? \{ modeWarnings \}/,
    'prepare must include non-empty modeWarnings in the completed diagnostics result');
});
