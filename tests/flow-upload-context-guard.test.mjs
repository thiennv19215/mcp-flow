import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { flowComponentsSource } from './helpers/flow-components-source.mjs';

// IMG-09 (part 1) — the upload confirmation wait re-evaluates its context
// guard on EVERY poll iteration. The project/route guards used to be
// evaluated only when the operation started: if the user navigated to a
// different project mid-confirmation, the poll kept scanning the NEW
// project's grid — it could confirm a same-name tile from the wrong
// project, or burn the whole deadline and report a misleading timeout.
// The wait now captures the project id (and route scope) at start and
// aborts promptly with FLOW_UPLOAD_CONTEXT_CHANGED when they change.
// The same per-iteration pass generalizes the abort-signal check that
// IMG-05b added for the extension step only: an aborted signal anywhere
// in the wait exits promptly through the standard timeout path.
//
// The harness drives the wait with a fake clock and a mutable fake
// location: Date.now() reads the fake time, the poll wait advances it,
// and the route (project id in the pathname) can flip mid-wait.

const PROJECT_A = '11111111-1111-4111-8111-111111111111';
const PROJECT_B = '22222222-2222-4222-8222-222222222222';

function guardHarness({ readyAt = Infinity, switchAt = null, switchTo = PROJECT_B, abortAt = null } = {}) {
  let now = 1_000_000;
  const startedAt = now;
  class FakeDate extends Date {
    static now() { return now; }
  }
  let currentProject = PROJECT_A;
  const controller = new AbortController();
  const location = {
    get pathname() { return currentProject ? `/project/${currentProject}/` : '/'; },
    get href() { return `https://flow.google.com${currentProject ? `/project/${currentProject}/` : '/'}`; },
  };
  const ownerId = 'media-owner-1';
  const name = 'guarded-upload.png';
  const image = { getAttribute: attribute => (attribute === 'alt' ? name : null) };
  const tile = {
    get ready() { return now >= readyAt; },
    getAttribute: attribute => (attribute === 'aria-label' ? name : null),
    get innerText() { return name; },
    get textContent() { return name; },
    querySelector(selector) {
      if (selector === 'flow-error-tile') return null;
      if (selector === 'flow-scene-tile') return null;
      if (selector === 'flow-video-tile,video') return null;
      if (selector === 'flow-image-tile,img') return image;
      if (selector.includes('img')) return image;
      return null;
    },
  };
  const context = vm.createContext({
    Date: FakeDate,
    AbortController,
    location,
    document: {
      visibilityState: 'visible',
      querySelector: () => null,
      querySelectorAll: selector => (selector === 'flow-grid-tile-container' ? [tile] : []),
    },
    FlowTiles: { isTileMediaReady: candidate => candidate.ready === true },
    mediaId: () => ownerId,
    visible: () => true,
    wait: async ms => {
      now += Number(ms) || 0;
      if (switchAt !== null && now >= switchAt) currentProject = switchTo;
      if (abortAt !== null && now >= abortAt && !controller.signal.aborted) controller.abort();
    },
    emitFlowProgress: () => {},
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
    FlowMediaMenu: {
      scanNativeAssets: async options => {
        const baseline = new Set((options?.baselineIds || []).map(String));
        return [{
          id: ownerId,
          name,
          kind: 'image',
          ready: now >= readyAt,
          busy: now < readyAt,
          error: false,
          newSinceBaseline: !baseline.has(ownerId),
        }];
      },
    },
  });
  vm.runInContext(flowComponentsSource, context);
  return {
    waitForTile: context.FlowUploader.waitForNativeMediaTile,
    signal: controller.signal,
    startedAt,
    elapsed: () => now - startedAt,
  };
}

