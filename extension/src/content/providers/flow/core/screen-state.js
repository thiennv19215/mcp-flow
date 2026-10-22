(function (root) {
  "use strict";

  const clean = value => String(value || "").replace(/\s+/g, " ").trim();
  const normalize = value => clean(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d").toLowerCase();
  const visible = element => Boolean(element && root.visible?.(element));

  function visibleText(selector, limit = 8) {
    return [...document.querySelectorAll(selector)].filter(visible).slice(0, limit)
      .map(element => clean(element.innerText || element.textContent || element.getAttribute?.("aria-label")).slice(0, 1200))
      .filter(Boolean);
  }

  function configuredMatches(key, fallbackRegex) {
    const config = root.flowGetConfig?.(key) || root.FlowSelectors?.[key] || null;
    const candidates = (root.flowQueryAll?.(key, document) || []).filter(visible);
    const textMatches = config?.text_match || config?.textMatch || [];
    const patterns = [config?.textRegex, ...(Array.isArray(textMatches) ? textMatches : [textMatches])]
      .filter(Boolean)
      .map(pattern => {
        try { return pattern instanceof RegExp ? pattern : new RegExp(String(pattern), "i"); }
        catch { return null; }
      }).filter(Boolean);
    const regex = patterns.length ? new RegExp(patterns.map(pattern => `(?:${pattern.source})`).join("|"), "i") : fallbackRegex;
    const matches = candidates.filter(element => {
      const text = clean(root.accessibleName?.(element) || element.innerText || element.textContent || element.getAttribute?.("aria-label"));
      return regex ? regex.test(text) : true;
    });
    const samples = matches.slice(0, 3).map(element => clean(root.accessibleName?.(element) || element.innerText || element.textContent || element.getAttribute?.("aria-label")).slice(0, 240));
    return { configured: Boolean(config?.selectors?.length), count: matches.length, candidates: candidates.length, samples };
  }

  function inspect() {
    const registry = root.ProviderRegistry || root.FlowDriverRegistry;
    const route = registry?.describeUrl?.(location.href) || null;
    const editor = root.flowQuery?.("editor") || null;
    const agent = root.FlowAgent?.findNativeAgentModeControl?.() || null;
    const agentActive = agent?.control?.getAttribute?.("aria-pressed") === "true";
    const agentPanelOpen = root.FlowAgent?.isNativeAgentSessionOpen?.() === true;
    const mainText = visibleText("main,[role='main'],h1,h2,[role='heading']", 12).join(" ");
    const signInControls = [...document.querySelectorAll("main button,main a,[role='main'] button,[role='main'] a")]
      .filter(visible)
      .filter(element => /^(?:sign in|log in|continue to sign in|sign in with google|đăng nhập|tiếp tục đăng nhập)(?:\s+.*)?$/i.test(
        clean(root.accessibleName?.(element) || element.innerText || element.textContent)));
    const submitErrors = root.FlowEditor?.currentFlowSubmitErrors?.() || [];
    const alertText = visibleText("[role='alert'],mat-error,[aria-live='assertive'],[aria-live='polite']", 12).join(" ");
    const errorText = normalize(`${alertText} ${mainText} ${submitErrors.join(" ")}`);
    const configuredSignOut = configuredMatches("signed_out_indicator", /sign in|log in|đăng nhập/i);
    const configuredProjectError = configuredMatches("project_error_indicator", /project (?:not found|unavailable|could not be loaded)|unable to load (?:this )?project|failed to load project|dự án (?:không tồn tại|không khả dụng)|không thể tải (?:dự án|project)|không tìm thấy dự án/i);
    const projectHomeRecoveryLinkCount = route?.projectId
      ? [...document.querySelectorAll('#__next a[href$="/tools/flow"]')].filter(visible).length
      : 0;
    const mediaViewerRoute = /(?:^|\/)project\/[0-9a-f-]{36}\/edit\/[^/]+(?:\/|$)/i.test(location.pathname);
    const hasEditorOrTiles = Boolean(editor || root.flowQuery?.("submitButton") || root.flowQueryAll?.("tiles.container", document)?.length);

    let state = "unknown";
    let reason = "composer_not_detected";
    if ((!editor && (configuredSignOut.count > 0 || (signInControls.length > 0 && /sign in|log in|đăng nhập/i.test(normalize(mainText))))) ||
      (!editor && /(?:you need to sign in|sign in to continue|log in to continue|đăng nhập để tiếp tục|vui lòng đăng nhập)/i.test(errorText))) {
      state = "signed_out";
      reason = "sign_in_surface_detected";
    } else if (route?.projectId && !hasEditorOrTiles && (configuredProjectError.count > 0 || projectHomeRecoveryLinkCount > 0 || /(?:project (?:not found|unavailable|could not be loaded)|(?:we )?couldn['’]?t find (?:this )?project|unable to load (?:this )?project|failed to load project|dự án (?:không tồn tại|không khả dụng)|không thể tải (?:dự án|project)|không tìm thấy dự án)/i.test(errorText))) {
      state = "project_error";
      reason = "project_error_message_detected";
    } else if (mediaViewerRoute) {
      state = "media_viewer";
      reason = "media_viewer_route_active";
    } else if (agentActive || agentPanelOpen) {
      state = "agent_blocked";
      reason = agentActive ? "agent_mode_active" : "agent_panel_open";
    } else if (route?.isProjectEditor && editor && visible(editor)) {
      state = "ready";
      reason = "project_editor_and_composer_visible";
    }

    return {
      state,
      reason,
      projectId: route?.projectId || null,
      isProjectEditor: route?.isProjectEditor === true,
      composerVisible: Boolean(editor && visible(editor)),
      agentModeActive: agentActive,
      agentPanelOpen,
      signInControlCount: signInControls.length,
      configuredSignedOutIndicatorCount: configuredSignOut.count,
      configuredProjectErrorIndicatorCount: configuredProjectError.count,
      projectHomeRecoveryLinkCount,
      visibleAlertCount: alertText ? visibleText("[role='alert'],mat-error,[aria-live='assertive'],[aria-live='polite']", 12).length : 0,
      errorMessage: state === "project_error" ? clean(alertText || configuredProjectError.samples[0] || submitErrors.join(" ") || (projectHomeRecoveryLinkCount ? "Flow project error screen with a link back to Flow home." : "")).slice(0, 300) : undefined,
    };
  }

  function assertGenerationReady() {
    const status = inspect();
    if (status.state === "ready" || status.state === "agent_blocked") return status;
    const failures = {
      signed_out: ["FLOW_SESSION_REQUIRED", "Flow is showing a sign-in screen. Sign in in the Flow tab before starting generation."],
      project_error: ["FLOW_PROJECT_LOAD_FAILED", status.errorMessage || "Flow reported that the project could not be loaded. No generation was submitted."],
      media_viewer: ["FLOW_MEDIA_VIEWER_OPEN", "Flow is showing a media detail view instead of the project editor. No generation was submitted."],
      unknown: ["FLOW_SCREEN_NOT_READY", "Flow's project composer could not be verified. No generation was submitted."],
    };
    const [code, message] = failures[status.state] || failures.unknown;
    const error = root.flowError(code, message, status.state === "unknown", false);
    error.diagnostics = { errorCode: code, screen: status };
    throw error;
  }

  root.FlowScreenState = Object.freeze({ inspect, assertGenerationReady });
})(globalThis);
