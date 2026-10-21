(function (root) {
  "use strict";

  function flowTileOptionsButton(tile) {
    const candidates = (typeof root.flowQueryAll === "function" ? root.flowQueryAll("mediaMenu.triggerButton", tile, { checkVisible: false }) : null) ||
      [...tile.querySelectorAll('button,[role="button"]')];
    return candidates.find(el => {
      const label = (root.accessibleName?.(el) || "").replace(/\s+/g, " ").trim().toLowerCase();
      const icon = (root.flowFindIcon ? root.flowFindIcon(el) : el.querySelector?.("mat-icon, .mat-icon, .google-symbols"))?.textContent?.trim().toLowerCase();
      return !el.disabled && el.getAttribute("aria-disabled") !== "true" &&
        (label === "more options" || label.startsWith("more options ") ||
         label === "tùy chọn khác" || label.startsWith("tùy chọn khác") ||
         label === "tác vụ khác" || label === "thêm tùy chọn" ||
         icon === "more_vert" || icon === "more_horiz");
    });
  }

  function flowMenuLabel(el) {
    const label = (typeof root.flowQuery === "function" ? root.flowQuery("mediaMenu.menuItemLabel", el, { checkVisible: false }) : null) ||
      el.querySelector(".label,.item-text");
    if (label) return (label.innerText || label.textContent || "").replace(/\s+/g, " ").trim();
    const clone = el.cloneNode(true);
    const removeIcons = root.FlowSelectors?.mediaMenu?.removeIcons?.selectors?.join(",") || root.FlowSelectors?.common?.icons?.selectors?.join(",") || "mat-icon,.mat-icon,.google-symbols,svg,[aria-hidden='true']";
    clone.querySelectorAll(removeIcons).forEach(icon => icon.remove());
    return (clone.innerText || clone.textContent || root.accessibleName?.(el) || "").replace(/\s+/g, " ").trim();
  }

  function flowMenuItems(container = document) {
    const items = (typeof root.flowQueryAll === "function" ? root.flowQueryAll("mediaMenu.menuItems", container) : null) ||
      [...container.querySelectorAll('[role="menuitem"],button')];
    return items.filter(el => root.visible?.(el));
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
    const knownMenus = new Set((typeof root.flowQueryAll === "function" ? root.flowQueryAll("mediaMenu.menuPanel", document, { checkVisible: false }) : null) || document.querySelectorAll('[role="menu"],mat-menu-panel'));
    const find = () => {
      for (const id of [trigger.getAttribute("aria-controls"), trigger.getAttribute("aria-owns")].filter(Boolean)) {
        const target = document.getElementById(id);
        if (target && target !== parentMenu && root.visible?.(target)) return target;
      }
      const menuCandidates = (typeof root.flowQueryAll === "function" ? root.flowQueryAll("mediaMenu.menuPanel", document, { checkVisible: false }) : null) ||
        [...document.querySelectorAll('[role="menu"],mat-menu-panel')];
      const candidates = menuCandidates.filter(menu => menu !== parentMenu && root.visible?.(menu));
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

  async function waitForFlowTileMedia(tile, title, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    let lastState = "media element missing";
    while (Date.now() < deadline) {
      if (!tile.isConnected) throw root.flowError("FLOW_ASSET_CHANGED", `The tile for "${title}" changed while preparing its download.`, true);
      const errorTile = (typeof root.flowQuery === "function" ? root.flowQuery("tiles.error", tile, { checkVisible: false }) : null) ||
        tile.querySelector("flow-error-tile");
      const retryControl = (typeof root.flowFindSemantic === "function" ? root.flowFindSemantic("tiles.retryButton", tile, { checkVisible: false }) : null) ||
        [...tile.querySelectorAll('button,[role="button"]')].find(el =>
          /^(?:retry|try again|thử lại)(?:\s+.*)?$/i.test(flowMenuLabel(el) || (root.accessibleName?.(el) || "").replace(/\s+/g, " ").trim()) ||
          /^(?:refresh|replay|retry)$/i.test((root.flowFindIcon ? root.flowFindIcon(el) : el.querySelector?.("mat-icon, .mat-icon, .google-symbols"))?.textContent?.trim() || ""));
      if (errorTile || retryControl) {
        const reason = (errorTile?.innerText || errorTile?.textContent || flowMenuLabel(retryControl) || "").replace(/\s+/g, " ").trim();
        throw root.flowError("FLOW_GENERATION_FAILED", `Flow marked "${title}" as failed${reason ? `: ${reason}` : ""}.`, false, true);
      }

      const isBusy = Boolean(root.isTileBusy?.(tile) ?? ((typeof root.flowQuery === "function" ? root.flowQuery("tiles.progressBar", tile, { checkVisible: false }) : null) || tile.querySelector('flow-progress-tile,mat-progress-bar,[role="progressbar"]')));
      const optionsBtn = flowTileOptionsButton(tile);

      // Search for media elements in light DOM and shadow roots
      const media = [
        ...((typeof root.flowQueryAll === "function" ? root.flowQueryAll("tiles.mediaElements", tile, { checkVisible: false }) : null) || tile.querySelectorAll("video,img,canvas,[role='img'],flow-video-tile,flow-image-tile")),
        ...(tile.shadowRoot ? [...tile.shadowRoot.querySelectorAll("video,img,canvas")] : []),
        ...([...tile.querySelectorAll("*")].flatMap(el => el.shadowRoot ? [...el.shadowRoot.querySelectorAll("video,img,canvas")] : []))
      ];

      for (const element of media) {
        if (element instanceof HTMLVideoElement) {
          const src = element.currentSrc || element.getAttribute("src") || "";
          const placeholder = !src || src.includes("media.html") || src.endsWith(".html") || src.startsWith("chrome-extension://");
          const validSource = !placeholder && (root.isFlowMediaSource?.(src) || element.getAttribute("src")?.startsWith("/fx/") || src.startsWith("blob:"));
          lastState = `video found (src: ${src ? 'yes' : 'no'}, valid: ${validSource})`;
          if (validSource || (!isBusy && (src || element.readyState >= 1))) return element;
        } else if (element instanceof HTMLImageElement) {
          const src = element.currentSrc || element.getAttribute("src") || "";
          const placeholder = !src || src.includes("media.html") || src.endsWith(".html") || src.startsWith("chrome-extension://");
          const validSource = !placeholder && (root.isFlowMediaSource?.(src) || element.getAttribute("src")?.startsWith("/fx/") || src.startsWith("blob:") || src.startsWith("data:"));
          const ready = validSource && (element.complete && element.naturalWidth > 0 || root.mediaId?.(tile)?.startsWith("asb:"));
          lastState = `image found (valid source: ${validSource}, ready: ${ready})`;
          if (ready) return element;
        } else if (!isBusy && optionsBtn) {
          lastState = `custom media element (${element.tagName.toLowerCase()}) ready with options menu`;
          return element;
        }
      }

      // If no explicit img/video is matched, but the tile is rendered (not busy) and has options button
      if (!isBusy && optionsBtn) {
        lastState = "tile options ready";
        return tile;
      }

      await root.wait?.(200);
    }

    // Graceful fallback: If tile is connected and finished rendering (not failed, not busy), allow download
    const finalError = (typeof root.flowQuery === "function" ? root.flowQuery("tiles.error", tile, { checkVisible: false }) : null) ||
      tile.querySelector("flow-error-tile");
    const finalBusy = Boolean(root.isTileBusy?.(tile) ?? ((typeof root.flowQuery === "function" ? root.flowQuery("tiles.progressBar", tile, { checkVisible: false }) : null) || tile.querySelector('flow-progress-tile,mat-progress-bar,[role="progressbar"]')));
    if (tile.isConnected && !finalError && !finalBusy) {
      return tile;
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
      const scene = Boolean(typeof root.flowQuery === "function" ? root.flowQuery("tiles.scene", tile, { checkVisible: false }) : tile.querySelector("flow-scene-tile"));
      const kind = (typeof root.flowQuery === "function" ? root.flowQuery("tiles.video", tile, { checkVisible: false }) : tile.querySelector("flow-video-tile")) ? "video" : "image";
      if (!scene) await waitForFlowTileMedia(tile, title);
      if (!tile.isConnected || mediaHandle && root.mediaId?.(tile) !== mediaHandle) {
        tile = mediaHandle
          ? ((typeof root.flowQueryAll === "function" ? root.flowQueryAll("tiles.container", document, { checkVisible: false }) : null) ||
            [...document.querySelectorAll("flow-grid-tile-container")]).find(candidate => root.mediaId?.(candidate) === mediaHandle)
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
        const isDownloadItem = el => {
          const lbl = flowMenuLabel(el);
          const icon = (root.flowFindIcon ? root.flowFindIcon(el) : el.querySelector?.("mat-icon, .mat-icon, .google-symbols"))?.textContent?.trim().toLowerCase();
          return /^(?:Download|Tải xuống|Tải)(?:\s+(?:image|video|hình ảnh|ảnh|tệp|original|gốc))?$/i.test(lbl) ||
            icon === "download" || icon === "file_download";
        };

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
            if (entries.some(isDownloadItem)) break;
            await root.wait?.(100);
          } while (Date.now() < menuDeadline);
        }
        const download = entries.find(isDownloadItem);
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

  function collectAssets(options = {}) {
    const includeIncomplete = options.includeIncomplete === true;
    const tileContainers = (typeof root.flowQueryAll === "function" ? root.flowQueryAll("tiles.container", document, { checkVisible: false }) : null) ||
      [...document.querySelectorAll("flow-grid-tile-container")];
    return tileContainers.map(tile => {
      const scene = Boolean(typeof root.flowQuery === "function" ? root.flowQuery("tiles.scene", tile, { checkVisible: false }) : tile.querySelector("flow-scene-tile"));
      const video = (typeof root.flowQuery === "function" ? root.flowQuery("tiles.video", tile, { checkVisible: false }) : tile.querySelector("flow-video-tile"));
      const image = (typeof root.flowQuery === "function" ? root.flowQuery("tiles.image", tile, { checkVisible: false }) : tile.querySelector("flow-image-tile"));
      const kind = scene ? "scene" : video ? "video" : image ? "image" : null;
      const name = (tile.getAttribute("aria-label") || tile.getAttribute("title") || tile.getAttribute("data-tile-name") ||
        tile.querySelector("img")?.getAttribute("alt") || tile.querySelector("img")?.getAttribute("aria-label") || "").trim();
      const imageElement = tile.querySelector("img");
      let thumbnailUrl = imageElement?.currentSrc || imageElement?.getAttribute("src") || "";
      try {
        const parsedThumbnail = new URL(thumbnailUrl, location.href);
        thumbnailUrl = parsedThumbnail.protocol === "https:" ? parsedThumbnail.href : "";
      } catch { thumbnailUrl = ""; }
      const rawId = root.mediaId?.(tile);
      const id = rawId && !rawId.startsWith("title:") ? rawId : undefined;
      if ((!kind || !name) && (!includeIncomplete || !id)) return null;
      const busy = Boolean(root.FlowTiles?.isTileBusy?.(tile) ?? root.isTileBusy?.(tile));
      const ready = Boolean(root.FlowTiles?.isTileMediaReady?.(tile) ?? (!busy && root.isTileMediaReady?.(tile)));
      const hasError = Boolean(typeof root.flowQuery === "function" ? root.flowQuery("tiles.error", tile, { checkVisible: false }) : tile.querySelector("flow-error-tile"));
      return { ...(id ? { id } : {}), name, kind, ...(thumbnailUrl ? { thumbnailUrl } : {}), busy, ...(includeIncomplete ? { ready, error: hasError } : {}) };
    }).filter(Boolean);
  }

  async function scanNativeAssets(options = {}) {
    const maxDurationMs = Math.max(1000, Math.min(25_000, Number(options.maxDurationMs) || 25_000));
    const deadline = Math.min(Number(options.deadline) || Infinity, Date.now() + maxDurationMs);
    const controller = new AbortController();
    const remainingMs = Math.max(0, deadline - Date.now());
    const timeout = setTimeout(() => controller.abort(), remainingMs);
    const externalSignal = options.signal;
    const onExternalAbort = () => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) onExternalAbort();
    else externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
    const signal = controller.signal;
    const checkActive = () => {
      if (signal.aborted || Date.now() >= deadline) {
        controller.abort();
        throw root.flowError?.("FLOW_ASSET_SCAN_TIMEOUT", "Flow media library scan reached its time limit and was cancelled. No further assets were scanned.", true, false) || new Error("Flow media library scan timed out.");
      }
    };
    const boundedWait = async ms => {
      checkActive();
      await root.wait?.(Math.min(ms, Math.max(1, deadline - Date.now())));
      checkActive();
    };
    const matchesTarget = asset => {
      if (!options.exactName) return false;
      const normalize = value => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
      const full = normalize(options.exactName);
      const stem = normalize(String(options.exactName).replace(/\.(?:png|jpe?g|webp|gif|heic|heif|avif|mp4|m4v|mov|webm|avi|mkv|3gp)$/i, ""));
      const name = normalize(asset?.name).replace(/\s+(?:image|video|character|avatar|ảnh|nhân vật)$/i, "").trim();
      const kindMatches = !options.kind || (!asset?.kind && options.includeIncomplete) || (options.kind === "video" ? asset?.kind === "video" || asset?.kind === "scene" : asset?.kind === options.kind);
      return kindMatches && (name === full || name === stem);
    };
    const originalContainer = root.scrollContainer?.();
    const originalTop = originalContainer?.scrollTop ?? 0;
    const byIdentity = new Map();
    let targetFound = false;
    let targetScrollTop = null;
    let scanSteps = 0;
    const hasBaselineIds = Array.isArray(options.baselineIds);
    const baselineIds = new Set((options.baselineIds || []).map(String));
    const ownerKindMatches = asset => !options.ownerKind || !asset.kind ||
      (options.ownerKind === "video" ? asset.kind === "video" || asset.kind === "scene" : asset.kind === options.ownerKind);
    const rememberVisible = () => {
      const currentTop = root.scrollContainer?.()?.scrollTop ?? 0;
      for (const asset of collectAssets({ includeIncomplete: options.includeIncomplete })) {
        const key = asset.id ? `id:${asset.id}` : `name:${asset.kind}:${asset.name.toLowerCase()}`;
        const prior = byIdentity.get(key);
        byIdentity.set(key, {
          ...prior,
          ...asset,
          name: asset.name || prior?.name || "",
          kind: asset.kind || prior?.kind,
          busy: asset.busy ?? prior?.busy ?? true,
          ready: asset.ready ?? prior?.ready ?? false,
          _scrollTop: prior?._scrollTop ?? currentTop,
        });
      }
      const matches = [...byIdentity.values()].filter(matchesTarget);
      if (matches.length > 1) throw root.flowError?.("FLOW_ASSET_AMBIGUOUS", `More than one Flow library tile exactly matches "${options.exactName}".`, false, true) || new Error("Ambiguous Flow asset title.");
      if (matches.length === 1) { targetFound = true; targetScrollTop = matches[0]._scrollTop; }
      return matches;
    };
    try {
      checkActive();
      const hasGrid = (typeof root.flowQuery === "function" && root.flowQuery("tiles.container", document, { checkVisible: false })) ||
        document.querySelector("flow-grid-tile-container");
      if (!hasGrid) {
        const navigation = root.ensureFlowLibrarySection?.("All media", { deadline, signal });
        if (navigation) {
          await Promise.race([
            navigation,
            new Promise((_, reject) => signal.addEventListener("abort", () => reject(root.flowError?.("FLOW_ASSET_SCAN_TIMEOUT", "Flow media library scan reached its time limit and was cancelled.", true, false) || new Error("Flow media library scan timed out.")), { once: true })),
          ]);
        }
      }
      checkActive();
      const gridAfter = (typeof root.flowQuery === "function" && root.flowQuery("tiles.container", document, { checkVisible: false })) ||
        document.querySelector("flow-grid-tile-container");
      if (!gridAfter) {
        throw new Error("Flow's All media grid is not visible. Open the project and try again.");
      }
      const container = root.scrollContainer?.();
      if (!container) {
        if (options.requireComplete) {
          throw root.flowError?.("FLOW_ASSET_SCAN_INCOMPLETE", "Flow's media library has no scroll container, so a complete upload baseline cannot be proven; no upload was started.", true, false) || new Error("Flow media library scan was incomplete.");
        }
        const matches = rememberVisible();
        if (options.exactName && matches.length !== 1) {
          options.onDiagnostics?.({ steps: scanSteps, uniqueTiles: byIdentity.size, reachedEnd: false, exactMatchCount: matches.length });
          throw root.flowError?.("FLOW_ASSET_NOT_FOUND", `No exact Flow asset titled "${options.exactName}" was found.`, true, true) || new Error("Flow asset was not found.");
        }
        const output = [...byIdentity.values()];
        const owners = output.filter(asset => asset.id && hasBaselineIds && !baselineIds.has(String(asset.id)) && ownerKindMatches(asset));
        if (owners.length > 1) throw root.flowError?.("FLOW_UPLOAD_TILE_AMBIGUOUS", "More than one new Flow media tile appeared during upload confirmation.", false, true) || new Error("Ambiguous new Flow media tiles.");
        if (owners.length === 1 && owners[0].kind && owners[0].ready) { targetFound = true; targetScrollTop = owners[0]._scrollTop; }
        const result = output.map(({ busy, ready, error, _scrollTop, ...asset }) => ({
          ...asset,
          ...(options.exactName || options.includeIncomplete ? { busy } : {}),
          ...(options.includeIncomplete ? { ready, error } : {}),
          ...(hasBaselineIds && asset.id ? { newSinceBaseline: !baselineIds.has(String(asset.id)) } : {}),
        }));
        options.onDiagnostics?.({ steps: scanSteps, uniqueTiles: output.length, reachedEnd: false });
        return result;
      }
      container.scrollTop = 0;
      await boundedWait(350);
      let unchanged = 0;
      let reachedEnd = false;
      for (let step = 0; step < 80; step++) {
        scanSteps++;
        checkActive();
        const matches = rememberVisible();
        if (options.exactName && matches.length === 1) break;
        const before = container.scrollTop;
        const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
        if (before >= maxTop - 2) { reachedEnd = true; break; }
        container.scrollTop = Math.min(maxTop, before + Math.max(200, container.clientHeight * 0.78));
        await boundedWait(300);
        if (container.scrollTop <= before) {
          unchanged++;
          if (unchanged >= 3) { reachedEnd = container.scrollTop >= maxTop - 2; break; }
        } else unchanged = 0;
      }
      const matches = rememberVisible();
      if (options.exactName && matches.length !== 1) {
        options.onDiagnostics?.({ steps: scanSteps, uniqueTiles: byIdentity.size, reachedEnd, exactMatchCount: matches.length });
        throw root.flowError?.("FLOW_ASSET_NOT_FOUND", `No exact Flow asset titled "${options.exactName}" was found before the scan deadline.`, true, true) || new Error("Flow asset was not found.");
      }
      if (options.requireComplete && !reachedEnd && !options.exactName) {
        throw root.flowError?.("FLOW_ASSET_SCAN_INCOMPLETE", "Flow's media library could not be fully scanned before the upload baseline deadline; no upload was started.", true, false) || new Error("Flow media library scan was incomplete.");
      }
      const output = [...byIdentity.values()];
      const owners = output.filter(asset => asset.id && hasBaselineIds && !baselineIds.has(String(asset.id)) && ownerKindMatches(asset));
      if (owners.length > 1) throw root.flowError?.("FLOW_UPLOAD_TILE_AMBIGUOUS", "More than one new Flow media tile appeared during upload confirmation.", false, true) || new Error("Ambiguous new Flow media tiles.");
      if (owners.length === 1 && owners[0].kind && owners[0].ready) { targetFound = true; targetScrollTop = owners[0]._scrollTop; }
      const result = output.map(({ busy, ready, error, _scrollTop, ...asset }) => ({
        ...asset,
        ...(options.exactName || options.includeIncomplete ? { busy } : {}),
        ...(options.includeIncomplete ? { ready, error } : {}),
        ...(hasBaselineIds && asset.id ? { newSinceBaseline: !baselineIds.has(String(asset.id)) } : {}),
      }));
      options.onDiagnostics?.({ steps: scanSteps, uniqueTiles: output.length, reachedEnd });
      return result;
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", onExternalAbort);
      const current = root.scrollContainer?.();
      if (current && originalContainer === current) {
        if (options.keepPositionOnMatch && targetFound && Number.isFinite(targetScrollTop)) current.scrollTop = targetScrollTop;
        else if (!(options.keepPositionOnMatch && targetFound)) current.scrollTop = originalTop;
      }
    }
  }

  let lastCharacterScanDiagnostics = null;

  function characterLibrarySnapshot(container = root.scrollContainer?.()) {
    const pathname = location.pathname || "";
    const project = (root.ProviderRegistry || root.FlowDriverRegistry)?.describeUrl?.(location.href) || null;
    const tiles = (typeof root.flowQueryAll === "function" ? root.flowQueryAll("components.characterTile", document, { checkVisible: false }) : null) ||
      [...document.querySelectorAll("flow-character-tile")];
    const visibleTiles = tiles.filter(tile => root.visible?.(tile) !== false);
    const loadingCount = [...document.querySelectorAll('[role="progressbar"],[aria-busy="true"]')]
      .filter(el => root.visible?.(el) !== false).length;
    const nav = root.FlowNavigation?.flowNavigationItem?.("Characters") || root.flowNavigationItem?.("Characters") || null;
    const navText = String(nav?.innerText || nav?.textContent || root.accessibleName?.(nav) || "").replace(/\s+/g, " ").trim();
    const navClass = String(nav?.className?.baseVal || nav?.className || "");
    const navActive = Boolean(nav && (
      /^(?:page|true)$/i.test(nav.getAttribute?.("aria-current") || "") ||
      nav.getAttribute?.("aria-selected") === "true" ||
      nav.getAttribute?.("aria-pressed") === "true" ||
      /^(?:active|selected)$/i.test(nav.getAttribute?.("data-state") || "") ||
      /(?:^|\s)(?:active|selected|current|is-active|mat-mdc-nav-list-item-active)(?:\s|$)/i.test(navClass)
    ));
    const createAction = [...document.querySelectorAll("flow-custom-tile")].some(tile => {
      if (root.visible?.(tile) === false) return false;
      const hasAddIcon = [...(tile.querySelectorAll?.("mat-icon") || [])]
        .some(icon => /^(?:add|add_circle)$/i.test(String(icon.innerText || icon.textContent || "").trim()));
      const text = String(tile.innerText || tile.textContent || "").replace(/\s+/g, " ").trim();
      return hasAddIcon && /(?:new character|create character|nhân vật mới|tạo nhân vật)/i.test(text);
    });
    const explicitEmpty = [...document.querySelectorAll('[role="status"],[role="alert"],[aria-live]')]
      .filter(el => root.visible?.(el) !== false)
      .some(el => /(?:no characters(?: found)?|you have no characters|không có nhân vật|chưa có nhân vật)/i.test(el.innerText || el.textContent || ""));
    const routeIsCharacterForm = /\/character(?:\/|$)/i.test(pathname);
    const activeEvidence = [];
    if (navActive) activeEvidence.push("characters_navigation_active");
    if (createAction) activeEvidence.push("new_character_action");
    if (visibleTiles.length && !routeIsCharacterForm) activeEvidence.push("character_tiles_visible");
    if (explicitEmpty && navActive) activeEvidence.push("explicit_empty_state_in_active_section");
    return {
      url: location.href,
      route: pathname,
      projectId: project?.projectId || null,
      currentSection: activeEvidence.length ? "Characters" : null,
      sectionActive: activeEvidence.length > 0,
      activeEvidence,
      routeIsCharacterForm,
      navigation: nav ? {
        text: navText.slice(0, 100),
        ariaCurrent: nav.getAttribute?.("aria-current") || null,
        ariaSelected: nav.getAttribute?.("aria-selected") || null,
        ariaPressed: nav.getAttribute?.("aria-pressed") || null,
        dataState: nav.getAttribute?.("data-state") || null,
        className: navClass.slice(0, 120),
      } : null,
      createActionVisible: createAction,
      explicitEmptyState: explicitEmpty,
      visibleTileCount: visibleTiles.length,
      totalTileCount: tiles.length,
      loadingCount,
      scrollContainer: container ? {
        tag: container.tagName?.toLowerCase() || null,
        className: String(container.className?.baseVal || container.className || "").slice(0, 120),
        scrollTop: Number(container.scrollTop) || 0,
        clientHeight: Number(container.clientHeight) || 0,
        scrollHeight: Number(container.scrollHeight) || 0,
        connected: container.isConnected !== false,
      } : null,
    };
  }

  function characterScanError(code, message, snapshot) {
    lastCharacterScanDiagnostics = { ...snapshot, result: "incomplete", scanComplete: false, errorCode: code, checkedAt: new Date().toISOString() };
    const error = root.flowError?.(code, message, true, false) || new Error(message);
    error.diagnostics = JSON.parse(JSON.stringify(lastCharacterScanDiagnostics));
    throw error;
  }

  async function scanNativeCharacters(options = {}) {
    const deadline = Math.min(Number(options.deadline) || Infinity, Date.now() + 45_000);
    const requireTime = (operation = "scanning Flow characters") => {
      if (Date.now() >= deadline) {
        const snapshot = characterLibrarySnapshot(container);
        characterScanError("FLOW_CHARACTER_SCAN_INCOMPLETE", `Flow character library scan did not complete while ${operation}; no empty or partial list was returned. Diagnostics: ${JSON.stringify(snapshot).slice(0, 1200)}`, snapshot);
      }
    };
    const boundedWait = async (ms, operation) => {
      requireTime(operation);
      const remaining = deadline - Date.now();
      await root.wait?.(Math.max(1, Math.min(ms, remaining)));
      requireTime(operation);
    };
    requireTime("opening the Characters library");
    const charactersByIdentity = new Map();
    let container = null;
    let originalTop = 0;
    try {
      await root.ensureFlowLibrarySection?.("Characters", { deadline, signal: options.signal });
      requireTime("opening the Characters library");
      // Resolve the scroller only after navigation. The project editor's old
      // scroll element can be detached when the Characters surface mounts.
      container = root.scrollContainer?.() || null;
      originalTop = container?.scrollTop ?? 0;
      if (container) container.scrollTop = 0;
      const readyDeadline = Math.min(deadline, Date.now() + 10_000);
      let stableSince = null;
      let stableSignature = "";
      let librarySettled = false;
      let settledEmpty = false;
      let latest = characterLibrarySnapshot(container);
      while (Date.now() < readyDeadline) {
        latest = characterLibrarySnapshot(container);
        if (!latest.sectionActive || latest.routeIsCharacterForm) {
          stableSince = null;
          stableSignature = "";
          await boundedWait(200, "confirming the active Characters library");
          continue;
        }
        if (latest.loadingCount > 0) {
          stableSince = null;
          stableSignature = "";
          await boundedWait(200, "waiting for the Characters library to finish loading");
          continue;
        }
        if (latest.visibleTileCount > 0) {
          const signature = `${latest.projectId}|${latest.route}|${latest.visibleTileCount}|${latest.activeEvidence.join(",")}`;
          if (signature !== stableSignature) { stableSignature = signature; stableSince = Date.now(); }
          if (stableSince !== null && Date.now() - stableSince >= 500) { librarySettled = true; break; }
        } else {
          // An empty result is valid only in a verified Characters surface,
          // after its controls/state remain stable for a full load window.
          // Without an explicit empty-state message, require the section's
          // New character action as the empty-library marker.
          const canProveEmpty = latest.explicitEmptyState || latest.createActionVisible;
          const signature = `${latest.projectId}|${latest.route}|${latest.activeEvidence.join(",")}|${latest.explicitEmptyState}|${latest.createActionVisible}`;
          if (signature !== stableSignature) { stableSignature = signature; stableSince = Date.now(); }
          const stableMs = stableSince === null ? 0 : Date.now() - stableSince;
          if (canProveEmpty && stableMs >= 3000) { librarySettled = true; settledEmpty = true; break; }
        }
        await boundedWait(150, "waiting for the Characters library to settle");
      }
      if (!librarySettled) {
        latest = characterLibrarySnapshot(container);
        characterScanError("FLOW_CHARACTER_SCAN_INCOMPLETE", `Flow's Characters section could not be verified as active and settled; no empty or partial list was returned. Diagnostics: ${JSON.stringify(latest).slice(0, 1200)}`, latest);
      }
      latest = characterLibrarySnapshot(container);
      if (!latest.sectionActive || latest.routeIsCharacterForm || latest.loadingCount > 0) {
        characterScanError("FLOW_CHARACTER_SCAN_INCOMPLETE", `Flow's Characters section changed before scanning began; no list was returned. Diagnostics: ${JSON.stringify(latest).slice(0, 1200)}`, latest);
      }
      lastCharacterScanDiagnostics = { ...latest, result: settledEmpty ? "confirmed_empty" : "scanning", scanComplete: false, checkedAt: new Date().toISOString() };
      options.onDiagnostics?.(JSON.parse(JSON.stringify(lastCharacterScanDiagnostics)));

      const documentScroller = document.scrollingElement || document.documentElement;
      let reachedEnd = Boolean(container) || Boolean(documentScroller && Number.isFinite(documentScroller.scrollHeight) && Number.isFinite(documentScroller.clientHeight) && documentScroller.scrollHeight <= documentScroller.clientHeight + 2);
      if (!reachedEnd) {
        characterScanError("FLOW_CHARACTER_SCAN_INCOMPLETE", "Flow's Characters library has no verified scroll container or settled non-scrollable document; no complete list was returned.", characterLibrarySnapshot(container));
      }
      let step = 0;
      while (container && step < 100 && Date.now() < deadline) {
        step++;
        requireTime("scanning the Characters library");
        const charTiles = (typeof root.flowQueryAll === "function" ? root.flowQueryAll("components.characterTile", document, { checkVisible: false }) : null) ||
          document.querySelectorAll("flow-character-tile");
        collectVisibleCharacterTiles(charTiles, charactersByIdentity, container);
        const before = container.scrollTop;
        const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
        if (before >= maxTop - 2) { reachedEnd = true; break; }
        container.scrollTop = Math.min(maxTop, before + Math.max(200, container.clientHeight * 0.78));
        await boundedWait(400, "scanning the Characters library");
        if (container.scrollTop <= before) {
          characterScanError("FLOW_CHARACTER_SCAN_INCOMPLETE", "Flow's character library stopped scrolling before its end; no complete list was returned.", characterLibrarySnapshot(container));
        }
      }
      requireTime("scanning the Characters library");
      if (!reachedEnd) {
        characterScanError("FLOW_CHARACTER_SCAN_LIMIT", "Flow's Characters library exceeded the scan page limit; no partial list was returned.", characterLibrarySnapshot(container));
      }
      const finalCharTiles = (typeof root.flowQueryAll === "function" ? root.flowQueryAll("components.characterTile", document, { checkVisible: false }) : null) ||
        document.querySelectorAll("flow-character-tile");
      collectVisibleCharacterTiles(finalCharTiles, charactersByIdentity, container);
      const finalSnapshot = characterLibrarySnapshot(container);
      if (!finalSnapshot.sectionActive || finalSnapshot.routeIsCharacterForm || finalSnapshot.loadingCount > 0) {
        characterScanError("FLOW_CHARACTER_SCAN_INCOMPLETE", `Flow's Characters section changed during the scan; no list was returned. Diagnostics: ${JSON.stringify(finalSnapshot).slice(0, 1200)}`, finalSnapshot);
      }
      const characters = [...charactersByIdentity.values()];
      const result = characters.length ? "complete" : "confirmed_empty";
      lastCharacterScanDiagnostics = {
        ...finalSnapshot,
        result,
        scanComplete: true,
        nameCount: characters.length,
        stableUuidCount: characters.filter(character => character.uuid).length,
        checkedAt: new Date().toISOString(),
      };
      options.onDiagnostics?.(JSON.parse(JSON.stringify(lastCharacterScanDiagnostics)));
      return characters;
    } finally {
      if (container) container.scrollTop = originalTop;
      if (/\/character\/?$/i.test(location.pathname)) {
        const back = root.flowButton?.("Go back");
        if (back) {
          back.click();
          const cleanupTimeout = Math.max(1, Math.min(3000, deadline - Date.now()));
          await root.waitForFlowRoute?.(path => !/\/character\/?$/i.test(path), cleanupTimeout, "Flow did not leave the empty character chooser.").catch(() => {});
        }
      }
      if (root.clickFlowNavigation?.("All media") && Date.now() < deadline) await boundedWait(300, "returning to All media");
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

  function readCharacterIdentity(tile) {
    const name = cleanCharacterName(tile?.innerText || tile?.textContent || "");
    if (!name) return null;
    // The portrait's media UUID identifies its image, not the saved character.
    // Only character-specific identity attributes may be exposed as UUIDs.
    const candidates = [
      tile.getAttribute?.("data-character-id"),
      tile.getAttribute?.("data-character-uuid"),
      tile.querySelector?.("[data-character-id]")?.getAttribute?.("data-character-id"),
      tile.querySelector?.("[data-character-uuid]")?.getAttribute?.("data-character-uuid"),
    ];
    const uuid = candidates.find(value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))?.toLowerCase();
    return { name, ...(uuid ? { uuid } : {}) };
  }

  function collectVisibleCharacterTiles(tiles, target, container) {
    for (const tile of tiles) {
      if (root.visible?.(tile) === false) continue;
      const character = readCharacterIdentity(tile);
      if (!character) {
        characterScanError("FLOW_CHARACTER_SCAN_INVALID_RESULT", "A visible Flow character tile did not expose a usable name; the library scan is incomplete.", characterLibrarySnapshot(container));
      }
      target.set(character.uuid || `name:${character.name.toLocaleLowerCase()}`, character);
    }
  }

  function nativeRead(name) {
    if (name === "flowState") {
      const url = location.href;
      const desc = root.ProviderRegistry?.describeUrl?.(url) || root.FlowDriverRegistry?.describeUrl?.(url) || null;
      const signedIn = !/\/about|accounts\.google\.com/.test(url);
      const inProject = Boolean(desc?.projectId);
      const isProjectEditor = Boolean(desc?.isProjectEditor);
      const state = { url, signedIn, inProject, isProjectEditor, projectId: desc?.projectId || null };
      // Read-only audit data helps distinguish a stale content-script bundle,
      // an unrecognized V2 trigger, and a disabled control before upload code
      // is allowed to open the picker or select a file.
      state.uploadControlDiagnostics = root.FlowComponents?.inspectUploadTrigger?.() || null;
      state.framePickerDiagnostics = root.FlowComponents?.inspectFramePickerDiagnostics?.() || null;
      state.referenceClearDiagnostics = root.inspectFlowReferenceClearDiagnostics?.() || null;
      state.referenceActionDiagnostics = root.FlowReferenceActions?.inspectDiagnostics?.() || null;
      state.characterNameDiagnostics = root.FlowCharacterActions?.inspectNameDiagnostics?.() || null;
      state.characterListDiagnostics = lastCharacterScanDiagnostics ? JSON.parse(JSON.stringify(lastCharacterScanDiagnostics)) : null;
      state.imageSettingsDiagnostics = root.FlowSettings?.inspectImagePreparationDiagnostics?.() || null;
      state.videoSettingsDiagnostics = root.FlowSettings?.inspectVideoPreparationDiagnostics?.() || null;
      const visibleSubmitWarnings = root.FlowEditor?.currentFlowSubmitErrors?.() || [];
      if (visibleSubmitWarnings.length) state.submitWarnings = visibleSubmitWarnings;
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
    const projectLinks = () => [...((typeof root.flowQueryAll === "function" ? root.flowQueryAll("navigation.projectLinks", document, { checkVisible: false }) : null) || document.querySelectorAll('a[href*="/project/"]'))]
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
    inspectCharacterScanDiagnostics: () => lastCharacterScanDiagnostics ? JSON.parse(JSON.stringify(lastCharacterScanDiagnostics)) : null,
  });

  root.FlowMediaMenu = FlowMediaMenu;
  root.triggerFlowDownload = triggerFlowDownload;
  root.scanNativeAssets = scanNativeAssets;
  root.scanNativeProjects = scanNativeProjects;
  root.scanNativeCharacters = scanNativeCharacters;
  root.nativeRead = nativeRead;
  root.collectAssets = collectAssets;
})(globalThis);
