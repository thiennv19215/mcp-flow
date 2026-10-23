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
    let onFramesConfirmed = null;
    let pickerFlowAssets = [];
    let pickerFlowSelection = new Map();
    let pickerLocalFiles = [];
    let pickerSelectionOrder = [];
    let pickerFlowLoading = false;
    let pickerFlowScanned = false;
    let pickerProjectId = null;
    let pendingPreviousProjectId = null;
    let pickerProjectEpoch = 0;
    const flowAssetCacheByProject = new Map();
    let pickerVisibleLimit = 20;
    let pickerScanLimit = 120;
    let pickerScannedCount = 0;
    const flowThumbnailProxyCache = new Map();

    function notifyFrameSourcesChanged() {
      onFrameSourcesChanged?.([...frameSources]);
    }

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
    const normalizeType = type => String(type || "").toLowerCase() === "video" ? "video" : "image";
    const referencesFor = type => references[normalizeType(type)];
    const localFileKey = file => `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
    const isVideoFile = file => file?.type?.startsWith("video/") || /\.(mp4|mov|webm|mkv|avi|m4v)$/i.test(String(file?.name || ""));
    const normalizeReferenceId = value => String(value || "").toLowerCase();
    const selectionLimit = () => pickerPurpose === "frames" ? 100 : 3;
    const selectedCount = () => pickerPurpose === "frames" ? frameSources.length + pickerFlowSelection.size + pickerLocalFiles.length
      : referencesFor(pickerType).length + pickerFlowSelection.size + pickerLocalFiles.length;
    const hasFrameSource = source => frameSources.some(item => item.source === "flow"
      ? source.source === "flow" && normalizeReferenceId(item.id) === normalizeReferenceId(source.id)
      : source.source === "local" && localFileKey(item.file) === localFileKey(source.file));
    const hasLocalFile = file => (pickerPurpose === "frames" ? frameSources : referencesFor(pickerType))
      .some(item => item.source === "local" && localFileKey(item.file) === localFileKey(file));

    function normalizeFlowThumbnailUrl(asset) {
      const candidate = asset?.thumbnailUrl || asset?.thumbnail_url || asset?.thumbnail || asset?.previewUrl || asset?.posterUrl || asset?.poster || asset?.src;
      if (typeof candidate !== "string" || !candidate.trim()) return "";
      try {
        const parsed = new URL(candidate, location.href);
        if (parsed.protocol !== "https:") return "";
        return parsed.href;
      } catch {
        return "";
      }
    }

    function isFlowThumbnailHost(url) {
      try {
        const host = new URL(url).hostname.toLowerCase();
        return host === "flow.google.com" || host === "labs.google" || host.endsWith(".googleusercontent.com") ||
          host.endsWith(".googleapis.com") || host === "storage.googleapis.com" || host.endsWith(".usercontent.goog");
      } catch {
        return false;
      }
    }

    function proxyFlowThumbnail(url) {
      if (!isFlowThumbnailHost(url)) return Promise.resolve("");
      const cached = flowThumbnailProxyCache.get(url);
      if (cached) return cached;
      const pending = (async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15_000);
        try {
          const response = await fetch(url, { credentials: "include", cache: "force-cache", signal: controller.signal });
          if (!response.ok) return "";
          const blob = await response.blob();
          if (!blob.size || blob.size > 3 * 1024 * 1024 || !/^image\//i.test(blob.type || "")) return "";
          return URL.createObjectURL(blob);
        } catch {
          return "";
        } finally {
          clearTimeout(timeout);
        }
      })();
      flowThumbnailProxyCache.set(url, pending);
      if (flowThumbnailProxyCache.size > 100) flowThumbnailProxyCache.delete(flowThumbnailProxyCache.keys().next().value);
      void pending.then(result => { if (!result) flowThumbnailProxyCache.delete(url); });
      return pending;
    }

    function bindFlowThumbnail(img, url, onUnavailable) {
      let proxyAttempted = false;
      img.onerror = async () => {
        if (proxyAttempted || !img.isConnected) {
          onUnavailable?.();
          return;
        }
        proxyAttempted = true;
        const proxiedUrl = await proxyFlowThumbnail(url);
        if (proxiedUrl && img.isConnected) {
          img.src = proxiedUrl;
          return;
        }
        onUnavailable?.();
      };
      img.src = url;
    }

    function renderReferenceCards(type) {
      type = normalizeType(type);
      const isImage = type === "image";
      const list = referencesFor(type);
      const cardsList = document.querySelector(isImage ? "#refCardsListImage" : "#refCardsListVideo");
      const uploadSlot = document.querySelector(isImage ? "#refUploadSlotImage" : "#refUploadSlotVideo");
      const countBadge = document.querySelector(isImage ? "#refImageCountImage" : "#refImageCountVideo");
      if (!cardsList || !uploadSlot) return;
      if (countBadge) countBadge.textContent = `${list.length}/3 ${type === "video" ? "tham chiếu" : "ảnh"}`;
      cardsList.querySelectorAll(".ref-card").forEach(element => element.remove());

      list.forEach((reference, index) => {
        const card = document.createElement("div");
        card.className = "ref-card";
        const img = document.createElement("img");
        const isFlowAsset = reference.source === "flow";
        const isVideo = reference.kind === "video";
        const flowThumbnailUrl = isFlowAsset ? normalizeFlowThumbnailUrl(reference) : "";
        if (!flowThumbnailUrl && !isFlowAsset) {
          if (!reference.previewUrl) reference.previewUrl = URL.createObjectURL(reference.file);
          img.src = reference.previewUrl;
        } else if (!flowThumbnailUrl) img.style.display = "none";
        img.alt = reference.name || (isVideo ? "Video tham chiếu" : "Ảnh tham chiếu");
        img.onerror = () => { img.style.display = "none"; };

        const badge = document.createElement("div");
        badge.className = "ref-badge";
        badge.textContent = String(index + 1);

        if (isVideo) {
          const videoIndicator = document.createElement("div");
          videoIndicator.className = "ref-video-indicator";
          videoIndicator.textContent = "▶ Video";
          videoIndicator.style.cssText = "position:absolute;bottom:22px;left:4px;background:rgba(0,0,0,0.75);color:#fff;font-size:9px;padding:1px 4px;border-radius:3px;z-index:2;font-weight:600;";
          card.appendChild(videoIndicator);
        }

        const tag = document.createElement("div");
        tag.className = "ref-tag";
        tag.textContent = reference.name || (isVideo ? "Video tham chiếu" : "Ảnh tham chiếu");
        tag.title = `${isFlowAsset ? (isVideo ? "Video trên Flow" : "Ảnh trên Flow") : "Chờ upload"}: ${reference.name || (isVideo ? "Video tham chiếu" : "Ảnh tham chiếu")}`;
        const remove = document.createElement("button");
        remove.className = "ref-remove-btn";
        remove.type = "button";
        remove.title = isVideo ? "Xóa video này" : "Xóa ảnh này";
        remove.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
        remove.onclick = event => {
          event.stopPropagation();
          const [removed] = list.splice(index, 1);
          if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
          renderReferenceCards(type);
        };
        card.append(img, badge, tag, remove);
        cardsList.insertBefore(card, uploadSlot);
        if (flowThumbnailUrl) bindFlowThumbnail(img, flowThumbnailUrl, () => { img.style.display = "none"; });
      });
      uploadSlot.style.display = list.length >= 3 ? "none" : "flex";

      // Also synchronize TobyFlow preview grid and ratio count
      const currentGenType = normalizeType(document.querySelector("#genType")?.value);
      if (type === currentGenType) {
        const previewGrid = document.querySelector("#refImagesPreview");
        const ratioCount = document.querySelector("#refRatioCount");
        const clearAllButton = document.querySelector("#clearAllGenRefsBtn");
        if (ratioCount) ratioCount.textContent = list.length > 0 ? `${list.length}/3 ảnh` : "";
        if (clearAllButton) {
          clearAllButton.classList.toggle("hidden", list.length === 0);
          clearAllButton.disabled = list.length === 0;
        }
        if (previewGrid) {
          previewGrid.replaceChildren();
          list.forEach((reference, index) => {
            const item = document.createElement("div");
            item.className = "ref-grid-item";
            item.dataset.index = String(index);
            const img = document.createElement("img");
            const isFlowAsset = reference.source === "flow";
            const flowThumbnailUrl = isFlowAsset ? normalizeFlowThumbnailUrl(reference) : "";
            if (!flowThumbnailUrl && !isFlowAsset && reference.previewUrl) img.src = reference.previewUrl;
            else if (!flowThumbnailUrl) img.style.display = "none";
            img.alt = reference.name || "";
            img.onerror = () => { img.style.display = "none"; };

            const tag = document.createElement("span");
            tag.className = "ref-grid-tag";
            tag.textContent = reference.name || (reference.kind === "video" ? "Video" : "Ảnh");
            tag.title = reference.name || (reference.kind === "video" ? "Video" : "Ảnh");

            const removeBtn = document.createElement("button");
            removeBtn.type = "button";
            removeBtn.className = "ref-grid-remove";
            removeBtn.innerHTML = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"></path></svg>';
            removeBtn.title = reference.kind === "video" ? "Xóa video tham chiếu" : "Xóa ảnh tham chiếu";
            removeBtn.setAttribute("aria-label", removeBtn.title);
            removeBtn.onclick = event => {
              event.stopPropagation();
              const [removed] = list.splice(index, 1);
              if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
              renderReferenceCards(type);
            };
            item.append(img, tag, removeBtn);
            previewGrid.appendChild(item);
            if (flowThumbnailUrl) bindFlowThumbnail(img, flowThumbnailUrl, () => { img.style.display = "none"; });
          });
        }
      }
    }

    function addLocalFilesToReferences(type, files) {
      type = normalizeType(type);
      const list = referencesFor(type);
      let rejectedVideo = false;
      for (const file of files) {
        if (isVideoFile(file)) {
          rejectedVideo = true;
          continue;
        }
        const isImage = file?.type?.startsWith("image/");
        if (!isImage || list.length >= 3) continue;
        const key = localFileKey(file);
        if (list.some(item => item.source === "local" && localFileKey(item.file) === key)) continue;
        list.push({
          source: "local",
          file,
          name: file.name || "Ảnh mới",
          kind: "image",
          previewUrl: URL.createObjectURL(file)
        });
      }
      if (rejectedVideo) setFeedback?.(t("referencePickerVideoUploadUnsupported", "Không hỗ trợ tải video từ máy. Hãy chọn video có sẵn trong Thư viện Flow."), false);
      renderReferenceCards(type);
    }

    function renderFlowPickerAssets() {
      const query = (searchInput.value || "").trim().toLocaleLowerCase();
      const allowVideo = pickerType === "video" && pickerPurpose !== "frames";
      const list = pickerFlowAssets.filter(asset => (asset.kind === "image" || (allowVideo && asset.kind === "video")) && !asset.busy && !asset.error && asset.ready !== false)
        .filter(asset => !query || String(asset.name || "").toLocaleLowerCase().includes(query));
      const assetCount = document.querySelector("#refPickerAssetCount");
      const moreButton = document.querySelector("#refPickerMore");
      if (assetCount) assetCount.textContent = `Tìm thấy ${list.length} ${allowVideo ? "media" : "ảnh"}`;
      if (moreButton) {
        moreButton.hidden = (list.length <= pickerVisibleLimit && pickerScannedCount < pickerScanLimit) || pickerFlowLoading;
        moreButton.textContent = list.length > pickerVisibleLimit
          ? `⊕  Xem thêm ${list.length - pickerVisibleLimit} ${allowVideo ? "media" : "ảnh"}`
          : pickerScannedCount >= pickerScanLimit ? `⊕  Quét thêm ${allowVideo ? "media" : "ảnh"} trên Flow` : "";
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
        const isVideo = asset.kind === "video";
        const button = document.createElement("button");
        button.type = "button";
        button.className = `ref-picker-asset${isExisting || isPicked ? " selected" : ""}`;
        button.title = isExisting ? "Đã có trong danh sách tham chiếu" : !canIdentifySafely ? `Flow không cung cấp media ID ổn định cho ${isVideo ? "video" : "ảnh"} này` : asset.name || (isVideo ? "Video Flow" : "Ảnh Flow");
        button.disabled = isExisting || (!canIdentifySafely && !isPicked) || (!isPicked && selectedCount() >= selectionLimit());
        const thumbnailUrl = normalizeFlowThumbnailUrl(asset);
        let thumbnailElement = null;
        if (thumbnailUrl) {
          thumbnailElement = document.createElement("img");
          thumbnailElement.alt = "";
          thumbnailElement.loading = "lazy";
          button.appendChild(thumbnailElement);
        } else {
          const placeholder = document.createElement("div");
          placeholder.className = "ref-picker-asset-placeholder";
          placeholder.textContent = isVideo ? "▶" : "▧";
          button.appendChild(placeholder);
        }
        if (isVideo) {
          const videoIndicator = document.createElement("span");
          videoIndicator.className = "ref-picker-video-badge";
          videoIndicator.textContent = "▶ Video";
          videoIndicator.style.cssText = "position:absolute;top:4px;left:4px;background:rgba(0,0,0,0.7);color:#fff;font-size:10px;padding:1px 4px;border-radius:3px;z-index:2;";
          button.appendChild(videoIndicator);
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
        name.textContent = asset.name || (isVideo ? "Video không tên" : "Ảnh không tên");
        button.appendChild(name);
        button.onclick = () => {
          if (!canIdentifySafely || isExisting) return;
          if (pickerFlowSelection.has(assetId)) {
            const selectedReference = pickerFlowSelection.get(assetId);
            pickerFlowSelection.delete(assetId);
            pickerSelectionOrder = pickerSelectionOrder.filter(item => item !== selectedReference);
          } else if (selectedCount() < selectionLimit()) {
            const selectedReference = {
              source: "flow",
              projectId: pickerProjectId,
              id: assetId,
              name: asset.name,
              kind: asset.kind || (isVideo ? "video" : "image"),
              assetName: `asset:${asset.name}`,
              expectedId: assetId,
              thumbnailUrl
            };
            pickerFlowSelection.set(assetId, selectedReference);
            pickerSelectionOrder.push(selectedReference);
          }
          updatePickerCount();
        };
        flowGrid.appendChild(button);
        if (thumbnailElement) bindFlowThumbnail(thumbnailElement, thumbnailUrl, () => {
          const placeholder = document.createElement("div");
          placeholder.className = "ref-picker-asset-placeholder";
          placeholder.textContent = isVideo ? "▶" : "▧";
          if (thumbnailElement.isConnected) thumbnailElement.replaceWith(placeholder);
        });
      }
      if (flowMessage) {
        flowMessage.hidden = !pickerFlowLoading && list.length > 0;
        if (pickerFlowLoading) flowMessage.textContent = `Đang quét thư viện ${allowVideo ? "media" : "ảnh"} Flow...`;
        else if (!pickerProjectId) flowMessage.textContent = "Đang chờ xác định dự án Flow...";
        else if (!list.length) flowMessage.textContent = query ? `Không tìm thấy ${allowVideo ? "media" : "ảnh"} khớp.` : `Không tìm thấy ${allowVideo ? "media" : "ảnh"} sẵn sàng trong thư viện Flow. Hãy mở dự án Flow rồi quét lại.`;
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

    async function loadFlowPickerAssets({ background = false } = {}) {
      if (pickerFlowLoading) return;
      const projectId = pickerProjectId;
      if (!projectId) {
        pickerFlowAssets = [];
        pickerFlowScanned = false;
        if (flowMessage) {
          flowMessage.hidden = false;
          flowMessage.textContent = "Đang chờ xác định dự án Flow...";
        }
        renderFlowPickerAssets();
        return;
      }
      const projectEpoch = pickerProjectEpoch;
      pickerFlowLoading = true;
      if (!background || pickerFlowAssets.length === 0) pickerFlowScanned = false;
      if (flowMessage) {
        flowMessage.hidden = false;
        flowMessage.textContent = background && pickerFlowAssets.length
          ? "Đang cập nhật thư viện ảnh Flow..."
          : "Đang quét thư viện ảnh Flow...";
      }
      const refresh = document.querySelector("#refPickerRefresh");
      if (refresh) refresh.disabled = true;
      renderFlowPickerAssets();
      try {
        const result = await dispatchFlowOperation("flow.assets.list", { includeIncomplete: true, maxItems: pickerScanLimit });
        const assets = Array.isArray(result) ? result : (result?.assets || []);
        if (projectEpoch !== pickerProjectEpoch || projectId !== pickerProjectId) return;
        pickerScannedCount = assets.length;
        pickerFlowAssets = assets.filter(asset => asset && (asset.kind === "image" || asset.kind === "video") && typeof asset.name === "string")
          .map(asset => ({ ...asset, thumbnailUrl: normalizeFlowThumbnailUrl(asset) }));
        flowAssetCacheByProject.set(projectId, { assets: pickerFlowAssets, scannedCount: assets.length });
        while (flowAssetCacheByProject.size > 5) flowAssetCacheByProject.delete(flowAssetCacheByProject.keys().next().value);
        pickerVisibleLimit = 20;
        pickerFlowScanned = true;
        renderFlowPickerAssets();
      } catch (error) {
        if (projectEpoch !== pickerProjectEpoch || projectId !== pickerProjectId) return;
        if (!background || pickerFlowAssets.length === 0) {
          pickerFlowAssets = [];
          pickerScannedCount = 0;
        }
        if (flowMessage) {
          flowMessage.hidden = false;
          flowMessage.textContent = `${error.message || "Không thể tải ảnh Flow."} Mở Flow ở mục All media rồi bấm Quét lại.`;
        }
      } finally {
        if (projectEpoch !== pickerProjectEpoch || projectId !== pickerProjectId) return;
        pickerFlowLoading = false;
        if (refresh) refresh.disabled = false;
        renderFlowPickerAssets();
      }
    }

    function setProjectContext(projectId) {
      const nextProjectId = typeof projectId === "string" && projectId.trim() ? projectId.trim() : null;
      const previousProjectId = pickerProjectId || pendingPreviousProjectId;
      if (nextProjectId === pickerProjectId && !pendingPreviousProjectId) {
        if (!nextProjectId && flowMessage) {
          flowMessage.hidden = false;
          flowMessage.textContent = "Đang chờ xác định dự án Flow...";
        }
        return;
      }

      if (previousProjectId !== nextProjectId) {
        for (const type of ["image", "video"]) {
          const list = referencesFor(type);
          const kept = list.filter(item => item.source !== "flow" || item.projectId === nextProjectId);
          if (kept.length !== list.length) {
            list.splice(0, list.length, ...kept);
            renderReferenceCards(type);
          }
        }
        let removedFrameSource = false;
        for (let index = frameSources.length - 1; index >= 0; index--) {
          const source = frameSources[index];
          if (source.source === "flow" && source.projectId !== nextProjectId) {
            frameSources.splice(index, 1);
            removedFrameSource = true;
          }
        }
        if (removedFrameSource) notifyFrameSourcesChanged();
      }

      pickerProjectId = nextProjectId;
      pendingPreviousProjectId = null;
      pickerProjectEpoch++;
      pickerFlowLoading = false;
      pickerFlowSelection.clear();
      pickerSelectionOrder = pickerSelectionOrder.filter(entry => entry.source !== "flow");
      const cachedProjectAssets = nextProjectId ? flowAssetCacheByProject.get(nextProjectId) : null;
      pickerFlowAssets = Array.isArray(cachedProjectAssets?.assets) ? [...cachedProjectAssets.assets] : [];
      pickerScannedCount = Number(cachedProjectAssets?.scannedCount) || 0;
      pickerFlowScanned = Boolean(cachedProjectAssets);
      const refresh = document.querySelector("#refPickerRefresh");
      if (refresh) refresh.disabled = false;
      updatePickerCount();

      // Warm the newly entered project's cache before the user opens the picker.
      // A missing project ID deliberately clears the gallery instead of showing
      // assets from the last project while context is loading or unavailable.
      if (nextProjectId) void loadFlowPickerAssets({ background: true });
      else if (flowMessage) {
        flowMessage.hidden = false;
        flowMessage.textContent = "Đang chờ xác định dự án Flow...";
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
      pickerType = normalizeType(type);
      pickerPurpose = purpose === "frames" ? "frames" : "references";
      const cachedProjectAssets = pickerProjectId ? flowAssetCacheByProject.get(pickerProjectId) : null;
      pickerFlowAssets = Array.isArray(cachedProjectAssets?.assets) ? [...cachedProjectAssets.assets] : [];
      pickerVisibleLimit = 20;
      pickerScanLimit = 120;
      pickerScannedCount = Number(cachedProjectAssets?.scannedCount) || 0;
      pickerFlowSelection = new Map();
      pickerLocalFiles = [];
      pickerSelectionOrder = [];
      pickerFlowScanned = Boolean(cachedProjectAssets);
      searchInput.value = "";
      localList.replaceChildren();
      document.querySelector("#refPickerTitle").textContent = pickerPurpose === "frames" ? t("framePickerTitle", "Chọn ảnh nguồn Frames")
        : pickerType === "video" ? t("videoReferencePickerTitle", "Chọn ảnh hoặc video tham chiếu")
          : t("referencePickerTitle", "Chọn / Tải ảnh lên");
      document.querySelector("#refPickerLimitHint").textContent = pickerPurpose === "frames" ? t("framePickerLimit", "Tối đa 100 ảnh nguồn") : t("referencePickerLimit", "Tối đa 3 ảnh tham chiếu");
      document.querySelector("#refPickerUploadHint").textContent = pickerPurpose === "frames"
        ? t("framePickerUploadHint", "Ảnh sẽ được tải lên Flow trước khi xếp các prompt vào hàng đợi.")
        : pickerType === "video"
          ? t("videoReferencePickerUploadHint", "Ảnh từ máy có thể dùng làm tham chiếu; video phải được chọn từ Thư viện Flow.")
          : t("referencePickerUploadHint", "Ảnh sẽ được tải lên Flow khi bạn bấm Tạo ảnh hoặc Tạo video.");
      const localDescription = document.querySelector("#refPickerDrop > span");
      if (localDescription) {
        localDescription.textContent = pickerPurpose === "frames"
          ? t("framePickerLocalDescription", "Chọn ảnh từ máy hoặc kéo thả ảnh vào đây")
          : t("referencePickerLocalDescription", "Chỉ nhận ảnh từ máy; video từ máy chưa được hỗ trợ.");
      }
      document.querySelector('[data-ref-picker-tab="flow"]').textContent = pickerPurpose === "frames" ? t("framePickerFlowTab", "Thư viện Flow")
        : pickerType === "video" ? t("videoReferencePickerFlowTab", "Ảnh & video trên Flow")
          : t("referencePickerFlowTab", "Ảnh trên Flow");
      document.querySelector('[data-ref-picker-tab="upload"]').textContent = pickerPurpose === "frames" ? t("framePickerLocalTab", "Máy tính") : t("referencePickerLocalTab", "Ảnh từ máy");
      document.querySelector("#refPickerConfirm").textContent = pickerPurpose === "frames" ? t("framePickerConfirm", "Thêm nguồn") : t("referencePickerConfirm", "Xác nhận");
      fileInput.accept = "image/*";
      modal.hidden = false;
      document.body.style.overflow = "hidden";
      // Show the cached same-project gallery immediately, or scan it when the
      // user visits the Flow tab if project-entry warm-up has not finished.
      setPickerTab("upload");
      updatePickerCount();
      document.querySelector("#refPickerClose").focus();
    }

    function close({ confirmed = false } = {}) {
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
    function addPickerLocalFiles(files) {
      let rejectedVideo = false;
      for (const file of Array.from(files || [])) {
        if (isVideoFile(file)) {
          rejectedVideo = true;
          continue;
        }
        if (!file?.type?.startsWith("image/")) continue;
        if (selectedCount() >= selectionLimit()) break;
        const key = localFileKey(file);
        if (pickerLocalFiles.some(entry => localFileKey(entry.file) === key) || hasLocalFile(file)) continue;
        const entry = { source: "local", file, kind: "image", previewUrl: URL.createObjectURL(file) };
        pickerLocalFiles.push(entry);
        pickerSelectionOrder.push(entry);
      }
      if (rejectedVideo) setFeedback?.(t("referencePickerVideoUploadUnsupported", "Không hỗ trợ tải video từ máy. Hãy chọn video có sẵn trong Thư viện Flow."), false);
      renderPickerLocalFiles();
      updatePickerCount();
    }
    fileInput.onchange = event => {
      addPickerLocalFiles(event.target.files);
      fileInput.value = "";
    };
    const dropTarget = document.querySelector("#refPickerDrop");
    dropTarget.ondragover = event => { event.preventDefault(); dropTarget.style.borderColor = "var(--primary)"; };
    dropTarget.ondragleave = () => { dropTarget.style.borderColor = ""; };
    dropTarget.ondrop = event => {
      event.preventDefault();
      dropTarget.style.borderColor = "";
      addPickerLocalFiles(event.dataTransfer?.files);
    };
    modal.onclick = event => { if (event.target === modal) close(); };
    document.addEventListener("keydown", event => { if (event.key === "Escape" && !modal.hidden) close(); });
    async function confirmProjectContext(context) {
      const expectedProjectId = typeof context?.projectId === "string" && context.projectId.trim()
        ? context.projectId.trim().toLowerCase()
        : null;
      if (!expectedProjectId) {
        setProjectContext(null);
        return;
      }
      if (expectedProjectId === pickerProjectId) return;
      // Clear the old project's gallery while the live Flow context is checked.
      pendingPreviousProjectId = pickerProjectId || pendingPreviousProjectId;
      pickerProjectId = null;
      pickerProjectEpoch++;
      pickerFlowLoading = false;
      pickerFlowAssets = [];
      pickerFlowScanned = false;
      pickerScannedCount = 0;
      pickerFlowSelection.clear();
      pickerSelectionOrder = pickerSelectionOrder.filter(entry => entry.source !== "flow");
      renderFlowPickerAssets();
      if (flowMessage) {
        flowMessage.hidden = false;
        flowMessage.textContent = "Đang xác minh dự án Flow...";
      }
      const verificationEpoch = pickerProjectEpoch;
      for (let attempt = 0; attempt < 5; attempt++) {
        if (verificationEpoch !== pickerProjectEpoch) return;
        try {
          const liveContext = await dispatchFlowOperation("flow.context");
          const confirmedProjectId = typeof liveContext?.projectId === "string" ? liveContext.projectId.trim().toLowerCase() : "";
          if (verificationEpoch !== pickerProjectEpoch) return;
          if (liveContext?.isProjectEditor === true && confirmedProjectId === expectedProjectId) {
            setProjectContext(confirmedProjectId);
            return;
          }
        } catch {
          // The route can be announced before Flow's project editor is ready.
        }
        if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 350));
      }
      if (verificationEpoch === pickerProjectEpoch) setProjectContext(null);
    }

    chrome.storage?.onChanged?.addListener?.((changes, area) => {
      if (area !== "session" || !Object.prototype.hasOwnProperty.call(changes, "targetFlowContext")) return;
      void confirmProjectContext(changes.targetFlowContext?.newValue);
    });
    const initialContext = chrome.storage?.session?.get?.("targetFlowContext");
    if (initialContext?.then) void initialContext.then(stored => confirmProjectContext(stored?.targetFlowContext));
    document.querySelector("#refPickerConfirm").onclick = () => {
      const list = referencesFor(pickerType);
      const pending = [...pickerSelectionOrder].map(entry => entry.source === "local"
        ? { ...entry, name: entry.file.name || (entry.kind === "video" ? "Video mới" : "Ảnh mới") }
        : entry);
      if (pickerPurpose === "frames") {
        const additions = pending.filter(entry => !hasFrameSource(entry)).slice(0, Math.max(0, selectionLimit() - frameSources.length));
        if (!additions.length) {
          setFeedback?.(t("framePickerNeedSource", "Hãy chọn ít nhất một ảnh mới làm nguồn Frames."), false);
          return;
        }
        frameSources.push(...additions);
        notifyFrameSourcesChanged();
        onFramesConfirmed?.([...frameSources]);
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
      setProjectContext,
      getReferences: referencesFor,
      getFrameSources: () => [...frameSources],
      removeFrameSource: source => {
        const index = frameSources.indexOf(source);
        if (index < 0) return [...frameSources];
        const [removed] = frameSources.splice(index, 1);
        if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
        notifyFrameSourcesChanged();
        return [...frameSources];
      },
      moveFrameSource: (source, delta) => {
        const index = frameSources.indexOf(source);
        const target = Math.max(0, Math.min(frameSources.length - 1, index + Math.trunc(Number(delta) || 0)));
        if (index >= 0 && target !== index) frameSources.splice(target, 0, frameSources.splice(index, 1)[0]);
        return [...frameSources];
      },
      openFrames: onChanged => { onFramesConfirmed = typeof onChanged === "function" ? onChanged : null; open("video", "frames"); },
      setFrameSourcesChanged: onChanged => {
        onFrameSourcesChanged = typeof onChanged === "function" ? onChanged : null;
        onFrameSourcesChanged?.([...frameSources]);
      },
      bindThumbnail: (img, source, onUnavailable) => {
        if (!img || !source) return false;
        const url = source.source === "flow"
          ? normalizeFlowThumbnailUrl(source)
          : String(source.previewUrl || "");
        if (!url) {
          onUnavailable?.();
          return false;
        }
        if (source.source === "flow") bindFlowThumbnail(img, url, onUnavailable);
        else {
          img.onerror = () => onUnavailable?.();
          img.src = url;
        }
        return true;
      },
      open: (type = "image", purpose = "references") => open(type, purpose),
      renderReferenceCards,
      addLocalFilesToReferences,
    };
  }

  window.createFlowReferencePicker = createFlowReferencePicker;
})();
