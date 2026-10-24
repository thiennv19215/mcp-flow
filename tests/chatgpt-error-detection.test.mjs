import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// GPT-07 — ChatGPT error-pattern matcher (study behaviors B5, B10, B20 +
// session login probe; study (E) item 7).
// A local pattern table over visible page text — limit alert, challenge,
// login wall, generation-error alert — mapping matches to typed CHATGPT_*
// codes. Precedence is TABLE ORDER (limit → challenge → login →
// generation-error), never the position of the match inside the text.

const source = readFileSync(
  new URL('../extension/src/content/providers/chatgpt/generation/error-detection.js', import.meta.url),
  'utf8',
);

function loadDetection() {
  const sandbox = { console };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox.ChatGptErrorDetection;
}

test('limit alert (EN) maps to CHATGPT_LIMIT_ALERT', () => {
  const { detectError } = loadDetection();
  const result = detectError("You've reached your image creation limit. Please try again later.");
  assert.equal(result.code, 'CHATGPT_LIMIT_ALERT');
  assert.equal(result.category, 'limit');
  assert.equal(result.matchedText, "You've reached your image creation limit");
});

test('limit alert (VI) maps to CHATGPT_LIMIT_ALERT', () => {
  const { detectError } = loadDetection();
  const result = detectError('Bạn đã đạt giới hạn tạo hình ảnh. Vui lòng thử lại sau.');
  assert.equal(result.code, 'CHATGPT_LIMIT_ALERT');
  assert.equal(result.category, 'limit');
});

test('challenge (Cloudflare verify) maps to the typed challenge code', () => {
  const { detectError } = loadDetection();
  const result = detectError('Verify you are human by completing the action below.');
  assert.equal(result.code, 'CHATGPT_CHALLENGE_TIMEOUT');
  assert.equal(result.category, 'challenge');
  assert.equal(result.matchedText, 'Verify you are human');
});

test('challenge (VI reCAPTCHA) maps to the typed challenge code', () => {
  const { detectError } = loadDetection();
  const result = detectError('Tôi không phải là người máy');
  assert.equal(result.code, 'CHATGPT_CHALLENGE_TIMEOUT');
  assert.equal(result.category, 'challenge');
});

test('login wall (EN) maps to CHATGPT_NOT_LOGGED_IN', () => {
  const { detectError } = loadDetection();
  const result = detectError('Welcome back. Log in to continue.');
  assert.equal(result.code, 'CHATGPT_NOT_LOGGED_IN');
  assert.equal(result.category, 'login');
});

test('login wall (VI) maps to CHATGPT_NOT_LOGGED_IN', () => {
  const { detectError } = loadDetection();
  const result = detectError('Đăng nhập để tiếp tục sử dụng ChatGPT.');
  assert.equal(result.code, 'CHATGPT_NOT_LOGGED_IN');
  assert.equal(result.category, 'login');
});

test('generation-error alert (EN) maps to CHATGPT_GENERATION_ERROR', () => {
  const { detectError } = loadDetection();
  const result = detectError('There was an error generating a response.');
  assert.equal(result.code, 'CHATGPT_GENERATION_ERROR');
  assert.equal(result.category, 'generation-error');
});

test('generation-error alert (VI) maps to CHATGPT_GENERATION_ERROR', () => {
  const { detectError } = loadDetection();
  const result = detectError('Đã xảy ra lỗi. Vui lòng thử lại.');
  assert.equal(result.code, 'CHATGPT_GENERATION_ERROR');
  assert.equal(result.category, 'generation-error');
});

test('benign page text returns null', () => {
  const { detectError } = loadDetection();
  assert.equal(detectError('What can I help with?'), null);
  assert.equal(
    detectError('Here is a short story about a cat who learns to swim. Let me know if you want a sequel.'),
    null,
  );
  assert.equal(detectError(['New chat', 'Search chats', 'Library', 'Explain quantum computing in simple terms']), null);
});

test('precedence: limit beats challenge even when the challenge text comes first', () => {
  const { detectError } = loadDetection();
  const text = "Verify you are human. You've reached your image creation limit.";
  const result = detectError(text);
  assert.equal(result.code, 'CHATGPT_LIMIT_ALERT');
  assert.equal(result.category, 'limit');
});

test('precedence: challenge beats login wall', () => {
  const { detectError } = loadDetection();
  const result = detectError('Log in to continue. Verify you are human.');
  assert.equal(result.code, 'CHATGPT_CHALLENGE_TIMEOUT');
  assert.equal(result.category, 'challenge');
});

test('precedence: login wall beats generation-error alert', () => {
  const { detectError } = loadDetection();
  const result = detectError('Something went wrong. Log in to continue.');
  assert.equal(result.code, 'CHATGPT_NOT_LOGGED_IN');
  assert.equal(result.category, 'login');
});

test('fragment list input: a match in any fragment is detected', () => {
  const { detectError } = loadDetection();
  const result = detectError(['What can I help with?', "You've reached your image creation limit."]);
  assert.equal(result.code, 'CHATGPT_LIMIT_ALERT');
  assert.equal(result.matchedText, "You've reached your image creation limit");
});

test('matching is case-insensitive and whitespace-tolerant, matchedText keeps the page casing', () => {
  const { detectError } = loadDetection();
  const result = detectError("you've   reached\n  your IMAGE creation limit");
  assert.equal(result.code, 'CHATGPT_LIMIT_ALERT');
  assert.equal(result.matchedText, "you've reached your IMAGE creation limit");
});

test('garbage input returns null and never throws', () => {
  const { detectError } = loadDetection();
  for (const input of [null, undefined, 42, NaN, {}, [], '', '   ', [null, 42, {}, ''], Symbol('x')]) {
    assert.equal(detectError(input), null, `input ${String(input)} must yield null`);
  }
});
