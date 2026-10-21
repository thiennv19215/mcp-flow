import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertVerifiedQuoteWithinCap, parseAuditOptions } from '../scripts/audit-native-options.mjs';

const runner = readFileSync(new URL('../scripts/audit-native.mjs', import.meta.url), 'utf8');

test('voice-options audit mode is a read-only local API probe with no submit path', () => {
  assert.equal(parseAuditOptions(['--mode', 'voice-options']).mode, 'voice-options');
  assert.throws(() => parseAuditOptions(['--mode', 'voice-options', '--voice', 'Voice Alpha']), /only valid with text video or video-reference/);
  assert.throws(() => parseAuditOptions(['--mode', 'voice-options', '--asset', 'still.png']), /--asset is not valid/);
  assert.match(runner, /mode === 'voice-options'[\s\S]*?api\('voice_options'\)/);
});

test('last-frame audit mode requires exactly one existing image asset and routes it as last_frame', () => {
  const parsed = parseAuditOptions(['--mode', 'last-frame', '--asset', 'uploaded still.png']);
  assert.equal(parsed.mode, 'last-frame');
  assert.deepEqual(parsed.assetNames, ['uploaded still.png']);
  assert.match(runner, /mode === 'last-frame'[\s\S]*?last_frame: `asset:\$\{assetNames\[0\]\}`[\s\S]*?max_credits: 15/);
  assert.throws(() => parseAuditOptions(['--mode', 'last-frame']), /requires --asset/);
  assert.throws(() => parseAuditOptions(['--mode', 'last-frame', '--asset', 'first.png', '--asset', 'second.png']), /requires exactly one/);
});

test('image and video reference audit modes accept one exact character or image assets', () => {
  const imageCharacter = parseAuditOptions(['--mode', 'reference', '--character-name', 'Untitled character']);
  assert.equal(imageCharacter.mode, 'reference');
  assert.equal(imageCharacter.characterName, 'Untitled character');
  assert.equal(imageCharacter.characterNameProvided, true);
  assert.deepEqual(imageCharacter.assetNames, []);

  const videoCharacter = parseAuditOptions(['--mode', 'video-reference', '--character-name', 'Untitled character']);
  assert.equal(videoCharacter.mode, 'video-reference');
  assert.equal(videoCharacter.characterName, 'Untitled character');
  assert.equal(videoCharacter.characterNameProvided, true);
  assert.deepEqual(videoCharacter.assetNames, []);

  assert.deepEqual(parseAuditOptions(['--mode', 'reference', '--asset', 'one.png']).assetNames, ['one.png']);
  assert.deepEqual(parseAuditOptions(['--mode', 'reference', '--asset', 'one.png', '--asset', 'two.png']).assetNames, ['one.png', 'two.png']);
  assert.deepEqual(parseAuditOptions(['--mode', 'video-reference', '--asset', 'one.png']).assetNames, ['one.png']);
  assert.throws(() => parseAuditOptions(['--mode', 'reference']), /requires one to three image --asset values or --character-name/);
  assert.throws(() => parseAuditOptions(['--mode', 'video-reference']), /requires one to three image --asset values or --character-name/);
  assert.throws(() => parseAuditOptions(['--mode', 'reference', '--character-name', 'Untitled character', '--asset', 'one.png']), /Choose image --asset references or one --character-name/);
  assert.throws(() => parseAuditOptions(['--mode', 'video-reference', '--character-name', 'Untitled character', '--asset', 'one.png']), /Choose image --asset references or one --character-name/);
});

