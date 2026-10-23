import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const domUtilsSource = readFileSync(new URL('../extension/src/content/shared/dom-utils.js', import.meta.url), 'utf8');
const editorSource = readFileSync(new URL('../extension/src/content/providers/flow/composer/flow-editor.js', import.meta.url), 'utf8');
const tilesSource = readFileSync(new URL('../extension/src/content/providers/flow/generation/tiles.js', import.meta.url), 'utf8');
const operationsSource = readFileSync(new URL('../extension/src/content/providers/flow/generation/generation-operations.js', import.meta.url), 'utf8');

const LOCATION = { href: 'https://flow.google.com/u/0/?hl=vi' };
const VISIBLE_STYLE = () => ({ display: 'block', visibility: 'visible', opacity: '1' });

// ---------------------------------------------------------------------------
// Fix 1: the credit quote must come from the composer region; a cheaper
// quote elsewhere on the page must not under-read the maxCredits gate.
// ---------------------------------------------------------------------------

function quoteElement({ text, parent = null, matches = true }) {
  return {
    innerText: text,
    textContent: text,
    parentElement: parent,
    parentNode: parent,
    isConnected: true,
    getBoundingClientRect: () => ({ width: 140, height: 24 }),
    getAttribute: () => null,
    matches: () => matches,
    contains: () => false,
    querySelectorAll: () => [],
    querySelector: () => null,
  };
}

function creditQuoteHarness({ composerFound, scopedQuoteText, outsideQuoteTexts }) {
  const editor = quoteElement({ text: 'A dramatic scene', matches: false });
  editor.isContentEditable = true;
  const composer = quoteElement({ text: '', matches: false });
  const scopedQuote = scopedQuoteText ? quoteElement({ text: scopedQuoteText, parent: composer }) : null;
  composer.contains = element => element === scopedQuote;
  editor.closest = selector => (composerFound && selector.includes('composer') ? composer : null);
  editor.parentElement = null;
  const outsideQuotes = outsideQuoteTexts.map(text => quoteElement({ text }));
  const allElements = [editor, composer, ...(scopedQuote ? [scopedQuote] : []), ...outsideQuotes];

  const context = vm.createContext({
    globalThis: {},
    window: {},
    document: {
      body: null,
      querySelectorAll: selector => {
        if (selector === '*') return allElements;
        if (selector.includes('.ProseMirror')) return [editor];
        return [];
      },
      querySelector: selector => {
        if (selector.includes('contenteditable') || selector.includes('.ProseMirror')) return editor;
        return null;
      },
    },
    location: LOCATION,
    getComputedStyle: VISIBLE_STYLE,
    accessibleName: element => element.innerText || '',
  });
  vm.runInContext(domUtilsSource, context);
  vm.runInContext(editorSource, context);
  return context.globalThis.FlowEditor;
}

test('credit quote: the composer-region quote wins over a cheaper quote elsewhere on the page', () => {
  const FlowEditor = creditQuoteHarness({
    composerFound: true,
    scopedQuoteText: 'Generating will use 40 credits',
    outsideQuoteTexts: ['will use 10 credits'],
  });
  // Before the fix the page-wide scan picked the shortest text ("will use 10
  // credits") and the maxCredits gate silently passed a 40-credit charge.
  assert.equal(FlowEditor.readGenerationCreditQuote(), 40);
});

test('credit quote: composer found but its quote missing -> page-wide fallback takes the maximum', () => {
  const FlowEditor = creditQuoteHarness({
    composerFound: true,
    scopedQuoteText: null,
    outsideQuoteTexts: ['will use 10 credits', 'Generating will use 40 credits'],
  });
  assert.equal(FlowEditor.readGenerationCreditQuote(), 40);
});

test('credit quote: no composer region at all -> page-wide fallback takes the maximum, never the cheapest', () => {
  const FlowEditor = creditQuoteHarness({
    composerFound: false,
    scopedQuoteText: null,
    outsideQuoteTexts: ['will use 10 credits', 'Generating will use 40 credits'],
  });
  assert.equal(FlowEditor.readGenerationCreditQuote(), 40);
});

