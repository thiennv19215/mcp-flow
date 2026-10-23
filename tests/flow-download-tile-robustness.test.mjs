import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// DL-09 — Download-path tile robustness (sweep, broken tile, project check).
// Queue downloads of older results can target tiles that are scrolled out
// of Flow's virtualized grid or whose preview failed to load, and the
// download op never confirmed the page is in the media's project before
// clicking. The reference logic (study D3/D4/D5/D6, gap G9):
//  - D4: if the target tile is not mounted, force-load tiles with a scroll
//    sweep; a callback fires the moment the target mounts, ownership is
//    re-verified at that moment, and a failed sweep imposes a cooldown so
//    repeated attempts don't thrash the grid (reference: 60 seconds);
//  - D5: before any download, the resolved tile's identity ALIAS SET
//    (media id / persistent id / UUID / asb form — the forms the
//    generation side already accepts) must contain the requested
//    identity; a tile mounting with a DIFFERENT identity is never
//    clicked;
//  - D6: a broken (load-error) tile is recovered first; if recovery
//    fails, the download is withheld entirely — no download click;
//  - D3: the page's current project must equal the media's project,
//    checked before any sweep or click, failing with FLOW_PROJECT_MISMATCH.
// The happy path (mounted, healthy, correct-project tile) must download
// exactly as before DL-09 (the control test pins DL-01/03/08 behavior).

const tilesSource = readFileSync(new URL('../extension/src/content/providers/flow/generation/tiles.js', import.meta.url), 'utf8');
const mediaMenuSource = readFileSync(new URL('../extension/src/content/providers/flow/media/media-menu.js', import.meta.url), 'utf8');

const PAGE_PROJECT = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT = '99999999-9999-4999-8999-999999999999';
const UUID_A = '22222222-2222-4222-8222-222222222222';
const UUID_B = '33333333-3333-4333-8333-333333333333';
const ASB_A = 'asb:asbPersistentA1234567890abcdef';

class FakeEvent {
  constructor(type, init = {}) { this.type = type; Object.assign(this, init); }
}
class FakeImageElement {}
class FakeVideoElement {}

