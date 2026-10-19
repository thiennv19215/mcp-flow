var nativeUploadAssemblers = new Map();
var stagedNativeFiles = new Map();

function validStagedLocalImage(value, suffixPattern) {
  return Boolean(value && typeof value.transferId === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value.transferId) && stagedNativeFiles.has(value.transferId) &&
    typeof value.name === "string" && new RegExp(`^fm-[A-Za-z0-9_-]{1,32}-${suffixPattern.source}\\.(?:png|jpe?g|webp|gif|heic|heif|avif)$`, "i").test(value.name));
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
