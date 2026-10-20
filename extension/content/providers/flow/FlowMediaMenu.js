(function (root) {
  "use strict";

  function flowTileOptionsButton(tile) {
    return [...tile.querySelectorAll('button,[role="button"]')].find(el => {
      const label = (root.accessibleName?.(el) || "").replace(/\s+/g, " ").trim().toLowerCase();
      const icon = el.querySelector?.("mat-icon, .mat-icon, .google-symbols")?.textContent?.trim().toLowerCase();
      return !el.disabled && el.getAttribute("aria-disabled") !== "true" &&
        (label === "more options" || label.startsWith("more options ") ||
         label === "tùy chọn khác" || label.startsWith("tùy chọn khác") ||
         label === "tác vụ khác" || label === "thêm tùy chọn" ||
         icon === "more_vert" || icon === "more_horiz");
    });
  }

  function flowMenuLabel(el) {
    const label = el.querySelector(".label,.item-text");
    if (label) return (label.innerText || label.textContent || "").replace(/\s+/g, " ").trim();
    const clone = el.cloneNode(true);
    clone.querySelectorAll("mat-icon,.mat-icon,.google-symbols,svg,[aria-hidden='true']").forEach(icon => icon.remove());
    return (clone.innerText || clone.textContent || root.accessibleName?.(el) || "").replace(/\s+/g, " ").trim();
  }

  function flowMenuItems(container = document) {
    return [...container.querySelectorAll('[role="menuitem"],button')].filter(el => root.visible?.(el));
  }

  function flowDownloadChoice(items, quality, kind) {
    const wanted = kind === "video"
      ? quality === "upscaled" ? /1080p|upscaled|chất lượng cao|đã nâng cấp/i : /720p|original|gốc|chất lượng gốc/i
      : quality === "upscaled" ? /upscaled|2x|4x|2k|chất lượng cao|đã nâng cấp/i : /original|1k|gốc|chất lượng gốc/i;
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
        if (target && target !== parentMenu && root.visible?.(target)) return target;
      }
      const candidates = [...document.querySelectorAll('[role="menu"],mat-menu-panel')].filter(menu => menu !== parentMenu && root.visible?.(menu));
      return candidates.find(menu => flowDownloadChoice(flowMenuItems(menu), quality, kind)) || candidates.find(menu => !knownMenus.has(menu));
    };
    for (const event of ["pointerover", "pointerenter", "pointermove", "pointerdown", "pointerup"]) {
      trigger.dispatchEvent(new PointerEvent(event, { ...pointer, ...(event.endsWith("down") || event.endsWith("up") ? { button: 0 } : {}) }));
    }
    for (const event of ["mouseover", "mouseenter", "mousemove"]) trigger.dispatchEvent(new MouseEvent(event, mouse));
    trigger.focus();
    for (let attempt = 0; attempt < 6; attempt++) {
      await root.wait?.(150);
      const submenu = find();
      if (submenu) return submenu;
      if (attempt === 2) {
        trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      }
    }
    trigger.click();
    for (let attempt = 0; attempt < 6; attempt++) {
      await root.wait?.(150);
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
    const button = flowTileOptionsButton(tile);
    if (button) return button;
    const deadline = Date.now() + 1800;
    while (Date.now() < deadline) {
      const revealed = flowTileOptionsButton(tile);
      if (revealed) return revealed;
      await root.wait?.(100);
    }
    return null;
  }

  async function waitForFlowTileMedia(tile, title, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    let lastState = "media element missing";
    while (Date.now() < deadline) {
      if (!tile.isConnected) throw root.flowError("FLOW_ASSET_CHANGED", `The tile for "${title}" changed while preparing its download.`, true);
      const errorTile = tile.querySelector("flow-error-tile");
      const retryControl = [...tile.querySelectorAll('button,[role="button"]')].find(el => /^(retry|try again)$/i.test(flowMenuLabel(el) || (root.accessibleName?.(el) || "").replace(/\s+/g, " ").trim()));
      if (errorTile || retryControl) {
        const reason = (errorTile?.innerText || errorTile?.textContent || flowMenuLabel(retryControl) || "").replace(/\s+/g, " ").trim();
        throw root.flowError("FLOW_GENERATION_FAILED", `Flow marked "${title}" as failed${reason ? `: ${reason}` : ""}.`, false, true);
      }
      const media = [...tile.querySelectorAll("video,img")];
      for (const element of media) {
        const src = element.currentSrc || element.getAttribute("src") || "";
        const placeholder = !src || src.includes("media.html") || src.endsWith(".html") || src.startsWith("chrome-extension://");
        const validSource = !placeholder && (root.isFlowMediaSource?.(src) || element.getAttribute("src")?.startsWith("/fx/"));
        const ready = element instanceof HTMLVideoElement
          ? validSource
          : validSource && (element.complete && element.naturalWidth > 0 || root.mediaId?.(tile)?.startsWith("asb:"));
        lastState = `media found (valid source: ${validSource}, ready: ${ready})`;
        if (ready) return element;
      }
      await root.wait?.(200);
    }
    throw root.flowError("FLOW_MEDIA_NOT_READY", `Flow has not finished loading media for "${title}" (${lastState}).`, true);
  }

  function triggerFlowDownload(title, quality = "original", mediaHandle) {
    return (async () => {
      if (document.visibilityState === "hidden") {
        const activated = await chrome.runtime.sendMessage({ type: "flow-mcp:ensure-active-tab" });
        if (!activated?.ok) throw root.flowError("FLOW_TAB_ACTIVATION_FAILED", activated?.error || "Flow tab could not be activated for its download menu.", true);
        await root.wait?.(300);
      }
      let tile;
      if (mediaHandle) {
        const scroller = root.scrollContainer?.();
        if (scroller) scroller.scrollTop = 0;
        for (let step = 0; step < 180 && !tile; step++) {
          tile = [...document.querySelectorAll("flow-grid-tile-container")].find(candidate => root.mediaId?.(candidate) === mediaHandle);
          if (tile || !scroller) break;
          const top = scroller.scrollTop, max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
          if (top >= max - 2) break;
          scroller.scrollTop = Math.min(max, top + Math.max(200, scroller.clientHeight * 0.78));
          await root.wait?.(300);
        }
        if (!tile) throw root.flowError("FLOW_ASSET_NOT_FOUND", `Could not find media id "${mediaHandle}" in the project library; refusing to substitute another tile named "${title}".`, true);
      }
      if (!tile) tile = await root.findFlowTile?.(title);
      if (!tile) throw root.flowError("FLOW_ASSET_NOT_FOUND", `Could not find "${title}" in the project library.`, true);
      const scene = Boolean(tile.querySelector("flow-scene-tile"));
      const kind = tile.querySelector("flow-video-tile") ? "video" : "image";
      if (!scene) await waitForFlowTileMedia(tile, title);
      if (!tile.isConnected || mediaHandle && root.mediaId?.(tile) !== mediaHandle) {
        tile = mediaHandle
          ? [...document.querySelectorAll("flow-grid-tile-container")].find(candidate => root.mediaId?.(candidate) === mediaHandle)
          : await root.findFlowTile?.(title);
        if (!tile) throw root.flowError("FLOW_ASSET_CHANGED", `The selected Flow tile for "${title}" changed before its menu opened.`, true);
        tile.scrollIntoView({ behavior: "instant", block: "center" });
        if (!scene) await waitForFlowTileMedia(tile, title);
      }
      if (scene) {
        tile.click();
        await root.wait?.(1200);
        const download = root.flowButton?.("Download scene") || root.flowButton?.("Tải xuống cảnh") || root.flowButton?.("Tải cảnh");
        if (!download) throw root.flowError("FLOW_SCENE_DOWNLOAD_MISSING", "Scene view opened but Download scene is unavailable.", true);
        download.click();
      } else {
        const more = await revealFlowTileOptions(tile);
        let entries;
        if (more) {
          more.click();
          await root.wait?.(400);
          entries = flowMenuItems();
        } else {
          const media = tile.querySelector("img,video") || tile;
          const rect = media.getBoundingClientRect();
          media.dispatchEvent(new MouseEvent("contextmenu", {
            bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2, button: 2,
          }));
          const menuDeadline = Date.now() + 1800;
          do {
            entries = flowMenuItems();
            if (entries.some(el => /^(?:Download|Tải xuống)(?:\s+(?:image|video|hình ảnh|ảnh))?$/i.test(flowMenuLabel(el)))) break;
            await root.wait?.(100);
          } while (Date.now() < menuDeadline);
        }
        const download = entries.find(el => /^(?:Download|Tải xuống)(?:\s+(?:image|video|hình ảnh|ảnh))?$/i.test(flowMenuLabel(el)));
        if (download) {
          if (download.getAttribute("aria-haspopup") === "menu") {
            const parentMenu = download.closest('[role="menu"],mat-menu-panel') || download.parentElement;
            const submenu = await revealFlowSubmenu(download, parentMenu, quality, kind);
            if (!submenu) throw root.flowError("FLOW_DOWNLOAD_SUBMENU_MISSING", `Flow opened the media menu but did not reveal download choices for "${title}".`, true);
            const choice = flowDownloadChoice(flowMenuItems(submenu), quality, kind);
            if (!choice) {
              const available = flowMenuItems(submenu).map(flowMenuLabel).filter(Boolean).join(", ") || "none";
              throw root.flowError("FLOW_DOWNLOAD_QUALITY_MISSING", `Flow's download menu for "${title}" has no ${quality} option. Available: ${available}.`, true);
            }
            choice.click();
          } else {
            download.click();
          }
        } else throw root.flowError("FLOW_TILE_MENU_MISSING", `Could not open options for "${title}".`, true);
      }
      return { title, kind: scene ? "scene" : tile.querySelector("flow-video-tile") ? "video" : "image", downloadTriggered: true, trustedGesture: false };
    })();
  }

  function collectAssets() {
    return [...document.querySelectorAll("flow-grid-tile-container")].map(tile => {
      const kind = tile.querySelector("flow-scene-tile") ? "scene" : tile.querySelector("flow-video-tile") ? "video" : tile.querySelector("flow-image-tile") ? "image" : null;
      const name = (tile.getAttribute("aria-label") || "").trim();
      if (!kind || !name) return null;
      const id = root.mediaId?.(tile);
      return { ...(id && !id.startsWith("title:") ? { id } : {}), name, kind };
    }).filter(Boolean);
  }

  async function scanNativeAssets() {
    const originalContainer = root.scrollContainer?.();
    const originalTop = originalContainer?.scrollTop ?? 0;
    const byName = new Map();
    try {
      if (!document.querySelector("flow-grid-tile-container")) {
        await root.ensureFlowLibrarySection?.("All media");
      }
      if (!document.querySelector("flow-grid-tile-container")) {
        throw new Error("Flow's All media grid is not visible. Open the project and try again.");
      }
      const container = root.scrollContainer?.();
      if (!container) return collectAssets();
      container.scrollTop = 0;
      await root.wait?.(350);
      let unchanged = 0;
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
        await root.wait?.(500);
        if (container.scrollTop <= before) {
          unchanged++;
          if (unchanged >= 3) break;
        } else unchanged = 0;
      }
      for (const asset of collectAssets()) {
        const known = byName.get(asset.name);
        if (!known) byName.set(asset.name, asset);
        else if (!known.id && asset.id) known.id = asset.id;
      }
      return [...byName.values()];
    } finally {
      const current = root.scrollContainer?.();
      if (current && originalContainer === current) current.scrollTop = originalTop;
    }
  }

  async function scanNativeCharacters() {
    await root.ensureFlowLibrarySection?.("Characters");
    const names = new Set();
    const container = root.scrollContainer?.();
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
        await root.wait?.(400);
        if (container.scrollTop <= before) break;
      }
      for (const tile of document.querySelectorAll("flow-character-tile")) {
        const name = cleanCharacterName(tile.innerText || tile.textContent || "");
        if (name && name !== "Me") names.add(name);
      }
      return [...names];
    } finally {
      if (container) container.scrollTop = originalTop;
      if (/\/character\/?$/i.test(location.pathname)) {
        const back = root.flowButton?.("Go back");
        if (back) {
          back.click();
          await root.waitForFlowRoute?.(path => !/\/character\/?$/i.test(path), 5000, "Flow did not leave the empty character chooser.").catch(() => {});
        }
      }
      if (root.clickFlowNavigation?.("All media")) await root.wait?.(500);
    }
  }

  function cleanCharacterName(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\b(accessibility_new|person|movie|image|videocam|mic)\b/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function nativeRead(name) {
    if (name === "flowState") {
      const url = location.href;
      const desc = root.ProviderRegistry?.describeUrl?.(url) || root.FlowDriverRegistry?.describeUrl?.(url) || null;
      const signedIn = !/\/about|accounts\.google\.com/.test(url);
      const inProject = Boolean(desc?.projectId);
      const isProjectEditor = Boolean(desc?.isProjectEditor);
      const state = { url, signedIn, inProject, isProjectEditor, projectId: desc?.projectId || null };
      if (!signedIn) state.hint = "Not signed in. Sign in to Google in the Flow Chrome tab.";
      else if (!inProject) state.hint = "Signed in, but no project is open. Open or create a Flow project.";
      else if (!isProjectEditor) state.hint = "Flow is not in project editor view. Recovering to project root...";
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
    const cardsDeadline = Date.now() + 15000;
    while (!projectLinks().length && Date.now() < cardsDeadline) {
      if (location.href !== homeUrl) throw root.flowError("FLOW_EXECUTION_TARGET_CHANGED", "Flow navigated while project cards were loading.", true);
      await root.wait?.(250);
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
      if (location.href !== homeUrl) throw root.flowError("FLOW_EXECUTION_TARGET_CHANGED", "Flow navigated while project cards were loading.", true);
      const before = top();
      scrollTo(max() + 1000);
      await root.wait?.(400);
      const count = projectLinks().length;
      const moved = top() > before + 2;
      if (count <= lastCount && !moved) { if (++stable >= 2) break; } else stable = 0;
      lastCount = count;
    }
    scrollTo(originalTop);
    await root.wait?.(120);
    const seen = new Set();
    const projects = [];
    for (const link of projectLinks()) {
      const url = new URL(link.href);
      const match = url.pathname.match(/\/project\/([0-9a-f-]{36})(?:\/|$)/i);
      const id = match?.[1];
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const name = (link.innerText || link.textContent || root.accessibleName?.(link) || "").replace(/\s+/g, " ").trim();
      projects.push({ id, name });
    }
    return projects;
  }

  const FlowMediaMenu = Object.freeze({
    triggerFlowDownload,
    scanNativeAssets,
    scanNativeProjects,
    scanNativeCharacters,
    collectAssets,
    nativeRead,
  });

  root.FlowMediaMenu = FlowMediaMenu;
  root.triggerFlowDownload = triggerFlowDownload;
  root.scanNativeAssets = scanNativeAssets;
  root.scanNativeProjects = scanNativeProjects;
  root.scanNativeCharacters = scanNativeCharacters;
  root.nativeRead = nativeRead;
  root.collectAssets = collectAssets;
})(globalThis);
