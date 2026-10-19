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
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
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
function clickFlowNavigation(label) {
  const candidates = [...document.querySelectorAll(
    'a,button,[role="button"],[role="menuitem"],mat-list-item,button[mat-list-item]'
  )];
  const target = candidates.find(el => {
    const text = (el.getAttribute("aria-label") || el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    return text.toLowerCase() === label.toLowerCase() && visible(el) && !el.disabled;
  });
  if (!target) return false;
  target.click();
  return true;
}
function collectAssets() {
  return [...document.querySelectorAll("flow-grid-tile-container")].map(tile => {
    const kind = tile.querySelector("flow-scene-tile") ? "scene" : tile.querySelector("flow-video-tile") ? "video" : tile.querySelector("flow-image-tile") ? "image" : null;
    const name = (tile.getAttribute("aria-label") || "").trim();
    if (!kind || !name) return null;
    const id = mediaId(tile);
    return { ...(id && !id.startsWith("title:") ? { id } : {}), name, kind };
  }).filter(Boolean);
}
function scrollContainer() {
  const preferred = document.querySelector(".page-container");
  if (preferred) return preferred;
  return [...document.querySelectorAll("*" )].find(el => el.scrollHeight > el.clientHeight + 8 && el.clientHeight > 100) || null;
}
async function scanNativeAssets() {
  const originalContainer = scrollContainer();
  const originalTop = originalContainer?.scrollTop ?? 0;
  const byName = new Map();
  try {
    // From detail/editor views, return to the project library when the Flow navigation is available.
    if (!document.querySelector("flow-grid-tile-container")) {
      clickFlowNavigation("All media");
      await wait(700);
    }
    if (!document.querySelector("flow-grid-tile-container")) {
      throw new Error("Flow's All media grid is not visible. Open the project and try again.");
    }
    const container = scrollContainer();
    if (!container) return collectAssets();
    container.scrollTop = 0;
    await wait(350);
    let unchanged = 0;
    // The grid is virtualized: accumulate each rendered viewport and stop only after the scroll range ends
    // (or several waits produce no movement). Bound the scan to keep a malformed page from hanging an MCP call.
    for (let step = 0; step < 160; step++) {
      for (const asset of collectAssets()) {
        const known = byName.get(asset.name);
        if (!known) byName.set(asset.name, asset);
        else if (!known.id && asset.id) known.id = asset.id;
      }
      const before = container.scrollTop;
      const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
      if (before >= maxTop - 2) break;
      container.scrollTop = Math.min(maxTop, before + Math.max(200, container.clientHeight * 0.78));
      await wait(500);
      if (container.scrollTop <= before) {
        unchanged++;
        if (unchanged >= 3) break;
      } else unchanged = 0;
    }
    // Include the final viewport after reaching the bottom.
    for (const asset of collectAssets()) {
      const known = byName.get(asset.name);
      if (!known) byName.set(asset.name, asset);
      else if (!known.id && asset.id) known.id = asset.id;
    }
    return [...byName.values()];
  } finally {
    const current = scrollContainer();
    if (current && originalContainer === current) current.scrollTop = originalTop;
  }
}
async function scanNativeCharacters() {
  const clicked = clickFlowNavigation("Characters");
  if (!clicked && !document.querySelector("flow-character-tile")) {
    throw new Error("Flow's Characters section is not available in the current view. Open the project navigation and try again.");
  }
  if (clicked) await wait(700);
  const names = new Set();
  const container = scrollContainer();
  const originalTop = container?.scrollTop ?? 0;
  try {
    if (container) container.scrollTop = 0;
    for (let step = 0; step < 100; step++) {
      for (const tile of document.querySelectorAll("flow-character-tile")) {
        const name = cleanCharacterName(tile.innerText || tile.textContent || "");
        if (name && name !== "Me") names.add(name);
      }
      if (!container) break;
      const before = container.scrollTop;
      const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
      if (before >= maxTop - 2) break;
      container.scrollTop = Math.min(maxTop, before + Math.max(200, container.clientHeight * 0.78));
      await wait(400);
      if (container.scrollTop <= before) break;
    }
    for (const tile of document.querySelectorAll("flow-character-tile")) {
      const name = cleanCharacterName(tile.innerText || tile.textContent || "");
      if (name && name !== "Me") names.add(name);
    }
    return [...names];
  } finally {
    if (container) container.scrollTop = originalTop;
    // Restore the user's main library view after reading the separate Characters section.
    if (clicked && clickFlowNavigation("All media")) await wait(500);
  }
}
function nativeRead(name) {
  if (name === "flowState") {
    const url = location.href;
    const signedIn = !/\/about|accounts\.google\.com/.test(url);
    const inProject = /\/project\//.test(url);
    const state = { url, signedIn, inProject };
    if (!signedIn) state.hint = "Not signed in. Sign in to Google in the Flow Chrome tab.";
    else if (!inProject) state.hint = "Signed in, but no project is open. Open or create a Flow project.";
    return state;
  }
  if (name === "assets") return scanNativeAssets();
  if (name === "characters") return scanNativeCharacters();
  throw new Error(`Unsupported native read: ${name}`);
}

async function scanNativeProjects() {
  const homeUrl = location.href;
  const projectLinks = () => [...document.querySelectorAll('a[href*="/project/"]')]
    .filter(link => {
      try { return new URL(link.href).origin === location.origin && /\/project\/[0-9a-f-]{36}(?:[/?#]|$)/i.test(new URL(link.href).pathname + new URL(link.href).search); }
      catch { return false; }
    });
  // Flow's home shell often reaches `complete` before React has rendered the
  // project cards. TobyFlow waits on its home-page observer before scanning;
  // give this route the same settling window instead of returning a false empty list.
  const cardsDeadline = Date.now() + 15_000;
  while (!projectLinks().length && Date.now() < cardsDeadline) {
    if (location.href !== homeUrl) throw flowError("FLOW_EXECUTION_TARGET_CHANGED", "Flow navigated while project cards were loading.", true);
    await wait(250);
  }
  const first = projectLinks()[0];
  let scroller = null;
  for (let parent = first?.parentElement, depth = 0; parent && parent !== document.body && depth < 12; parent = parent.parentElement, depth++) {
    const style = getComputedStyle(parent);
    if ((style.overflowY === "auto" || style.overflowY === "scroll") && parent.scrollHeight > parent.clientHeight + 4) { scroller = parent; break; }
  }
  const scrolling = document.scrollingElement || document.documentElement;
  const top = () => scroller ? scroller.scrollTop : window.scrollY || scrolling.scrollTop || 0;
  const max = () => scroller ? scroller.scrollHeight - scroller.clientHeight : scrolling.scrollHeight - window.innerHeight;
  const scrollTo = value => scroller ? (scroller.scrollTop = value) : window.scrollTo(0, value);
  const originalTop = top();
  let lastCount = projectLinks().length, stable = 0;
  for (let step = 0; step < 20; step++) {
    if (location.href !== homeUrl) throw flowError("FLOW_EXECUTION_TARGET_CHANGED", "Flow navigated while project cards were loading.", true);
    const before = top();
    scrollTo(max() + 1000);
    await wait(400);
    const count = projectLinks().length;
    const moved = top() > before + 2;
    if (count <= lastCount && !moved) { if (++stable >= 2) break; } else stable = 0;
    lastCount = count;
  }
  scrollTo(originalTop);
  await wait(120);
  const seen = new Set();
  const projects = [];
  for (const link of projectLinks()) {
    const url = new URL(link.href);
    const match = url.pathname.match(/\/project\/([0-9a-f-]{36})(?:\/|$)/i);
    const id = match?.[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const card = link.closest("article,[role=article],li") || link.parentElement;
    const title = card?.querySelector("h1,h2,h3,[data-testid*=title]")?.textContent?.trim();
    const excluded = /^(open project|edit project title|delete project|more options)$/i;
    let direct = "";
    for (let ancestor = link.parentElement, depth = 0; ancestor && ancestor !== document.body && depth < 20 && !direct; ancestor = ancestor.parentElement, depth++) {
      const lines = (ancestor.innerText || ancestor.textContent || "").split(/\n+/).map(text => text.replace(/\s+/g, " ").trim());
      direct = lines.find(text => text && text.length <= 100 && !/^\d+$/.test(text) && !excluded.test(text)) || "";
      if (direct) break;
      direct = [...ancestor.querySelectorAll("span,p,div")]
        .filter(el => !el.closest("a,button,[role=button]"))
        .map(el => [...el.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join("").replace(/\s+/g, " ").trim())
        .find(text => text && text.length <= 100 && !/^\d+$/.test(text) && !excluded.test(text)) || "";
    }
    const aria = link.getAttribute("aria-label") || card?.getAttribute("aria-label");
    const name = (title || direct || (!excluded.test(aria || "") ? aria : "") || link.textContent || "").replace(/\s+/g, " ").trim();
    projects.push({ id, name: name.slice(0, 100) || `Flow project ${projects.length + 1}`, url: `${url.origin}${url.pathname}`, active: false });
  }
  return projects;
}

// Native Flow operations deliberately return project media handles, never local paths. The
// backend owns files and downloads; this layer only drives the page and reports what Flow did.
function flowError(code, message, retryable = false, outcomeUnknown = false) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  error.outcome_unknown = outcomeUnknown;
  return error;
}
function flowButton(name, root = document) {
  return [...root.querySelectorAll('button,[role="button"]')].find(el =>
    visible(el) && matchesName(accessibleName(el).replace(/\s+/g, " ").trim(), name, null, true));
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
function flowTileOptionsButton(tile) {
  return [...tile.querySelectorAll('button,[role="button"]')].find(el => {
    const label = accessibleName(el).replace(/\s+/g, " ").trim().toLowerCase();
    return !el.disabled && el.getAttribute("aria-disabled") !== "true" && (label === "more options" || label.startsWith("more options "));
  });
}
function flowMenuLabel(el) {
  const label = el.querySelector(".label,.item-text");
  if (label) return (label.innerText || label.textContent || "").replace(/\s+/g, " ").trim();
  const clone = el.cloneNode(true);
  clone.querySelectorAll("mat-icon,.mat-icon,.google-symbols,svg,[aria-hidden='true']").forEach(icon => icon.remove());
  return (clone.innerText || clone.textContent || accessibleName(el)).replace(/\s+/g, " ").trim();
}
function flowMenuItems(root = document) {
  return [...root.querySelectorAll('[role="menuitem"],button')].filter(visible);
}
function flowDownloadChoice(items, quality, kind) {
  const wanted = kind === "video"
    ? quality === "upscaled" ? /1080p|upscaled/i : /720p|original/i
    : quality === "upscaled" ? /upscaled|2x|4x|2k/i : /original|1k/i;
  return items.find(item => !item.disabled && item.getAttribute("aria-disabled") !== "true" && wanted.test(flowMenuLabel(item)));
}
async function revealFlowSubmenu(trigger, parentMenu, quality, kind) {
  const rect = trigger.getBoundingClientRect();
  const point = { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
  const pointer = { ...point, pointerId: 1, pointerType: "mouse", relatedTarget: parentMenu };
  const mouse = { ...point, relatedTarget: parentMenu };
  const knownMenus = new Set(document.querySelectorAll('[role="menu"],mat-menu-panel'));
  const find = () => {
    for (const id of [trigger.getAttribute("aria-controls"), trigger.getAttribute("aria-owns")].filter(Boolean)) {
      const target = document.getElementById(id);
      if (target && target !== parentMenu && visible(target)) return target;
    }
    const candidates = [...document.querySelectorAll('[role="menu"],mat-menu-panel')].filter(menu => menu !== parentMenu && visible(menu));
    return candidates.find(menu => flowDownloadChoice(flowMenuItems(menu), quality, kind)) || candidates.find(menu => !knownMenus.has(menu));
  };
  for (const event of ["pointerover", "pointerenter", "pointermove", "pointerdown", "pointerup"]) {
    trigger.dispatchEvent(new PointerEvent(event, { ...pointer, ...(event.endsWith("down") || event.endsWith("up") ? { button: 0 } : {}) }));
  }
  for (const event of ["mouseover", "mouseenter", "mousemove"]) trigger.dispatchEvent(new MouseEvent(event, mouse));
  trigger.focus();
  for (let attempt = 0; attempt < 6; attempt++) {
    await wait(150);
    const submenu = find();
    if (submenu) return submenu;
    if (attempt === 2) {
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    }
  }
  // Some Flow builds open Angular Material submenus on activation instead of hover.
  trigger.click();
  for (let attempt = 0; attempt < 6; attempt++) {
    await wait(150);
    const submenu = find();
    if (submenu) return submenu;
  }
  return null;
}
async function revealFlowTileOptions(tile) {
  tile.scrollIntoView({ behavior: "instant", block: "center" });
  const target = tile.querySelector("img,video,[role=img]") || tile;
  const rect = target.getBoundingClientRect();
  const point = { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
  for (const event of ["pointerover", "pointerenter", "pointermove", "mouseover", "mouseenter", "mousemove"]) {
    const Ctor = event.startsWith("pointer") ? PointerEvent : MouseEvent;
    target.dispatchEvent(new Ctor(event, { ...point, pointerId: 1, pointerType: "mouse" }));
  }
  // The Flow V2 button exists in the tile DOM while CSS hides it until hover.
  // Synthetic hover does not update Chromium's :hover state, so activate that
  // tile-scoped control directly before falling back to Flow's context menu.
  const button = flowTileOptionsButton(tile);
  if (button) return button;
  const deadline = Date.now() + 1800;
  while (Date.now() < deadline) {
    const revealed = flowTileOptionsButton(tile);
    if (revealed) return revealed;
    await wait(100);
  }
  return null;
}
async function waitForFlowTileMedia(tile, title, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastState = "media element missing";
  while (Date.now() < deadline) {
    if (!tile.isConnected) throw flowError("FLOW_ASSET_CHANGED", `The tile for "${title}" changed while preparing its download.`, true);
    const errorTile = tile.querySelector("flow-error-tile");
    const retryControl = [...tile.querySelectorAll('button,[role="button"]')].find(el => /^(retry|try again)$/i.test(flowMenuLabel(el) || accessibleName(el).replace(/\s+/g, " ").trim()));
    if (errorTile || retryControl) {
      const reason = (errorTile?.innerText || errorTile?.textContent || flowMenuLabel(retryControl) || "").replace(/\s+/g, " ").trim();
      throw flowError("FLOW_GENERATION_FAILED", `Flow marked "${title}" as failed${reason ? `: ${reason}` : ""}.`, false, true);
    }
    const media = [...tile.querySelectorAll("video,img")];
    for (const element of media) {
      const src = element.currentSrc || element.getAttribute("src") || "";
      const placeholder = !src || src.includes("media.html") || src.endsWith(".html") || src.startsWith("chrome-extension://");
      const validSource = !placeholder && (isFlowMediaSource(src) || element.getAttribute("src")?.startsWith("/fx/"));
      const ready = element instanceof HTMLVideoElement
        ? validSource
        : validSource && (element.complete && element.naturalWidth > 0 || mediaId(tile)?.startsWith("asb:"));
      lastState = `media found (valid source: ${validSource}, ready: ${ready})`;
      if (ready) return element;
    }
    await wait(200);
  }
  throw flowError("FLOW_MEDIA_NOT_READY", `Flow has not finished loading media for "${title}" (${lastState}).`, true);
}
function flowRadio(name) {
  return [...document.querySelectorAll('[role="radio"],mat-radio-button')].find(el =>
    visible(el) && matchesName(accessibleName(el).replace(/\s+/g, " ").trim(), name, null, true));
}
function flowOption(name) {
  const expected = String(name).replace(/\s+/g, " ").trim().toLowerCase();
  return [...document.querySelectorAll('[role="radio"],mat-radio-button,[role="tab"],[role="option"],button,[role="button"]')].find(el => {
    const label = accessibleName(el).replace(/\s+/g, " ").trim().toLowerCase();
    return visible(el) && (label === expected || label.endsWith(` ${expected}`));
  });
}
async function activateFlowSubmitButton(button) {
  if (!(button instanceof HTMLButtonElement) || !button.isConnected) {
    throw flowError("FLOW_SUBMIT_BUTTON_MISSING", "Flow's Start generation button disappeared before activation.", true);
  }
  const token = crypto.randomUUID();
  button.setAttribute("data-flow-mcp-submit-token", token);
  try {
    button.removeAttribute("data-flow-mcp-submit-result");
    button.setAttribute("data-flow-mcp-submit-request", token);
    const deadline = Date.now() + 5000;
    let activation;
    while (Date.now() < deadline) {
      const raw = button.getAttribute("data-flow-mcp-submit-result");
      if (raw) {
        try {
          const result = JSON.parse(raw);
          if (result?.token === token) { activation = result; break; }
        } catch { /* The main-world bridge may still be writing the result. */ }
      }
      await wait(50);
    }
    button.removeAttribute("data-flow-mcp-submit-request");
    button.removeAttribute("data-flow-mcp-submit-result");
    if (!activation) throw flowError("FLOW_SUBMIT_BRIDGE_TIMEOUT", "The Flow main-world submit bridge did not answer. Refresh the Flow tab and retry.", true);
    if (!activation?.success && !activation?.clickDelivered && !activation?.controlAccepted) {
      const detail = activation?.error || "no matching Flow listener";
      const bridge = activation?.bridgeReadyState && ` Bridge started at document.readyState=${activation.bridgeReadyState}; captured ${activation.capturedClickRegistrations || 0} click listener(s).`;
      throw flowError("FLOW_SUBMIT_ACTIVATION_FAILED", `Flow's submit listener was not activated: ${detail}.${bridge || ""} Nothing was confirmed submitted.`, !activation?.clickDelivered, Boolean(activation?.clickDelivered));
    }
    return activation;
  } finally {
    button.removeAttribute("data-flow-mcp-submit-token");
  }
}
function nativeRadioMatching(predicate) {
  return [...document.querySelectorAll('[role="radio"],mat-radio-button')].find(el =>
    visible(el) && predicate(accessibleName(el).replace(/\s+/g, " ").trim()));
}
function nativeRadioSelected(radio) {
  return radio?.getAttribute("aria-checked") === "true" ||
    radio?.getAttribute("aria-pressed") === "true" ||
    radio?.getAttribute("aria-selected") === "true" ||
    radio?.getAttribute("data-state") === "checked" ||
    radio?.classList.contains("mat-radio-checked") ||
    radio?.classList.contains("mdc-radio--checked") ||
    radio?.classList.contains("selected") ||
    radio?.classList.contains("active") ||
    Boolean(radio?.querySelector('input[type="radio"]:checked'));
}
async function setNativeAgentSettings(confirm, aspect) {
  const composer = document.querySelector("flow-base-prompt-box");
  const settings = composer && [...composer.querySelectorAll('button,[role="button"]')].find(el =>
    visible(el) && accessibleName(el).replace(/\s+/g, " ").trim() === "Settings");
  if (!settings) throw flowError("NATIVE_CAPABILITY_UNSUPPORTED", "Flow Agent settings are not available in this view; nothing was submitted.", true);
  settings.click(); await wait(350);
  const confirmRadio = nativeRadioMatching(name => new RegExp(`^${confirm}(?:\\b|\\s)`, "i").test(name));
  if (!confirmRadio) throw flowError("NATIVE_CAPABILITY_UNSUPPORTED", "Flow Agent confirmation settings are unavailable; nothing was submitted.", true);
  if (!nativeRadioSelected(confirmRadio)) confirmRadio.click();
  if (aspect) {
    const aspectRadio = flowRadio(aspect);
    const variantRadio = flowRadio("x1");
    if (!aspectRadio || !variantRadio) throw flowError("NATIVE_CAPABILITY_UNSUPPORTED", "Flow Agent aspect or variant settings are unavailable; nothing was submitted.", true);
    if (!nativeRadioSelected(aspectRadio)) aspectRadio.click();
    if (!nativeRadioSelected(variantRadio)) variantRadio.click();
  }
  await wait(250);
  const save = flowButton("Save");
  if (!save) throw flowError("NATIVE_CAPABILITY_UNSUPPORTED", "Flow Agent settings could not be saved; nothing was submitted.", true);
  save.click(); await wait(700);
}
async function setNativeAgentMode(on) {
  const agent = flowButton("Agent");
  if (!agent) throw flowError("NATIVE_CAPABILITY_UNSUPPORTED", "Flow Agent mode is unavailable; nothing was submitted.", true);
  if ((agent.getAttribute("aria-pressed") === "true") !== on) agent.click();
  await wait(500);
  const updated = flowButton("Agent");
  if ((updated?.getAttribute("aria-pressed") === "true") !== on) throw flowError("FLOW_AGENT_MODE_FAILED", `Could not switch Flow Agent mode ${on ? "on" : "off"}.`, true);
}
async function pickNativeAgentImageModel() {
  const root = document.querySelector("flow-agent-panel") || document;
  const button = flowButton("Image generation default model", root);
  if (!button) return;
  button.click();
  let items = [];
  const menuDeadline = Date.now() + 4000;
  while (Date.now() < menuDeadline) {
    items = [...document.querySelectorAll('[role="menuitem"]')].filter(visible);
    if (items.length) break;
    await wait(100);
  }
  const candidates = items.map((el, index) => ({ el, index, name: accessibleName(el).replace(/\s+/g, " ").trim() }))
    .filter(item => /nano banana\s+\d/i.test(item.name) && !/\blite\b/i.test(item.name));
  const version = item => /nano banana\s+(\d+(?:\.\d+)*)/i.exec(item.name)?.[1].split(".").map(Number) || [];
  candidates.sort((a, b) => {
    const av = version(a), bv = version(b);
    for (let i = 0; i < Math.max(av.length, bv.length); i++) if ((av[i] || 0) !== (bv[i] || 0)) return (bv[i] || 0) - (av[i] || 0);
    return a.index - b.index;
  });
  if (candidates.length) candidates[0].el.click();
  else document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await wait(350);
}
function flowSettingsPanelVisible() {
  return Boolean(flowRadio("x1") || flowOption("x1") || flowRadio("Image") || flowOption("Image") ||
    flowRadio("Video") || flowOption("Video") || flowButton("Select model family") || flowButton("Model"));
}
async function openFlowSettings() {
  if (flowSettingsPanelVisible()) return true;
  const trigger = flowButton("Settings trigger");
  if (!trigger) throw flowError("FLOW_SETTINGS_UNAVAILABLE", "Flow's settings panel cannot be opened; no generation was submitted.", true);
  trigger.click();
  await wait(400);
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (flowSettingsPanelVisible()) return true;
    await wait(100);
  }
  throw flowError("FLOW_SETTINGS_OPEN_FAILED", "Flow's settings panel did not open; no generation was submitted.", true);
}
async function chooseRadio(name) {
  let radio = flowRadio(name) || flowOption(name);
  if (!radio && flowButton("Settings trigger")) {
    await openFlowSettings();
    const openedBy = Date.now() + 2500;
    while (Date.now() < openedBy && !radio) { await wait(100); radio = flowRadio(name) || flowOption(name); }
  }
  if (!radio) {
    const options = [...document.querySelectorAll('[role="radio"],mat-radio-button,[role="tab"],[role="option"],button,[role="button"]')]
      .filter(visible).map(el => accessibleName(el).replace(/\s+/g, " ").trim()).filter(Boolean);
    throw flowError("FLOW_OPTION_NOT_FOUND", `Flow has no visible "${name}" option for the current settings. Visible options: ${[...new Set(options)].slice(0, 30).join(", ") || "none"}.`);
  }
  if (!nativeRadioSelected(radio)) radio.click();
  await wait(400);
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const current = flowRadio(name) || flowOption(name);
    if (nativeRadioSelected(current)) return;
    // Some Flow versions close the settings popover immediately after accepting a radio.
    if (!current && (!radio.isConnected || !visible(radio))) return;
    await wait(100);
  }
  // Retry the same radio once only while it is still visible and unselected.
  // This is safe before submit and helps when Flow drops a click during a slow repaint.
  radio = flowRadio(name) || flowOption(name);
  if (radio && !nativeRadioSelected(radio)) {
    radio.click();
    const retryDeadline = Date.now() + 2500;
    while (Date.now() < retryDeadline) {
      const current = flowRadio(name) || flowOption(name);
      if (nativeRadioSelected(current) || (!current && (!radio.isConnected || !visible(radio)))) return;
      await wait(100);
    }
  }
  throw flowError("FLOW_OPTION_SELECTION_FAILED", `Flow did not confirm that "${name}" was selected. Nothing was submitted.`, true);
}
async function chooseNativeVariantCount(count) {
  const variants = Math.max(1, Math.min(4, Number(count) || 1));
  const name = `x${variants}`;
  await openFlowSettings();
  let option = flowRadio(name) || flowOption(name);
  if (!option) throw flowError("FLOW_VARIANT_OPTION_MISSING", `Flow did not show the ${name} output option. Nothing was submitted.`, true);
  // Explicitly re-apply the requested count on every job, even when Flow shows it selected already.
  option.click();
  await wait(450);

  const summaryConfirms = () => {
    const trigger = flowButton("Settings trigger");
    const summary = (trigger?.innerText || trigger?.textContent || "").replace(/\s+/g, " ").trim();
    return new RegExp(`(?:^|\\s)${name}(?:\\s|$)`, "i").test(summary);
  };
  const deadline = Date.now() + 5000;
  let stableSelectionChecks = 0;
  let stableSummaryChecks = 0;
  while (Date.now() < deadline) {
    option = flowRadio(name) || flowOption(name);
    if (summaryConfirms()) {
      if (++stableSummaryChecks >= 2) { await wait(300); return variants; }
    } else stableSummaryChecks = 0;
    if (option && nativeRadioSelected(option)) {
      if (++stableSelectionChecks >= 2) { await wait(300); return variants; }
    } else {
      stableSelectionChecks = 0;
      // If Flow closes the panel after selection, accept only its updated xN summary.
      if ((!option || !option.isConnected || !visible(option)) && summaryConfirms()) {
        await wait(300);
        return variants;
      }
    }
    await wait(200);
  }
  throw flowError("FLOW_VARIANT_SELECTION_UNCONFIRMED", `Flow did not confirm the requested ${name} output count. Nothing was submitted.`, true);
}
async function closeFlowSettings() {
  const isOpen = () => Boolean(flowRadio("x1") || flowOption("x1"));
  if (!isOpen()) return;
  // Flow can ignore a synthetic Escape, so use its own settings toggle and confirm the
  // quantity controls are actually gone before allowing the submit action to continue.
  const trigger = flowButton("Settings trigger");
  if (trigger) {
    trigger.click();
    const closeDeadline = Date.now() + 2500;
    while (Date.now() < closeDeadline && isOpen()) await wait(100);
  }
  if (isOpen()) {
    document.querySelector(".ProseMirror")?.click();
    const closeDeadline = Date.now() + 2000;
    while (Date.now() < closeDeadline && isOpen()) await wait(100);
  }
  if (isOpen()) throw flowError("FLOW_SETTINGS_CLOSE_FAILED", "Flow's settings panel stayed open after choosing the quantity. Nothing was submitted.", true);
}
async function chooseNativeModel(model, type) {
  if (!model) return;
  const legacyImage = type === "image" && /^\s*(nano banana( 2)?|latest)?\s*$/i.test(model);
  let button = flowButton("Select model family") || flowButton("Model");
  if (!button) {
    await openFlowSettings();
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline && !button) {
      button = flowButton("Select model family") || flowButton("Model");
      if (!button) await wait(100);
    }
  }
  if (!button) throw flowError("NATIVE_CAPABILITY_UNSUPPORTED", "Flow's model selector is unavailable; nothing was submitted.", true);
  // Open the model list and re-apply the requested model for each job instead of trusting
  // a value left selected by the previous operation or by the user's earlier session.
  button.click();
  await wait(450);
  let items = [];
  const menuDeadline = Date.now() + 4000;
  while (Date.now() < menuDeadline) {
    items = [...document.querySelectorAll('[role="menuitem"]')].filter(visible);
    if (items.length) break;
    await wait(100);
  }
  const names = items.map(accessibleName).map(name => name.replace(/\s+/g, " ").trim());
  let index = legacyImage ? names.reduce((best, name, i) => {
    const match = /nano banana\s+(\d+(?:\.\d+)*)(?!.*\blite\b)/i.exec(name);
    if (!match || /\blite\b/i.test(name)) return best;
    const version = match[1].split(".").map(Number);
    const score = version.reduce((value, part) => value * 1000 + part, 0);
    return score > best.score ? { index: i, score } : best;
  }, { index: -1, score: -1 }).index : names.findIndex(name => name.toLowerCase().includes(model.toLowerCase()));
  if (index < 0) {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    throw flowError("FLOW_MODEL_NOT_FOUND", `Model "${model}" was not found in Flow. Available: ${names.join(", ")}`, true);
  }
  items[index].click();
  await wait(500);
  const selected = () => {
    const trigger = flowButton("Settings trigger");
    const settingSummary = (trigger?.innerText || trigger?.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (legacyImage ? /nano banana\s+\d/i.test(settingSummary) && !/\blite\b/i.test(settingSummary) : settingSummary.includes(model.toLowerCase())) return true;
    return [...document.querySelectorAll('button,[role="button"]')].some(el => {
      if (!visible(el)) return false;
      const label = accessibleName(el).replace(/\s+/g, " ").trim().toLowerCase();
      return legacyImage ? /nano banana\s+\d/i.test(label) && !/\blite\b/i.test(label) : label.includes(model.toLowerCase());
    });
  };
  const selectDeadline = Date.now() + 4000;
  while (Date.now() < selectDeadline && !selected()) await wait(100);
  if (!selected()) throw flowError("FLOW_MODEL_SELECTION_FAILED", `Flow did not confirm model "${model}" within 4 seconds. Nothing was submitted.`, true);
  await wait(350);
}
async function chooseNativePickerAsset(assetName, slot) {
  const wanted = String(assetName).trim().toLocaleLowerCase();
  const wantedStem = wanted.replace(/\.(?:png|jpe?g|webp|gif|heic|heif|avif|mp4|m4v|mov|webm|avi|mkv|3gp)$/i, "");
  const openerName = slot === "start" ? "Start" : slot === "end" ? "End" : "Add ingredients to the prompt box";
  let opener = flowButton(openerName);
  if (!opener) throw flowError("NATIVE_CAPABILITY_UNSUPPORTED", `Flow's ${slot || "reference"} picker is unavailable; nothing was submitted.`, true);
  let list;
  for (let attempt = 0; attempt < 3; attempt++) {
    const priorLists = new Set(document.querySelectorAll('[role="listbox"]'));
    opener.click();
    const controlledIds = [opener.getAttribute("aria-controls"), opener.getAttribute("aria-owns")].filter(Boolean).flatMap(value => value.split(/\s+/));
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      const controlled = controlledIds.map(id => document.getElementById(id)).find(el => el?.getAttribute("role") === "listbox" && visible(el));
      const visibleLists = [...document.querySelectorAll('[role="listbox"]')].filter(visible);
      list = controlled || visibleLists.find(el => !priorLists.has(el)) || visibleLists.at(-1);
      if (list) break;
      await wait(100);
    }
    if (list) break;
    if (attempt < 2) { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await wait(400); opener = flowButton(openerName); }
  }
  if (!visible(list)) throw flowError("FLOW_ASSET_PICKER_MISSING", `Flow's ${slot || "reference"} asset picker did not open.`, true);
  const findTab = name => [...document.querySelectorAll('[role="tab"]')].find(tab => visible(tab) && accessibleName(tab).replace(/\s+/g, " ").trim() === name);
  const allTab = findTab("All");
  if (allTab && allTab.getAttribute("aria-selected") !== "true") { allTab.click(); await wait(300); }
  const optionNames = option => {
    const values = [accessibleName(option), option.getAttribute("aria-label"), option.getAttribute("title")];
    for (const node of option.querySelectorAll("[aria-label],[title],img[alt],flow-grid-tile-container")) {
      values.push(node.getAttribute("aria-label"), node.getAttribute("title"), node.getAttribute("alt"));
    }
    return values.map(value => String(value || "").replace(/\s+/g, " ").trim().toLocaleLowerCase()).filter(Boolean);
  };
  const findOptions = () => [...list.querySelectorAll('[role="option"]')].filter(option => {
    if (!visible(option)) return false;
    return optionNames(option).some(label => label === wanted || label === wantedStem);
  });
  const requireUniqueOption = () => {
    const matches = findOptions();
    if (matches.length > 1) throw flowError("FLOW_ASSET_AMBIGUOUS", `Flow's picker has ${matches.length} exact matches for "${assetName}"; no asset was selected.`, true);
    return matches[0] || null;
  };
  let option = requireUniqueOption();
  if (!option) for (const tabName of ["Characters", "Avatars", "Uploads"]) {
    const tab = findTab(tabName);
    if (!tab) continue;
    tab.click(); await wait(350); option = requireUniqueOption(); if (option) break;
  }
  if (!option) {
    const visibleNames = [...list.querySelectorAll('[role="option"]')].filter(visible).slice(0, 12).map(option => optionNames(option).slice(0, 3).join(" / ")).filter(Boolean);
    throw flowError("FLOW_ASSET_NOT_FOUND", `Flow's picker does not contain an exact match for "${assetName}". Visible entries: ${visibleNames.join("; ") || "none"}. No asset was selected.`, true);
  }
  option.click(); await wait(300);
  const add = flowButton("Add to prompt");
  if (!slot && add) { add.click(); await wait(300); }
  return true;
}
async function waitForNativeMediaTile(assetName, command, kind) {
  const deadline = Date.now() + (kind === "video" ? 60_000 : 90_000);
  let priorProgress = "";
  const stems = new Set([String(assetName).toLowerCase(), String(assetName).replace(/\.(?:png|jpe?g|webp|gif|heic|heif|avif|mp4|m4v|mov|webm|avi|mkv|3gp)$/i, "").toLowerCase()]);
  while (Date.now() < deadline) {
    const tile = [...document.querySelectorAll("flow-grid-tile-container")]
      .find(item => stems.has(String(item.getAttribute("aria-label") || "").trim().toLowerCase()));
    if (tile) {
      if (tile.querySelector("flow-error-tile")) throw flowError("FLOW_UPLOAD_REJECTED", `Flow rejected uploaded ${kind} "${assetName}".`, false, true);
      const media = kind === "video" ? tile.querySelector("video, img[data-media-id], flow-video-tile") : tile.querySelector("img[data-media-id], flow-image-tile img");
      const loadedImage = media instanceof HTMLImageElement && media.complete && media.naturalWidth > 0;
      const loadedVideo = media instanceof HTMLVideoElement && (media.readyState >= 1 || Boolean(media.currentSrc || media.src));
      const identity = mediaId(tile);
      const hasPersistentIdentity = identity && !identity.startsWith("title:");
      if (hasPersistentIdentity || media?.getAttribute?.("data-media-id") || loadedImage || loadedVideo) return tile.getAttribute("aria-label") || assetName;
    }
    const typeName = kind === "video" ? "video" : "image";
    const progress = tile ? `Flow is processing uploaded ${typeName} ${assetName}` : `Waiting for Flow to receive uploaded ${typeName} ${assetName}`;
    if (progress !== priorProgress) { emitFlowProgress(command, progress); priorProgress = progress; }
    await wait(500);
  }
  throw flowError("FLOW_UPLOAD_TIMEOUT", `Flow did not confirm that ${kind} "${assetName}" finished uploading. Inspect Flow before retrying.`, false, true);
}
async function uploadStagedFlowMedia(file, kind, command) {
  const isFlowV2 = /\/(?:fx\/tools\/flow|fx\/flow)(?:\/|$)/i.test(location.pathname);
  const mediaRoots = () => [...document.querySelectorAll('[role="dialog"],[role="menu"],[role="listbox"],[data-state="open"],mat-dialog-container,mat-menu-panel')].filter(visible);
  const findUploadTab = () => [...document.querySelectorAll('[role="tab"]')].find(el =>
    visible(el) && accessibleName(el).replace(/\s+/g, " ").trim().toLowerCase() === "upload");
  const findUploadAction = () => {
    const roots = [...mediaRoots(), document];
    const candidates = roots.flatMap(root => [...root.querySelectorAll('button,[role="button"],[role="menuitem"]')]);
    return candidates.find(el => {
      if (!visible(el) || el.matches('[role="tab"]') || el.disabled || el.getAttribute("aria-disabled") === "true") return false;
      const label = accessibleName(el).replace(/\s+/g, " ").trim().toLowerCase();
      const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      const materialIcon = [...el.querySelectorAll("i,mat-icon,[class*='icon']")].map(icon => (icon.textContent || "").trim().toLowerCase()).join(" ");
      return /^(upload|upload media|upload file|tải lên|tải tệp lên|tải nội dung nghe nhìn lên)$/.test(label) ||
        /^(upload|upload media|upload file|tải lên|tải tệp lên|tải nội dung nghe nhìn lên)$/.test(text) ||
        /^(upload|upload_file|file_upload)$/.test(materialIcon);
    });
  };
  const clickFlowControl = element => {
    const rect = element.getBoundingClientRect();
    const point = { bubbles: true, cancelable: true, composed: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0 };
    element.focus?.();
    element.dispatchEvent(new PointerEvent("pointerdown", { ...point, pointerId: 1, pointerType: "mouse" }));
    element.dispatchEvent(new MouseEvent("mousedown", point));
    element.dispatchEvent(new PointerEvent("pointerup", { ...point, pointerId: 1, pointerType: "mouse" }));
    element.dispatchEvent(new MouseEvent("mouseup", point));
    element.dispatchEvent(new MouseEvent("click", point));
  };
  const beforeInputs = new Set(document.querySelectorAll('input[type="file"]'));
  const uploadButton = flowButton("Add media menu") || (isFlowV2 && flowButton("Add ingredients to the prompt box"));
  const acceptsMedia = input => {
    const accept = String(input.getAttribute("accept") || "").toLowerCase();
    return kind === "video"
      ? !accept || accept.includes("video") || accept.includes("*/*") || /mp4|mov|webm|avi|mkv|3gp/.test(accept)
      : !accept || accept.includes("image") || /png|jpe?g|webp|gif|heic|heif|avif/.test(accept);
  };
  let dispatched = false;
  if (kind === "video") {
    const videoInput = [...document.querySelectorAll('input[type="file"]')].find(acceptsMedia);
    if (videoInput) {
      try {
        const result = await FlowNativeFileTransfer.assignFileToFlowInput(file, videoInput);
        dispatched = result.success === true;
      } catch { /* Fall back to the upload menu and file-picker trap. */ }
    }
  }
  if (!dispatched) {
    if (!uploadButton && !isFlowV2) {
      if (kind !== "video") throw flowError("FLOW_UPLOAD_UNAVAILABLE", "Flow's upload menu is unavailable.", false);
      await FlowNativeFileTransfer.dropFileToFlow(file);
    } else {
      if (uploadButton) uploadButton.click();
      const menuDeadline = Date.now() + 5000;
      let uploadItem = null;
      let newlyCreatedInput = null;
      while (Date.now() < menuDeadline && !uploadItem && !newlyCreatedInput) {
        await wait(100);
        // Flow V2 first shows an Upload category tab. Select it, then click the
        // separate upload-media action inside that category (TobyFlow's flow).
        const uploadTab = isFlowV2 && findUploadTab();
        if (uploadTab && uploadTab.getAttribute("aria-selected") !== "true") clickFlowControl(uploadTab);
        uploadItem = findUploadAction();
        newlyCreatedInput = [...document.querySelectorAll('input[type="file"]')].find(input => !beforeInputs.has(input) && acceptsMedia(input));
      }
      if (newlyCreatedInput) {
        try {
          const result = await FlowNativeFileTransfer.assignFileToFlowInput(file, newlyCreatedInput);
          dispatched = result.success === true;
        } catch { /* Use the menu's upload action below if direct assignment was refused. */ }
      }
      if (dispatched) {
        // Continue to the shared completion check below.
      } else if (!uploadItem) {
        if (kind === "video") {
          await FlowNativeFileTransfer.dropFileToFlow(file);
          dispatched = true;
        } else {
          const menuText = mediaRoots().map(root => (root.innerText || "").replace(/\s+/g, " ").trim().slice(0, 300)).filter(Boolean).join(" | ");
          throw flowError("FLOW_UPLOAD_MENU_MISSING", `Flow's upload control was not found after opening its media menu${menuText ? ` (${menuText})` : ""}.`, true);
        }
      } else {
        try {
          await FlowNativeFileTransfer.selectFileThroughPicker(file, () => clickFlowControl(uploadItem));
          dispatched = true;
        } catch (error) {
          if (kind !== "video") throw flowError("FLOW_UPLOAD_CONTROL_NOT_OPENED", "Flow's upload action did not open a file input, so the file was not selected and no upload was started. Retry after reloading the Flow extension page.", true, false);
          await FlowNativeFileTransfer.dropFileToFlow(file);
          dispatched = true;
        }
      }
    }
  }
  if (kind === "video") await confirmFlowVideoUploadIfPrompted();
  await waitForNativeMediaTile(file.name, command, kind);
  return { uploaded: true, name: file.name, kind };
}
async function confirmFlowVideoUploadIfPrompted() {
  for (let attempt = 0; attempt < 24; attempt++) {
    const dialog = [...document.querySelectorAll('[role="dialog"],mat-dialog-container')].find(el =>
      visible(el) && /video|upload/i.test((el.innerText || el.textContent || "").slice(0, 1200)));
    if (!dialog) return;
    const confirm = [...dialog.querySelectorAll("button,[role=button]")].find(el =>
      visible(el) && /^(upload|continue|confirm)$/i.test(accessibleName(el).replace(/\s+/g, " ").trim()));
    if (confirm) { confirm.click(); await wait(250); return; }
    await wait(300);
  }
}
function collectNativeMedia() {
  return [...document.querySelectorAll("flow-grid-tile-container")].map(tile => {
    const kind = tile.querySelector("flow-video-tile") ? "video" : tile.querySelector("flow-image-tile") ? "image" : tile.querySelector("flow-scene-tile") ? "scene" : null;
    const title = (tile.getAttribute("aria-label") || "").trim();
    const id = mediaId(tile);
    const image = tile.querySelector("flow-image-tile img, img[src]");
    const imageLoaded = Boolean(image?.complete && image.naturalWidth > 0 && (image.currentSrc || image.getAttribute("src")));
    const videoLoaded = Boolean(tile.querySelector('img[alt="Generated video thumbnail"], video'));
    const failedTile = tile.querySelector("flow-error-tile");
    const retryControl = [...tile.querySelectorAll('button,[role="button"]')].find(el =>
      visible(el) && /^(retry|try again)$/i.test(accessibleName(el).replace(/\s+/g, " ").trim()));
    const failed = Boolean(failedTile || retryControl);
    const busy = /\d+%/.test(tile.innerText || "") || (kind === "image" && !failed && !imageLoaded) || (kind === "video" && !failed && !videoLoaded);
    const failureReason = failedTile ? (failedTile.innerText || failedTile.textContent || "").replace(/\s+/g, " ").trim() : "";
    return kind && title ? { id, title, kind, busy, failed, failureReason } : null;
  }).filter(Boolean);
}
function currentFlowSubmitErrors() {
  const errorWords = /(?:error|failed|could not|couldn't|unable|insufficient|not enough|quota|credit limit|try again)/i;
  return [...document.querySelectorAll('[role="alert"], [aria-live="assertive"], mat-error, .mat-mdc-form-field-error')]
    .filter(visible)
    .map(el => (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim())
    .filter(text => text && errorWords.test(text));
}
function emitFlowProgress(command, progress) {
  try { chrome.runtime.sendMessage({ type: "flow-mcp:progress", commandId: command.id || command.commandId, jobId: command.job_id || command.jobId, progress }).catch(() => {}); } catch {}
}
async function findFlowTile(title, maxSteps = 180) {
  const scroller = scrollContainer();
  if (scroller) scroller.scrollTop = 0;
  await wait(300);
  for (let step = 0; step <= maxSteps; step++) {
    const tile = [...document.querySelectorAll("flow-grid-tile-container")].find(el => el.getAttribute("aria-label") === title);
    if (tile) return tile;
    if (!scroller) break;
    const top = scroller.scrollTop, max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    if (top >= max - 2) break;
    scroller.scrollTop = Math.min(max, top + Math.max(200, scroller.clientHeight * 0.78));
    await wait(300);
  }
  return null;
}
async function countFlowTitleAcrossGrid(title) {
  if (!document.querySelector("flow-grid-tile-container")) await scanNativeAssets();
  const scroller = scrollContainer();
  if (!scroller) return [...document.querySelectorAll("flow-grid-tile-container")].filter(el => el.getAttribute("aria-label") === title).length;
  const originalTop = scroller.scrollTop, ids = new Set();
  let together = 0;
  try {
    scroller.scrollTop = 0; await wait(250);
    for (let step = 0; step < 200; step++) {
      const matched = [...document.querySelectorAll("flow-grid-tile-container")].filter(el => el.getAttribute("aria-label") === title);
      together = Math.max(together, matched.length);
      for (const tile of matched) { const id = mediaId(tile); if (id && !id.startsWith("title:")) ids.add(id); }
      const top = scroller.scrollTop, max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      if (top >= max - 2) break;
      scroller.scrollTop = Math.min(max, top + Math.max(200, scroller.clientHeight * 0.78));
      await wait(350);
    }
    const last = [...document.querySelectorAll("flow-grid-tile-container")].filter(el => el.getAttribute("aria-label") === title);
    together = Math.max(together, last.length);
    for (const tile of last) { const id = mediaId(tile); if (id && !id.startsWith("title:")) ids.add(id); }
    return Math.max(ids.size, together);
  } finally { scroller.scrollTop = originalTop; }
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
function descriptor(item) { return { id: item.id, title: item.title, kind: item.kind }; }
async function waitForProgressResult(command, before, expected, kind, timeoutMs, selector = "flow-grid-tile-container") {
  const until = Date.now() + timeoutMs;
  let hadProgress = false, last = "";
  while (Date.now() < until) {
    const fresh = collectNativeMedia().filter(item => !before.includes(item.id || `title:${item.title}`) && (!kind || item.kind === kind));
    const ready = fresh.filter(item => !item.busy && !item.failed);
    if (ready.length >= expected) return ready.slice(0, expected).map(descriptor);
    const pct = [...document.querySelectorAll(selector)].slice(0, 10).map(el => (el.innerText || "").match(/\d+%/)?.[0]).filter(Boolean);
    if (pct.length) hadProgress = true;
    const text = pct.join(", ") || (hadProgress ? "Flow is finishing the result" : "Waiting for Flow");
    if (text !== last) { emitFlowProgress(command, text); last = text; }
    const failed = fresh.find(item => item.failed);
    if (failed) throw flowError("FLOW_GENERATION_FAILED", `Flow failed while processing "${failed.title}"${failed.failureReason ? `: ${failed.failureReason}` : ""}. No retry was submitted.`, false, true);
    await wait(2500);
  }
  throw flowError("FLOW_OPERATION_TIMEOUT", "Timed out waiting for Flow. The operation may have completed; inspect Flow before retrying.", false, true);
}
function triggerFlowDownload(title, quality = "original", mediaHandle) {
  return (async () => {
    if (document.visibilityState === "hidden") {
      const activated = await chrome.runtime.sendMessage({ type: "flow-mcp:ensure-active-tab" });
      if (!activated?.ok) throw flowError("FLOW_TAB_ACTIVATION_FAILED", activated?.error || "Flow tab could not be activated for its download menu.", true);
      await wait(300);
    }
    let tile;
    if (mediaHandle) {
      const scroller = scrollContainer();
      if (scroller) scroller.scrollTop = 0;
      for (let step = 0; step < 180 && !tile; step++) {
        tile = [...document.querySelectorAll("flow-grid-tile-container")].find(candidate => mediaId(candidate) === mediaHandle);
        if (tile || !scroller) break;
        const top = scroller.scrollTop, max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        if (top >= max - 2) break;
        scroller.scrollTop = Math.min(max, top + Math.max(200, scroller.clientHeight * 0.78)); await wait(300);
      }
      if (!tile) throw flowError("FLOW_ASSET_NOT_FOUND", `Could not find media id "${mediaHandle}" in the project library; refusing to substitute another tile named "${title}".`, true);
    }
    if (!tile) tile = await findFlowTile(title);
    if (!tile) throw flowError("FLOW_ASSET_NOT_FOUND", `Could not find "${title}" in the project library.`, true);
    const scene = Boolean(tile.querySelector("flow-scene-tile"));
    const kind = tile.querySelector("flow-video-tile") ? "video" : "image";
    if (!scene) await waitForFlowTileMedia(tile, title);
    if (!tile.isConnected || mediaHandle && mediaId(tile) !== mediaHandle) {
      tile = mediaHandle
        ? [...document.querySelectorAll("flow-grid-tile-container")].find(candidate => mediaId(candidate) === mediaHandle)
        : await findFlowTile(title);
      if (!tile) throw flowError("FLOW_ASSET_CHANGED", `The selected Flow tile for "${title}" changed before its menu opened.`, true);
      tile.scrollIntoView({ behavior: "instant", block: "center" });
      if (!scene) await waitForFlowTileMedia(tile, title);
    }
    if (scene) {
      tile.click(); await wait(1200);
      const download = flowButton("Download scene");
      if (!download) throw flowError("FLOW_SCENE_DOWNLOAD_MISSING", "Scene view opened but Download scene is unavailable.", true);
      download.click();
    } else {
      const more = await revealFlowTileOptions(tile);
      let entries;
      if (more) {
        more.click(); await wait(400);
        entries = flowMenuItems();
      } else {
        // Flow V2 exposes its media actions through the media context menu. TobyFlow
        // uses this path because the tile's overflow button can remain hidden.
        const media = tile.querySelector("img,video") || tile;
        const rect = media.getBoundingClientRect();
        media.dispatchEvent(new MouseEvent("contextmenu", {
          bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2, button: 2,
        }));
        const menuDeadline = Date.now() + 1800;
        do {
          entries = flowMenuItems();
          if (entries.some(el => /^Download( image| video)?$/i.test(flowMenuLabel(el)))) break;
          await wait(100);
        } while (Date.now() < menuDeadline);
      }
      const download = entries.find(el => /^Download( image| video)?$/i.test(flowMenuLabel(el)));
      if (download) {
        if (download.getAttribute("aria-haspopup") === "menu") {
          const parentMenu = download.closest('[role="menu"],mat-menu-panel') || download.parentElement;
          const submenu = await revealFlowSubmenu(download, parentMenu, quality, kind);
          if (!submenu) throw flowError("FLOW_DOWNLOAD_SUBMENU_MISSING", `Flow opened the media menu but did not reveal download choices for "${title}".`, true);
          const choice = flowDownloadChoice(flowMenuItems(submenu), quality, kind);
          if (!choice) {
            const available = flowMenuItems(submenu).map(flowMenuLabel).filter(Boolean).join(", ") || "none";
            throw flowError("FLOW_DOWNLOAD_QUALITY_MISSING", `Flow's download menu for "${title}" has no ${quality} option. Available: ${available}.`, true);
          }
          choice.click();
        } else {
          download.click();
        }
      } else throw flowError("FLOW_TILE_MENU_MISSING", `Could not open options for "${title}".`, true);
    }
    return { title, kind: scene ? "scene" : tile.querySelector("flow-video-tile") ? "video" : "image", downloadTriggered: true, trustedGesture: false };
  })();
}
async function executeFlowOperation(name, payload = {}, command = {}) {
  if (name === "flow.projects.list") {
    if (/\/project\/[0-9a-f-]{36}(?:\/|$)/i.test(location.pathname)) {
      throw flowError("FLOW_HOMEPAGE_REQUIRED", "Project discovery needs the Flow home page. The connector should open a temporary home tab.", true);
    }
    return scanNativeProjects();
  }
  if (name === "flow.generation.upload.preflight") {
    const state = nativeRead("flowState");
    if (!state.signedIn || !state.inProject) throw flowError("FLOW_NOT_READY", state.hint || "Open a signed-in Flow project first.", true);
    // Flow creates/replaces file inputs when its upload menu opens. Do not require
    // the composer controls or an input to exist before we stage the file.
    const fileInputs = [...document.querySelectorAll('input[type="file"]')];
    return {
      ready: true,
      trustedFileSelection: false,
      hasComposer: Boolean(document.querySelector(".ProseMirror")),
      hasUploadButton: Boolean(flowButton("Add media menu")),
      fileInputCount: fileInputs.length,
    };
  }
  if (name === "flow.file.upload.begin") {
    const t = payload.transfer;
    if (!t || typeof t !== "object") throw flowError("FLOW_INVALID_ARGUMENT", "Upload metadata is required.");
    const isVideo = String(t.type || "").startsWith("video/");
    const assembler = new FlowNativeFileTransfer.UploadAssembler(t, { maxBytes: isVideo ? 200 * 1024 * 1024 : 25 * 1024 * 1024, chunkBytes: 256 * 1024, maxChunks: isVideo ? 800 : 100 });
    if (stagedNativeFiles.has(assembler.transferId)) throw flowError("FLOW_TRANSFER_DUPLICATE", "Upload transfer id is already staged.");
    nativeUploadAssemblers.set(assembler.transferId, assembler);
    return { transferId: assembler.transferId, ready: true };
  }
  if (name === "flow.file.upload.chunk") {
    const chunks = Array.isArray(payload.chunks) ? payload.chunks : [payload.chunk];
    const transferId = chunks[0]?.transferId;
    const assembler = nativeUploadAssemblers.get(transferId);
    if (!assembler) throw flowError("FLOW_TRANSFER_UNKNOWN", "Upload transfer is not active.");
    if (!chunks.length || chunks.length > 4 || chunks.some(chunk => chunk?.transferId !== transferId)) throw flowError("FLOW_INVALID_ARGUMENT", "Upload chunk batch is empty, too large, or mixes transfer ids.");
    try {
      let result;
      for (const chunk of chunks) result = await assembler.accept(chunk);
      return result;
    } catch (error) { nativeUploadAssemblers.delete(transferId); throw error; }
  }
  if (name === "flow.file.upload.finish") {
    const transferId = String(payload.transferId || "");
    const assembler = nativeUploadAssemblers.get(transferId);
    if (!assembler) throw flowError("FLOW_TRANSFER_UNKNOWN", "Upload transfer is not active.");
    try {
      const file = await assembler.finish();
      nativeUploadAssemblers.delete(transferId);
      stagedNativeFiles.set(transferId, file);
      return { transferId, staged: true, size: file.size, trustedGesture: false };
    } catch (error) { nativeUploadAssemblers.delete(transferId); throw error; }
  }
  if (name === "flow.file.upload.abort") {
    const transferId = String(payload.transferId || "");
    nativeUploadAssemblers.get(transferId)?.abort();
    nativeUploadAssemblers.delete(transferId);
    stagedNativeFiles.delete(transferId);
    return { transferId, aborted: true };
  }
  if (name === "flow.media.upload") {
    const transferId = String(payload.transferId || "");
    const file = stagedNativeFiles.get(transferId);
    const name = String(payload.name || "");
    const kind = payload.kind === "video" ? "video" : "image";
    if (!file || file.name !== name) throw flowError("FLOW_TRANSFER_UNKNOWN", "The staged media file is missing or its name does not match.", true);
    await uploadStagedFlowMedia(file, kind, command);
    return { uploaded: true, name, kind, trustedGesture: false };
  }
  if (name === "flow.asset.download") {
    const prefix = String(payload.name || "").toLowerCase();
    if (!prefix && !payload.id) throw flowError("FLOW_INVALID_ARGUMENT", "Asset name or media id is required.");
    if (payload.id) return triggerFlowDownload(String(payload.name || ""), payload.quality, String(payload.id));
    const assets = await scanNativeAssets();
    const candidates = assets.filter(asset => asset.name.toLowerCase().startsWith(prefix));
    const matches = [];
    for (const asset of candidates) {
      const count = await countFlowTitleAcrossGrid(asset.name);
      for (let i = 0; i < count; i++) matches.push(asset);
      if (matches.length > 1) break;
    }
    if (!matches.length) throw flowError("FLOW_ASSET_NOT_FOUND", `No asset title begins with "${payload.name}".`, true);
    if (matches.length > 1) throw flowError("FLOW_AMBIGUOUS_ASSET", `${matches.length} assets begin with "${payload.name}"; no download was started.`, true);
    return triggerFlowDownload(matches[0].name, payload.quality);
  }
  if (name === "flow.character.create") return globalThis.FlowCharacterActions.create(payload, command);
  if (name === "flow.character.edit") return globalThis.FlowCharacterActions.edit(payload, command);
  if (name === "flow.edit.run") {
    const params = payload.job?.params || payload.params || {};
    const source = String(params.edit_asset || "");
    const tile = await findFlowTile(source) || [...document.querySelectorAll("flow-grid-tile-container")].find(el => (el.getAttribute("aria-label") || "").toLowerCase().startsWith(source.toLowerCase()));
    if (!tile || !tile.querySelector("flow-video-tile")) throw flowError("FLOW_VIDEO_NOT_FOUND", `No video beginning "${source}" is visible in the project.`, true);
    const before = collectNativeMedia().map(item => item.id || `title:${item.title}`);
    tile.click(); await wait(1000);
    if (!/\/edit\//.test(location.pathname)) throw flowError("FLOW_EDIT_VIEW_MISSING", "Flow did not open the video editor.", true);
    const boxes = [...document.querySelectorAll(".ProseMirror")];
    if (!boxes.length) throw flowError("FLOW_COMPOSER_MISSING", "Flow's edit prompt is not visible.", true);
    setEditable(boxes[boxes.length - 1], String(params.prompt || "")); await wait(300);
    const start = flowButton("Start generation");
    if (!start || start.disabled) throw flowError("FLOW_SUBMIT_DISABLED", "Flow's edit action is unavailable; nothing was submitted.", true);
    await activateFlowSubmitButton(start);
    const results = await waitForProgressResult(command, before, 1, "video", Number(params.timeout_ms || 600000), "main");
    const back = flowButton("Back button to go to previous page"); if (back) back.click();
    return { media: results, trustedGesture: false };
  }
  if (name === "flow.agent.batch") {
    const params = payload.job?.params || payload.params || {};
    const scenes = params.agent_scenes || [];
    if (!scenes.length) throw flowError("FLOW_INVALID_ARGUMENT", "agent_scenes is required.");
    const before = collectNativeMedia().map(item => item.id || `title:${item.title}`);
    let submitted = false;
    let outcomeUnknown = false;
    try {
      await setNativeAgentMode(true);
      await setNativeAgentSettings("Never", params.aspect_ratio || "16:9");
      await pickNativeAgentImageModel();
      const box = document.querySelector(".ProseMirror");
      if (!box) throw flowError("FLOW_AGENT_COMPOSER_MISSING", "Flow's Agent composer is not visible.", true);
      const sceneText = scenes.map((scene, index) => `Scene ${index + 1}: ${String(scene).replace(/\s+/g, " ").trim()}`).join("\n");
      const script = `Generate exactly ${scenes.length} separate images: one image for each scene below, in the listed scene order. Do not combine scenes into a collage or a single image. Images only, never video. ${params.aspect_ratio || "16:9"} aspect ratio. Do not ask questions; generate them now.\n${sceneText}`;
      setEditable(box, script); await wait(300);
      const start = flowButton("Start generation");
      if (!start || start.disabled) throw flowError("FLOW_SUBMIT_DISABLED", "Flow's Agent Start generation button is disabled; nothing was submitted.", true);
      await activateFlowSubmitButton(start);
      submitted = true;
      const media = await waitForProgressResult(command, before, scenes.length, "image", Number(params.timeout_ms || 1800000), "main");
      const prompts = [];
      for (const item of media) {
        const scroller = scrollContainer();
        if (scroller) scroller.scrollTop = 0;
        await wait(250);
        let tile;
        for (let step = 0; step < 160 && !tile; step++) {
          tile = [...document.querySelectorAll("flow-grid-tile-container")].find(candidate =>
            item.id && !item.id.startsWith("title:")
              ? mediaId(candidate) === item.id
              : candidate.getAttribute("aria-label") === item.title);
          if (!tile && scroller) {
            const top = scroller.scrollTop, max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
            if (top >= max - 2) break;
            scroller.scrollTop = Math.min(max, top + Math.max(200, scroller.clientHeight * 0.78)); await wait(250);
          }
        }
        if (!tile) { prompts.push(""); continue; }
        tile.scrollIntoView({ block: "center" }); tile.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); await wait(250);
        const reuse = flowButton("Reuse prompt", tile);
        if (!reuse) { prompts.push(""); continue; }
        reuse.click(); await wait(550);
        prompts.push(document.querySelector(".ProseMirror")?.innerText || "");
        const close = flowButton("Close");
        if (close && flowButton("Start new session")) { close.click(); await wait(350); }
      }
      const clear = flowButton("Clear prompt"); if (clear) clear.click();
      return { media, prompts, trustedGesture: false };
    } catch (error) {
      outcomeUnknown = Boolean(error?.outcome_unknown) || submitted;
      throw error;
    } finally {
      // Do not alter a potentially still-running task after an uncertain result.
      if (!outcomeUnknown) {
        const session = flowButton("Start new session");
        if (session) { const close = flowButton("Close"); if (close) { close.click(); await wait(500); } }
        try { await setNativeAgentSettings("Always"); } catch {}
        await setNativeAgentMode(false).catch(() => {});
        const clear = flowButton("Clear prompt"); if (clear) clear.click();
      }
    }
  }
  if (name === "flow.continue.run") {
    const params = payload.job?.params || payload.params || {};
    const sourceName = String(params.continue_from || "");
    const likeness = params.continue_mode === "likeness";
    if (likeness && (!Array.isArray(params.attach) || !params.attach.length)) throw flowError("FLOW_INVALID_ARGUMENT", "Likeness continuation requires at least one character or avatar attachment.", true);
    const tile = [...document.querySelectorAll("flow-grid-tile-container")].find(el => (el.getAttribute("aria-label") || "").toLowerCase().startsWith(sourceName.toLowerCase()) && el.querySelector("flow-video-tile"));
    if (!tile) throw flowError("FLOW_VIDEO_NOT_FOUND", `No video beginning "${sourceName}" is visible.`, true);
    tile.click(); await wait(900);
    if (!/\/edit\//.test(location.pathname)) throw flowError("FLOW_EDIT_VIEW_MISSING", "Flow did not open the source video editor.", true);
    const next = flowButton("Skip to next clip"); if (!next) throw flowError("FLOW_TIMELINE_MISSING", "The source video timeline is not ready.", true);
    next.click(); await wait(900);
    const save = flowButton("Save frame"); if (!save) throw flowError("FLOW_SAVE_FRAME_MISSING", "Flow did not show Save frame.", true);
    save.click(); await wait(1600);
    const back = flowButton("Back button to go to previous page"); if (back) back.click(); await wait(900);
    const frameTitle = `Saved frame from ${sourceName}`;
    const frame = await findFlowTile(frameTitle);
    if (!frame) throw flowError("FLOW_FRAME_NOT_FOUND", `Flow did not add the saved frame "${frameTitle}".`, false, true);
    const more = flowButton("More options", frame); if (!more) throw flowError("FLOW_TILE_MENU_MISSING", "Could not open the saved frame menu.", true);
    more.click(); await wait(250);
    const animate = [...document.querySelectorAll('[role="menuitem"]')].find(el => visible(el) && accessibleName(el).trim() === "Animate");
    if (!animate) throw flowError("FLOW_ANIMATE_MISSING", "Flow did not show Animate for the saved frame.", true);
    animate.click(); await wait(900);
    const box = document.querySelector(".ProseMirror"); if (!box) throw flowError("FLOW_COMPOSER_MISSING", "Flow's continuation composer is not visible.", true);
    if (likeness) {
      await setNativeAgentMode(true);
      await setNativeAgentSettings("Never", params.aspect_ratio || "16:9");
      for (const reference of params.attach || []) {
        const value = String(reference || "").replace(/^asset:/i, "").trim();
        if (!value) throw flowError("FLOW_INVALID_ARGUMENT", "Likeness continuation contains an empty attachment; nothing was submitted.", true);
        await chooseNativePickerAsset(value, undefined);
      }
    }
    const cast = (params.attach || []).join(" and ");
    const prompt = `${likeness
      ? `Use R2V, reference-to-video, with the attached frame and ${cast || "the attached reference"} both as references, so the look and person stay consistent through the clip. Open as close to the attached frame as possible.`
      : "Use I2V, Flow's first frame animation tool. The attached frame is the FIRST FRAME of this clip: begin exactly on it, preserve framing and scene, and continue with no cut. Do not use any other reference."} ${params.prompt || ""}`;
    setEditable(box, prompt);
    const before = collectNativeMedia().map(item => item.id || `title:${item.title}`);
    const start = flowButton("Start generation"); if (!start || start.disabled) throw flowError("FLOW_SUBMIT_DISABLED", "Flow's continuation Start generation button is disabled.", true);
    await activateFlowSubmitButton(start);
    try {
      const media = await waitForProgressResult(command, before, 1, "video", Number(params.timeout_ms || 720000), "main");
      const session = flowButton("Start new session");
      if (session) { const close = flowButton("Close"); if (close) { close.click(); await wait(350); } }
      try { await setNativeAgentSettings("Always"); } catch {}
      try { await setNativeAgentMode(false); } catch {}
      const clear = flowButton("Clear prompt"); if (clear) clear.click();
      return { media, trustedGesture: false };
    } catch (error) {
      error.outcome_unknown = true;
      throw error;
    }
  }
  if (name === "flow.state") {
    const state = nativeRead("flowState");
    const settingsButton = flowButton("Settings trigger");
    if (settingsButton) state.composer = (settingsButton.innerText || accessibleName(settingsButton)).replace(/\s+/g, " ").trim();
    if (payload.detailed && state.signedIn) {
      const account = flowButton("Account details");
      if (account) {
        account.click(); await wait(500);
        const creditLink = [...document.querySelectorAll("a")].find(a => /Google Flow credits/i.test(accessibleName(a)) && visible(a));
        const creditText = creditLink ? accessibleName(creditLink) : "";
        const n = Number(creditText.replace(/[^\d]/g, ""));
        state.credits_remaining = Number.isFinite(n) && creditText ? n : undefined;
        state.plan = [...document.querySelectorAll("button")].find(b => /Account details/i.test(accessibleName(b)))?.innerText?.split("\n")[0];
        const close = flowButton("Close account panel"); if (close) close.click();
      }
    }
    return state;
  }
  if (name === "flow.assets.list") return scanNativeAssets();
  if (name === "flow.characters.list") return scanNativeCharacters();
  if (name === "flow.generation.submit") {
    const state = nativeRead("flowState");
    if (!state.signedIn || !state.inProject) throw flowError("FLOW_NOT_READY", state.hint || "Open a signed-in Flow project first.", true);
    const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
    const variants = Math.max(1, Math.min(4, Number(payload.variants || 1)));
    const frameValue = value => {
      if (typeof value === "string" && value.trim()) return { assetName: value.replace(/^asset:/i, "").trim() };
      if (!value || typeof value !== "object") return undefined;
      if (typeof value.assetName === "string" && value.assetName.trim()) return { assetName: value.assetName.trim() };
      if (validStagedLocalImage(value, /(?:start|end)/)) return value;
      return null;
    };
    const firstFrame = frameValue(payload.firstFrame), lastFrame = frameValue(payload.lastFrame);
    if (firstFrame === null || lastFrame === null || attachments.some(item => {
      if (typeof item === "string") return !item.trim();
      if (!item || typeof item !== "object") return true;
      if (typeof item.assetName === "string") return !item.assetName.trim();
      return !validStagedLocalImage(item, /(?:ref[1-3]|attach[1-3])/);
    })) throw flowError("NATIVE_CAPABILITY_UNSUPPORTED", "Native generation accepts project asset names or staged local image attachments only; nothing was submitted.", true);
    const framesMode = Boolean(firstFrame || lastFrame);
    const referenceAttachments = framesMode ? [] : attachments;
    const box = document.querySelector(".ProseMirror");
    if (!box) throw flowError("FLOW_COMPOSER_MISSING", "Flow's generation composer is not visible.", true);
    const before = collectNativeMedia().map(item => item.id || `title:${item.title}`);
    const agent = flowButton("Agent"); if (agent?.getAttribute("aria-pressed") === "true") agent.click();
    const clear = flowButton("Clear prompt"); if (clear) clear.click();
    const settingsCredits = payload.type === "image"
      ? await globalThis.FlowImageActions.prepare(payload, variants)
      : await globalThis.FlowVideoActions.prepare(payload, variants, framesMode);

    const uploadAndResolve = async (attachment, slot) => {
      if (!validStagedLocalImage(attachment, /(?:start|end|ref[1-3])/)) throw flowError("FLOW_UPLOAD_UNAVAILABLE", "Flow's staged image transfer is unavailable before file selection.", false, Boolean(slot));
      const file = stagedNativeFiles.get(attachment.transferId);
      if (!file) throw flowError("FLOW_TRANSFER_UNKNOWN", "The staged image is no longer available.", true);
      await uploadStagedFlowMedia(file, "image", command);
      await chooseNativePickerAsset(attachment.name, slot);
    };
    const resolveValue = async (value, slot) => {
      if (!value) return;
      if (value.assetName) return chooseNativePickerAsset(value.assetName, slot);
      await uploadAndResolve(value, slot);
    };
    if (firstFrame) await resolveValue(firstFrame, "start");
    if (lastFrame) await resolveValue(lastFrame, "end");
    for (const item of referenceAttachments) {
      const attachment = typeof item === "string" ? { assetName: item.replace(/^asset:/i, "").trim() } : item;
      await resolveValue(attachment, undefined);
    }
    const expectedRefs = referenceAttachments.length;
    const attachedCount = [...document.querySelectorAll("button,[role=button]")].filter(el => visible(el) && /^Ingredient\b/i.test(accessibleName(el).trim())).length;
    if (attachedCount < expectedRefs) throw flowError("FLOW_REFERENCE_ATTACH_UNCONFIRMED", `Flow shows ${attachedCount} of ${expectedRefs} reference attachment(s); no generation was submitted. Inspect Flow before retrying.`, false, true);
    const activeBox = document.querySelector(".ProseMirror");
    if (!activeBox) throw flowError("FLOW_COMPOSER_MISSING", "Flow's composer disappeared while preparing references; no generation was submitted.", false, Boolean(attachments.length));
    const promptApplied = await insertNativeFlowPrompt(activeBox, payload.prompt);
    if (!promptApplied) throw flowError("FLOW_PROMPT_INPUT_UNCONFIRMED", "Flow's composer did not confirm the full prompt text. Nothing was submitted.", true, false);
    // Flow may not calculate/render its usage quote until settings, references and prompt are applied.
    // Read it at the last safe point, immediately before activating submit.
    const renderedCredits = await waitForGenerationCreditQuote(Number.isFinite(settingsCredits) ? 1500 : 8000);
    const credits = Number.isFinite(renderedCredits) ? renderedCredits : settingsCredits;
    if (!Number.isFinite(credits)) throw flowError("FLOW_CREDIT_QUOTE_UNAVAILABLE", "Flow did not show a numeric generation credit quote after settings, references, and prompt were prepared. Nothing was submitted.", true, false);
    if (payload.maxCredits !== undefined && credits > Number(payload.maxCredits)) throw flowError("FLOW_MAX_CREDITS_EXCEEDED", `Flow quotes ${credits} credits, above max_credits=${payload.maxCredits}. Nothing was submitted.`, false, false);
    const start = await waitForEnabledFlowButton("Start generation", 10_000);
    if (!start) throw flowError("FLOW_SUBMIT_DISABLED", "Flow's Start generation button did not become ready within 10 seconds; nothing was submitted.", true);
    const errorsBeforeSubmit = new Set(currentFlowSubmitErrors());
    const activation = await activateFlowSubmitButton(start);

    // Follow TobyFlow's submit contract: a delivered click is only an attempt.
    // Require a changed control/editor or a new tile before starting the render wait.
    const submitDeadline = Date.now() + 30_000;
    let acknowledged = false;
    let lastSubmitProgress = "";
    while (Date.now() < submitDeadline) {
      const newError = currentFlowSubmitErrors().find(message => !errorsBeforeSubmit.has(message));
      if (newError) throw flowError("FLOW_SUBMIT_REJECTED", `Flow rejected the submit: ${newError}`, false, false);
      const currentStart = flowButton("Start generation");
      const currentBox = document.querySelector(".ProseMirror");
      const freshMedia = collectNativeMedia().filter(item => !before.includes(item.id || `title:${item.title}`));
      if (!currentStart || currentStart.disabled || currentStart.getAttribute("aria-disabled") === "true" ||
          currentBox?.textContent?.trim() !== String(payload.prompt || "").trim() || freshMedia.length) {
        acknowledged = true;
        break;
      }
      const progress = freshMedia.some(item => item.busy) ? "Flow accepted the submit and is rendering" : "Waiting for Flow to accept the submit";
      if (progress !== lastSubmitProgress) {
        emitFlowProgress(command, progress);
        lastSubmitProgress = progress;
      }
      await wait(250);
    }
    if (!acknowledged && !activation.controlAccepted) {
      const newError = currentFlowSubmitErrors().find(message => !errorsBeforeSubmit.has(message));
      if (newError) throw flowError("FLOW_SUBMIT_REJECTED", `Flow rejected the submit: ${newError}`, false, false);
      throw flowError("FLOW_SUBMIT_UNCONFIRMED", `Flow did not confirm the submit within 30 seconds (${activation.invoked || 0} listener(s), click delivered: ${Boolean(activation.clickDelivered)}). No render wait or download was started.`, false, true);
    }
    return {
      submitted: true,
      before,
      type: payload.type === "image" ? "image" : "video",
      expectedCount: variants,
      credits,
      activation: activation.strategy || "flow-main-world",
      acceptanceObserved: acknowledged || Boolean(activation.controlAccepted),
    };
  }
  if (name === "flow.generation.observe") {
    const before = Array.isArray(payload.before) ? payload.before : [];
    const kind = payload.kind === "image" ? "image" : payload.kind === "video" ? "video" : undefined;
    const expected = Math.max(1, Math.min(20, Number(payload.expectedCount || 1)));
    const deadline = Date.now() + Math.max(1000, Math.min(15 * 60_000, Number(payload.timeoutMs || 12 * 60_000)));
    let priorProgress = "";
    while (Date.now() < deadline) {
      const fresh = collectNativeMedia().filter(item => !before.includes(item.id || `title:${item.title}`) && !item.title.startsWith("fm-") && (!kind || item.kind === kind));
      const failed = fresh.filter(item => item.failed);
      if (failed.length) {
        const details = failed.map(item => `${item.title}${item.failureReason ? `: ${item.failureReason}` : ""}`).join("; ");
        throw flowError("FLOW_GENERATION_FAILED", `Flow reported ${failed.length} failed generation tile(s): ${details}. No automatic retry was attempted.`, false, true);
      }
      const ready = fresh.filter(item => !item.busy);
      if (ready.length >= expected) return { media: ready.slice(0, expected).map(({ id, title, kind: mediaKind }) => ({ id, title, kind: mediaKind })) };
      const percentages = [...document.querySelectorAll("flow-grid-tile-container")].slice(0, 8).map(tile => (tile.innerText || "").match(/\d+%/)?.[0]).filter(Boolean);
      const progress = percentages.join(", ") || (fresh.length ? "Flow is finishing the result" : "Waiting for Flow to start rendering");
      if (progress !== priorProgress) { emitFlowProgress(command, progress); priorProgress = progress; }
      await wait(2000);
    }
    throw flowError("FLOW_GENERATION_TIMEOUT", "Timed out waiting for Flow. The command may have been accepted; inspect the project before retrying.", false, true);
  }
  if (name === "flow.asset.rename" || name === "flow.asset.trash") {
    const title = String(payload.name || "");
    if (!title) throw flowError("FLOW_INVALID_ARGUMENT", "Asset name is required.");
    const copies = await countFlowTitleAcrossGrid(title);
    if (copies !== 1) throw flowError(copies > 1 ? "FLOW_AMBIGUOUS_ASSET" : "FLOW_ASSET_NOT_FOUND", copies > 1 ? `${copies} assets are named "${title}"; no mutation was performed.` : `Could not find asset "${title}".`, true);
    const tile = await findFlowTile(title);
    if (!tile) throw flowError("FLOW_ASSET_NOT_FOUND", `Could not find asset "${title}" after scanning the project grid.`, true);
    tile.scrollIntoView({ block: "center" }); await wait(150);
    const more = flowButton("More options", tile); if (!more) throw flowError("FLOW_TILE_MENU_MISSING", `Could not open options for "${title}".`, true);
    more.click(); await wait(200);
    const action = name === "flow.asset.trash" ? "Move to trash" : "Rename";
    const menu = [...document.querySelectorAll('[role="menuitem"]')].find(item => visible(item) && accessibleName(item).trim() === action);
    if (!menu) throw flowError("FLOW_MENU_ITEM_MISSING", `Flow did not show "${action}" for "${title}".`, true);
    menu.click(); await wait(250);
    if (name === "flow.asset.trash") return { trashed: title };
    const input = [...document.querySelectorAll('input:not([type="file"]),[contenteditable="true"]')].find(el => visible(el));
    if (!input) throw flowError("FLOW_RENAME_INPUT_MISSING", "Flow opened rename but no editable title field is visible.", false, true);
    const newName = String(payload.newName || "");
    if (!newName) throw flowError("FLOW_INVALID_ARGUMENT", "newName is required.");
    if (input.isContentEditable) input.textContent = newName;
    else { input.value = newName; input.dispatchEvent(new Event("input", { bubbles: true })); }
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
    await wait(400);
    return { renamed: title, name: newName };
  }
  throw flowError("NATIVE_CAPABILITY_UNSUPPORTED", `Native Flow operation "${name}" is not implemented.`, true);
}
function validStagedLocalImage(value, suffixPattern) {
  return Boolean(value && typeof value.transferId === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value.transferId) && stagedNativeFiles.has(value.transferId) &&
    typeof value.name === "string" && new RegExp(`^fm-[A-Za-z0-9_-]{1,32}-${suffixPattern.source}\\.(?:png|jpe?g|webp)$`, "i").test(value.name));
}
async function flowOperation(name, payload = {}, command = {}) {
  const operation = name;
  const resolved = FlowDriverRegistry.resolveForUrl(location.href, { operationHandler: executeFlowOperation });
  if (!resolved?.driver) {
    throw flowError("FLOW_UNSUPPORTED_ROUTE", "This Flow page route is not supported by the installed Flow driver.", true);
  }
  return resolved.driver.invoke(operation, payload, command);
}
const nativeUploadAssemblers = new Map();
const stagedNativeFiles = new Map();
async function execute(c) {
  if (c.op === "flowOperation") return flowOperation(c.name, c.payload || {}, c);
  throw flowError("NATIVE_CAPABILITY_UNSUPPORTED", `Unsupported native Flow command: ${String(c.op || "unknown")}`, true);
}
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type !== "flow-mcp:execute") return;
  execute(message.command).then(result => respond({ ok:true, value:result }), error => respond({ ok:false, error:{ code:error?.code || "FLOW_DOM_FAILED", message:String(error?.message || error), retryable:Boolean(error?.retryable), outcome_unknown:Boolean(error?.outcome_unknown) } }));
  return true;
});
