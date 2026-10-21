import test from 'node:test';
import assert from 'node:assert/strict';
import { JobQueue } from '../dist/queue.js';
import { jobView } from '../dist/core.js';
import { auditLatestJob } from '../scripts/audit-native-report.mjs';

test('unknown submit diagnostics survive queue, job view, and final audit evidence with secrets stripped', async () => {
  const queue = new JobQueue(async () => {
    throw Object.assign(new Error('Flow submit outcome is unknown.'), {
      outcome_unknown: true,
      diagnostics: {
        clickDelivered: true,
        observerReady: true,
        xhrHookActive: true,
        fetchHookActive: true,
        rawPrompt: 'private prompt contents',
        requestDiagnostics: { version: 1, count: 1, events: [{
          observedAt: '2026-10-21T03:35:36.000Z', attemptId: 'attempt-private', rpcId: 'rpc-private',
          mediaType: 'image', transport: 'fetch', path: '/api/private-image?token=raw-token', payloadVersion: 2,
          payloadShape: 'image_request', pathClass: 'image', pathRecognized: true, payloadMatched: false,
          fields: { shape: true, prompt: true, model: false, quantity: true, referenceIds: false, project: true,
            'raw-token': true, rawtoken: true, private_id: true },
          reasons: ['reference_ids_mismatch', 'raw-token', 'rawtoken', 'secret_prompt'], rawUrl: 'https://example.test/?token=raw-token',
        }] },
      },
    });
  }, 'test-audit-request-diagnostics');
  queue.persist = () => {};
  queue.add({ prompt: 'private prompt contents', type: 'image', max_credits: 0, submit_only: true, retries: 0, output_dir: 'private-project', file_stem: 'private-scene' });
  for (let wait = 0; wait < 100 && ['queued', 'running'].includes(queue.list()[0]?.status); wait++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }

  const job = queue.list()[0];
  assert.equal(job.status, 'failed');
  assert.equal(job.outcomeUnknown, true);
  assert.equal(job.requestDiagnostics?.requestDiagnostics.count, 1);
  const view = jobView(job);
  const report = {
    probes: [{ name: 'image-reference', status: 'outcome_unknown', request_diagnostics: view.request_diagnostics }],
    latest_job: auditLatestJob(view),
  };
  const serialized = JSON.stringify(report);
  assert.equal(report.latest_job.request_diagnostics.requestDiagnostics.events[0].payloadMatched, false);
  assert.equal(report.latest_job.request_diagnostics.requestDiagnostics.events[0].fields.prompt, true);
  assert.deepEqual(Object.keys(report.latest_job.request_diagnostics.requestDiagnostics.events[0].fields).sort(),
    ['model', 'project', 'prompt', 'quantity', 'referenceIds', 'shape'].sort());
  assert.deepEqual(report.latest_job.request_diagnostics.requestDiagnostics.events[0].reasons, ['reference_ids_mismatch']);
  assert.doesNotMatch(serialized, /private prompt|private-project|private-scene|attempt-private|rpc-private|asset-private|raw-token|rawtoken|secret_prompt|rawUrl|private-image/);
  assert.equal(Object.hasOwn(report.latest_job, 'id'), false);
  assert.equal(Object.hasOwn(report.latest_job, 'prompt'), false);
  assert.equal(Object.hasOwn(report.latest_job, 'project'), false);
});