// ---------------------------------------------------------------------------
// Fix 2: observe must not fail a dispatched generation because of a page
// error that already existed when observation started.
// ---------------------------------------------------------------------------

function observeHarness({ errorsScript, receipt, media }) {
  const attemptId = 'attempt-1';
  const correlation = new Map([[attemptId, {
    attemptId, receipts: [], requestSeen: true, interfered: false, projectId: 'project-1', mediaType: 'image',
  }]]);
  let errorCalls = 0;
  const context = vm.createContext({
    Date, Promise, Map, Set, Object, String, Number, Boolean, Array, Math, RegExp, Error,
    setTimeout, clearTimeout,
    window: { addEventListener() {}, removeEventListener() {} },
    wait: async () => {},
    checkFlowCreditLimitAlert: () => null,
    FlowEditor: {
      currentFlowSubmitErrors: () => errorsScript(errorCalls++),
    },
    FlowTiles: {
      nativeFlowCorrelationMap: () => correlation,
      nativeFlowCorrelationReceipt: () => receipt,
      collectNativeMedia: () => media,
      emitFlowProgress: async () => {},
      disarmNativeFlowCorrelation: () => {},
      retryIdentity: item => item.id,
      retryNativeErrorTile: async () => false,
    },
  });
  vm.runInContext(operationsSource, context);
  const driver = {
    error: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
  };
  const operations = new context.FlowGenerationOperations(driver);
  return () => operations.execute('flow.generation.observe', {
    before: [], kind: 'image', expectedCount: 1, timeoutMs: 30_000, correlationAttemptId: attemptId,
  }, {});
}

const READY_MEDIA = [{ id: 'media-1', title: 'scene-01', kind: 'image', mediaReady: true, busy: false, failed: false }];
const READY_RECEIPT = { mediaIds: ['media-1'], children: [] };

test('observe: a stale page error present since observation started does not fail a succeeded generation', async () => {
  const observe = observeHarness({
    errorsScript: () => ['Đã xảy ra lỗi. Vui lòng thử lại sau'],
    receipt: READY_RECEIPT,
    media: READY_MEDIA,
  });
  // Before the fix the first poll threw FLOW_GENERATION_FAILED
  // (outcome_unknown=false) on the lingering toast, inviting a duplicate,
  // second-charge retry of a generation that had already succeeded.
  const result = await observe();
  assert.equal(result.media.length, 1);
  assert.equal(result.media[0].id, 'media-1');
});

test('observe: receipt/success evidence is evaluated before the page-error check', async () => {
  const observe = observeHarness({
    // Absent from the start-of-observe snapshot, present on later reads:
    // the correlated success in the same poll must still win.
    errorsScript: call => (call === 0 ? [] : ['Unrelated alert: something went wrong']),
    receipt: READY_RECEIPT,
    media: READY_MEDIA,
  });
  const result = await observe();
  assert.equal(result.media.length, 1);
  assert.equal(result.media[0].id, 'media-1');
});

test('observe: a genuinely new page error still fails the observation definitively', async () => {
  const observe = observeHarness({
    errorsScript: call => (call === 0 ? [] : ['Something went wrong while generating']),
    receipt: null,
    media: [],
  });
  await assert.rejects(observe(), error => {
    assert.equal(error.code, 'FLOW_GENERATION_FAILED');
    assert.equal(error.outcome_unknown, false);
    assert.match(error.message, /Something went wrong while generating/);
    return true;
  });
});

// ---------------------------------------------------------------------------
// Fix 3: a tile must not be classified failed because its own title/prompt
// text contains error words; a dedicated in-tile error element still fails.
// ---------------------------------------------------------------------------