function downloadHarness() {
  const posted = [];
  const events = [];
  const mounted = new Set();
  let pendingTile = null;
  let mountAt = Infinity;
  let menuOpenFor = null;

  const scroller = {
    scrollHeight: 1200,
    clientHeight: 300,
    scrollSets: [],
    _top: 0,
    get scrollTop() { return this._top; },
    set scrollTop(value) {
      this._top = value;
      this.scrollSets.push(value);
      if (pendingTile && value >= mountAt) mounted.add(pendingTile);
    },
  };

  function makeTile({
    primaryId = 'media-1',
    title = 'scene one',
    uuid = null,
    kind = 'image',
    error = false,
    recoverOnRetry = false,
    imgBroken = false,
    imgSrc = null,
  } = {}) {
    const state = {
      error, busy: false, retryClicks: 0, moreClicks: 0, scrollIntoViewCount: 0,
    };
    const src = imgSrc || (uuid ? `https://flow-content.google/image/${uuid}` : 'https://lh3.googleusercontent.com/media-1=s512');
    const img = new (kind === 'video' ? FakeVideoElement : FakeImageElement)();
    Object.assign(img, {
      tagName: kind === 'video' ? 'VIDEO' : 'IMG',
      currentSrc: src,
      src,
      complete: true,
      naturalWidth: imgBroken ? 0 : 64,
      readyState: 4,
      getAttribute(name) {
        if (name === 'src') return src;
        if (name === 'data-media-id' || name === 'data-persistent-media-id') return uuid;
        return null;
      },
      dispatchEvent() { return true; },
      getBoundingClientRect() { return { left: 0, top: 0, width: 20, height: 20 }; },
    });
    const retryBtn = {
      disabled: false,
      __accessibleName: 'Retry',
      getAttribute(name) { return name === 'aria-label' ? 'Retry' : null; },
      querySelector(sel) { return sel.includes('mat-icon') ? { textContent: 'refresh' } : null; },
      cloneNode() { return { querySelectorAll: () => [], innerText: 'Retry', textContent: 'Retry' }; },
      dispatchEvent() { return true; },
      getBoundingClientRect() { return { left: 0, top: 0, width: 10, height: 10 }; },
      click() {
        state.retryClicks += 1;
        events.push('retry-click');
        if (recoverOnRetry) {
          state.error = false;
          state.busy = true;
          img.naturalWidth = 64;
        }
      },
    };
    const errorEl = {
      innerText: 'Failed to load',
      textContent: 'Failed to load',
      matches() { return false; },
      querySelectorAll() { return state.error ? [retryBtn] : []; },
      contains(el) { return el === retryBtn; },
    };
    const progressEl = { tagName: 'FLOW-PROGRESS-TILE' };
    const moreBtn = {
      disabled: false,
      getAttribute() { return null; },
      querySelector(sel) { return sel.includes('mat-icon') ? { textContent: 'more_vert' } : null; },
      cloneNode() { return { querySelectorAll: () => [], innerText: '', textContent: '' }; },
      click() { state.moreClicks += 1; menuOpenFor = tile; },
    };
    const tile = {
      __id: primaryId,
      isConnected: true,
      parentElement: scroller,
      innerText: '',
      textContent: '',
      getAttribute(name) {
        if (name === 'aria-label') return title;
        if (name === 'data-persistent-media-id' || name === 'data-media-id') return uuid;
        return null;
      },
      querySelector(sel) {
        if (typeof sel !== 'string') return null;
        if (sel.includes('flow-error-tile')) return state.error ? errorEl : null;
        if (sel.includes('flow-progress-tile') || sel.includes('mat-progress-bar') || sel.includes('progressbar')) return state.busy ? progressEl : null;
        if (sel.includes('spinner') || sel.includes('mat-spinner')) return null;
        if (sel === 'flow-scene-tile') return null;
        if (sel === 'flow-video-tile') return kind === 'video' ? {} : null;
        if (sel.includes('flow-video-tile')) return kind === 'video' ? {} : null;
        if (sel === 'flow-error-tile') return state.error ? errorEl : null;
        if (sel === 'img,video' || sel === 'img' || sel === 'video' || sel === 'img,video,[role=img]') return img;
        return null;
      },
      querySelectorAll(sel) {
        if (typeof sel !== 'string') return [];
        if (sel.includes('data-persistent-media-id')) return [];
        if (sel === 'button,[role="button"]') return state.error ? [moreBtn, retryBtn] : [moreBtn];
        if (sel === '*') return [];
        if (sel === 'img') return kind === 'video' ? [] : [img];
        if (sel.includes('img') || sel.includes('video') || sel.includes('canvas')) return [img];
        return [];
      },
      scrollIntoView() { state.scrollIntoViewCount += 1; },
      dispatchEvent() { return true; },
      getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; },
      contains(el) { return el === retryBtn || el === img || el === moreBtn || el === errorEl; },
      click() {},
    };
    return { tile, img, state, moreBtn, retryBtn, errorEl };
  }

  const downloadItem = {
    disabled: false,
    clicks: 0,
    getAttribute() { return null; },
    querySelector(sel) { return sel.includes('.label') ? { innerText: 'Download', textContent: 'Download' } : null; },
    cloneNode() { return { querySelectorAll: () => [], innerText: '', textContent: '' }; },
    click() { this.clicks += 1; events.push('download-click'); },
  };

  const documentFake = {
    visibilityState: 'visible',
    scrollingElement: null,
    documentElement: { scrollHeight: 0, clientHeight: 0 },
    body: { appendChild() {} },
    querySelectorAll(sel) {
      if (sel === 'flow-grid-tile-container') return [...mounted];
      if (sel === 'div,main,section') return [scroller];
      if (sel === '[role="menuitem"],button') return menuOpenFor ? [downloadItem] : [];
      return [];
    },
    querySelector() { return null; },
    createElement() { throw new Error('no anchor save expected in these tests'); },
  };

  const sandbox = {
    console,
    URL,
    atob,
    setTimeout,
    clearTimeout,
    crypto: globalThis.crypto,
    HTMLVideoElement: FakeVideoElement,
    HTMLImageElement: FakeImageElement,
    isFlowMediaSource: value => /^https:\/\/(?:flow-content\.google|lh3\.googleusercontent\.com|flow\.google\.com)/.test(String(value || '')),
    PointerEvent: FakeEvent,
    MouseEvent: FakeEvent,
    KeyboardEvent: FakeEvent,
    Event: FakeEvent,
    CustomEvent: FakeEvent,
    location: { origin: 'https://flow.google.com', href: `https://flow.google.com/project/${PAGE_PROJECT}` },
    window: { postMessage: message => posted.push(message), addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } },
    document: documentFake,
    chrome: {
      storage: { local: { get: async () => ({}) } },
      runtime: { sendMessage: async () => ({ ok: true }) },
    },
    addEventListener() {},
    getComputedStyle: el => ({ overflowY: el === scroller ? 'auto' : 'visible' }),
    flowError: (code, message, retryable, outcomeUnknown) =>
      Object.assign(new Error(message), { code, retryable, outcome_unknown: outcomeUnknown }),
    wait: async () => {},
    visible: () => true,
    accessibleName: el => el?.__accessibleName || el?.getAttribute?.('aria-label') || '',
    mediaId: candidate => candidate?.__id,
    ProviderRegistry: {
      describeUrl(value) {
        const match = /\/project\/([0-9a-f-]{36})/i.exec(String(value || ''));
        return match ? { projectId: match[1], origin: 'https://flow.google.com' } : null;
      },
    },
    fetch: async () => { throw new Error('direct-bytes fallback must not engage in DL-09 tests'); },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(tilesSource, context);
  vm.runInContext(mediaMenuSource, context);

  return {
    context,
    events,
    posted,
    scroller,
    downloadItem,
    makeTile,
    mount(tile) { mounted.add(tile); },
    mountOnScroll(tile, at) { pendingTile = tile; mountAt = at; },
    run: (title, quality, handle, options) => context.triggerFlowDownload(title, quality, handle, options),
  };
}

