import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// GPT-02 — ChatGPT submit payload builder.
// A pure builder from queue payload to content command: prompt, normalized
// ratio (GPT-01 semantics), model passthrough, fallback-prefix defaulting,
// refs carried through from GPT-03's resolution contract (never re-resolved),
// and timeout resolution where a missing/invalid timing config yields a
// typed config error instead of a hang (study behavior B4).

const source = readFileSync(
  new URL('../extension/src/content/providers/chatgpt/core/submit-payload.js', import.meta.url),
  'utf8',
);

// Values built inside the vm realm carry its prototypes; normalize through
// JSON before deep comparison (the repo's convention for vm-loaded modules).
const plain = value => JSON.parse(JSON.stringify(value));

function loadModule() {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox.ChatGptSubmitPayload;
}

const b64 = bytes => Buffer.from(bytes).toString('base64');

function refsResultFixture(overrides = {}) {
  return {
    refs: [
      { fileId: 'staged-1', base64: b64([1, 2, 3]), name: 'ref-1.png', type: 'image/png' },
    ],
    rejected: [{ index: 1, reason: 'bare_reference' }],
    capped: false,
    ...overrides,
  };
}

function timingError(err) {
  return err && err.code === 'CHATGPT_TIMING_CONFIG_INVALID';
}

test('image mode: full payload shape snapshot', () => {
  const { buildSubmitPayload } = loadModule();
  const command = plain(buildSubmitPayload(
    {
      prompt: 'a cat astronaut riding a bicycle',
      ratio: '16:9',
      model: 'GPT-4o',
      timeoutMs: 120000,
      conversationId: 'conv-123',
    },
    { refsResult: refsResultFixture() },
  ));
  assert.deepEqual(command, {
    operation: 'chatgpt.generation.submit',
    prompt: 'a cat astronaut riding a bicycle',
    ratio: 'widescreen',
    ratioSpelling: '16:9',
    model: 'GPT-4o',
    imageMode: true,
    fallbackPrefix: 'Generate an image of: ',
    refs: [
      { fileId: 'staged-1', base64: b64([1, 2, 3]), name: 'ref-1.png', type: 'image/png' },
    ],
    refRejections: [{ index: 1, reason: 'bare_reference' }],
    refsCapped: false,
    timeoutMs: 120000,
    conversationId: 'conv-123',
  });
});

test('minimal payload: defaults for ratio, model, refs, prefix, conversation', () => {
  const { buildSubmitPayload } = loadModule();
  const command = plain(buildSubmitPayload({ prompt: 'draw a house', timeoutMs: 60000 }));
  assert.deepEqual(command, {
    operation: 'chatgpt.generation.submit',
    prompt: 'draw a house',
    ratio: 'square',
    ratioSpelling: '1:1',
    model: null,
    imageMode: true,
    fallbackPrefix: 'Generate an image of: ',
    refs: [],
    refRejections: [],
    refsCapped: false,
    timeoutMs: 60000,
    conversationId: null,
  });
});

test('prompt is carried verbatim — the builder never prepends the fallback prefix', () => {
  const { buildSubmitPayload } = loadModule();
  const command = buildSubmitPayload({ prompt: '  a  lighthouse at dawn ', timeoutMs: 1000 });
  assert.equal(command.prompt, '  a  lighthouse at dawn ');
  assert.equal(command.fallbackPrefix, 'Generate an image of: ');
});

test('model is passthrough — unknown models are carried, not validated', () => {
  const { buildSubmitPayload } = loadModule();
  assert.equal(
    buildSubmitPayload({ prompt: 'x', model: 'totally-made-up-model', timeoutMs: 1000 }).model,
    'totally-made-up-model',
  );
  assert.equal(buildSubmitPayload({ prompt: 'x', timeoutMs: 1000 }).model, null);
  assert.equal(buildSubmitPayload({ prompt: 'x', model: '', timeoutMs: 1000 }).model, null);
});

// --- Timeout resolution (B4: invalid timing config fails fast, never hangs) ---

