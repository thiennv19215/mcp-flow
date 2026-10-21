(function (root) {
  "use strict";

  function isFlowProjectNavigationControl(el) {
    if (!el || typeof el.closest !== "function") return false;
    if (el.closest('nav, [role="navigation"], header, [role="banner"], mat-toolbar, aside, mat-sidenav, flow-navigation, [class*="sidebar"], [class*="drawer"], flow-library, [class*="media-gallery"], [class*="media-list"]')) return true;
    for (let parent = el; parent && parent !== document.body; parent = parent.parentElement) {
      const aria = parent.getAttribute?.("aria-label") || "";
      if (/project navigation|điều hướng dự án|thư viện|library|bộ sưu tập|tất cả nội dung|danh sách tệp/i.test(aria)) return true;
    }
    return false;
  }

  function cleanCharacterName(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\b(accessibility_new|person|movie|image|videocam|mic)\b/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  const NAV_SYNONYMS = {
    "characters": ["characters", "nhân vật", "nhan vat"],
    "all media": [
      "all media", "tất cả nội dung nghe nhìn", "tất cả phương tiện", "tất cả media", "thư viện", "tất cả tệp"
    ]
  };

  const ALL_MEDIA_ICONS = ["dashboard", "perm_media", "movie", "video_library", "photo_library", "grid_view", "auto_awesome_motion", "folder", "collections", "video_settings"];

  function flowNavigationItem(label) {
    const normalize = value => cleanCharacterName(String(value || "").replace(/\s+/g, " ").trim()).toLowerCase();
    const navigation = [...document.querySelectorAll('nav,[role="navigation"],mat-sidenav')].find(el =>
      /project navigation|điều hướng dự án|dự án/i.test(root.accessibleName?.(el) || "") ||
      /project navigation|điều hướng dự án|dự án/i.test(el.getAttribute?.("aria-label") || "") ||
      el.querySelector?.('mat-icon')
    ) || document.querySelector('nav,[role="navigation"],mat-sidenav');
    const roots = navigation ? [navigation, document] : [document];
    const candidates = [...new Set(roots.flatMap(r => [...r.querySelectorAll(
      'a,button,[role="button"],[role="menuitem"],mat-list-item,button[mat-list-item],[role="tab"]'
    )]))];
    const wanted = normalize(label);
    const synonyms = (root.I18n?.getPatterns?.(wanted)?.length ? root.I18n.getPatterns(wanted) : NAV_SYNONYMS[wanted]) || [wanted];
    return candidates.find(el => {
      if (!root.visible?.(el) || el.disabled || el.getAttribute?.("aria-disabled") === "true") return false;
      const text = normalize(el.innerText || el.textContent || root.accessibleName?.(el));
      const iconNames = [...(el.querySelectorAll?.("mat-icon") || [])].map(icon => normalize(icon.innerText || icon.textContent));
      // Flow's character controls use either a person or face Material icon,
      // depending on which surface/version is mounted.
      if ((wanted === "characters" || synonyms.includes("nhân vật")) &&
          iconNames.some(icon => ["accessibility_new", "person", "face"].includes(icon))) return true;
      if (wanted === "all media" || synonyms.includes("tất cả nội dung nghe nhìn")) {
        if (/(?:^|\s)(?:video|clip|nhân vật|characters|dự án|project|nội dung tải lên|uploads?)(?:$|\s)/i.test(text)) return false;
        if (iconNames.some(ic => ALL_MEDIA_ICONS.includes(ic))) return true;
      }
      
      // So khớp an toàn: exact match hoặc prefix/suffix có icon ligature
      return synonyms.some(syn => {
        if (text === syn || text.endsWith(` ${syn}`) || text.startsWith(`${syn} `)) return true;
        if (syn.includes(" ") && text.includes(syn)) return true;
        return false;
      });
    });
  }

  function clickFlowNavigation(label) {
    const target = flowNavigationItem(label);
    if (!target) return false;
    target.click();
    return true;
  }

  async function waitForFlowRoute(predicate, timeoutMs = 20000, message = "Route wait timed out.", options = {}) {
    const deadline = Math.min(Date.now() + timeoutMs, Number.isFinite(options.deadline) ? options.deadline : Infinity);
    while (Date.now() < deadline) {
      root.FlowUiDeadline?.requireTime(deadline, message, false, options.signal);
      if (predicate(location.pathname)) return true;
      if (root.FlowUiDeadline?.boundedWait) await root.FlowUiDeadline.boundedWait(100, deadline, message, false, options.signal);
      else await root.wait?.(100);
    }
    throw (root.flowError ? root.flowError("FLOW_NAVIGATION_TIMEOUT", message, true) : new Error(message));
  }

  async function exitFlowMediaViewer() {
    const isMediaViewer = () => {
      return /\/edit(?:\/|$)/i.test(location.pathname) || /\/project\/[^/]+\/edit/i.test(location.pathname);
    };
    if (!isMediaViewer()) return true;

    console.log("[FlowNavigation] Detected open media viewer, executing 3-tier exit...");

    // Tier 1: Back button with arrow_back or "Back" label
    const backButtons = [...document.querySelectorAll('button, [role="button"]')].filter(el => root.visible?.(el));
    const backBtn = backButtons.find(btn => {
      const label = (root.accessibleName?.(btn) || btn.innerText || btn.textContent || "").trim().toLowerCase();
      const hasBackIcon = [...btn.querySelectorAll('mat-icon')].some(icon => /arrow_back|arrow-back|back/i.test((icon.innerText || icon.textContent || "").trim()));
      return hasBackIcon || /^(?:back|go back|quay lại|back button.*)$/i.test(label);
    });

    if (backBtn) {
      const eventInit = { bubbles: true, cancelable: true, view: window, button: 0 };
      try { backBtn.dispatchEvent(new PointerEvent("pointerdown", eventInit)); } catch {}
      try { backBtn.dispatchEvent(new MouseEvent("mousedown", eventInit)); } catch {}
      try { backBtn.dispatchEvent(new PointerEvent("pointerup", eventInit)); } catch {}
      try { backBtn.dispatchEvent(new MouseEvent("mouseup", eventInit)); } catch {}
      try { backBtn.click(); } catch {}
      const left = await waitForFlowRoute(path => !isMediaViewer(), 2000, "").catch(() => false);
      if (left) return true;
    }

    // Tier 2: history.back()
    try {
      if (typeof history !== "undefined" && typeof history.back === "function") {
        history.back();
        const left = await waitForFlowRoute(path => !isMediaViewer(), 2000, "").catch(() => false);
        if (left) return true;
      }
    } catch {}

    // Tier 3: Direct reload to clean project root URL
    const target = root.ProviderRegistry?.describeUrl?.(location.href) || root.FlowDriverRegistry?.describeUrl?.(location.href);
    if (target?.projectId) {
      const rootUrl = `${target.origin}${target.routePrefix}/project/${target.projectId}`;
      console.warn("[FlowNavigation] Tier 1+2 did not exit media viewer; reloading clean project URL:", rootUrl);
      location.assign(rootUrl);
      throw (root.flowError ? root.flowError("FLOW_PROJECT_NAVIGATING", "Navigating back to project root editor. Please retry.", true, false) : new Error("Navigating back to project root editor."));
    }

    return !isMediaViewer();
  }

  async function dismissBlockingOverlays(options = {}) {
    const checkTime = label => root.FlowUiDeadline?.requireTime(Number.isFinite(options.deadline) ? options.deadline : Infinity, label, false, options.signal);
    const pause = async (ms, label) => {
      if (root.FlowUiDeadline?.boundedWait && Number.isFinite(options.deadline)) return root.FlowUiDeadline.boundedWait(ms, options.deadline, label, false, options.signal);
      checkTime(label);
      await root.wait?.(ms);
      checkTime(label);
    };
    let dismissedAny = false;

    const isSettingsDialog = el => {
      if (!el) return false;
      if (el.querySelector?.('button[id*="-trigger-"]')) return true;
      const radios = [...(el.querySelectorAll?.('[role="radio"], mat-radio-button') || [])];
      return radios.some(r => /image|video|9:16|16:9/i.test(root.accessibleName?.(r) || ""));
    };

    const dialogs = [...document.querySelectorAll('[role="dialog"], mat-dialog-container, flow-dialog, [aria-modal="true"]')].filter(el => root.visible?.(el));
    for (const dialog of dialogs) {
      checkTime("checking Flow blocking dialogs");
      if (isSettingsDialog(dialog)) continue;

      const closeBtn = [...dialog.querySelectorAll('button, [role="button"]')].find(btn => {
        if (!root.visible?.(btn)) return false;
        const label = (root.accessibleName?.(btn) || btn.innerText || btn.textContent || "").trim().toLowerCase();
        const hasCloseIcon = [...btn.querySelectorAll('mat-icon')].some(icon => /close|clear/i.test((icon.innerText || icon.textContent || "").trim()));
        return hasCloseIcon || /^(?:close|đóng|dismiss|got it|cancel|hủy)$/i.test(label) || label.includes("close") || label.includes("đóng");
      });

      if (closeBtn) {
        closeBtn.click();
        dismissedAny = true;
        await pause(150, "closing a Flow blocking dialog");
      } else {
        root.dispatchEscapeKey?.();
        dismissedAny = true;
        await pause(150, "closing a Flow blocking dialog");
      }
    }

    const backdrops = [...document.querySelectorAll('.cdk-overlay-backdrop.cdk-overlay-backdrop-showing')].filter(el => root.visible?.(el));
    if (backdrops.length > 0) {
      const activePanels = [...document.querySelectorAll('.cdk-overlay-pane')].filter(el => root.visible?.(el));
      const hasOnlySettings = activePanels.length > 0 && activePanels.every(isSettingsDialog);
      if (!hasOnlySettings) {
        root.dispatchEscapeKey?.();
        dismissedAny = true;
        await pause(150, "closing a Flow overlay");
      }
    }

    return dismissedAny;
  }

  async function leaveFlowDetailView() {
    const target = root.ProviderRegistry?.describeUrl?.(location.href) || root.FlowDriverRegistry?.describeUrl?.(location.href);
    if (target?.projectId && !target.isProjectEditor) {
      if (/\/edit(?:\/|$)/i.test(location.pathname)) {
        await exitFlowMediaViewer();
        return;
      }
      if (/\/character(?:\/|$)/i.test(location.pathname)) {
        const done = [...document.querySelectorAll("button,[role=button]")].find(el => root.visible?.(el) && /^(?:Done( editing)?|Xong|Hoàn tất)$/i.test(root.accessibleName?.(el).trim()));
        if (done) {
          done.click();
          const left = await waitForFlowRoute(path => !/\/character(?:\/|$)/i.test(path), 2000, "").catch(() => false);
          if (left) return;
        }
        const goBack = root.flowButton?.("Go back") || root.flowButton?.("Back") || root.flowButton?.("Quay lại");
        if (goBack) {
          goBack.click();
          const left = await waitForFlowRoute(path => !/\/character(?:\/|$)/i.test(path), 2000, "").catch(() => false);
          if (left) return;
        }
      }

      await ensureFlowProjectEditor();
    }
  }

  async function ensureFlowProjectEditor(options = {}) {
    const waitOptions = { deadline: options.deadline, signal: options.signal };
    const checkTime = label => root.FlowUiDeadline?.requireTime(Number.isFinite(options.deadline) ? options.deadline : Infinity, label, false, options.signal);
    const describe = () => (root.ProviderRegistry?.describeUrl?.(location.href) || root.FlowDriverRegistry?.describeUrl?.(location.href) || null);
    let target = describe();
    checkTime("opening the Flow project editor");

    // 1. In project root editor
    if (target?.isProjectEditor) {
      return { success: true, isProjectEditor: true, projectId: target.projectId };
    }

    // 2. Stuck on sub-routes (/character, /edit, ...)
    if (target?.projectId && !target.isProjectEditor) {
      console.log("[FlowNavigation] Detected sub-route (" + location.pathname + "), recovering to project root editor...");

      const doneOrBack = [...document.querySelectorAll('button, [role="button"]')].find(el => {
        if (!root.visible?.(el)) return false;
        const name = root.accessibleName?.(el).trim();
        return /^(?:Done( editing)?|Xong|Hoàn tất)$/i.test(name) || /^(?:Back( button.*)?|Quay lại|Quay về)$/i.test(name) || /^(Go back|Quay lại)$/i.test(name);
      });
      if (doneOrBack) {
        doneOrBack.click();
        const leftSubRoute = await waitForFlowRoute(() => describe()?.isProjectEditor === true, 2000, "", waitOptions).catch(() => false);
        if (leftSubRoute) return { success: true, isProjectEditor: true, projectId: target.projectId };
      }

      const allMedia = flowNavigationItem("All media");
      if (allMedia) {
        allMedia.click();
        const leftSubRoute = await waitForFlowRoute(() => describe()?.isProjectEditor === true, 2000, "", waitOptions).catch(() => false);
        if (leftSubRoute) return { success: true, isProjectEditor: true, projectId: target.projectId };
      }

      const rootUrl = `${target.origin}${target.routePrefix}/project/${target.projectId}`;
      console.log("[FlowNavigation] Navigating directly to project root URL:", rootUrl);
      location.assign(rootUrl);
      if (describe()?.isProjectEditor) {
        return { success: true, isProjectEditor: true, projectId: target.projectId };
      }
      throw (root.flowError ? root.flowError("FLOW_PROJECT_NAVIGATING", "Navigating back to project root editor. Please retry.", true, false) : new Error("Navigating back to project root editor."));
    }

    // 3. Outside of project
    console.log("[FlowNavigation] Outside of project. Finding New project button or existing project...");
    const navConfig = root.FlowSelectors?.navigation?.newProjectButton;
    const navTextRegex = navConfig?.textRegex || /new project|tạo dự án|dự án mới|create project/i;
    const newProjectBtn = [...document.querySelectorAll('button, a[role="button"]')].find(btn => {
      if (!root.visible?.(btn)) return false;
      const label = (root.accessibleName?.(btn) || btn.innerText || btn.textContent || "").trim().toLowerCase();
      const hasAddIcon = [...btn.querySelectorAll('mat-icon')].some(i => /add|create|new/i.test((i.innerText || i.textContent || "").trim()));
      return (root.matchesFlowUiRegex?.(label, navTextRegex) || navTextRegex.test(label)) ||
        (hasAddIcon && (root.matchesFlowUiRegex?.(label, /project|dự án/i) || /project|dự án/i.test(label)));
    });

    if (newProjectBtn) {
      console.log("[FlowNavigation] Clicking New project button...");
      newProjectBtn.click();
      await waitForFlowRoute(() => describe()?.isProjectEditor === true, 15000, "Flow did not open a new project editor.", waitOptions);
      target = describe();
      return { success: true, isProjectEditor: true, projectId: target?.projectId || null };
    }

    const firstProjectCard = document.querySelector('a[href*="/project/"]');
    if (firstProjectCard && root.visible?.(firstProjectCard)) {
      console.log("[FlowNavigation] Opening first existing project...");
      firstProjectCard.click();
      await waitForFlowRoute(() => describe()?.isProjectEditor === true, 15000, "Flow did not open existing project editor.", waitOptions);
      target = describe();
      return { success: true, isProjectEditor: true, projectId: target?.projectId || null };
    }

    return { success: false, error: "FLOW_PROJECT_REQUIRED" };
  }

  function blurFlowNavigationFocus() {
    const focused = document.activeElement;
    if (focused?.closest?.("mat-sidenav,[role=navigation]")) focused.blur();
  }

  async function ensureFlowLibrarySection(label, options = {}) {
    const checkTime = () => root.FlowUiDeadline?.requireTime(Number.isFinite(options.deadline) ? options.deadline : Infinity, `opening the Flow ${label} library`, false, options.signal);
    checkTime();
    await leaveFlowDetailView();

    const isAtProjectRoot = () => {
      const desc = (root.ProviderRegistry || root.FlowDriverRegistry)?.describeUrl?.(location.href);
      if (desc?.isProjectEditor) return true;
      const notSubRoute = !/\/character|\/edit/i.test(location.pathname);
      const hasComposer = Boolean(document.querySelector('.ProseMirror, flow-base-prompt-box')) ||
        Boolean(root.flowButton?.("Start generation"));
      return notSubRoute && hasComposer;
    };

    // Nếu mục tiêu là "All media" và giao diện đã ở sẵn màn hình Project Editor chính
    if (label === "All media" && isAtProjectRoot()) {
      return true;
    }

    let target = flowNavigationItem(label);
    if (!target && label === "Characters") {
      // The project URL can update before Flow mounts the project sidebar.
      // Wait briefly for its navigation controls before reporting them missing.
      const navDeadline = Math.min(Date.now() + 5000, Number.isFinite(options.deadline) ? options.deadline : Infinity);
      while (!target && Date.now() < navDeadline) {
        checkTime();
        if (root.FlowUiDeadline?.boundedWait) await root.FlowUiDeadline.boundedWait(150, navDeadline, "waiting for Flow's Characters navigation control", false, options.signal);
        else await root.wait?.(150);
        target = flowNavigationItem(label);
      }
    }
    if (!target && label === "All media") {
      // Thử phục hồi về Project Editor nếu bị kẹt ở sub-route
      await ensureFlowProjectEditor(options);
      if (isAtProjectRoot()) return true;
      target = flowNavigationItem(label);
    }

    if (!target) {
      if (label === "All media" && isAtProjectRoot()) return true;
      throw root.flowError("FLOW_NAV_UNAVAILABLE", `Flow's project navigation could not open "${label}" from this view.`, true);
    }

    target.click();
    const deadline = Math.min(Date.now() + (label === "Characters" ? 10000 : 5000), Number.isFinite(options.deadline) ? options.deadline : Infinity);
    const hasCharacterAction = () => [...document.querySelectorAll("flow-custom-tile")].some(tile => {
      if (!root.visible?.(tile)) return false;
      const addIcon = [...tile.querySelectorAll("mat-icon")].some(icon =>
        cleanCharacterName(icon.innerText || icon.textContent || "").toLowerCase() === "add");
      const text = cleanCharacterName(tile.innerText || tile.textContent || "").toLowerCase();
      return addIcon && (/character/.test(text) || /nhân vật/.test(text));
    });
    const hasEmptyCharacterChooser = () => /\/character\/?$/i.test(location.pathname) &&
      (root.flowButton?.("Go back") || root.flowButton?.("Add from project") || root.flowButton?.("Quay lại") || root.flowButton?.("Thêm từ dự án"));
    const hasSectionMarker = () => label === "Characters"
      ? hasCharacterAction() || hasEmptyCharacterChooser()
      : isAtProjectRoot() || [...document.querySelectorAll("flow-grid-tile-container")].some(el => root.visible?.(el));
    while (Date.now() < deadline) {
      checkTime();
      const loading = [...document.querySelectorAll('[role="progressbar"],[aria-busy="true"]')].some(el => root.visible?.(el));
      if (!loading && hasSectionMarker()) break;
      if (root.FlowUiDeadline?.boundedWait) await root.FlowUiDeadline.boundedWait(150, deadline, `opening the Flow ${label} library`, false, options.signal);
      else await root.wait?.(150);
    }
    if (!hasSectionMarker()) {
      if (label === "All media" && isAtProjectRoot()) return true;
      throw root.flowError("FLOW_LIBRARY_LOADING", `Flow's "${label}" library did not become ready after navigation.`, true);
    }
    blurFlowNavigationFocus();
  }

  const FlowNavigation = Object.freeze({
    ensureFlowProjectEditor,
    exitFlowMediaViewer,
    dismissBlockingOverlays,
    leaveFlowDetailView,
    ensureFlowLibrarySection,
    flowNavigationItem,
    clickFlowNavigation,
    waitForFlowRoute,
    isFlowProjectNavigationControl,
  });

  root.FlowNavigation = FlowNavigation;
  root.ensureFlowProjectEditor = ensureFlowProjectEditor;
  root.exitFlowMediaViewer = exitFlowMediaViewer;
  root.dismissBlockingOverlays = dismissBlockingOverlays;
  root.leaveFlowDetailView = leaveFlowDetailView;
  root.ensureFlowLibrarySection = ensureFlowLibrarySection;
  root.waitForFlowRoute = waitForFlowRoute;
  root.isFlowProjectNavigationControl = isFlowProjectNavigationControl;
})(globalThis);
