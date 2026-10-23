import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHATGPT_GENERATION_OPERATION,
  LocalCore,
  chatGptGenerationQueueJob,
  extensionJobAsLegacy,
  jobView,
  materializeQueueJob,
  projectDir,
} from '../dist/core.js';
import { createFlowMcpServer } from '../dist/mcp-tools.js';
import { sanitizeFlowOperationDiagnostics, sanitizeUnknownSubmitDiagnostics } from '../dist/flow-request-diagnostics.js';

// GPT-11: the legacy job view gains a ChatGPT branch and chatgpt_generate
// enqueues through the generic queue path. The mapping composition under
// test is the exact one production uses: jobView(extensionJobAsLegacy(job)).

const CHAT_RESULT_URLS = ['https://cdn.example.test/chatgpt/file-1.png', 'https://cdn.example.test/chatgpt/file-2.png'];

function literalChatGptJob(overrides = {}) {
  return {
    id: 'job-chatgpt-1',
    operation: 'chatgpt.generation.submit',
    payload: { prompt: 'a cat wearing a hat', ratio: '16:9', model: 'gpt-image-1' },
    metadata: {
      provider: 'chatgpt', source: 'mcp',
      output_dir: '/films/ChatArt', file_stem: 'chatgpt-01',
      files: ['/films/ChatArt/chatgpt-01.png'],
    },
    status: 'completed',
    attempts: 1,
    // Poisoned credit fields: a ChatGPT job has no credit accounting, so
    // none of these may surface in the view — credits stay null, always.
    credits: 42,
    creditQuoteVerified: true,
    result: { result: { imageUrls: CHAT_RESULT_URLS, turnId: 'turn-1', credits: 99 } },
    ...overrides,
  };
}

test('a literal ChatGPT job maps to the legacy job view (status, files, prompt, null credits)', () => {
  const view = jobView(extensionJobAsLegacy(literalChatGptJob()));
  assert.equal(view.id, 'job-chatgpt-1');
  assert.equal(view.status, 'done');
  assert.equal(view.project, '/films/ChatArt');
  assert.equal(view.scene, 'chatgpt-01');
  assert.equal(view.prompt, 'a cat wearing a hat');
  assert.deepEqual(view.files, ['/films/ChatArt/chatgpt-01.png']);
  assert.equal(view.attempts, 1);
  assert.equal(view.credits, null);
  assert.equal(view.credit_quote_verified, false);
});

test('ChatGPT status mapping matches the Flow queue mapping', () => {
  const cases = { pending: 'queued', running: 'running', waiting_for_user: 'waiting_for_user', completed: 'done', failed: 'failed', cancelled: 'cancelled' };
  for (const [queueStatus, viewStatus] of Object.entries(cases)) {
    const view = jobView(extensionJobAsLegacy(literalChatGptJob({ status: queueStatus, metadata: { provider: 'chatgpt' } })));
    assert.equal(view.status, viewStatus, `queue status ${queueStatus}`);
    assert.equal(view.credits, null, `credits stay null for status ${queueStatus}`);
  }
});