test('timeout: payload timeoutMs 0 is a typed config error', () => {
  const { buildSubmitPayload } = loadModule();
  assert.throws(() => buildSubmitPayload({ prompt: 'x', timeoutMs: 0 }), timingError);
});

test('timeout: payload timeoutMs NaN is a typed config error', () => {
  const { buildSubmitPayload } = loadModule();
  assert.throws(() => buildSubmitPayload({ prompt: 'x', timeoutMs: NaN }), timingError);
});

test('timeout: absent timeout with no config anywhere is a typed config error', () => {
  const { buildSubmitPayload } = loadModule();
  assert.throws(() => buildSubmitPayload({ prompt: 'x' }), timingError);
  assert.throws(() => buildSubmitPayload({}), timingError);
  assert.throws(() => buildSubmitPayload(null), timingError);
});

test('timeout: negative, non-number and infinite payload timeouts are typed config errors', () => {
  const { buildSubmitPayload } = loadModule();
  for (const bad of [-5, '120000', Infinity, -Infinity, {}, [], true]) {
    assert.throws(
      () => buildSubmitPayload({ prompt: 'x', timeoutMs: bad }),
      timingError,
      `timeoutMs=${String(bad)} must fail fast`,
    );
  }
});

test('timeout: an explicitly invalid payload timeout is fatal even when a valid config exists', () => {
  const { buildSubmitPayload } = loadModule();
  assert.throws(
    () => buildSubmitPayload({ prompt: 'x', timeoutMs: 0 }, { timing: { timeoutMs: 45000 } }),
    timingError,
  );
});

test('timeout: absent payload timeout resolves from the timing config', () => {
  const { buildSubmitPayload } = loadModule();
  assert.equal(
    buildSubmitPayload({ prompt: 'x' }, { timing: { timeoutMs: 45000 } }).timeoutMs,
    45000,
  );
  assert.equal(
    buildSubmitPayload({ prompt: 'x' }, { timeoutMs: 30000 }).timeoutMs,
    30000,
  );
});

test('timeout: invalid config timeout (with absent payload timeout) is a typed config error', () => {
  const { buildSubmitPayload } = loadModule();
  assert.throws(
    () => buildSubmitPayload({ prompt: 'x' }, { timing: { timeoutMs: 0 } }),
    timingError,
  );
  assert.throws(
    () => buildSubmitPayload({ prompt: 'x' }, { timing: { timeoutMs: NaN } }),
    timingError,
  );
});

test('timeout: range is (0, 1800000] and the resolved value is a whole number', () => {
  const { buildSubmitPayload } = loadModule();
  assert.equal(buildSubmitPayload({ prompt: 'x', timeoutMs: 1800000 }).timeoutMs, 1800000);
  assert.throws(() => buildSubmitPayload({ prompt: 'x', timeoutMs: 1800001 }), timingError);
  assert.equal(buildSubmitPayload({ prompt: 'x', timeoutMs: 1500.9 }).timeoutMs, 1500);
});

test('timeout: snake_case timeout_ms is accepted from payload and config', () => {
  const { buildSubmitPayload } = loadModule();
  assert.equal(buildSubmitPayload({ prompt: 'x', timeout_ms: 21000 }).timeoutMs, 21000);
  assert.equal(
    buildSubmitPayload({ prompt: 'x' }, { timing: { timeout_ms: 22000 } }).timeoutMs,
    22000,
  );
});

test('timeout: the typed error carries the shared error fields and diagnostics', () => {
  const { buildSubmitPayload } = loadModule();
  let caught = null;
  try {
    buildSubmitPayload({ prompt: 'x', timeoutMs: 0 });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, 'an error must be thrown');
  assert.equal(caught.code, 'CHATGPT_TIMING_CONFIG_INVALID');
  assert.equal(caught.retryable, false);
  assert.equal(caught.outcome_unknown, false);
  assert.equal(caught.noRetry, true);
  assert.equal(caught.diagnostics.field, 'timeoutMs');
});

// --- Ratio normalization (GPT-01 semantics) ---

