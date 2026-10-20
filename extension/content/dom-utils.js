function visible(el) {
  const r = el.getBoundingClientRect();
  const s = getComputedStyle(el);
  return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
}

function accessibleName(el) {
  const labels = el.labels ? [...el.labels].map(l => l.innerText).join(" ") : "";
  const labelledBy = (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean).map(id => document.getElementById(id)?.innerText || document.getElementById(id)?.textContent || "").join(" ").trim();
  return el.getAttribute("aria-label") || labelledBy || el.getAttribute("title") || el.getAttribute("alt") || labels || el.getAttribute("placeholder") || el.innerText || el.textContent || "";
}

function semanticActionText(el) {
  const labels = el.labels ? [...el.labels].map(label => label.innerText || label.textContent || "").join(" ").trim() : "";
  const labelledBy = (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean)
    .map(id => document.getElementById(id)?.innerText || document.getElementById(id)?.textContent || "").join(" ").trim();
  const explicit = el.getAttribute("aria-label") || labelledBy || el.getAttribute("title") || labels || el.getAttribute("alt");
  if (explicit) return explicit;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const text = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    let parent = node.parentElement;
    let hidden = false;
    while (parent && el.contains(parent)) {
      if (parent.getAttribute("aria-hidden") === "true") { hidden = true; break; }
      if (parent === el) break;
      parent = parent.parentElement;
    }
    if (!hidden) text.push(node.nodeValue || "");
  }
  return text.join(" ").replace(/\s+/g, " ").trim();
}

function matchesName(value, expected, regex, exact) {
  if (regex?.__regexp || regex?.source) { try { return new RegExp(regex.source, regex.flags).test(value); } catch {} }
  return expected === undefined || (exact ? value === expected : value.toLowerCase().includes(String(expected).toLowerCase()));
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

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function flowError(code, message, retryable = false, outcomeUnknown = false) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  error.outcome_unknown = outcomeUnknown;
  return error;
}

