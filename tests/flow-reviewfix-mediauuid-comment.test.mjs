import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Review round 1, item S7 — INVESTIGATION CORRECTION, not a code fix.
//
// The review claimed the receipt's mediaUuid field is dead (always null
// because identityFields only carries uploadName/originalName). Reading
// the chain proves otherwise: every receipt passes through
// enrichFlowUploadReceipt (uploader.js), which sets mediaUuid from the
// receipt's own mediaUuid, from a UUID tile id, or via the media catalog
// / identities probe for asb: ids; flow.media.upload spreads the receipt
// (overriding only name); FlowUploadClient reads value.mediaUuid. So
// mediaUuid is present in the common cases and absent ONLY when the tile
// id is asb: AND catalog and probe both miss — and then the sidebar's
// fallback to the receipt id (the asb: id itself) is still a real
// identity that attach-time resolution can resolve (now with the wider
// two-window resolver from the asb-window fix).
//
// The fix is therefore option (b): correct the sidebar comment to
// describe the actual chain instead of implying mediaUuid is always
// available, and keep the id fallback. This test pins both the comment
// and the fallback behavior of uploadedAssetAttachment.
// ---------------------------------------------------------------------------

function extractSidebarFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `${signature} must exist in sidebar.js`);
  const bodyOpen = source.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = bodyOpen; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  assert.notEqual(end, -1, `${signature} body must close`);
  return { fnSource: source.slice(start, end), commentBlock: source.slice(Math.max(0, start - 1200), start) };
}

test('S7: the uploadedAssetAttachment comment describes the real mediaUuid chain, and the id fallback is kept', () => {
  const source = readFileSync(new URL('../extension/src/ui/sidebar.js', import.meta.url), 'utf8');
  const { fnSource, commentBlock } = extractSidebarFunction(source, 'function uploadedAssetAttachment(uploaded)');
  assert.match(commentBlock, /enrichment/,
    'the comment must name upload enrichment as the mediaUuid source (the old comment implied mediaUuid is always present)');
  assert.match(commentBlock, /asb:/,
    'the comment must describe the asb: id fallback for unresolvable mediaUuid');
  const context = vm.createContext({});
  vm.runInContext(`${fnSource}; globalThis.__fn = uploadedAssetAttachment;`, context);
  const buildRaw = context.__fn;
  // Objects created inside the vm carry the vm's Object.prototype, which
  // deepStrictEqual rejects — serialize like native-references does.
  const build = (input) => JSON.parse(JSON.stringify(buildRaw(input)));
  assert.deepEqual(build({ uploadName: 'a1b2-upload.png', mediaUuid: '22222222-2222-4222-8222-222222222222', id: 'asb:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
    { assetName: 'asset:a1b2-upload.png', expectedId: '22222222-2222-4222-8222-222222222222' },
    'a resolved mediaUuid wins over the receipt id');
  assert.deepEqual(build({ uploadName: 'a1b2-upload.png', id: 'asb:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
    { assetName: 'asset:a1b2-upload.png', expectedId: 'asb:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    'an unresolvable asb: id stays as the fallback identity — it is still resolvable at attach time');
  assert.deepEqual(build({ uploadName: 'a1b2-upload.png' }),
    { assetName: 'asset:a1b2-upload.png' },
    'no identity at all means no expectedId key, as before');
});
