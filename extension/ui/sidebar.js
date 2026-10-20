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
    const saveSettingsLabel = document.querySelector("#txtSaveSettings");
    if (saveSettingsLabel) saveSettingsLabel.textContent = t("sidebar.saveSettings");

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
        bridge: "https://mcp.shopcongngheso5.io.vn",
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
      const formAngle = document.querySelector("#formAngle");
      if (formAngle) formAngle.style.display = mode === "angle" ? "flex" : "none";
      if (mode === "angle") updateSideAnglePrompt();
      setFeedback("");
    });
  });

  let isGenerating = false;

  // Listen for real-time progress broadcast from background/Flow
  chrome.runtime.onMessage.addListener(msg => {
    if (msg?.type === "flow-mcp:progress-broadcast" && msg.progress) {
      setFeedback(`⏳ ${msg.progress}`, true);
      addLog("Tiến trình", msg.progress, true);
      if (isGenerating) {
        const isImage = document.querySelector("#formImage")?.style.display !== "none";
        const btnTextEl = isImage
          ? document.querySelector("#txtBtnSubmitImage")
          : document.querySelector("#txtBtnSubmitVideo");
        if (btnTextEl) btnTextEl.textContent = msg.progress;
      }
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
          aspectRatio: aspect_ratio,
          aspect_ratio,
          variants: count,
          count,
          attachments,
          ...(video_settings || {})
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
          variants: count,
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

  document.querySelector("#btnPairSettings").onclick = () => chrome.runtime.openOptionsPage();

  // Angle 3D Orbit Canvas & Controller
  const SIDE_ROT_MODS = {
    "-180": "directly behind the subject, showing the back",
    "-135": "behind and to the left of the subject, three-quarter back view",
    "-90": "to the left of the subject, left profile view",
    "-45": "slightly to the left of the subject, three-quarter front view from the left",
    "0": "directly in front of the subject, frontal view facing the camera",
    "45": "slightly to the right of the subject, three-quarter front view from the right",
    "90": "to the right of the subject, right profile view",
    "135": "behind and to the right of the subject, three-quarter back view",
    "180": "directly behind the subject, showing the back",
  };
  const SIDE_TILT_MODS = {
    "-60": "very low near the ground looking up at the subject, worm's eye perspective",
    "-30": "low angle looking up at the subject",
    "0": "at eye level with the subject",
    "30": "high angle looking down at the subject",
    "60": "very high angle looking steeply down at the subject, bird's eye view",
    "90": "directly above the subject, strictly top-down overhead perspective",
  };
  const SIDE_ZOOM_MODS = {
    "-2": "far away, extreme wide shot showing the full surrounding environment",
    "-1": "wide shot, full body visible in frame",
    "0": "medium shot, waist up",
    "1": "close-up shot focused on face and shoulders",
    "2": "extreme close-up macro detail",
  };
  const SIDE_PRESETS_DEF = {
    "portrait-reangle": "Recreate this exact subject from the reference image, camera positioned {angle_modifier}, {tilt_modifier}, {zoom_modifier}. Maintain identical appearance, facial structure, clothing, colors, and all details. Same lighting and background style.",
    "product-reangle": "Studio product photography of the exact item from the reference image, camera positioned {angle_modifier}, {tilt_modifier}, {zoom_modifier}. Keep product geometry, materials, branding, labels and colors 100% identical. Premium commercial lighting with soft clean reflections.",
    "cinematic-orbit": "Cinematic movie still featuring the exact subject from the reference image, shot with camera placed {angle_modifier}, {tilt_modifier}, {zoom_modifier}. 85mm lens, shallow depth of field, cinematic atmospheric lighting, photorealistic textures.",
    "character-turnaround": "Clean character turnaround model sheet view of the exact character, camera view {angle_modifier}, {tilt_modifier}, {zoom_modifier}. Crisp clean contours, neutral even studio lighting, precise proportions matching the reference image perfectly."
  };

  let sideRot = 0, sideTilt = 0, sideZoom = 0;

  function findNearestSide(val, dict) {
    const keys = Object.keys(dict).map(Number).sort((a, b) => a - b);
    let best = keys[0], diff = Math.abs(val - best);
    for (const k of keys) {
      const d = Math.abs(val - k);
      if (d < diff) { diff = d; best = k; }
    }
    return dict[best] || "";
  }

  function drawSideOrbit() {
    const canvas = document.querySelector("#sideOrbitCanvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const w = canvas.width, h = canvas.height;
    const cx = w / 2, cy = h / 2;
    const R = 55;
    ctx.clearRect(0, 0, w, h);

    // Outer rings
    ctx.beginPath();
    ctx.ellipse(cx, cy, R, R * 0.35, 0, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(139, 185, 255, 0.25)";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
    ctx.stroke();

    // 3D position
    const rotRad = (sideRot * Math.PI) / 180;
    const tiltRad = (sideTilt * Math.PI) / 180;
    const camX = cx + R * Math.sin(rotRad) * Math.cos(tiltRad);
    const camY = cy - R * Math.sin(tiltRad);
    const camZ = R * Math.cos(rotRad) * Math.cos(tiltRad);
    const isBehind = camZ < 0;

    // Center icon
    ctx.beginPath();
    ctx.arc(cx, cy, 14, 0, Math.PI * 2);
    ctx.fillStyle = "#202c3b";
    ctx.fill();
    ctx.strokeStyle = "#8bb9ff";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Cone line
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(camX, camY);
    ctx.strokeStyle = isBehind ? "rgba(204, 255, 0, 0.3)" : "#ccff00";
    ctx.setLineDash(isBehind ? [3, 3] : []);
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash([]);

    // Camera dot
    ctx.beginPath();
    ctx.arc(camX, camY, isBehind ? 5 : 7, 0, Math.PI * 2);
    ctx.fillStyle = isBehind ? "#8a9900" : "#ccff00";
    ctx.fill();
    ctx.strokeStyle = "#102033";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  function updateSideAnglePrompt() {
    const rotMod = findNearestSide(sideRot, SIDE_ROT_MODS);
    const tiltMod = findNearestSide(sideTilt, SIDE_TILT_MODS);
    const zoomMod = findNearestSide(sideZoom, SIDE_ZOOM_MODS);
    const presetKey = document.querySelector("#selectSidePreset")?.value || "portrait-reangle";
    const template = SIDE_PRESETS_DEF[presetKey] || SIDE_PRESETS_DEF["portrait-reangle"];

    const prompt = template
      .replace("{angle_modifier}", rotMod)
      .replace("{tilt_modifier}", tiltMod)
      .replace("{zoom_modifier}", zoomMod);

    const previewEl = document.querySelector("#previewSideAnglePrompt");
    if (previewEl) previewEl.textContent = prompt;

    const valRot = document.querySelector("#valSideRot");
    if (valRot) valRot.textContent = `${sideRot}°`;
    const valTilt = document.querySelector("#valSideTilt");
    if (valTilt) valTilt.textContent = `${sideTilt}°`;
    const valZoom = document.querySelector("#valSideZoom");
    if (valZoom) valZoom.textContent = sideZoom;
    const readout = document.querySelector("#sideOrbitReadout");
    if (readout) readout.textContent = `Góc: ${sideRot}° | Nghiêng: ${sideTilt}° | Zoom: ${sideZoom}`;

    drawSideOrbit();
    return prompt;
  }

  function initSideOrbit() {
    const canvas = document.querySelector("#sideOrbitCanvas");
    if (!canvas) return;

    let dragging = false, startX = 0, startY = 0, startRot = 0, startTilt = 0;

    const onStart = (e) => {
      dragging = true;
      canvas.style.cursor = "grabbing";
      const pos = e.touches ? e.touches[0] : e;
      startX = pos.clientX;
      startY = pos.clientY;
      startRot = sideRot;
      startTilt = sideTilt;
    };

    const onMove = (e) => {
      if (!dragging) return;
      const pos = e.touches ? e.touches[0] : e;
      const dx = pos.clientX - startX;
      const dy = pos.clientY - startY;

      let newRot = Math.round((startRot + dx * 0.75) / 15) * 15;
      newRot = Math.max(-180, Math.min(180, newRot));

      let newTilt = Math.round((startTilt - dy * 0.6) / 15) * 15;
      newTilt = Math.max(-60, Math.min(90, newTilt));

      sideRot = newRot;
      sideTilt = newTilt;
      const rRot = document.querySelector("#rangeSideRot");
      if (rRot) rRot.value = sideRot;
      const rTilt = document.querySelector("#rangeSideTilt");
      if (rTilt) rTilt.value = sideTilt;
      updateSideAnglePrompt();
    };

    const onEnd = () => {
      dragging = false;
      canvas.style.cursor = "grab";
    };

    canvas.addEventListener("mousedown", onStart);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onEnd);
    canvas.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: true });
    window.addEventListener("touchend", onEnd);

    document.querySelector("#rangeSideRot")?.addEventListener("input", (e) => {
      sideRot = +e.target.value;
      updateSideAnglePrompt();
    });
    document.querySelector("#rangeSideTilt")?.addEventListener("input", (e) => {
      sideTilt = +e.target.value;
      updateSideAnglePrompt();
    });
    document.querySelector("#rangeSideZoom")?.addEventListener("input", (e) => {
      sideZoom = +e.target.value;
      updateSideAnglePrompt();
    });
    document.querySelector("#selectSidePreset")?.addEventListener("change", () => {
      updateSideAnglePrompt();
    });

    document.querySelector("#btnSubmitAngle")?.addEventListener("click", async () => {
      const ref = document.querySelector("#inputAngleRef")?.value.trim();
      if (!ref) {
        setFeedback("Vui lòng nhập tên ảnh gốc hoặc nhân vật đã có trong Flow!", false);
        return;
      }
      const prompt = updateSideAnglePrompt();
      const ratio = document.querySelector("#selectAngleRatio")?.value || "9:16";
      const count = parseInt(document.querySelector("#selectAngleCount")?.value || "1", 10);
      const btn = document.querySelector("#btnSubmitAngle");
      const btnTextEl = document.querySelector("#txtBtnSubmitAngle");

      await executeGenerationTask({
        type: "image",
        prompt,
        aspect_ratio: ratio,
        count,
        attachments: [{ assetName: ref }],
        btn,
        btnTextEl,
        defaultTextKey: "sidebar.btnSubmitAngle"
      });
    });

    updateSideAnglePrompt();
  }

  // Initialize
  const initLocale = typeof I18n !== "undefined" ? I18n.init() : Promise.resolve();
  initLocale.then(() => {
    applyLanguage();
    initSideOrbit();
    return fetchStatus();
  }).then(() => {
    return loadFlowCharacters();
  });

  // Auto poll status periodically
  setInterval(fetchStatus, 3000);
})();
