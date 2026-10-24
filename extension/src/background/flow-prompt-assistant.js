// FEAT-14 — Prompt Assistant + image-to-prompt, LOCAL formats (study B9 /
// feature #12).
//
// The assistant mechanism with our own locally authored format set: a
// format pairs an instruction template (which demands one agreed reply
// block) with the user's idea to assemble the exact request text that a
// chat-provider session would receive; the provider's reply parses back
// into a prompt list; and an image-to-prompt reply parses into
// structured fields (subject + EN/VI recreation prompts). Everything
// here is pure text logic — the live send path (opening a provider tab
// and auto-sending) additionally waits on the ChatGPT live-DOM phase
// (GPT-B1), so this module deliberately has no send function and names
// no provider DOM. The vendor's format catalog is fetched from their
// server and stays blocked (FEAT-B3); these formats are written here,
// in the open, and the sidebar speaks to this module over the
// `flow-prompt-assistant:*` message contract.

export class PromptAssistantError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "PromptAssistantError";
    this.code = code;
  }
}

const assistantError = (message, code) => new PromptAssistantError(message, code);

const cleanText = (value, max = 4000) => String(value ?? "").trim().slice(0, max);

// The agreed reply blocks. The instruction templates demand them
// verbatim and the parsers look for exactly these markers, so a reply
// that ignores the shape is (correctly) treated as malformed.
export const PROMPTS_BLOCK_START = "<<<PROMPTS";
export const PROMPTS_BLOCK_END = "PROMPTS>>>";
export const I2P_BLOCK_START = "<<<I2P";
export const I2P_BLOCK_END = "I2P>>>";

// Locally authored format set. `instruction` is the full template sent
// ahead of the user's idea; each one demands the PROMPTS block so the
// reply parses deterministically.
export const PROMPT_ASSISTANT_FORMATS = [
  {
    id: "single-en",
    name: "Single prompt (EN)",
    instruction: [
      "You are a prompt writer for an AI image/video generator.",
      "Turn the idea below into ONE polished English prompt.",
      "Reply with exactly this block and nothing else:",
      PROMPTS_BLOCK_START,
      "1. <the prompt>",
      PROMPTS_BLOCK_END,
    ].join("\n"),
  },
  {
    id: "single-vi",
    name: "Một prompt (VI)",
    instruction: [
      "Bạn là người viết prompt cho công cụ tạo ảnh/video AI.",
      "Hãy biến ý tưởng dưới đây thành MỘT prompt tiếng Việt trau chuốt.",
      "Chỉ trả lời đúng khối sau, không thêm gì khác:",
      PROMPTS_BLOCK_START,
      "1. <prompt>",
      PROMPTS_BLOCK_END,
    ].join("\n"),
  },
  {
    id: "scenes",
    name: "Scene breakdown",
    instruction: [
      "You are a prompt writer for an AI image/video generator.",
      "Break the idea below into a sequence of scene prompts, in English.",
      "Reply with exactly this block and nothing else:",
      PROMPTS_BLOCK_START,
      "1. <scene 1 prompt>",
      "2. <scene 2 prompt>",
      PROMPTS_BLOCK_END,
    ].join("\n"),
  },
];

const FORMAT_BY_ID = new Map(PROMPT_ASSISTANT_FORMATS.map(format => [format.id, format]));

export function getPromptAssistantFormat(id) {
  const format = FORMAT_BY_ID.get(String(id ?? ""));
  if (!format) {
    throw assistantError(`Unknown prompt assistant format: ${String(id ?? "")}`, "FLOW_PROMPT_ASSISTANT_FORMAT_UNKNOWN");
  }
  return format;
}

const DEFAULT_SCENE_COUNT = 4;

