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
      "all media", "tất cả nội dung nghe nhìn", "tất cả nội dung", "nội dung nghe nhìn", "tất cả phương tiện", "tất cả media", "thư viện", "tất cả tệp"
    ]
  };

  const ALL_MEDIA_ICONS = ["dashboard", "perm_media", "movie", "video_library", "photo_library", "grid_view", "auto_awesome_motion", "folder", "collections", "video_settings"];
  let projectNavigationPending = null;
  // The project this page session was last verified to be operating in.
  // Operations bind to a project when they start; if the tab later leaves
  // that project mid-operation (user navigation, a Flow redirect), recovery
  // must return to THIS project — never to an arbitrary one.
  let lastVerifiedProjectId = null;

  function configuredNavigationItem(label) {
    const key = normalizeNavigationLabel(label) === "all media" ? "allMediaButton" :
      normalizeNavigationLabel(label) === "characters" ? "charactersButton" : null;
    if (!key) return undefined;
    const path = `navigation.${key}`;
    const config = root.flowGetConfig?.(path) || root.FlowSelectors?.navigation?.[key];
    const candidates = (typeof root.flowQueryAll === "function" ? root.flowQueryAll(path, document) : null) || [];
    // Without a live configured selector result there is no backend semantic
    // contract to enforce. Let the existing bounded DOM fallback inspect the
    // mounted sidebar instead of treating the missing adapter as ambiguity.
    if (!config || !candidates.length) return undefined;
    let regex = config?.textRegex instanceof RegExp ? config.textRegex : null;
    if (!regex && config?.textRegex) {
      try { regex = new RegExp(config.textRegex, "i"); } catch {}
    }
    const matches = candidates.filter(el => {
      if (!root.visible?.(el) || el.disabled || el.getAttribute?.("aria-disabled") === "true" || !isFlowProjectNavigationControl(el)) return false;
      const text = root.semanticActionText?.(el) || root.accessibleName?.(el) || el.innerText || el.textContent || "";
      if (regex) return regex.test(String(text).replace(/\s+/g, " ").trim());
      // Audit cluster E: fold BOTH sides with the canonical UI fold, so
      // a decomposed-accent label ("Tất cả...") still matches its
      // synonym. The lookup KEY stays strict-folded (NAV_SYNONYMS keys
      // are literal), and ambiguity still fails closed below.
      const foldNavigationText = value => root.normalizeFlowUiText?.(value) || String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
      const normalized = foldNavigationText(text);
      return (NAV_SYNONYMS[normalizeNavigationLabel(label)] || []).map(foldNavigationText).includes(normalized);
    });
    // Refuse ambiguous sidebars. Toby's route fallback handles a missing All media control.
    return matches.length === 1 ? matches[0] : null;
  }

  function normalizeNavigationLabel(label) {
    return String(label || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function flowNavigationItem(label) {
    const configured = configuredNavigationItem(label);
    if (configured !== undefined) return configured;
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
    const matches = candidates.filter(el => {
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
    return matches.length === 1 ? matches[0] : null;
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

  async function exitFlowMediaViewer(options = {}) {
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
      const left = await waitForFlowRoute(path => !isMediaViewer(), 2000, "", options).catch(() => false);
      if (left) return true;
    }

    // Tier 2: history.back()
    try {
      if (typeof history !== "undefined" && typeof history.back === "function") {
        history.back();
        const left = await waitForFlowRoute(path => !isMediaViewer(), 2000, "", options).catch(() => false);
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

    const visible = el => Boolean(el && root.visible?.(el));
    const normalize = value => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[đĐ]/g, "d").toLowerCase().replace(/\s+/g, " ").trim();
    const dialogSelector = '[role="dialog"],[role="alertdialog"],dialog[open],mat-dialog-container,flow-dialog,[aria-modal="true"]';
    const overlaySelector = [
      dialogSelector,
      '[role="menu"]', '[role="listbox"]', 'mat-menu-panel', '.mat-mdc-menu-panel', 'mat-select-panel',
      '.cdk-overlay-pane',
    ].join(",");
    const visibleOverlayOwners = () => {
      const overlays = [...new Set(document.querySelectorAll(overlaySelector))].filter(visible);
      // Angular Flow surfaces can expose both the CDK pane and the dialog or
      // menu mounted inside it. Inspect only the innermost visible surface so
      // one dialog is not mistaken for several competing blockers.
      return overlays.filter(el => !overlays.some(other => other !== el && el.contains(other)));
    };
    const visibleOverlays = () => visibleOverlayOwners().filter(el => !isSettingsDialog(el));
    const isMediaPicker = el => {
      const text = normalize(`${root.accessibleName?.(el) || ""} ${el.getAttribute?.("aria-label") || ""} ${el.innerText || el.textContent || ""}`);
      const hasAssetSearch = /search assets|tim kiem noi dung|tim kiem tai nguyen/.test(text);
      const hasMediaCategory = /all media|images|uploads|album|anh tren flow|anh tham chieu|tai len|tat ca noi dung/.test(text);
      const explicitPickerTitle = /(?:choose|select|chon)\s*\/\s*(?:upload|tai len)|(?:chon|tai)\s*\/\s*(?:tai len|chon)/.test(text);
      return explicitPickerTitle || (hasAssetSearch && hasMediaCategory) ||
        (/\b(?:album|anh tren flow|tai len)\b/.test(text) && /\b(?:chon|upload|tai len)\b/.test(text));
    };
    const isKnownPopupMenu = el => {
      const role = String(el?.getAttribute?.("role") || "").toLowerCase();
      const marker = `${el?.className?.baseVal || el?.className || ""} ${el?.tagName || ""}`.toLowerCase();
      return role === "menu" || role === "listbox" || /mat-menu-panel|mat-mdc-menu-panel|mat-select-panel/.test(marker);
    };
    const isDialogSurface = el => {
      const marker = `${el?.getAttribute?.("role") || ""} ${el?.tagName || ""} ${el?.getAttribute?.("aria-modal") || ""}`.toLowerCase();
      return /dialog|modal|mat-dialog-container|flow-dialog/.test(marker) || Boolean(el?.querySelector?.('[role="dialog"],mat-dialog-container,flow-dialog,[aria-modal="true"]'));
    };
    const isAgentInstructionDialog = surface => {
      const text = normalize(`${root.accessibleName?.(surface) || ""} ${surface?.getAttribute?.("aria-label") || ""} ${surface?.innerText || surface?.textContent || ""}`);
      // Mirror the reference extension's dedicated Agent-instructions
      // recovery. A generic dialog with a Done button is not enough evidence
      // to dismiss it automatically.
      if (/(?:agent|assistant|tro ly).{0,160}(?:instruction|instructions|welcome|huong dan|chi dan)|(?:instruction|instructions|huong dan).{0,160}(?:agent|assistant|tro ly)/i.test(text)) return true;
      const knownDialogs = root.FlowAgent?.visibleAgentInstructionDialogs?.() || [];
      return knownDialogs.some(dialog => dialog === surface || surface?.contains?.(dialog) || dialog?.contains?.(surface));
    };
    const isRiskyConfirmationDialog = surface => /\b(?:are you sure|confirm(?:ation)?|delete|remove|discard|overwrite|unsaved changes|cancel generation|stop generation|submit|purchase|billing|payment|xoa|huy tao|gui lenh|xac nhan)\b/i
      .test(normalize(`${root.accessibleName?.(surface) || ""} ${surface?.innerText || surface?.textContent || ""}`));
    const isKnownDismissibleSurface = el => isMediaPicker(el) || isKnownPopupMenu(el);
    const clickClose = surface => {
      const closeButton = [...(surface?.querySelectorAll?.('button, [role="button"]') || [])].find(button => {
        if (!visible(button) || button.disabled || button.getAttribute?.("aria-disabled") === "true") return false;
        const label = normalize(`${root.accessibleName?.(button) || ""} ${button.innerText || button.textContent || ""} ${button.getAttribute?.("title") || ""}`);
        const hasCloseIcon = [...(button.querySelectorAll?.('mat-icon,.mat-icon,.google-symbols,.material-symbols-outlined') || [])]
          .some(icon => /close|clear|cancel/.test(normalize(icon.innerText || icon.textContent)));
        return hasCloseIcon || /^(?:close|dismiss|got it|cancel|dong|huy|bo qua)$/.test(label) || /\b(?:close|dong)\b/.test(label);
      });
      if (!closeButton) return false;
      closeButton.click();
      return true;
    };
    const clickExplicitDialogClose = surface => {
      const agentInstructionDialog = isAgentInstructionDialog(surface);
      const controls = [...(surface?.querySelectorAll?.('button, [role="button"]') || [])].filter(button => {
        if (!visible(button) || button.disabled || button.getAttribute?.("aria-disabled") === "true") return false;
        return true;
      });
      const controlLabels = button => [...new Set([
        root.accessibleName?.(button), button.innerText, button.textContent,
        button.getAttribute?.("aria-label"), button.getAttribute?.("title"),
      ].map(normalize).filter(Boolean))];
      const isExplicitCloseLabel = label => {
        const localizedClose = (root.I18n?.getPatterns?.("Close") || []).map(normalize);
        if (localizedClose.includes(label)) return true;
        return /^(?:close|dismiss)(?: this)? (?:dialog|modal|window|popup)$/.test(label) ||
          /^(?:close|dismiss) (?:the )?(?:dialog|modal|window|popup)$/.test(label) ||
          /^(?:dong|dong hop thoai|dong cua so|dong cua so nay|dong cua so dialog|fermer|fermer la fenetre|fermer la boite de dialogue|cerrar|cerrar dialogo|cerrar ventana|schliessen|dialog schliessen|chiudi|chiudi finestra|关闭对话框|닫기)$/.test(label);
      };
      const doneControls = controls.filter(button => {
        const labels = controlLabels(button);
        const donePatterns = (root.I18n?.getPatterns?.("Done") || []).map(normalize);
        return labels.some(label => /^(?:done|xong|hoan tat)$/.test(label) || donePatterns.includes(label));
      });
      // The reference Flow extension closes this exact dialog through its
      // dedicated Done action. Prefer it over a generic X/Close control when
      // both are present, and never treat another dialog's Done as safe.
      if (agentInstructionDialog) {
        let configuredDone = null;
        try { configuredDone = root.flowFindSemantic?.("agent_instruction_done", surface) || null; } catch {}
        const candidates = new Set(doneControls);
        if (configuredDone && controls.includes(configuredDone)) candidates.add(configuredDone);
        if (candidates.size !== 1) return false;
        return [...candidates][0];
      }
      const closeIcons = controls.filter(button => {
        const labels = controlLabels(button);
        const iconLabels = [...(button.querySelectorAll?.('mat-icon,.mat-icon,.google-symbols,.material-symbols-outlined,[aria-label],[data-icon]') || [])]
          .flatMap(icon => [icon.innerText, icon.textContent, icon.getAttribute?.("aria-label"), icon.getAttribute?.("data-icon")])
          .map(normalize).filter(Boolean);
        return labels.some(isExplicitCloseLabel) ||
          iconLabels.some(label => /^(?:close|clear|close_fullscreen)$/.test(label));
      });
      if (closeIcons.length === 1) return closeIcons[0];
      if (closeIcons.length > 1) return false;

      // A confirmation dialog may be dismissed only through an explicit
      // cancel-style action. Never choose its positive or ambiguous action.
      if (isRiskyConfirmationDialog(surface)) {
        const cancelControls = controls.filter(button => controlLabels(button).some(label =>
          /^(?:cancel|not now|later|huy|de sau|khong phai luc nay)$/.test(label)));
        return cancelControls.length === 1 ? cancelControls[0] : false;
      }

      const safeActions = controls.filter(button => controlLabels(button).some(label =>
        /^(?:got it|okay|ok|understood|not now|later|done|xong|hoan tat|dong|bo qua)$/.test(label)));
      if (safeActions.length !== 1) return false;
      const labels = controlLabels(safeActions[0]);
      const isDedicatedDismiss = labels.some(label => /^(?:got it|okay|ok|understood|not now|later|dong|bo qua)$/.test(label));
      // "Done" can submit or save a form. Only treat it as a dismiss action
      // when it is the dialog's sole enabled control.
      if (!isDedicatedDismiss && controls.length !== 1) return false;
      return safeActions[0];
    };
    const waitForDialogToClose = async (surface, button) => {
      const owner = button?.closest?.(dialogSelector) || surface;
      const deadline = Math.min(Number.isFinite(options.deadline) ? options.deadline : Date.now() + 2_000, Date.now() + 2_000);
      while (Date.now() < deadline) {
        if (!owner?.isConnected || !visible(owner)) return true;
        await pause(100, "confirming the Flow dialog closed");
      }
      return !owner?.isConnected || !visible(owner);
    };
    const clickExplicitNonDialogClose = surface => {
      if (!surface || isDialogSurface(surface) || isRiskyConfirmationDialog(surface)) return null;
      const localizedClose = [
        ...(root.I18n?.getPatterns?.("Close") || []),
        ...(root.I18n?.getPatterns?.("Dismiss") || []),
      ].map(normalize);
      const controls = [...(surface.querySelectorAll?.('button,[role="button"]') || [])].filter(button =>
        visible(button) && button.disabled !== true && !button.hasAttribute?.("disabled") && button.getAttribute?.("aria-disabled") !== "true");
      const labelsFor = button => [
        root.accessibleName?.(button), button.innerText, button.textContent,
        button.getAttribute?.("aria-label"), button.getAttribute?.("title"),
      ].map(normalize).filter(Boolean);
      const candidates = controls.filter(button => {
        const labels = labelsFor(button);
        const explicitlyNamedClose = labels.some(label => label === "close" || label === "dismiss" || localizedClose.includes(label));
        const recognizedCloseIcon = [button, ...(button.querySelectorAll?.('mat-icon,.mat-icon,.google-symbols,.material-symbols-outlined,[aria-label],[data-icon]') || [])]
          .flatMap(icon => [icon.innerText, icon.textContent, icon.getAttribute?.("aria-label"), icon.getAttribute?.("data-icon")])
          .map(normalize).some(label => /^(?:close|close_fullscreen)$/.test(label));
        return explicitlyNamedClose || recognizedCloseIcon;
      });
      return candidates.length === 1 ? candidates[0] : null;
    };
    const waitForNonDialogOwnerToClose = async surface => {
      const owner = surface?.closest?.(".cdk-overlay-pane") || surface;
      const deadline = Math.min(Number.isFinite(options.deadline) ? options.deadline : Date.now() + 2_000, Date.now() + 2_000);
      while (Date.now() < deadline) {
        if (!owner?.isConnected || !visible(owner)) return true;
        try { await pause(100, "confirming the Flow popup closed"); }
        catch { return false; }
      }
      return !owner?.isConnected || !visible(owner);
    };
    const snapshot = () => {
      const overlayOwners = visibleOverlayOwners();
      const overlays = visibleOverlays();
      const settingsOwners = overlayOwners.filter(isSettingsDialog);
      const referencePicker = (() => {
        try { return root.FlowReferenceActions?.inspectDiagnostics?.() || null; } catch { return null; }
      })();
      const backdrops = [...document.querySelectorAll('.cdk-overlay-backdrop.cdk-overlay-backdrop-showing')].filter(visible);
      const backdropOpen = backdrops.length > 0;
      const settingsOwnsOnlyOverlay = !referencePicker?.pickerOpen && overlayOwners.length === 1 && settingsOwners.length === 1 && overlays.length === 0 &&
        (!backdropOpen || backdrops.length === 1);
      return {
        overlays,
        overlayOwnerCount: overlayOwners.length,
        referencePickerOpen: referencePicker?.pickerOpen === true,
        mediaPickerOpen: overlays.some(isMediaPicker),
        backdropOpen,
        blockingBackdrop: backdropOpen && !settingsOwnsOnlyOverlay,
        settingsOpen: settingsOwners.length > 0,
      };
    };
    const waitForOverlayTransition = async surface => {
      // Flow can keep an overlay node mounted while its exit animation runs,
      // or replace a generic shell with its real dialog after preflight. Give
      // that DOM transition a bounded window before classifying it as
      // an unknown blocker; otherwise a just-finished job can spuriously fail
      // the next queued operation during teardown.
      const deadline = Math.min(Number.isFinite(options.deadline) ? options.deadline : Date.now() + 2_000, Date.now() + 2_000);
      while (Date.now() < deadline) {
        await pause(100, "waiting for the Flow overlay to settle");
        const current = snapshot();
        const hasBlockingPopup = current.referencePickerOpen || current.overlays.length > 0 || current.blockingBackdrop;
        if (!hasBlockingPopup) return true;
        const currentSurface = current.overlays.find(el => !isSettingsDialog(el));
        if (currentSurface !== surface) return true;
      }
      return false;
    };
    const publicSnapshot = state => ({
      dialogCount: state.overlays.filter(el => /dialog|modal/i.test(`${el.getAttribute?.("role") || ""} ${el.tagName || ""}`)).length,
      menuCount: state.overlays.filter(el => /menu|listbox|select|pane/i.test(`${el.getAttribute?.("role") || ""} ${el.className?.baseVal || el.className || ""} ${el.tagName || ""}`)).length,
      referencePickerOpen: state.referencePickerOpen,
      mediaPickerOpen: state.mediaPickerOpen,
      backdropOpen: state.backdropOpen,
      blockingBackdrop: state.blockingBackdrop,
      settingsOpen: state.settingsOpen,
    });

    for (let attempt = 0; attempt < 8; attempt++) {
      checkTime("checking Flow popups before the next operation");
      const state = snapshot();
      const hasBlockingPopup = state.referencePickerOpen || state.overlays.length > 0 || state.blockingBackdrop;
      if (!hasBlockingPopup) return dismissedAny;

      if (state.referencePickerOpen && typeof root.FlowReferenceActions?.closePicker === "function") {
        await root.FlowReferenceActions.closePicker({ deadline: options.deadline, signal: options.signal });
        dismissedAny = true;
        await pause(100, "closing the Flow media reference picker");
        continue;
      }

      const surface = state.overlays.find(el => !isSettingsDialog(el));
      if (!surface && state.blockingBackdrop) {
        // A popup can briefly expose its backdrop before its surface mounts.
        // Escape only cancels the topmost transient layer; then re-scan.
        root.dispatchEscapeKey?.();
        dismissedAny = true;
        await pause(150, "closing a Flow popup backdrop");
        continue;
      }
      const isDialog = surface && isDialogSurface(surface);
      let explicitDialogButton = isDialog ? clickExplicitDialogClose(surface) : null;
      if (surface && !isKnownDismissibleSurface(surface) && !explicitDialogButton) {
        if (await waitForOverlayTransition(surface)) continue;
        // Some Flow dialogs mount their accessible action after the dialog
        // shell. Re-check the same surface once after the bounded settle wait.
        if (isDialogSurface(surface)) {
          explicitDialogButton = clickExplicitDialogClose(surface);
        }
        if (!explicitDialogButton) {
          if (!isDialogSurface(surface)) {
            const closeButton = clickExplicitNonDialogClose(surface);
            if (closeButton) {
              try {
                closeButton.click();
                if (await waitForNonDialogOwnerToClose(surface)) {
                  dismissedAny = true;
                  await pause(100, "finishing Flow popup dismissal");
                  continue;
                }
              } catch { /* Keep the unknown-surface blocker if safe dismissal is not confirmed. */ }
            }
            // If this is another popup type, Escape dismisses the topmost
            // layer without selecting a menu item. Verify it before continuing.
            root.dispatchEscapeKey?.();
            if (await waitForNonDialogOwnerToClose(surface)) {
              dismissedAny = true;
              await pause(100, "finishing Flow notification dismissal");
              continue;
            }
          } else {
            // Escape cancels rather than accepts a modal action. This covers
            // notice/alert variants whose close control is absent or unlabeled.
            root.dispatchEscapeKey?.();
            if (await waitForDialogToClose(surface, null)) {
              dismissedAny = true;
              await pause(100, "finishing Flow notification dismissal");
              continue;
            }
          }
          const message = isDialogSurface(surface)
            ? "Flow left a dialog open without one unique safe Close or acknowledgement control. The queue paused to protect later tasks; resolve the dialog and resume the queue to retry this task first."
            : "Flow left an unidentified overlay open. The queue paused to protect later tasks; inspect and dismiss the overlay, then resume the queue to retry this task first.";
          const error = root.flowError
            ? root.flowError("FLOW_UNKNOWN_OVERLAY_BLOCKING", message, false, false)
            : new Error(message);
          error.diagnostics = { ...publicSnapshot(state), blockingSurface: {
            role: surface.getAttribute?.("role") || null,
            tagName: surface.tagName || null,
            label: normalize(root.accessibleName?.(surface) || surface.getAttribute?.("aria-label") || "").slice(0, 160),
            dismissControlCount: [...(surface.querySelectorAll?.('button,[role="button"]') || [])].filter(button => {
              if (!visible(button) || button.disabled || button.getAttribute?.("aria-disabled") === "true") return false;
              const label = normalize(`${root.accessibleName?.(button) || ""} ${button.innerText || button.textContent || ""} ${button.getAttribute?.("aria-label") || ""} ${button.getAttribute?.("title") || ""}`);
              const closeIcon = [...(button.querySelectorAll?.('mat-icon,.mat-icon,.google-symbols,.material-symbols-outlined') || [])]
                .some(icon => /^(?:close|clear)$/.test(normalize(icon.innerText || icon.textContent)));
              return closeIcon || /^(?:got it|dong)$/.test(label) || /\b(?:close|dismiss)\b/.test(label);
            }).length,
          } };
          throw error;
        }
      }

      if (surface && explicitDialogButton) {
        explicitDialogButton.click();
        dismissedAny = true;
        if (!await waitForDialogToClose(surface, explicitDialogButton)) {
          const error = root.flowError
            ? root.flowError("FLOW_DIALOG_DISMISS_UNCONFIRMED", "Flow did not confirm that its dialog closed. The queue paused to protect later tasks; resolve the dialog and resume the queue to retry this task first.", false, false)
            : new Error("Flow did not confirm that its dialog closed.");
          error.diagnostics = { ...publicSnapshot(state), blockingSurface: {
            role: surface.getAttribute?.("role") || null,
            tagName: surface.tagName || null,
            label: normalize(root.accessibleName?.(surface) || surface.getAttribute?.("aria-label") || "").slice(0, 160),
          } };
          throw error;
        }
        await pause(100, "finishing Flow dialog dismissal");
        continue;
      }

      if (surface && (isKnownDismissibleSurface(surface) ? clickClose(surface) : true)) {
        dismissedAny = true;
        await pause(150, state.mediaPickerOpen || isMediaPicker(surface) ? "closing the Flow media picker" : "closing a Flow dialog or popup");
        continue;
      }

      // Escape is safe for a positively identified picker/menu even when the
      // non-modal generation settings panel is also open: Flow closes the
      // topmost popup first. A backdrop by itself remains ambiguous.
      if (!surface || !isKnownDismissibleSurface(surface)) {
        const message = "A Flow overlay is visible but its type could not be identified or dismissed safely. The queue paused to protect later tasks; inspect and dismiss it, then resume the queue.";
        const error = root.flowError
          ? root.flowError("FLOW_UNKNOWN_OVERLAY_BLOCKING", message, false, false)
          : new Error(message);
        error.diagnostics = publicSnapshot(state);
        throw error;
      }
      root.dispatchEscapeKey?.();
      dismissedAny = true;
      await pause(150, "closing a Flow popup with Escape");
    }

    const remaining = snapshot();
    if (remaining.referencePickerOpen || remaining.overlays.length || remaining.blockingBackdrop) {
      const error = root.flowError
        ? root.flowError("FLOW_BLOCKING_OVERLAY_UNRESOLVED", "A Flow media/library popup is still open after cleanup. The next operation was stopped before it could change the composer or submit generation.", true, false)
        : new Error("A Flow popup is still open after cleanup; the next operation was not started.");
      error.diagnostics = publicSnapshot(remaining);
      throw error;
    }
    return dismissedAny;
  }

  async function prepareFlowOperation(options = {}) {
    // Popup cleanup must still get a short bounded window if the command that
    // opened the picker was cancelled or timed out; otherwise an aborted
    // signal can strand the very overlay this preflight is meant to remove.
    const now = Date.now();
    const requestedDeadline = Number.isFinite(options.deadline) ? options.deadline : now + 6_000;
    const cleanupDeadline = Math.min(Math.max(requestedDeadline, now + 2_500), now + 8_000);
    await leaveFlowDetailView({ deadline: cleanupDeadline, signal: options.signal });
    const before = await dismissBlockingOverlays({ deadline: cleanupDeadline });
    const referencePicker = (() => {
      try { return root.FlowReferenceActions?.inspectDiagnostics?.()?.pickerOpen === true; } catch { return false; }
    })();
    const overlays = [...new Set(document.querySelectorAll('[role="dialog"],[role="alertdialog"],dialog[open],mat-dialog-container,flow-dialog,[aria-modal="true"],[role="menu"],[role="listbox"],mat-menu-panel,.mat-mdc-menu-panel,mat-select-panel,.cdk-overlay-pane'))]
      .filter(el => root.visible?.(el) && !isSettingsDialogForPreflight(el));
    if (referencePicker || overlays.length) {
      const error = root.flowError("FLOW_OPERATION_PREFLIGHT_FAILED", "Flow still has an open popup. The requested operation was not started.", true, false);
      error.diagnostics = { referencePickerOpen: referencePicker, visiblePopupCount: overlays.length };
      throw error;
    }
    return { ready: true, popupDismissed: before };
  }

  function isSettingsDialogForPreflight(el) {
    if (!el) return false;
    if (el.querySelector?.('button[id*="-trigger-"]')) return true;
    return [...(el.querySelectorAll?.('[role="radio"], mat-radio-button') || [])]
      .some(radio => /image|video|9:16|16:9/i.test(root.accessibleName?.(radio) || ""));
  }

  async function leaveFlowDetailView(options = {}) {
    const target = root.ProviderRegistry?.describeUrl?.(location.href) || root.FlowDriverRegistry?.describeUrl?.(location.href);
    if (target?.projectId && !target.isProjectEditor) {
      if (/\/edit(?:\/|$)/i.test(location.pathname)) {
        await exitFlowMediaViewer(options);
        return;
      }
      if (/\/character(?:\/|$)/i.test(location.pathname)) {
        const done = [...document.querySelectorAll("button,[role=button]")].find(el => root.visible?.(el) && /^(?:Done( editing)?|Xong|Hoàn tất)$/i.test(root.accessibleName?.(el).trim()));
        if (done) {
          done.click();
          const left = await waitForFlowRoute(path => !/\/character(?:\/|$)/i.test(path), 2000, "", options).catch(() => false);
          if (left) return;
        }
        const goBack = root.flowButton?.("Go back") || root.flowButton?.("Back") || root.flowButton?.("Quay lại");
        if (goBack) {
          goBack.click();
          const left = await waitForFlowRoute(path => !/\/character(?:\/|$)/i.test(path), 2000, "", options).catch(() => false);
          if (left) return;
        }
      }

      await ensureFlowProjectEditor({ ...options, expectedProjectId: target.projectId });
    }
  }

  async function ensureFlowProjectEditorInternal(options = {}) {
    const waitOptions = { deadline: options.deadline, signal: options.signal };
    const checkTime = label => root.FlowUiDeadline?.requireTime(Number.isFinite(options.deadline) ? options.deadline : Infinity, label, false, options.signal);
    const describe = () => (root.ProviderRegistry?.describeUrl?.(location.href) || root.FlowDriverRegistry?.describeUrl?.(location.href) || null);
    let target = describe();
    checkTime("opening the Flow project editor");

    // 1. In project root editor
    if (target?.isProjectEditor) {
      if (target.projectId) lastVerifiedProjectId = target.projectId;
      return { success: true, isProjectEditor: true, projectId: target.projectId };
    }

    // 2. Stuck on sub-routes (/character, /edit, ...)
    if (target?.projectId && !target.isProjectEditor) {
      console.log("[FlowNavigation] Detected sub-route (" + location.pathname + "), recovering to project root editor...");
      const sameProject = () => {
        const current = describe();
        return current?.origin === target.origin && current?.projectId === target.projectId && current?.routePrefix === target.routePrefix;
      };

      const doneOrBack = [...document.querySelectorAll('button, [role="button"]')].find(el => {
        if (!root.visible?.(el)) return false;
        const name = root.accessibleName?.(el).trim();
        return /^(?:Done( editing)?|Xong|Hoàn tất)$/i.test(name) || /^(?:Back( button.*)?|Quay lại|Quay về)$/i.test(name) || /^(Go back|Quay lại)$/i.test(name);
      });
      if (doneOrBack) {
        doneOrBack.click();
        const leftSubRoute = await waitForFlowRoute(() => describe()?.isProjectEditor === true, 2000, "", waitOptions).catch(() => false);
        if (leftSubRoute) { lastVerifiedProjectId = target.projectId; return { success: true, isProjectEditor: true, projectId: target.projectId }; }
      }

      const allMedia = configuredNavigationItem("All media");
      if (allMedia) {
        allMedia.click();
        const clickDeadline = Math.min(Date.now() + 2500, Number.isFinite(options.deadline) ? options.deadline : Infinity);
        let leftSubRoute = false;
        while (Date.now() < clickDeadline) {
          checkTime("returning to the Flow project editor");
          if (!sameProject()) throw root.flowError("FLOW_EXECUTION_TARGET_CHANGED", "The Flow project changed while returning to its editor. No further action was taken.", false, false);
          if (describe()?.isProjectEditor) { leftSubRoute = true; break; }
          if (root.FlowUiDeadline?.boundedWait) await root.FlowUiDeadline.boundedWait(100, clickDeadline, "waiting for the Flow project editor", false, options.signal);
          else await root.wait?.(100);
        }
        if (leftSubRoute) { lastVerifiedProjectId = target.projectId; return { success: true, isProjectEditor: true, projectId: target.projectId }; }
      }

      if (!sameProject()) throw root.flowError("FLOW_EXECUTION_TARGET_CHANGED", "The Flow project changed before navigation recovery. No further action was taken.", false, false);
      const rootUrl = `${target.origin}${target.routePrefix}/project/${target.projectId}`;
      console.log("[FlowNavigation] Navigating directly to project root URL:", rootUrl);
      location.assign(rootUrl);
      throw (root.flowError ? root.flowError("FLOW_PROJECT_NAVIGATING", "Navigating back to project root editor. Please retry.", true, false) : new Error("Navigating back to project root editor."));
    }

    // 3. Outside of project
    // When the operation is bound to a specific project — passed explicitly
    // via options.expectedProjectId, or the project this page session was
    // last verified to be operating in — recovery must land in exactly that
    // project. Creating a new project or opening an arbitrary first card
    // would silently continue the operation (uploads, generations) in the
    // wrong project, so with a target set those shortcuts are forbidden and
    // a mismatch fails as FLOW_EXECUTION_TARGET_CHANGED, mirroring case 2.
    const expectedProjectId = String(options.expectedProjectId || "").trim() || lastVerifiedProjectId;
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

    if (expectedProjectId) {
      const projectCards = [...document.querySelectorAll('a[href*="/project/"]')].filter(card => root.visible?.(card));
      const targetCard = projectCards.find(card => String(card.getAttribute?.("href") || "").includes(`/project/${expectedProjectId}`));
      if (!targetCard) {
        throw root.flowError("FLOW_EXECUTION_TARGET_CHANGED", "The Flow tab left the target project and that project could not be reopened. No further action was taken.", false, false);
      }
      console.log("[FlowNavigation] Reopening the operation's target project...");
      targetCard.click();
      await waitForFlowRoute(() => describe()?.isProjectEditor === true, 15000, "Flow did not open the target project editor.", waitOptions);
      target = describe();
      if (target?.projectId !== expectedProjectId) {
        throw root.flowError("FLOW_EXECUTION_TARGET_CHANGED", "Flow opened a different project than the operation's target. No further action was taken.", false, false);
      }
      lastVerifiedProjectId = target.projectId;
      return { success: true, isProjectEditor: true, projectId: target.projectId };
    }

    if (newProjectBtn) {
      console.log("[FlowNavigation] Clicking New project button...");
      newProjectBtn.click();
      await waitForFlowRoute(() => describe()?.isProjectEditor === true, 15000, "Flow did not open a new project editor.", waitOptions);
      target = describe();
      if (target?.projectId) lastVerifiedProjectId = target.projectId;
      return { success: true, isProjectEditor: true, projectId: target?.projectId || null };
    }

    const firstProjectCard = document.querySelector('a[href*="/project/"]');
    if (firstProjectCard && root.visible?.(firstProjectCard)) {
      console.log("[FlowNavigation] Opening first existing project...");
      firstProjectCard.click();
      await waitForFlowRoute(() => describe()?.isProjectEditor === true, 15000, "Flow did not open existing project editor.", waitOptions);
      target = describe();
      if (target?.projectId) lastVerifiedProjectId = target.projectId;
      return { success: true, isProjectEditor: true, projectId: target?.projectId || null };
    }

    return { success: false, error: "FLOW_PROJECT_REQUIRED" };
  }

  function ensureFlowProjectEditor(options = {}) {
    if (projectNavigationPending) return projectNavigationPending;
    const operation = ensureFlowProjectEditorInternal(options);
    projectNavigationPending = operation;
    return operation.finally(() => {
      if (projectNavigationPending === operation) projectNavigationPending = null;
    });
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
    prepareFlowOperation,
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
  root.prepareFlowOperation = prepareFlowOperation;
  root.leaveFlowDetailView = leaveFlowDetailView;
  root.ensureFlowLibrarySection = ensureFlowLibrarySection;
  root.waitForFlowRoute = waitForFlowRoute;
  root.isFlowProjectNavigationControl = isFlowProjectNavigationControl;
})(globalThis);