test('DL-09 (a): unmounted target — the generation sweep mounts it, identity is verified via the alias set, on-mounted fires before the click', async () => {
  const h = downloadHarness();
  // The tile's primary mediaId() form is the asb identity; the requested
  // handle is the canonical UUID. The tile exposes the UUID through its
  // persistent-id attributes and its media src — the alias set the
  // generation side already accepts. Strict single-id equality (the
  // pre-DL-09 download code) can never match this tile.
  const { tile, state } = h.makeTile({ primaryId: ASB_A, uuid: UUID_A });
  h.mountOnScroll(tile, 240);

  const mountedSeen = [];
  const result = await h.run('scene one', 'original', UUID_A, {
    projectId: PAGE_PROJECT,
    onTileMounted: mounted => { mountedSeen.push(mounted); h.events.push('tile-mounted'); },
  });

  assert.equal(result.downloadTriggered, true);
  assert.equal(h.downloadItem.clicks, 1, 'the download completes once the tile mounts');
  assert.ok(h.scroller.scrollSets.some(value => value >= 240), 'the tile-loading sweep scrolled the virtualized grid');
  assert.equal(mountedSeen.length, 1, 'the on-mounted callback fired exactly once');
  assert.equal(mountedSeen[0], tile, 'the on-mounted callback received the mounted tile');
  assert.ok(h.events.indexOf('tile-mounted') < h.events.indexOf('download-click'),
    'on-mounted fires the moment the tile mounts, before any download click');
  assert.equal(state.moreClicks, 1);
});

test('DL-09 (a2): tiles sweep entry point — alias set exposure, on-mounted callback, 60s failure-cooldown constant', async () => {
  const h = downloadHarness();
  const { tile } = h.makeTile({ primaryId: ASB_A, uuid: UUID_A });
  h.mount(tile);

  assert.equal(typeof h.context.FlowTiles.sweepFlowTileByMediaId, 'function',
    'tiles.js exposes a reusable sweep entry point for the download path');
  assert.equal(h.context.FlowTiles.FLOW_TILE_SWEEP_FAILURE_COOLDOWN_MS, 60_000,
    'the failure cooldown window is the reference 60 seconds');
  const aliases = h.context.FlowTiles.tileIdentityAliases(tile);
  assert.ok(aliases.includes(UUID_A), `alias set carries the canonical UUID (got ${JSON.stringify(aliases)})`);
  assert.ok(aliases.includes(ASB_A), 'alias set carries the primary asb identity');

  const seen = [];
  const found = await h.context.FlowTiles.sweepFlowTileByMediaId(UUID_A, {
    onMounted: mounted => seen.push(mounted),
  });
  assert.equal(found, tile);
  assert.deepEqual(seen, [tile], 'the sweep fires on-mounted for the verified tile');
});

test('DL-09 (b): load-error tile — recovery is attempted and, when it fails, NO download click happens', async () => {
  const h = downloadHarness();
  const { tile, state } = h.makeTile({ primaryId: 'media-1', error: true, recoverOnRetry: false });
  h.mount(tile);

  await assert.rejects(h.run('scene one', 'original', 'media-1', { projectId: PAGE_PROJECT }), error => {
    assert.equal(error.code, 'FLOW_DOWNLOAD_BROKEN_TILE',
      'a tile that cannot recover is withheld with the broken-tile error, not downloaded');
    return true;
  });
  assert.ok(state.retryClicks >= 1, 'recovery was attempted (the tile retry control was activated)');
  assert.equal(state.moreClicks, 0, 'the tile options menu was never opened');
  assert.equal(h.downloadItem.clicks, 0, 'no download click happened');
});

test('DL-09 (b2): load-error tile — a successful recovery lets the download proceed', async () => {
  const h = downloadHarness();
  const { tile, state } = h.makeTile({ primaryId: 'media-1', error: true, recoverOnRetry: true });
  h.mount(tile);

  const result = await h.run('scene one', 'original', 'media-1', { projectId: PAGE_PROJECT });
  assert.equal(result.downloadTriggered, true);
  assert.equal(state.retryClicks, 1, 'recovery was attempted exactly once before downloading');
  assert.equal(h.downloadItem.clicks, 1, 'the recovered tile downloads normally');
});

