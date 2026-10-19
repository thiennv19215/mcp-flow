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
function blurFlowNavigationFocus() {
  const focused = document.activeElement;
  if (focused?.closest?.("mat-sidenav,[role=navigation]")) focused.blur();
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
      await ensureFlowLibrarySection("All media");
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
  await ensureFlowLibrarySection("Characters");
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
    if (/\/character\/?$/i.test(location.pathname)) {
      const back = flowButton("Go back");
      if (back) {
        back.click();
        await waitForFlowRoute(path => !/\/character\/?$/i.test(path), 5000, "Flow did not leave the empty character chooser.").catch(() => {});
      }
    }
    if (clickFlowNavigation("All media")) await wait(500);
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
    visible(el) && !isFlowProjectNavigationControl(el) && matchesName(accessibleName(el).replace(/\s+/g, " ").trim(), name, null, true));
}
function isFlowProjectNavigationControl(el) {
  if (el.closest('nav,[role="navigation"]')) return true;
  for (let parent = el; parent && parent !== document.body; parent = parent.parentElement) {
    if (/project navigation/i.test(parent.getAttribute("aria-label") || "")) return true;
  }
  return false;
}
function flowOption(name) {
  const expected = String(name).replace(/\s+/g, " ").trim().toLowerCase();
  // The closed settings trigger carries a summary such as "Video · 720p · 10s x1".
  // It is a button, but never an option; allowing it here makes x1 falsely imply
  // that the settings panel is open and can also toggle the panel during selection.
  const settingsTrigger = flowButton("Settings trigger");
  return [...document.querySelectorAll('[role="radio"],mat-radio-button,[role="tab"],[role="option"],button,[role="button"]')].find(el => {
    const label = accessibleName(el).replace(/\s+/g, " ").trim().toLowerCase();
    return visible(el) && el !== settingsTrigger && !isFlowProjectNavigationControl(el) &&
      (label === expected || label.endsWith(` ${expected}`));
  });
}
function normalizeFlowPrompt(value) {
  return String(value || "").replace(/[\u200B\u200C\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim();
}
function inspectFlowSubmitTarget(button, expectedPrompt) {
  if (!(button instanceof HTMLButtonElement) || !button.isConnected || !visible(button)) {
    throw flowError("FLOW_SUBMIT_BUTTON_MISSING", "Flow's Start generation button disappeared before activation.", true);
  }
  if (button.disabled || button.getAttribute("aria-disabled") === "true") {
    throw flowError("FLOW_SUBMIT_DISABLED", "Flow's Start generation button is disabled; nothing was submitted.", true);
  }
  const wanted = normalizeFlowPrompt(expectedPrompt);
  const editors = [...document.querySelectorAll(".ProseMirror[contenteditable='true']")].filter(visible);
  const promptBox = editors.find(editor => {
    const actual = normalizeFlowPrompt(editor.innerText || editor.textContent);
    return wanted ? actual.endsWith(wanted) : Boolean(actual);
  });
  if (!promptBox) {
    throw flowError("FLOW_SUBMIT_PROMPT_NOT_READY", "The visible Flow composer does not contain the prompt prepared for this request. Nothing was submitted.", true, false);
  }
  let composer = button.parentElement;
  while (composer && composer !== document.body && !composer.contains(promptBox)) composer = composer.parentElement;
  if (!composer || composer === document.body || !composer.contains(promptBox)) {
    throw flowError("FLOW_SUBMIT_COMPOSER_MISMATCH", "The Start generation button is not inside the composer that contains this request's prompt. Nothing was submitted.", true, false);
  }
  const rect = button.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  if (!Number.isFinite(x) || !Number.isFinite(y) || rect.width < 8 || rect.height < 8 ||
      x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) {
    throw flowError("FLOW_SUBMIT_TARGET_OUT_OF_VIEW", "Flow's submit button is not fully available in the visible viewport. Nothing was submitted.", true, false);
  }
  const hit = document.elementFromPoint(x, y);
  if (!hit || (hit !== button && !button.contains(hit))) {
    throw flowError("FLOW_SUBMIT_TARGET_OCCLUDED", "Another element covers Flow's submit button at its click point. Nothing was submitted.", true, false);
  }
  return { x, y, prompt: normalizeFlowPrompt(promptBox.innerText || promptBox.textContent) };
}
async function activateFlowSubmitButton(button, command, expectedPrompt) {
  const target = inspectFlowSubmitTarget(button, expectedPrompt);
  const requestId = command?.id ?? command?.requestId ?? command?.request_id;
  if (requestId === undefined || requestId === null || String(requestId).length === 0) {
    throw flowError("FLOW_SUBMIT_REQUEST_ID_MISSING", "Flow's submit cannot be tied to an active request. Nothing was submitted.", true, false);
  }
  try {
    const result = await chrome.runtime.sendMessage({
      type: "flow-mcp:trusted-submit-click",
      requestId: String(requestId),
      x: target.x,
      y: target.y,
      label: "Start generation",
      prompt: target.prompt,
    });
    if (!result?.ok) {
      throw flowError("FLOW_SUBMIT_ACTIVATION_FAILED", result?.error || "Chrome could not activate Flow's submit button.", true, Boolean(result?.outcome_unknown));
    }
  } catch (error) {
    if (error?.code) throw error;
    throw flowError("FLOW_SUBMIT_ACTIVATION_FAILED", `Chrome could not activate Flow's submit button (${String(error?.message || error)}). No submit was confirmed.`, true, false);
  }
  // Chrome's input pipeline produces the trusted pointer sequence Flow expects. The
  // caller still observes the page before it starts waiting for the render result.
  return { clickDelivered: true, controlAccepted: false, strategy: "cdp-trusted-click" };
}
async function waitForGenerationSubmitButton(expectedPrompt, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const candidates = [...document.querySelectorAll('button,[role="button"]')].filter(el =>
      visible(el) && matchesName(semanticActionText(el).replace(/\s+/g, " ").trim(), "Start generation", null, true));
    for (const button of candidates) {
      try {
        inspectFlowSubmitTarget(button, expectedPrompt);
        return button;
      } catch {}
    }
    await wait(150);
  }
  return null;
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
    [...control.classList].some(className => /(?:^|[-_])(?:checked|selected|active|activated)(?:$|[-_])/i.test(className))
  ) || Boolean(stateControl.querySelector('input[type="radio"]:checked,input[type="checkbox"]:checked,[aria-checked="true"],[aria-pressed="true"],[aria-selected="true"],[data-state="checked"]'));
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
  const modeIs = () => {
    const agent = flowButton("Agent");
    return Boolean(agent) && (agent.getAttribute("aria-pressed") === "true") === on;
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    if (modeIs()) return;
    const settingsDialog = [...document.querySelectorAll('[role="dialog"],mat-dialog-container,.cdk-overlay-pane')].find(el =>
      visible(el) && /Agent settings/i.test(el.innerText || el.textContent || ""));
    const save = settingsDialog && flowButton("Save", settingsDialog);
    if (save) { save.click(); await wait(400); }
    const focused = document.activeElement;
    if (focused?.closest?.("mat-sidenav,[role=navigation]")) focused.blur();
    const agent = flowButton("Agent");
    if (!agent) {
      await closeNativeAgentSession();
      if (modeIs()) return;
      await wait(250);
      continue;
    }
    agent.click();
    await wait(700);
  }
  if (!modeIs()) throw flowError("FLOW_AGENT_MODE_FAILED", `Could not switch Flow Agent mode ${on ? "on" : "off"}.`, true);
}
async function closeNativeAgentSession() {
  if (!flowButton("Start new session")) return;
  const close = flowButton("Close");
  if (close) close.click();
  await wait(700);
}
async function resetNativeAgentWorkflow() {
  await closeNativeAgentSession();
  if (/\/edit(?:\/|$)/i.test(location.pathname)) {
    const back = flowButton("Back button to go to previous page");
    if (back) back.click();
    await waitForFlowRoute(path => !/\/edit(?:\/|$)/i.test(path), 20_000, "Flow did not leave the Agent video editor.");
  }
  if (!document.querySelector("flow-grid-tile-container")) await ensureFlowLibrarySection("All media").catch(() => {});
  try { await setNativeAgentSettings("Always"); } catch {}
  try { await setNativeAgentMode(false); } catch {}
  const clear = flowButton("Clear prompt");
  if (clear) clear.click();
  else {
    const box = document.querySelector(".ProseMirror");
    if (box) replaceNativeEditableText(box, "");
  }
  await wait(350);
}
async function answerNativeAgentQuestion(answer) {
  const box = document.querySelector(".ProseMirror");
  if (!box || !replaceNativeEditableText(box, answer)) return false;
  await wait(200);
  const send = [...document.querySelectorAll("button,[role=button]")].find(el =>
    visible(el) && !el.disabled && /^(send|submit|continue)$/i.test(accessibleName(el).replace(/\s+/g, " ").trim()));
  if (send) send.click();
  else {
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
    box.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
  }
  return true;
}
async function resolveNativeAgentQuestion(command, answer) {
  for (let attempt = 0; attempt < 12; attempt++) {
    await wait(5000);
    const body = document.body?.innerText || "";
    if (/\d{1,3}%/.test(body)) return;
    if (!/Would you like to|which you prefer|I2V|R2V/i.test(body)) continue;
    emitFlowProgress(command, "Answering Flow Agent's video method question");
    if (await answerNativeAgentQuestion(answer)) {
      await wait(6000);
      return;
    }
  }
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
  const hasTypeOption = Boolean(flowRadio("Image") || flowOption("Image")) && Boolean(flowRadio("Video") || flowOption("Video"));
  const hasVariantOption = [1, 2, 3, 4].some(count => flowRadio(`x${count}`) || flowOption(`x${count}`));
  return hasTypeOption && hasVariantOption;
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
  let radio = flowRadio(name);
  if (!radio) {
    await openFlowSettings();
    const findOption = () => flowRadio(name) || flowOption(name);
    const openedBy = Date.now() + 2500;
    while (Date.now() < openedBy && !radio) { await wait(100); radio = findOption(); }
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
    const current = flowRadio(name) || (flowSettingsPanelVisible() && flowOption(name));
    if (nativeRadioSelected(current)) return;
    // Some Flow versions close the settings popover immediately after accepting a radio.
    if (!current && (!radio.isConnected || !visible(radio))) return;
    await wait(100);
  }
  // Retry the same radio once only while it is still visible and unselected.
  // This is safe before submit and helps when Flow drops a click during a slow repaint.
  radio = flowRadio(name) || (flowSettingsPanelVisible() && flowOption(name));
  if (radio && !nativeRadioSelected(radio)) {
    radio.click();
    const retryDeadline = Date.now() + 2500;
    while (Date.now() < retryDeadline) {
      const current = flowRadio(name) || (flowSettingsPanelVisible() && flowOption(name));
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
  const isOpen = () => flowSettingsPanelVisible();
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
function findRenderedSetting(name) {
  const normalized = String(name || "").replace(/\s+/g, " ").trim().toLowerCase();
  const candidates = [...document.querySelectorAll('[role="radio"],mat-radio-button,[role="tab"],[role="option"],button,[role="button"]')]
    .filter(el => visible(el) && !isFlowProjectNavigationControl(el));
  const exact = candidates.find(el => {
    const label = accessibleName(el).replace(/\s+/g, " ").trim().toLowerCase();
    return label === normalized || label.endsWith(` ${normalized}`);
  });
  if (exact) return exact;
  const seconds = /^(\d+)s$/.exec(normalized);
  if (seconds) return candidates.find(el => new RegExp(`(?:^|\\s)${seconds[1]}\\s*seconds?(?:\\s|$)`, "i").test(accessibleName(el).replace(/\s+/g, " ").trim()));
  return null;
}
async function preflightGenerationPrompt(payload, framesMode) {
  await openFlowSettings();
  const expected = [];
  if (payload.type === "image") expected.push("Image");
  else expected.push("Video");
  if (payload.aspectRatio) expected.push(payload.aspectRatio);
  expected.push(`x${Math.max(1, Math.min(4, Number(payload.variants) || 1))}`);
  if (payload.type === "video") {
    if (payload.duration) expected.push(`${payload.duration}s`);
    if (payload.resolution) expected.push(String(payload.resolution));
    expected.push(framesMode ? "Frames" : "Ingredients");
  }
  for (const name of expected) {
    const control = findRenderedSetting(name);
    const selected = nativeRadioSelected(control) || (name === "Frames" && flowButton("Start") && flowButton("End"));
    if (!control || !selected) {
      throw flowError("FLOW_SETTINGS_PREFLIGHT_FAILED", `Flow's rendered settings do not confirm "${name}" before prompt entry. Nothing was submitted.`, true, false);
    }
  }
  if (framesMode && (!flowButton("Start") || !flowButton("End"))) {
    throw flowError("FLOW_SETTINGS_PREFLIGHT_FAILED", "Flow's rendered Frames settings do not show both Start and End controls before prompt entry. Nothing was submitted.", true, false);
  }
  await closeFlowSettings();
  if (flowSettingsPanelVisible()) throw flowError("FLOW_SETTINGS_CLOSE_FAILED", "Flow's settings panel is still open before prompt entry. Nothing was submitted.", true, false);
  const deadline = Date.now() + 5000;
  let promptBox = null;
  while (Date.now() < deadline) {
    promptBox = [...document.querySelectorAll(".ProseMirror")].find(el => visible(el) && el.isContentEditable);
    if (promptBox) return promptBox;
    await wait(100);
  }
  throw flowError("FLOW_PROMPT_COMPOSER_NOT_READY", "Flow's prompt editor is not visible after closing settings. Nothing was submitted.", true, false);
}
async function restoreNativeFramesMode() {
  await openFlowSettings();
  const findFrames = () => [...document.querySelectorAll('[role="radio"],mat-radio-button,[role="tab"],[role="option"],button,[role="button"]')]
    .find(el => visible(el) && !isFlowProjectNavigationControl(el) &&
      accessibleName(el).replace(/^(?:accessibility_new|dashboard|face)\s*/i, "").replace(/\s+/g, " ").trim().toLocaleLowerCase() === "frames");
  let frames = findFrames();
  if (!frames) throw flowError("FLOW_FRAMES_MODE_UNAVAILABLE", "Flow does not show a Frames mode control after local frame upload. Nothing was submitted.", true, false);
  if (!nativeRadioSelected(frames) && frames.getAttribute("aria-selected") !== "true") frames.click();
  const hasFrameControls = () => Boolean(flowButton("Start") && flowButton("End"));
  const deadline = Date.now() + 5000;
  let confirmed = false;
  while (Date.now() < deadline) {
    frames = findFrames();
    if (frames && (nativeRadioSelected(frames) || frames.getAttribute("aria-selected") === "true" || hasFrameControls())) { confirmed = true; break; }
    if (!flowSettingsPanelVisible()) await openFlowSettings();
    await wait(100);
  }
  if (!confirmed) throw flowError("FLOW_FRAMES_MODE_UNCONFIRMED", "Flow did not confirm Frames mode after local frame upload. Nothing was submitted.", true, false);
  await closeFlowSettings();
  const controlsDeadline = Date.now() + 4000;
  while (Date.now() < controlsDeadline && !(flowButton("Start") && flowButton("End"))) await wait(100);
  if (!flowButton("Start") || !flowButton("End")) {
    throw flowError("FLOW_FRAMES_CONTROLS_UNAVAILABLE", "Flow selected Frames but did not restore both Start and End frame controls. Nothing was submitted.", true, false);
  }
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
  const chosenName = names[index];
  items[index].click();
  await wait(500);
  const summaryConfirms = () => {
    const trigger = flowButton("Settings trigger");
    const settingSummary = (trigger?.innerText || trigger?.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
    return legacyImage
      ? /nano banana\s+\d/i.test(settingSummary) && !/\blite\b/i.test(settingSummary)
      : settingSummary.includes(model.toLowerCase());
  };
  const selectDeadline = Date.now() + 4000;
  while (Date.now() < selectDeadline && !summaryConfirms()) await wait(100);
  let selectionConfirmed = summaryConfirms();
  if (!selectionConfirmed) {
    // Some Flow versions omit the selected model from the settings summary. Reopen
    // the model menu and require its requested item to expose a selected state.
    button = flowButton("Select model family") || flowButton("Model");
    if (!button) {
      await openFlowSettings();
      button = flowButton("Select model family") || flowButton("Model");
    }
    if (button) {
      button.click();
      const verifyDeadline = Date.now() + 4000;
      let verifyItems = [];
      while (Date.now() < verifyDeadline) {
        verifyItems = [...document.querySelectorAll('[role="menuitem"]')].filter(visible);
        if (verifyItems.length) break;
        await wait(100);
      }
      const wantedName = chosenName.replace(/\s+/g, " ").trim().toLowerCase();
      const chosen = verifyItems.find(item => {
        const label = accessibleName(item).replace(/\s+/g, " ").trim().toLowerCase();
        return label === wantedName || label.includes(wantedName);
      });
      const itemSelected = item => {
        if (!item) return false;
        if (["aria-selected", "aria-checked", "aria-pressed", "aria-current", "data-selected", "data-state"]
          .some(attribute => ["true", "checked", "selected", "page"].includes((item.getAttribute(attribute) || "").toLowerCase()))) return true;
        if (["selected", "active", "checked"].some(className => item.classList.contains(className))) return true;
        if (item.querySelector('input[type="radio"]:checked,input[type="checkbox"]:checked,[aria-checked="true"],[aria-selected="true"],[data-state="checked"]')) return true;
        return [...item.querySelectorAll("mat-icon")].some(icon => /^(?:check|check_circle|done|radio_button_checked)$/i.test((icon.innerText || icon.textContent || "").trim()));
      };
      selectionConfirmed = itemSelected(chosen);
      // The verification menu is only an observation step. Close it before the
      // caller continues applying settings or attempts to submit the video.
      if (chosen?.isConnected && visible(chosen)) {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await wait(200);
        if (chosen.isConnected && visible(chosen) && button?.isConnected && visible(button)) {
          button.click();
          await wait(200);
        }
      }
    }
  }
  if (!selectionConfirmed) throw flowError("FLOW_MODEL_SELECTION_FAILED", `Flow did not confirm model "${model}" in its settings summary or selected model menu item. Nothing was submitted.`, true);
  await wait(350);
}
async function chooseNativePickerAsset(assetName, slot) {
  if (!slot) return globalThis.FlowReferenceActions.attach(assetName);
  const wanted = String(assetName || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
  if (!wanted || !["start", "end"].includes(slot)) throw flowError("FLOW_INVALID_ARGUMENT", "Frame selection requires an exact asset title and a Start or End slot.", false, false);
  const buttonForSlot = () => flowButton(slot === "start" ? "Start" : "End");
  const listForOpener = (opener, priorLists) => {
    const ids = [opener?.getAttribute("aria-controls"), opener?.getAttribute("aria-owns")].filter(Boolean).flatMap(value => value.split(/\s+/));
    const controlled = ids.map(id => document.getElementById(id)).find(el => el?.getAttribute("role") === "listbox" && visible(el));
    const lists = [...document.querySelectorAll('[role="listbox"]')].filter(visible);
    return controlled || lists.find(el => !priorLists.has(el)) || lists.at(-1);
  };
  const pickerSettled = async (listGetter, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    let stableAt = 0;
    while (Date.now() < deadline) {
      const list = listGetter();
      const loading = [...document.querySelectorAll('[role="progressbar"],[aria-busy="true"]')].some(visible);
      if (list && !loading) {
        const options = [...list.querySelectorAll('[role="option"]')].filter(visible);
        if (options.length || /no (?:assets|items) found/i.test(list.innerText || "")) return list;
        if (!stableAt) stableAt = Date.now();
        if (Date.now() - stableAt >= 700) return list;
      } else stableAt = 0;
      await wait(150);
    }
    throw flowError("FLOW_ASSET_PICKER_LOADING", `Flow's ${slot} frame picker did not finish loading. Nothing was selected.`, true, false);
  };
  const findTab = name => [...document.querySelectorAll('[role="tab"]')].find(tab => visible(tab) &&
    accessibleName(tab).replace(/\s+/g, " ").trim().toLocaleLowerCase() === name.toLocaleLowerCase());
  const optionNames = option => {
    const values = [accessibleName(option), option.getAttribute("aria-label"), option.getAttribute("title")];
    for (const node of option.querySelectorAll("[aria-label],[title],img[alt],flow-grid-tile-container")) {
      values.push(node.getAttribute("aria-label"), node.getAttribute("title"), node.getAttribute("alt"));
    }
    return [...new Set(values.map(value => String(value || "").replace(/\s+/g, " ").trim().toLocaleLowerCase()).filter(Boolean))];
  };
  const isExactOption = option => optionNames(option).some(label => label === wanted ||
    label.replace(/\s+(?:image|video|character|avatar)$/i, "") === wanted);
  const optionIdentity = (option, pageIndex, itemIndex, scroller) => {
    const tile = option.querySelector("flow-grid-tile-container");
    const id = tile && mediaId(tile);
    if (id && !id.startsWith("title:")) return id;
    const image = option.querySelector("img");
    return image?.currentSrc || image?.src || option.getAttribute("data-media-id") || option.id ||
      option.getAttribute("aria-posinset") || `${wanted}|${Math.floor((scroller?.scrollTop || 0) / Math.max(1, scroller?.clientHeight || 1))}|${pageIndex}|${itemIndex}`;
  };
  const slotSignature = () => {
    const opener = buttonForSlot();
    if (!opener) return "missing";
    const container = opener.parentElement?.parentElement || opener;
    return JSON.stringify({
      label: opener.getAttribute("aria-label"), title: opener.getAttribute("title"), text: (opener.innerText || "").replace(/\s+/g, " ").trim(),
      expanded: opener.getAttribute("aria-expanded"),
      media: [...container.querySelectorAll("img,video")].map(el => el.currentSrc || el.getAttribute("src") || el.getAttribute("alt") || ""),
      names: [...container.querySelectorAll("[aria-label],[title]")].map(el => el.getAttribute("aria-label") || el.getAttribute("title")),
    });
  };

  let opener = buttonForSlot();
  if (!opener) throw flowError("FLOW_FRAMES_CONTROLS_UNAVAILABLE", `Flow's ${slot} frame picker is unavailable. Nothing was submitted.`, true, false);
  const beforeSlot = slotSignature();
  let list;
  for (let attempt = 0; attempt < 3; attempt++) {
    opener = buttonForSlot();
    if (!opener) break;
    const priorLists = new Set(document.querySelectorAll('[role="listbox"]'));
    const controlledIds = [opener.getAttribute("aria-controls"), opener.getAttribute("aria-owns")].filter(Boolean).flatMap(value => value.split(/\s+/));
    opener.click();
    const listGetter = () => {
      const controlled = controlledIds.map(id => document.getElementById(id)).find(el => el?.getAttribute("role") === "listbox" && visible(el));
      const lists = [...document.querySelectorAll('[role="listbox"]')].filter(visible);
      return controlled || lists.find(el => !priorLists.has(el)) || lists.at(-1);
    };
    try { list = await pickerSettled(listGetter, 5000); } catch (error) {
      if (attempt === 2) throw error;
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await wait(250);
      continue;
    }
    if (list) break;
  }
  if (!list || !visible(list)) throw flowError("FLOW_ASSET_PICKER_MISSING", `Flow's ${slot} frame picker did not open. Nothing was submitted.`, true, false);
  const listGetter = () => {
    const lists = [...document.querySelectorAll('[role="listbox"]')].filter(visible);
    return lists.find(item => item === list) || lists.at(-1);
  };

  const categories = ["All", "Tất cả", "Ingredients", "Thành phần", "Uploads", "Tải lên"];
  let matches = new Map();
  let scroller = null;
  let pageIndex = 0;
  try {
    let search = [...document.querySelectorAll('input,[role="textbox"]')].find(el => visible(el) && /search assets/i.test(accessibleName(el)));
    if (search) {
      setEditable(search, assetName);
      await wait(650);
      await pickerSettled(listGetter);
    }
    for (const category of categories) {
      const tab = findTab(category);
      if (tab && tab.getAttribute("aria-selected") !== "true") {
        tab.click();
        const tabDeadline = Date.now() + 5000;
        while (Date.now() < tabDeadline) {
          const current = findTab(category);
          if (current?.getAttribute("aria-selected") === "true") break;
          await wait(100);
        }
        if (findTab(category)?.getAttribute("aria-selected") !== "true") throw flowError("FLOW_ASSET_CATEGORY_UNCONFIRMED", `Flow did not select the ${category} picker category. Nothing was submitted.`, true, false);
        await pickerSettled(listGetter);
      }
      list = listGetter();
      if (!list) continue;
      search = [...document.querySelectorAll('input,[role="textbox"]')].find(el => visible(el) && /search assets/i.test(accessibleName(el)));
      if (search && String(search.value ?? "") !== assetName) {
        setEditable(search, assetName);
        await wait(650);
        await pickerSettled(listGetter);
      }
      list = listGetter();
      scroller = list && [list, ...list.querySelectorAll("*")].find(el => el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 5);
      if (scroller) scroller.scrollTop = 0;
      matches = new Map();
      for (pageIndex = 0; pageIndex < (scroller ? 150 : 1); pageIndex++) {
        list = await pickerSettled(listGetter);
        if (!list) break;
        const visibleOptions = [...list.querySelectorAll('[role="option"]')].filter(visible);
        visibleOptions.forEach((option, itemIndex) => {
          if (isExactOption(option)) matches.set(optionIdentity(option, pageIndex, itemIndex, scroller), option);
        });
        if (matches.size > 1) break;
        if (!scroller || scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 2) break;
        const previous = scroller.scrollTop;
        scroller.scrollTop = Math.min(scroller.scrollHeight - scroller.clientHeight, previous + Math.max(120, scroller.clientHeight * 0.75));
        await wait(250);
        if (scroller.scrollTop === previous) break;
      }
      if (matches.size) break;
    }
    if (matches.size > 1) throw flowError("FLOW_AMBIGUOUS_ASSET", `More than one project image is titled "${assetName}"; no frame was selected.`, false, false);
    if (!matches.size) {
      const visibleNames = [...(list?.querySelectorAll('[role="option"]') || [])].filter(visible).slice(0, 12).map(option => optionNames(option).slice(0, 3).join(" / ")).filter(Boolean);
      throw flowError("FLOW_ASSET_NOT_FOUND", `Flow's ${slot} frame picker has no exact asset titled "${assetName}". Visible entries: ${visibleNames.join("; ") || "none"}. Nothing was selected.`, true, false);
    }
    const option = [...matches.values()][0];
    option.click();
    const selectionDeadline = Date.now() + 5000;
    let attached = false;
    while (Date.now() < selectionDeadline) {
      const currentList = listGetter();
      const selected = currentList && [...currentList.querySelectorAll('[role="option"]')].find(item => isExactOption(item) &&
        (item.getAttribute("aria-selected") === "true" || item.getAttribute("aria-checked") === "true" || item.getAttribute("data-state") === "checked"));
      if (selected || (slotSignature() !== beforeSlot && !currentList)) { attached = true; break; }
      await wait(150);
    }
    if (!attached) throw flowError("FLOW_FRAME_ATTACH_UNCONFIRMED", `Flow did not confirm that "${assetName}" was selected for the ${slot} frame. Nothing was submitted.`, false, false);
    return true;
  } finally {
    const openPicker = () => {
      const currentList = listGetter();
      return currentList && visible(currentList) ? currentList : null;
    };
    if (openPicker()) {
      const currentList = openPicker();
      const closeButton = flowButton("Close", currentList.closest('[role="dialog"]') || document);
      if (closeButton) closeButton.click();
      else document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      const closeDeadline = Date.now() + 2500;
      while (Date.now() < closeDeadline && openPicker()) await wait(100);
      if (openPicker()) throw flowError("FLOW_ASSET_PICKER_CLOSE_FAILED", `Flow's ${slot} frame picker stayed open after selection. Inspect the composer before retrying.`, true, false);
    }
  }
}
function findAddMediaButton() {
  const direct = flowButton("Add media menu");
  if (direct) return direct;
  const addNames = new Set(["add media menu", "add media", "thêm nội dung nghe nhìn", "thêm tệp", "thêm", "add"]);
  return [...document.querySelectorAll('button,[role="button"]')].find(el => {
    if (!visible(el) || el.disabled || el.getAttribute("aria-disabled") === "true") return false;
    const label = accessibleName(el).replace(/\s+/g, " ").trim().toLowerCase();
    if (addNames.has(label) || label === "+" || label.endsWith(" add")) return true;
    const icon = el.querySelector("mat-icon,.mat-icon,.google-symbols,.material-symbols-outlined,svg")?.textContent?.trim() || "";
    return icon === "add" || icon === "add_circle";
  }) || null;
}

async function ensureAddMediaButton() {
  let button = findAddMediaButton();
  if (button) return button;
  // Flow V2 hides composer '+' button when in Video Frames mode; switch to Ingredients mode to recover it
  try {
    const settingsTrigger = flowButton("Settings trigger") || [...document.querySelectorAll('button,[role="button"]')].find(el => {
      if (!visible(el)) return false;
      const icon = el.querySelector("mat-icon,.mat-icon,.google-symbols,.material-symbols-outlined,svg")?.textContent?.trim() || "";
      const label = accessibleName(el).toLowerCase();
      return icon === "tune" || icon === "settings" || label.includes("setting") || label.includes("cài đặt");
    });
    if (settingsTrigger) {
      await openFlowSettings();
      const ingredientsOption = flowOption("Ingredients") || flowOption("Thành phần");
      if (ingredientsOption) {
        ingredientsOption.click();
        await wait(300);
      }
      await closeFlowSettings();
      await wait(300);
      button = findAddMediaButton();
    }
  } catch {}
  return button;
}

function matchesFlowTile(tile, assetName) {
  if (!tile || !assetName) return false;
  const norm = s => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
  const full = norm(assetName);
  const stem = norm(assetName.replace(/\.(?:png|jpe?g|webp|gif|heic|heif|avif|mp4|m4v|mov|webm|avi|mkv|3gp)$/i, ""));

  const label = norm(tile.getAttribute("aria-label"));
  const title = norm(tile.getAttribute("title"));
  const dataName = norm(tile.getAttribute("data-tile-name"));
  const imgAlt = norm(tile.querySelector("img")?.getAttribute("alt"));
  const imgAria = norm(tile.querySelector("img")?.getAttribute("aria-label"));
  const text = norm(tile.innerText || tile.textContent);

  const candidates = [label, title, dataName, imgAlt, imgAria, text].filter(Boolean);
  return candidates.some(c => c === full || c === stem || c.includes(full) || (stem.length >= 3 && c.includes(stem)));
}

async function waitForNativeMediaTile(assetName, command, kind) {
  const deadline = Date.now() + (kind === "video" ? 60_000 : 90_000);
  let priorProgress = "";
  let retryCount = 0;
  const maxRetries = 3;
  while (Date.now() < deadline) {
    const tile = [...document.querySelectorAll("flow-grid-tile-container")]
      .find(item => matchesFlowTile(item, assetName));
    if (tile) {
      if (tile.querySelector("flow-error-tile")) {
        if (retryCount < maxRetries) {
          const retryBtn = [...tile.querySelectorAll('button,[role="button"]')].find(el => {
            if (!visible(el) || el.disabled || el.getAttribute("aria-disabled") === "true") return false;
            const label = accessibleName(el).replace(/\s+/g, " ").trim().toLowerCase();
            const icon = el.querySelector("mat-icon,.mat-icon,.google-symbols,.material-symbols-outlined,svg")?.textContent?.trim() || "";
            return /^(retry|try again|thử lại)$/i.test(label) || /refresh|replay|retry/i.test(icon);
          });
          if (retryBtn) {
            retryCount++;
            emitFlowProgress(command, `Flow upload tile reported an error; clicking retry (${retryCount}/${maxRetries})...`);
            retryBtn.click();
            await wait(2500);
            continue;
          }
        }
        throw flowError("FLOW_UPLOAD_REJECTED", `Flow rejected uploaded ${kind} "${assetName}".`, false, true);
      }
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
  // Stabilize viewport to keep composer controls visible
  const scroller = scrollContainer();
  if (scroller && scroller.scrollTop > 5) {
    scroller.scrollTop = 0;
    await wait(150);
  }

  // De-duplication check: reuse completed tile if already uploaded in project
  const existingTile = [...document.querySelectorAll("flow-grid-tile-container")].find(item => {
    return matchesFlowTile(item, file.name) && !item.querySelector("flow-error-tile");
  });
  if (existingTile) {
    const id = mediaId(existingTile);
    if (id && !id.startsWith("title:")) {
      return { uploaded: true, name: file.name, kind, reused: true };
    }
  }

  const uploadButton = await ensureAddMediaButton();
  const normalize = value => String(value || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
  const uploadNames = new Set(["upload", "upload media", "upload file", "tải lên", "tải tệp lên", "tải nội dung nghe nhìn lên"]);
  const menuRoots = () => [...document.querySelectorAll('[role="menu"],mat-menu-panel,[role="dialog"],.cdk-overlay-pane,[data-state="open"]')].filter(visible);
  const labelOf = el => {
    const labels = [accessibleName(el), el.getAttribute("aria-label"), el.getAttribute("title"), el.innerText, el.textContent];
    // Material icon ligatures are exposed as text in some Flow builds (for example,
    // "upload Upload"). Ignore decorative icon text when resolving the menu row.
    try {
      const clone = el.cloneNode(true);
      clone.querySelectorAll('mat-icon,.mat-icon,.google-symbols,svg,[aria-hidden="true"]').forEach(icon => icon.remove());
      labels.push(clone.innerText || clone.textContent);
    } catch {}
    return labels.map(normalize);
  };
  const isUploadLabel = el => {
    const icon = el.querySelector("mat-icon,.mat-icon,.google-symbols,.material-symbols-outlined,svg")?.textContent?.trim() || "";
    if (["upload", "file_upload", "upload_file", "cloud_upload"].includes(icon)) return true;
    return labelOf(el).some(label => uploadNames.has(label) || uploadNames.has(label.replace(/^(?:upload|upload_file|file_upload|arrow_upward)\s+/, "")));
  };

  const switchUploadCategoryTab = async roots => {
    for (const root of roots) {
      const tabs = [...root.querySelectorAll('[role="tab"],button')].filter(visible);
      for (const tab of tabs) {
        const icon = tab.querySelector("mat-icon,.mat-icon,.google-symbols,.material-symbols-outlined,svg")?.textContent?.trim() || "";
        const label = accessibleName(tab).replace(/\s+/g, " ").trim().toLowerCase();
        const isUploadTab = ["upload", "file_upload", "upload_file", "cloud_upload"].includes(icon) ||
          label === "upload" || label === "tải lên" || label.includes("upload") || label.includes("tải lên");
        if (isUploadTab) {
          const isSelected = tab.getAttribute("aria-selected") === "true" || tab.getAttribute("data-state") === "active";
          if (!isSelected) {
            clickFlowControl(tab);
            await wait(350);
          }
          return true;
        }
      }
    }
    return false;
  };

  const findUploadItem = () => {
    const activeMenus = menuRoots();
    // Like TobyFlow, resolve the Upload control relative to Flow's open menu first;
    // only scan the page if this Flow build does not expose an overlay/menu root.
    const roots = activeMenus.length ? [...activeMenus, document] : [document];
    for (const root of roots) {
      const semantic = [...root.querySelectorAll('button,[role="button"],[role="menuitem"],a,[tabindex]')]
        .filter(el => visible(el) && !el.matches('[role="tab"]') && !el.disabled && el.getAttribute("aria-disabled") !== "true" && isUploadLabel(el));
      if (semantic.length) return semantic[0];
    }
    // Some Flow builds render menu rows as clickable divs without ARIA roles.
    for (const root of roots) {
      const textLeaves = [...root.querySelectorAll("*")].filter(el => visible(el) && !el.matches('[role="tab"]') && isUploadLabel(el));
      for (const leaf of textLeaves) {
        let candidate = leaf;
        while (candidate && candidate !== root) {
          if (visible(candidate) && !candidate.matches('[role="tab"]') &&
              (candidate.getAttribute("tabindex") === "0" || getComputedStyle(candidate).cursor === "pointer")) return candidate;
          candidate = candidate.parentElement;
        }
        // Clicking the exact text leaf bubbles to Flow's delegated menu-row listener.
        if (leaf !== root) return leaf;
      }
    }
    return null;
  };
  const clickFlowControl = element => {
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    const point = { bubbles: true, cancelable: true, composed: true, button: 0, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
    element.dispatchEvent(new PointerEvent("pointerdown", { ...point, pointerId: 1, pointerType: "mouse" }));
    element.dispatchEvent(new MouseEvent("mousedown", point));
    element.dispatchEvent(new PointerEvent("pointerup", { ...point, pointerId: 1, pointerType: "mouse" }));
    element.dispatchEvent(new MouseEvent("mouseup", point));
    element.dispatchEvent(new MouseEvent("click", point));
    return true;
  };
  const acceptsMedia = input => {
    const accept = String(input.getAttribute("accept") || "").toLowerCase();
    return kind === "video"
      ? !accept || accept.includes("video") || accept.includes("*/*") || /mp4|mov|webm|avi|mkv|3gp/.test(accept)
      : !accept || accept.includes("image") || /png|jpe?g|webp|gif|heic|heif|avif/.test(accept);
  };
  let dispatched = false;
  const existingInput = [...document.querySelectorAll('input[type="file"]')].find(acceptsMedia);
  if (existingInput) {
    try {
      const result = await FlowNativeFileTransfer.assignFileToFlowInput(file, existingInput);
      dispatched = result.success === true;
    } catch { /* Fall back to the upload menu and file-picker trap. */ }
  }
  if (!dispatched) {
    if (!uploadButton) {
      console.warn(`[Flow MCP upload] Upload button unavailable; falling back to drag-and-drop for ${kind} "${file.name}".`);
      await FlowNativeFileTransfer.dropFileToFlow(file);
    } else {
      uploadButton.click();
      const menuDeadline = Date.now() + 2500;
      let uploadItem = null;
      while (Date.now() < menuDeadline && !uploadItem) {
        const activeMenus = menuRoots();
        if (activeMenus.length) await switchUploadCategoryTab(activeMenus);
        uploadItem = findUploadItem();
        if (!uploadItem) await wait(100);
      }
      if (!uploadItem) {
        console.warn(`[Flow MCP upload] Upload row missing in menu; falling back to drag-and-drop for ${kind} "${file.name}".`);
        await FlowNativeFileTransfer.dropFileToFlow(file);
      } else {
        try {
          await FlowNativeFileTransfer.selectFileThroughPicker(file, async () => {
            // Arming the MAIN-world picker trap is asynchronous. Flow can replace
            // its menu DOM during that round trip, so reacquire the live row just
            // before the click (TobyFlow performs this same detached-node check).
            if (!uploadItem?.isConnected || !visible(uploadItem)) {
              await switchUploadCategoryTab(menuRoots());
              uploadItem = findUploadItem();
            }
            if (!uploadItem?.isConnected || !visible(uploadItem)) return false;
            return clickFlowControl(uploadItem);
          });
        } catch (error) {
          console.warn(`[Flow MCP upload] File-picker trap failed (${String(error?.message || error)}); falling back to drag-and-drop for ${kind} "${file.name}".`);
          await FlowNativeFileTransfer.dropFileToFlow(file);
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
function descriptor(item) { return { id: item.id, title: item.title, kind: item.kind }; }
async function retryNativeErrorTile(item) {
  let tile = [...document.querySelectorAll("flow-grid-tile-container")].find(candidate =>
    item.id && !item.id.startsWith("title:") ? mediaId(candidate) === item.id : candidate.getAttribute("aria-label") === item.title);
  if (!tile) return false;
  tile.scrollIntoView({ block: "center" });
  const rect = tile.getBoundingClientRect();
  tile.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, pointerId: 1, pointerType: "mouse" }));
  tile.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
  await wait(250);
  const retry = [...tile.querySelectorAll("button,[role=button]")].find(el =>
    visible(el) && !el.disabled && el.getAttribute("aria-disabled") !== "true" && /^(retry|try again)$/i.test(accessibleName(el).replace(/\s+/g, " ").trim()));
  if (!retry) return false;
  retry.click();
  await wait(1500);
  if (scrollContainer()) scrollContainer().scrollTop = 0;
  return true;
}
async function waitForProgressResult(command, before, expected, kind, timeoutMs, selector = "flow-grid-tile-container", allowConfirmedPartial = false) {
  const until = Date.now() + timeoutMs;
  let hadProgress = false, last = "", lastTitleOnlyResult = "", retriesLeft = 1;
  while (Date.now() < until) {
    const fresh = collectNativeMedia().filter(item => !before.includes(item.id || `title:${item.title}`) && (!kind || item.kind === kind));
    const failed = fresh.filter(item => item.failed);
    if (failed.length) {
      if (retriesLeft > 0 && await retryNativeErrorTile(failed[0])) {
        retriesLeft--;
        emitFlowProgress(command, "Flow failed this render; retrying its failed tile");
        continue;
      }
      if (!allowConfirmedPartial || fresh.filter(item => !item.busy).length >= expected) {
        const ready = fresh.filter(item => !item.busy && !item.failed);
        const failure = failed[0];
        const error = flowError("FLOW_GENERATION_FAILED", `Flow failed while processing "${failure.title}"${failure.failureReason ? `: ${failure.failureReason}` : ""}. Nothing was charged for the failed render.`, false, false);
        if (allowConfirmedPartial && ready.length + failed.length >= expected) {
          error.partialMedia = ready.map(descriptor);
          error.failedMedia = failed.map(descriptor);
        }
        throw error;
      }
    }
    const ready = fresh.filter(item => !item.busy && !item.failed);
    if (ready.length >= expected) {
      const picked = ready.slice(0, expected);
      const titleOnly = picked.some(item => !item.id || item.id.startsWith("title:"));
      const signature = picked.map(item => item.id || `title:${item.title}`).join("|");
      if (!titleOnly || signature === lastTitleOnlyResult) return picked.map(descriptor);
      lastTitleOnlyResult = signature;
      emitFlowProgress(command, "Flow is finishing the video title");
      await wait(1500);
      continue;
    }
    const pct = [...document.querySelectorAll(selector)].slice(0, 10).map(el => (el.innerText || "").match(/\d+%/)?.[0]).filter(Boolean);
    if (pct.length) hadProgress = true;
    const text = pct.join(", ") || (hadProgress ? "Flow is finishing the result" : "Waiting for Flow");
    if (text !== last) { emitFlowProgress(command, text); last = text; }
    await wait(2500);
  }
  throw flowError("FLOW_OPERATION_TIMEOUT", "Timed out waiting for Flow. The operation may have completed; inspect Flow before retrying.", false, true);
}
async function waitForNativeEditorCompletion(command, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  let seenProgress = false;
  let previous = "";
  while (Date.now() < deadline) {
    const text = document.querySelector("main")?.innerText || document.body?.innerText || "";
    const progress = text.match(/\d{1,3}%/)?.[0];
    if (progress) {
      seenProgress = true;
      if (progress !== previous) emitFlowProgress(command, progress);
      previous = progress;
    } else if (seenProgress) {
      return true;
    }
    const failure = text.split("\n").map(line => line.trim()).find(line =>
      /(?:failed to generate|generation failed|could not generate|something went wrong|try again)/i.test(line));
    if (failure) throw flowError("FLOW_GENERATION_FAILED", `Flow reported a failed ${description}: ${failure.slice(0, 300)}`, false, true);
    await wait(2500);
  }
  throw flowError("FLOW_OPERATION_TIMEOUT", `Timed out waiting for Flow to finish the ${description}. Inspect Flow before retrying.`, false, true);
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
      hasUploadButton: Boolean(findAddMediaButton()),
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
    const source = String(params.edit_asset || "").trim();
    if (!source) throw flowError("FLOW_INVALID_ARGUMENT", "Video title is required.");
    await closeNativeAgentSession();
    const activeAgent = flowButton("Agent");
    if (activeAgent?.getAttribute("aria-pressed") === "true") await setNativeAgentMode(false);
    await ensureFlowLibrarySection("All media");
    const assets = await scanNativeAssets();
    const matches = assets.filter(asset => asset.kind === "video" && asset.name.toLowerCase().startsWith(source.toLowerCase()));
    if (matches.length > 1) throw flowError("FLOW_AMBIGUOUS_ASSET", `${matches.length} videos begin with "${source}"; no edit was started. Use the full title from flow_assets.`, true, false);
    const found = matches[0];
    if (!found) throw flowError("FLOW_VIDEO_NOT_FOUND", `No video beginning "${source}" exists in the project. Use flow_assets to list titles.`, true);
    if (scrollContainer()) scrollContainer().scrollTop = 0;
    const before = collectNativeMedia().map(item => item.id || `title:${item.title}`);
    const tile = await findFlowTile(found.name);
    if (!tile || !tile.querySelector("flow-video-tile")) throw flowError("FLOW_VIDEO_NOT_FOUND", `Video "${found.name}" is no longer visible in the project.`, true);
    tile.scrollIntoView({ block: "center" }); tile.click();
    await waitForFlowRoute(path => /\/edit\//i.test(path), 30_000, "Flow did not open the video editor.");
    const boxes = [...document.querySelectorAll(".ProseMirror")];
    if (!boxes.length) throw flowError("FLOW_COMPOSER_MISSING", "Flow's edit prompt is not visible.", true);
    const prompt = String(params.prompt || "").replace(/\s*\n+\s*/g, " ").trim();
    if (!replaceNativeEditableText(boxes[boxes.length - 1], prompt)) throw flowError("FLOW_PROMPT_INPUT_UNCONFIRMED", "Flow did not accept the video edit prompt. Nothing was submitted.", true);
    await wait(500);
    const start = await waitForGenerationSubmitButton(prompt, 8000);
    if (!start) throw flowError("FLOW_SUBMIT_DISABLED", "Flow's edit action is unavailable; nothing was submitted.", true);
    let submitted = false;
    try {
      await activateFlowSubmitButton(start, command, prompt);
      submitted = true;
      await waitForNativeEditorCompletion(command, Number(params.timeout_ms || 10 * 60_000), "video edit");
      const back = flowButton("Back button to go to previous page");
      if (!back) throw flowError("FLOW_EDIT_BACK_MISSING", "Flow finished the video edit, but its Back control is unavailable. The result remains in Flow.", true, true);
      back.click();
      await waitForFlowRoute(path => !/\/edit(?:\/|$)/i.test(path), 20_000, "Flow finished the edit but did not return to the project.");
      await ensureFlowLibrarySection("All media");
      if (scrollContainer()) scrollContainer().scrollTop = 0;
      const results = await waitForProgressResult(command, before, 1, "video", 90_000);
      return { media: results, trustedGesture: false };
    } catch (error) {
      if (submitted && error && typeof error === "object") error.outcome_unknown = true;
      throw error;
    }
  }
  if (name === "flow.agent.batch") {
    const params = payload.job?.params || payload.params || {};
    const scenes = params.agent_scenes || [];
    if (!scenes.length) throw flowError("FLOW_INVALID_ARGUMENT", "agent_scenes is required.");
    await closeNativeAgentSession();
    await ensureFlowLibrarySection("All media");
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
      const start = await waitForGenerationSubmitButton(script, 8000);
      if (!start) throw flowError("FLOW_SUBMIT_DISABLED", "Flow's Agent Start generation button is disabled or is not in the composer containing the prompt; nothing was submitted.", true);
      await activateFlowSubmitButton(start, command, script);
      submitted = true;
      let media;
      let partialFailure = false;
      let failedMedia = [];
      try {
        media = await waitForProgressResult(command, before, scenes.length, "image", Number(params.timeout_ms || 1800000), "main", true);
      } catch (error) {
        if (error?.code !== "FLOW_GENERATION_FAILED" || error?.outcome_unknown !== false
          || !Array.isArray(error.partialMedia) || !Array.isArray(error.failedMedia)) throw error;
        media = error.partialMedia;
        failedMedia = error.failedMedia;
        partialFailure = true;
      }
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
      return { media, prompts, ...(partialFailure ? { partial: true, failedMedia } : {}), trustedGesture: false };
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
    const sourcePrefix = String(params.continue_from || "").trim();
    if (!sourcePrefix) throw flowError("FLOW_INVALID_ARGUMENT", "Video title is required.");
    const likeness = params.continue_mode === "likeness";
    if (likeness && (!Array.isArray(params.attach) || !params.attach.length)) throw flowError("FLOW_INVALID_ARGUMENT", "Likeness continuation requires at least one character or avatar attachment.", true);
    await closeNativeAgentSession();
    const activeAgent = flowButton("Agent");
    if (activeAgent?.getAttribute("aria-pressed") === "true") await setNativeAgentMode(false);
    await ensureFlowLibrarySection("All media");
    const assets = await scanNativeAssets();
    const matches = assets.filter(asset => asset.kind === "video" && asset.name.toLowerCase().startsWith(sourcePrefix.toLowerCase()));
    if (matches.length > 1) throw flowError("FLOW_AMBIGUOUS_ASSET", `${matches.length} videos begin with "${sourcePrefix}"; no continuation was started. Use the full title from flow_assets.`, true, false);
    const source = matches[0];
    if (!source) throw flowError("FLOW_VIDEO_NOT_FOUND", `No video beginning "${sourcePrefix}" exists in the project. Use flow_assets to list titles.`, true);
    if (scrollContainer()) scrollContainer().scrollTop = 0;
    const before = collectNativeMedia().map(item => item.id || `title:${item.title}`);
    let submitted = false;
    try {
      const tile = await findFlowTile(source.name);
      if (!tile || !tile.querySelector("flow-video-tile")) throw flowError("FLOW_VIDEO_NOT_FOUND", `Video "${source.name}" is no longer visible in the project.`, true);
      tile.scrollIntoView({ block: "center" }); tile.click();
      await waitForFlowRoute(path => /\/edit\//i.test(path), 30_000, "Flow did not open the source video editor.");
      await waitForEnabledFlowButton("Skip to next clip", 30_000).then(button => {
        if (!button) throw flowError("FLOW_TIMELINE_MISSING", "The source video timeline is not ready.", true);
        button.click();
      });
      await wait(1800);
      const save = await waitForEnabledFlowButton("Save frame", 10_000);
      if (!save) throw flowError("FLOW_SAVE_FRAME_MISSING", "Flow did not show Save frame.", true);
      save.click(); await wait(2500);
      const back = flowButton("Back button to go to previous page");
      if (!back) throw flowError("FLOW_EDIT_BACK_MISSING", "Flow saved the frame, but its Back control is unavailable.", true, true);
      back.click();
      await waitForFlowRoute(path => !/\/edit(?:\/|$)/i.test(path), 20_000, "Flow did not return to the project after saving the last frame.");
      await ensureFlowLibrarySection("All media");
      if (scrollContainer()) scrollContainer().scrollTop = 0;

      const frameTitle = `Saved frame from ${source.name}`;
      const frame = await findFlowTile(frameTitle, 200);
      if (!frame) throw flowError("FLOW_FRAME_NOT_FOUND", `Flow did not add the saved frame "${frameTitle}".`, false, true);
      frame.scrollIntoView({ block: "center" });
      frame.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); await wait(250);
      const more = flowButton("More options", frame);
      if (!more) throw flowError("FLOW_TILE_MENU_MISSING", "Could not open the saved frame menu.", true);
      more.click(); await wait(350);
      const animate = [...document.querySelectorAll('[role="menuitem"]')].find(el => visible(el) && accessibleName(el).trim() === "Animate");
      if (!animate) throw flowError("FLOW_ANIMATE_MISSING", "Flow did not show Animate for the saved frame.", true);
      animate.click();
      await waitForEnabledFlowButton("Start generation", 15_000);
      const box = document.querySelector(".ProseMirror");
      if (!box) throw flowError("FLOW_COMPOSER_MISSING", "Flow's continuation composer is not visible.", true);

      // Animate enters Flow Agent mode, which can use the saved frame and a character
      // together. Keep the old flow's order: attach the cast before setting Agent policy.
      await setNativeAgentMode(true);
      if (likeness) {
        for (const reference of params.attach || []) {
          const value = String(reference || "").replace(/^asset:/i, "").trim();
          if (!value) throw flowError("FLOW_INVALID_ARGUMENT", "Likeness continuation contains an empty attachment; nothing was submitted.", true);
          await chooseNativePickerAsset(value, undefined);
        }
      }
      await setNativeAgentSettings("Never", params.aspect_ratio || "16:9");
      const cast = (params.attach || []).join(" and ");
      const exact = !likeness;
      const prompt = `${exact
        ? `Use I2V, Flow's first frame animation tool. The attached frame is the FIRST FRAME of this clip: begin exactly on it, with the same framing, lighting, colours, wardrobe and set, and continue from there with no cut, as an unbroken continuation of the shot it came from. Do not use any other reference.`
        : `Use R2V, reference-to-video, with the attached frame and ${cast || "the attached reference"} both as references, so the look and the person stay consistent through the clip. Open as close to the attached frame as you can.`} ${params.prompt || ""}`;
      const activeBox = document.querySelector(".ProseMirror");
      if (!activeBox || !replaceNativeEditableText(activeBox, prompt)) throw flowError("FLOW_PROMPT_INPUT_UNCONFIRMED", "Flow did not accept the continuation prompt. Nothing was submitted.", true);
      const start = await waitForGenerationSubmitButton(prompt, 10_000);
      if (!start) throw flowError("FLOW_SUBMIT_DISABLED", "Flow's continuation Start generation button is disabled.", true);
      await activateFlowSubmitButton(start, command, prompt);
      submitted = true;
      await resolveNativeAgentQuestion(command, exact
        ? "Use I2V, first frame animation. Start exactly on that frame and continue from it with no cut. Do not use the other reference."
        : "Use R2V, reference-to-video, using both attached references so the person stays consistent.");
      const media = await waitForProgressResult(command, before, 1, "video", Number(params.timeout_ms || 720000), "main");
      return { media, trustedGesture: false };
    } catch (error) {
      if (submitted) error.outcome_unknown = true;
      throw error;
    } finally {
      // Restore the plain project composer after both success and failure so the next
      // generation or character operation does not inherit a hidden Agent session.
      await resetNativeAgentWorkflow().catch(() => {});
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
  if (name === "flow.references.attach") {
    const references = payload.references;
    if (!Array.isArray(references) || !references.length || references.length > 3) throw flowError("FLOW_INVALID_ARGUMENT", "Provide one to three named references.");
    const attached = [];
    for (const reference of references) attached.push(await globalThis.FlowReferenceActions.attach(reference));
    return { attached, submitted: false };
  }
  if (name === "flow.generation.submit") {
    const state = nativeRead("flowState");
    if (!state.signedIn || !state.inProject) throw flowError("FLOW_NOT_READY", state.hint || "Open a signed-in Flow project first.", true);
    await closeNativeAgentSession();
    await ensureFlowLibrarySection("All media");
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
    const framesMode = payload.type === "video" && Boolean(firstFrame || lastFrame);
    if (firstFrame === null || lastFrame === null || (!framesMode && attachments.some(item => {
      if (typeof item === "string") return !item.trim();
      if (!item || typeof item !== "object") return true;
      if (typeof item.assetName === "string") return !item.assetName.trim();
      return !validStagedLocalImage(item, /(?:ref[1-3]|attach[1-3])/);
    }))) throw flowError("NATIVE_CAPABILITY_UNSUPPORTED", "Native generation accepts project asset names or staged local image attachments only; nothing was submitted.", true, false);
    const referenceAttachments = framesMode ? [] : attachments;
    if (scrollContainer()) scrollContainer().scrollTop = 0;
    const before = collectNativeMedia().map(item => item.id || `title:${item.title}`);
    const agent = flowButton("Agent");
    if (agent?.getAttribute("aria-pressed") === "true") {
      await setNativeAgentMode(false);
    }
    const clear = flowButton("Clear prompt"); if (clear) clear.click();
    const settingsCredits = payload.type === "image"
      ? await globalThis.FlowImageActions.prepare(payload, variants)
      : await globalThis.FlowVideoActions.prepare(payload, variants, framesMode);

    const uploadAndResolve = async (attachment, slot) => {
      if (!validStagedLocalImage(attachment, /(?:start|end|ref[1-3])/)) throw flowError("FLOW_UPLOAD_UNAVAILABLE", "Flow's staged image transfer is unavailable before file selection.", false, false);
      const file = stagedNativeFiles.get(attachment.transferId);
      if (!file) throw flowError("FLOW_TRANSFER_UNKNOWN", "The staged image is no longer available.", true);
      try {
          await uploadStagedFlowMedia(file, "image", command);
      } finally {
        // Uploading from Flow V2's Frames composer temporarily switches to Ingredients
        // when the + menu is hidden. Restore Frames before using Start/End pickers.
        if (framesMode && (slot === "start" || slot === "end")) await restoreNativeFramesMode();
      }
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
    if (expectedRefs > 0) {
      const isRefChip = el => {
        if (!visible(el)) return false;
        const name = (accessibleName(el) || el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
        return /(?:Ingredient|Thành phần)/i.test(name) || /Xóa thành phần|Remove ingredient/i.test(name);
      };
      let attachedCount = 0;
      const countDeadline = Date.now() + 2500;
      while (Date.now() < countDeadline) {
        attachedCount = [...document.querySelectorAll("button,[role=button],[role=listitem],mat-chip,[data-chip]")].filter(isRefChip).length;
        if (attachedCount >= expectedRefs) break;
        await wait(250);
      }
      if (attachedCount < expectedRefs) {
        const composerRoot = document.querySelector(".ProseMirror")?.closest(".flow-composer, [class*='composer'], form") || document.body;
        const chipsInComposer = [...composerRoot.querySelectorAll("img, button, [role=button]")].filter(el => {
          if (!visible(el)) return false;
          const label = (accessibleName(el) || el.getAttribute("alt") || el.getAttribute("title") || "").toLowerCase();
          return /(?:ingredient|thành phần)/i.test(label);
        });
        const finalCount = Math.max(attachedCount, chipsInComposer.length);
        if (finalCount < expectedRefs) {
          throw flowError("FLOW_REFERENCE_ATTACH_UNCONFIRMED", `Flow shows ${finalCount} of ${expectedRefs} reference attachment(s); no generation was submitted. Inspect Flow before retrying.`, false, true);
        }
      }
    }
    const activeBox = await preflightGenerationPrompt(payload, framesMode);
    const promptApplied = await insertNativeFlowPrompt(activeBox, payload.prompt);
    if (!promptApplied) throw flowError("FLOW_PROMPT_INPUT_UNCONFIRMED", "Flow's composer did not confirm the full prompt text. Nothing was submitted.", true, false);
    // Flow may not calculate/render its usage quote until settings, references and prompt are applied.
    // Read it at the last safe point, immediately before activating submit.
    const renderedCredits = await waitForGenerationCreditQuote(Number.isFinite(settingsCredits) ? 1500 : 8000);
    const credits = Number.isFinite(renderedCredits) ? renderedCredits : settingsCredits;
    if (!Number.isFinite(credits)) throw flowError("FLOW_CREDIT_QUOTE_UNAVAILABLE", "Flow did not show a numeric generation credit quote after settings, references, and prompt were prepared. Nothing was submitted.", true, false);
    if (payload.maxCredits !== undefined && credits > Number(payload.maxCredits)) throw flowError("FLOW_MAX_CREDITS_EXCEEDED", `Flow quotes ${credits} credits, above max_credits=${payload.maxCredits}. Nothing was submitted.`, false, false);
    const start = await waitForGenerationSubmitButton(payload.prompt, 10_000);
    if (!start) throw flowError("FLOW_SUBMIT_DISABLED", "Flow's Start generation button did not become ready within 10 seconds; nothing was submitted.", true);
    const errorsBeforeSubmit = new Set(currentFlowSubmitErrors());
    const activation = await activateFlowSubmitButton(start, command, payload.prompt);

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
      throw flowError("FLOW_SUBMIT_UNCONFIRMED", `Flow did not confirm the trusted submit within 30 seconds (click delivered: ${Boolean(activation.clickDelivered)}). No render wait or download was started.`, false, true);
    }
    return {
      submitted: true,
      before,
      type: payload.type === "image" ? "image" : "video",
      expectedCount: variants,
      credits,
      activation: activation.strategy || "dom-click",
      acceptanceObserved: acknowledged || Boolean(activation.controlAccepted),
    };
  }
  if (name === "flow.generation.observe") {
    const before = Array.isArray(payload.before) ? payload.before : [];
    const kind = payload.kind === "image" ? "image" : payload.kind === "video" ? "video" : undefined;
    const expected = Math.max(1, Math.min(20, Number(payload.expectedCount || 1)));
    const deadline = Date.now() + Math.max(1000, Math.min(15 * 60_000, Number(payload.timeoutMs || 12 * 60_000)));
    let priorProgress = "", lastTitleOnlyResult = "";
    let retriesLeft = Math.max(0, Math.min(3, Number(payload.retries ?? 1)));
    while (Date.now() < deadline) {
      const fresh = collectNativeMedia().filter(item => !before.includes(item.id || `title:${item.title}`) && !item.title.startsWith("fm-") && (!kind || item.kind === kind));
      const failed = fresh.filter(item => item.failed);
      if (failed.length) {
        const retryable = failed.find(item => item);
        if (retryable && retriesLeft > 0 && await retryNativeErrorTile(retryable)) {
          retriesLeft--;
          emitFlowProgress(command, `Flow failed this render; retrying (${Math.max(0, Number(payload.retries ?? 1) - retriesLeft)}/${Number(payload.retries ?? 1)})`);
          continue;
        }
        const details = failed.map(item => `${item.title}${item.failureReason ? `: ${item.failureReason}` : ""}`).join("; ");
        throw flowError("FLOW_GENERATION_FAILED", `Flow reported ${failed.length} failed generation tile(s): ${details}. Nothing was charged for the failed render.`, false, false);
      }
      const ready = fresh.filter(item => !item.busy);
      if (ready.length >= expected) {
        const picked = ready.slice(0, expected);
        const titleOnly = picked.some(item => !item.id || item.id.startsWith("title:"));
        const signature = picked.map(item => item.id || `title:${item.title}`).join("|");
        if (!titleOnly || signature === lastTitleOnlyResult) return { media: picked.map(({ id, title, kind: mediaKind }) => ({ id, title, kind: mediaKind })) };
        lastTitleOnlyResult = signature;
        emitFlowProgress(command, "Flow is finishing the video title");
        await wait(1500);
        continue;
      }
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
    typeof value.name === "string" && new RegExp(`^fm-[A-Za-z0-9_-]{1,32}-${suffixPattern.source}\\.(?:png|jpe?g|webp|gif|heic|heif|avif)$`, "i").test(value.name));
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
