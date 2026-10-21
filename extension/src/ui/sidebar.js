(function () {
  "use strict";

  let cachedStatus = null;
  const logs = [];
  let currentCharacters = [];
  let flowProjects = [];
  let flowAssets = [];

  async function dispatchFlowOperation(operation, payload = {}) {
    const response = await chrome.runtime.sendMessage({ type: "flow-mcp:dispatch", operation, payload });
    if (!response?.ok) throw new Error(response?.error?.message || `Flow operation failed: ${operation}`);
    return response.value;
  }

  async function assertQueueIdleForDirectAction() {
    const response = await chrome.runtime.sendMessage({ type: "flow-queue:get" });
    const jobs = response?.snapshot?.jobs || response?.jobs || [];
    if (!response?.ok || response.isRunning || jobs.some(job => ["running", "queued", "pending"].includes(job.status))) {
      throw new Error("Hãy đợi hàng đợi Flow trống trước khi thực hiện thao tác này.");
    }
  }

  function showLibraryResult(value) {
    const output = document.querySelector("#flowLibraryResult");
    if (output) output.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  }

  function fillSelect(select, items, getValue, getLabel, placeholder) {
    if (!select) return;
    const previous = select.value;
    select.replaceChildren();
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = placeholder;
    select.appendChild(empty);
    for (const item of items) {
      const value = String(getValue(item) || "");
      if (!value) continue;
      const option = document.createElement("option");
      option.value = value;
      option.textContent = String(getLabel(item) || value);
      select.appendChild(option);
    }
    if ([...select.options].some(option => option.value === previous)) select.value = previous;
  }

  async function runLibraryAction(button, action) {
    if (button) button.disabled = true;
    try {
      const result = await action();
      showLibraryResult(result ?? "Hoàn tất.");
      setFeedback("Thao tác Flow hoàn tất.", true);
      return result;
    } catch (error) {
      showLibraryResult(error.message || String(error));
      setFeedback(error.message || String(error), false);
      return null;
    } finally {
      if (button) button.disabled = false;
    }
  }

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
  let flowQueuePanel = null;

  // Listen for real-time progress broadcast from background/Flow
  chrome.runtime.onMessage.addListener(msg => {
    if (msg?.type === "flow-queue:changed") {
      const jobs = msg.snapshot?.jobs || msg.snapshot?.items || [];
      const active = jobs.find(job => job.status === "running");
      if (active?.progress?.message) setFeedback(`⏳ ${active.progress.message}`, true);
      if (msg.reason === "job-finished") {
        const finished = [...jobs].reverse().find(job => job.status === "completed" || job.status === "failed");
        if (finished?.status === "completed") {
          const isCharacter = finished.operation === "flow.character.create" || finished.operation === "flow.character.edit";
          setFeedback(isCharacter ? "✅ Đã hoàn tất thao tác nhân vật trong Flow." : "✅ Tác vụ Flow hoàn tất.", true);
          addLog(isCharacter ? "flow.character.create" : "flow.operation.complete", finished.label || finished.name || "Flow job", true);
          if (isCharacter) void loadFlowCharacters();
        } else if (finished?.status === "failed") {
          setFeedback(`❌ ${finished.error || "Tác vụ Flow thất bại."}`, false);
          addLog("flow.generation.failed", finished.error || "Flow job failed", false);
        }
      }
      return;
    }
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

  async function executeGenerationTask({ type, prompt, aspect_ratio, count = 1, model, attachments = [], video_settings, btn, btnTextEl, defaultTextKey }) {
    if (isGenerating) {
      setFeedback("Đang có tác vụ đang chạy, vui lòng đợi!", false);
      return;
    }
    isGenerating = true;
    if (btn) btn.disabled = true;

    try {
      const payload = {
          type,
          prompt,
          ...(model ? { model } : {}),
          aspectRatio: aspect_ratio,
          aspect_ratio,
          variants: count,
          count,
          attachments,
          ...(video_settings || {})
      };
      const addResult = await chrome.runtime.sendMessage({
        type: "flow-queue:add",
        job: { operation: "flow.generation.submit", payload, label: `[${type.toUpperCase()}] ${prompt.slice(0, 96)}` }
      });
      if (!addResult?.ok) throw new Error(addResult?.error?.message || "Không thể thêm tác vụ vào hàng đợi Flow");
      const startResult = await chrome.runtime.sendMessage({ type: "flow-queue:resume" });
      if (!startResult?.ok) throw new Error(startResult?.error?.message || "Không thể chạy hàng đợi Flow");
      setFeedback("Đã thêm vào hàng đợi Flow.", true);
      addLog("flow.queue.add", `[${type.toUpperCase()}] ${prompt.slice(0, 96)}`, true);
    } catch (err) {
      setFeedback(`❌ ${err.message}`, false);
      addLog("flow.queue.error", err.message, false);
    } finally {
      isGenerating = false;
      if (btn) btn.disabled = false;
      if (btnTextEl && defaultTextKey) btnTextEl.textContent = t(defaultTextKey);
    }
  }

  const referencePicker = window.createFlowReferencePicker({ dispatchFlowOperation, setFeedback });

  async function uploadReferenceImage(file, onProgress) {
    if (window.FlowUploadClient) {
      return await window.FlowUploadClient.upload(file, { onProgress, kind: "image" });
    }
    throw new Error("Dịch vụ tải ảnh lên Flow chưa được khởi tạo");
  }

  async function assertQueueIdleForReferenceUpload() {
    const state = await chrome.runtime.sendMessage({ type: "flow-queue:get" });
    if (!state?.ok || state.isRunning) {
      throw new Error("Hàng đợi Flow đang chạy. Hãy đợi tác vụ hiện tại hoàn tất rồi tải ảnh tham chiếu.");
    }
  }

  // SUBMIT TẠO ẢNH (GENERATE IMAGE)
  document.querySelector("#btnSubmitImage").onclick = async () => {
    const refFilesImage = referencePicker.getReferences("image");
    const btn = document.querySelector("#btnSubmitImage");
    const btnTextEl = document.querySelector("#txtBtnSubmitImage");
    const prompt = document.querySelector("#inputPromptImage").value.trim();
    if (!prompt) {
      setFeedback("Vui lòng nhập câu lệnh prompt cho ảnh!", false);
      return;
    }
    const aspect_ratio = document.querySelector("#selectRatioImage").value;
    const count = Number(document.querySelector("#selectQtyImage").value) || 1;
    const model = document.querySelector("#selectModelImage")?.value || "nano banana";
    const character = document.querySelector("#selectCharImage").value;

    const attachments = [];
    if (character) {
      attachments.push({ assetName: `character:${character}` });
    }

    try {
      if (btn) btn.disabled = true;
      // Reuse selected Flow media IDs; only newly chosen local files are uploaded.
      const localImageReferences = refFilesImage.filter(reference => reference.source === "local");
      if (localImageReferences.length > 0) {
        try { await assertQueueIdleForReferenceUpload(); }
        catch (error) { setFeedback(error.message, false); return; }
      }
      let uploadedImageCount = 0;
      for (let i = 0; i < refFilesImage.length; i++) {
        const reference = refFilesImage[i];
        if (reference.source === "flow") {
          attachments.push({ assetName: reference.assetName, expectedId: reference.expectedId });
          continue;
        }
        uploadedImageCount++;
        setFeedback(`Đang tải ảnh tham chiếu ${uploadedImageCount}/${localImageReferences.length} lên Flow...`, true);
        const uploaded = await uploadReferenceImage(reference.file);
        const uploadedName = typeof uploaded === "string" ? uploaded : (uploaded?.name || uploaded?.title || String(uploaded));
        const uploadedId = typeof uploaded === "object" ? (uploaded?.id || uploaded?.mediaId) : undefined;
        attachments.push({ assetName: `asset:${uploadedName}`, ...(uploadedId ? { expectedId: uploadedId } : {}) });
      }

      await executeGenerationTask({
        type: "image",
        prompt,
        aspect_ratio,
        count,
        model,
        attachments,
        btn,
        btnTextEl,
        defaultTextKey: "sidebar.btnGenerateImage"
      });
    } catch (err) {
      setFeedback(`❌ ${err.message}`, false);
    } finally {
      if (btn) btn.disabled = false;
      if (btnTextEl) btnTextEl.textContent = t("sidebar.btnGenerateImage");
    }
  };

  // SUBMIT TẠO VIDEO (GENERATE VIDEO)
  document.querySelector("#btnSubmitVideo").onclick = async () => {
    const refFilesVideo = referencePicker.getReferences("video");
    const btn = document.querySelector("#btnSubmitVideo");
    const btnTextEl = document.querySelector("#txtBtnSubmitVideo");
    const prompt = document.querySelector("#inputPromptVideo").value.trim();
    if (!prompt) {
      setFeedback("Vui lòng nhập câu lệnh prompt cho video!", false);
      return;
    }
    const aspect_ratio = document.querySelector("#selectRatioVideo").value;
    const duration = Number(document.querySelector("#selectDurationVideo").value) || 8;
    const model = document.querySelector("#selectModelVideo")?.value || "veo 3.1";
    const resolution = document.querySelector("#selectResolutionVideo")?.value || "1080p";
    const mode = document.querySelector("#selectModeVideo").value || "ingredients";
    const character = document.querySelector("#selectCharVideo").value;

    const attachments = [];
    if (character) {
      attachments.push({ assetName: `character:${character}` });
    }

    try {
      if (btn) btn.disabled = true;
      // Reuse selected Flow media IDs; only newly chosen local files are uploaded.
      const localVideoReferences = refFilesVideo.filter(reference => reference.source === "local");
      if (localVideoReferences.length > 0) {
        try { await assertQueueIdleForReferenceUpload(); }
        catch (error) { setFeedback(error.message, false); return; }
      }
      let uploadedVideoCount = 0;
      for (let i = 0; i < refFilesVideo.length; i++) {
        const reference = refFilesVideo[i];
        if (reference.source === "flow") {
          attachments.push({ assetName: reference.assetName, expectedId: reference.expectedId });
          continue;
        }
        uploadedVideoCount++;
        setFeedback(`Đang tải ảnh tham chiếu ${uploadedVideoCount}/${localVideoReferences.length} lên Flow...`, true);
        const uploaded = await uploadReferenceImage(reference.file);
        const uploadedName = typeof uploaded === "string" ? uploaded : (uploaded?.name || uploaded?.title || String(uploaded));
        const uploadedId = typeof uploaded === "object" ? (uploaded?.id || uploaded?.mediaId) : undefined;
        attachments.push({ assetName: `asset:${uploadedName}`, ...(uploadedId ? { expectedId: uploadedId } : {}) });
      }

      await executeGenerationTask({
        type: "video",
        prompt,
        aspect_ratio,
        count: 1,
        video_settings: {
          mode,
          duration,
          model,
          resolution,
          ...(document.querySelector("#flowVoiceSelect")?.value ? { voice: document.querySelector("#flowVoiceSelect").value } : {})
        },
        attachments,
        btn,
        btnTextEl,
        defaultTextKey: "sidebar.btnGenerateVideo"
      });
    } catch (err) {
      setFeedback(`❌ ${err.message}`, false);
    } finally {
      if (btn) btn.disabled = false;
      if (btnTextEl) btnTextEl.textContent = t("sidebar.btnGenerateVideo");
    }
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
    addLog("flow.queue.add", `Tạo nhân vật: ${name}`, true);

    try {
      const res = await chrome.runtime.sendMessage({
        type: "flow-queue:add",
        job: { operation: "flow.character.create", payload: { name, describe: description }, label: `Nhân vật: ${name}` }
      });
      if (!res?.ok) throw new Error(res?.error?.message || "Không thể thêm tác vụ tạo nhân vật vào hàng đợi");
      const started = await chrome.runtime.sendMessage({ type: "flow-queue:resume" });
      if (!started?.ok) throw new Error(started?.error?.message || "Không thể chạy hàng đợi Flow");
      setFeedback("Đã thêm tác vụ tạo nhân vật vào hàng đợi Flow.", true);
      document.querySelector("#inputCharName").value = "";
      document.querySelector("#inputCharDesc").value = "";
    } catch (err) {
      setFeedback(err.message, false);
      addLog("flow.character.create.error", err.message, false);
    }
  };

  document.querySelector("#btnRefreshProjects").onclick = event => runLibraryAction(event.currentTarget, async () => {
    const result = await dispatchFlowOperation("flow.projects.list");
    flowProjects = Array.isArray(result) ? result : (result?.projects || []);
    fillSelect(document.querySelector("#flowProjectSelect"), flowProjects,
      project => project.id || project.projectId || project.project_id,
      project => project.name || project.title || project.id || project.projectId,
      "Chọn dự án");
    return { projects: flowProjects.length };
  });

  document.querySelector("#btnCreateProject").onclick = event => runLibraryAction(event.currentTarget, async () => {
    await assertQueueIdleForDirectAction();
    const result = await dispatchFlowOperation("flow.project.create");
    await dispatchFlowOperation("flow.projects.list").then(items => {
      flowProjects = Array.isArray(items) ? items : (items?.projects || []);
      fillSelect(document.querySelector("#flowProjectSelect"), flowProjects,
        project => project.id || project.projectId || project.project_id,
        project => project.name || project.title || project.id || project.projectId,
        "Chọn dự án");
    }).catch(() => {});
    return result;
  });

  document.querySelector("#btnOpenProject").onclick = event => runLibraryAction(event.currentTarget, async () => {
    const projectId = document.querySelector("#flowProjectSelect").value;
    if (!projectId) throw new Error("Hãy chọn một dự án.");
    await assertQueueIdleForDirectAction();
    return dispatchFlowOperation("flow.project.open", { projectId, language: "en" });
  });

  document.querySelector("#btnRefreshAssets").onclick = event => runLibraryAction(event.currentTarget, async () => {
    const result = await dispatchFlowOperation("flow.assets.list");
    flowAssets = Array.isArray(result) ? result : (result?.assets || []);
    fillSelect(document.querySelector("#flowAssetSelect"), flowAssets,
      (asset, index) => asset.id || asset.name || String(index),
      asset => asset.name || asset.title || asset.id,
      "Chọn tài sản");
    return { assets: flowAssets.length };
  });

  function selectedFlowAsset() {
    const value = document.querySelector("#flowAssetSelect").value;
    return flowAssets.find((asset, index) => String(asset.id || asset.name || index) === value) || null;
  }

  document.querySelector("#btnDownloadAsset").onclick = event => runLibraryAction(event.currentTarget, async () => {
    const asset = selectedFlowAsset();
    if (!asset) throw new Error("Hãy chọn một tài sản.");
    await assertQueueIdleForDirectAction();
    return dispatchFlowOperation("flow.asset.download", { name: asset.name || asset.title, id: asset.id, quality: "original" });
  });

  document.querySelector("#btnRenameAsset").onclick = event => runLibraryAction(event.currentTarget, async () => {
    const asset = selectedFlowAsset();
    const newName = document.querySelector("#flowAssetNewName").value.trim();
    if (!asset || !newName) throw new Error("Chọn tài sản và nhập tên mới.");
    await assertQueueIdleForDirectAction();
    const result = await dispatchFlowOperation("flow.asset.rename", { name: asset.name || asset.title, id: asset.id, newName });
    document.querySelector("#flowAssetNewName").value = "";
    return result;
  });

  document.querySelector("#btnTrashAsset").onclick = event => runLibraryAction(event.currentTarget, async () => {
    const asset = selectedFlowAsset();
    if (!asset) throw new Error("Hãy chọn một tài sản.");
    if (!window.confirm(`Chuyển “${asset.name || asset.title}” vào thùng rác Flow?`)) return "Đã hủy.";
    await assertQueueIdleForDirectAction();
    const result = await dispatchFlowOperation("flow.asset.trash", { name: asset.name || asset.title, id: asset.id });
    return result;
  });

  document.querySelector("#btnRefreshLibraryCharacters").onclick = event => runLibraryAction(event.currentTarget, async () => {
    const result = await dispatchFlowOperation("flow.characters.list");
    currentCharacters = Array.isArray(result) ? result : (result?.characters || []);
    populateCharacterSelects();
    fillSelect(document.querySelector("#flowLibraryCharacterSelect"), currentCharacters,
      character => typeof character === "string" ? character : character.name,
      character => typeof character === "string" ? character : character.name,
      "Chọn nhân vật");
    return { characters: currentCharacters.length };
  });

  document.querySelector("#btnEditCharacter").onclick = async event => {
    const selected = document.querySelector("#flowLibraryCharacterSelect").value;
    const rename = document.querySelector("#flowCharacterNewName").value.trim();
    const change = document.querySelector("#flowCharacterChange").value.trim();
    if (!selected || (!rename && !change)) {
      setFeedback("Chọn nhân vật và nhập tên mới hoặc mô tả thay đổi.", false);
      return;
    }
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({ type: "flow-queue:add", job: {
        operation: "flow.character.edit", payload: { name: selected, ...(rename ? { rename } : {}), ...(change ? { change } : {}) },
        label: `Chỉnh sửa nhân vật: ${selected}`
      }});
      if (!response?.ok) throw new Error(response?.error?.message || "Không thể thêm chỉnh sửa vào hàng đợi.");
      const started = await chrome.runtime.sendMessage({ type: "flow-queue:resume" });
      if (!started?.ok) throw new Error(started?.error?.message || "Không thể chạy hàng đợi Flow.");
      document.querySelector("#flowCharacterNewName").value = "";
      document.querySelector("#flowCharacterChange").value = "";
      setFeedback("Đã đưa chỉnh sửa nhân vật vào hàng đợi Flow.", true);
      showLibraryResult({ queued: true, operation: "flow.character.edit", name: selected });
    } catch (error) { setFeedback(error.message, false); showLibraryResult(error.message); }
    finally { button.disabled = false; }
  };

  document.querySelector("#btnAttachReferences").onclick = event => runLibraryAction(event.currentTarget, async () => {
    const references = document.querySelector("#flowReferenceInput").value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    if (!references.length) throw new Error("Nhập ít nhất một tham chiếu.");
    await assertQueueIdleForDirectAction();
    return dispatchFlowOperation("flow.references.attach", { references });
  });

  document.querySelector("#btnClearReferences").onclick = event => runLibraryAction(event.currentTarget, async () => {
    await assertQueueIdleForDirectAction();
    return dispatchFlowOperation("flow.references.clear", {});
  });

  document.querySelector("#btnUploadMedia").onclick = event => runLibraryAction(event.currentTarget, async () => {
    const file = document.querySelector("#flowUploadFile").files?.[0];
    if (!file) throw new Error("Chọn một tệp ảnh hoặc video.");
    if (!window.FlowUploadClient) throw new Error("Dịch vụ tải media lên chưa sẵn sàng.");
    await assertQueueIdleForDirectAction();
    const kind = file.type.startsWith("video/") ? "video" : "image";
    const uploaded = await window.FlowUploadClient.upload(file, { kind, onProgress: progress => setFeedback(`Đang tải tệp lên Flow: ${progress}%`, true) });
    document.querySelector("#flowUploadFile").value = "";
    return uploaded;
  });

  document.querySelector("#btnLoadVoices").onclick = event => runLibraryAction(event.currentTarget, async () => {
    const result = await dispatchFlowOperation("flow.voices.options");
    const voices = Array.isArray(result?.voices) ? result.voices : [];
    fillSelect(document.querySelector("#flowVoiceSelect"), voices,
      voice => typeof voice === "string" ? voice : voice.name,
      voice => typeof voice === "string" ? voice : voice.name,
      "Không dùng giọng nói");
    return result;
  });

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

  // Initialize
  const initLocale = typeof I18n !== "undefined" ? I18n.init() : Promise.resolve();
  const queueContainer = document.querySelector("#flowQueuePanel");
  if (queueContainer && window.FlowQueuePanel) flowQueuePanel = new window.FlowQueuePanel(queueContainer).mount();
  initLocale.then(() => {
    applyLanguage();
    return fetchStatus();
  }).then(() => {
    return loadFlowCharacters();
  });

  // Auto poll status periodically
  setInterval(fetchStatus, 3000);
})();