function tilesHarness() {
  const context = vm.createContext({
    globalThis: {},
    window: {},
    setTimeout, clearTimeout,
    document: { querySelectorAll: () => [], querySelector: () => null },
    location: LOCATION,
    getComputedStyle: VISIBLE_STYLE,
    accessibleName: element => element.innerText || '',
  });
  vm.runInContext(domUtilsSource, context);
  vm.runInContext(tilesSource, context);
  return context;
}

function fakeLeaf({ text = '' } = {}) {
  return {
    innerText: text,
    textContent: text,
    getAttribute: () => null,
    matches: () => false,
    contains: () => false,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

test('tiles: a successful tile whose title contains "thất bại" is not classified failed', () => {
  const context = tilesHarness();
  const { isTileBusy, isTileMediaReady, collectNativeMedia } = context.globalThis.FlowTiles;
  const title = 'Cảnh thất bại của mẹ';
  const img = {
    currentSrc: 'https://flow.google.com/asb/finished-1',
    complete: true,
    naturalWidth: 1024,
    innerText: '',
    textContent: '',
    getAttribute: name => (name === 'src' ? 'https://flow.google.com/asb/finished-1' : null),
  };
  const titleElement = fakeLeaf({ text: title });
  const tile = {
    innerText: title,
    textContent: title,
    getAttribute: name => (name === 'aria-label' ? title : null),
    querySelector: selector => (selector === 'img' ? img : null),
    querySelectorAll: selector => {
      if (selector === '*') return [titleElement, img];
      if (selector.includes('img')) return [img];
      return [];
    },
  };

  // Before the fix the whole-tile text fallback matched "thất bại" in the
  // prompt/title and returned the tile itself as its own error element.
  assert.equal(isTileMediaReady(tile), true);
  assert.equal(isTileBusy(tile), false);

  context.document.querySelectorAll = selector => (selector.includes('flow-grid-tile-container') ? [tile] : []);
  const media = collectNativeMedia();
  assert.equal(media.length, 1);
  assert.equal(media[0].failed, false);
});

test('tiles: a dedicated in-tile error element still classifies the tile as failed', () => {
  const context = tilesHarness();
  const { isTileMediaReady, collectNativeMedia } = context.globalThis.FlowTiles;
  const title = 'A peaceful landscape';
  const titleElement = fakeLeaf({ text: title });
  const errorElement = fakeLeaf({ text: 'Generation failed' });
  const tile = {
    innerText: `${title} Generation failed`,
    textContent: `${title} Generation failed`,
    getAttribute: name => (name === 'aria-label' ? title : null),
    querySelector: () => null,
    querySelectorAll: selector => (selector === '*' ? [titleElement, errorElement] : []),
  };

  assert.equal(isTileMediaReady(tile), false);

  context.document.querySelectorAll = selector => (selector.includes('flow-grid-tile-container') ? [tile] : []);
  const media = collectNativeMedia();
  assert.equal(media.length, 1);
  assert.equal(media[0].failed, true);
  assert.equal(media[0].failureReason, 'Generation failed');
});

test('tiles: waitForNativeEditorCompletion ignores failure words inside tile titles', async () => {
  const context = tilesHarness();
  const titleLine = 'Tạo thất bại của nhân vật chính';
  const tile = {
    innerText: titleLine,
    textContent: titleLine,
    getAttribute: name => (name === 'aria-label' ? titleLine : null),
  };
  let mainReads = 0;
  const main = {};
  Object.defineProperty(main, 'innerText', {
    get: () => (mainReads++ === 0 ? `Đang tạo 50%\n${titleLine}` : titleLine),
  });
  context.document.querySelector = selector => (selector === 'main' ? main : null);
  context.document.querySelectorAll = selector => (selector.includes('flow-grid-tile-container') ? [tile] : []);
  context.document.body = { querySelectorAll: () => [], innerText: '' };

  // Before the fix the free-text scan matched the folded tile title
  // ("tao that bai") and threw FLOW_GENERATION_FAILED for a healthy edit.
  const completed = await context.globalThis.FlowTiles.waitForNativeEditorCompletion({}, 60_000, 'video edit');
  assert.equal(completed, true);
});