test('character-edit audit mode requires a distinct source and target name', () => {
  const parsed = parseAuditOptions(['--mode', 'character-edit', '--character-name', 'MCP Character', '--rename-character', 'MCP Character Renamed']);
  assert.equal(parsed.mode, 'character-edit');
  assert.equal(parsed.characterName, 'MCP Character');
  assert.equal(parsed.renameCharacter, 'MCP Character Renamed');
  assert.match(runner, /mode === 'character-edit'[\s\S]*?api\('character_edit', \{ name: characterName, rename: renameCharacter \}/);
  assert.throws(() => parseAuditOptions(['--mode', 'character-edit', '--character-name', 'MCP Character']), /requires --rename-character/);
  assert.throws(() => parseAuditOptions(['--mode', 'character-edit', '--rename-character', 'New Name']), /requires --character-name/);
  assert.throws(() => parseAuditOptions(['--mode', 'character-edit', '--character-name', 'Same', '--rename-character', ' same ']), /must differ/);
  assert.throws(() => parseAuditOptions(['--mode', 'image', '--rename-character', 'New Name']), /only valid/);
});

test('audit voice option is limited to text video and image-reference video with an exact operator value', () => {
  const voice = 'Flow Voice Label (custom)';
  assert.equal(parseAuditOptions(['--mode', 'video', '--voice', voice]).voice, voice);
  assert.equal(parseAuditOptions(['--mode', 'video-reference', '--asset', 'still.png', '--voice', voice]).voice, voice);
  assert.match(runner, /mode === 'video'[\s\S]*?\.\.\.\(voice \? \{ voice \} : \{\}\)/);
  assert.match(runner, /mode === 'video-reference'[\s\S]*?\.\.\.\(voice \? \{ voice \} : \{\}\)/);
  for (const mode of ['image', 'frame', 'last-frame', 'frame-pair', 'reference', 'agent']) {
    assert.throws(() => parseAuditOptions(['--mode', mode, '--voice', voice, ...(mode === 'frame' || mode === 'last-frame' || mode === 'reference' ? ['--asset', 'still.png'] : mode === 'frame-pair' ? ['--asset', 'first.png', '--asset', 'last.png'] : [])]), /only valid with text video or video-reference/);
  }
  assert.throws(() => parseAuditOptions(['--mode', 'video', '--voice']), /Missing value after --voice/);
  assert.throws(() => parseAuditOptions(['--mode', 'video', '--voice', '   ']), /must contain 1 to 120 characters/);
  assert.throws(() => parseAuditOptions(['--mode', 'video-reference', '--asset', 'still.png', '--voice', 'v'.repeat(121)]), /must contain 1 to 120 characters/);
  assert.throws(() => parseAuditOptions(['--mode', 'video', '--voice', 'Kore', '--voice', 'Aoede']), /only be supplied once/);
});

test('audit submit passes require an explicit verified quote within the configured cap', () => {
  assert.equal(assertVerifiedQuoteWithinCap({ credit_quote_verified: true, credits: 0 }, 0), true);
  assert.throws(() => assertVerifiedQuoteWithinCap({ credit_quote_verified: false, credits: 0 }, 0), /verified credit quote/);
  assert.throws(() => assertVerifiedQuoteWithinCap({ credit_quote_verified: true, credits: null }, 0), /verified credit quote/);
  assert.throws(() => assertVerifiedQuoteWithinCap({ credit_quote_verified: true, credits: 1 }, 0), /exceeds this E2E request cap/);
  assert.throws(() => assertVerifiedQuoteWithinCap({ credit_quote_verified: true, credits: 0 }, undefined), /configured non-negative credit cap/);

  assert.doesNotMatch(runner, /allow_unknown_quote/);
  assert.match(runner, /submitGeneration\(scene, label\)[\s\S]*?scene\.max_credits[\s\S]*?scene\.max_credits\);/);
  assert.match(runner, /async function submitOperation\(method, payload, label, maxCredits\)[\s\S]*?if \(!Number\.isFinite\(maxCredits\)[\s\S]*?queued = await api\(method, payload\)/);
  assert.match(runner, /if \(job\.request_dispatched === true \|\| job\.status === 'submitted'\)[\s\S]*?assertVerifiedQuoteWithinCap\(job, maxCredits\)/);
});
