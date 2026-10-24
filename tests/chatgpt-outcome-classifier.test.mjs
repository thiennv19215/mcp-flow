import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const classifierSource = readFileSync(
  new URL('../extension/src/content/providers/chatgpt/generation/outcome-classifier.js', import.meta.url),
  'utf8',
);

function loadClassifier() {
  const context = vm.createContext({ console });
  vm.runInContext(classifierSource, context);
  return context.ChatGptOutcomeClassifier;
}

const streaming = (over = {}) => ({ streaming: true, textLength: 0, imageCount: 0, ...over });
const ended = (over = {}) => ({ streaming: false, textLength: 0, imageCount: 0, ...over });

test('images appearing late (during the settle grace) decide success once the stream has ended', () => {
  const { classifyOutcome } = loadClassifier();
  const decision = classifyOutcome([
    streaming({ textLength: 12 }),
    streaming({ textLength: 64 }),
    ended({ textLength: 96 }), // stream over, nothing rendered yet — grace starts
    ended({ textLength: 96, imageCount: 2 }), // images land inside the grace
  ]);
  assert.equal(decision.outcome, 'success');
  assert.equal(decision.code, null);
  assert.equal(decision.imageCount, 2);
  assert.equal(decision.diagnostics.samples, 4);
  assert.equal(decision.diagnostics.decidedAtSample, 4);
  assert.equal(decision.diagnostics.peakImageCount, 2);
  assert.equal(decision.diagnostics.finalTextLength, 96);
});

test('images present while the stream is still open never decide success early', () => {
  const { createOutcomeClassifier } = loadClassifier();
  const classifier = createOutcomeClassifier();
  assert.equal(classifier.push(streaming({ imageCount: 1 })), null);
  assert.equal(classifier.push(streaming({ imageCount: 3 })), null);
  const decision = classifier.push(ended({ imageCount: 3 }));
  assert.equal(decision.outcome, 'success');
  assert.equal(decision.diagnostics.peakImageCount, 3);
});

test('stream ending text-only settles into a distinct TEXT_ONLY outcome with the count bundle', () => {
  const { classifyOutcome } = loadClassifier();
  const decision = classifyOutcome([
    streaming({ textLength: 30 }),
    ended({ textLength: 132 }),
    ended({ textLength: 132 }),
  ]);
  assert.equal(decision.outcome, 'text_only');
  assert.equal(decision.code, 'CHATGPT_TEXT_ONLY');
  assert.equal(decision.imageCount, 0);
  assert.equal(decision.textLength, 132);
  assert.equal(decision.diagnostics.samples, 3);
  assert.equal(decision.diagnostics.peakImageCount, 0);
  assert.equal(decision.diagnostics.finalImageCount, 0);
  assert.equal(decision.diagnostics.finalTextLength, 132);
  assert.equal(decision.diagnostics.streaming, false);
});

test('TEXT_ONLY is not collapsed into error or timeout outcomes', () => {
  const { classifyOutcome, OUTCOME } = loadClassifier();
  const decision = classifyOutcome([ended({ textLength: 10 }), ended({ textLength: 10 })]);
  assert.equal(decision.outcome, OUTCOME.TEXT_ONLY);
  assert.notEqual(decision.outcome, OUTCOME.ERROR);
  assert.notEqual(decision.outcome, OUTCOME.TIMEOUT);
  assert.notEqual(decision.outcome, OUTCOME.SUCCESS);
});

test('an error sample mid-stream decides error immediately and carries the error detail', () => {
  const { classifyOutcome } = loadClassifier();
  const decision = classifyOutcome([
    streaming({ textLength: 20 }),
    streaming({ textLength: 48, errorPresent: true, errorDetail: 'Something went wrong while generating.' }),
    ended({ textLength: 48, imageCount: 4 }), // never reached: the fold stops at the error
  ]);
  assert.equal(decision.outcome, 'error');
  assert.equal(decision.error, 'Something went wrong while generating.');
  assert.equal(decision.diagnostics.samples, 2);
  assert.equal(decision.diagnostics.decidedAtSample, 2);
});

test('error presence wins over a same-sample stream end with images', () => {
  const { classifyOutcome } = loadClassifier();
  const decision = classifyOutcome([
    ended({ imageCount: 3, errorPresent: true, errorDetail: 'Generation error alert' }),
  ]);
  assert.equal(decision.outcome, 'error');
  assert.equal(decision.error, 'Generation error alert');
  assert.equal(decision.diagnostics.peakImageCount, 3);
});

test('deadline reached with the stream still open decides timeout with the count bundle', () => {
  const { classifyOutcome } = loadClassifier();
  const decision = classifyOutcome([
    streaming({ textLength: 10 }),
    streaming({ textLength: 55, imageCount: 1 }),
    streaming({ textLength: 80, imageCount: 1, deadlineReached: true }),
  ]);
  assert.equal(decision.outcome, 'timeout');
  assert.equal(decision.diagnostics.samples, 3);
  assert.equal(decision.diagnostics.peakImageCount, 1);
  assert.equal(decision.diagnostics.finalTextLength, 80);
  assert.equal(decision.diagnostics.streaming, true);
  assert.equal(decision.diagnostics.endedBy, 'deadline');
});

