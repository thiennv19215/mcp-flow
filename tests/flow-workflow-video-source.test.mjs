import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const workflowSource = readFileSync(new URL('../extension/src/content/providers/flow/workflows/workflow-operations.js', import.meta.url), 'utf8');

// Cluster A2, workflow paths (flow.edit.run / flow.continue.run /
// flow.frame.extract_last): resolving a video by title prefix must never
// silently pick a different video. Before this fix the scan filter took
// matches[0] whenever exactly one video began with the requested title,
// so editing "anh" would edit "anh 2". The resolution rule pinned here:
// an exact title always wins; several prefix matches without an exact one
// are returned so the caller can raise FLOW_AMBIGUOUS_ASSET; a single
// prefix-only match is refused outright.

function workflowHarness() {
  const context = vm.createContext({
    Date, Map, Promise, Set, Object, Math, String, Number, Boolean, Array, Error,
    setTimeout, clearTimeout,
    location: { href: 'https://flow.google.com/project/00000000-0000-4000-8000-000000000000' },
    wait: async () => {},
  });
  vm.runInContext(workflowSource, context);
  const ops = new context.FlowWorkflowOperations({
    error: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
  });
  return ops;
}

const video = name => ({ kind: 'video', name });
const image = name => ({ kind: 'image', name });

test('A2: an exact title wins even when prefix matches also exist', () => {
  const ops = workflowHarness();
  const { source, matches } = ops.resolveWorkflowVideoSource([video('anh 2'), video('anh')], 'anh');
  assert.equal(source.name, 'anh');
  assert.equal(matches.length, 2);
});

test('A2: a single prefix-only match is refused, not silently used', () => {
  const ops = workflowHarness();
  assert.throws(
    () => ops.resolveWorkflowVideoSource([video('anh 2')], 'anh'),
    error => error.code === 'FLOW_VIDEO_NOT_FOUND' && /exactly/.test(error.message),
  );
});

test('A2: several prefix matches without an exact one are returned unresolved', () => {
  const ops = workflowHarness();
  const { source, matches } = ops.resolveWorkflowVideoSource([video('anh 2'), video('anh 3')], 'anh');
  assert.equal(source, null);
  assert.equal(matches.length, 2);
  assert.equal(matches.map(m => m.name).join('|'), 'anh 2|anh 3');
});

test('A2: no match at all is unresolved, and non-video assets are ignored', () => {
  const ops = workflowHarness();
  // Field checks, not deepEqual: the result object lives in the vm
  // realm, so its prototype differs from this realm's Object.
  for (const assets of [[image('anh')], []]) {
    const resolved = ops.resolveWorkflowVideoSource(assets, 'anh');
    assert.equal(resolved.source, null);
    assert.equal(resolved.matches.length, 0);
  }
});

test('A2: exact matching is case-insensitive', () => {
  const ops = workflowHarness();
  const { source } = ops.resolveWorkflowVideoSource([video('Anh 2')], 'anh 2');
  assert.equal(source.name, 'Anh 2');
});
