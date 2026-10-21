(() => {
  "use strict";

  const root = globalThis;

  function cleanFlowMediaCandidateName(str) {
    if (!str) return "";
    let clean = String(str).replace(/\s+/g, " ").trim().toLowerCase();
    // Strip tiền tố ở đầu: "hình ảnh ", "ảnh ", "video ", "nội dung nghe nhìn ", "tệp ", "nhân vật ", "image ", "media "
    clean = clean.replace(/^(?:h\u00ECnh\s+\u1EA3nh|\u1EA3nh|video|n\u1ED9i\s+dung(?:\s+nghe\s+nh\u00ECn)?|t\u1EC7p|nh\u00E2n\s+v\u1EADt|image|media)\s+/i, "");
    // Strip hậu tố ở cuối: " hình ảnh", " ảnh", " video", " nhân vật", " avatar", " nội dung nghe nhìn", " image"
    clean = clean.replace(/\s+(?:h\u00ECnh\s+\u1EA3nh|\u1EA3nh|video|nh\u00E2n\s+v\u1EADt|avatar|n\u1ED9i\s+dung(?:\s+nghe\s+nh\u00ECn)?|image)$/i, "");
    return clean.trim();
  }

  function normalizeFlowUploadName(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function flowUploadNameMatches(value, assetName) {
    if (!value || !assetName) return false;
    const name = cleanFlowMediaCandidateName(normalizeFlowUploadName(value));
    const full = normalizeFlowUploadName(assetName);
    const stem = normalizeFlowUploadName(String(assetName || "").replace(/\.(?:png|jpe?g|webp|gif|heic|heif|avif|mp4|m4v|mov|webm|avi|mkv|3gp)$/i, ""));
    if (name && (name === full || name === stem)) return true;
    const normName = typeof root.normalizeFlowUiText === "function" ? root.normalizeFlowUiText(name) : name;
    const normFull = typeof root.normalizeFlowUiText === "function" ? root.normalizeFlowUiText(full) : full;
    const normStem = typeof root.normalizeFlowUiText === "function" ? root.normalizeFlowUiText(stem) : stem;
    return Boolean(normName && (normName === normFull || normName === normStem));
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
    return candidates.some(candidate => {
      const rawClean = cleanFlowMediaCandidateName(candidate);
      if (rawClean === full || rawClean === stem) return true;
      const normClean = typeof root.normalizeFlowUiText === "function" ? root.normalizeFlowUiText(rawClean) : rawClean;
      const normFull = typeof root.normalizeFlowUiText === "function" ? root.normalizeFlowUiText(full) : full;
      const normStem = typeof root.normalizeFlowUiText === "function" ? root.normalizeFlowUiText(stem) : stem;
      return Boolean(normClean && (normClean === normFull || normClean === normStem));
    });
  }

  function flowUploadTileKind(tile) {
    if (!tile) return null;
    if (tile.querySelector("flow-scene-tile")) return "scene";
    if (tile.querySelector("flow-video-tile,video")) return "video";
    if (tile.querySelector("flow-image-tile,img")) return "image";
    return null;
  }

  function flowUploadKindMatches(expectedKind, actualKind) {
    return expectedKind === "video" ? actualKind === "video" || actualKind === "scene" : actualKind === expectedKind;
  }

  function resolveUniqueUploadTarget(candidates, code, actionLabel) {
    if (candidates.length > 1) {
      const fn = root.flowError || ((c, m, r, o) => Object.assign(new Error(m), { code: c, retryable: r, outcome_unknown: o }));
      throw fn(code, `Flow shows multiple matching ${actionLabel} controls. No control was selected.`, false, false);
    }
    return candidates[0] || null;
  }

  function assertReusableFlowUploadKind(tile, assetName, expectedKind) {
    const actualKind = flowUploadTileKind(tile);
    if (actualKind && !flowUploadKindMatches(expectedKind, actualKind)) {
      const fn = root.flowError || ((c, m, r, o) => Object.assign(new Error(m), { code: c, retryable: r, outcome_unknown: o }));
      throw fn("FLOW_UPLOAD_KIND_MISMATCH", `Flow already has a ${actualKind} tile named "${assetName}", not the requested ${expectedKind}. No upload was started.`, false, false);
    }
    return actualKind;
  }

  function flowUploadTileNames(tile) {
    if (!tile) return [];
    return [tile.getAttribute("aria-label"), tile.getAttribute("title"), tile.getAttribute("data-tile-name"),
      tile.querySelector("img")?.getAttribute("alt"), tile.querySelector("img")?.getAttribute("aria-label")]
      .map(value => String(value || "").trim()).filter(Boolean);
  }

  function safeFlowPickerMethod(value) {
    return ["input-capture", "input.click", "showOpenFilePicker", "input-assign", "drop"].includes(value) ? value : "unknown";
  }

  function safeFlowPickerType(value) {
    const type = String(value || "").toLowerCase();
    return /^(?:image|video)\/[a-z0-9.+-]{1,80}$/.test(type) ? type : "unknown";
  }

  function inspectFlowUploadUiState() {
    const isVisible = root.visible || (el => Boolean(el && el.isConnected));
    const visibleElements = selector => [...document.querySelectorAll(selector)].filter(isVisible).slice(0, 100);
    const dialogs = visibleElements('[role="dialog"],mat-dialog-container').filter(el =>
      /video|upload/i.test(String(el.innerText || el.textContent || "").slice(0, 1200)));
    const progress = visibleElements('[role="progressbar"],[aria-busy="true"],mat-progress-bar,.mat-mdc-progress-bar,[data-state="loading"]');
    const errorTiles = visibleElements("flow-error-tile");
    const textErrors = visibleElements('[role="alert"],[aria-live="assertive"],.error,.warning,[data-testid*="error"]')
      .some(el => /upload|video|file/i.test(String(el.innerText || el.textContent || "").slice(0, 240)) &&
        /reject|unsupported|invalid|failed|error|too large|không hỗ trợ|không thể tải/i.test(String(el.innerText || el.textContent || "").slice(0, 240)));
    return {
      confirmationDialogVisible: dialogs.length > 0,
      visibleProgressIndicatorCount: progress.length,
      visibleErrorTileCount: errorTiles.length,
      visibleUploadRejection: Boolean(errorTiles.length || textErrors),
    };
  }

  function flowComposerForUpload() {
    const editor = (typeof root.flowQuery === "function" ? root.flowQuery("editor") : null) ||
      document.querySelector(".ProseMirror[contenteditable='true']");
    const submit = root.FlowEditor?.getFlowSubmitButton?.() || root.getFlowSubmitButton?.();
    if (!editor || !submit) return null;
    for (let node = editor.parentElement, depth = 0; node && node !== document.body && depth < 12; node = node.parentElement, depth++) {
      if (node.contains(submit) && /composer|prompt|form/i.test(`${node.tagName} ${String(node.className?.baseVal || node.className || "")}`)) return node;
    }
    const configured = (typeof root.flowQuery === "function" ? root.flowQuery("composerRoot") : null);
    if (configured?.contains(editor) && configured.contains(submit)) return configured;
    for (let node = editor.parentElement, depth = 0; node && node !== document.body && depth < 12; node = node.parentElement, depth++) {
      if (node.contains(submit)) return node;
    }
    return null;
  }

  function uploadControlDiagnostics(composer = flowComposerForUpload()) {
    const scope = composer || document;
    const isVisible = root.visible || (el => Boolean(el && el.isConnected));
    const getAria = root.accessibleName || (el => el.getAttribute("aria-label") || "");
    return [...scope.querySelectorAll('button,[role="button"],mat-button,[tabindex="0"]')]
      .filter(isVisible).slice(0, 30).map(el => ({
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role"),
        aria: getAria(el).replace(/\s+/g, " ").trim().slice(0, 80),
        title: (el.getAttribute("title") || "").slice(0, 80),
        text: String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
        ariaPressed: el.getAttribute("aria-pressed"),
        ariaSelected: el.getAttribute("aria-selected"),
        dataState: el.getAttribute("data-state"),
        checked: typeof el.checked === "boolean" ? el.checked : null,
        disabled: Boolean(el.disabled || el.getAttribute("aria-disabled") === "true"),
        icon: el.querySelector("mat-icon,.mat-icon,.google-symbols,.material-symbols-outlined,svg")?.textContent?.trim().slice(0, 40) || "",
        className: String(el.className?.baseVal || el.className || "").slice(0, 100),
      }));
  }

  function findAddMediaButton() {
    const composer = flowComposerForUpload();
    if (!composer) return null;
    const sharedResolver = typeof root.flowButton === "function" ? root.flowButton("Add ingredients to the prompt box", composer) : null;
    if (sharedResolver && composer.contains(sharedResolver)) return sharedResolver;
    const isVisible = root.visible || (el => Boolean(el && el.isConnected));
    const getAria = root.accessibleName || (el => el.getAttribute("aria-label") || "");
    const candidates = [...composer.querySelectorAll('button,[role="button"],mat-button,[tabindex="0"]')].filter(isVisible);
    const names = new Set([
      "add media menu", "add media", "add to prompt", "add to prompt box", "add component",
      "add ingredients to the prompt box", "add ingredient", "add content", "add", "+",
      "thêm nội dung nghe nhìn", "thêm tệp", "thêm vào lời nhắc", "thêm thành phần",
      "thêm thành phần vào hộp lời nhắc", "thêm thành phần vào hộp câu lệnh", "thêm vào hộp lời nhắc",
      "thêm phương tiện", "thêm ảnh", "thêm video", "thêm hình ảnh", "thêm",
    ]);
    const clean = value => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
    const labelOf = el => [getAria(el), el.getAttribute("aria-label"), el.getAttribute("title"), el.innerText, el.textContent]
      .map(clean).filter(Boolean);
    const exact = candidates.find(el => labelOf(el).some(label => {
      if (names.has(label)) return true;
      const norm = typeof root.normalizeFlowUiText === "function" ? root.normalizeFlowUiText(label) : label;
      for (const name of names) {
        if ((typeof root.normalizeFlowUiText === "function" ? root.normalizeFlowUiText(name) : name) === norm) return true;
      }
      return false;
    }));
    if (exact) return exact;
    const addIcons = new Set(["add", "add_circle", "add_2", "add_circle_outline", "add_box", "add_rounded"]);
    const isNav = root.isFlowProjectNavigationControl || (() => false);
    const iconCandidates = candidates.filter(el => {
      if (isNav(el)) return false;
      const icon = clean(el.querySelector("mat-icon,.mat-icon,.google-symbols,.material-symbols-outlined,svg")?.textContent);
      return addIcons.has(icon);
    });
    const submit = root.FlowEditor?.getFlowSubmitButton?.();
    const adjacent = submit?.previousElementSibling;
    return adjacent && candidates.includes(adjacent) && iconCandidates.includes(adjacent) ? adjacent : iconCandidates[0] || null;
  }

  async function ensureAddMediaButton(deadline = Date.now() + 10_000, signal) {
    const requireTime = operation => root.FlowUiDeadline?.requireTime(deadline, operation, false, signal);
    const boundedWait = (ms, operation) => root.FlowUiDeadline?.boundedWait(ms, deadline, operation, false, signal);
    requireTime("finding Flow's upload control");
    let button = findAddMediaButton();
    if (button) return button;

    const settings = root.FlowSettings;
    const settingsTrigger = typeof root.flowButton === "function" ? root.flowButton("Settings trigger", flowComposerForUpload() || document) : null;
    if (settingsTrigger && settings) {
      await settings.openFlowSettings({ deadline, signal });
      requireTime("inspecting Flow's current video mode");
      const framesOption = settings.flowRadio("Frames");
      const framesSelected = settings.nativeRadioSelected(framesOption) ||
        framesOption?.getAttribute("aria-selected") === "true" || framesOption?.getAttribute("data-state") === "active";
      if (framesSelected) {
        await settings.chooseRadio("Ingredients", { deadline, signal });
        const ingredients = settings.flowRadio("Ingredients");
        if (!settings.nativeRadioSelected(ingredients) && ingredients?.getAttribute("aria-selected") !== "true" && ingredients?.getAttribute("data-state") !== "active") {
          const fn = root.flowError || ((c, m, r, o) => Object.assign(new Error(m), { code: c, retryable: r, outcome_unknown: o }));
          throw fn("FLOW_UPLOAD_MODE_SWITCH_UNCONFIRMED", "Flow did not confirm Ingredients mode; no file was selected.", true, false);
        }
      }
      await settings.closeFlowSettings({ deadline, signal });
      const triggerDeadline = Math.min(Date.now() + 2500, deadline);
      while (Date.now() < triggerDeadline && !(button = findAddMediaButton())) await boundedWait(80, "waiting for Flow's composer Upload control");
    }
    return button;
  }

  async function confirmFlowVideoUploadIfPrompted(deadline = Date.now() + 10_000, signal, selection = {}) {
    const isVisible = root.visible || (el => Boolean(el && el.isConnected));
    const getAria = root.accessibleName || (el => el.getAttribute("aria-label") || "");
    const fn = root.flowError || ((c, m, r, o) => Object.assign(new Error(m), { code: c, retryable: r, outcome_unknown: o }));
    const result = { confirmationDialogSeen: false, confirmationButtonClicked: false, confirmationDialogUnrecognized: false };
    const ambiguous = (reason, dialogCount, controlCount) => {
      const error = fn("FLOW_UPLOAD_CONFIRMATION_AMBIGUOUS", `Flow displayed an ambiguous video upload confirmation (${reason}); no confirmation control was clicked. Inspect Flow before retrying.`, false, true);
      error.diagnostics = {
        ...result,
        confirmationDialogCandidateCount: dialogCount,
        enabledConfirmationControlCount: controlCount,
        filePickerSelectionConfirmed: selection.filePickerSelectionConfirmed === true,
        pickerMethod: safeFlowPickerMethod(selection.pickerMethod),
        pickerType: safeFlowPickerType(selection.pickerType),
        uploadUi: inspectFlowUploadUiState(),
      };
      throw error;
    };
    for (let attempt = 0; attempt < 24; attempt++) {
      if (Date.now() >= deadline) throw fn("FLOW_OPERATION_TIMEOUT", "Timed out while confirming Flow's video upload. Inspect Flow before retrying.", false, true);
      const matchingDialogs = [...document.querySelectorAll('[role="dialog"],mat-dialog-container')].filter(el =>
        isVisible(el) && /video|upload|tải lên|tải video|tải tệp/i.test(String(el.innerText || el.textContent || "").slice(0, 1200)));
      const specificDialogs = matchingDialogs.filter(dialog =>
        !matchingDialogs.some(other => other !== dialog && dialog.contains?.(other)));
      if (!specificDialogs.length) {
        await root.FlowUiDeadline?.boundedWait(300, deadline, "waiting for Flow's video upload confirmation", true, signal);
        continue;
      }
      result.confirmationDialogSeen = true;
      if (specificDialogs.length !== 1) ambiguous("multiple visible dialogs", specificDialogs.length, 0);
      const dialog = specificDialogs[0];
      const confirms = [...dialog.querySelectorAll("button,[role=button]")].filter(el => {
        if (!isVisible(el) || el.disabled || el.getAttribute("aria-disabled") === "true") return false;
        const text = (getAria(el) || el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
        return /^(?:upload|continue|confirm|agree|accept|next|done|ok|got it|tải lên|tiếp tục|xác nhận|đồng ý|chấp nhận|tải video|tải video lên)(?:\s+(?:và\s+|and\s+)?(?:tiếp tục|upload|tải lên|video|file|media))?$/i.test(text) ||
          /^(?:upload\s+video|upload\s+file|upload\s+media|continue\s+upload|agree\s+and\s+continue|tiếp tục\s+tải lên)$/i.test(text);
      });
      if (confirms.length > 1) ambiguous("multiple enabled confirmation controls", 1, confirms.length);
      const confirm = confirms[0];
      if (confirm) { confirm.click(); result.confirmationButtonClicked = true; await root.FlowUiDeadline?.boundedWait(250, deadline, "confirming Flow's video upload", true, signal); return result; }
      await root.FlowUiDeadline?.boundedWait(300, deadline, "waiting for Flow's video upload confirmation", true, signal);
    }
    result.confirmationDialogUnrecognized = true;
    const error = fn("FLOW_UPLOAD_CONFIRMATION_UNRECOGNIZED", "Flow displayed a video upload confirmation dialog, but no recognized Upload, Continue, or Confirm control appeared. No further upload actions were started; inspect Flow before retrying.", false, true);
    error.diagnostics = {
      ...result,
      filePickerSelectionConfirmed: selection.filePickerSelectionConfirmed === true,
      pickerMethod: safeFlowPickerMethod(selection.pickerMethod),
      pickerType: safeFlowPickerType(selection.pickerType),
      dropAttempted: selection.dropAttempted === true,
      dropReceiptConfirmed: selection.dropReceiptConfirmed === true,
      uploadUi: inspectFlowUploadUiState(),
    };
    throw error;
  }

  async function waitForNativeMediaTile(assetName, command, kind, options = {}) {
    const fn = root.flowError || ((c, m, r, o) => Object.assign(new Error(m), { code: c, retryable: r, outcome_unknown: o }));
    const deadline = Math.min(options.deadline || Infinity, Date.now() + (kind === "video" ? 60_000 : 90_000));
    const startedAt = Date.now();
    let nextLibraryScanAt = startedAt + 1_500;
    let libraryScans = 0;
    const maxLibraryScans = Number.isInteger(options.maxLibraryScans) ? Math.max(0, options.maxLibraryScans) : 3;
    const baselineIds = new Set((options.baselineIds || []).map(String));
    const requireNewOwner = options.requireNewOwner === true;
    let ownerId = options.ownerId ? String(options.ownerId) : null;
    let exactTileObserved = false;
    let lastScan = null;
    let lastScanErrorCode = null;
    const getMediaId = root.mediaId || (el => el.getAttribute("data-media-id") || el.getAttribute("id") || "");

    while (Date.now() < deadline) {
      const exactMatches = [...document.querySelectorAll("flow-grid-tile-container")]
        .filter(item => matchesFlowTile(item, assetName));
      if (exactMatches.length) exactTileObserved = true;
      if (exactMatches.length > 1) {
        throw fn("FLOW_UPLOAD_TILE_AMBIGUOUS", `More than one Flow tile exactly matches uploaded ${kind} "${assetName}". Inspect the library before retrying.`, false, true);
      }
      const tile = exactMatches[0] || null;
      if (tile) {
        if (tile.querySelector("flow-error-tile")) {
          throw fn("FLOW_UPLOAD_REJECTED", `Flow rejected uploaded ${kind} "${assetName}".`, false, true);
        }
        const identity = getMediaId(tile);
        const hasPersistentIdentity = identity && !identity.startsWith("title:");
        const isNewOwner = hasPersistentIdentity && !baselineIds.has(String(identity));
        const actualKind = flowUploadTileKind(tile);
        if (requireNewOwner && isNewOwner) {
          if (ownerId && ownerId !== String(identity)) {
            throw fn("FLOW_UPLOAD_TILE_AMBIGUOUS", `A second new Flow media ID appeared while confirming uploaded ${kind} "${assetName}". Inspect the library before retrying.`, false, true);
          }
          ownerId = String(identity);
        }
        const identityMatchesOwner = !requireNewOwner || Boolean(ownerId && hasPersistentIdentity && String(identity) === ownerId && isNewOwner);
        const kindMatches = flowUploadKindMatches(kind, actualKind);
        const ready = root.FlowTiles?.isTileMediaReady?.(tile) ?? !root.isTileBusy?.(tile);
        if (requireNewOwner && hasPersistentIdentity && !isNewOwner) {
          // Pre-existing tile
        } else if (ready && kindMatches && identityMatchesOwner && hasPersistentIdentity && flowUploadTileNames(tile).some(name => flowUploadNameMatches(name, assetName))) {
          return { name: flowUploadTileNames(tile).find(name => flowUploadNameMatches(name, assetName)) || assetName, id: identity, kind };
        }
      }
      if (libraryScans < maxLibraryScans && Date.now() >= nextLibraryScanAt && root.FlowMediaMenu?.scanNativeAssets) {
        libraryScans++;
        nextLibraryScanAt = Date.now() + 2_000;
        try {
          const assets = await root.FlowMediaMenu.scanNativeAssets({
            deadline: Math.min(deadline, Date.now() + 8_000),
            maxDurationMs: 8_000,
            exactName: assetName,
            kind,
            includeIncomplete: true,
            ...(requireNewOwner ? { baselineIds: [...baselineIds], ownerKind: kind } : {}),
            keepPositionOnMatch: true,
            onDiagnostics: diagnostics => {
              lastScan = { steps: Number(diagnostics.steps) || 0, uniqueTiles: Number(diagnostics.uniqueTiles) || 0,
                reachedEnd: diagnostics.reachedEnd === true, exactMatchCount: Number(diagnostics.exactMatchCount) || 0 };
              root.emitFlowProgress?.(command, `Upload confirmation scan ${libraryScans}: ${lastScan.uniqueTiles} unique tiles across ${lastScan.steps} pages; baseline ${baselineIds.size}, owner ${ownerId || "not latched"}`);
            },
          });
          const confirmedAssets = assets.filter(asset => flowUploadNameMatches(asset?.name, assetName) && asset?.id);
          if (confirmedAssets.length > 1) throw fn("FLOW_UPLOAD_TILE_AMBIGUOUS", `More than one Flow library tile exactly matches uploaded ${kind} "${assetName}". Inspect the library before retrying.`, false, true);
          if (confirmedAssets.length === 1) {
            const asset = confirmedAssets[0];
            if (asset.error) throw fn("FLOW_UPLOAD_REJECTED", `Flow rejected uploaded ${kind} "${assetName}".`, false, true);
            const isNewOwner = !requireNewOwner || (asset.newSinceBaseline === true && !baselineIds.has(String(asset.id)));
            if (requireNewOwner && !isNewOwner) {
              // Stale
            } else {
              if (ownerId && ownerId !== String(asset.id)) throw fn("FLOW_UPLOAD_TILE_AMBIGUOUS", `Flow reported a different new media ID while confirming "${assetName}". Inspect the library before retrying.`, false, true);
              ownerId = String(asset.id);
              const kindMatches = flowUploadKindMatches(kind, asset.kind);
              const kindUnknown = !asset.kind;
              if (!kindMatches && !kindUnknown) throw fn("FLOW_UPLOAD_KIND_MISMATCH", `Flow's new media ID for "${assetName}" hydrated as ${asset.kind}, not ${kind}. Inspect it before retrying.`, false, true);
              if (kindMatches && asset.ready === true && asset.busy === false) return { name: asset.name, id: asset.id, kind };
            }
          }
        } catch (error) {
          lastScanErrorCode = typeof error?.code === "string" ? error.code : "SCAN_FAILED";
          if (["FLOW_UPLOAD_TILE_AMBIGUOUS", "FLOW_ASSET_AMBIGUOUS", "FLOW_UPLOAD_REJECTED", "FLOW_UPLOAD_KIND_MISMATCH"].includes(error?.code)) throw error;
        }
      }
      if (typeof root.wait === "function") await root.wait(250);
      else await new Promise(r => setTimeout(r, 250));
    }
    const selection = options.selectionDiagnostics || {};
    const diagnostics = {
      filePickerSelectionConfirmed: selection.filePickerSelectionConfirmed === true,
      pickerMethod: safeFlowPickerMethod(selection.pickerMethod),
      pickerType: safeFlowPickerType(selection.pickerType),
      dropAttempted: selection.dropAttempted === true,
      dropReceiptConfirmed: selection.dropReceiptConfirmed === true,
      confirmationDialogSeen: selection.confirmationDialogSeen === true,
      confirmationButtonClicked: selection.confirmationButtonClicked === true,
      confirmationDialogUnrecognized: selection.confirmationDialogUnrecognized === true,
      exactTileObserved,
      baselineIdCount: baselineIds.size,
      newOwnerIdLatched: Boolean(ownerId),
      scansAttempted: libraryScans,
      lastScan,
      lastScanErrorCode,
      uploadUi: inspectFlowUploadUiState(),
    };
    const timeoutErr = fn("FLOW_UPLOAD_TIMEOUT", `Flow did not confirm an exact ${kind} library tile for "${assetName}" before the bounded deadline. Picker selection confirmed: ${diagnostics.filePickerSelectionConfirmed}; method: ${diagnostics.pickerMethod}; type: ${diagnostics.pickerType}; full-library scans: ${libraryScans}; last scan: ${lastScan ? `${lastScan.uniqueTiles} tiles, ${lastScan.steps} pages, reached end ${lastScan.reachedEnd}` : "no scan diagnostics"}. Visible rejection: ${diagnostics.uploadUi.visibleUploadRejection}; progress indicators: ${diagnostics.uploadUi.visibleProgressIndicatorCount}. Inspect Flow before retrying.`, false, true);
    timeoutErr.diagnostics = diagnostics;
    throw timeoutErr;
  }

  async function uploadStagedMedia(file, kind, command, options = {}) {
    const fn = root.flowError || ((c, m, r, o) => Object.assign(new Error(m), { code: c, retryable: r, outcome_unknown: o }));
    const deadline = options.deadline || root.FlowUiDeadline?.makeDeadline(command, 75_000, 15_000) || Date.now() + 60_000;
    const checkTime = (operation, outcomeUnknown = false) => root.FlowUiDeadline?.requireTime(deadline, operation, outcomeUnknown, options.signal);
    checkTime("starting the Flow media upload");

    const scroller = typeof root.scrollContainer === "function" ? root.scrollContainer() : null;
    if (scroller && scroller.scrollTop > 5) {
      scroller.scrollTop = 0;
      await root.FlowUiDeadline?.boundedWait(150, deadline, "scrolling to the Flow composer", false, options.signal);
    }

    const existingTiles = [...document.querySelectorAll("flow-grid-tile-container")].filter(item => matchesFlowTile(item, file.name));
    if (existingTiles.length > 1) {
      throw fn("FLOW_UPLOAD_TILE_AMBIGUOUS", `More than one Flow tile exactly matches "${file.name}". Inspect the library before retrying.`, false, true);
    }
    if (existingTiles.length === 1) {
      if (existingTiles[0].querySelector("flow-error-tile")) {
        throw fn("FLOW_UPLOAD_REJECTED", `Flow already has an error tile for "${file.name}". Inspect it before retrying.`, false, true);
      }
      const id = typeof root.mediaId === "function" ? root.mediaId(existingTiles[0]) : "";
      const ready = root.FlowTiles?.isTileMediaReady?.(existingTiles[0]) ?? !root.isTileBusy?.(existingTiles[0]);
      const actualKind = assertReusableFlowUploadKind(existingTiles[0], file.name, kind);
      if (ready && id && !id.startsWith("title:") && flowUploadKindMatches(kind, actualKind)) {
        return { uploaded: true, name: file.name, kind, id, reused: true };
      }
      const confirmed = await waitForNativeMediaTile(file.name, command, kind, { deadline, signal: options.signal });
      return { uploaded: true, name: file.name, kind, id: confirmed.id, reused: true };
    }

    const baselineAssets = root.FlowMediaMenu?.collectAssets?.({ includeIncomplete: true });
    if (!Array.isArray(baselineAssets)) {
      throw fn("FLOW_UPLOAD_BASELINE_UNAVAILABLE", "Could not capture Flow media IDs before upload. No file was selected; inspect the project before retrying.", false, false);
    }
    const baselineIds = [...new Set(baselineAssets.map(asset => asset?.id).filter(Boolean).map(String))];

    const uploadButton = await ensureAddMediaButton(deadline, options.signal);
    const normalize = value => String(value || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
    const isVisible = root.visible || (el => Boolean(el && el.isConnected));
    const getAria = root.accessibleName || (el => el.getAttribute("aria-label") || "");

    const uploadNames = new Set([
      "upload", "upload media", "upload file", "upload from computer", "upload from device", "uploads",
      "tải lên", "tải tệp", "tải tệp lên", "tải lên tệp", "tải ảnh lên", "tải hình ảnh lên",
      "tải nội dung nghe nhìn lên", "tải phương tiện lên", "nội dung tải lên", "tệp tải lên",
      "tải lên từ máy tính", "tải lên từ thiết bị", "tải tệp từ thiết bị", "chọn tệp để tải lên",
      "tải nội dung lên", "tải phương tiện",
    ]);
    const normUploadNames = new Set([...uploadNames].map(name => typeof root.normalizeFlowUiText === "function" ? root.normalizeFlowUiText(name) : name));

    const labelOf = el => {
      const labels = [getAria(el), el.getAttribute("aria-label"), el.getAttribute("title"), el.innerText, el.textContent];
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
      return labelOf(el).some(label => {
        if (uploadNames.has(label)) return true;
        const stripped = label.replace(/^(?:upload|upload_file|file_upload|arrow_upward)\s+/, "");
        if (uploadNames.has(stripped)) return true;
        const folded = typeof root.normalizeFlowUiText === "function" ? root.normalizeFlowUiText(label) : label;
        return normUploadNames.has(folded);
      });
    };

    const isUploadAction = el => {
      if (el.matches('[role="tab"]') || el.getAttribute("aria-selected") !== null) return false;
      const icon = el.querySelector("mat-icon,.mat-icon,.google-symbols,.material-symbols-outlined,svg")?.textContent?.trim() || "";
      if (["file_upload", "upload_file", "cloud_upload", "upload"].includes(icon)) return true;
      const actionNames = new Set([
        "upload", "upload media", "upload file", "upload from computer", "upload from device",
        "tải lên", "tải tệp", "tải tệp lên", "tải lên tệp", "tải ảnh lên", "tải hình ảnh lên",
        "tải nội dung nghe nhìn lên", "tải phương tiện lên", "tải lên từ máy tính", "tải lên từ thiết bị",
        "tải tệp từ thiết bị", "chọn tệp để tải lên", "tải nội dung lên",
      ]);
      const normActionNames = new Set([...actionNames].map(a => typeof root.normalizeFlowUiText === "function" ? root.normalizeFlowUiText(a) : a));
      return labelOf(el).some(label => {
        if (actionNames.has(label)) return true;
        const folded = typeof root.normalizeFlowUiText === "function" ? root.normalizeFlowUiText(label) : label;
        if (normActionNames.has(folded)) return true;
        return folded.includes("tai len") || folded.includes("tai tep") || folded.includes("tai noi dung") ||
          label.includes("upload media") || label.includes("upload file") || label.includes("upload from");
      });
    };

    const menuRoots = () => [...document.querySelectorAll('[role="menu"],mat-menu-panel,[role="dialog"],.cdk-overlay-pane,[data-state="open"]')]
      .filter(mRoot => isVisible(mRoot) && [...mRoot.querySelectorAll('[role="tab"],button,[role="button"],[role="menuitem"],a,[tabindex],mat-icon,.mat-icon,.google-symbols,.material-symbols-outlined')].some(isUploadLabel));

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

    const switchUploadCategoryTab = async roots => {
      const allRoleTabs = roots.flatMap(mRoot => [...mRoot.querySelectorAll('[role="tab"]')]);
      const tabCandidates = allRoleTabs.length > 0 ? allRoleTabs : roots.flatMap(mRoot => [...mRoot.querySelectorAll('button')]);
      const validTabs = [...new Set(tabCandidates)].filter(tab => {
        if (!isVisible(tab) || tab.disabled || tab.getAttribute("aria-disabled") === "true") return false;
        const icon = tab.querySelector("mat-icon,.mat-icon,.google-symbols,.material-symbols-outlined,svg")?.textContent?.trim() || "";
        const label = getAria(tab).replace(/\s+/g, " ").trim().toLowerCase();
        const folded = typeof root.normalizeFlowUiText === "function" ? root.normalizeFlowUiText(label) : label;
        return ["upload", "file_upload", "upload_file", "cloud_upload"].includes(icon) ||
          ["upload", "uploads", "upload file", "tải lên", "nội dung tải lên", "tệp tải lên", "các tệp tải lên", "tải tệp", "tải tệp lên", "tải lên tệp", "tải ảnh lên", "tải hình ảnh lên"].includes(label) ||
          ["upload", "uploads", "tai len", "noi dung tai len", "tep tai len", "cac tep tai len", "tai tep", "tai tep len", "tai len tep"].includes(folded);
      });
      const tab = resolveUniqueUploadTarget(validTabs, "FLOW_UPLOAD_CATEGORY_AMBIGUOUS", "Upload category");
      if (!tab) return false;
      const isSelected = tab.getAttribute("aria-selected") === "true" || tab.getAttribute("data-state") === "active";
      if (!isSelected) {
        if (!clickFlowControl(tab)) throw fn("FLOW_UPLOAD_CATEGORY_CLICK_FAILED", "Flow's Upload category could not be clicked. No file was selected.", true, false);
        await root.FlowUiDeadline?.boundedWait(350, deadline, "switching Flow's upload category");
      }
      return true;
    };

    const findUploadItem = () => {
      const roots = menuRoots();
      const semantic = [...new Set(roots.flatMap(mRoot => [...mRoot.querySelectorAll('button,[role="button"],[role="menuitem"],a,[tabindex]')]))]
        .filter(el => isVisible(el) && !el.disabled && el.getAttribute("aria-disabled") !== "true" && isUploadAction(el));
      const semanticTarget = resolveUniqueUploadTarget(semantic, "FLOW_UPLOAD_MENU_ITEM_AMBIGUOUS", "Upload action");
      if (semanticTarget) return semanticTarget;
      const candidates = new Set();
      for (const mRoot of roots) {
        const textLeaves = [...mRoot.querySelectorAll("*")].filter(el => isVisible(el) && isUploadAction(el));
        for (const leaf of textLeaves) {
          for (let candidate = leaf; candidate && candidate !== mRoot; candidate = candidate.parentElement) {
            if (isVisible(candidate) && !candidate.matches('[role="tab"]') && candidate.getAttribute("aria-selected") === null &&
                (candidate.matches('button,[role="button"],[role="menuitem"],a,[tabindex]') || candidate.getAttribute("tabindex") === "0" || getComputedStyle(candidate).cursor === "pointer")) {
              candidates.add(candidate);
              break;
            }
          }
        }
      }
      return resolveUniqueUploadTarget([...candidates], "FLOW_UPLOAD_MENU_ITEM_AMBIGUOUS", "Upload action");
    };

    const selectionDiagnostics = { filePickerSelectionConfirmed: false, pickerMethod: "unknown", pickerType: "unknown", dropAttempted: false, dropReceiptConfirmed: false,
      confirmationDialogSeen: false, confirmationButtonClicked: false, confirmationDialogUnrecognized: false };

    if (!uploadButton) {
      const controls = uploadControlDiagnostics();
      root.emitFlowProgress?.(command, `Upload trigger unavailable; composer controls: ${JSON.stringify(controls).slice(0, 2200)}`);
      throw fn("FLOW_UPLOAD_CONTROL_MISSING", `Flow's project Upload control is unavailable. No file was selected. Visible composer controls: ${JSON.stringify(controls).slice(0, 2200)}`, true, false);
    } else if (uploadButton.disabled || uploadButton.getAttribute("aria-disabled") === "true") {
      throw fn("FLOW_UPLOAD_CONTROL_DISABLED", "Flow's composer add-menu trigger is disabled. No file was selected.", true, false);
    } else {
      if (!clickFlowControl(uploadButton)) throw fn("FLOW_UPLOAD_CONTROL_CLICK_FAILED", "Flow's project Upload control could not be clicked. No file was selected.", true, false);
      root.emitFlowProgress?.(command, "Opening Flow's scoped Upload menu and arming its file picker");
      const menuDeadline = Math.min(Date.now() + 2500, deadline);
      let uploadItem = null;
      while (Date.now() < menuDeadline && !uploadItem) {
        checkTime("opening Flow's upload menu");
        const activeMenus = menuRoots();
        if (activeMenus.length) {
          await switchUploadCategoryTab(activeMenus);
          checkTime("selecting the upload category");
        }
        uploadItem = findUploadItem();
        if (!uploadItem) await root.FlowUiDeadline?.boundedWait(100, deadline, "waiting for Flow's upload menu", false, options.signal);
      }
      if (!uploadItem) {
        throw fn("FLOW_UPLOAD_MENU_ITEM_MISSING", "Flow's visible Upload menu item did not appear. No file was selected.", true, false);
      } else {
        try {
          const pickerReceipt = await root.FlowNativeFileTransfer.selectFileThroughPicker(file, async () => {
            checkTime("opening Flow's file picker");
            if (!uploadItem?.isConnected || !isVisible(uploadItem)) {
              await switchUploadCategoryTab(menuRoots());
              uploadItem = findUploadItem();
            }
            if (!uploadItem?.isConnected || !isVisible(uploadItem)) return false;
            return clickFlowControl(uploadItem);
          }, { deadline });
          selectionDiagnostics.filePickerSelectionConfirmed = pickerReceipt?.selected === true;
          selectionDiagnostics.pickerMethod = safeFlowPickerMethod(pickerReceipt?.method);
          selectionDiagnostics.pickerType = safeFlowPickerType(pickerReceipt?.type);
          root.emitFlowProgress?.(command, `Flow's scoped Upload picker confirmed ${file.name} via ${pickerReceipt.method || "Flow file input"}`);
        } catch (error) {
          if (error?.outcome_unknown || error?.code === "FLOW_UPLOAD_PICKER_OUTCOME_UNKNOWN") throw error;
          if (error?.code === "FLOW_OPERATION_TIMEOUT") throw error;
          console.warn(`[Flow MCP upload] File-picker trap failed before selection (${String(error?.message || error)}); falling back to drag-and-drop for ${kind} "${file.name}".`);
          selectionDiagnostics.dropAttempted = true;
          const dropReceipt = await root.FlowNativeFileTransfer.dropFileToFlow(file);
          selectionDiagnostics.dropReceiptConfirmed = dropReceipt?.dropped === true || dropReceipt?.accepted === true;
        }
      }
    }
    checkTime("confirming the Flow media upload", true);
    if (kind === "video") Object.assign(selectionDiagnostics, await confirmFlowVideoUploadIfPrompted(deadline, options.signal, selectionDiagnostics));
    const confirmed = await waitForNativeMediaTile(file.name, command, kind, { deadline, signal: options.signal, baselineIds, requireNewOwner: true, selectionDiagnostics });
    return { ...confirmed, uploaded: true, name: file.name, kind };
  }

  /**
   * FlowUploader OOP Service Facade
   */
  class FlowUploader {
    static upload(file, kind, command, options) {
      return uploadStagedMedia(file, kind, command, options);
    }
    static findAddMediaButton() {
      return findAddMediaButton();
    }
    static ensureAddMediaButton(deadline, signal) {
      return ensureAddMediaButton(deadline, signal);
    }
    static matchesTile(tile, assetName) {
      return matchesFlowTile(tile, assetName);
    }
    static flowUploadNameMatches(value, assetName) {
      return flowUploadNameMatches(value, assetName);
    }
    static confirmVideoUpload(deadline, signal, selection) {
      return confirmFlowVideoUploadIfPrompted(deadline, signal, selection);
    }
    static waitForNativeMediaTile(assetName, command, kind, options) {
      return waitForNativeMediaTile(assetName, command, kind, options);
    }
    static inspectUiState() {
      return inspectFlowUploadUiState();
    }
  }

  root.FlowUploader = FlowUploader;
})();