// Assemble the exact request text for one assistant run: the format's
// instruction, a blank line, then the user's input lines. Options:
// `scenes` (scene count for the breakdown format), `extra` (a free
// note), `hasImage` (an image accompanies the request).
export function buildAssistantRequest({ format = "single-en", idea, options = {} } = {}) {
  const resolved = getPromptAssistantFormat(format);
  const cleanIdea = cleanText(idea);
  if (!cleanIdea) {
    throw assistantError("The prompt assistant needs an idea to work from.", "FLOW_PROMPT_ASSISTANT_IDEA_REQUIRED");
  }
  const lines = [resolved.instruction, "", `Idea: ${cleanIdea}`];
  if (resolved.id === "scenes") {
    const count = Number.isFinite(options.scenes) && options.scenes > 0
      ? Math.floor(options.scenes)
      : DEFAULT_SCENE_COUNT;
    lines.push(`Scenes: ${count}`);
  }
  const extra = cleanText(options.extra, 500);
  if (extra) lines.push(`Note: ${extra}`);
  if (options.hasImage) lines.push("An image is attached; base the result on it.");
  return { formatId: resolved.id, text: lines.join("\n") };
}

// Extract the lines of the first agreed block in a reply, or null when
// the reply carries no complete block (a malformed reply).
function extractBlock(text, start, end) {
  const source = String(text ?? "");
  const open = source.indexOf(start);
  if (open < 0) return null;
  const close = source.indexOf(end, open + start.length);
  if (close < 0) return null;
  return source.slice(open + start.length, close);
}

const LIST_PREFIX = /^(?:\d+\s*[.)]|[-*•])\s*/;

// Parse a chat reply into a prompt list. Only the PROMPTS block counts:
// numbered/bulleted lines inside it become individual prompts, prose
// around the block is ignored. A reply with no usable block yields an
// empty list and the untouched raw text, so the UI can show the user
// what actually came back instead of inventing prompts.
export function parseAssistantReply(text) {
  const raw = String(text ?? "");
  const block = extractBlock(raw, PROMPTS_BLOCK_START, PROMPTS_BLOCK_END);
  if (block === null) return { prompts: [], raw };
  const prompts = block
    .split("\n")
    .map(line => line.trim().replace(LIST_PREFIX, "").trim())
    .filter(Boolean);
  return { prompts, raw };
}

// The image-to-prompt analysis request: one locally authored template
// demanding the I2P block the parser below reads.
export function buildImageToPromptRequest({ extra } = {}) {
  const lines = [
    "Look at the attached image and describe how to recreate it.",
    "Reply with exactly this block and nothing else:",
    I2P_BLOCK_START,
    "SUBJECT: <short subject summary>",
    "PROMPT_EN: <one English recreation prompt>",
    "PROMPT_VI: <one Vietnamese recreation prompt>",
    I2P_BLOCK_END,
  ];
  const note = cleanText(extra, 500);
  if (note) lines.push(`Note: ${note}`);
  return lines.join("\n");
}

const I2P_FIELDS = [
  ["SUBJECT", "subject"],
  ["PROMPT_EN", "promptEn"],
  ["PROMPT_VI", "promptVi"],
];
const I2P_KEY_LINE = /^(SUBJECT|PROMPT_EN|PROMPT_VI)\s*:\s*(.*)$/i;

// Parse an image-to-prompt reply into structured fields. Field values
// may span several lines (continuation lines join the current field).
// Any missing field leaves the result incomplete with the raw reply
// preserved, so a partial answer degrades to showing the user the raw
// text instead of half-filled fields presented as fact.
export function parseImageToPromptReply(text) {
  const raw = String(text ?? "");
  const result = { subject: null, promptEn: null, promptVi: null, complete: false, raw };
  const block = extractBlock(raw, I2P_BLOCK_START, I2P_BLOCK_END);
  if (block === null) return result;
  const values = {};
  let current = null;
  for (const line of block.split("\n")) {
    const match = line.match(I2P_KEY_LINE);
    if (match) {
      current = I2P_FIELDS.find(([key]) => key === match[1].toUpperCase())[1];
      values[current] = match[2].trim();
    } else if (current && line.trim()) {
      values[current] = values[current] ? `${values[current]}\n${line.trim()}` : line.trim();
    }
  }
  for (const [, field] of I2P_FIELDS) {
    if (values[field]) result[field] = values[field];
  }
  result.complete = I2P_FIELDS.every(([, field]) => Boolean(result[field]));
  return result;
}