test('ChatGPT diagnostics pass through with the same sanitizers as the Flow wiring', () => {
  const rawUnknown = {
    clickDelivered: true, observerReady: true, xhrHookActive: true, fetchHookActive: true,
    rawPrompt: 'private prompt contents',
    requestDiagnostics: { version: 1, count: 1, events: [{
      observedAt: '2026-10-21T03:35:36.000Z', attemptId: 'attempt-private', rpcId: 'rpc-private',
      mediaType: 'image', transport: 'fetch', path: '/api/private-image?token=<redacted>', payloadVersion: 2,
      payloadShape: 'image_request', pathClass: 'image', pathRecognized: true, payloadMatched: false,
      fields: { shape: true, prompt: true, model: false, quantity: true, referenceIds: false, project: true, 'raw-token': true },
      reasons: ['reference_ids_mismatch', 'raw-token'], rawUrl: 'https://example.test/?token=<redacted>',
    }] },
  };
  const rawOperation = {
    quoteDiagnostics: { candidateCount: 2, reasonCodes: ['unrecognized_credit_text', 'no_candidate', 'account_balance_1040'], rawCandidateText: 'Private nearby prompt and balance 1.040 credits', quote: 1040 },
    locale: 'vi', activeCategory: 'uploads', categoriesScanned: ['all', 'uploads', 'characters'], categorySelected: true,
    searchLabelRecognized: true, searchLabel: 'tìm kiếm nội dung nghe nhìn', searchResultsVerified: false,
    optionCount: 3, pages: 1, endReached: false, optionLabelHashes: ['h-1234abcd', 'malicious-label'],
    exactTargetFound: false, scrollOwnerCount: 1, scrollOwnerDepth: -1, scrollClientHeight: 100, scrollHeight: 360, scrollTop: 180,
    tileActionAttempted: true, tileActionStep: 'menu_missing', tileActionMenuObserved: false,
    errorCode: 'FLOW_REFERENCE_SCAN_INCOMPLETE', assetTitle: 'private asset title', query: 'private search query',
    imageUrl: 'https://example.test/private-image?token=<redacted>', content: 'private image bytes',
  };

  const chatUnknown = jobView(extensionJobAsLegacy(literalChatGptJob({ status: 'failed', outcomeUnknown: true, diagnostics: { requestDiagnostics: rawUnknown } })));
  const flowUnknown = jobView(extensionJobAsLegacy({
    id: 'job-flow-unknown', operation: 'flow.generation.submit',
    payload: { prompt: 'p', type: 'image' }, metadata: {}, status: 'failed', outcomeUnknown: true,
    diagnostics: { requestDiagnostics: rawUnknown },
  }));
  assert.deepEqual(chatUnknown.request_diagnostics, sanitizeUnknownSubmitDiagnostics(rawUnknown));
  assert.deepEqual(chatUnknown.request_diagnostics, flowUnknown.request_diagnostics);
  assert.equal(JSON.stringify(chatUnknown.request_diagnostics).includes('private prompt'), false);

  const chatOperation = jobView(extensionJobAsLegacy(literalChatGptJob({ status: 'failed', diagnostics: { operationDiagnostics: rawOperation } })));
  const flowOperation = jobView(extensionJobAsLegacy({
    id: 'job-flow-op', operation: 'flow.generation.submit',
    payload: { prompt: 'p', type: 'image' }, metadata: {}, status: 'failed',
    diagnostics: { operationDiagnostics: rawOperation },
  }));
  assert.deepEqual(chatOperation.operation_diagnostics, sanitizeFlowOperationDiagnostics(rawOperation));
  assert.deepEqual(chatOperation.operation_diagnostics, flowOperation.operation_diagnostics);
});

