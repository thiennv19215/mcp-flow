(function (root) {
  'use strict';

  // GPT-07 — ChatGPT error-pattern matcher (study behaviors B5, B10, B20 and
  // the session login probe; study (E) item 7).
  //
  // A LOCAL pattern table over visible page text. Each row maps a category
  // of product UI state to the typed CHATGPT_* error code the submit
  // pipeline distinguishes for it (the study's failure taxonomy, prefixed):
  //   limit alert           -> CHATGPT_LIMIT_ALERT      (taxonomy LIMIT_ALERT)
  //   challenge             -> CHATGPT_CHALLENGE_TIMEOUT (taxonomy
  //                            CHALLENGE_TIMEOUT — raised when a detected
  //                            challenge is not completed in the tab)
  //   login wall            -> CHATGPT_NOT_LOGGED_IN    (taxonomy
  //                            NOT_LOGGED_IN)
  //   generation-error alert -> CHATGPT_GENERATION_ERROR
  //
  // Precedence is TABLE ORDER, never the position of a match inside the
  // text: rows are scanned in the order the gap entry and study (E)7 list
  // the categories — limit, challenge, login, generation-error — and the
  // first row with any match wins, even if a lower row's text appears
  // earlier on the page.
  //
  // Patterns are the product's canonical UI strings (English + Vietnamese
  // where the product ships them). Matching is case-insensitive over
  // whitespace-collapsed text. The matcher is pure: it takes a string or a
  // list of text fragments and returns
  // { code, category, pattern, matchedText } or null; garbage input yields
  // null and never throws.

  const CODES = Object.freeze({
    limit: 'CHATGPT_LIMIT_ALERT',
    challenge: 'CHATGPT_CHALLENGE_TIMEOUT',
    login: 'CHATGPT_NOT_LOGGED_IN',
    'generation-error': 'CHATGPT_GENERATION_ERROR',
  });

  const row = (category, patterns) => Object.freeze({
    category,
    code: CODES[category],
    patterns: Object.freeze(patterns.map(([id, text]) => Object.freeze({ id, text }))),
  });

  const ERROR_PATTERN_TABLE = Object.freeze([
    row('limit', [
      ['limit/image-creation-limit-reached', "You've reached your image creation limit"],
      ['limit/image-creation-limit-reached-no-apostrophe', 'You have reached your image creation limit'],
      ['limit/limit-for-image-creation', "You've reached your limit for image creation"],
      ['limit/image-generation-limit-reached', "You've reached your image generation limit"],
      ['limit/image-creation-limit-reached-vi', 'Bạn đã đạt giới hạn tạo hình ảnh'],
      ['limit/image-creation-limit-reached-vi-den', 'Bạn đã đạt đến giới hạn tạo hình ảnh'],
      ['limit/image-creation-limit-reached-vi-short', 'Bạn đã đạt giới hạn tạo ảnh'],
    ]),
    row('challenge', [
      ['challenge/verify-you-are-human', 'Verify you are human'],
      ['challenge/verifying-you-are-human', 'Verifying you are human'],
      ['challenge/verify-that-you-are-human', 'Verify that you are human'],
      ['challenge/complete-the-security-check', 'Please complete the security check'],
      ['challenge/checking-your-browser', 'Checking your browser before accessing'],
      ['challenge/cloudflare-just-a-moment', 'Just a moment'],
      ['challenge/verify-you-are-human-vi', 'Xác minh bạn là con người'],
      ['challenge/not-a-robot-vi', 'Tôi không phải là người máy'],
    ]),
    row('login', [
      ['login/log-in-to-continue', 'Log in to continue'],
      ['login/session-expired', 'Your session has expired'],
      ['login/log-in-to-continue-vi', 'Đăng nhập để tiếp tục'],
      ['login/session-expired-vi', 'Phiên đăng nhập đã hết hạn'],
    ]),
    row('generation-error', [
      ['generation-error/error-generating-response', 'There was an error generating a response'],
      ['generation-error/something-went-wrong', 'Something went wrong'],
      ['generation-error/an-error-occurred', 'An error occurred'],
      ['generation-error/error-occurred-vi', 'Đã xảy ra lỗi'],
      ['generation-error/incident-occurred-vi', 'Đã xảy ra sự cố'],
    ]),
  ]);

  const normalize = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');

  const detectError = (input) => {
    const raw = typeof input === 'string' ? [input] : Array.isArray(input) ? input : [];
    const fragments = raw.map(normalize).filter(Boolean);
    if (!fragments.length) return null;
    const lowered = fragments.map((fragment) => fragment.toLowerCase());
    for (const tableRow of ERROR_PATTERN_TABLE) {
      for (const pattern of tableRow.patterns) {
        const needle = pattern.text.toLowerCase();
        for (let index = 0; index < fragments.length; index += 1) {
          const at = lowered[index].indexOf(needle);
          if (at === -1) continue;
          return Object.freeze({
            code: tableRow.code,
            category: tableRow.category,
            pattern: pattern.id,
            matchedText: fragments[index].slice(at, at + pattern.text.length),
          });
        }
      }
    }
    return null;
  };

  root.ChatGptErrorDetection = Object.freeze({
    detectError,
    ERROR_PATTERN_TABLE,
    CODES,
  });
})(globalThis);
