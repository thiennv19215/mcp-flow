import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { JobQueue } from '../dist/queue.js';
import { jobView } from '../dist/core.js';

test('definite pre-dispatch operation diagnostics persist in queue receipts with only safe fields', async () => {
  const scope = `reference-diagnostics-${randomUUID()}`;
  const queue = new JobQueue(async () => {
    throw Object.assign(new Error('Picker could not prove a complete scan.'), {
      code: 'FLOW_REFERENCE_SCAN_INCOMPLETE', retryable: true, outcome_unknown: false,
      diagnostics: {
        quoteDiagnostics: {
          candidateCount: 2,
          reasonCodes: ['unrecognized_credit_text', 'no_candidate', 'account_balance_1040'],
          rawCandidateText: 'Private nearby prompt and balance 1.040 credits',
          quote: 1040,
        },
        locale: 'vi', activeCategory: 'uploads', categoriesScanned: ['all', 'uploads', 'characters'], categorySelected: true, searchLabelRecognized: true, searchLabel: 'tìm kiếm nội dung nghe nhìn',
        searchResultsVerified: false, optionCount: 3, pages: 1, endReached: false,
        optionLabelHashes: ['h-1234abcd', 'malicious-label'], exactTargetFound: false,
        scrollOwnerCount: 1, scrollOwnerDepth: -1, scrollClientHeight: 100, scrollHeight: 360, scrollTop: 180,
        tileActionAttempted: true, tileActionStep: 'menu_missing', tileActionMenuObserved: false,
        errorCode: 'FLOW_REFERENCE_SCAN_INCOMPLETE', assetTitle: 'private asset title', query: 'private search query',
        imageUrl: 'https://example.test/private-image?token=secret', content: 'private image bytes',
      },
    });
  }, scope);
  queue.add({ prompt: 'private prompt', type: 'image', max_credits: 0, retries: 0, output_dir: 'private-project', file_stem: 'private-scene' });
  for (let wait = 0; wait < 100 && ['queued', 'running'].includes(queue.list()[0]?.status); wait++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }

  const job = queue.list()[0];
  assert.equal(job.status, 'failed');
  assert.equal(job.outcomeUnknown, false);
  assert.equal(job.operationDiagnostics?.locale, 'vi');
  assert.equal(job.operationDiagnostics?.pages, 1);
  assert.equal(job.operationDiagnostics?.activeCategory, 'uploads');
  assert.deepEqual(job.operationDiagnostics?.categoriesScanned, ['all', 'uploads']);
  assert.deepEqual(job.operationDiagnostics?.optionLabelHashes, ['h-1234abcd']);
  assert.equal(job.operationDiagnostics?.scrollOwnerDepth, -1);
  assert.equal(job.operationDiagnostics?.scrollTop, 180);
  assert.equal(job.operationDiagnostics?.tileActionAttempted, true);
  assert.equal(job.operationDiagnostics?.tileActionStep, 'menu_missing');
  assert.equal(job.operationDiagnostics?.tileActionMenuObserved, false);
  assert.equal(job.operationDiagnostics?.optionCount, 3);
  assert.equal(job.operationDiagnostics?.endReached, false);
  assert.equal(job.operationDiagnostics?.searchLabelRecognized, true);
  assert.equal(job.operationDiagnostics?.searchResultsVerified, false);
  assert.equal(job.operationDiagnostics?.errorCode, 'FLOW_REFERENCE_SCAN_INCOMPLETE');
  assert.deepEqual(job.operationDiagnostics?.quoteDiagnostics, {
    candidateCount: 2,
    reasonCodes: ['unrecognized_credit_text', 'no_candidate'],
  });

  const restored = new JobQueue(async () => [], scope).get(job.id);
  assert.ok(restored);
  const view = jobView(restored);
  assert.deepEqual(view.operation_diagnostics, {
    locale: 'vi', activeCategory: 'uploads', categoriesScanned: ['all', 'uploads'], categorySelected: true,
    searchLabelRecognized: true, searchLabel: 'tìm kiếm nội dung nghe nhìn',
    searchResultsVerified: false, optionCount: 3, pages: 1, endReached: false,
    optionLabelHashes: ['h-1234abcd'], exactTargetFound: false,
    scrollOwnerCount: 1, scrollOwnerDepth: -1, scrollClientHeight: 100, scrollHeight: 360, scrollTop: 180,
    tileActionAttempted: true, tileActionStep: 'menu_missing', tileActionMenuObserved: false,
    errorCode: 'FLOW_REFERENCE_SCAN_INCOMPLETE',
    quoteDiagnostics: { candidateCount: 2, reasonCodes: ['unrecognized_credit_text', 'no_candidate'] },
  });
  const serialized = JSON.stringify(view.operation_diagnostics);
  assert.doesNotMatch(serialized, /private asset title|private search query|private-image|token=secret|private image bytes|private prompt|private-project|private-scene|rawCandidateText|account_balance|1040/);
});
