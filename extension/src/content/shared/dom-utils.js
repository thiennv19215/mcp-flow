function visible(el) {
  const r = el.getBoundingClientRect();
  const s = getComputedStyle(el);
  return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
}

function accessibleName(el) {
  if (!el) return "";
  const labels = el.labels ? [...el.labels].map(l => l.innerText).join(" ") : "";
  const labelledBy = (el.getAttribute?.("aria-labelledby") || "").split(/\s+/).filter(Boolean).map(id => document.getElementById?.(id)?.innerText || document.getElementById?.(id)?.textContent || "").join(" ").trim();
  return el.getAttribute?.("aria-label") || labelledBy || el.getAttribute?.("title") || el.getAttribute?.("alt") || labels || el.getAttribute?.("placeholder") || el.innerText || el.textContent || "";
}

function semanticActionText(el) {
  if (!el) return "";
  const labels = el.labels ? [...el.labels].map(label => label.innerText || label.textContent || "").join(" ").trim() : "";
  const labelledBy = (el.getAttribute?.("aria-labelledby") || "").split(/\s+/).filter(Boolean)
    .map(id => document.getElementById?.(id)?.innerText || document.getElementById?.(id)?.textContent || "").join(" ").trim();
  const explicit = el.getAttribute?.("aria-label") || labelledBy || el.getAttribute?.("title") || labels || el.getAttribute?.("alt") || (typeof el.name === "string" ? el.name : "");
  if (explicit) return explicit;
  if (typeof document.createTreeWalker !== "function" || typeof NodeFilter === "undefined") {
    return el.innerText || el.textContent || (typeof el.name === "string" ? el.name : "") || "";
  }
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const text = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    let parent = node.parentElement;
    let hidden = false;
    while (parent && el.contains(parent)) {
      if (parent.getAttribute?.("aria-hidden") === "true") { hidden = true; break; }
      if (parent === el) break;
      parent = parent.parentElement;
    }
    if (!hidden) text.push(node.nodeValue || "");
  }
  return text.join(" ").replace(/\s+/g, " ").trim();
}

function matchesName(value, expected, regex, exact) {
  if (regex?.__regexp || regex?.source) { try { return new RegExp(regex.source, regex.flags).test(value) || matchesFlowUiRegex(value, regex); } catch {} }
  if (expected === undefined) return true;
  const actual = normalizeFlowUiText(value);
  const wanted = normalizeFlowUiText(expected);
  return exact ? actual === wanted : actual.includes(wanted);
}

function mediaId(tile) {
  const mediaNodes = [...tile.querySelectorAll("img,video")];
  const directId = mediaNodes.map(media => media.getAttribute("data-media-id")).find(Boolean);
  const sources = mediaNodes.map(media => media.currentSrc || media.getAttribute("src") || "").filter(Boolean);
  const asbId = sources.map(src => {
    try {
      const url = new URL(src, location.href);
      if (url.origin !== location.origin || !url.pathname.startsWith("/asb/")) return null;
      return url.pathname.slice("/asb/".length).replace(/=(?:s\d+(?:-[a-z]+)*|mm,\d+,\d+)$/i, "");
    } catch { return null; }
  }).find(Boolean);
  const uuid = sources.map(src => src.match(/[0-9a-f]{8}-[0-9a-f-]{27}/i)?.[0]).find(Boolean);
  const id = directId || (asbId ? `asb:${asbId}` : null) || uuid;
  if (id) return id;
  const title = tile.getAttribute("aria-label");
  return title ? `title:${title}` : undefined;
}

function isFlowMediaSource(value) {
  try {
    const url = new URL(value, location.href);
    if (url.protocol === "blob:") return url.origin === location.origin;
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return host === "flow.google.com" || host === "flow-content.google" || host === "labs.google" ||
      host === "aisandbox-pa.googleapis.com" || host === "googleusercontent.com" || host.endsWith(".googleusercontent.com");
  } catch { return false; }
}

var nativeUploadAssemblers = globalThis.nativeUploadAssemblers || (globalThis.nativeUploadAssemblers = new Map());
var stagedNativeFiles = globalThis.stagedNativeFiles || (globalThis.stagedNativeFiles = new Map());

function validStagedLocalImage(value, suffixPattern) {
  return Boolean(value && typeof value.transferId === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value.transferId) && stagedNativeFiles.has(value.transferId) &&
    typeof value.name === "string" && new RegExp(`^fm-[A-Za-z0-9_-]{1,32}-${suffixPattern.source}\\.(?:png|jpe?g|webp|gif|heic|heif|avif)$`, "i").test(value.name));
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Flow may expose Vietnamese labels with inconsistent accents or Unicode
// composition. Fold those differences while keeping caller match boundaries.
function normalizeFlowUiText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, match => match === "Đ" ? "D" : "d")
    .replace(/[\u200B\u200C\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("vi");
}

function matchesFlowUiRegex(value, regex) {
  if (!regex?.source) return false;
  try {
    if (new RegExp(regex.source, regex.flags).test(value)) return true;
    return new RegExp(normalizeFlowUiText(regex.source), regex.flags)
      .test(normalizeFlowUiText(value));
  } catch {
    return false;
  }
}

function flowError(code, message, retryable = false, outcomeUnknown = false) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  error.outcome_unknown = outcomeUnknown;
  return error;
}

function classifyFlowError(rawText) {
  if (!rawText || typeof rawText !== "string") return null;
  const text = rawText.trim();
  const foldedText = normalizeFlowUiText(text);
  const searchableText = `${text}\n${foldedText}`;

  // Flow can render a missing-prompt validation response as a gallery tile.
  // Catch it before generation observation mistakes that tile for downloadable media.
  if (/missing text or image prompt/i.test(searchableText)) {
    return {
      category: "prompt_validation",
      code: "FLOW_PROMPT_MISSING",
      message: `Flow rejected this generation because it did not receive a text or image prompt: ${text}. Check the task prompt and attached reference image before retrying.`,
      retryable: false,
    };
  }

  // 1. Quota / Credits
  if (/(?:PUBLIC_ERROR_USER_QUOTA_REACHED|quota_exceeded|per_model_daily|tier_restricted|credit limit|insufficient credits|not enough credits|out of credits|daily generation limit|khong du (?:credit|tin dung|diem tin dung)|het (?:han muc|tin dung|luot tao)|vuot(?: qua)? han muc(?: tao)?|gioi han tao hang ngay)/i.test(searchableText)) {
    return {
      category: "quota",
      code: "FLOW_QUOTA_EXCEEDED",
      message: `Flow quota/credits exceeded: ${text}`,
      retryable: false,
    };
  }

  // 2. Unusual Activity / Captcha / Bot Detection
  if (/(?:PUBLIC_ERROR_UNUSUAL_ACTIVITY|UNUSUAL_ACTIVITY|bot_detected|captcha_failed|unusual activity|extensions that modify the page|suspicious activity|hoạt động bất thường|tiện ích trình duyệt sửa đổi trang)/i.test(searchableText)) {
    return {
      category: "captcha",
      code: "FLOW_UNUSUAL_ACTIVITY",
      message: `Flow detected unusual activity or requires captcha verification: "${text}". Automatic retries halted to protect your account. Please complete verification directly on the Flow tab.`,
      retryable: false,
    };
  }

  // 3. Safety / Policy Violation
  if (/(?:SEXUALLY_EXPLICIT|CHILD_SAFETY|CONTENT_BLOCKED|policy violation|safety guidelines|harmful content|unable to generate this prompt|vi pham (?:chinh sach|nguyen tac)|chinh sach an toan|noi dung khong an toan|khong the tao (?:noi dung|hinh anh|video) nay|cau lenh khong hop le)/i.test(searchableText)) {
    return {
      category: "policy",
      code: "FLOW_POLICY_VIOLATION",
      message: `Flow safety policy blocked this generation: ${text}. Retrying with the same prompt will fail.`,
      retryable: false,
    };
  }

  // 4. Rate limit
  if (/(?:RATE_LIMIT|RESOURCE_EXHAUSTED|too many requests|try again in a few moments|gioi han (?:tan suat|yeu cau)|qua nhieu yeu cau|thu lai sau(?: vai phut| it phut)?|he thong dang ban)/i.test(searchableText)) {
    return {
      category: "rate_limit",
      code: "FLOW_RATE_LIMIT",
      message: `Flow rate limited: ${text}. Please wait before submitting again.`,
      retryable: true,
    };
  }

  // 5. Expired sign-in/session. This is recoverable after the user signs in again,
  // but automation must not keep retrying against an unavailable account.
  if (/(?:UNAUTHENTICATED|AUTH_REQUIRED|login required|sign in to continue|session expired|not signed in|authentication required|vui long dang nhap|hay dang nhap|can dang nhap|phien dang nhap het han|chua dang nhap|yeu cau dang nhap)/i.test(searchableText)) {
    return {
      category: "session",
      code: "FLOW_SESSION_REQUIRED",
      message: `Flow sign-in is required: ${text}. Sign in on the Flow tab, then retry the job.`,
      retryable: false,
    };
  }

  // 6. Media delivery failures happen after generation. Retrying the whole job can
  // create and charge for a duplicate, so surface these separately from render errors.
  if (/(?:download failed|download unavailable|media url|media download|failed to fetch media)/i.test(text)) {
    return {
      category: "download",
      code: "FLOW_DOWNLOAD_FAILED",
      message: `Flow generated the media but it could not be downloaded: ${text}. The result remains in the Flow project.`,
      retryable: false,
    };
  }

  return null;
}