function flowButton(name, root = document) {
  return [...root.querySelectorAll('button,[role="button"]')].find(el =>
    visible(el) && matchesName(semanticActionText(el).replace(/\s+/g, " ").trim(), name, null, true));
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
  if (el.closest('nav,[role="navigation"]')) return true;
  for (let parent = el; parent && parent !== document.body; parent = parent.parentElement) {
    if (/project navigation/i.test(parent.getAttribute("aria-label") || "")) return true;
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
  image: ["image", "hình ảnh", "ảnh"],
};

function flowRadio(name) {
  const wanted = String(name || "").trim().toLowerCase();
  const normalizedWanted = normalizeAspectRatio(wanted);
  const aliases = OPTION_ALIASES[wanted] || (normalizedWanted ? [wanted, normalizedWanted] : [wanted]);
  return [...document.querySelectorAll('[role="radio"],mat-radio-button')].find(el => {
    if (!visible(el) || isFlowProjectNavigationControl(el)) return false;
    const label = accessibleName(el).replace(/\s+/g, " ").trim().toLowerCase();
    if (aliases.some(a => label === a || label.endsWith(` ${a}`))) return true;
    if (normalizedWanted && (label.includes(normalizedWanted) || label.endsWith(` ${normalizedWanted}`))) return true;
    return matchesName(accessibleName(el).replace(/\s+/g, " ").trim(), name, null, true);
  });
}

function flowOption(name) {
  const expected = String(name).replace(/\s+/g, " ").trim().toLowerCase();
  const normalizedExpected = normalizeAspectRatio(expected);
  const aliases = OPTION_ALIASES[expected] || (normalizedExpected ? [expected, normalizedExpected] : [expected]);
  // The closed settings trigger carries a summary such as "Video · 720p · 10s x1".
  // It is a button, but never an option; allowing it here makes x1 falsely imply
  // that the settings panel is open and can also toggle the panel during selection.
  const settingsTrigger = flowButton("Settings trigger");
  return [...document.querySelectorAll('[role="radio"],mat-radio-button,[role="tab"],[role="option"],button,[role="button"]')].find(el => {
    const label = accessibleName(el).replace(/\s+/g, " ").trim().toLowerCase();
    if (!visible(el) || el === settingsTrigger || isFlowProjectNavigationControl(el)) return false;
    if (aliases.some(a => label === a || label.endsWith(` ${a}`))) return true;
    if (normalizedExpected && (label === normalizedExpected || label.includes(normalizedExpected))) return true;
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

async function insertNativeFlowPrompt(el, value) {
  const text = String(value || "");
  const normalize = input => String(input || "").replace(/[\u200B\u200C\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim();
  const expected = normalize(text);
  if (!el?.isContentEditable) return false;
  const before = normalize(el.innerText || el.textContent);
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
      inserted = paste.defaultPrevented || normalize(el.innerText || el.textContent) !== before;
    } catch {}
  }
  if (expected && !inserted) document.execCommand("insertText", false, text);
  await wait(150);
  const actual = normalize(el.innerText || el.textContent);
  // Inline reference chips may share the editor, so preserve them and confirm that the
  // submitted prompt is the final text segment instead of replacing the editor contents.
  return !expected || actual.endsWith(expected) || actual === normalize(`${before} ${text}`);
}

function readGenerationCreditQuote() {
  const pageText = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
  const pageUsage = pageText.match(/\b(?:generating\s+)?will\s+use\s+([\d,]+(?:\.\d+)?)\s+credits?\b/i);
  if (pageUsage) return Number(pageUsage[1].replace(/,/g, ""));
  const candidates = [...document.querySelectorAll("a,button,[role],p,span")]
    .filter(visible)
    .map(el => (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  // Prefer Flow's explicit usage quote; a balance or unrelated "N credits" label is not a quote.
  const usage = candidates.map(text => ({ text, match: text.match(/\b(?:generating\s+)?will\s+use\s+([\d,]+(?:\.\d+)?)\s+credits?\b/i) }))
    .filter(item => item.match)
    .sort((a, b) => a.text.length - b.text.length)[0];
  if (usage) return Number(usage.match[1].replace(/,/g, ""));
  // Retain compatibility with Flow builds that expose only a bare numeric quote.
  const bare = candidates.map(text => ({ text, match: text.match(/^([\d,]+(?:\.\d+)?)\s+credits?$/i) }))
    .filter(item => item.match)
    .sort((a, b) => a.text.length - b.text.length)[0];
  return bare ? Number(bare.match[1].replace(/,/g, "")) : undefined;
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

function flowNavigationItem(label) {
  const normalize = value => cleanCharacterName(String(value || "").replace(/\s+/g, " ").trim()).toLowerCase();
  const navigation = [...document.querySelectorAll('nav,[role="navigation"]')].find(el =>
    /project navigation/i.test(accessibleName(el)) || /project navigation/i.test(el.getAttribute("aria-label") || ""));
  const roots = navigation ? [navigation] : [document];
  const candidates = roots.flatMap(root => [...root.querySelectorAll(
    'a,button,[role="button"],[role="menuitem"],mat-list-item,button[mat-list-item]'
  )]);
  const wanted = normalize(label);
  return candidates.find(el => {
    if (!visible(el) || el.disabled || el.getAttribute("aria-disabled") === "true") return false;
    const text = normalize(el.innerText || el.textContent || accessibleName(el));
    const iconNames = [...el.querySelectorAll("mat-icon")].map(icon => normalize(icon.innerText || icon.textContent));
    if (label === "Characters" && iconNames.includes("accessibility_new")) return true;
    if (label === "All media" && iconNames.includes("dashboard")) return true;
    // Material icon ligatures can prefix the visible navigation label (for example "image All media").
    return text === wanted || text.endsWith(` ${wanted}`);
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

async function leaveFlowDetailView() {
  if (/\/character(?:\/|$)/i.test(location.pathname)) {
    const done = [...document.querySelectorAll("button,[role=button]")].find(el => visible(el) && /^Done( editing)?$/i.test(accessibleName(el).trim()));
    if (done) done.click();
    await waitForFlowRoute(path => !/\/character(?:\/|$)/i.test(path), 15_000, "Flow did not leave the character editor.");
  } else if (/\/edit(?:\/|$)/i.test(location.pathname)) {
    const back = flowButton("Back button to go to previous page");
    if (back) back.click();
    await waitForFlowRoute(path => !/\/edit(?:\/|$)/i.test(path), 20_000, "Flow did not return from the video editor.");
  }
}

function blurFlowNavigationFocus() {
  const focused = document.activeElement;
  if (focused?.closest?.("mat-sidenav,[role=navigation]")) focused.blur();
}

async function ensureFlowLibrarySection(label) {
  await leaveFlowDetailView();
  const target = flowNavigationItem(label);
  if (!target) {
    throw flowError("FLOW_NAV_UNAVAILABLE", `Flow's project navigation could not open "${label}" from this view.`, true);
  }
  target.click();
  const deadline = Date.now() + (label === "Characters" ? 10_000 : 5000);
  const hasCharacterAction = () => [...document.querySelectorAll("flow-custom-tile")].some(tile => {
    if (!visible(tile)) return false;
    const addIcon = [...tile.querySelectorAll("mat-icon")].some(icon =>
      cleanCharacterName(icon.innerText || icon.textContent || "").toLowerCase() === "add");
    const text = cleanCharacterName(tile.innerText || tile.textContent || "").toLowerCase();
    return addIcon && (/character/.test(text) || /nhân vật/.test(text));
  });
  const hasEmptyCharacterChooser = () => /\/character\/?$/i.test(location.pathname) &&
    (flowButton("Go back") || flowButton("Add from project"));
  const hasSectionMarker = () => label === "Characters"
    ? hasCharacterAction() || hasEmptyCharacterChooser()
    : label === "All media" && [...document.querySelectorAll("flow-grid-tile-container")].some(visible);
  while (Date.now() < deadline) {
    const loading = [...document.querySelectorAll('[role="progressbar"],[aria-busy="true"]')].some(visible);
    if (!loading && hasSectionMarker()) break;
    await wait(150);
  }
  if (!hasSectionMarker()) {
    throw flowError("FLOW_LIBRARY_LOADING", `Flow's "${label}" library did not become ready after navigation.`, true);
  }
  blurFlowNavigationFocus();
}