test('ratio: canonical spellings normalize to the five semantic buckets', () => {
  const { buildSubmitPayload } = loadModule();
  const cases = {
    '16:9': ['widescreen', '16:9'],
    '9:16': ['story', '9:16'],
    '1:1': ['square', '1:1'],
    '4:3': ['landscape', '4:3'],
    '3:4': ['portrait', '3:4'],
  };
  for (const [input, [bucket, spelling]] of Object.entries(cases)) {
    const command = buildSubmitPayload({ prompt: 'x', ratio: input, timeoutMs: 1000 });
    assert.equal(command.ratio, bucket, `ratio ${input}`);
    assert.equal(command.ratioSpelling, spelling, `spelling ${input}`);
  }
});

test('ratio: separator variants and reducible spellings normalize', () => {
  const { buildSubmitPayload } = loadModule();
  assert.equal(buildSubmitPayload({ prompt: 'x', ratio: '16x9', timeoutMs: 1000 }).ratio, 'widescreen');
  assert.equal(buildSubmitPayload({ prompt: 'x', ratio: '16/9', timeoutMs: 1000 }).ratio, 'widescreen');
  const reduced = buildSubmitPayload({ prompt: 'x', ratio: '32:18', timeoutMs: 1000 });
  assert.equal(reduced.ratio, 'widescreen');
  assert.equal(reduced.ratioSpelling, '16:9');
});

test('ratio: an already-normalized semantic bucket is idempotent', () => {
  const { buildSubmitPayload } = loadModule();
  const first = buildSubmitPayload({ prompt: 'x', ratio: '16:9', timeoutMs: 1000 });
  assert.equal(first.ratio, 'widescreen');
  const second = buildSubmitPayload({ prompt: 'x', ratio: first.ratio, timeoutMs: 1000 });
  assert.equal(second.ratio, 'widescreen');
  assert.equal(second.ratioSpelling, '16:9');
  for (const bucket of ['widescreen', 'story', 'square', 'landscape', 'portrait']) {
    assert.equal(
      buildSubmitPayload({ prompt: 'x', ratio: bucket, timeoutMs: 1000 }).ratio,
      bucket,
      `bucket ${bucket} passes through unchanged`,
    );
  }
});

test('ratio: localized labels normalize like GPT-01', () => {
  const { buildSubmitPayload } = loadModule();
  assert.equal(
    buildSubmitPayload({ prompt: 'x', ratio: 'Màn hình rộng', timeoutMs: 1000 }).ratio,
    'widescreen',
  );
  assert.equal(
    buildSubmitPayload({ prompt: 'x', ratio: 'vuông', timeoutMs: 1000 }).ratio,
    'square',
  );
  assert.equal(
    buildSubmitPayload({ prompt: 'x', ratio: 'chân dung', timeoutMs: 1000 }).ratio,
    'portrait',
  );
});

test('ratio: garbage or absent ratio falls back to the square default, never throws', () => {
  const { buildSubmitPayload } = loadModule();
  assert.equal(buildSubmitPayload({ prompt: 'x', ratio: 'banana', timeoutMs: 1000 }).ratio, 'square');
  assert.equal(buildSubmitPayload({ prompt: 'x', timeoutMs: 1000 }).ratio, 'square');
  assert.equal(buildSubmitPayload({ prompt: 'x', ratio: 169, timeoutMs: 1000 }).ratio, 'square');
});

test('ratio: semantics are read from a registry object passed in', () => {
  const { buildSubmitPayload } = loadModule();
  // A parsed GPT-01 registry stores semantics keyed by REDUCED canonical
  // spellings (its parser canonicalizes "21:9" to "7:3"), and GPT-01's
  // normalizer looks the reduced spelling up — the builder mirrors both.
  const registry = {
    defaults: {
      ratioSemantics: { '7:3': 'ultrawide', '16:9': 'widescreen', '1:1': 'square' },
    },
  };
  const command = buildSubmitPayload(
    { prompt: 'x', ratio: '21:9', timeoutMs: 1000 },
    { registry },
  );
  assert.equal(command.ratio, 'ultrawide');
  assert.equal(command.ratioSpelling, '7:3');
});