var BUTTON_SYNONYMS = {
  "settings trigger": ["settings trigger", "cài đặt", "kích hoạt cài đặt", "cài đặt tham số", "tune", "settings"],
  "start generation": ["start generation", "bắt đầu tạo", "tạo video", "tạo ảnh", "tạo hình ảnh", "tạo", "generate", "create"],
  "clear prompt": ["clear prompt", "xóa câu lệnh", "xóa lời nhắc", "xóa văn bản", "xóa prompt", "clear text"],
  "add ingredients to the prompt box": [
    "add ingredients to the prompt box", "thêm thành phần vào hộp câu lệnh", "thêm thành phần vào hộp lời nhắc",
    "thêm thành phần", "thêm nguyên liệu", "add ingredients", "add media", "thêm nội dung nghe nhìn", "thêm tệp"
  ],
  "add to prompt": ["add to prompt", "thêm vào câu lệnh", "thêm vào lời nhắc", "thêm vào lời nhắc văn bản", "thêm vào prompt"],
  "add media": ["add media", "thêm nội dung nghe nhìn", "thêm tệp", "thêm phương tiện", "thêm ảnh"],
  "start": ["start frame", "khung bắt đầu", "khung đầu", "bắt đầu", "start"],
  "end": ["end frame", "khung kết thúc", "khung cuối", "kết thúc", "end"],
  "go back": ["go back", "back", "quay lại", "quay về", "trở lại", "nút quay lại"],
  "back": ["back", "go back", "quay lại", "quay về", "back button to go to previous page", "nút quay lại"],
  "done": ["done editing", "done", "xong", "hoàn tất", "xong việc chỉnh sửa", "xong chỉnh sửa"],
  "done editing": ["done editing", "done", "xong", "hoàn tất"],
  "close": ["close", "đóng", "dismiss", "got it", "bỏ qua", "đóng lại"],
  "cancel": ["cancel", "hủy", "hủy bỏ"],
  "save": ["save", "lưu", "áp dụng", "lưu lại"],
  "more options": ["more options", "tùy chọn khác", "tác vụ khác", "thêm tùy chọn", "các tùy chọn khác", "menu tùy chọn"],
  "download scene": ["download scene", "tải xuống cảnh", "tải cảnh"],
  "download image": ["download image", "tải xuống hình ảnh", "tải xuống ảnh", "tải ảnh", "tải hình ảnh"],
  "download video": ["download video", "tải xuống video", "tải video"],
  "reuse prompt": ["reuse prompt", "sử dụng lại câu lệnh", "dùng lại lời nhắc", "dùng lại câu lệnh", "sử dụng lại lời nhắc"],
  "start new session": ["start new session", "bắt đầu phiên mới", "phiên mới"],
  "account details": ["account details", "chi tiết tài khoản", "tài khoản"],
  "close account panel": ["close account panel", "đóng bảng tài khoản", "đóng tài khoản"],
  "add media menu": ["add media menu", "thêm nội dung nghe nhìn", "menu thêm tệp", "thêm tệp", "add media"],
  "skip to next clip": ["skip to next clip", "chuyển đến đoạn video tiếp theo", "bỏ qua đến clip tiếp theo", "clip tiếp theo"],
  "save frame": ["save frame", "lưu khung hình", "lưu khung ảnh", "lưu khung"],
  "animate": ["animate", "tạo hiệu ứng động", "làm chuyển động", "tạo animation"],
  "agent": ["agent", "trợ lý"],
  "select a voice": ["select a voice", "chọn giọng nói", "giọng nói", "chọn một giọng nói"],
  "add to character": ["add to character", "thêm vào nhân vật", "thêm giọng nói vào nhân vật", "thêm giọng nói"],
  "add from project": ["add from project", "thêm từ dự án", "chọn từ dự án", "từ dự án"],
  "upload": ["upload", "tải lên", "tải tệp lên", "tải lên tệp", "tải ảnh lên", "tải hình ảnh lên", "tải phương tiện lên"],
  "upload file": ["upload file", "tải tệp lên", "tải lên tệp", "tải tệp"],
  "continue": ["continue", "tiếp tục"],
  "confirm": ["confirm", "xác nhận", "đồng ý"],
  "rename": ["rename", "đổi tên", "đổi tên tệp", "đổi tên nội dung"],
  "move to trash": ["move to trash", "chuyển vào thùng rác", "đưa vào thùng rác", "bỏ vào thùng rác"],
};

