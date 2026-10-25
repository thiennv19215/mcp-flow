import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  PROMPT_ASSISTANT_FORMATS,
  PromptAssistantError,
  buildAssistantRequest,
  buildImageToPromptRequest,
  getPromptAssistantFormat,
  parseAssistantReply,
  parseImageToPromptReply,
} from '../extension/src/background/flow-prompt-assistant.js';

const sidebarSource = readFileSync(new URL('../extension/src/ui/sidebar.js', import.meta.url), 'utf8');
const sidebarHtml = readFileSync(new URL('../extension/src/ui/sidebar.html', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// FEAT-14: Prompt Assistant + image-to-prompt, LOCAL formats (study B9 /
// feature #12). The vendor format catalog stays blocked (FEAT-B3); this is
// our own locally authored format set (single prompt EN/VI, scene
// breakdown). The mechanism is pure logic: assemble a request from a
// format template + the user's idea, parse a chat reply back into a
// prompt list, and parse an image-to-prompt reply into structured fields.
// The live send path waits on the ChatGPT live-DOM phase (GPT-B1) — there
// is deliberately no send function here.
// ---------------------------------------------------------------------------

const hasCode = code => error => {
  assert.equal(error?.code, code, `expected error code ${code}, got ${error?.code} (${error?.message})`);
  return true;
};

// --- format catalog --------------------------------------------------------

test('the local format set ships single-en, single-vi and scenes', () => {
  assert.deepEqual(
    PROMPT_ASSISTANT_FORMATS.map(format => format.id),
    ['single-en', 'single-vi', 'scenes'],
  );
  for (const format of PROMPT_ASSISTANT_FORMATS) {
    assert.equal(typeof format.name, 'string');
    assert.ok(format.name.length > 0);
    assert.equal(typeof format.instruction, 'string');
    assert.ok(format.instruction.includes('<<<PROMPTS'), `${format.id} instruction must demand the agreed reply block`);
    assert.ok(format.instruction.includes('PROMPTS>>>'), `${format.id} instruction must close the agreed reply block`);
  }
});

test('getPromptAssistantFormat resolves a known id and rejects an unknown one', () => {
  assert.equal(getPromptAssistantFormat('scenes').id, 'scenes');
  assert.throws(() => getPromptAssistantFormat('vendor-catalog-thing'), error => {
    assert.ok(error instanceof PromptAssistantError);
    return hasCode('FLOW_PROMPT_ASSISTANT_FORMAT_UNKNOWN')(error);
  });
});

// --- request assembly ------------------------------------------------------

test('assembly: single-en with an idea produces the exact request text', () => {
  const request = buildAssistantRequest({ format: 'single-en', idea: 'a cat surfing at dawn' });
  assert.equal(request.formatId, 'single-en');
  assert.equal(request.text, [
    'You are a prompt writer for an AI image/video generator.',
    'Turn the idea below into ONE polished English prompt.',
    'Reply with exactly this block and nothing else:',
    '<<<PROMPTS',
    '1. <the prompt>',
    'PROMPTS>>>',
    '',
    'Idea: a cat surfing at dawn',
  ].join('\n'));
});

test('assembly: single-vi with an idea produces the exact request text', () => {
  const request = buildAssistantRequest({ format: 'single-vi', idea: 'mèo lướt sóng lúc bình minh' });
  assert.equal(request.formatId, 'single-vi');
  assert.equal(request.text, [
    'Bạn là người viết prompt cho công cụ tạo ảnh/video AI.',
    'Hãy biến ý tưởng dưới đây thành MỘT prompt tiếng Việt trau chuốt.',
    'Chỉ trả lời đúng khối sau, không thêm gì khác:',
    '<<<PROMPTS',
    '1. <prompt>',
    'PROMPTS>>>',
    '',
    'Idea: mèo lướt sóng lúc bình minh',
  ].join('\n'));
});

test('assembly: scenes defaults to 4 scenes and honours an explicit count', () => {
  const fallback = buildAssistantRequest({ format: 'scenes', idea: 'a robot learns to cook' });
  assert.ok(fallback.text.endsWith('Idea: a robot learns to cook\nScenes: 4'));
  const explicit = buildAssistantRequest({ format: 'scenes', idea: 'a robot learns to cook', options: { scenes: 3 } });
  assert.ok(explicit.text.endsWith('Idea: a robot learns to cook\nScenes: 3'));
});

test('assembly: options append a note line and an attached-image line', () => {
  const request = buildAssistantRequest({
    format: 'single-en',
    idea: 'same rider, new city',
    options: { extra: 'Keep the red jacket.', hasImage: true },
  });
  assert.ok(request.text.endsWith(
    'Idea: same rider, new city\nNote: Keep the red jacket.\nAn image is attached; base the result on it.',
  ));
});

test('assembly: an empty idea is a typed error, not a half-built request', () => {
  assert.throws(() => buildAssistantRequest({ format: 'single-en', idea: '   ' }),
    hasCode('FLOW_PROMPT_ASSISTANT_IDEA_REQUIRED'));
  assert.throws(() => buildAssistantRequest({ format: 'nope', idea: 'x' }),
    hasCode('FLOW_PROMPT_ASSISTANT_FORMAT_UNKNOWN'));
});

// --- reply parsing ---------------------------------------------------------

const cannedReply = [
  'Here is your breakdown:',
  '<<<PROMPTS',
  '1. A lighthouse keeper climbs the spiral stairs at dawn, warm lantern light',
  '2. Storm waves crash against the rocks below the lighthouse, dramatic sky',
  '3. The keeper watches the sunrise from the gallery, calm sea, hopeful mood',
  'PROMPTS>>>',
  'Hope that helps!',
].join('\n');

test('a canned chat reply in the agreed format parses to the exact prompt list', () => {
  const parsed = parseAssistantReply(cannedReply);
  assert.deepEqual(parsed.prompts, [
    'A lighthouse keeper climbs the spiral stairs at dawn, warm lantern light',
    'Storm waves crash against the rocks below the lighthouse, dramatic sky',
    'The keeper watches the sunrise from the gallery, calm sea, hopeful mood',
  ]);
  assert.equal(parsed.raw, cannedReply);
});

test('bulleted and unnumbered lines inside the block also parse', () => {
  const reply = ['<<<PROMPTS', '- first prompt', '* second prompt', 'third prompt', 'PROMPTS>>>'].join('\n');
  assert.deepEqual(parseAssistantReply(reply).prompts, ['first prompt', 'second prompt', 'third prompt']);
});

test('a malformed reply yields no prompts with the raw text preserved', () => {
  const raw = 'Sure! A great prompt would be: a cat surfing at dawn, golden light.';
  const parsed = parseAssistantReply(raw);
  assert.deepEqual(parsed.prompts, []);
  assert.equal(parsed.raw, raw);
  assert.deepEqual(parseAssistantReply('').prompts, []);
  assert.equal(parseAssistantReply('').raw, '');
});

// --- image-to-prompt -------------------------------------------------------

test('the image-to-prompt request demands the agreed structured block', () => {
  const text = buildImageToPromptRequest();
  assert.ok(text.includes('<<<I2P'));
  assert.ok(text.includes('SUBJECT:'));
  assert.ok(text.includes('PROMPT_EN:'));
  assert.ok(text.includes('PROMPT_VI:'));
  assert.ok(text.includes('I2P>>>'));
  assert.ok(buildImageToPromptRequest({ extra: 'Focus on the outfit.' })
    .endsWith('Note: Focus on the outfit.'));
});

const cannedI2p = [
  '<<<I2P',
  'SUBJECT: A street vendor selling flowers from a bicycle in the morning',
  'PROMPT_EN: A street vendor arranging colorful flowers on a bicycle at dawn, soft morning light, photorealistic',
  'PROMPT_VI: Một người bán hoa rong sắp xếp những bông hoa rực rỡ trên xe đạp lúc bình minh, ánh sáng dịu, chân thực',
  'I2P>>>',
].join('\n');

test('the i2p structured parse extracts EN/VI recreation prompts + subject', () => {
  const parsed = parseImageToPromptReply(cannedI2p);
  assert.equal(parsed.subject, 'A street vendor selling flowers from a bicycle in the morning');
  assert.equal(parsed.promptEn, 'A street vendor arranging colorful flowers on a bicycle at dawn, soft morning light, photorealistic');
  assert.equal(parsed.promptVi, 'Một người bán hoa rong sắp xếp những bông hoa rực rỡ trên xe đạp lúc bình minh, ánh sáng dịu, chân thực');
  assert.equal(parsed.complete, true);
});

test('the i2p parse keeps multi-line field values together', () => {
  const reply = [
    '<<<I2P',
    'SUBJECT: Night market stall',
    'PROMPT_EN: A bustling night market stall,',
    'steam rising from noodle bowls, neon signs',
    'PROMPT_VI: Một quầy hàng chợ đêm nhộn nhịp, hơi bốc lên từ những tô mì, biển neon',
    'I2P>>>',
  ].join('\n');
  const parsed = parseImageToPromptReply(reply);
  assert.equal(parsed.promptEn, 'A bustling night market stall,\nsteam rising from noodle bowls, neon signs');
  assert.equal(parsed.complete, true);
});

test('an i2p reply with a missing field degrades to the raw text', () => {
  const reply = ['<<<I2P', 'SUBJECT: A paper boat', 'PROMPT_EN: A paper boat on a puddle', 'I2P>>>'].join('\n');
  const parsed = parseImageToPromptReply(reply);
  assert.equal(parsed.subject, 'A paper boat');
  assert.equal(parsed.promptEn, 'A paper boat on a puddle');
  assert.equal(parsed.promptVi, null);
  assert.equal(parsed.complete, false);
  assert.equal(parsed.raw, reply);
});

test('an unstructured i2p reply yields no fields with the raw text preserved', () => {
  const raw = 'The image shows a lovely paper boat floating on a puddle after rain.';
  const parsed = parseImageToPromptReply(raw);
  assert.deepEqual(
    { subject: parsed.subject, promptEn: parsed.promptEn, promptVi: parsed.promptVi, complete: parsed.complete },
    { subject: null, promptEn: null, promptVi: null, complete: false },
  );
  assert.equal(parsed.raw, raw);
});

// --- sidebar surface contract ----------------------------------------------

test('the sidebar omits the prompt toolbar and Prompt Assistant surface', () => {
  for (const id of ['promptSearchBtn', 'chatAIBtn', 'importTxtBtn', 'promptCharCount', 'promptSaveBtn', 'promptAssistantPanel', 'paFormat', 'paIdea', 'paBuildBtn', 'paRequest', 'paReply', 'paParseBtn', 'paPromptList', 'paI2pReply', 'paI2pParseBtn', 'paI2pResult']) {
    assert.ok(!sidebarHtml.includes(`id="${id}"`), `sidebar.html must omit #${id}`);
  }
  assert.ok(!sidebarHtml.includes('class="prompt-editor-toolbar"'), 'sidebar.html must omit the prompt toolbar');
  assert.ok(!sidebarSource.includes('flow-prompt-assistant:'), 'sidebar.js must not bind the removed Prompt Assistant surface');
});