test('deadline after the stream ended with text but no images truncates the grace into TEXT_ONLY', () => {
  const { classifyOutcome } = loadClassifier();
  const decision = classifyOutcome(
    [streaming({ textLength: 44 }), ended({ textLength: 61 })],
    { deadlineReached: true },
  );
  assert.equal(decision.outcome, 'text_only');
  assert.equal(decision.code, 'CHATGPT_TEXT_ONLY');
  assert.equal(decision.diagnostics.endedBy, 'deadline');
});

test('a stream that ends with neither text nor images is a NO_RESPONSE error, settled or at deadline', () => {
  const { classifyOutcome } = loadClassifier();
  const settled = classifyOutcome([streaming(), ended(), ended()]);
  assert.equal(settled.outcome, 'error');
  assert.equal(settled.code, 'NO_RESPONSE');
  assert.equal(settled.diagnostics.finalTextLength, 0);
  assert.equal(settled.diagnostics.finalImageCount, 0);

  const atDeadline = classifyOutcome([streaming(), ended()], { deadlineReached: true });
  assert.equal(atDeadline.outcome, 'error');
  assert.equal(atDeadline.code, 'NO_RESPONSE');
});

test('a stream resuming mid-grace resets the settle streak', () => {
  const { createOutcomeClassifier } = loadClassifier();
  const classifier = createOutcomeClassifier();
  assert.equal(classifier.push(ended({ textLength: 70 })), null); // streak 1 of 2
  assert.equal(classifier.push(streaming({ textLength: 74 })), null); // resumed — streak reset
  assert.equal(classifier.push(ended({ textLength: 74 })), null); // streak 1 again, no TEXT_ONLY yet
  const decision = classifier.push(ended({ textLength: 74 }));
  assert.equal(decision.outcome, 'text_only');
  assert.equal(decision.diagnostics.settleSamplesSeen, 2);
});

test('settleSamples is configurable: a single confirming sample can settle the outcome', () => {
  const { classifyOutcome } = loadClassifier();
  const decision = classifyOutcome([ended({ textLength: 25 })], { settleSamples: 1 });
  assert.equal(decision.outcome, 'text_only');
  assert.equal(decision.diagnostics.samples, 1);
});

test('an exhausted sequence with the stream never ended classifies as timeout (sequence end)', () => {
  const { classifyOutcome } = loadClassifier();
  const decision = classifyOutcome([streaming({ textLength: 5 }), streaming({ textLength: 9 })]);
  assert.equal(decision.outcome, 'timeout');
  assert.equal(decision.diagnostics.endedBy, 'sequence_end');
  assert.equal(decision.diagnostics.peakImageCount, 0);
});

test('an empty sample sequence is a timeout with a zeroed bundle', () => {
  const { classifyOutcome } = loadClassifier();
  const decision = classifyOutcome([]);
  assert.equal(decision.outcome, 'timeout');
  assert.equal(decision.diagnostics.samples, 0);
  assert.equal(decision.diagnostics.peakImageCount, 0);
  assert.equal(decision.diagnostics.finalTextLength, 0);
  assert.equal(decision.diagnostics.finalImageCount, 0);
});

test('extraction counts on the deciding sample pass through into the diagnostic bundle', () => {
  const { classifyOutcome } = loadClassifier();
  const bundle = {
    renderedCount: 5,
    matchedCount: 0,
    perSelectorCounts: { generated: 0, result: 0, cdn: 5 },
    baselineSourceCount: 3,
    assistantImageCount: 0,
  };
  const decision = classifyOutcome([
    streaming({ textLength: 15 }),
    ended({ textLength: 88, ...bundle }),
    ended({ textLength: 88, ...bundle }),
  ]);
  assert.equal(decision.outcome, 'text_only');
  assert.equal(decision.diagnostics.renderedCount, 5);
  assert.equal(decision.diagnostics.matchedCount, 0);
  // The classifier runs in a vm realm, so its objects carry that realm's
  // prototype; compare the per-selector counts structurally via JSON.
  assert.deepEqual(JSON.parse(JSON.stringify(decision.diagnostics.perSelectorCounts)), {
    generated: 0,
    result: 0,
    cdn: 5,
  });
  assert.equal(decision.diagnostics.baselineSourceCount, 3);
  assert.equal(decision.diagnostics.assistantImageCount, 0);
});

test('once decided, the classifier is stable: later pushes return the same decision', () => {
  const { createOutcomeClassifier } = loadClassifier();
  const classifier = createOutcomeClassifier();
  classifier.push(ended({ textLength: 40 }));
  const decision = classifier.push(ended({ textLength: 40 }));
  assert.equal(decision.outcome, 'text_only');
  assert.equal(classifier.push(ended({ imageCount: 9 })), decision);
  assert.equal(classifier.finish(), decision);
});