function flowButton(name, root = document) {
  const normName = String(name || "").trim().toLowerCase();
  const candidates = [...root.querySelectorAll('button,[role="button"]')].filter(visible);
  
  // 1. Direct match: so khớp chính xác tên truyền vào
  const direct = candidates.find(el =>
    matchesName(semanticActionText(el).replace(/\s+/g, " ").trim(), name, null, true));
  if (direct) return direct;

  const synonyms = (globalThis.I18n?.getPatterns?.(normName)?.length ? globalThis.I18n.getPatterns(normName) : BUTTON_SYNONYMS[normName]);
  if (!synonyms || !synonyms.length) return null;

  // Helper để lấy text sạch không dính icon ligatures
  const getCleanTexts = el => {
    const rawText = semanticActionText(el).replace(/\s+/g, " ").trim().toLowerCase();
    const rawAria = (accessibleName(el) || "").replace(/\s+/g, " ").trim().toLowerCase();
    const rawInner = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
    const icon = el.querySelector?.("mat-icon, .mat-icon, .google-symbols, svg")?.textContent?.trim()?.toLowerCase() || "";
    
    // Tách bỏ tên icon ligature nếu bị dính vào đầu hoặc cuối text
    const cleanText = icon ? rawText.replace(new RegExp(`^${icon}\\s*|\\s*${icon}$`, "i"), "").trim() : rawText;
    const cleanAria = icon ? rawAria.replace(new RegExp(`^${icon}\\s*|\\s*${icon}$`, "i"), "").trim() : rawAria;
    const cleanInner = icon ? rawInner.replace(new RegExp(`^${icon}\\s*|\\s*${icon}$`, "i"), "").trim() : rawInner;

    return { rawText, rawAria, rawInner, cleanText, cleanAria, cleanInner, icon };
  };

  // PASS 1: So khớp CHÍNH XÁC (Exact match toàn bộ chuỗi) - Ngăn chặn 100% click nhầm DOM
  for (const el of candidates) {
    const { rawText, rawAria, rawInner, cleanText, cleanAria, cleanInner } = getCleanTexts(el);
    for (const syn of synonyms) {
      const wanted = normalizeFlowUiText(syn);
      if ([rawText, rawAria, rawInner, cleanText, cleanAria, cleanInner]
        .some(value => normalizeFlowUiText(value) === wanted)) {
        return el;
      }
    }
  }

  // PASS 2: Phục hồi bằng Icon đặc trưng của Flow
  for (const el of candidates) {
    const { icon } = getCleanTexts(el);
    if (!icon) continue;

    if (normName === "settings trigger" && (icon === "tune" || icon === "settings")) return el;
    if (normName === "more options" && (icon === "more_vert" || icon === "more_horiz")) return el;
    if ((normName === "back" || normName === "go back") && (icon === "arrow_back" || icon === "arrow-back" || icon === "arrow_left")) return el;
    if (normName === "close" && (icon === "close" || icon === "clear")) return el;
    if ((normName === "add ingredients to the prompt box" || normName === "add media menu" || normName === "add media") &&
        (icon === "add" || icon === "add_circle") && !isFlowProjectNavigationControl(el)) return el;
    if (normName === "download scene" || normName === "download image" || normName === "download video") {
      if (icon === "download" || icon === "file_download") return el;
    }
  }

  // PASS 3: So khớp Cụm từ an toàn (CHỈ áp dụng cho từ có dấu cách hoặc dài >= 6 ký tự)
  for (const el of candidates) {
    const { rawText, rawAria, cleanText, cleanAria } = getCleanTexts(el);
    for (const syn of synonyms) {
      if (syn.includes(" ") || syn.length >= 6) {
        const wanted = normalizeFlowUiText(syn);
        // Starts with hoặc ends with có khoảng cách ranh giới từ
        if ([rawText, rawAria, cleanText, cleanAria].some(value => {
          const folded = normalizeFlowUiText(value);
          return folded.startsWith(wanted + " ") || folded.endsWith(" " + wanted);
        })) {
          return el;
        }
        // Substring includes CHỈ cho cụm từ dài >= 8 ký tự (ví dụ: "bắt đầu tạo", "thêm thành phần vào hộp câu lệnh")
        if (syn.length >= 8 && [rawText, rawAria, cleanText, cleanAria]
          .some(value => normalizeFlowUiText(value).includes(wanted))) {
          return el;
        }
      }
    }
  }

  return null;
}

async function waitForEnabledFlowButton(name, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const button = flowButton(name);
    if (button && !button.disabled && button.getAttribute("aria-disabled") !== "true") return button;
    await wait(150);
  }
  return null;
}

function isFlowProjectNavigationControl(el) {
  if (!el || typeof el.closest !== "function") return false;
  if (el.closest('nav, [role="navigation"], header, [role="banner"], mat-toolbar, aside, mat-sidenav, flow-navigation, [class*="sidebar"], [class*="drawer"], flow-library, [class*="media-gallery"], [class*="media-list"]')) return true;
  for (let parent = el; parent && parent !== document.body; parent = parent.parentElement) {
    const aria = parent.getAttribute?.("aria-label") || "";
    if (/project navigation|điều hướng dự án|thư viện|library|bộ sưu tập|tất cả nội dung|danh sách tệp/i.test(aria)) return true;
  }
  return false;
}

function normalizeAspectRatio(input) {
  if (!input) return null;
  const s = String(input).trim().toLowerCase();
  const map = {
    "9:16": "9:16", "dọc": "9:16", "doc": "9:16", "story": "9:16", "portrait": "9:16", "vertical": "9:16",
    "16:9": "16:9", "ngang": "16:9", "widescreen": "16:9", "landscape": "16:9", "horizontal": "16:9",
    "1:1": "1:1", "vuông": "1:1", "vuong": "1:1", "square": "1:1",
    "4:3": "4:3", "3:4": "3:4", "21:9": "21:9"
  };
  return map[s] || s;
}

var OPTION_ALIASES = {
  video: ["video", "clip"],
  image: ["image", "hình ảnh", "ảnh", "photo"],
  ingredients: ["ingredients", "thành phần", "nguyên liệu", "ingredient"],
  frames: ["frames", "khung hình", "khung ảnh", "khung", "frame"],
};

function flowRadio(name) {
  const wanted = String(name || "").trim().toLowerCase();
  const normalizedWanted = normalizeAspectRatio(wanted);
  const aliases = (globalThis.I18n?.getPatterns?.(wanted)?.length ? globalThis.I18n.getPatterns(wanted) : OPTION_ALIASES[wanted]) || (normalizedWanted ? [wanted, normalizedWanted] : [wanted]);
  
  // Hỗ trợ thêm biến thể số lượng output x1, x2, x3, x4 trong tiếng Việt
  const variantMatch = wanted.match(/^x([1-4])$/);
  const variantNum = variantMatch ? variantMatch[1] : null;

  return [...document.querySelectorAll('[role="radio"],mat-radio-button,[role="tab"]')].find(el => {
    if (!visible(el) || isFlowProjectNavigationControl(el)) return false;
    const label = normalizeFlowUiText(accessibleName(el));
    const inner = normalizeFlowUiText(el.innerText || el.textContent || "");
    const labels = [label, inner];
    if (aliases.some(alias => {
      const a = normalizeFlowUiText(alias);
      return labels.some(value => value === a || value.endsWith(` ${a}`) || value.startsWith(`${a} `));
    })) return true;
    const foldedWanted = normalizeFlowUiText(normalizedWanted);
    if (foldedWanted && labels.some(value => value === foldedWanted || value.includes(foldedWanted))) return true;
    
    if (variantNum) {
      if (label === `x${variantNum}` || inner === `x${variantNum}` || label === variantNum || inner === variantNum) return true;
      if (label.includes(`${variantNum} ket qua`) || inner.includes(`${variantNum} ket qua`)) return true;
      if (label.includes(`${variantNum} bien the`) || inner.includes(`${variantNum} bien the`)) return true;
      if (label.includes(`${variantNum} anh`) || inner.includes(`${variantNum} anh`)) return true;
      if (label.includes(`${variantNum} hinh anh`) || inner.includes(`${variantNum} hinh anh`)) return true;
      if (label.includes(`${variantNum} video`) || inner.includes(`${variantNum} video`)) return true;
    }

    return matchesName(accessibleName(el).replace(/\s+/g, " ").trim(), name, null, true) ||
      matchesName((el.innerText || el.textContent || "").replace(/\s+/g, " ").trim(), name, null, true);
  });
}

