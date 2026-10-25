(() => {
  "use strict";

  function createFlowReferencePicker({ dispatchFlowOperation, setFeedback }) {
    if (typeof dispatchFlowOperation !== "function") throw new TypeError("Flow reference picker requires a Flow operation dispatcher.");
    const t = (key, fallback) => window.I18n?.t?.(`sidebar.${key}`) || fallback;
    const references = { image: [], video: [] };
    let pickerType = "image";
    let pickerPurpose = "references";
    let onFrameSlotPicked = null;
    let onFrameSlotsPicked = null;
    let onFrameProjectChanged = null;
    let pickerFlowAssets = [];
    let pickerAlbums = [];
    let pickerAlbumId = null;
    let pickerFlowSelection = new Map();
    let pickerLocalFiles = [];
    let pickerSelectionOrder = [];
    let pickerFlowLoading = false;
    let pickerFlowScanned = false;
    let pickerFlowLoadEpoch = 0;
    let pickerProjectId = null;
    let pendingPreviousProjectId = null;
    let pickerProjectEpoch = 0;
    const flowAssetCacheByProject = new Map();
    let pickerVisibleLimit = 20;
    let pickerScanLimit = 120;
    let pickerScannedCount = 0;
    const flowThumbnailProxyCache = new Map();

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

    // One builder for every Flow-identity pick — the library grid and
    // the Albums source alike — so an album "use as ref" returns exactly
    // the shape a library pick produces and the two cannot drift apart.
    function flowReferenceFor(asset, thumbnailUrl) {
      const assetId = String(asset.id || "");
      return {
        source: "flow",
        projectId: pickerProjectId,
        id: assetId,
        name: asset.name,
        kind: asset.kind || "image",
        assetName: `asset:${asset.name}`,
        expectedId: assetId,
        thumbnailUrl
      };
    }

    const supportedReferenceId = value => typeof value === "string" && (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) || value.startsWith("asb:")
    );
    const normalizeType = type => String(type || "").toLowerCase() === "video" ? "video" : "image";
    const referencesFor = type => references[normalizeType(type)];
    const localFileKey = file => `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
    const isVideoFile = file => file?.type?.startsWith("video/") || /\.(mp4|mov|webm|mkv|avi|m4v)$/i.test(String(file?.name || ""));
    const normalizeReferenceId = value => String(value || "").toLowerCase();
    const isFramePicker = () => pickerPurpose === "frame-slot" || pickerPurpose === "frame-pair";
    const selectionLimit = () => pickerPurpose === "frame-slot" ? 1 : pickerPurpose === "frame-pair" ? 2 : 3;
    const selectedCount = () => (isFramePicker() ? 0 : referencesFor(pickerType).length)
      + pickerFlowSelection.size + pickerLocalFiles.length;
    const hasLocalFile = file => (isFramePicker() ? pickerLocalFiles : referencesFor(pickerType))
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

      // Also synchronize the preview grid and ratio count
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
      const allowVideo = pickerType === "video" && pickerPurpose === "references";
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
      const selectedReferences = isFramePicker() ? [] : referencesFor(pickerType);
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
          if (pickerPurpose === "frame-slot") {
            commitFrameSlot(flowReferenceFor(asset, thumbnailUrl));
            return;
          }
          if (pickerFlowSelection.has(assetId)) {
            const selectedReference = pickerFlowSelection.get(assetId);
            pickerFlowSelection.delete(assetId);
            pickerSelectionOrder = pickerSelectionOrder.filter(item => item !== selectedReference);
          } else if (selectedCount() < selectionLimit()) {
            const selectedReference = flowReferenceFor(asset, thumbnailUrl);
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

    // FEAT-10: the Albums source. Album membership lives in the
    // background album store (flow-albums.js); the picker only reads it
    // and turns a chosen album image into a reference through the same
    // builder the library grid uses, so the attach path downstream
    // cannot tell where the identity came from.
    const albumSelect = document.querySelector("#refPickerAlbumSelect");
    const albumGrid = document.querySelector("#refPickerAlbumGrid");
    const albumMessage = document.querySelector("#refPickerAlbumMessage");

    async function loadPickerAlbums() {
      if (!albumSelect || !albumGrid) return;
      try {
        const res = await chrome.runtime.sendMessage({ type: "flow-albums:list" });
        pickerAlbums = res?.ok && Array.isArray(res.albums) ? res.albums : [];
      } catch {
        pickerAlbums = [];
      }
      if (!pickerAlbums.some(album => album.id === pickerAlbumId)) {
        pickerAlbumId = pickerAlbums[0]?.id || null;
      }
      albumSelect.replaceChildren();
      for (const album of pickerAlbums) {
        const option = document.createElement("option");
        option.value = album.id;
        option.textContent = `${album.name} (${Array.isArray(album.images) ? album.images.length : 0})`;
        albumSelect.appendChild(option);
      }
      albumSelect.value = pickerAlbumId || "";
      renderPickerAlbumAssets();
    }

    function renderPickerAlbumAssets() {
      if (!albumGrid) return;
      albumGrid.replaceChildren();
      const album = pickerAlbums.find(entry => entry.id === pickerAlbumId) || null;
      const allowVideo = pickerType === "video" && pickerPurpose === "references";
      const images = (Array.isArray(album?.images) ? album.images : [])
        .filter(image => image && (image.kind === "image" || (allowVideo && image.kind === "video")));
      if (albumMessage) {
        albumMessage.hidden = images.length > 0;
        albumMessage.textContent = !pickerAlbums.length
          ? "Chưa có album nào. Hãy tạo album trong tab Ảnh."
          : album && !images.length ? "Album này chưa có ảnh phù hợp." : "";
      }
      const selectedReferences = isFramePicker() ? [] : referencesFor(pickerType);
      const existingIds = new Set(selectedReferences.filter(item => item.source === "flow").map(item => normalizeReferenceId(item.id)));
      for (const image of images) {
        const assetId = String(image.id || "");
        const isExisting = existingIds.has(normalizeReferenceId(assetId));
        const isPicked = pickerFlowSelection.has(assetId);
        const canIdentifySafely = supportedReferenceId(assetId);
        const isVideo = image.kind === "video";
        const button = document.createElement("button");
        button.type = "button";
        button.className = `ref-picker-asset${isExisting || isPicked ? " selected" : ""}`;
        button.title = isExisting ? "Đã có trong danh sách tham chiếu" : !canIdentifySafely ? "Flow không cung cấp media ID ổn định cho ảnh này" : image.name || "Ảnh trong album";
        button.disabled = isExisting || (!canIdentifySafely && !isPicked) || (!isPicked && selectedCount() >= selectionLimit());
        if (image.thumbnailUrl) {
          const thumbnailElement = document.createElement("img");
          thumbnailElement.alt = "";
          thumbnailElement.loading = "lazy";
          thumbnailElement.src = image.thumbnailUrl;
          thumbnailElement.onerror = () => thumbnailElement.remove();
          button.appendChild(thumbnailElement);
        } else {
          const placeholder = document.createElement("div");
          placeholder.className = "ref-picker-asset-placeholder";
          placeholder.textContent = isVideo ? "▶" : "▧";
          button.appendChild(placeholder);
        }
        if (isExisting || isPicked) {
          const check = document.createElement("span");
          check.className = "ref-picker-check";
          check.textContent = isExisting
            ? String(selectedReferences.findIndex(item => item.source === "flow" && normalizeReferenceId(item.id) === normalizeReferenceId(assetId)) + 1)
            : String(pickerSelectionOrder.indexOf(pickerFlowSelection.get(assetId)) + 1);
          button.appendChild(check);
        }
        const name = document.createElement("span");
        name.className = "ref-picker-asset-name";
        name.textContent = image.name || "Ảnh không tên";
        button.appendChild(name);
        button.onclick = () => {
          if (!canIdentifySafely || isExisting) return;
          if (pickerPurpose === "frame-slot") {
            commitFrameSlot(flowReferenceFor(image, image.thumbnailUrl || null));
            return;
          }
          if (pickerFlowSelection.has(assetId)) {
            const selectedReference = pickerFlowSelection.get(assetId);
            pickerFlowSelection.delete(assetId);
            pickerSelectionOrder = pickerSelectionOrder.filter(item => item !== selectedReference);
          } else if (selectedCount() < selectionLimit()) {
            const selectedReference = flowReferenceFor(image, image.thumbnailUrl || null);
            pickerFlowSelection.set(assetId, selectedReference);
            pickerSelectionOrder.push(selectedReference);
          }
          updatePickerCount();
          renderPickerAlbumAssets();
        };
        albumGrid.appendChild(button);
      }
    }

    function updatePickerCount() {
      const existingCount = isFramePicker() ? 0 : referencesFor(pickerType).length;
      const pendingCount = pickerSelectionOrder.length;
      const countValue = Math.min(selectionLimit(), existingCount + pendingCount);
      const count = document.querySelector("#refPickerCount");
      if (count) count.textContent = pickerPurpose === "frame-slot"
        ? `${countValue}/1 ảnh khung đã chọn`
        : pickerPurpose === "frame-pair"
          ? `${countValue}/2 ảnh khung đã chọn`
        : `${countValue}/3 ảnh đã chọn${existingCount ? ` (${existingCount} đã có)` : ""}`;
      const confirm = document.querySelector("#refPickerConfirm");
      if (confirm) confirm.disabled = pendingCount === 0 || existingCount + pendingCount > selectionLimit();
      renderFlowPickerAssets();
    }

    async function loadFlowPickerAssets({ background = false, force = false } = {}) {
      if (pickerFlowLoading && !force) return;
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
      const loadEpoch = ++pickerFlowLoadEpoch;
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
        if (projectEpoch !== pickerProjectEpoch || projectId !== pickerProjectId || loadEpoch !== pickerFlowLoadEpoch) return;
        pickerScannedCount = assets.length;
        pickerFlowAssets = assets.filter(asset => asset && (asset.kind === "image" || asset.kind === "video") && typeof asset.name === "string")
          .map(asset => ({ ...asset, thumbnailUrl: normalizeFlowThumbnailUrl(asset) }));
        flowAssetCacheByProject.set(projectId, { assets: pickerFlowAssets, scannedCount: assets.length });
        while (flowAssetCacheByProject.size > 5) flowAssetCacheByProject.delete(flowAssetCacheByProject.keys().next().value);
        pickerVisibleLimit = 20;
        pickerFlowScanned = true;
        renderFlowPickerAssets();
      } catch (error) {
        if (projectEpoch !== pickerProjectEpoch || projectId !== pickerProjectId || loadEpoch !== pickerFlowLoadEpoch) return;
        if (!background || pickerFlowAssets.length === 0) {
          pickerFlowAssets = [];
          pickerScannedCount = 0;
        }
        if (flowMessage) {
          flowMessage.hidden = false;
          flowMessage.textContent = `${error.message || "Không thể tải ảnh Flow."} Mở Flow ở mục All media rồi bấm Quét lại.`;
        }
      } finally {
        if (projectEpoch !== pickerProjectEpoch || projectId !== pickerProjectId || loadEpoch !== pickerFlowLoadEpoch) return;
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
        onFrameProjectChanged?.(nextProjectId);
      }

      pickerProjectId = nextProjectId;
      pendingPreviousProjectId = null;
      pickerProjectEpoch++;
      pickerFlowLoadEpoch++;
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
      pickerPurpose = purpose === "frame-slot" || purpose === "frame-pair" ? purpose : "references";
      const framePicker = isFramePicker();
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
      document.querySelector("#refPickerTitle").textContent = pickerPurpose === "frame-slot" ? t("frameSlotPickerTitle", "Chọn ảnh cho khung video")
        : pickerPurpose === "frame-pair" ? t("framePairPickerTitle", "Chọn tối đa 2 ảnh khung video")
        : pickerType === "video" ? t("videoReferencePickerTitle", "Chọn ảnh hoặc video tham chiếu")
          : t("referencePickerTitle", "Chọn / Tải ảnh lên");
      document.querySelector("#refPickerLimitHint").textContent = pickerPurpose === "frame-slot" ? t("frameSlotPickerLimit", "Chọn tối đa 1 ảnh cho khung này")
        : pickerPurpose === "frame-pair" ? t("framePairPickerLimit", "Ảnh đầu là Start; ảnh thứ hai là End, không bắt buộc.")
        : t("referencePickerLimit", "Tối đa 3 ảnh tham chiếu");
      document.querySelector("#refPickerUploadHint").textContent = framePicker
        ? t("frameSlotPickerUploadHint", "Ảnh từ máy sẽ được tải lên Flow trước khi tạo video.")
        : pickerType === "video"
          ? t("videoReferencePickerUploadHint", "Ảnh từ máy có thể dùng làm tham chiếu; video phải được chọn từ Thư viện Flow.")
          : t("referencePickerUploadHint", "Ảnh sẽ được tải lên Flow khi bạn bấm Tạo ảnh hoặc Tạo video.");
      const localDescription = document.querySelector("#refPickerDrop > span");
      if (localDescription) {
        localDescription.textContent = framePicker
          ? t("framePickerLocalDescription", "Chọn ảnh từ máy hoặc kéo thả ảnh vào đây")
          : t("referencePickerLocalDescription", "Chỉ nhận ảnh từ máy; video từ máy chưa được hỗ trợ.");
      }
      document.querySelector('[data-ref-picker-tab="flow"]').textContent = framePicker ? t("framePickerFlowTab", "Thư viện Flow")
        : pickerType === "video" ? t("videoReferencePickerFlowTab", "Ảnh & video trên Flow")
          : t("referencePickerFlowTab", "Ảnh trên Flow");
      document.querySelector('[data-ref-picker-tab="upload"]').textContent = framePicker ? t("framePickerLocalTab", "Máy tính") : t("referencePickerLocalTab", "Ảnh từ máy");
      const confirmButton = document.querySelector("#refPickerConfirm");
      confirmButton.textContent = pickerPurpose === "frame-slot" ? t("frameSlotPickerConfirm", "Chọn ảnh")
        : pickerPurpose === "frame-pair" ? t("framePairPickerConfirm", "Dùng ảnh đã chọn")
        : t("referencePickerConfirm", "Xác nhận");
      confirmButton.hidden = pickerPurpose === "frame-slot";
      const countLabel = document.querySelector("#refPickerCount");
      if (countLabel) countLabel.hidden = pickerPurpose === "frame-slot";
      fileInput.accept = "image/*";
      fileInput.multiple = pickerPurpose !== "frame-slot";
      modal.hidden = false;
      document.body.style.overflow = "hidden";
      void loadPickerAlbums();
      // Show the cached same-project gallery immediately, or scan it when the
      // user visits the Flow tab if project-entry warm-up has not finished.
      setPickerTab(framePicker ? "flow" : "upload");
      updatePickerCount();
      document.querySelector("#refPickerClose").focus();
    }

    function close({ confirmed = false } = {}) {
      pickerFlowLoading = false;
      const refresh = document.querySelector("#refPickerRefresh");
      if (refresh) refresh.disabled = false;
      if (!confirmed) pickerLocalFiles.forEach(entry => URL.revokeObjectURL(entry.previewUrl));
      if (!confirmed) {
        onFrameSlotPicked = null;
        onFrameSlotsPicked = null;
      }
      pickerLocalFiles = [];
      pickerFlowSelection.clear();
      pickerSelectionOrder = [];
      modal.hidden = true;
      document.body.style.overflow = "";
    }

    function commitFrameSlot(source) {
      if (pickerPurpose !== "frame-slot" || !source) return false;
      const onPicked = onFrameSlotPicked;
      onFrameSlotPicked = null;
      try {
        onPicked?.(source);
      } catch (error) {
        if (source.source === "local" && source.previewUrl) URL.revokeObjectURL(source.previewUrl);
        close();
        setFeedback?.(error?.message || String(error), false);
        return false;
      }
      close({ confirmed: true });
      return true;
    }

    document.querySelectorAll("[data-ref-picker-tab]").forEach(button => {
      button.onclick = () => setPickerTab(button.dataset.refPickerTab);
    });
    document.querySelector("#refPickerClose").onclick = () => close();
    document.querySelector("#refPickerCancel").onclick = () => close();
    document.querySelector("#refPickerRefresh").onclick = () => loadFlowPickerAssets();
    if (albumSelect) albumSelect.onchange = () => { pickerAlbumId = albumSelect.value || null; renderPickerAlbumAssets(); };
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
      if (pickerPurpose === "frame-slot") {
        let rejectedVideo = false;
        const file = Array.from(files || []).find(candidate => {
          if (isVideoFile(candidate)) {
            rejectedVideo = true;
            return false;
          }
          return candidate?.type?.startsWith("image/");
        });
        if (file) {
          commitFrameSlot({
            source: "local",
            file,
            name: file.name || "Ảnh mới",
            kind: "image",
            previewUrl: URL.createObjectURL(file),
          });
        } else if (rejectedVideo) {
          setFeedback?.(t("referencePickerVideoUploadUnsupported", "Không hỗ trợ tải video từ máy. Hãy chọn video có sẵn trong Thư viện Flow."), false);
        }
        return;
      }
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
      if (pickerPurpose === "frame-slot") {
        const picked = pending[0];
        if (!picked) {
          setFeedback?.(t("frameSlotPickerNeedImage", "Hãy chọn một ảnh cho khung video."), false);
          return;
        }
        const onPicked = onFrameSlotPicked;
        onFrameSlotPicked = null;
        onPicked?.(picked);
        close({ confirmed: true });
        return;
      }
      if (pickerPurpose === "frame-pair") {
        const picked = pending.slice(0, 2);
        if (!picked.length) {
          setFeedback?.(t("framePairPickerNeedImage", "Hãy chọn ít nhất một ảnh cho Frames."), false);
          return;
        }
        const onPicked = onFrameSlotsPicked;
        onFrameSlotsPicked = null;
        try {
          onPicked?.(picked);
        } catch (error) {
          close();
          setFeedback?.(error?.message || String(error), false);
          return;
        }
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
      refreshFlowAssets: async () => {
        if (!pickerProjectId) return false;
        flowAssetCacheByProject.delete(pickerProjectId);
        pickerFlowScanned = false;
        await loadFlowPickerAssets({ background: true, force: true });
        return pickerFlowScanned;
      },
      getReferences: referencesFor,
      openFrameSlot: onPicked => {
        onFrameSlotPicked = typeof onPicked === "function" ? onPicked : null;
        open("video", "frame-slot");
      },
      openFrameSlots: onPicked => {
        onFrameSlotsPicked = typeof onPicked === "function" ? onPicked : null;
        open("video", "frame-pair");
      },
      setFrameProjectChanged: onChanged => { onFrameProjectChanged = typeof onChanged === "function" ? onChanged : null; },
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
