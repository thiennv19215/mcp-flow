import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { FlowJobQueue } from '../extension/src/background/flow-job-queue.js';
import { FlowMediaCatalog } from '../extension/src/background/flow-media-catalog.js';
import { revalidateJobReferences } from '../extension/src/background/flow-ref-preflight.js';

// IMG-04 follow-up (Phase 2 opener): the queue-level ref pass existed since
// IMG-04 — FlowJobQueue accepts a `refPreflight` option and
// revalidateJobReferences implements the contract — but service-worker.js
// never passed the option, so in production the pass only ran at the
// content stage inside flow.generation.submit. This suite pins the worker
// wiring: the queue the worker constructs receives a refPreflight whose
// catalog leg resolves against the worker's own FlowMediaCatalog instance
// (the project comes from the job's pinned flow target metadata, exactly
// where the runner reads it). Existence/recovery legs stay conservative
// in the worker — see the implementation comments in service-worker.js.

const serviceWorkerSource = readFileSync(new URL('../extension/src/background/service-worker.js', import.meta.url), 'utf8');

const PROJECT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROJECT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MEDIA_ID = '123e4567-e89b-12d3-a456-426614174000';

function memoryStorage() {
  const data = {};
  return {
    data,
    async get(key) { return { [key]: data[key] }; },
    async set(entries) { Object.assign(data, entries); },
    async remove(key) { delete data[key]; },
  };
}

// Extract one top-level function from the service-worker source and return
// its source text. Brace matching is safe for the two wiring helpers: they
// are written without regex literals or braces inside string literals.
function extractFunctionSource(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `service-worker.js must define ${marker}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Unbalanced function source for ${marker}`);
}

// Load the worker's actual wiring helpers (queueJobProjectId +
// createQueueRefPreflight) into a vm sandbox whose free variables are the
// test doubles for the worker environment, plus the REAL
// revalidateJobReferences module function — so the pass under test is the
// worker's own code, not a copy.
function loadWorkerWiring({ tabs = new Map(), selectedTabId = undefined } = {}) {
  const sandbox = {
    revalidateJobReferences,
    // Contract stubs for two worker helpers whose behavior is not what
    // this suite exercises (both are pinned by their own suites): the
    // project-id URL parser and the Flow-URL predicate.
    flowProjectIdFromUrl: value => {
      try { return new URL(value).pathname.match(/\/project\/([0-9a-f-]{36})(?:\/|$)/i)?.[1]?.toLowerCase() || null; }
      catch { return null; }
    },
    flowUrl: value => {
      try { return new URL(value).hostname === 'flow.google.com'; } catch { return false; }
    },
    chrome: {
      tabs: {
        get: async tabId => {
          const tab = tabs.get(tabId);
          if (!tab) throw new Error(`No tab with id: ${tabId}`);
          return tab;
        },
      },
    },
    selectedTabId,
  };
  const code = [
    extractFunctionSource(serviceWorkerSource, 'async function queueJobProjectId('),
    extractFunctionSource(serviceWorkerSource, 'function createQueueRefPreflight('),
    'this.__wiring = { queueJobProjectId, createQueueRefPreflight };',
  ].join('\n');
  vm.runInNewContext(code, sandbox);
  return sandbox.__wiring;
}

function spyCatalog(realCatalog, order) {
  const lookups = [];
  return {
    lookups,
    catalog: {
      lookup: async query => {
        const entry = await realCatalog.lookup(query);
        lookups.push({ query, entry });
        order?.push('catalog');
        return entry;
      },
    },
  };
}

async function recordedCatalog() {
  const catalog = new FlowMediaCatalog({ storage: memoryStorage() });
  const recorded = await catalog.record({
    projectId: PROJECT,
    mediaId: MEDIA_ID,
    name: 'Beach.png',
    originalName: 'Beach.png',
    uploadName: 'beach-content-name.png',
    kind: 'image',
  });
  assert.ok(recorded, 'the catalog records the uploaded asset');
  return catalog;
}