function flowOption(name) {
  const expected = String(name).replace(/\s+/g, " ").trim().toLowerCase();
  const normalizedExpected = normalizeAspectRatio(expected);
  const aliases = (globalThis.I18n?.getPatterns?.(expected)?.length ? globalThis.I18n.getPatterns(expected) : OPTION_ALIASES[expected]) || (normalizedExpected ? [expected, normalizedExpected] : [expected]);
  const settingsTrigger = flowButton("Settings trigger");
  
  const variantMatch = expected.match(/^x([1-4])$/);
  const variantNum = variantMatch ? variantMatch[1] : null;

  return [...document.querySelectorAll('[role="radio"],mat-radio-button,[role="tab"],[role="option"],button,[role="button"]')].find(el => {
    const label = normalizeFlowUiText(accessibleName(el));
    const inner = normalizeFlowUiText(el.innerText || el.textContent || "");
    if (!visible(el) || el === settingsTrigger || isFlowProjectNavigationControl(el)) return false;

    const labels = [label, inner];
    if (aliases.some(alias => {
      const a = normalizeFlowUiText(alias);
      return labels.some(value => value === a || value.endsWith(` ${a}`) || value.startsWith(`${a} `));
    })) return true;
    const foldedExpected = normalizeFlowUiText(normalizedExpected);
    if (foldedExpected && labels.some(value => value === foldedExpected || value.includes(foldedExpected))) return true;
    
    if (variantNum) {
      if (label === `x${variantNum}` || inner === `x${variantNum}` || label === variantNum || inner === variantNum) return true;
      if (label.includes(`${variantNum} ket qua`) || inner.includes(`${variantNum} ket qua`)) return true;
      if (label.includes(`${variantNum} bien the`) || inner.includes(`${variantNum} bien the`)) return true;
      if (label.includes(`${variantNum} anh`) || inner.includes(`${variantNum} anh`)) return true;
      if (label.includes(`${variantNum} hinh anh`) || inner.includes(`${variantNum} hinh anh`)) return true;
      if (label.includes(`${variantNum} video`) || inner.includes(`${variantNum} video`)) return true;
    }

    return false;
  });
}

function nativeRadioMatching(predicate) {
  return [...document.querySelectorAll('[role="radio"],mat-radio-button')].find(el =>
    visible(el) && predicate(accessibleName(el).replace(/\s+/g, " ").trim()));
}

function nativeRadioSelected(radio) {
  if (!radio) return false;
  const stateControl = radio.closest('[role="radio"],[role="tab"],[role="option"],[aria-checked],[aria-pressed],[aria-selected],mat-radio-button,mat-button-toggle') || radio;
  const controls = stateControl === radio ? [radio] : [radio, stateControl];
  return controls.some(control =>
    control.getAttribute("aria-checked") === "true" ||
    control.getAttribute("aria-pressed") === "true" ||
    control.getAttribute("aria-selected") === "true" ||
    control.getAttribute("data-selected") === "true" ||
    control.getAttribute("data-state") === "checked" ||
    control.getAttribute("data-state") === "active" ||
    [...control.classList].some(className => /(?:^|[-_])(?:checked|selected|active|activated)(?:$|[-_])/i.test(className))
  ) || Boolean(stateControl.querySelector('input[type="radio"]:checked,input[type="checkbox"]:checked,[aria-checked="true"],[aria-pressed="true"],[aria-selected="true"],[data-state="checked"]'));
}

function scrollContainer() {
  const preferred = document.querySelector(".page-container");
  if (preferred) return preferred;
  return [...document.querySelectorAll("*")].find(el => el.scrollHeight > el.clientHeight + 8 && el.clientHeight > 100) || null;
}