test('DL-09 (b3): broken image element (loaded with zero size) — recovery fails and the download is withheld', async () => {
  const h = downloadHarness();
  const { tile, state } = h.makeTile({ primaryId: 'media-1', imgBroken: true });
  h.mount(tile);

  await assert.rejects(h.run('scene one', 'original', 'media-1', { projectId: PAGE_PROJECT }), error => {
    assert.equal(error.code, 'FLOW_DOWNLOAD_BROKEN_TILE');
    return true;
  });
  assert.equal(state.moreClicks, 0);
  assert.equal(h.downloadItem.clicks, 0, 'a broken tile is never clicked for download');
});

test('DL-09 (c): wrong project — FLOW_PROJECT_MISMATCH before any sweep or click', async () => {
  const h = downloadHarness();
  const { tile, state } = h.makeTile({ primaryId: ASB_A, uuid: UUID_A });
  h.mountOnScroll(tile, 240);

  await assert.rejects(h.run('scene one', 'original', UUID_A, { projectId: OTHER_PROJECT }), error => {
    assert.equal(error.code, 'FLOW_PROJECT_MISMATCH',
      'the page project is checked against the media project with the repo FLOW_PROJECT_* code');
    return true;
  });
  assert.equal(h.scroller.scrollSets.length, 0, 'no sweep ran before the project check failed');
  assert.equal(state.moreClicks, 0);
  assert.equal(h.downloadItem.clicks, 0, 'no download click happened');
});

test('DL-09 (d): happy-path control — mounted, healthy, correct-project tile downloads exactly as before', async () => {
  const h = downloadHarness();
  const { tile, state } = h.makeTile({ primaryId: 'media-1' });
  h.mount(tile);

  const result = await h.run('scene one', 'original', 'media-1', { projectId: PAGE_PROJECT });
  assert.equal(result.downloadTriggered, true);
  assert.equal(result.kind, 'image');
  assert.equal(result.route, undefined, 'the menu route result carries no fallback marker (DL-08 unchanged)');
  assert.equal(h.downloadItem.clicks, 1, 'the menu download item was clicked exactly once');
  assert.equal(state.retryClicks, 0, 'no recovery was attempted for a healthy tile');
  assert.equal(h.scroller.scrollSets.length, 0, 'an already-mounted tile needs no sweep scrolling');
});

test('DL-09 (e): a tile mounting with a DIFFERENT identity is never clicked', async () => {
  const h = downloadHarness();
  const wrong = h.makeTile({ primaryId: 'media-wrong', uuid: UUID_B, title: 'scene one' });
  h.mountOnScroll(wrong.tile, 240);

  await assert.rejects(h.run('scene one', 'original', UUID_A, { projectId: PAGE_PROJECT }), error => {
    assert.equal(error.code, 'FLOW_ASSET_NOT_FOUND',
      'the sweep only ever accepts a tile whose alias set contains the requested identity');
    return true;
  });
  assert.equal(wrong.state.moreClicks, 0, 'the wrong-identity tile was never opened');
  assert.equal(h.downloadItem.clicks, 0, 'no download click happened');
});

test('DL-09 (f): failed sweep imposes the per-target cooldown — a repeat attempt fails fast without scrolling, a different target is unaffected', async () => {
  const h = downloadHarness();
  // Nothing ever mounts in this harness.
  await assert.rejects(h.run('scene one', 'original', UUID_A, { projectId: PAGE_PROJECT }), error => {
    assert.equal(error.code, 'FLOW_ASSET_NOT_FOUND');
    return true;
  });
  const setsAfterFirst = h.scroller.scrollSets.length;
  assert.ok(setsAfterFirst > 0, 'the first attempt really swept the grid');

  await assert.rejects(h.run('scene one', 'original', UUID_A, { projectId: PAGE_PROJECT }), error => {
    assert.equal(error.code, 'FLOW_TILE_SWEEP_COOLDOWN',
      'a repeated sweep for the same target inside the cooldown window fails fast');
    return true;
  });
  assert.equal(h.scroller.scrollSets.length, setsAfterFirst,
    'the cooled-down attempt did not scroll/thrash the grid at all');
  assert.equal(h.downloadItem.clicks, 0);

  await assert.rejects(h.run('scene one', 'original', UUID_B, { projectId: PAGE_PROJECT }), error => {
    assert.equal(error.code, 'FLOW_ASSET_NOT_FOUND',
      'the cooldown is per-target: a different target still gets a real sweep');
    return true;
  });
  assert.ok(h.scroller.scrollSets.length > setsAfterFirst, 'the different target swept normally');
});