test('ratio: an injected normalizer takes precedence over the built-in semantics', () => {
  const { buildSubmitPayload } = loadModule();
  const command = buildSubmitPayload(
    { prompt: 'x', ratio: '1:1', timeoutMs: 1000 },
    { normalizeRatio: () => 'story' },
  );
  assert.equal(command.ratio, 'story');
});

// --- Refs: GPT-03 output is carried through, never re-resolved ---

test('refs: the resolveRefs result is carried through with rejections and capped flag', () => {
  const { buildSubmitPayload } = loadModule();
  const refsResult = refsResultFixture({
    refs: [
      { fileId: 'a', base64: b64([9]), name: 'a.png', type: 'image/png' },
      { fileId: 'b', base64: b64([8]), name: 'b.png', type: 'image/png' },
    ],
    rejected: [{ index: 2, reason: 'missing_payload' }],
    capped: true,
  });
  const command = plain(buildSubmitPayload({ prompt: 'x', timeoutMs: 1000 }, { refsResult }));
  assert.deepEqual(command.refs, refsResult.refs);
  assert.deepEqual(command.refRejections, [{ index: 2, reason: 'missing_payload' }]);
  assert.equal(command.refsCapped, true);
});

test('refs: raw attachments on the payload are NOT re-resolved by the builder', () => {
  const { buildSubmitPayload } = loadModule();
  const command = plain(buildSubmitPayload({
    prompt: 'x',
    timeoutMs: 1000,
    attachments: [{ fileId: 'staged-9', base64: b64([1]), name: 'n.png', type: 'image/png' }],
  }));
  assert.deepEqual(command.refs, []);
  assert.deepEqual(command.refRejections, []);
  assert.equal(command.refsCapped, false);
});

test('refs: a resolved result stashed on the payload is accepted when options carry none', () => {
  const { buildSubmitPayload } = loadModule();
  const refsResult = refsResultFixture();
  const command = plain(buildSubmitPayload({ prompt: 'x', timeoutMs: 1000, refs: refsResult }));
  assert.deepEqual(command.refs, refsResult.refs);
  assert.equal(command.refsCapped, false);
});

// --- Fallback prefix defaulting (B17) ---

test('fallback prefix: payload value wins, then config, then the default', () => {
  const { buildSubmitPayload, DEFAULT_FALLBACK_PREFIX } = loadModule();
  assert.equal(DEFAULT_FALLBACK_PREFIX, 'Generate an image of: ');
  assert.equal(
    buildSubmitPayload(
      { prompt: 'x', timeoutMs: 1000, fallbackPrefix: 'Draw an image of: ' },
      { config: { fallbackPrefix: 'Config prefix: ' } },
    ).fallbackPrefix,
    'Draw an image of: ',
  );
  assert.equal(
    buildSubmitPayload(
      { prompt: 'x', timeoutMs: 1000 },
      { config: { fallbackPrefix: 'Config prefix: ' } },
    ).fallbackPrefix,
    'Config prefix: ',
  );
  assert.equal(
    buildSubmitPayload({ prompt: 'x', timeoutMs: 1000 }).fallbackPrefix,
    'Generate an image of: ',
  );
});

test('fallback prefix: a blank supplied prefix falls back to the default', () => {
  const { buildSubmitPayload } = loadModule();
  assert.equal(
    buildSubmitPayload({ prompt: 'x', timeoutMs: 1000, fallbackPrefix: '   ' }).fallbackPrefix,
    'Generate an image of: ',
  );
  assert.equal(
    buildSubmitPayload({ prompt: 'x', timeoutMs: 1000, fallback_prefix: 'Sketch: ' }).fallbackPrefix,
    'Sketch: ',
  );
});

test('image mode off: no fallback prefix is defaulted', () => {
  const { buildSubmitPayload } = loadModule();
  const command = buildSubmitPayload({ prompt: 'x', timeoutMs: 1000, imageMode: false });
  assert.equal(command.imageMode, false);
  assert.equal(command.fallbackPrefix, null);
});