test('IMG-09: a project switch mid-confirmation aborts promptly with a context-changed error', async () => {
  // The route flips to project B at 2 s. The grid now shows project B's
  // same-name tile, which becomes ready at 5 s: the old wait confirmed
  // that wrong-project tile. The guarded wait must refuse it, promptly.
  const harness = guardHarness({ readyAt: 1_000_000 + 5_000, switchAt: 1_000_000 + 2_000 });
  let caught;
  try {
    await harness.waitForTile('guarded-upload.png', {}, 'image', {
      deadline: harness.startedAt + 90_000,
      baselineIds: [],
      requireNewOwner: true,
      selectionDiagnostics: {},
    });
  } catch (error) { caught = error; }
  assert.ok(caught, 'confirmation must not confirm a tile from the other project');
  assert.equal(caught.code, 'FLOW_UPLOAD_CONTEXT_CHANGED', String(caught?.stack || caught));
  assert.equal(caught.retryable, false, 'a context change is not retryable into the wrong project');
  assert.equal(caught.outcome_unknown, true, 'the upload may have landed in the original project');
  assert.equal(caught.diagnostics?.contextChanged, true);
  assert.equal(caught.diagnostics?.expectedProjectId, PROJECT_A);
  assert.equal(caught.diagnostics?.currentProjectId, PROJECT_B);
  assert.ok(harness.elapsed() < 10_000, `the abort was prompt, not a deadline burn (elapsed ${harness.elapsed()} ms)`);
});

test('IMG-09: leaving the project route mid-confirmation also aborts with the context-changed error', async () => {
  const harness = guardHarness({ readyAt: Infinity, switchAt: 1_000_000 + 2_000, switchTo: null });
  let caught;
  try {
    await harness.waitForTile('guarded-upload.png', {}, 'image', {
      deadline: harness.startedAt + 90_000,
      baselineIds: [],
      requireNewOwner: true,
      selectionDiagnostics: {},
    });
  } catch (error) { caught = error; }
  assert.ok(caught, 'confirmation must fail when the user leaves the project');
  assert.equal(caught.code, 'FLOW_UPLOAD_CONTEXT_CHANGED', String(caught?.stack || caught));
  assert.equal(caught.diagnostics?.expectedProjectId, PROJECT_A);
  assert.equal(caught.diagnostics?.currentProjectId, null);
  assert.ok(harness.elapsed() < 10_000, `the abort was prompt (elapsed ${harness.elapsed()} ms)`);
});

test('IMG-09 control: a stable context confirms exactly as before', async () => {
  const harness = guardHarness({ readyAt: 1_000_000 + 2_000 });
  const result = await harness.waitForTile('guarded-upload.png', {}, 'image', {
    deadline: harness.startedAt + 90_000,
    baselineIds: [],
    requireNewOwner: true,
    selectionDiagnostics: {},
  });
  assert.equal(result.id, 'media-owner-1');
  assert.equal(result.kind, 'image');
  assert.ok(harness.elapsed() < 10_000, `confirmation finished when the tile became ready (elapsed ${harness.elapsed()} ms)`);
});

test('IMG-09: an abort signal mid-wait exits promptly even outside the extension window', async () => {
  // Explicit caller deadline (an absolute cap, so no deadline extension
  // is armed) and a tile that never becomes ready. The caller aborts at
  // 5 s: before IMG-09 the signal was only consulted inside the IMG-05b
  // extension step, so the wait burned the full 90 s budget.
  const harness = guardHarness({ readyAt: Infinity, abortAt: 1_000_000 + 5_000 });
  let caught;
  try {
    await harness.waitForTile('guarded-upload.png', {}, 'image', {
      deadline: harness.startedAt + 90_000,
      baselineIds: [],
      requireNewOwner: true,
      selectionDiagnostics: {},
      signal: harness.signal,
    });
  } catch (error) { caught = error; }
  assert.ok(caught, 'confirmation must fail once the caller aborts');
  assert.equal(caught.code, 'FLOW_UPLOAD_TIMEOUT', String(caught?.stack || caught));
  assert.ok(harness.elapsed() >= 4_000, `the wait ran until the abort (elapsed ${harness.elapsed()} ms)`);
  assert.ok(harness.elapsed() < 15_000, `the wait stopped at the abort instead of burning the 90 s budget (elapsed ${harness.elapsed()} ms)`);
});
