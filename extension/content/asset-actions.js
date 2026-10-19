function collectAssets() {
  return [...document.querySelectorAll("flow-grid-tile-container")].map(tile => {
    const kind = tile.querySelector("flow-scene-tile") ? "scene" : tile.querySelector("flow-video-tile") ? "video" : tile.querySelector("flow-image-tile") ? "image" : null;
    const name = (tile.getAttribute("aria-label") || "").trim();
    if (!kind || !name) return null;
    const id = mediaId(tile);
    return { ...(id && !id.startsWith("title:") ? { id } : {}), name, kind };
  }).filter(Boolean);
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

function collectNativeMedia() {
  return [...document.querySelectorAll("flow-grid-tile-container")].map(tile => {
    const kind = tile.querySelector("flow-video-tile") ? "video" : tile.querySelector("flow-image-tile") ? "image" : tile.querySelector("flow-scene-tile") ? "scene" : null;
    const title = (tile.getAttribute("aria-label") || "").trim();
    const id = mediaId(tile);
    const image = tile.querySelector("flow-image-tile img, img[src]");
    const imageLoaded = Boolean(image?.complete && image.naturalWidth > 0 && (image.currentSrc || image.getAttribute("src")));
    const videoLoaded = Boolean(tile.querySelector('img[alt="Generated video thumbnail"], video'));
    const failedTile = tile.querySelector("flow-error-tile");
    const retryControl = [...tile.querySelectorAll('button,[role="button"]')].find(el => {
      if (!visible(el) || el.disabled || el.getAttribute("aria-disabled") === "true") return false;
      const label = accessibleName(el).replace(/\s+/g, " ").trim().toLowerCase();
      const icon = el.querySelector("mat-icon,.mat-icon,.google-symbols,.material-symbols-outlined,svg")?.textContent?.trim() || "";
      return /^(retry|try again|thử lại)$/i.test(label) || /refresh|replay|retry/i.test(icon);
    });
    const failed = Boolean(failedTile || retryControl);
    const busy = /\d+%/.test(tile.innerText || "") || (kind === "image" && !failed && !imageLoaded) || (kind === "video" && !failed && !videoLoaded);
    const failureReason = failedTile ? (failedTile.innerText || failedTile.textContent || "").replace(/\s+/g, " ").trim() : "";
    return kind && title ? { id, title, kind, busy, failed, failureReason } : null;
  }).filter(Boolean);
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