function setEditable(el, value) {
  el.focus();
  if (el.isContentEditable) el.textContent = value;
  else {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  }
  el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function replaceNativeEditableText(el, value) {
  const text = String(value || "");
  if (!el) return false;
  el.focus();
  if (el.isContentEditable) {
    try {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.execCommand("insertText", false, text);
    } catch {}
    const normalize = input => String(input || "").replace(/[\u200B\u200C\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim();
    if (normalize(el.innerText || el.textContent) !== normalize(text)) setEditable(el, text);
  } else {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, text);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  return String(el.innerText || el.textContent || el.value || "").includes(text);
}

function getEditorUserText(editor) {
  if (!editor) return "";
  if (!editor.isContentEditable) {
    return String(editor.value || editor.textContent || "").replace(/[\u200B\u200C\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim();
  }
  const chunks = [];
  const blockTags = new Set(["P", "DIV", "LI", "UL", "OL", "BLOCKQUOTE", "PRE"]);
  const visit = node => {
    if (node.nodeType === 3 /* TEXT_NODE */) {
      chunks.push(node.nodeValue || "");
      return;
    }
    if (node.nodeType !== 1 /* ELEMENT_NODE */) return;
    const element = node;
    // Bỏ qua các inline chip nhân vật, tham chiếu, mention có contenteditable="false"
    if (element.getAttribute?.("contenteditable") === "false") return;
    if (element.tagName === "BR") {
      chunks.push("\n");
      return;
    }
    const isBlock = blockTags.has(element.tagName);
    if (isBlock && chunks.length && !String(chunks[chunks.length - 1]).endsWith("\n")) chunks.push("\n");
    for (const child of element.childNodes || []) visit(child);
    if (isBlock && !String(chunks[chunks.length - 1] || "").endsWith("\n")) chunks.push("\n");
  };
  visit(editor);
  return chunks.join("").replace(/[\u200B\u200C\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim();
}

function countInlineChips(editor) {
  if (!editor || !editor.querySelectorAll) return 0;
  return editor.querySelectorAll('[contenteditable="false"]').length;
}

async function clearEditorTextPreservingChips(editor) {
  if (!editor?.isContentEditable) return false;
  
  const chipCount = countInlineChips(editor);
  const currentText = getEditorUserText(editor);
  if (!currentText) return true;

  editor.focus?.();
  const selection = typeof window !== "undefined" ? window.getSelection?.() : null;

  if (chipCount === 0) {
    try {
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.execCommand("delete", false);
      selection?.removeAllRanges();
    } catch {}
    await wait(50);
    if (getEditorUserText(editor)) {
      try {
        document.execCommand("selectAll", false);
        document.execCommand("delete", false);
      } catch {}
      await wait(50);
    }
    return !getEditorUserText(editor);
  }

  // Khi có chips: xóa các text node tự do mà giữ nguyên các thẻ chip [contenteditable="false"]
  const textNodesToDelete = [];
  const SHOW_TEXT = typeof NodeFilter !== "undefined" ? NodeFilter.SHOW_TEXT : 4;
  const FILTER_ACCEPT = typeof NodeFilter !== "undefined" ? NodeFilter.FILTER_ACCEPT : 1;
  const FILTER_REJECT = typeof NodeFilter !== "undefined" ? NodeFilter.FILTER_REJECT : 2;
  const FILTER_SKIP = typeof NodeFilter !== "undefined" ? NodeFilter.FILTER_SKIP : 3;

  if (typeof document.createTreeWalker === "function") {
    try {
      const walker = document.createTreeWalker(editor, SHOW_TEXT, {
        acceptNode: node => {
          if (node.parentElement?.closest?.('[contenteditable="false"]')) return FILTER_REJECT;
          if ((node.nodeValue || "").replace(/[\u200B\u200C\u200D\uFEFF]/g, "").trim().length > 0) {
            return FILTER_ACCEPT;
          }
          return FILTER_SKIP;
        }
      });
      while (walker.nextNode()) textNodesToDelete.push(walker.currentNode);
    } catch {}
  }

  if (!textNodesToDelete.length) {
    const collectTextNodes = node => {
      if (!node) return;
      if (node.nodeType === 3) {
        if (!node.parentElement?.closest?.('[contenteditable="false"]')) textNodesToDelete.push(node);
        return;
      }
      if (node.getAttribute?.("contenteditable") === "false") return;
      for (const child of node.childNodes || []) collectTextNodes(child);
    };
    collectTextNodes(editor);
  }

  for (const textNode of textNodesToDelete) {
    try {
      const range = document.createRange();
      range.selectNode(textNode);
      selection?.removeAllRanges?.();
      selection?.addRange?.(range);
      document.execCommand?.("delete", false);
    } catch {}
    textNode.nodeValue = "";
  }

  selection?.removeAllRanges?.();
  await wait(50);
  try {
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
  } catch {}
  return !getEditorUserText(editor);
}

function dispatchEscapeKey() {
  const eventInit = { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true };
  document.dispatchEvent(new KeyboardEvent("keydown", eventInit));
  document.dispatchEvent(new KeyboardEvent("keyup", eventInit));
}

async function dismissBlockingOverlays() {
  let dismissedAny = false;

  const isSettingsDialog = el => {
    if (!el) return false;
    if (el.querySelector?.('button[id*="-trigger-"]')) return true;
    const radios = [...(el.querySelectorAll?.('[role="radio"], mat-radio-button') || [])];
    return radios.some(r => /image|video|9:16|16:9/i.test(accessibleName(r)));
  };

  const dialogs = [...document.querySelectorAll('[role="dialog"], mat-dialog-container, flow-dialog, [aria-modal="true"]')].filter(visible);
  for (const dialog of dialogs) {
    if (isSettingsDialog(dialog)) continue;
    const closeBtn = [...dialog.querySelectorAll('button, [role="button"]')].find(btn => {
      if (!visible(btn)) return false;
    const label = normalizeFlowUiText(accessibleName(btn) || btn.innerText || btn.textContent || "");
      const hasCloseIcon = [...btn.querySelectorAll('mat-icon')].some(icon => /close|clear/i.test((icon.innerText || icon.textContent || "").trim()));
      return hasCloseIcon || /^(?:close|dong|dismiss|got it|cancel|huy)$/.test(label) || label.includes("close") || label.includes("dong");
    });

    if (closeBtn) {
      closeBtn.click();
      dismissedAny = true;
      await wait(150);
    } else {
      dispatchEscapeKey();
      dismissedAny = true;
      await wait(150);
    }
  }

  const backdrops = [...document.querySelectorAll('.cdk-overlay-backdrop.cdk-overlay-backdrop-showing')].filter(visible);
  if (backdrops.length > 0) {
    const activePanels = [...document.querySelectorAll('.cdk-overlay-pane')].filter(visible);
    const hasOnlySettings = activePanels.length > 0 && activePanels.every(isSettingsDialog);
    if (!hasOnlySettings) {
      dispatchEscapeKey();
      dismissedAny = true;
      await wait(150);
    }
  }

  return dismissedAny;
}

async function insertNativeFlowPrompt(el, value) {
  const text = String(value || "");
  const normalize = input => String(input || "").replace(/[\u200B\u200C\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim();
  const expected = normalize(text);
  if (!el?.isContentEditable) return false;

  // Xóa sạch text prompt cũ nhưng bảo toàn các chip reference/nhân vật
  await clearEditorTextPreservingChips(el);

  el.focus();
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  selection?.removeAllRanges();
  selection?.addRange(range);
  let inserted = false;
  if (expected && typeof DataTransfer === "function" && typeof ClipboardEvent === "function") {
    try {
      const clipboard = new DataTransfer();
      clipboard.setData("text/plain", text);
      const paste = new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true, cancelable: true });
      el.dispatchEvent(paste);
      inserted = paste.defaultPrevented || normalize(getEditorUserText(el)) === expected;
    } catch {}
  }
  if (expected && !inserted) document.execCommand("insertText", false, text);
  await wait(150);
  const actual = normalize(getEditorUserText(el));
  // Xác nhận text thuần khớp với prompt mới, bảo toàn các inline chips
  return !expected || actual === expected || actual.endsWith(expected);
}

var FLOW_CREDIT_QUOTE_REGEX = /(?:\b(?:generating\s+)?will\s+use\s+([\d,]+(?:\.\d+)?)\s+credits?\b|(?:quá trình tạo\s+)?(?:sẽ\s+dùng|sẽ\s+sử\s+dụng|tiêu\s+tốn)\s+([\d,]+(?:\.\d+)?)\s+(?:tín\s+dụng|điểm\s+tín\s+dụng|credits?))/i;

function readGenerationCreditQuote() {
  const pageText = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
  const pageUsage = pageText.match(FLOW_CREDIT_QUOTE_REGEX);
  if (pageUsage) return Number((pageUsage[1] || pageUsage[2]).replace(/,/g, ""));
  const candidates = [...document.querySelectorAll("a,button,[role],p,span")]
    .filter(visible)
    .map(el => (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  // Prefer Flow's explicit usage quote; a balance or unrelated "N credits" label is not a quote.
  const usage = candidates.map(text => ({ text, match: text.match(FLOW_CREDIT_QUOTE_REGEX) }))
    .filter(item => item.match)
    .sort((a, b) => a.text.length - b.text.length)[0];
  if (usage) return Number((usage.match[1] || usage.match[2]).replace(/,/g, ""));
  return undefined;
}

async function waitForGenerationCreditQuote(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const quote = readGenerationCreditQuote();
    if (Number.isFinite(quote)) return quote;
    await wait(200);
  }
  return readGenerationCreditQuote();
}

function cleanCharacterName(value) {
  return value.replace(/\s+/g, " ").trim()
    .replace(/\b(accessibility_new|person|movie|image|videocam|mic)\b/g, "")
    .replace(/\s+/g, " ").trim();
}

var NAV_SYNONYMS = {
  "characters": ["characters", "nhân vật", "nhan vat"],
  "all media": [
    "all media", "tất cả nội dung nghe nhìn", "tất cả phương tiện", "tất cả media", "thư viện", "tất cả tệp"
  ]
};

var ALL_MEDIA_ICONS = ["dashboard", "perm_media", "movie", "video_library", "photo_library", "grid_view", "auto_awesome_motion", "folder", "collections", "video_settings"];

function flowNavigationItem(label) {
  const normalize = value => cleanCharacterName(String(value || "").replace(/\s+/g, " ").trim()).toLowerCase();
  const navigation = [...document.querySelectorAll('nav,[role="navigation"],mat-sidenav')].find(el =>
    /project navigation|điều hướng dự án|dự án/i.test(accessibleName(el)) ||
    /project navigation|điều hướng dự án|dự án/i.test(el.getAttribute?.("aria-label") || "") ||
    el.querySelector?.('mat-icon')
  ) || document.querySelector('nav,[role="navigation"],mat-sidenav');
  const roots = navigation ? [navigation, document] : [document];
  const candidates = [...new Set(roots.flatMap(root => [...root.querySelectorAll(
    'a,button,[role="button"],[role="menuitem"],mat-list-item,button[mat-list-item],[role="tab"]'
  )]))];
  const wanted = normalize(label);
  const synonyms = (globalThis.I18n?.getPatterns?.(wanted)?.length ? globalThis.I18n.getPatterns(wanted) : NAV_SYNONYMS[wanted]) || [wanted];
  return candidates.find(el => {
    if (!visible(el) || el.disabled || el.getAttribute?.("aria-disabled") === "true") return false;
    const text = normalize(el.innerText || el.textContent || accessibleName(el));
    const iconNames = [...(el.querySelectorAll?.("mat-icon") || [])].map(icon => normalize(icon.innerText || icon.textContent));
    if ((wanted === "characters" || synonyms.includes("nhân vật")) &&
        iconNames.some(icon => ["accessibility_new", "person", "face"].includes(icon))) return true;
    if ((wanted === "all media" || synonyms.includes("tất cả nội dung nghe nhìn")) && iconNames.some(ic => ALL_MEDIA_ICONS.includes(ic))) return true;
    
    // So khớp an toàn: exact match hoặc prefix/suffix có icon
    return synonyms.some(syn => {
      if (text === syn || text.endsWith(` ${syn}`) || text.startsWith(`${syn} `)) return true;
      if (syn.includes(" ") && text.includes(syn)) return true;
      return false;
    });
  });
}

function clickFlowNavigation(label) {
  const target = flowNavigationItem(label);
  if (!target) return false;
  target.click();
  return true;
}

async function waitForFlowRoute(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(location.pathname)) return true;
    await wait(100);
  }
  throw flowError("FLOW_NAVIGATION_TIMEOUT", message, true);
}

async function exitFlowMediaViewer() {
  const isMediaViewer = () => {
    return /\/edit(?:\/|$)/i.test(location.pathname) || /\/project\/[^/]+\/edit/i.test(location.pathname);
  };
  if (!isMediaViewer()) return true;

  console.log("[FlowMediaViewer] Detected open media viewer, executing 3-tier exit...");

  // Tier 1: Nút back với icon arrow_back hoặc text Back
  const backButtons = [...document.querySelectorAll('button, [role="button"]')].filter(visible);
  const backBtn = backButtons.find(btn => {
    const label = (accessibleName(btn) || btn.innerText || btn.textContent || "").trim().toLowerCase();
    const hasBackIcon = [...btn.querySelectorAll('mat-icon')].some(icon => /arrow_back|arrow-back|back/i.test((icon.innerText || icon.textContent || "").trim()));
    return hasBackIcon || /^(?:back|go back|quay lại|back button.*)$/i.test(label);
  });

  if (backBtn) {
    const eventInit = { bubbles: true, cancelable: true, view: window, button: 0 };
    try { backBtn.dispatchEvent(new PointerEvent("pointerdown", eventInit)); } catch {}
    try { backBtn.dispatchEvent(new MouseEvent("mousedown", eventInit)); } catch {}
    try { backBtn.dispatchEvent(new PointerEvent("pointerup", eventInit)); } catch {}
    try { backBtn.dispatchEvent(new MouseEvent("mouseup", eventInit)); } catch {}
    try { backBtn.click(); } catch {}
    const left = await waitForFlowRoute(path => !isMediaViewer(), 2000, "").catch(() => false);
    if (left) return true;
  }

  // Tier 2: history.back()
  try {
    if (typeof history !== "undefined" && typeof history.back === "function") {
      history.back();
      const left = await waitForFlowRoute(path => !isMediaViewer(), 2000, "").catch(() => false);
      if (left) return true;
    }
  } catch {}

  // Tier 3: Điều hướng trực tiếp về project editor
  const target = globalThis.FlowDriverRegistry?.describeUrl?.(location.href);
  if (target?.projectId) {
    const rootUrl = `${target.origin}${target.routePrefix}/project/${target.projectId}`;
    console.warn("[FlowMediaViewer] Tier 1+2 did not exit media viewer; reloading clean project URL:", rootUrl);
    location.assign(rootUrl);
    throw flowError("FLOW_PROJECT_NAVIGATING", "Navigating back to project root editor. Please retry.", true, false);
  }

  return !isMediaViewer();
}

function flowReferenceComposerRoot() {
  const editor = (typeof flowQuery === "function" ? flowQuery("editor") : null) || document.querySelector(".ProseMirror[contenteditable='true']");
  if (!editor) return null;
  const configured = typeof flowQuery === "function" ? flowQuery("composerRoot") : null;
  if (configured?.contains(editor)) return configured;
  return editor.closest("flow-base-prompt-box, .base-prompt-box, .flow-composer, [class*='composer'], [class*='prompt-box'], form") || editor.parentElement;
}

function flowReferenceChipNodes(composer) {
  if (!composer) return [];
  const ingredientChipSelector = 'button[aria-label="Ingredient"],button[aria-label="Thành phần"],button[aria-label="Nguyên liệu"]';
  const isRefChip = el => {
    if (!visible(el)) return false;
    const name = (accessibleName(el) || el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      const ownClass = String(el.className?.baseVal || el.className || "").toLowerCase();
      const voiceMarker = el.getAttribute?.("data-ingredient-type") === "voice" || el.getAttribute?.("data-kind") === "voice" ||
        /voice-chip|ingredient-voice/.test(ownClass) ||
        Boolean(el.querySelector?.('[data-ingredient-type="voice"],[data-kind="voice"],[class*="voice-chip" i],[class*="ingredient-voice" i]')) ||
        /^(?:voice|giọng nói|giọng)\s*[:\-]/i.test(name);
      if (voiceMarker) return false;
    if (el.matches?.(ingredientChipSelector)) return true;
    if (el.hasAttribute?.("data-chip")) return true;
    if (el.matches?.("mat-chip,[role='listitem']")) return matchesFlowUiRegex(name, /(?:Ingredient|Thành phần)/i);
    return /(?:remove|delete|clear|xóa|gỡ).{0,40}(?:ingredient|thành phần)|(?:ingredient|thành phần).{0,40}(?:remove|delete|clear|xóa|gỡ)/i.test(name);
  };
  return [...composer.querySelectorAll(`${ingredientChipSelector},button,[role="button"],[role="listitem"],mat-chip,[data-chip]`)].filter(isRefChip);
}

function inspectFlowReferenceClearDiagnostics() {
  const composer = flowReferenceComposerRoot();
  const clear = composer ? flowButton("Clear prompt", composer) : null;
  const chips = flowReferenceChipNodes(composer);
  const helper = globalThis.__flowReferenceClearDiagnostics || { phase: "idle" };
  return {
    composer: composer ? { tag: composer.tagName?.toLowerCase(), className: String(composer.className?.baseVal || composer.className || "").slice(0, 120), connected: composer.isConnected === true } : null,
    clearPromptButton: clear ? { aria: (accessibleName(clear) || "").replace(/\s+/g, " ").trim().slice(0, 100), disabled: Boolean(clear.disabled || clear.getAttribute("aria-disabled") === "true"), connected: clear.isConnected === true } : null,
    chipCount: chips.length,
    chips: chips.slice(0, 6).map(chip => {
      const attached = globalThis.FlowReferenceActions?.chips?.().find(item => item.element === chip);
      return {
        tag: chip.tagName.toLowerCase(),
        label: (accessibleName(chip) || chip.innerText || chip.textContent || "").replace(/\s+/g, " ").trim().slice(0, 100),
        name: attached?.name || null,
        kind: attached?.kind || null,
        id: attached?.mediaId || null,
        connected: chip.isConnected === true,
      };
    }),
    helper: { ...helper },
  };
}

async function clearExistingIngredientChips(options = {}) {
  const deadline = Number.isFinite(options.deadline) ? options.deadline : Date.now() + 5_000;
  const signal = options.signal;
  const state = globalThis.__flowReferenceClearDiagnostics || (globalThis.__flowReferenceClearDiagnostics = { phase: "idle" });
  const update = patch => Object.assign(state, patch, { updatedAt: new Date().toISOString() });
  const requireTime = operation => globalThis.FlowUiDeadline?.requireTime(deadline, operation, false, signal);
  const boundedWait = (ms, operation) => globalThis.FlowUiDeadline?.boundedWait(ms, deadline, operation, false, signal) || wait(Math.min(ms, Math.max(1, deadline - Date.now())));
  const composer = flowReferenceComposerRoot();
  if (!composer) throw flowError("FLOW_REFERENCE_CLEAR_COMPOSER_MISSING", "Could not scope existing reference chips to Flow's composer; nothing was submitted.", false, false);
  const initial = flowReferenceChipNodes(composer);
  update({ phase: initial.length ? "clearing" : "no-existing-chips", initialCount: initial.length, removedCount: 0, error: null });
  if (!initial.length) {
    update({ phase: "returned", remainingCount: 0 });
    return { cleared: 0, remaining: 0 };
  }

  let removedCount = 0;
  try {
    // FlowEditor.insertNativeFlowPrompt clears prompt text while preserving
    // reference chips. Avoid the broad Clear prompt action; it also removes
    // user prompt text and is not needed for attachment cleanup.
    for (let attempt = 0; attempt < 6; attempt++) {
      requireTime("clearing existing Flow reference chips");
      const chips = flowReferenceChipNodes(composer);
      if (!chips.length) break;
      const chip = chips[0];
      const isFlowIngredientChipButton = chip.matches?.('button[aria-label="Ingredient"],button[aria-label="Thành phần"],button[aria-label="Nguyên liệu"]');
      const controls = [...(chip.matches?.('button,[role="button"]') ? [chip] : []), ...chip.querySelectorAll('button,[role="button"],mat-icon')];
      const remove = isFlowIngredientChipButton
        ? chip
        : controls.find(control => /(?:close|clear|remove|delete|xóa|gỡ)/i.test(accessibleName(control) || control.innerText || control.textContent || ""));
      if (!remove || remove.disabled || remove.getAttribute("aria-disabled") === "true") {
        throw flowError("FLOW_REFERENCE_REMOVE_CONTROL_MISSING", "A Flow reference chip has no enabled remove control; nothing was submitted.", false, false);
      }
      const beforeCount = chips.length;
      update({ phase: "removing-chip", currentLabel: (accessibleName(chip) || chip.innerText || chip.textContent || "").replace(/\s+/g, " ").trim().slice(0, 100), removedCount });
      remove.click();
      await boundedWait(120, "waiting for a Flow reference chip to clear");
      const after = flowReferenceChipNodes(composer);
      if (after.length >= beforeCount) throw flowError("FLOW_REFERENCE_CLEAR_UNCONFIRMED", "Flow did not remove the existing reference chip; nothing was submitted. Inspect the composer before retrying.", false, false);
      removedCount += beforeCount - after.length;
      update({ phase: "chip-removed", removedCount, remainingCount: after.length });
    }
    requireTime("confirming existing Flow reference chips are cleared");
    const remaining = flowReferenceChipNodes(composer).length;
    if (remaining) throw flowError("FLOW_REFERENCE_CLEAR_UNCONFIRMED", `Flow still shows ${remaining} existing reference chip(s); nothing was submitted.`, false, false);
    update({ phase: "returned", removedCount, remainingCount: 0 });
    return { cleared: removedCount, remaining: 0 };
  } catch (error) {
    update({ phase: "error", removedCount, error: String(error?.code || error?.message || error).slice(0, 240) });
    throw error;
  }
}

function checkFlowCreditLimitAlert() {
  const root = typeof globalThis !== "undefined" ? globalThis : (typeof window !== "undefined" ? window : self);
  const config = root.FlowSelectors?.creditLimit;
  const alertTexts = config?.patterns || [
    "run out of credits",
    "no credits remaining",
    "not enough credits",
    "credit limit reached",
    "bạn đã hết credit",
    "không đủ credit",
    "hết hạn mức credit",
    "public_error_user_quota_reached"
  ];

  const candidates = (typeof root.flowQueryAll === "function" ? root.flowQueryAll("creditLimit") : null) ||
    [...document.querySelectorAll('[role="alert"], mat-error, .flow-alert, [class*="alert"], [class*="error"], [class*="quota"], [class*="credit"]')].filter(visible);
  for (const el of candidates) {
    const text = (el.innerText || el.textContent || "").trim().toLowerCase();
    if (alertTexts.some(alert => text.includes(alert))) {
      return text;
    }
  }

  const bodyText = (document.body?.innerText || "").toLowerCase();
  for (const alert of alertTexts) {
    if (bodyText.includes(alert)) {
      return alert;
    }
  }
  return null;
}

async function leaveFlowDetailView() {
  const target = globalThis.FlowDriverRegistry?.describeUrl?.(location.href);
  if (target?.projectId && !target.isProjectEditor) {
    if (/\/edit(?:\/|$)/i.test(location.pathname)) {
      await exitFlowMediaViewer();
      return;
    }
    if (/\/character(?:\/|$)/i.test(location.pathname)) {
      const done = flowButton("Done") || flowButton("Done editing");
      if (done) {
        done.click();
        const left = await waitForFlowRoute(path => !/\/character(?:\/|$)/i.test(path), 2000, "").catch(() => false);
        if (left) return;
      }
      const goBack = flowButton("Go back") || flowButton("Back");
      if (goBack) {
        goBack.click();
        const left = await waitForFlowRoute(path => !/\/character(?:\/|$)/i.test(path), 2000, "").catch(() => false);
        if (left) return;
      }
    }

    // Nếu không có nút thoát UI hoặc click không chuyển trang, tự động phục hồi về project editor
    await ensureFlowProjectEditor();
  }
}

async function ensureFlowProjectEditor() {
  const describe = () => globalThis.FlowDriverRegistry?.describeUrl?.(location.href) || null;
  let target = describe();

  // 1. Đã ở đúng màn hình Project Editor chính
  if (target?.isProjectEditor) {
    return { success: true, isProjectEditor: true, projectId: target.projectId };
  }

  // 2. Đang ở trong project nhưng kẹt ở sub-route (/character, /edit, ...)
  if (target?.projectId && !target.isProjectEditor) {
    console.log("[FlowProjectNavigation] Detected sub-route (" + location.pathname + "), recovering to project root editor...");
    
    // Thử click nút quay lại / Done nếu có
    const doneOrBack = [...document.querySelectorAll('button, [role="button"]')].find(el => {
      if (!visible(el)) return false;
      const name = accessibleName(el).trim();
      return matchesFlowUiRegex(name, /^Done( editing)?$/i) || matchesFlowUiRegex(name, /^Back( button.*)?$/i) || matchesFlowUiRegex(name, /^(Go back|Quay lại)$/i);
    });
    if (doneOrBack) {
      doneOrBack.click();
      const leftSubRoute = await waitForFlowRoute(() => describe()?.isProjectEditor === true, 2000, "").catch(() => false);
      if (leftSubRoute) return { success: true, isProjectEditor: true, projectId: target.projectId };
    }

    // Thử click All media navigation
    const allMedia = flowNavigationItem("All media");
    if (allMedia) {
      allMedia.click();
      const leftSubRoute = await waitForFlowRoute(() => describe()?.isProjectEditor === true, 2000, "").catch(() => false);
      if (leftSubRoute) return { success: true, isProjectEditor: true, projectId: target.projectId };
    }

    // Điều hướng trực tiếp về project root URL (cơ chế phục hồi giống TobyFlow)
    const rootUrl = `${target.origin}${target.routePrefix}/project/${target.projectId}`;
    console.log("[FlowProjectNavigation] Navigating directly to project root URL:", rootUrl);
    location.assign(rootUrl);
    if (describe()?.isProjectEditor) {
      return { success: true, isProjectEditor: true, projectId: target.projectId };
    }
    throw flowError("FLOW_PROJECT_NAVIGATING", "Navigating back to project root editor. Please retry.", true, false);
  }

  // 3. Đang ở ngoài project (trang chủ hoặc danh sách dự án): tự động mở hoặc tạo dự án mới
  console.log("[FlowProjectNavigation] Outside of project. Finding New project button or existing project...");
  const newProjectBtn = [...document.querySelectorAll('button, a[role="button"]')].find(btn => {
    if (!visible(btn)) return false;
    const label = (accessibleName(btn) || btn.innerText || btn.textContent || "").trim().toLowerCase();
    const hasAddIcon = [...btn.querySelectorAll('mat-icon')].some(i => /add|create|new/i.test((i.innerText || i.textContent || "").trim()));
    return /new project|tạo dự án|create project/i.test(label) || (hasAddIcon && /project|dự án/i.test(label));
  });

  if (newProjectBtn) {
    console.log("[FlowProjectNavigation] Clicking New project button...");
    newProjectBtn.click();
    await waitForFlowRoute(() => describe()?.isProjectEditor === true, 15_000, "Flow did not open a new project editor.");
    target = describe();
    return { success: true, isProjectEditor: true, projectId: target?.projectId || null };
  }

  const firstProjectCard = document.querySelector('a[href*="/project/"]');
  if (firstProjectCard && visible(firstProjectCard)) {
    console.log("[FlowProjectNavigation] Opening first existing project...");
    firstProjectCard.click();
    await waitForFlowRoute(() => describe()?.isProjectEditor === true, 15_000, "Flow did not open existing project editor.");
    target = describe();
    return { success: true, isProjectEditor: true, projectId: target?.projectId || null };
  }

  return { success: false, error: "FLOW_PROJECT_REQUIRED" };
}

function blurFlowNavigationFocus() {
  const focused = document.activeElement;
  if (focused?.closest?.("mat-sidenav,[role=navigation]")) focused.blur();
}

async function ensureFlowLibrarySection(label) {
  await leaveFlowDetailView();

  const isAtProjectRoot = () => {
    const desc = globalThis.FlowDriverRegistry?.describeUrl?.(location.href);
    if (desc?.isProjectEditor) return true;
    const notSubRoute = !/\/character|\/edit/i.test(location.pathname);
    const hasComposer = Boolean(document.querySelector('.ProseMirror, flow-base-prompt-box')) ||
      Boolean(flowButton("Start generation"));
    return notSubRoute && hasComposer;
  };

  // Nếu mục tiêu là "All media" và giao diện đã ở sẵn màn hình Project Editor chính
  if (label === "All media" && isAtProjectRoot()) {
    return true;
  }

  let target = flowNavigationItem(label);
  if (!target && label === "All media") {
    // Thử phục hồi về Project Editor nếu bị kẹt ở sub-route
    await ensureFlowProjectEditor();
    if (isAtProjectRoot()) return true;
    target = flowNavigationItem(label);
  }

  if (!target) {
    if (label === "All media" && isAtProjectRoot()) return true;
    throw flowError("FLOW_NAV_UNAVAILABLE", `Flow's project navigation could not open "${label}" from this view.`, true);
  }

  target.click();
  const deadline = Date.now() + (label === "Characters" ? 10_000 : 5000);
  const hasCharacterAction = () => [...document.querySelectorAll("flow-custom-tile")].some(tile => {
    if (!visible(tile)) return false;
    const addIcon = [...(tile.querySelectorAll?.("mat-icon") || [])].some(icon =>
      cleanCharacterName(icon.innerText || icon.textContent || "").toLowerCase() === "add");
    const text = cleanCharacterName(tile.innerText || tile.textContent || "").toLowerCase();
    return addIcon && (/character/.test(text) || /nhân vật/.test(text));
  });
  const hasEmptyCharacterChooser = () => /\/character\/?$/i.test(location.pathname) &&
    (flowButton("Go back") || flowButton("Add from project") || flowButton("Quay lại") || flowButton("Thêm từ dự án"));
  const hasSectionMarker = () => label === "Characters"
    ? hasCharacterAction() || hasEmptyCharacterChooser()
    : isAtProjectRoot() || [...document.querySelectorAll("flow-grid-tile-container")].some(visible);
  while (Date.now() < deadline) {
    const loading = [...document.querySelectorAll('[role="progressbar"],[aria-busy="true"]')].some(visible);
    if (!loading && hasSectionMarker()) break;
    await wait(150);
  }
  if (!hasSectionMarker()) {
    if (label === "All media" && isAtProjectRoot()) return true;
    throw flowError("FLOW_LIBRARY_LOADING", `Flow's "${label}" library did not become ready after navigation.`, true);
  }
  blurFlowNavigationFocus();
}

if (typeof globalThis !== "undefined") {
  globalThis.visible = visible;
  globalThis.accessibleName = accessibleName;
  globalThis.wait = wait;
  globalThis.normalizeFlowUiText = normalizeFlowUiText;
  globalThis.matchesFlowUiRegex = matchesFlowUiRegex;
  globalThis.flowError = flowError;
  globalThis.classifyFlowError = classifyFlowError;
  globalThis.flowButton = flowButton;
  globalThis.waitForEnabledFlowButton = waitForEnabledFlowButton;
  globalThis.isFlowProjectNavigationControl = isFlowProjectNavigationControl;
  globalThis.normalizeAspectRatio = normalizeAspectRatio;
  globalThis.scrollContainer = scrollContainer;
  globalThis.validStagedLocalImage = validStagedLocalImage;
  globalThis.stagedNativeFiles = stagedNativeFiles;
  globalThis.nativeUploadAssemblers = nativeUploadAssemblers;
  globalThis.getEditorUserText = getEditorUserText;
  globalThis.countInlineChips = countInlineChips;
  globalThis.clearEditorTextPreservingChips = clearEditorTextPreservingChips;
  globalThis.dismissBlockingOverlays = dismissBlockingOverlays;
  globalThis.dispatchEscapeKey = dispatchEscapeKey;
  globalThis.ensureFlowProjectEditor = ensureFlowProjectEditor;
  globalThis.exitFlowMediaViewer = exitFlowMediaViewer;
  globalThis.clearExistingIngredientChips = clearExistingIngredientChips;
  globalThis.inspectFlowReferenceClearDiagnostics = inspectFlowReferenceClearDiagnostics;
  globalThis.checkFlowCreditLimitAlert = checkFlowCreditLimitAlert;
  globalThis.readGenerationCreditQuote = readGenerationCreditQuote;
  globalThis.waitForGenerationCreditQuote = waitForGenerationCreditQuote;
  globalThis.flowRadio = flowRadio;
  globalThis.flowOption = flowOption;
  globalThis.flowNavigationItem = flowNavigationItem;
  globalThis.ensureFlowLibrarySection = ensureFlowLibrarySection;
  globalThis.waitForFlowRoute = waitForFlowRoute;
}
