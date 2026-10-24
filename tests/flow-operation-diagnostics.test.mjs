import test from 'node:test';
import assert from 'node:assert/strict';
import { jobView } from '../dist/core.js';
import { sanitizeFlowOperationDiagnostics } from '../dist/flow-request-diagnostics.js';

// The backend JobQueue that used to carry these diagnostics to jobView was
// removed (the extension queue owns jobs now); the sanitizers and jobView
// are the live path, so they are exercised directly.
test('definite pre-dispatch operation diagnostics persist with only safe fields', async () => {
  const rawDiagnostics = {
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
    imageUrl: 'https://example.test/private-image?token=<redacted>', content: 'private image bytes',
  };

  const stored = sanitizeFlowOperationDiagnostics(rawDiagnostics);
  assert.equal(stored?.locale, 'vi');
  assert.equal(stored?.pages, 1);
  assert.equal(stored?.activeCategory, 'uploads');
  assert.deepEqual(stored?.categoriesScanned, ['all', 'uploads']);
  assert.deepEqual(stored?.optionLabelHashes, ['h-1234abcd']);
  assert.equal(stored?.scrollOwnerDepth, -1);
  assert.equal(stored?.scrollTop, 180);
  assert.equal(stored?.tileActionAttempted, true);
  assert.equal(stored?.tileActionStep, 'menu_missing');
  assert.equal(stored?.tileActionMenuObserved, false);
  assert.equal(stored?.optionCount, 3);
  assert.equal(stored?.endReached, false);
  assert.equal(stored?.searchLabelRecognized, true);
  assert.equal(stored?.searchResultsVerified, false);
  assert.equal(stored?.errorCode, 'FLOW_REFERENCE_SCAN_INCOMPLETE');
  assert.deepEqual(stored?.quoteDiagnostics, {
    candidateCount: 2,
    reasonCodes: ['unrecognized_credit_text', 'no_candidate'],
  });

  const job = {
    id: 'job-diagnostics-1', status: 'failed',
    params: { output_dir: 'private-project', file_stem: 'private-scene', prompt: 'private prompt' },
    files: [], attempts: 1, outcomeUnknown: false, requestDispatched: false,
    operationDiagnostics: rawDiagnostics,
  };
  const view = jobView(job);
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
  assert.doesNotMatch(serialized, /private asset title|private search query|private-image|token=<redacted>|private image bytes|private prompt|private-project|private-scene|rawCandidateText|account_balance|1040/);
});
