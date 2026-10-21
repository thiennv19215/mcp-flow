const allowedModes = new Set([
  'readonly', 'upload', 'image', 'video', 'frame', 'last-frame', 'frame-pair', 'reference', 'video-reference',
  'edit', 'continue-exact', 'continue-likeness', 'agent', 'reangle', 'character', 'character-edit', 'create-project', 'voice-options',
]);

export function parseAuditOptions(args) {
  const options = new Map();
  const assetNames = [];
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!['--mode', '--asset', '--file', '--character-name', '--rename-character', '--voice', '--timeout-seconds', '--force-continue'].includes(key)) {
      throw new Error(`Unknown option: ${key}`);
    }
    if (key === '--force-continue') {
      if (options.has(key)) throw new Error('Option may only be supplied once: --force-continue');
      options.set(key, true);
      continue;
    }
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value after ${key}`);
    if (key === '--asset') {
      assetNames.push(value);
      continue;
    }
    if (options.has(key)) throw new Error(`Option may only be supplied once: ${key}`);
    options.set(key, value);
  }

  const mode = options.get('--mode') || 'readonly';
  if (!allowedModes.has(mode)) throw new Error(`Unknown mode "${mode}". Choose: ${[...allowedModes].join(', ')}.`);
  const filePath = options.get('--file');
  const characterName = options.get('--character-name') || `MCP Diagnostic ${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
  const renameCharacter = options.get('--rename-character');
  const voice = options.get('--voice');
  const timeoutSeconds = Number(options.get('--timeout-seconds') || 600);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 1800) {
    throw new Error('--timeout-seconds must be an integer from 30 to 1800.');
  }
  const imageAssetModes = new Set(['frame', 'last-frame', 'frame-pair', 'reference', 'video-reference', 'reangle', 'character']);
  const videoAssetModes = new Set(['edit', 'continue-exact', 'continue-likeness']);
  const characterReferenceModes = new Set(['reference', 'video-reference']);
  if (imageAssetModes.has(mode) && !assetNames.length && !characterReferenceModes.has(mode)) throw new Error(`--mode ${mode} requires --asset with the exact title of an existing Flow image.`);
  if (videoAssetModes.has(mode) && assetNames.length !== 1) throw new Error(`--mode ${mode} requires exactly one --asset with the exact title of an existing Flow video.`);
  if (mode === 'frame-pair' && assetNames.length !== 2) throw new Error('--mode frame-pair requires exactly two --asset values: first frame, then last frame.');
  if (['frame', 'last-frame', 'reangle', 'character'].includes(mode) && assetNames.length !== 1) throw new Error(`--mode ${mode} requires exactly one --asset value.`);
  if (mode === 'video-reference' && assetNames.length > 3) throw new Error('--mode video-reference accepts at most three --asset image references.');
  if (mode === 'reference' && assetNames.length > 3) throw new Error('--mode reference accepts at most three --asset image references.');
  if (mode === 'upload' && !filePath) throw new Error('--mode upload requires --file with an absolute local image or video path.');
  if (mode !== 'upload' && filePath) throw new Error('--file is only valid with --mode upload.');
  if (options.has('--voice') && !['video', 'video-reference'].includes(mode)) {
    throw new Error('--voice is only valid with text video or video-reference generation modes.');
  }
  if (options.has('--voice') && (!voice.trim() || voice.length > 120)) {
    throw new Error('--voice must contain 1 to 120 characters.');
  }
  const characterNameModes = new Set(['character', 'character-edit', 'continue-likeness', ...characterReferenceModes]);
  if (!characterNameModes.has(mode) && options.has('--character-name')) throw new Error('--character-name is not valid with this mode.');
  if (options.has('--character-name') && (characterName.length > 60 || !characterName.trim())) throw new Error('--character-name must contain 1 to 60 characters.');
  if (!['continue-exact', 'continue-likeness'].includes(mode) && options.has('--force-continue')) throw new Error('--force-continue is only valid with a continue mode.');
  if (mode === 'continue-likeness' && !options.has('--character-name')) throw new Error('--mode continue-likeness requires --character-name for an existing Flow character.');
  if (characterReferenceModes.has(mode)) {
    if (assetNames.length && options.has('--character-name')) throw new Error('Choose image --asset references or one --character-name, not both.');
    if (!assetNames.length && !options.has('--character-name')) throw new Error(`--mode ${mode} requires one to three image --asset values or --character-name.`);
  }
  if (mode === 'character-edit') {
    if (!options.has('--character-name')) throw new Error('--mode character-edit requires --character-name for the existing Flow character.');
    if (!renameCharacter) throw new Error('--mode character-edit requires --rename-character with the new name.');
    if (renameCharacter.length > 60 || !renameCharacter.trim()) throw new Error('--rename-character must contain 1 to 60 characters.');
    if (renameCharacter.trim().replace(/\s+/g, ' ').toLowerCase() === characterName.trim().replace(/\s+/g, ' ').toLowerCase()) {
      throw new Error('--rename-character must differ from --character-name.');
    }
  } else if (options.has('--rename-character')) {
    throw new Error('--rename-character is only valid with --mode character-edit.');
  }
  if (mode === 'agent' && assetNames.length) throw new Error('--asset is not used by --mode agent.');
  if (!imageAssetModes.has(mode) && !videoAssetModes.has(mode) && mode !== 'agent' && assetNames.length) throw new Error('--asset is not valid with this mode.');

  return {
    mode, assetNames, filePath, characterName, characterNameProvided: options.has('--character-name'), renameCharacter, voice, timeoutSeconds,
    forceContinue: options.has('--force-continue'),
  };
}

export function assertVerifiedQuoteWithinCap(job, maxCredits) {
  if (!Number.isFinite(maxCredits) || maxCredits < 0) {
    throw new Error('E2E submit requires a configured non-negative credit cap; nothing was submitted.');
  }
  if (job?.credit_quote_verified !== true || !Number.isFinite(job?.credits)) {
    throw new Error('Flow did not provide a verified credit quote; this E2E request cannot count as successful. Inspect Flow before retrying.');
  }
  if (job.credits > maxCredits) {
    throw new Error(`Flow's verified quote (${job.credits}) exceeds this E2E request cap (${maxCredits}); inspect Flow before retrying.`);
  }
  return true;
}
