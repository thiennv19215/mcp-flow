import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Audit cluster E — slug and filename-stem unification:
//
// - characterSlug (backend, src/characters.ts) must agree exactly with
//   slugifySelectionName (extension, selection-normalize.js — the
//   source of truth). They used to differ by one call: toLowerCase()
//   vs toLocaleLowerCase(), which diverge under tr/az ambient locales.
//   (This environment cannot force a tr ambient locale, so the test
//   pins agreement under the ambient locale; agreement under every
//   ambient locale follows by construction — both now call the same
//   method in the same order.)
// - safeQueueFilenameStem (queue downloads) must be exactly the plan
//   module's safety pass over the basename — it used to duplicate the
//   pass WITHOUT the 120-char cap, so a queue-derived stem over 120
//   chars could never match its capped planned stem.
// ---------------------------------------------------------------------------

function extensionSlugify() {
  const source = readFileSync(new URL('../extension/src/content/shared/selection-normalize.js', import.meta.url), 'utf8');
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context);
  return context.FlowSelectionNormalize.slugifySelectionName;
}

test('slug: backend characterSlug agrees with extension slugifySelectionName', async () => {
  const { characterSlug } = await import('../dist/characters.js');
  const slugify = extensionSlugify();
  const names = [
    'Anh Hùng',
    'Đỗ Thị  Lan',
    'Nguyễn Văn A!',
    '  padded   name  ',
    'Hello, World?',
    'Istanbul',
    'Æsop & Björk',
    'a--b__c',
    '---',
    '',
  ];
  for (const name of names) {
    assert.equal(characterSlug(name), slugify(name), `slug disagreement for ${JSON.stringify(name)}`);
  }
  assert.equal(characterSlug('Anh Hùng'), 'anh-hung');
});

test('stem: queue stem equals plan stem over the basename, capped at 120', async () => {
  const { safeQueueFilenameStem } = await import('../extension/src/background/flow-queue-downloads.js');
  const { sanitizePlanFilenameStem, FLOW_PLAN_STEM_MAX } = await import('../extension/src/background/flow-download-plan.js');
  assert.equal(FLOW_PLAN_STEM_MAX, 120);
  const long = `a`.repeat(200);
  assert.equal(safeQueueFilenameStem(long).length, 120, 'queue stem must now carry the 120 cap');
  assert.equal(safeQueueFilenameStem(long), sanitizePlanFilenameStem(long));
  assert.equal(safeQueueFilenameStem('folder/sub/name<bad>...'), sanitizePlanFilenameStem('name<bad>...'));
  assert.equal(safeQueueFilenameStem('CON'), '_CON');
  assert.equal(safeQueueFilenameStem('..'), '');
  assert.equal(safeQueueFilenameStem('normal name'), 'normal name');
});