test('materialization turns a completed ChatGPT job imageUrls into files[]', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'chatgpt-materialize-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const fetched = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
  };
  try {
    const job = literalChatGptJob({
      metadata: { provider: 'chatgpt', source: 'mcp', output_dir: dir, file_stem: 'shot' },
    });
    delete job.credits;
    const materialized = await materializeQueueJob(job);
    const expected = [join(dir, 'shot-v1.png'), join(dir, 'shot-v2.png')];
    assert.deepEqual(fetched, CHAT_RESULT_URLS);
    assert.deepEqual(materialized.metadata.files, expected);
    assert.equal(materialized.metadata.downloadComplete, true);
    for (const file of expected) {
      assert.equal(existsSync(file), true);
      assert.deepEqual(readFileSync(file), png);
    }
    assert.deepEqual(jobView(extensionJobAsLegacy(materialized)).files, expected);

    // A second pass is a no-op: downloadComplete + files are already recorded.
    fetched.length = 0;
    const again = await materializeQueueJob(materialized);
    assert.deepEqual(fetched, []);
    assert.deepEqual(again.metadata.files, expected);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('materialization refuses an HTML payload instead of saving it as an image', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'chatgpt-materialize-html-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('<!doctype html><html><body>sign in</body></html>', {
    status: 200, headers: { 'content-type': 'text/html; charset=utf-8' },
  });
  try {
    const job = literalChatGptJob({
      metadata: { provider: 'chatgpt', source: 'mcp', output_dir: dir, file_stem: 'shot' },
      result: { result: { imageUrls: ['https://cdn.example.test/chatgpt/file-1.png'], turnId: 'turn-1' } },
    });
    const materialized = await materializeQueueJob(job);
    assert.equal(materialized.metadata.files, undefined);
    assert.match(materialized.metadata.downloadError, /HTML/);
    assert.equal(existsSync(join(dir, 'shot.png')), false);
    const view = jobView(extensionJobAsLegacy(materialized));
    assert.equal(view.error, materialized.metadata.downloadError);
    assert.equal(view.error_category, 'download');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('chatGptGenerationQueueJob builds the generic queue submission for the chatgpt operation', () => {
  const refs = [{ base64: 'QUJD', type: 'image/png', name: 'ref.png' }];
  const built = chatGptGenerationQueueJob({
    project: 'ChatArt', prompt: 'a cat wearing a hat', ratio: '16:9', model: 'gpt-image-1',
    conversation_id: 'conv-1', refs, timeout_ms: 60_000,
  });
  assert.equal(CHATGPT_GENERATION_OPERATION, 'chatgpt.generation.submit');
  assert.equal(built.operation, 'chatgpt.generation.submit');
  assert.deepEqual(built.payload, {
    prompt: 'a cat wearing a hat', ratio: '16:9', model: 'gpt-image-1',
    attachments: refs, conversationId: 'conv-1', timeoutMs: 60_000,
  });
  assert.deepEqual(built.metadata, {
    provider: 'chatgpt', source: 'mcp', output_dir: projectDir('ChatArt'), file_stem: 'chatgpt-01',
  });
  assert.match(built.label, /ChatGPT/);

  const minimal = chatGptGenerationQueueJob({ project: 'ChatArt', prompt: 'just a prompt' });
  assert.deepEqual(minimal.payload, { prompt: 'just a prompt' });
  assert.equal(minimal.metadata.file_stem, 'chatgpt-01');

  const stemmed = chatGptGenerationQueueJob({ project: 'ChatArt', prompt: 'p', file_stem: 'hero' });
  assert.equal(stemmed.metadata.file_stem, 'hero');
});

test('LocalCore.chatgpt_generate validates args, then routes through the extension queue bridge', async () => {
  const core = new LocalCore();
  await assert.rejects(core.chatgpt_generate({ project: '', prompt: 'x' }), /project/);
  await assert.rejects(core.chatgpt_generate({ project: 'P', prompt: '  ' }), /prompt/);
  // No extension is connected in the test environment: the generic queue
  // bridge is the only path, and it reports offline instead of the call
  // going anywhere else.
  await assert.rejects(core.chatgpt_generate({ project: 'P', prompt: 'a cat' }), /Flow extension is offline/);
});

test('chatgpt_generate MCP tool is registered and forwards to the Core method', async () => {
  const calls = [];
  const server = createFlowMcpServer({
    chatgpt_generate: async (args) => {
      calls.push(args);
      return { output_dir: '/films/ChatArt', jobs: [{ id: 'job-chatgpt-1', status: 'queued' }] };
    },
  });
  const tools = server._registeredTools;
  assert.ok(tools.chatgpt_generate);
  assert.equal(tools.chatgpt_generate.annotations.readOnlyHint, false);
  assert.equal(tools.chatgpt_generate.inputSchema.safeParse({ project: 'ChatArt', prompt: 'a cat' }).success, true);
  assert.equal(tools.chatgpt_generate.inputSchema.safeParse({ prompt: 'a cat' }).success, false);
  assert.equal(tools.chatgpt_generate.inputSchema.safeParse({ project: 'ChatArt' }).success, false);
  assert.equal(tools.chatgpt_generate.inputSchema.safeParse({ project: 'ChatArt', prompt: 'a cat', refs: [{ base64: 'QUJD', type: 'image/png' }] }).success, true);

  const reply = await tools.chatgpt_generate.handler({ project: 'ChatArt', prompt: 'a cat', ratio: '16:9' });
  assert.deepEqual(JSON.parse(reply.content[0].text), { output_dir: '/films/ChatArt', jobs: [{ id: 'job-chatgpt-1', status: 'queued' }] });
  assert.deepEqual(calls, [{ project: 'ChatArt', prompt: 'a cat', ratio: '16:9' }]);
});

test('chatgpt_generate MCP tool answers a clear error when the hosting core does not provide it', async () => {
  const server = createFlowMcpServer({});
  const reply = await server._registeredTools.chatgpt_generate.handler({ project: 'ChatArt', prompt: 'a cat' });
  assert.equal(reply.isError, true);
  assert.match(JSON.parse(reply.content[0].text).error, /chatgpt_generate/);
});

test('Flow job mapping is unchanged by the ChatGPT branch (pins)', () => {
  const flowJob = {
    id: 'job-flow-1', operation: 'flow.generation.submit',
    payload: { prompt: 'clip prompt', type: 'video', output_dir: '/films/Movie', file_stem: 'scene-01' },
    metadata: { files: ['/films/Movie/scene-01.mp4'] },
    status: 'completed', attempts: 2,
    result: { result: { credits: 20, creditQuoteVerified: true } },
  };
  const view = jobView(extensionJobAsLegacy(flowJob));
  assert.equal(view.status, 'done');
  assert.equal(view.credits, 20);
  assert.equal(view.credit_quote_verified, true);
  assert.deepEqual(view.files, ['/films/Movie/scene-01.mp4']);
  assert.equal(view.project, '/films/Movie');
  assert.equal(view.scene, 'scene-01');
  assert.equal(view.prompt, 'clip prompt');
  assert.equal(view.attempts, 2);
});