test('IMG-04 wiring: service-worker.js imports the ref preflight and passes it to the queue', () => {
  assert.match(serviceWorkerSource, /import \{ revalidateJobReferences \} from "\.\/flow-ref-preflight\.js";/,
    'the worker imports revalidateJobReferences');
  const constructionStart = serviceWorkerSource.indexOf('new FlowJobQueue(runExtensionFlowJob, {');
  assert.ok(constructionStart >= 0, 'the worker constructs the production queue');
  const construction = serviceWorkerSource.slice(constructionStart, serviceWorkerSource.indexOf('});', constructionStart));
  assert.match(construction, /refPreflight:/, 'the queue construction passes a refPreflight option');
  assert.match(construction, /createQueueRefPreflight\(/, 'the option is built by the wiring factory');
  assert.match(construction, /flowMediaCatalog/, 'the factory receives the worker-owned media catalog');
});

test('IMG-04 wiring: the queue-level catalog lookup resolves against the worker media catalog before the runner runs', async () => {
  const realCatalog = await recordedCatalog();
  const order = [];
  const { catalog, lookups } = spyCatalog(realCatalog, order);
  const { queueJobProjectId, createQueueRefPreflight } = loadWorkerWiring();
  const refPreflight = createQueueRefPreflight({ catalog, projectIdForJob: queueJobProjectId });

  let runnerPayload = null;
  const queue = new FlowJobQueue(async job => {
    order.push('runner');
    runnerPayload = job.payload;
    return { completed: true };
  }, { storage: memoryStorage(), minDelayMs: 0, maxDelayMs: 0, refPreflight });

  const added = await queue.add({
    operation: 'flow.generation.submit',
    payload: { type: 'image', prompt: 'a still', attachments: [{ assetName: 'Beach.png', expectedId: MEDIA_ID, kind: 'image' }] },
    label: 'wired ref job',
    metadata: { flowProjectId: PROJECT },
  });
  await queue.start();
  const { job } = await queue.wait(added.id, 5_000);
  assert.equal(job.status, 'completed', 'the job runs to completion with the wired pass in place');
  assert.deepEqual(order, ['catalog', 'runner'], 'the catalog leg of the pass runs before the runner');
  assert.equal(lookups.length, 1, 'exactly one catalog lookup for the single reference');
  assert.equal(lookups[0].query.projectId, PROJECT, 'the lookup is scoped to the job target project from its metadata');
  assert.equal(lookups[0].query.mediaId, MEDIA_ID, 'the lookup keys on the attachment expectedId like the content pass');
  assert.equal(lookups[0].query.name, 'Beach.png', 'the lookup carries the asset name like the content pass');
  assert.equal(lookups[0].entry?.mediaId, MEDIA_ID, 'the lookup resolved the recorded entry from the real catalog');
  assert.equal(lookups[0].entry?.uploadName, 'beach-content-name.png', 'the resolved entry carries its upload provenance');
  assert.equal(runnerPayload.attachments[0].expectedId, MEDIA_ID, 'the runner receives the validated payload');
});

test('IMG-04 wiring: the project falls back to the pinned tab URL when the job metadata has none', async () => {
  const realCatalog = await recordedCatalog();
  const { catalog, lookups } = spyCatalog(realCatalog);
  const tabs = new Map([[7, { id: 7, url: `https://flow.google.com/project/${PROJECT}/scene/xyz` }]]);
  const { queueJobProjectId, createQueueRefPreflight } = loadWorkerWiring({ tabs });
  const refPreflight = createQueueRefPreflight({ catalog, projectIdForJob: queueJobProjectId });

  const { job: validated } = await refPreflight({
    operation: 'flow.generation.submit',
    payload: { type: 'image', prompt: 'a still', attachments: [{ assetName: 'Beach.png', expectedId: MEDIA_ID }] },
    metadata: { flowTabId: 7 },
  });
  assert.equal(lookups.length, 1, 'the catalog is consulted once');
  assert.equal(lookups[0].query.projectId, PROJECT, 'the project was parsed from the pinned tab URL');
  assert.equal(validated.payload.attachments[0].expectedId, MEDIA_ID, 'the validated job passes through');
});

test('IMG-04 wiring: with no resolvable project the catalog is not consulted and the job passes through', async () => {
  const realCatalog = await recordedCatalog();
  const { catalog, lookups } = spyCatalog(realCatalog);
  const { queueJobProjectId, createQueueRefPreflight } = loadWorkerWiring();
  const refPreflight = createQueueRefPreflight({ catalog, projectIdForJob: queueJobProjectId });

  const { job: validated, reuploaded } = await refPreflight({
    operation: 'flow.generation.submit',
    payload: { type: 'image', prompt: 'a still', attachments: [{ assetName: 'Beach.png', expectedId: MEDIA_ID }] },
    metadata: {},
  });
  assert.equal(lookups.length, 0, 'no project means no catalog lookup — the content-stage pass stays the authority');
  assert.deepEqual(reuploaded, [], 'nothing is rewritten from the worker');
  assert.equal(validated.payload.attachments[0].expectedId, MEDIA_ID, 'the job is untouched');
});

test('IMG-04 wiring: a project mismatch does not resolve another project catalog entry', async () => {
  const realCatalog = await recordedCatalog();
  const { catalog, lookups } = spyCatalog(realCatalog);
  const { queueJobProjectId, createQueueRefPreflight } = loadWorkerWiring();
  const refPreflight = createQueueRefPreflight({ catalog, projectIdForJob: queueJobProjectId });

  await refPreflight({
    operation: 'flow.generation.submit',
    payload: { type: 'image', prompt: 'a still', attachments: [{ assetName: 'Beach.png', expectedId: MEDIA_ID }] },
    metadata: { flowProjectId: PROJECT_B },
  });
  assert.equal(lookups.length, 1, 'the catalog is consulted for the job project');
  assert.equal(lookups[0].query.projectId, PROJECT_B, 'the lookup is scoped to the job project, not the recorded one');
  assert.equal(lookups[0].entry, null, 'the per-project catalog does not leak entries across projects');
});
