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
    ? quality === "upscaled" ? /1080p|upscaled|chất lượng cao/i : /720p|original|gốc/i
    : quality === "upscaled" ? /upscaled|2x|4x|2k|chất lượng cao/i : /original|1k|gốc/i;
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
          if (entries.some(el => /^(?:Download|Tải xuống)(?:\s+(?:image|video|hình ảnh))?$/i.test(flowMenuLabel(el)))) break;
          await wait(100);
        } while (Date.now() < menuDeadline);
      }
      const download = entries.find(el => /^(?:Download|Tải xuống)(?:\s+(?:image|video|hình ảnh))?$/i.test(flowMenuLabel(el)));
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
