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

  // Byte size a library tile exposes for its underlying file, when Flow puts
  // one in the DOM. Only plain byte counts in file-size attributes count as
  // evidence; anything else (dimensions, labels) is not comparable.
  function flowUploadTileFileSize(tile) {
    if (!tile) return null;
    const readSize = el => {
      if (!el || typeof el.getAttribute !== "function") return null;
      for (const attribute of ["data-file-size", "data-filesize", "data-size-bytes", "data-byte-size", "data-content-length"]) {
        const raw = el.getAttribute(attribute);
        if (raw === null || raw === undefined) continue;
        const text = String(raw).trim().replace(/,/g, "");
        if (!/^\d+(?:\s*(?:b|bytes))?$/i.test(text)) continue;
        const value = Number(text.replace(/[^0-9]/g, ""));
        if (Number.isSafeInteger(value) && value > 0) return value;
      }
      return null;
    };
    const own = readSize(tile);
    if (own !== null) return own;
    try {
      return readSize(tile.querySelector?.("img,video,flow-image-tile,flow-video-tile,flow-scene-tile"));
    } catch { return null; }
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

  const FLOW_UPLOAD_MENU_ROOT_SELECTOR = [
    '[role="menu"]', '[role="dialog"]', '[role="listbox"]', '[aria-modal="true"]',
    'mat-menu-panel', '.mat-mdc-menu-panel', '.cdk-overlay-pane', '[data-state="open"]',
    'flow-component-picker', '[data-testid*="component-picker"]', '[data-testid*="add-component"]',
    '[class*="component-picker"]',
  ].join(",");

  function visibleFlowUploadMenuRoots(doc = document, isVisible = el => Boolean(el && el.isConnected)) {
    try {
      return [...new Set(doc.querySelectorAll(FLOW_UPLOAD_MENU_ROOT_SELECTOR))].filter(isVisible);
    } catch {
      return [];
    }
  }

  function normalizeFlowUploadActionLabel(value) {
    return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[đĐ]/g, "d")
      .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
  }

  function flowUploadActionMatches(labels, icon = "", role = "", ariaSelected = null) {
    if (String(role || "").toLowerCase() === "tab" || ariaSelected !== null) return false;
    if (["upload", "file_upload", "upload_file", "cloud_upload", "drive_folder_upload"].includes(String(icon || "").trim().toLowerCase())) return true;
    const exactLabels = new Set([
      "upload", "upload media", "upload file", "upload files", "upload image", "upload images",
      "upload from computer", "upload from device", "upload from this device", "upload media from computer",
      "upload media from device", "upload image from computer", "upload image from device", "browse files",
      "browse images", "choose file", "choose files", "choose image", "choose images", "select file",
      "select files", "select image", "select images", "add file from computer", "add image from computer",
      "tai len", "tai anh", "tai anh len", "tai hinh anh", "tai hinh anh len", "tai tep", "tai tep len",
      "tai noi dung len", "tai noi dung nghe nhin len", "tai phuong tien len", "tai phuong tien",
      "tai len tu may tinh", "tai len tu thiet bi", "tai tu may tinh", "tai tu thiet bi",
      "chon tep", "chon tep de tai len", "chon anh", "chon anh de tai len", "chon hinh anh",
      "chon hinh anh de tai len",
    ]);
    return (Array.isArray(labels) ? labels : [labels]).some(raw => {
      const label = normalizeFlowUploadActionLabel(raw);
      if (!label) return false;
      if (exactLabels.has(label)) return true;
      return /^(?:upload|browse|choose|select|add) (?:media|files?|images?) (?:from|on) (?:this )?(?:computer|device)$/.test(label) ||
        /^(?:upload|browse|choose|select) (?:a )?(?:file|files|image|images) (?:to upload|for upload)$/.test(label) ||
        /^(?:tai|tai len) (?:anh|hinh anh|tep|noi dung|phuong tien) (?:len )?tu (?:may tinh|thiet bi)$/.test(label) ||
        /^(?:tai|tai len) (?:anh|hinh anh|tep|noi dung|phuong tien)(?: len)?$/.test(label) ||
        /^chon (?:tep|anh|hinh anh)(?: de tai len| tai len)?$/.test(label);
    });
  }

  function flowUploadCategoryTabMatches({ label = "", icon = "", role = "", ariaSelected = null, tagName = "" } = {}) {
    const explicitTab = String(role || "").toLowerCase() === "tab" || ariaSelected !== null ||
      /^(?:mat-tab|mat-tab-header)$/.test(String(tagName || "").toLowerCase());
    if (!explicitTab) return false;
    const folded = normalizeFlowUploadActionLabel(label);
    return ["upload", "uploads", "upload files", "upload media", "tai len", "tep tai len", "noi dung tai len", "cac tep tai len"].includes(folded);
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
    const confirmationConfig = root.flowGetConfig?.("video_upload_confirm") || root.FlowSelectors?.video_upload_confirm || {};
    const configuredConfirmationLabels = [
      ...(Array.isArray(confirmationConfig.textMatch) ? confirmationConfig.textMatch : confirmationConfig.textMatch ? [confirmationConfig.textMatch] : []),
      ...(Array.isArray(confirmationConfig.text_match) ? confirmationConfig.text_match : confirmationConfig.text_match ? [confirmationConfig.text_match] : []),
    ];
    const confirmationLabels = [
      ...configuredConfirmationLabels,
      "upload", "continue", "confirm", "agree", "accept", "next", "done", "ok", "got it",
      "upload video", "upload file", "upload media", "continue upload", "agree and continue",
      "tải lên", "tiếp tục", "xác nhận", "đồng ý", "chấp nhận", "tải video", "tải video lên", "tiếp tục tải lên",
      "đồng ý và tiếp tục", "xác nhận và tiếp tục", "tải lên và tiếp tục",
    ].map(normalizeFlowUploadActionLabel).filter(Boolean);
    const confirmationSelectors = [...new Set([
      ...(Array.isArray(confirmationConfig.selectors) ? confirmationConfig.selectors : []),
      "button", "[role=button]",
    ])];
    const confirmationControls = scope => {
      try {
        const selector = confirmationSelectors.join(",");
        let controls = scope.querySelectorAll ? [...scope.querySelectorAll(selector)] : [];
        if (!controls.length && confirmationSelectors.length > 1) {
          const selectorWithSpace = confirmationSelectors.join(", ");
          controls = scope.querySelectorAll ? [...scope.querySelectorAll(selectorWithSpace)] : [];
        }
        if (typeof scope.matches === "function" && scope.matches(selector) && !controls.includes(scope)) {
          controls.unshift(scope);
        }
        return controls;
      } catch {
        const controls = [];
        for (const selector of confirmationSelectors) {
          try {
            for (const element of scope.querySelectorAll(selector)) if (!controls.includes(element)) controls.push(element);
            if (scope.matches?.(selector) && !controls.includes(scope)) controls.unshift(scope);
          } catch {}
        }
        return controls;
      }
    };
    const isConfirmationControl = element => {
      if (!isVisible(element) || element.disabled || element.getAttribute?.("aria-disabled") === "true") return false;
      const rawText = String(getAria(element) || element.innerText || element.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      const text = normalizeFlowUploadActionLabel(rawText);
      // Confirmation labels are actions with high impact. Match complete
      // accessible labels from the locale profile (or the small action
      // grammar below) so a destructive negative option such as "Do not
      // upload" cannot match the generic word "upload" by substring.
      return confirmationLabels.some(label => text === label || rawText === label) ||
        /^(?:upload|continue|confirm|agree|accept|next|done|ok|got it|tai len|tiep tuc|xac nhan|dong y|chap nhan|tai video)(?:\s+(?:va\s+|and\s+)?(?:tiep tuc|upload|tai len|video|file|media))?$/i.test(text) ||
        /^(?:upload|continue|confirm|agree|accept|next|done|ok|got it|tải lên|tiếp tục|xác nhận|đồng ý|chấp nhận|tải video)(?:\s+(?:và\s+|and\s+)?(?:tiếp tục|upload|tải lên|video|file|media))?$/i.test(rawText);
    };
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
    const waitHelper = async (ms, op) => {
      if (root.FlowUiDeadline?.boundedWait) {
        return root.FlowUiDeadline.boundedWait(ms, deadline, op, true, signal);
      }
      if (typeof root.wait === "function") {
        return root.wait(ms);
      }
    };
    for (let attempt = 0; attempt < 24; attempt++) {
      if (Date.now() >= deadline) throw fn("FLOW_OPERATION_TIMEOUT", "Timed out while confirming Flow's video upload. Inspect Flow before retrying.", false, true);
      const matchingDialogs = [...document.querySelectorAll('[role="dialog"],mat-dialog-container')].filter(el => {
        if (!isVisible(el)) return false;
        const text = String(el.innerText || el.textContent || "").slice(0, 1200);
        const configuredDialogRegex = confirmationConfig.dialogTextRegex || confirmationConfig.dialog_text_regex;
        let configuredDialogMatch = false;
        if (configuredDialogRegex) {
          try {
            const regex = configuredDialogRegex instanceof RegExp ? configuredDialogRegex : new RegExp(String(configuredDialogRegex), "i");
            configuredDialogMatch = root.matchesFlowUiRegex?.(text, regex) ?? regex.test(text);
          } catch {}
        }
        return configuredDialogMatch || /video|upload|tải lên|tải video|tải tệp/i.test(text) ||
          ((selection.filePickerSelectionConfirmed === true || selection.dropReceiptConfirmed === true) && confirmationControls(el).some(isConfirmationControl));
      });
      const specificDialogs = matchingDialogs.filter(dialog =>
        !matchingDialogs.some(other => other !== dialog && dialog.contains?.(other)));
      if (!specificDialogs.length) {
        await waitHelper(300, "waiting for Flow's video upload confirmation");
        continue;
      }
      result.confirmationDialogSeen = true;
      if (specificDialogs.length !== 1) ambiguous("multiple visible dialogs", specificDialogs.length, 0);
      const dialog = specificDialogs[0];
      const confirms = confirmationControls(dialog).filter(isConfirmationControl);
      if (confirms.length > 1) ambiguous("multiple enabled confirmation controls", 1, confirms.length);
      const confirm = confirms[0];
      if (confirm) { confirm.click(); result.confirmationButtonClicked = true; await waitHelper(250, "confirming Flow's video upload"); return result; }
      await waitHelper(300, "waiting for Flow's video upload confirmation");
    }
    // Flow does not show a consent dialog for every account or upload route.
    // Toby treats that as the normal path and verifies the new tile afterward.
    // Only fail closed when a relevant dialog was actually observed but its
    // confirmation control could not be identified.
    if (!result.confirmationDialogSeen) return result;
    result.confirmationDialogUnrecognized = true;
    const error = fn("FLOW_UPLOAD_CONFIRMATION_UNRECOGNIZED", "Flow displayed a video upload confirmation dialog, but no recognized Upload, Continue, or Confirm control appeared. No further upload actions were started; inspect Flow before retrying.", false, true);
    error.diagnostics = {
      ...result,
      filePickerSelectionConfirmed: selection.filePickerSelectionConfirmed === true,
      pickerMethod: safeFlowPickerMethod(selection.pickerMethod),
      pickerType: safeFlowPickerType(selection.pickerType),
      dropAttempted: selection.dropAttempted === true,
      dropReceiptConfirmed: selection.dropReceiptConfirmed === true,
      configuredSelectorCount: confirmationSelectors.length,
      configuredTextMatchCount: Array.isArray(configuredConfirmationLabels) ? configuredConfirmationLabels.length : Number(Boolean(configuredConfirmationLabels)),
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
    const expectedId = options.expectedId ? String(options.expectedId) : null;
    let ownerId = options.ownerId ? String(options.ownerId) : null;
    let retryAttempted = false;
    let tabActivationAttempted = false;
    let exactTileObserved = false;
    let lastScan = null;
    let lastScanErrorCode = null;
    const getMediaId = root.mediaId || (el => el.getAttribute("data-media-id") || el.getAttribute("id") || "");

    while (Date.now() < deadline) {
      const exactNameMatches = [...document.querySelectorAll("flow-grid-tile-container")]
        .filter(item => matchesFlowTile(item, assetName));
      if (exactNameMatches.length) exactTileObserved = true;
      const exactMatches = expectedId && !requireNewOwner
        ? exactNameMatches.filter(item => String(getMediaId(item)) === expectedId)
        : exactNameMatches;
      if (exactMatches.length > 1 && !requireNewOwner) {
        throw fn("FLOW_UPLOAD_TILE_AMBIGUOUS", `More than one Flow tile exactly matches uploaded ${kind} "${assetName}". Inspect the library before retrying.`, false, true);
      }
      const newExactMatches = requireNewOwner ? exactMatches.filter(item => {
        const identity = getMediaId(item);
        return identity && !String(identity).startsWith("title:") && !baselineIds.has(String(identity));
      }) : exactMatches;
      if (newExactMatches.length > 1) {
        throw fn("FLOW_UPLOAD_TILE_AMBIGUOUS", `More than one new Flow tile exactly matches uploaded ${kind} "${assetName}". Inspect the library before retrying.`, false, true);
      }
      const tile = newExactMatches[0] || null;
      if (tile) {
        if (tile.querySelector("flow-error-tile")) {
          if (!retryAttempted && options.retryOnError !== false && root.FlowTiles?.retryNativeErrorTile) {
            retryAttempted = true;
            try {
              await root.FlowTiles.retryNativeErrorTile({ id: getMediaId(tile), title: assetName, kind, element: tile }, {
                deadline,
                timeoutMs: Math.min(8_000, Math.max(1_000, deadline - Date.now())),
                signal: options.signal,
              });
              continue;
            } catch (retryError) {
              if (retryError?.code === "FLOW_OPERATION_CANCELLED") throw retryError;
            }
          }
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
      if (!tabActivationAttempted && document.visibilityState === "hidden" && Date.now() - startedAt > 5000) {
        tabActivationAttempted = true;
        try {
          const activated = await chrome.runtime.sendMessage({ type: "flow-mcp:ensure-active-tab" });
          if (activated?.ok) await root.FlowUiDeadline?.boundedWait(300, deadline, "activating the Flow tab for upload confirmation", true, options.signal);
        } catch (activationError) {
          lastScanErrorCode = activationError?.code || "TAB_ACTIVATION_FAILED";
        }
      }
      if (libraryScans < maxLibraryScans && Date.now() >= nextLibraryScanAt && root.FlowMediaMenu?.scanNativeAssets) {
        libraryScans++;
        nextLibraryScanAt = Date.now() + 2_000;
        try {
          const assets = await root.FlowMediaMenu.scanNativeAssets({
            deadline: Math.min(deadline, Date.now() + 8_000),
            maxDurationMs: 8_000,
            ...(expectedId ? {} : { exactName: assetName }),
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
          const exactAssets = assets.filter(asset => asset?.id && (expectedId
            ? String(asset.id) === expectedId && flowUploadNameMatches(asset?.name, assetName)
            : flowUploadNameMatches(asset?.name, assetName)));
          const confirmedAssets = requireNewOwner
            ? exactAssets.filter(asset => asset?.newSinceBaseline === true && !baselineIds.has(String(asset.id)))
            : exactAssets;
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

    const scroller = root.FlowTiles?.flowMediaGridScrollContainer?.() || root.flowMediaGridScrollContainer?.() || null;
    if (scroller && scroller.scrollTop > 5) {
      scroller.scrollTop = 0;
      await root.FlowUiDeadline?.boundedWait(150, deadline, "scrolling to the Flow composer", false, options.signal);
    }

    const existingTiles = [...document.querySelectorAll("flow-grid-tile-container")].filter(item => matchesFlowTile(item, file.name));
    // A matching name alone does not prove a tile is the staged file: camera
    // exports and repeated downloads routinely collide on names like
    // IMG_1234.png, and reusing the wrong tile silently generates from the
    // wrong reference. When the staged size is known (production staged
    // files are real Files), a tile is reuse-eligible only when it exposes
    // the same byte size; a proven mismatch — or no comparable evidence at
    // all — means "upload instead" (a duplicate tile is recoverable, a
    // wrong reference is not). Callers whose file carries no size keep the
    // legacy name-only behavior.
    const stagedSize = Number.isSafeInteger(file?.size) && file.size >= 0 ? file.size : null;
    const namedTileDetails = existingTiles.map(tile => {
      const id = typeof root.mediaId === "function" ? root.mediaId(tile) : "";
      const actualKind = flowUploadTileKind(tile);
      const ready = root.FlowTiles?.isTileMediaReady?.(tile) ?? !root.isTileBusy?.(tile);
      const tileSize = flowUploadTileFileSize(tile);
      const sizeVerdict = stagedSize === null ? "legacy"
        : tileSize === null ? "unverifiable"
          : tileSize === stagedSize ? "match" : "mismatch";
      return { tile, id: id && !String(id).startsWith("title:") ? String(id) : null, actualKind, ready, tileSize, sizeVerdict,
        reuseEligible: sizeVerdict === "legacy" || sizeVerdict === "match",
        error: Boolean(tile.querySelector("flow-error-tile")) };
    }).filter(Boolean);
    const eligibleDetails = namedTileDetails.filter(item => item.reuseEligible);
    const eligibleTiles = eligibleDetails.map(item => item.tile);
    const excludedTiles = namedTileDetails.length - eligibleDetails.length;
    if (excludedTiles > 0) {
      root.emitFlowProgress?.(command, `Ignored ${excludedTiles} same-name Flow tile(s) for "${file.name}" whose size does not match the staged file; uploading instead of reusing.`);
    }
    const matchingKindTiles = eligibleDetails.filter(item => !item.error && (!item.actualKind || flowUploadKindMatches(kind, item.actualKind)));
    const reusableTiles = matchingKindTiles.filter(item => item.id);
    if (reusableTiles.length) {
      // Use the first exact-title, matching-kind asset in Flow's current grid order and carry its UUID into the picker selection.
      const chosen = reusableTiles.find(item => item.actualKind && item.ready) || reusableTiles[0];
      if (chosen.actualKind && chosen.ready) {
        root.emitFlowProgress?.(command, `Reusing existing Flow ${kind} media ID ${chosen.id} for "${file.name}"; skipped upload.`);
        return { uploaded: true, name: file.name, kind, id: chosen.id, reused: true };
      }
      const confirmed = await waitForNativeMediaTile(file.name, command, kind, { deadline, signal: options.signal, expectedId: chosen.id });
      root.emitFlowProgress?.(command, `Reusing existing Flow ${kind} media ID ${confirmed.id} for "${file.name}" after readiness confirmation; skipped upload.`);
      return { ...confirmed, uploaded: true, name: file.name, kind, reused: true };
    }
    // The name-only branches below confirm by title alone, so they may run
    // only when every same-name tile is reuse-eligible. If any tile was
    // excluded on size evidence, fall through to a fresh upload instead: the
    // baseline + requireNewOwner confirmation further down accepts only a
    // genuinely new tile, never one of the excluded ones.
    if (eligibleTiles.length && eligibleTiles.length === namedTileDetails.length) {
      if (eligibleTiles.length === 1) {
        if (eligibleTiles[0].querySelector("flow-error-tile")) {
          throw fn("FLOW_UPLOAD_REJECTED", `Flow already has an error tile for "${file.name}". Inspect it before retrying.`, false, true);
        }
        const actualKind = assertReusableFlowUploadKind(eligibleTiles[0], file.name, kind);
        if (actualKind && !flowUploadKindMatches(kind, actualKind)) throw fn("FLOW_UPLOAD_KIND_MISMATCH", `Flow already has a ${actualKind} tile named "${file.name}", not the requested ${kind}. No upload was started.`, false, false);
        const confirmed = await waitForNativeMediaTile(file.name, command, kind, { deadline, signal: options.signal });
        return { uploaded: true, name: file.name, kind, id: confirmed.id, reused: true };
      }
      if (eligibleTiles.length > 1) {
        const knownKinds = eligibleTiles.map(flowUploadTileKind).filter(Boolean);
        if (knownKinds.length === eligibleTiles.length && !knownKinds.some(actualKind => flowUploadKindMatches(kind, actualKind))) {
          throw fn("FLOW_UPLOAD_KIND_MISMATCH", `Flow has tiles named "${file.name}", but none are ${kind} media. No upload was started.`, false, false);
        }
        if (matchingKindTiles.length) {
          throw fn("FLOW_UPLOAD_ID_UNAVAILABLE", `Flow already has media tiles named "${file.name}", but none exposes a stable ID that can be selected safely. No duplicate upload was started.`, true, false);
        }
        if (eligibleDetails.every(item => item.error)) {
          throw fn("FLOW_UPLOAD_REJECTED", `All Flow tiles named "${file.name}" are in an error state. No duplicate upload was started.`, false, true);
        }
        throw fn("FLOW_UPLOAD_ID_UNAVAILABLE", `Flow has multiple tiles named "${file.name}", but their media IDs or types are not sufficient to choose an existing ${kind} asset safely. No duplicate upload was started.`, true, false);
      }
    }

    let baselineAssets;
    try {
      baselineAssets = await root.FlowMediaMenu?.scanNativeAssets?.({
        includeIncomplete: true,
        requireComplete: true,
        maxDurationMs: Math.min(15_000, Math.max(3_000, deadline - Date.now())),
        deadline,
        signal: options.signal,
      });
    } catch (error) {
      throw fn(error?.code || "FLOW_UPLOAD_BASELINE_UNAVAILABLE", error?.message || "Could not capture a complete Flow media baseline. No file was selected; inspect the project before retrying.", error?.retryable ?? true, error?.outcome_unknown ?? false);
    }
    if (!Array.isArray(baselineAssets)) {
      throw fn("FLOW_UPLOAD_BASELINE_UNAVAILABLE", "Could not capture Flow media IDs before upload. No file was selected; inspect the project before retrying.", false, false);
    }
    const baselineIds = [...new Set(baselineAssets.map(asset => asset?.id).filter(Boolean).map(String))];

    const uploadButton = await ensureAddMediaButton(deadline, options.signal);
    const normalize = value => String(value || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
    const isVisible = root.visible || (el => Boolean(el && el.isConnected));
    const getAria = root.accessibleName || (el => el.getAttribute("aria-label") || "");

    const labelOf = el => {
      const labels = [getAria(el), el.getAttribute("aria-label"), el.getAttribute("title"), el.innerText, el.textContent];
      try {
        const clone = el.cloneNode(true);
        clone.querySelectorAll('mat-icon,.mat-icon,.google-symbols,svg,[aria-hidden="true"]').forEach(icon => icon.remove());
        labels.push(clone.innerText || clone.textContent);
      } catch {}
      return labels.map(normalize);
    };

    const iconOf = el => el.querySelector("mat-icon,.mat-icon,.google-symbols,.material-symbols-outlined,svg")?.textContent?.trim() ||
      el.getAttribute("data-icon") || el.getAttribute("aria-hidden-icon") || "";
    const isUploadAction = el => flowUploadActionMatches(labelOf(el), iconOf(el), el.getAttribute("role"), el.getAttribute("aria-selected"));
    const menuRoots = () => visibleFlowUploadMenuRoots(document, isVisible);
    const menuControlSelector = '[role="tab"],button,[role="button"],[role="menuitem"],a,[tabindex],mat-icon,.mat-icon,.google-symbols,.material-symbols-outlined';
    const controlsIn = (scope, selector = menuControlSelector) => {
      const descendants = [...scope.querySelectorAll(selector)];
      if (scope.matches?.(selector)) descendants.unshift(scope);
      return descendants;
    };

    const uploadMenuDiagnostics = () => {
      const roots = menuRoots();
      const controls = [...new Set(roots.flatMap(scope => controlsIn(scope, 'button,[role="button"],[role="menuitem"],a,[tabindex],[role="tab"]')))]
        .filter(el => isVisible(el));
      const summarize = el => ({
        tag: String(el.tagName || "unknown").toLowerCase(),
        role: el.getAttribute("role") || null,
        aria: String(getAria(el) || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 70),
        title: String(el.getAttribute("title") || "").replace(/\s+/g, " ").trim().slice(0, 70),
        text: String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 70),
        icon: iconOf(el).slice(0, 30),
        disabled: Boolean(el.disabled || el.getAttribute("aria-disabled") === "true"),
      });
      return {
        visiblePopupRootCount: roots.length,
        popupRoots: roots.slice(0, 8).map(el => ({ tag: String(el.tagName || "unknown").toLowerCase(), role: el.getAttribute("role") || null,
          className: String(el.className?.baseVal || el.className || "").replace(/\s+/g, " ").trim().slice(0, 90) })),
        visibleControlCount: controls.length,
        uploadActionCandidates: controls.filter(isUploadAction).slice(0, 8).map(summarize),
        controls: controls.slice(0, 12).map(summarize),
      };
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

    const lastUploadTabClickAt = new WeakMap();
    const switchUploadCategoryTab = async roots => {
      const tabs = [...new Set(roots.flatMap(scope => controlsIn(scope, '[role="tab"],[aria-selected],mat-tab,mat-tab-header button')))].filter(tab => {
        if (!isVisible(tab) || tab.disabled || tab.getAttribute("aria-disabled") === "true") return false;
        return flowUploadCategoryTabMatches({ label: labelOf(tab)[0] || "", icon: iconOf(tab), role: tab.getAttribute("role"),
          ariaSelected: tab.getAttribute("aria-selected"), tagName: tab.tagName });
      });
      const validTabs = tabs;
      const tab = resolveUniqueUploadTarget(validTabs, "FLOW_UPLOAD_CATEGORY_AMBIGUOUS", "Upload category");
      if (!tab) return false;
      const isSelected = tab.getAttribute("aria-selected") === "true" || tab.getAttribute("aria-checked") === "true" ||
        tab.getAttribute("data-state") === "active";
      if (!isSelected) {
        const lastClick = lastUploadTabClickAt.get(tab) || 0;
        if (Date.now() - lastClick >= 500) {
          if (!clickFlowControl(tab)) throw fn("FLOW_UPLOAD_CATEGORY_CLICK_FAILED", "Flow's Upload category could not be clicked. No file was selected.", true, false);
          lastUploadTabClickAt.set(tab, Date.now());
          await root.FlowUiDeadline?.boundedWait(250, deadline, "switching Flow's upload category");
        }
      }
      return true;
    };

    const findUploadItem = () => {
      const roots = menuRoots();
      const semantic = [...new Set(roots.flatMap(mRoot => controlsIn(mRoot, 'button,[role="button"],[role="menuitem"],a,[tabindex]')))]
        .filter(el => isVisible(el) && !el.disabled && el.getAttribute("aria-disabled") !== "true" && isUploadAction(el));
      const semanticTarget = resolveUniqueUploadTarget(semantic, "FLOW_UPLOAD_MENU_ITEM_AMBIGUOUS", "Upload action");
      if (semanticTarget) return semanticTarget;
      const candidates = new Set();
      for (const mRoot of roots) {
        const textLeaves = controlsIn(mRoot, "*").filter(el => isVisible(el) && isUploadAction(el));
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
      const menuDeadline = Math.min(Date.now() + 5000, deadline);
      let uploadItem = null;
      while (Date.now() < menuDeadline && !uploadItem) {
        checkTime("opening Flow's upload menu");
        const activeMenus = menuRoots();
        // Prefer Toby's direct upload action when it is present. Only switch a
        // category tab after confirming it has explicit tab semantics; a plain
        // Upload button must never be clicked before the picker trap is armed.
        uploadItem = findUploadItem();
        if (!uploadItem && activeMenus.length) {
          await switchUploadCategoryTab(activeMenus);
          checkTime("selecting the upload category");
          uploadItem = findUploadItem();
        }
        if (!uploadItem) await root.FlowUiDeadline?.boundedWait(100, deadline, "waiting for Flow's upload menu", false, options.signal);
      }
      if (!uploadItem) {
        const diagnostics = uploadMenuDiagnostics();
        root.emitFlowProgress?.(command, `Flow upload action not found after menu scan: ${JSON.stringify(diagnostics).slice(0, 3000)}`);
        const error = fn("FLOW_UPLOAD_MENU_ITEM_MISSING", "Flow did not expose a recognized Upload action after the add-media menu was opened. No file was selected. Inspect popup roots and visible controls in the upload diagnostics.", true, false);
        error.diagnostics = diagnostics;
        throw error;
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
    static findVisibleUploadMenuRoots(doc, isVisible) {
      return visibleFlowUploadMenuRoots(doc, isVisible);
    }
    static matchesUploadAction(labels, icon, role, ariaSelected) {
      return flowUploadActionMatches(labels, icon, role, ariaSelected);
    }
    static matchesUploadCategoryTab(descriptor) {
      return flowUploadCategoryTabMatches(descriptor);
    }
  }

  root.FlowUploader = FlowUploader;
})();
