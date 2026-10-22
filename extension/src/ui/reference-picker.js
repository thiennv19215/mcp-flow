(() => {
  "use strict";

  function createFlowReferencePicker({ dispatchFlowOperation, setFeedback }) {
    if (typeof dispatchFlowOperation !== "function") throw new TypeError("Flow reference picker requires a Flow operation dispatcher.");
    const t = (key, fallback) => window.I18n?.t?.(`sidebar.${key}`) || fallback;
    const references = { image: [], video: [] };
    const frameSources = [];
    let pickerType = "image";
    let pickerPurpose = "references";
    let onFrameSourcesChanged = null;
    let pickerFlowAssets = [];
    let pickerFlowSelection = new Map();
    let pickerLocalFiles = [];
    let pickerSelectionOrder = [];
    let pickerFlowLoading = false;
    let pickerFlowScanned = false;
    let pickerSession = 0;
    let pickerVisibleLimit = 20;
    let pickerScanLimit = 120;
    let pickerScannedCount = 0;

    const modal = document.querySelector("#referencePickerModal");
    const flowGrid = document.querySelector("#refPickerFlowGrid");
    const flowMessage = document.querySelector("#refPickerFlowMessage");
    const flowPanel = document.querySelector("#refPickerFlowPanel");
    const uploadPanel = document.querySelector("#refPickerUploadPanel");
    const searchInput = document.querySelector("#refPickerSearch");
    const localList = document.querySelector("#refPickerLocalList");
    const fileInput = document.querySelector("#refPickerFileInput");
    if (!modal || !flowGrid || !flowPanel || !uploadPanel || !searchInput || !localList || !fileInput) {
      throw new Error("Flow reference picker UI is incomplete.");
    }

    const supportedReferenceId = value => typeof value === "string" && (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) || value.startsWith("asb:")
    );
    const referencesFor = type => references[type === "image" ? "image" : "video"];
    const localFileKey = file => `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
    const normalizeReferenceId = value => String(value || "").toLowerCase();
    const selectionLimit = () => pickerPurpose === "frames" ? 100 : 3;
    const selectedCount = () => pickerPurpose === "frames" ? frameSources.length + pickerFlowSelection.size + pickerLocalFiles.length
      : referencesFor(pickerType).length + pickerFlowSelection.size + pickerLocalFiles.length;
    const hasFrameSource = source => frameSources.some(item => item.source === "flow"
      ? source.source === "flow" && normalizeReferenceId(item.id) === normalizeReferenceId(source.id)
      : source.source === "local" && localFileKey(item.file) === localFileKey(source.file));
    const hasLocalFile = file => (pickerPurpose === "frames" ? frameSources : referencesFor(pickerType))
      .some(item => item.source === "local" && localFileKey(item.file) === localFileKey(file));

    function renderReferenceCards(type) {
      const isImage = type === "image";
      const list = referencesFor(type);
      const cardsList = document.querySelector(isImage ? "#refCardsListImage" : "#refCardsListVideo");
      const uploadSlot = document.querySelector(isImage ? "#refUploadSlotImage" : "#refUploadSlotVideo");
      const countBadge = document.querySelector(isImage ? "#refImageCountImage" : "#refImageCountVideo");
      if (!cardsList || !uploadSlot) return;
      if (countBadge) countBadge.textContent = `${list.length}/3 ảnh`;
      cardsList.querySelectorAll(".ref-card").forEach(element => element.remove());

      list.forEach((reference, index) => {
        const card = document.createElement("div");
        card.className = "ref-card";
        const img = document.createElement("img");
        const isFlowAsset = reference.source === "flow";
        if (isFlowAsset && reference.thumbnailUrl) img.src = reference.thumbnailUrl;
        else if (!isFlowAsset) {
          if (!reference.previewUrl) reference.previewUrl = URL.createObjectURL(reference.file);
          img.src = reference.previewUrl;
        } else img.style.display = "none";
        img.alt = reference.name || "Ảnh tham chiếu";
        img.onerror = () => { img.style.display = "none"; };

        const badge = document.createElement("div");
        badge.className = "ref-badge";
        badge.textContent = String(index + 1);
        const tag = document.createElement("div");
        tag.className = "ref-tag";
        tag.textContent = reference.name || "Ảnh tham chiếu";
        tag.title = `${isFlowAsset ? "Ảnh trên Flow" : "Chờ upload"}: ${reference.name || "Ảnh tham chiếu"}`;
        const remove = document.createElement("button");
        remove.className = "ref-remove-btn";
        remove.type = "button";
        remove.title = "Xóa ảnh này";
        remove.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
        remove.onclick = event => {
          event.stopPropagation();
          const [removed] = list.splice(index, 1);
          if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
          renderReferenceCards(type);
        };
        card.append(img, badge, tag, remove);
        cardsList.insertBefore(card, uploadSlot);
      });
      uploadSlot.style.display = list.length >= 3 ? "none" : "flex";
    }

    function addLocalFilesToReferences(type, files) {
      const list = referencesFor(type);
      for (const file of files) {
        if (!file?.type?.startsWith("image/") || list.length >= 3) continue;
        const key = localFileKey(file);
        if (list.some(item => item.source === "local" && localFileKey(item.file) === key)) continue;
        list.push({ source: "local", file, name: file.name || "Ảnh mới", previewUrl: URL.createObjectURL(file) });
      }
      renderReferenceCards(type);
    }

    function renderFlowPickerAssets() {
      const query = (searchInput.value || "").trim().toLocaleLowerCase();
      const list = pickerFlowAssets.filter(asset => asset.kind === "image" && !asset.busy && !asset.error && asset.ready !== false)
        .filter(asset => !query || String(asset.name || "").toLocaleLowerCase().includes(query));
      const assetCount = document.querySelector("#refPickerAssetCount");
      const moreButton = document.querySelector("#refPickerMore");
      if (assetCount) assetCount.textContent = `Tìm thấy ${list.length} ảnh`;
      if (moreButton) {
        moreButton.hidden = (list.length <= pickerVisibleLimit && pickerScannedCount < pickerScanLimit) || pickerFlowLoading;
        moreButton.textContent = list.length > pickerVisibleLimit
          ? `⊕  Xem thêm ${list.length - pickerVisibleLimit} ảnh`
          : pickerScannedCount >= pickerScanLimit ? "⊕  Quét thêm ảnh trên Flow" : "";
      }
      flowGrid.replaceChildren();
      const selectedReferences = pickerPurpose === "frames" ? frameSources : referencesFor(pickerType);
      const existingIds = new Set(selectedReferences.filter(item => item.source === "flow").map(item => normalizeReferenceId(item.id)));
      for (const asset of list.slice(0, pickerVisibleLimit)) {
        const assetId = String(asset.id || "");
        const normalizedAssetId = normalizeReferenceId(assetId);
        const isExisting = existingIds.has(normalizedAssetId);
        const isPicked = pickerFlowSelection.has(assetId);
        const canIdentifySafely = supportedReferenceId(assetId);
        const button = document.createElement("button");
        button.type = "button";
        button.className = `ref-picker-asset${isExisting || isPicked ? " selected" : ""}`;
        button.title = isExisting ? "Đã có trong danh sách tham chiếu" : !canIdentifySafely ? "Flow không cung cấp media ID ổn định cho ảnh này" : asset.name || "Ảnh Flow";
        button.disabled = isExisting || (!canIdentifySafely && !isPicked) || (!isPicked && selectedCount() >= selectionLimit());
        if (asset.thumbnailUrl) {
          const thumbnail = document.createElement("img");
          thumbnail.src = asset.thumbnailUrl;
          thumbnail.alt = "";
          thumbnail.loading = "lazy";
          thumbnail.onerror = () => thumbnail.remove();
          button.appendChild(thumbnail);
        } else {
          const placeholder = document.createElement("div");
          placeholder.className = "ref-picker-asset-placeholder";
          placeholder.textContent = "▧";
          button.appendChild(placeholder);
        }
        if (isExisting || isPicked) {
          const check = document.createElement("span");
          check.className = "ref-picker-check";
          check.textContent = isExisting
            ? String(selectedReferences.findIndex(item => item.source === "flow" && normalizeReferenceId(item.id) === normalizedAssetId) + 1)
            : String(pickerSelectionOrder.indexOf(pickerFlowSelection.get(assetId)) + 1);
          button.appendChild(check);
        }
        const name = document.createElement("span");
        name.className = "ref-picker-asset-name";
        name.textContent = asset.name || "Ảnh không tên";
        button.appendChild(name);
        button.onclick = () => {
          if (!canIdentifySafely || isExisting) return;
          if (pickerFlowSelection.has(assetId)) {
            const selectedReference = pickerFlowSelection.get(assetId);
            pickerFlowSelection.delete(assetId);
            pickerSelectionOrder = pickerSelectionOrder.filter(item => item !== selectedReference);
          } else if (selectedCount() < selectionLimit()) {
            const selectedReference = {
              source: "flow", id: assetId, name: asset.name,
              assetName: `asset:${asset.name}`, expectedId: assetId, thumbnailUrl: asset.thumbnailUrl || ""
            };
            pickerFlowSelection.set(assetId, selectedReference);
            pickerSelectionOrder.push(selectedReference);
          }
          updatePickerCount();
        };
        flowGrid.appendChild(button);
      }
      if (flowMessage) {
        flowMessage.hidden = !pickerFlowLoading && list.length > 0;
        if (pickerFlowLoading) flowMessage.textContent = "Đang quét thư viện ảnh Flow...";
        else if (!list.length) flowMessage.textContent = query ? "Không tìm thấy ảnh khớp." : "Không tìm thấy ảnh sẵn sàng trong thư viện Flow. Hãy mở dự án Flow rồi quét lại.";
      }
    }

    function updatePickerCount() {
      const existingCount = pickerPurpose === "frames" ? frameSources.length : referencesFor(pickerType).length;
      const pendingCount = pickerSelectionOrder.length;
      const countValue = Math.min(selectionLimit(), existingCount + pendingCount);
      const count = document.querySelector("#refPickerCount");
      if (count) count.textContent = pickerPurpose === "frames"
        ? `${countValue} ảnh nguồn${existingCount ? ` · ${existingCount} đã thêm` : ""}`
        : `${countValue}/3 ảnh đã chọn${existingCount ? ` (${existingCount} đã có)` : ""}`;
      const confirm = document.querySelector("#refPickerConfirm");
      if (confirm) confirm.disabled = pendingCount === 0 || existingCount + pendingCount > selectionLimit();
      renderFlowPickerAssets();
    }

    async function loadFlowPickerAssets() {
      if (pickerFlowLoading) return;
      const session = pickerSession;
      pickerFlowLoading = true;
      pickerFlowScanned = false;
      if (flowMessage) {
        flowMessage.hidden = false;
        flowMessage.textContent = "Đang quét thư viện ảnh Flow...";
      }
      const refresh = document.querySelector("#refPickerRefresh");
      if (refresh) refresh.disabled = true;
      renderFlowPickerAssets();
      try {
        const result = await dispatchFlowOperation("flow.assets.list", { includeIncomplete: true, maxItems: pickerScanLimit });
        const assets = Array.isArray(result) ? result : (result?.assets || []);
        if (session !== pickerSession) return;
        pickerScannedCount = assets.length;
        pickerFlowAssets = assets.filter(asset => asset && asset.kind === "image" && typeof asset.name === "string");
        pickerVisibleLimit = 20;
        pickerFlowScanned = true;
        renderFlowPickerAssets();
      } catch (error) {
        if (session !== pickerSession) return;
        pickerFlowAssets = [];
        pickerScannedCount = 0;
        if (flowMessage) {
          flowMessage.hidden = false;
          flowMessage.textContent = `${error.message || "Không thể tải ảnh Flow."} Mở Flow ở mục All media rồi bấm Quét lại.`;
        }
      } finally {
        if (session !== pickerSession) return;
        pickerFlowLoading = false;
        if (refresh) refresh.disabled = false;
        renderFlowPickerAssets();
      }
    }

    function setPickerTab(tab) {
      const showFlow = tab === "flow";
      flowPanel.hidden = !showFlow;
      uploadPanel.hidden = showFlow;
      document.querySelectorAll("[data-ref-picker-tab]").forEach(button => button.classList.toggle("active", button.dataset.refPickerTab === tab));
      if (showFlow && !pickerFlowScanned && !pickerFlowLoading) loadFlowPickerAssets();
    }

    function renderPickerLocalFiles() {
      localList.replaceChildren();
      pickerLocalFiles.forEach((entry, index) => {
        const row = document.createElement("div");
        row.className = "ref-picker-local-row";
        const img = document.createElement("img");
        img.src = entry.previewUrl;
        img.alt = "";
        const name = document.createElement("span");
        name.textContent = entry.file.name;
        name.title = entry.file.name;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "btn btn-secondary";
        remove.style.cssText = "width:auto;padding:4px 8px;margin-left:auto";
        remove.textContent = "×";
        remove.title = "Bỏ ảnh này";
        remove.onclick = () => {
          URL.revokeObjectURL(entry.previewUrl);
          pickerLocalFiles.splice(index, 1);
          pickerSelectionOrder = pickerSelectionOrder.filter(item => item !== entry);
          renderPickerLocalFiles();
          updatePickerCount();
        };
        row.append(img, name, remove);
        localList.appendChild(row);
      });
    }

    function open(type, purpose = "references") {
      pickerSession++;
      pickerType = type === "image" ? "image" : "video";
      pickerPurpose = purpose === "frames" ? "frames" : "references";
      pickerFlowAssets = [];
      pickerVisibleLimit = 20;
      pickerScanLimit = 120;
      pickerScannedCount = 0;
      pickerFlowSelection = new Map();
      pickerLocalFiles = [];
      pickerSelectionOrder = [];
      pickerFlowLoading = false;
      pickerFlowScanned = false;
      searchInput.value = "";
      localList.replaceChildren();
      document.querySelector("#refPickerTitle").textContent = pickerPurpose === "frames" ? t("framePickerTitle", "Chọn ảnh nguồn Frames") : t("referencePickerTitle", "Chọn / Tải ảnh lên");
      document.querySelector("#refPickerLimitHint").textContent = pickerPurpose === "frames" ? t("framePickerLimit", "Tối đa 100 ảnh nguồn") : t("referencePickerLimit", "Tối đa 3 ảnh tham chiếu");
      document.querySelector("#refPickerUploadHint").textContent = pickerPurpose === "frames"
        ? t("framePickerUploadHint", "Ảnh sẽ được tải lên Flow trước khi xếp các prompt vào hàng đợi.")
        : t("referencePickerUploadHint", "Ảnh sẽ được tải lên Flow khi bạn bấm Tạo ảnh hoặc Tạo video.");
      document.querySelector('[data-ref-picker-tab="flow"]').textContent = pickerPurpose === "frames" ? t("framePickerFlowTab", "Thư viện Flow") : t("referencePickerFlowTab", "Ảnh trên Flow");
      document.querySelector('[data-ref-picker-tab="upload"]').textContent = pickerPurpose === "frames" ? t("framePickerLocalTab", "Máy tính") : t("referencePickerLocalTab", "Upload");
      document.querySelector("#refPickerConfirm").textContent = pickerPurpose === "frames" ? t("framePickerConfirm", "Thêm nguồn") : t("referencePickerConfirm", "Xác nhận");
      modal.hidden = false;
      document.body.style.overflow = "hidden";
      // Local upload is the common path and must stay responsive even when a
      // Flow project contains a very large gallery. Scan Flow only on demand.
      setPickerTab("upload");
      updatePickerCount();
      document.querySelector("#refPickerClose").focus();
    }

    function close({ confirmed = false } = {}) {
      pickerSession++;
      pickerFlowLoading = false;
      const refresh = document.querySelector("#refPickerRefresh");
      if (refresh) refresh.disabled = false;
      if (!confirmed) pickerLocalFiles.forEach(entry => URL.revokeObjectURL(entry.previewUrl));
      pickerLocalFiles = [];
      pickerFlowSelection.clear();
      pickerSelectionOrder = [];
      modal.hidden = true;
      document.body.style.overflow = "";
    }

    document.querySelectorAll("[data-ref-picker-tab]").forEach(button => {
      button.onclick = () => setPickerTab(button.dataset.refPickerTab);
    });
    document.querySelector("#refPickerClose").onclick = () => close();
    document.querySelector("#refPickerCancel").onclick = () => close();
    document.querySelector("#refPickerRefresh").onclick = () => loadFlowPickerAssets();
    searchInput.oninput = () => { pickerVisibleLimit = 20; renderFlowPickerAssets(); };
    document.querySelector("#refPickerMore").onclick = () => {
      if (pickerVisibleLimit < pickerFlowAssets.length) {
        pickerVisibleLimit += 20;
        renderFlowPickerAssets();
      } else if (pickerScannedCount >= pickerScanLimit && !pickerFlowLoading) {
        pickerScanLimit += 120;
        loadFlowPickerAssets();
      }
    };
    document.querySelector("#refPickerChooseFiles").onclick = () => fileInput.click();
    fileInput.onchange = event => {
      for (const file of Array.from(event.target.files || [])) {
        if (!file.type.startsWith("image/")) continue;
        if (selectedCount() >= selectionLimit()) break;
        const key = localFileKey(file);
        if (pickerLocalFiles.some(entry => localFileKey(entry.file) === key) || hasLocalFile(file)) continue;
        const entry = { source: "local", file, previewUrl: URL.createObjectURL(file) };
        pickerLocalFiles.push(entry);
        pickerSelectionOrder.push(entry);
      }
      fileInput.value = "";
      renderPickerLocalFiles();
      updatePickerCount();
    };
    const dropTarget = document.querySelector("#refPickerDrop");
    dropTarget.ondragover = event => { event.preventDefault(); dropTarget.style.borderColor = "var(--primary)"; };
    dropTarget.ondragleave = () => { dropTarget.style.borderColor = ""; };
    dropTarget.ondrop = event => {
      event.preventDefault();
      dropTarget.style.borderColor = "";
      for (const file of Array.from(event.dataTransfer?.files || [])) {
        if (!file.type.startsWith("image/")) continue;
        if (selectedCount() >= selectionLimit()) break;
        const key = localFileKey(file);
        if (pickerLocalFiles.some(entry => localFileKey(entry.file) === key) || hasLocalFile(file)) continue;
        const entry = { source: "local", file, previewUrl: URL.createObjectURL(file) };
        pickerLocalFiles.push(entry);
        pickerSelectionOrder.push(entry);
      }
      renderPickerLocalFiles();
      updatePickerCount();
    };
    modal.onclick = event => { if (event.target === modal) close(); };
    document.addEventListener("keydown", event => { if (event.key === "Escape" && !modal.hidden) close(); });
    document.querySelector("#refPickerConfirm").onclick = () => {
      const list = referencesFor(pickerType);
      const pending = [...pickerSelectionOrder].map(entry => entry.source === "local"
        ? { ...entry, name: entry.file.name || "Ảnh mới" }
        : entry);
      if (pickerPurpose === "frames") {
        const additions = pending.filter(entry => !hasFrameSource(entry)).slice(0, Math.max(0, selectionLimit() - frameSources.length));
        if (!additions.length) {
          setFeedback?.(t("framePickerNeedSource", "Hãy chọn ít nhất một ảnh mới làm nguồn Frames."), false);
          return;
        }
        frameSources.push(...additions);
        onFrameSourcesChanged?.([...frameSources]);
        close({ confirmed: true });
        return;
      }
      if (list.length + pending.length > 3) {
        setFeedback?.(t("referencePickerTooMany", "Flow chỉ nhận tối đa 3 ảnh tham chiếu. Hãy bỏ bớt ảnh rồi thử lại."), false);
        return;
      }
      list.push(...pending);
      renderReferenceCards(pickerType);
      close({ confirmed: true });
    };

    for (const type of ["image", "video"]) {
      const isImage = type === "image";
      const uploadSlot = document.querySelector(isImage ? "#refUploadSlotImage" : "#refUploadSlotVideo");
      const dropzoneHint = document.querySelector(isImage ? "#refDropzoneHintImage" : "#refDropzoneHintVideo");
      const cardsList = document.querySelector(isImage ? "#refCardsListImage" : "#refCardsListVideo");
      if (!uploadSlot) continue;
      uploadSlot.onclick = () => open(type);
      if (dropzoneHint) dropzoneHint.onclick = () => open(type);
      const dropContainer = cardsList?.parentElement;
      if (!dropContainer) continue;
      dropContainer.ondragover = event => { event.preventDefault(); dropContainer.style.borderColor = "var(--primary)"; };
      dropContainer.ondragleave = () => { dropContainer.style.borderColor = ""; };
      dropContainer.ondrop = event => {
        event.preventDefault();
        dropContainer.style.borderColor = "";
        addLocalFilesToReferences(type, Array.from(event.dataTransfer?.files || []));
      };
    }

    return {
      getReferences: referencesFor,
      getFrameSources: () => [...frameSources],
      removeFrameSource: source => {
        const index = frameSources.indexOf(source);
        if (index < 0) return [...frameSources];
        const [removed] = frameSources.splice(index, 1);
        if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
        return [...frameSources];
      },
      moveFrameSource: (source, delta) => {
        const index = frameSources.indexOf(source);
        const target = Math.max(0, Math.min(frameSources.length - 1, index + Math.trunc(Number(delta) || 0)));
        if (index >= 0 && target !== index) frameSources.splice(target, 0, frameSources.splice(index, 1)[0]);
        return [...frameSources];
      },
      openFrames: onChanged => { onFrameSourcesChanged = onChanged; open("video", "frames"); },
    };
  }

  window.createFlowReferencePicker = createFlowReferencePicker;
})();
