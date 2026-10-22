(function (root) {
  "use strict";

  const applied = new Set();
  const clean = value => String(value || "").replace(/\s+/g, " ").trim();
  const normalize = value => root.normalizeFlowUiText?.(value) || clean(value).toLowerCase();
  const visible = element => Boolean(element && root.visible?.(element));
  const patternList = (key, fallback) => {
    const configured = root.flowGetConfig?.(`pageSettings.${key}`) || root.FlowSelectors?.pageSettings?.[key];
    const profile = configured?.textMatch || configured?.text_match || configured?.aliases || [];
    const i18n = root.I18n?.getPatterns?.(key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)) || [];
    return [...new Set([...(Array.isArray(profile) ? profile : [profile]), ...i18n, ...fallback].map(normalize).filter(Boolean))];
  };
  const matches = (value, patterns, exact = false) => {
    const text = normalize(value);
    return patterns.some(pattern => exact ? text === pattern : text.includes(pattern));
  };
  const matchesConfiguredText = (value, key, fallback, exact = false) => {
    if (matches(value, patternList(key, fallback), exact)) return true;
    const config = root.flowGetConfig?.(`pageSettings.${key}`) || root.FlowSelectors?.pageSettings?.[key];
    const source = config?.textRegex || config?.text_regex;
    if (!source) return false;
    try {
      const regex = source instanceof RegExp ? source : new RegExp(String(source), "i");
      return root.matchesFlowUiRegex?.(value, regex) ?? regex.test(String(value || ""));
    } catch { return false; }
  };
  const controlText = element => clean(root.semanticActionText?.(element) || root.accessibleName?.(element) || element?.innerText || element?.textContent || "");
  const iconName = element => {
    const icon = root.flowFindIcon?.(element) || element?.querySelector?.("mat-icon,.mat-icon,.google-symbols,.material-symbols-outlined");
    return normalize(icon?.getAttribute?.("fonticon") || icon?.getAttribute?.("data-mat-icon-name") || icon?.textContent || "");
  };
  const configuredQuery = (key, scope = document) => {
    const found = root.flowQueryAll?.(`pageSettings.${key}`, scope, { checkVisible: false });
    if (found?.length) return [...new Set(found)];
    const selectors = root.FlowSelectors?.pageSettings?.[key]?.selectors || [];
    return [...new Set(selectors.flatMap(selector => {
      try { return [...scope.querySelectorAll(selector)]; } catch { return []; }
    }))];
  };

  function activeState(element) {
    const values = [
      element?.getAttribute?.("aria-checked"),
      element?.getAttribute?.("aria-selected"),
      element?.getAttribute?.("aria-pressed"),
      element?.getAttribute?.("data-state"),
    ].map(value => String(value || "").toLowerCase());
    if (values.some(value => ["true", "active", "selected", "checked", "on"].includes(value))) return true;
    if (values.some(value => ["false", "inactive", "unselected", "unchecked", "off"].includes(value))) return false;
    if (element?.checked === true || element?.hasAttribute?.("checked")) return true;
    const classes = String(element?.className?.baseVal || element?.className || "");
    if (/(?:^|\s)(?:active|selected|checked|is-active|is-selected)(?:\s|$)/i.test(classes)) return true;
    if (/(?:^|\s)(?:inactive|unselected|unchecked)(?:\s|$)/i.test(classes)) return false;
    return null;
  }

  function selectedControl(panel, key, extra = []) {
    const candidates = configuredQuery("candidates", panel).filter(element =>
      visible(element) && !element.disabled && element.getAttribute?.("aria-disabled") !== "true");
    const labels = patternList(key, extra);
    const matchesForKey = candidates.filter(element => {
      const name = controlText(element);
      const icon = iconName(element);
      if (key === "grid_view" && /^(?:grid_view|dashboard|view_module)$/.test(icon)) return true;
      if (key === "small" && /^(?:small|view_comfy)$/.test(icon)) return true;
      return matches(name, labels, true) || matchesConfiguredText(name, key, extra, true);
    });
    return matchesForKey.length === 1 ? matchesForKey[0] : null;
  }

  function detailsToggle(panel) {
    const labels = patternList("show_tile_details", ["show tile details", "show details", "hiển thị chi tiết ô"]);
    const direct = configuredQuery("candidates", panel).filter(element =>
      visible(element) && !element.disabled && element.getAttribute?.("aria-disabled") !== "true" &&
      matches(controlText(element), labels, true) && /switch|checkbox|toggle/i.test(`${element.getAttribute?.("role") || ""} ${element.tagName || ""}`));
    if (direct.length === 1) return direct[0];
    if (direct.length > 1) return null;

    const rows = configuredQuery("detailsRow", panel)
      .filter(element => visible(element) && clean(element.innerText || element.textContent).length <= 180 && matchesConfiguredText(element.innerText || element.textContent, "show_tile_details", labels));
    const candidates = rows.flatMap(row => {
      const controls = configuredQuery("candidates", row).filter(element =>
        visible(element) && !element.disabled && element.getAttribute?.("aria-disabled") !== "true" &&
        /switch|checkbox|toggle/i.test(`${element.getAttribute?.("role") || ""} ${element.tagName || ""}`));
      return controls.length === 1 ? [{ control: controls[0], rowLength: clean(row.innerText || row.textContent).length }] : [];
    }).sort((a, b) => a.rowLength - b.rowLength);
    if (!candidates.length) return null;
    const shortest = candidates.filter(candidate => candidate.rowLength === candidates[0].rowLength);
    return shortest.length === 1 ? shortest[0].control : null;
  }

  function pageSettingsPanel() {
    const matching = configuredQuery("panel", document).filter(visible).filter(panel => {
      const text = normalize(panel.innerText || panel.textContent);
      return text.length < 5000 && (
        matchesConfiguredText(text, "grid_view", ["grid view", "lưới"]) ||
        matchesConfiguredText(text, "show_tile_details", ["show tile details", "hiển thị chi tiết ô"])
      );
    });
    return matching.filter(panel => !matching.some(other => other !== panel && panel.contains(other)));
  }

  async function waitFor(predicate, deadline, operation, signal) {
    while (Date.now() < deadline) {
      root.FlowUiDeadline?.requireTime(deadline, operation, false, signal);
      const result = predicate();
      if (result) return result;
      if (root.FlowUiDeadline?.boundedWait) await root.FlowUiDeadline.boundedWait(100, deadline, operation, false, signal);
      else await root.wait?.(100);
    }
    return null;
  }

  async function ensureApplied(options = {}) {
    const route = (root.ProviderRegistry || root.FlowDriverRegistry)?.describeUrl?.(location.href);
    if (!route?.projectId || !route?.isProjectEditor) return { applied: false, reason: "project_editor_unavailable" };
    const key = `${location.pathname}|grid|small|details`;
    if (applied.has(key)) return { applied: true, cached: true };
    const deadline = Math.min(Date.now() + Math.max(500, Number(options.timeoutMs) || 5000), Number.isFinite(options.deadline) ? options.deadline : Infinity);
    const alreadyOpen = pageSettingsPanel();
    // Do not take over or close a panel opened by the user or another command.
    if (alreadyOpen.length) return { applied: false, reason: "page_settings_already_open" };

    const triggerIcons = root.FlowSelectors?.pageSettings?.triggerButton?.icons || ["settings_2"];
    const triggerLabels = patternList("page_settings", ["page settings", "layout settings", "cài đặt trang", "cài đặt giao diện"]);
    const trigger = configuredQuery("triggerButton", document).filter(element => {
      if (!visible(element) || element.disabled || element.getAttribute?.("aria-disabled") === "true") return false;
      const icon = iconName(element);
      const label = controlText(element);
      return triggerIcons.some(value => normalize(value) === icon) || matches(label, triggerLabels) || matchesConfiguredText(label, "triggerButton", []);
    });
    if (trigger.length !== 1) return { applied: false, reason: trigger.length ? "page_settings_trigger_ambiguous" : "page_settings_trigger_missing" };

    trigger[0].click();
    const panelList = await waitFor(() => {
      const candidates = pageSettingsPanel();
      return candidates.length ? candidates : null;
    }, deadline, "opening Flow's page layout settings", options.signal);
    const panel = Array.isArray(panelList) && panelList.length === 1 ? panelList[0] : null;
    if (!panel) {
      // The operation owns the trigger click, so undo it if the resulting panel
      // cannot be identified. This avoids stranding a popup on selector drift.
      if (trigger[0].isConnected && visible(trigger[0])) {
        trigger[0].click();
        await root.wait?.(120);
      }
      return { applied: false, reason: panelList?.length > 1 ? "page_settings_panel_ambiguous" : "page_settings_panel_missing" };
    }

    const touched = [];
    const grid = selectedControl(panel, "grid_view", ["grid", "grid view", "lưới", "dạng lưới"]);
    const small = selectedControl(panel, "small", ["small", "nhỏ", "cỡ nhỏ"]);
    const details = detailsToggle(panel);
    const controls = [["grid", grid, true], ["size", small, true], ["details", details, true]];
    for (const [name, control, desired] of controls) {
      if (!control) continue;
      const state = activeState(control);
      if (name === "details" && state === null) continue;
      if (state !== desired) {
        control.click();
        touched.push(name);
        await (root.FlowUiDeadline?.boundedWait
          ? root.FlowUiDeadline.boundedWait(180, deadline, `setting Flow ${name}`, false, options.signal)
          : root.wait?.(180));
      }
    }

    const verified = Boolean(grid && small && details && activeState(grid) === true && activeState(small) === true && activeState(details) === true);
    const liveTrigger = trigger[0].isConnected ? trigger[0] : configuredQuery("triggerButton", document).find(element => visible(element) && triggerIcons.some(value => normalize(value) === iconName(element)));
    if (liveTrigger && pageSettingsPanel().includes(panel)) {
      liveTrigger.click();
      await waitFor(() => !visible(panel), deadline, "closing Flow's page layout settings", options.signal);
    }
    const closed = !visible(panel);
    if (verified && closed) applied.add(key);
    return { applied: verified && closed, verified, closed, changed: touched, missingControls: controls.filter(([, control]) => !control).map(([name]) => name) };
  }

  root.FlowPageSettings = Object.freeze({ ensureApplied });
})(globalThis);
