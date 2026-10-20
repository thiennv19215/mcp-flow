(function () {
  "use strict";

  let cachedStatus = null;
  const logs = [];
  let currentCharacters = [];

  function t(key, params) {
    return typeof I18n !== "undefined" ? I18n.t(key, params) : key;
  }

  function applyLanguage() {
    const cur = typeof I18n !== "undefined" ? I18n.getLocale() : "vi";
    document.documentElement.lang = cur;
    document.querySelector("#langSwitchLabel").textContent = cur.toUpperCase();

    // Tabs
    document.querySelector("#tabCreateLabel").textContent = t("sidebar.tabGen");
    document.querySelector("#tabStatusLabel").textContent = t("sidebar.tabStatus");
    document.querySelector("#tabLogsLabel").textContent = t("sidebar.tabLogs");
    document.querySelector("#tabSettingsLabel").textContent = t("sidebar.tabSettings");

    // Mode Segments
    document.querySelector("#txtModeImage").textContent = t("sidebar.typeImage");
    document.querySelector("#txtModeVideo").textContent = t("sidebar.typeVideo");
    document.querySelector("#txtModeCharacter").textContent = t("sidebar.typeCharacter");

    // Form Image
    document.querySelector("#lblPromptImage").textContent = t("sidebar.promptLabel") + ":";
    document.querySelector("#inputPromptImage").placeholder = t("sidebar.promptPlaceholder");
    document.querySelector("#lblRatioImage").textContent = t("sidebar.aspectRatio") + ":";
    document.querySelector("#lblQtyImage").textContent = t("sidebar.quantity") + ":";
    document.querySelector("#lblCharImage").textContent = t("sidebar.characterSelect") + ":";
    document.querySelector("#txtBtnSubmitImage").textContent = t("sidebar.btnGenerateImage");

    // Form Video
    document.querySelector("#lblPromptVideo").textContent = t("sidebar.promptLabel") + ":";
    document.querySelector("#inputPromptVideo").placeholder = t("sidebar.promptPlaceholderVideo");
    document.querySelector("#lblRatioVideo").textContent = t("sidebar.aspectRatio") + ":";
    document.querySelector("#lblDurationVideo").textContent = t("sidebar.videoDuration") + ":";
    document.querySelector("#lblModeVideo").textContent = t("sidebar.videoMode") + ":";
    document.querySelector("#lblCharVideo").textContent = t("sidebar.characterSelect") + ":";
    document.querySelector("#txtBtnSubmitVideo").textContent = t("sidebar.btnGenerateVideo");

    // Form Character
    document.querySelector("#lblCharName").textContent = t("sidebar.charNameLabel") + ":";
    document.querySelector("#inputCharName").placeholder = t("sidebar.charNamePlaceholder");
    document.querySelector("#lblCharDesc").textContent = t("sidebar.charDescLabel") + ":";
    document.querySelector("#inputCharDesc").placeholder = t("sidebar.charDescPlaceholder");
    document.querySelector("#txtBtnSubmitChar").textContent = t("sidebar.btnCreateCharacter");

    // Status pane
    document.querySelector("#lblFlowTabs").textContent = t("popup.flowTabs");
    document.querySelector("#lblSelectedTab").textContent = t("popup.selectedTab");
    document.querySelector("#lblQuickActions").textContent = t("sidebar.quickActions");
    document.querySelector("#txtBtnReconnect").textContent = t("sidebar.btnReconnect");
    document.querySelector("#txtBtnPreview").textContent = t("sidebar.btnPreview");
    document.querySelector("#txtBtnOpenFlow").textContent = t("sidebar.btnOpenFlow");

    // Logs pane
    document.querySelector("#lblLogsTitle").textContent = t("sidebar.tabLogs");
    document.querySelector("#btnClearLogs").textContent = t("sidebar.clearLogs");
    const emptyEl = document.querySelector("#logsEmpty");
    if (emptyEl) emptyEl.textContent = t("sidebar.logsEmpty");

    // Settings pane
    document.querySelector("#txtSaveSettings").textContent = t("sidebar.saveSettings");

    if (cachedStatus) renderStatus(cachedStatus);
    else document.querySelector("#wsText").textContent = t("popup.checking");
  }

  function renderStatus(s) {
    cachedStatus = s;
    const wsBadge = document.querySelector("#wsBadge");
    const wsText = document.querySelector("#wsText");
    const valFlowTabs = document.querySelector("#valFlowTabs");
    const valSelectedTab = document.querySelector("#valSelectedTab");
    const bridgeSummary = document.querySelector("#bridgeSummary");

    if (s.wsConnected) {
      wsBadge.className = "status-badge connected";
      wsText.textContent = t("popup.wsConnected");
    } else {
      wsBadge.className = "status-badge disconnected";
      wsText.textContent = t("popup.wsDisconnected");
    }

    const count = s.flowTabs ?? 0;
    valFlowTabs.textContent = count > 0 ? t("popup.tabsCount", count) : t("popup.tabsNone");
    valSelectedTab.textContent = s.selectedTabId ? `Tab #${s.selectedTabId}` : t("popup.tabNone");

    if (s.bridge) {
      try {
        const u = new URL(s.bridge);
        bridgeSummary.textContent = u.host || s.bridge;
      } catch {
        bridgeSummary.textContent = s.bridge;
      }
      const bridgeInput = document.querySelector("#inputBridgeUrl");
      if (bridgeInput && !bridgeInput.matches(":focus")) {
        bridgeInput.value = s.bridge;
      }
    }
  }

  function setFeedback(msg, isSuccess = true) {
    const el = document.querySelector("#feedbackBox");
    if (!el) return;
    el.textContent = msg;
    el.style.color = isSuccess ? "#4ade80" : "#f87171";
  }

  function addLog(name, detail, isOk = true) {
    const container = document.querySelector("#logsContainer");
    const empty = document.querySelector("#logsEmpty");
    if (empty) empty.style.display = "none";

    const time = new Date().toLocaleTimeString();
    const entry = document.createElement("div");
    entry.className = `log-entry ${isOk ? "ok" : "error"}`;
    entry.innerHTML = `
      <div class="log-head">
        <span>${name}</span>
        <span class="log-time">${time}</span>
      </div>
      <div class="log-detail">${detail}</div>
    `;
    container.insertBefore(entry, container.firstChild);
    logs.push({ name, detail, isOk, time });
  }

  async function fetchStatus() {
    try {
      const s = await chrome.runtime.sendMessage({ type: "flow-mcp:status" });
      if (s) renderStatus(s);
    } catch (err) {
      renderStatus({
        wsConnected: false,
        flowTabs: 0,
        selectedTabId: null,
        bridge: "http://127.0.0.1:18899",
        error: err.message
      });
    }
  }

  async function loadFlowCharacters() {
    try {
      const res = await chrome.runtime.sendMessage({
        type: "flow-mcp:dispatch",
        operation: "flow.characters.list",
        payload: {}
      });
      if (res?.ok && Array.isArray(res.value)) {
        currentCharacters = res.value;
        populateCharacterSelects();
      }
    } catch (_) {}
  }

  function populateCharacterSelects() {
    const selects = [document.querySelector("#selectCharImage"), document.querySelector("#selectCharVideo")];
    selects.forEach(sel => {
      if (!sel) return;
      const currentVal = sel.value;
      sel.innerHTML = `<option value="">${t("sidebar.characterNone")}</option>`;
      currentCharacters.forEach(c => {
        const name = typeof c === "string" ? c : c.name;
        if (!name) return;
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = `👤 ${name}`;
        if (opt.value === currentVal) opt.selected = true;
        sel.appendChild(opt);
      });
    });
  }

  // Navigation Tabs switching
  document.querySelectorAll(".tobyflow-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tobyflow-tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".tab-pane").forEach(p => p.classList.remove("active"));
      tab.classList.add("active");
      const targetId = tab.getAttribute("data-tab");
      document.getElementById(targetId)?.classList.add("active");
    });
  });

  // Mode Segments switching (Image / Video / Character)
  document.querySelectorAll(".mode-segment-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".mode-segment-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const mode = btn.getAttribute("data-mode");
      document.querySelector("#formImage").style.display = mode === "image" ? "flex" : "none";
      document.querySelector("#formVideo").style.display = mode === "video" ? "flex" : "none";
      document.querySelector("#formCharacter").style.display = mode === "character" ? "flex" : "none";
      setFeedback("");
    });
  });

  let isGenerating = false;

  // Listen for real-time progress broadcast from background/Flow
  chrome.runtime.onMessage.addListener(msg => {
    if (msg?.type === "flow-mcp:progress-broadcast" && msg.progress) {
      setFeedback(`⏳ ${msg.progress}`, true);
      addLog("Tiến trình", msg.progress, true);
    }
  });

  async function executeGenerationTask({ type, prompt, aspect_ratio, count = 1, attachments = [], video_settings, btn, btnTextEl, defaultTextKey }) {
    if (isGenerating) {
      setFeedback("Đang có tác vụ đang chạy, vui lòng đợi!", false);
      return;
    }
    isGenerating = true;
    if (btn) btn.disabled = true;

    try {
      setFeedback(t("sidebar.generating") || "Đang gửi lệnh tạo...", true);
      addLog("flow.generation.submit", `[${type.toUpperCase()}] ${prompt.slice(0, 40)}...`, true);

      // Bước 1: Gửi lệnh submit vào Google Flow
      const submitRes = await chrome.runtime.sendMessage({
        type: "flow-mcp:dispatch",
        operation: "flow.generation.submit",
        payload: {
          type,
          prompt,
          aspect_ratio,
          count,
          attachments,
          ...(video_settings ? { video_settings } : {})
        }
      });

      if (!submitRes?.ok) {
        throw new Error(submitRes?.error?.message || "Lỗi gửi lệnh tạo");
      }

      const info = submitRes.value || {};
      setFeedback("Đã gửi yêu cầu tạo. Đang theo dõi tiến trình render...", true);
      addLog("flow.generation.observe", "Bắt đầu theo dõi render...", true);

      // Bước 2: Theo dõi đến khi Flow render xong 100%
      const observeRes = await chrome.runtime.sendMessage({
        type: "flow-mcp:dispatch",
        operation: "flow.generation.observe",
        payload: {
          before: info.before || [],
          expectedCount: count,
          correlationAttemptId: info.correlationAttemptId,
          kind: type,
          timeoutMs: type === "video" ? 600000 : 300000
        }
      });

      if (!observeRes?.ok) {
        throw new Error(observeRes?.error?.message || "Lỗi trong quá trình render");
      }

      const mediaList = observeRes.value?.media || [];
      const countFinished = mediaList.length || count;
      const doneMsg = type === "video"
        ? `Tạo video hoàn tất! (${countFinished} video đã sẵn sàng)`
        : `Tạo ảnh hoàn tất! (${countFinished} ảnh đã sẵn sàng)`;

      setFeedback(`✅ ${doneMsg}`, true);
      addLog("flow.generation.complete", doneMsg, true);
    } catch (err) {
      setFeedback(`❌ ${err.message}`, false);
      addLog("Lỗi", err.message, false);
    } finally {
      isGenerating = false;
      if (btn) btn.disabled = false;
      if (btnTextEl && defaultTextKey) btnTextEl.textContent = t(defaultTextKey);
    }
  }

  // SUBMIT TẠO ẢNH (GENERATE IMAGE)
  document.querySelector("#btnSubmitImage").onclick = async () => {
    const prompt = document.querySelector("#inputPromptImage").value.trim();
    if (!prompt) {
      setFeedback("Vui lòng nhập câu lệnh prompt cho ảnh!", false);
      return;
    }
    const aspect_ratio = document.querySelector("#selectRatioImage").value;
    const count = Number(document.querySelector("#selectQtyImage").value) || 1;
    const character = document.querySelector("#selectCharImage").value;

    const attachments = [];
    if (character) {
      attachments.push({ assetName: `character:${character}` });
    }

    const btn = document.querySelector("#btnSubmitImage");
    const btnTextEl = document.querySelector("#txtBtnSubmitImage");
    await executeGenerationTask({
      type: "image",
      prompt,
      aspect_ratio,
      count,
      attachments,
      btn,
      btnTextEl,
      defaultTextKey: "sidebar.btnGenerateImage"
    });
  };

  // SUBMIT TẠO VIDEO (GENERATE VIDEO)
  document.querySelector("#btnSubmitVideo").onclick = async () => {
    const prompt = document.querySelector("#inputPromptVideo").value.trim();
    if (!prompt) {
      setFeedback("Vui lòng nhập câu lệnh prompt cho video!", false);
      return;
    }
    const aspect_ratio = document.querySelector("#selectRatioVideo").value;
    const duration = Number(document.querySelector("#selectDurationVideo").value) || 5;
    const mode = document.querySelector("#selectModeVideo").value || "ingredients";
    const character = document.querySelector("#selectCharVideo").value;

    const attachments = [];
    if (character) {
      attachments.push({ assetName: `character:${character}` });
    }

    const btn = document.querySelector("#btnSubmitVideo");
    const btnTextEl = document.querySelector("#txtBtnSubmitVideo");
    await executeGenerationTask({
      type: "video",
      prompt,
      aspect_ratio,
      count: 1,
      video_settings: {
        mode,
        duration
      },
      attachments,
      btn,
      btnTextEl,
      defaultTextKey: "sidebar.btnGenerateVideo"
    });
  };

  // SUBMIT TẠO NHÂN VẬT (CREATE CHARACTER)
  document.querySelector("#btnSubmitCharacter").onclick = async () => {
    const name = document.querySelector("#inputCharName").value.trim();
    if (!name) {
      setFeedback("Vui lòng nhập tên nhân vật!", false);
      return;
    }
    const description = document.querySelector("#inputCharDesc").value.trim();

    setFeedback(t("sidebar.creatingChar"), true);
    addLog("flow.character.create", `Tạo nhân vật: ${name}`, true);

    try {
      const res = await chrome.runtime.sendMessage({
        type: "flow-mcp:dispatch",
        operation: "flow.character.create",
        payload: {
          name,
          description
        }
      });
      if (!res?.ok) throw new Error(res?.error?.message || "Lỗi tạo nhân vật");
      setFeedback(t("sidebar.charSuccess"), true);
      addLog("flow.character.create", `Đã tạo nhân vật "${name}"!`, true);
      document.querySelector("#inputCharName").value = "";
      document.querySelector("#inputCharDesc").value = "";
      await loadFlowCharacters();
    } catch (err) {
      setFeedback(err.message, false);
      addLog("flow.character.create", err.message, false);
    }
  };

  // Language switch
  document.querySelector("#langSwitchBtn").onclick = async () => {
    if (typeof I18n === "undefined") return;
    const next = I18n.getLocale() === "vi" ? "en" : "vi";
    await I18n.setLocale(next);
    applyLanguage();
    populateCharacterSelects();
  };

  // Reload status
  document.querySelector("#reloadBtn").onclick = () => {
    fetchStatus();
    loadFlowCharacters();
    setFeedback("Đã làm mới dữ liệu", true);
    setTimeout(() => setFeedback(""), 2000);
  };

  // Connect button
  document.querySelector("#btnReconnect").onclick = async () => {
    setFeedback(t("popup.reconnecting"), true);
    addLog("flow.reconnect", "Yêu cầu kết nối lại Flow tab", true);
    try {
      await chrome.runtime.sendMessage({ type: "flow-mcp:connect" });
      setTimeout(async () => {
        await fetchStatus();
        await loadFlowCharacters();
        setFeedback("");
      }, 700);
    } catch (err) {
      setFeedback(err.message, false);
      addLog("flow.reconnect", err.message, false);
    }
  };

  // Preview button
  document.querySelector("#btnPreview").onclick = async () => {
    setFeedback(t("popup.previewTriggered"), true);
    addLog("flow.preview", "Kích hoạt viền xanh 5s", true);
    try {
      const res = await chrome.runtime.sendMessage({ type: "flow-mcp:preview" });
      if (res?.error) throw new Error(res.error);
    } catch (err) {
      setFeedback(err.message, false);
      addLog("flow.preview", err.message, false);
    }
  };

  // Open Flow
  document.querySelector("#btnOpenFlow").onclick = async () => {
    const tabs = await chrome.tabs.query({ url: "https://flow.google.com/*" });
    if (tabs.length > 0) {
      await chrome.tabs.update(tabs[0].id, { active: true });
      if (tabs[0].windowId) await chrome.windows.update(tabs[0].windowId, { focused: true });
    } else {
      await chrome.tabs.create({ url: "https://flow.google.com/" });
    }
  };

  // Clear logs
  document.querySelector("#btnClearLogs").onclick = () => {
    const container = document.querySelector("#logsContainer");
    container.innerHTML = `<div class="logs-empty" id="logsEmpty">${t("sidebar.logsEmpty")}</div>`;
    logs.length = 0;
  };

  // Save settings
  document.querySelector("#btnSaveSettings").onclick = async () => {
    const url = document.querySelector("#inputBridgeUrl").value.trim();
    if (!url) return;
    try {
      await chrome.storage.local.set({ bridge: url });
      setFeedback(t("sidebar.settingsSaved"), true);
      addLog("settings.save", `Bridge URL: ${url}`, true);
      await chrome.runtime.sendMessage({ type: "flow-mcp:connect" });
      setTimeout(fetchStatus, 700);
    } catch (err) {
      setFeedback(err.message, false);
    }
  };

  // Initialize
  const initLocale = typeof I18n !== "undefined" ? I18n.init() : Promise.resolve();
  initLocale.then(() => {
    applyLanguage();
    return fetchStatus();
  }).then(() => {
    return loadFlowCharacters();
  });

  // Auto poll status periodically
  setInterval(fetchStatus, 3000);
})();
