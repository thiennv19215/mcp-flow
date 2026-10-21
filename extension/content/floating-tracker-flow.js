/**
 * Flow MCP Floating Tracker Widget
 * Giao diện widget nổi góc dưới màn hình Flow:
 * - Theo dõi danh sách media (video/image) đang render hoặc đã hoàn thành.
 * - Đếm ngược và đo thời gian sinh video thời gian thực.
 * - Hỗ trợ thu nhỏ thành bóng tròn nổi (Launcher bubble), kéo thả di chuyển vị trí.
 * - Tự động cập nhật theo dõi qua cả Sự kiện Correlation Observer lẫn quan sát DOM Tiles.
 */
(function (root) {
  "use strict";

  if (root.__flowMcpFloatingTrackerLoaded__) return;
  root.__flowMcpFloatingTrackerLoaded__ = true;

  const STORAGE_KEY_POS = "flow_mcp_tracker_pos";
  const STORAGE_KEY_MINIMIZED = "flow_mcp_tracker_minimized";

  class FlowFloatingTracker {
    constructor() {
      this.jobs = new Map(); // id -> job object
      this.minimized = false;
      this.isDragging = false;
      this.dragOffset = { x: 0, y: 0 };
      this.timerInterval = null;
      this.domScanInterval = null;

      this.init();
    }

    init() {
      if (typeof document === "undefined" || !document.body) {
        window.addEventListener("DOMContentLoaded", () => this.init(), { once: true });
        return;
      }

      this.injectStyles();
      this.createWidget();
      this.createLauncher();
      this.bindEvents();
      this.startTimers();
      this.loadSavedPosition();
    }

    injectStyles() {
      if (document.getElementById("flow-mcp-tracker-styles")) return;

      const style = document.createElement("style");
      style.id = "flow-mcp-tracker-styles";
      style.textContent = `
        @keyframes flowPulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.55; transform: scale(0.96); }
        }
        @keyframes flowGlow {
          0%, 100% { filter: drop-shadow(0 0 6px rgba(204, 255, 0, 0.4)); }
          50% { filter: drop-shadow(0 0 14px rgba(204, 255, 0, 0.8)); }
        }
        @keyframes flowProgressSlide {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        #flow-mcp-tracker-root {
          position: fixed;
          bottom: 20px;
          right: 20px;
          width: 380px;
          max-width: calc(100vw - 32px);
          max-height: calc(100vh - 40px);
          background: linear-gradient(180deg, rgba(18, 22, 30, 0.88), rgba(8, 11, 16, 0.94));
          border: 1px solid rgba(255, 255, 255, 0.15);
          border-radius: 16px;
          box-shadow: 0 24px 50px rgba(0, 0, 0, 0.6), 0 4px 16px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.2);
          backdrop-filter: blur(20px) saturate(1.2);
          -webkit-backdrop-filter: blur(20px) saturate(1.2);
          z-index: 2147483640;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Inter", sans-serif;
          font-size: 13px;
          color: #f3f4f6;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.2s ease;
          user-select: none;
        }
        #flow-mcp-tracker-root.minimized {
          display: none !important;
        }
        .flow-ft-header {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 12px 14px;
          background: rgba(255, 255, 255, 0.04);
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
          cursor: grab;
        }
        .flow-ft-header:active {
          cursor: grabbing;
        }
        .flow-ft-icon {
          width: 24px;
          height: 24px;
          border-radius: 7px;
          background: rgba(204, 255, 0, 0.15);
          display: flex;
          align-items: center;
          justify-content: center;
          color: #ccff00;
          flex-shrink: 0;
        }
        .flow-ft-title {
          font-weight: 700;
          font-size: 13px;
          letter-spacing: 0.3px;
          color: #ffffff;
        }
        .flow-ft-badge {
          font-size: 11px;
          font-weight: 600;
          padding: 2px 7px;
          border-radius: 12px;
          background: rgba(255, 255, 255, 0.1);
          color: #d1d5db;
        }
        .flow-ft-badge.active {
          background: rgba(204, 255, 0, 0.2);
          color: #ccff00;
        }
        .flow-ft-controls {
          margin-left: auto;
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .flow-ft-btn {
          width: 24px;
          height: 24px;
          border: none;
          border-radius: 6px;
          background: rgba(255, 255, 255, 0.08);
          color: #9ca3af;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          transition: background 0.15s, color 0.15s;
          padding: 0;
        }
        .flow-ft-btn:hover {
          background: rgba(255, 255, 255, 0.18);
          color: #ffffff;
        }
        .flow-ft-progress-bar {
          height: 3px;
          width: 100%;
          background: rgba(255, 255, 255, 0.06);
          position: relative;
          overflow: hidden;
        }
        .flow-ft-progress-fill {
          height: 100%;
          width: 100%;
          background: linear-gradient(90deg, #10b981, #ccff00, #38bdf8, #ccff00);
          background-size: 200% 100%;
          animation: flowProgressSlide 2s linear infinite;
          transform: scaleX(0);
          transform-origin: left;
          transition: transform 0.3s ease;
        }
        .flow-ft-progress-fill.active {
          transform: scaleX(1);
        }
        .flow-ft-content {
          max-height: 320px;
          overflow-y: auto;
          padding: 8px 12px;
          display: flex;
          flex-direction: column;
          gap: 8px;
          scrollbar-width: thin;
          scrollbar-color: rgba(255, 255, 255, 0.2) transparent;
        }
        .flow-ft-content::-webkit-scrollbar {
          width: 5px;
        }
        .flow-ft-content::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.2);
          border-radius: 4px;
        }
        .flow-ft-empty {
          padding: 24px 12px;
          text-align: center;
          color: #6b7280;
          font-size: 12px;
        }
        .flow-ft-card {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 8px 10px;
          background: rgba(255, 255, 255, 0.035);
          border: 1px solid rgba(255, 255, 255, 0.06);
          border-radius: 10px;
          transition: background 0.15s, border-color 0.15s;
        }
        .flow-ft-card:hover {
          background: rgba(255, 255, 255, 0.06);
          border-color: rgba(255, 255, 255, 0.12);
        }
        .flow-ft-thumb {
          width: 44px;
          height: 44px;
          border-radius: 8px;
          overflow: hidden;
          background: #0f131a;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          position: relative;
        }
        .flow-ft-thumb img, .flow-ft-thumb video {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }
        .flow-ft-spinner {
          width: 20px;
          height: 20px;
          border: 2px solid rgba(204, 255, 0, 0.2);
          border-top-color: #ccff00;
          border-radius: 50%;
          animation: flowSpin 0.8s linear infinite;
        }
        @keyframes flowSpin {
          to { transform: rotate(360deg); }
        }
        .flow-ft-info {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .flow-ft-prompt {
          font-size: 12px;
          color: #e5e7eb;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          font-weight: 500;
        }
        .flow-ft-meta {
          font-size: 11px;
          display: flex;
          align-items: center;
          gap: 8px;
          color: #9ca3af;
        }
        .flow-ft-status-tag {
          display: inline-flex;
          align-items: center;
          gap: 4px;
        }
        .flow-ft-status-tag.rendering {
          color: #ccff00;
        }
        .flow-ft-status-tag.completed {
          color: #10b981;
        }
        .flow-ft-status-tag.failed {
          color: #f87171;
        }
        .flow-ft-timer {
          font-family: ui-monospace, monospace;
          color: #6b7280;
        }
        .flow-ft-action-btn {
          padding: 4px 8px;
          border-radius: 6px;
          background: rgba(255, 255, 255, 0.08);
          border: 1px solid rgba(255, 255, 255, 0.1);
          color: #e5e7eb;
          font-size: 11px;
          font-weight: 600;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          gap: 4px;
          text-decoration: none;
          transition: background 0.15s, color 0.15s;
        }
        .flow-ft-action-btn:hover {
          background: #ccff00;
          color: #000000;
          border-color: #ccff00;
        }
        #flow-mcp-tracker-launcher {
          position: fixed;
          bottom: 20px;
          right: 20px;
          width: 48px;
          height: 48px;
          border-radius: 50%;
          background: linear-gradient(135deg, #161b24, #0b0e14);
          border: 1px solid rgba(204, 255, 0, 0.4);
          box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5), 0 0 16px rgba(204, 255, 0, 0.25);
          cursor: pointer;
          z-index: 2147483639;
          display: none;
          align-items: center;
          justify-content: center;
          color: #ccff00;
          transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.2s;
        }
        #flow-mcp-tracker-launcher:hover {
          transform: scale(1.08);
          box-shadow: 0 14px 30px rgba(0, 0, 0, 0.6), 0 0 24px rgba(204, 255, 0, 0.4);
        }
        #flow-mcp-tracker-launcher.active-pulse {
          animation: flowGlow 2s infinite ease-in-out;
        }
        .flow-ft-launcher-badge {
          position: absolute;
          top: -3px;
          right: -3px;
          min-width: 18px;
          height: 18px;
          border-radius: 9px;
          background: #ef4444;
          color: #ffffff;
          font-size: 10px;
          font-weight: 700;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 0 4px;
          border: 2px solid #0f131a;
        }
      `;
      (document.head || document.documentElement).appendChild(style);
    }

    createWidget() {
      if (document.getElementById("flow-mcp-tracker-root")) return;

      const rootEl = document.createElement("div");
      rootEl.id = "flow-mcp-tracker-root";
      rootEl.innerHTML = `
        <div class="flow-ft-header" id="flow-ft-header">
          <div class="flow-ft-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
            </svg>
          </div>
          <div class="flow-ft-title">Flow Pipeline</div>
          <div class="flow-ft-badge" id="flow-ft-badge">Idle</div>
          <div class="flow-ft-controls">
            <button class="flow-ft-btn" id="flow-ft-minimize-btn" title="Thu nhỏ">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </button>
            <button class="flow-ft-btn" id="flow-ft-close-btn" title="Đóng">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        </div>
        <div class="flow-ft-progress-bar">
          <div class="flow-ft-progress-fill" id="flow-ft-progress-fill"></div>
        </div>
        <div class="flow-ft-content" id="flow-ft-content">
          <div class="flow-ft-empty">Chưa có video hoặc ảnh nào đang xử lý.</div>
        </div>
      `;

      document.body.appendChild(rootEl);
      this.rootEl = rootEl;
      this.contentEl = rootEl.querySelector("#flow-ft-content");
      this.badgeEl = rootEl.querySelector("#flow-ft-badge");
      this.progressFillEl = rootEl.querySelector("#flow-ft-progress-fill");
    }

    createLauncher() {
      if (document.getElementById("flow-mcp-tracker-launcher")) return;

      const launcher = document.createElement("div");
      launcher.id = "flow-mcp-tracker-launcher";
      launcher.title = "Mở Flow Pipeline Tracker";
      launcher.innerHTML = `
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
        </svg>
        <div class="flow-ft-launcher-badge" id="flow-ft-launcher-badge" style="display:none;">0</div>
      `;

      document.body.appendChild(launcher);
      this.launcherEl = launcher;
      this.launcherBadgeEl = launcher.querySelector("#flow-ft-launcher-badge");
    }

    bindEvents() {
      // Minimize & Close buttons
      const minBtn = this.rootEl?.querySelector("#flow-ft-minimize-btn");
      minBtn?.addEventListener("click", () => this.setMinimized(true));

      const closeBtn = this.rootEl?.querySelector("#flow-ft-close-btn");
      closeBtn?.addEventListener("click", () => this.setMinimized(true));

      // Launcher click to restore
      this.launcherEl?.addEventListener("click", () => this.setMinimized(false));

      // Dragging logic
      const header = this.rootEl?.querySelector("#flow-ft-header");
      header?.addEventListener("mousedown", (e) => this.onDragStart(e));
      window.addEventListener("mousemove", (e) => this.onDragMove(e));
      window.addEventListener("mouseup", () => this.onDragEnd());

      // Lắng nghe Correlation events từ flow-correlation-observer.js
      window.addEventListener("TOBY_FLOW_CORRELATION_RECEIPT", (e) => this.handleCorrelationReceipt(e.detail));
      window.addEventListener("TOBY_FLOW_V2_CORRELATION_RECEIPT", (e) => this.handleCorrelationReceipt(e.detail));
      window.addEventListener("TOBY_FLOW_MEDIA_IDENTITIES", (e) => this.handleMediaIdentities(e.detail));

      // Lắng nghe sự kiện custom từ MCP / Extension
      window.addEventListener("FLOW_MCP_TRACKER_UPDATE", (e) => this.handleCustomTrackerUpdate(e.detail));
    }

    setMinimized(val) {
      this.minimized = Boolean(val);
      if (this.minimized) {
        this.rootEl?.classList.add("minimized");
        if (this.launcherEl) this.launcherEl.style.display = "flex";
      } else {
        this.rootEl?.classList.remove("minimized");
        if (this.launcherEl) this.launcherEl.style.display = "none";
      }
      try {
        localStorage.setItem(STORAGE_KEY_MINIMIZED, this.minimized ? "1" : "0");
      } catch (_) {}
    }

    loadSavedPosition() {
      try {
        const savedPos = localStorage.getItem(STORAGE_KEY_POS);
        if (savedPos && this.rootEl) {
          const { x, y } = JSON.parse(savedPos);
          const maxX = window.innerWidth - this.rootEl.offsetWidth - 10;
          const maxY = window.innerHeight - this.rootEl.offsetHeight - 10;
          this.rootEl.style.left = `${Math.min(Math.max(10, x), maxX)}px`;
          this.rootEl.style.top = `${Math.min(Math.max(10, y), maxY)}px`;
          this.rootEl.style.right = "auto";
          this.rootEl.style.bottom = "auto";
        }
        const savedMin = localStorage.getItem(STORAGE_KEY_MINIMIZED);
        if (savedMin === "1") {
          this.setMinimized(true);
        }
      } catch (_) {}
    }

    onDragStart(e) {
      if (e.target.closest("button")) return;
      this.isDragging = true;
      const rect = this.rootEl.getBoundingClientRect();
      this.dragOffset.x = e.clientX - rect.left;
      this.dragOffset.y = e.clientY - rect.top;
    }

    onDragMove(e) {
      if (!this.isDragging || !this.rootEl) return;
      e.preventDefault();
      const x = Math.max(10, Math.min(window.innerWidth - this.rootEl.offsetWidth - 10, e.clientX - this.dragOffset.x));
      const y = Math.max(10, Math.min(window.innerHeight - this.rootEl.offsetHeight - 10, e.clientY - this.dragOffset.y));
      this.rootEl.style.left = `${x}px`;
      this.rootEl.style.top = `${y}px`;
      this.rootEl.style.right = "auto";
      this.rootEl.style.bottom = "auto";
    }

    onDragEnd() {
      if (!this.isDragging) return;
      this.isDragging = false;
      try {
        if (this.rootEl) {
          const rect = this.rootEl.getBoundingClientRect();
          localStorage.setItem(STORAGE_KEY_POS, JSON.stringify({ x: rect.left, y: rect.top }));
        }
      } catch (_) {}
    }

    startTimers() {
      // Cập nhật đồng hồ đếm thời gian mỗi giây
      this.timerInterval = setInterval(() => {
        this.updateTimers();
      }, 1000);

      // Định kỳ quét DOM các tiles để đồng bộ trạng thái thực tế
      this.domScanInterval = setInterval(() => {
        this.scanDomTiles();
      }, 2500);
    }

    handleCorrelationReceipt(detail) {
      if (!detail) return;
      const id = detail.operationId || detail.attemptId || detail.mediaUuid;
      if (!id) return;

      const existing = this.jobs.get(id) || {
        id,
        createdAt: Date.now(),
        prompt: detail.prompt || "Video Generation",
        type: detail.mediaType || "video"
      };

      if (detail.status === "COMPLETED" || detail.status === "SUCCESS") {
        existing.status = "completed";
        existing.completedAt = Date.now();
        existing.mediaUuid = detail.mediaUuid || existing.mediaUuid;
        existing.mediaUrl = detail.mediaUrl || detail.videoUrl || detail.imageUrl;
      } else if (detail.status === "FAILED" || detail.error) {
        existing.status = "failed";
        existing.error = detail.error || "Generation error";
      } else {
        existing.status = "rendering";
      }

      this.jobs.set(id, existing);
      this.render();
    }

    handleMediaIdentities(detail) {
      if (!detail?.entries || !Array.isArray(detail.entries)) return;
      for (const entry of detail.entries) {
        const id = entry.mediaUuid || entry.mediaId;
        if (!id) continue;
        const job = this.jobs.get(id);
        if (job) {
          job.mediaUuid = entry.mediaUuid;
          if (entry.videoUrl) job.mediaUrl = entry.videoUrl;
          if (entry.thumbnailUrl) job.thumbnail = entry.thumbnailUrl;
        }
      }
      this.render();
    }

    handleCustomTrackerUpdate(payload) {
      if (!payload || !payload.id) return;
      const id = payload.id;
      const job = this.jobs.get(id) || {
        id,
        createdAt: Date.now(),
        prompt: payload.prompt || "Flow Generation",
        type: payload.type || "video"
      };
      Object.assign(job, payload);
      this.jobs.set(id, job);
      this.render();
    }

    scanDomTiles() {
      // Dùng selector tiles từ FlowSelectors nếu có
      const tileContainers = typeof root.flowQueryAll === "function"
        ? root.flowQueryAll("tiles.container", document)
        : [...document.querySelectorAll("flow-grid-tile-container, [data-tile-id]")];

      if (!tileContainers || !tileContainers.length) return;

      let changed = false;
      for (const tile of tileContainers) {
        const tileId = tile.getAttribute?.("data-tile-id") || tile.getAttribute?.("data-media-id");
        if (!tileId) continue;

        const isBusy = Boolean(tile.querySelector("flow-progress-tile, mat-progress-bar, [role='progressbar'], .spinner"));
        const hasVideo = Boolean(tile.querySelector("video, flow-video-tile"));
        const hasError = Boolean(tile.querySelector("flow-error-tile, [role='alert']"));

        if (!this.jobs.has(tileId)) {
          // Phát hiện tile mới xuất hiện trên trang
          const promptText = tile.querySelector?.("[data-prompt], .prompt-text")?.textContent?.trim() || "Google Flow Media";
          this.jobs.set(tileId, {
            id: tileId,
            createdAt: Date.now(),
            prompt: promptText,
            status: isBusy ? "rendering" : (hasError ? "failed" : (hasVideo ? "completed" : "rendering")),
            type: "video"
          });
          changed = true;
        } else {
          const job = this.jobs.get(tileId);
          const oldStatus = job.status;
          if (isBusy) {
            job.status = "rendering";
          } else if (hasError) {
            job.status = "failed";
          } else if (hasVideo && job.status === "rendering") {
            job.status = "completed";
            job.completedAt = job.completedAt || Date.now();
            const videoEl = tile.querySelector("video");
            if (videoEl?.src) job.mediaUrl = videoEl.src;
          }
          if (oldStatus !== job.status) changed = true;
        }
      }

      if (changed) this.render();
    }

    updateTimers() {
      if (!this.contentEl) return;
      const now = Date.now();
      for (const [id, job] of this.jobs.entries()) {
        const timerEl = this.contentEl.querySelector(`[data-timer-id="${id}"]`);
        if (!timerEl) continue;

        const elapsedSec = Math.floor(((job.completedAt || now) - job.createdAt) / 1000);
        const mins = Math.floor(elapsedSec / 60).toString().padStart(2, "0");
        const secs = (elapsedSec % 60).toString().padStart(2, "0");
        timerEl.textContent = `${mins}:${secs}`;
      }
    }

    render() {
      if (!this.contentEl) return;

      const jobList = Array.from(this.jobs.values()).sort((a, b) => b.createdAt - a.createdAt);
      const activeCount = jobList.filter(j => j.status === "rendering").length;
      const completedCount = jobList.filter(j => j.status === "completed").length;

      // Update badge
      if (this.badgeEl) {
        if (activeCount > 0) {
          this.badgeEl.textContent = `${activeCount} Đang tạo...`;
          this.badgeEl.className = "flow-ft-badge active";
        } else if (jobList.length > 0) {
          this.badgeEl.textContent = `${completedCount}/${jobList.length} Xong`;
          this.badgeEl.className = "flow-ft-badge";
        } else {
          this.badgeEl.textContent = "Idle";
          this.badgeEl.className = "flow-ft-badge";
        }
      }

      // Update progress bar
      if (this.progressFillEl) {
        if (activeCount > 0) {
          this.progressFillEl.classList.add("active");
        } else {
          this.progressFillEl.classList.remove("active");
        }
      }

      // Update Launcher badge
      if (this.launcherBadgeEl && this.launcherEl) {
        if (activeCount > 0) {
          this.launcherBadgeEl.style.display = "flex";
          this.launcherBadgeEl.textContent = String(activeCount);
          this.launcherEl.classList.add("active-pulse");
        } else {
          this.launcherBadgeEl.style.display = "none";
          this.launcherEl.classList.remove("active-pulse");
        }
      }

      if (jobList.length === 0) {
        this.contentEl.innerHTML = `<div class="flow-ft-empty">Chưa có video hoặc ảnh nào đang xử lý.</div>`;
        return;
      }

      this.contentEl.innerHTML = jobList.map(job => {
        const isRendering = job.status === "rendering";
        const isCompleted = job.status === "completed";
        const isFailed = job.status === "failed";

        let statusHtml = "";
        if (isRendering) {
          statusHtml = `<span class="flow-ft-status-tag rendering">⚙️ Đang tạo</span>`;
        } else if (isCompleted) {
          statusHtml = `<span class="flow-ft-status-tag completed">✅ Hoàn thành</span>`;
        } else if (isFailed) {
          statusHtml = `<span class="flow-ft-status-tag failed">❌ Thất bại</span>`;
        }

        const now = Date.now();
        const elapsedSec = Math.floor(((job.completedAt || now) - job.createdAt) / 1000);
        const mins = Math.floor(elapsedSec / 60).toString().padStart(2, "0");
        const secs = (elapsedSec % 60).toString().padStart(2, "0");

        let thumbContent = `<div class="flow-ft-spinner"></div>`;
        if (job.mediaUrl) {
          thumbContent = `<video src="${job.mediaUrl}" muted loop onmouseover="this.play()" onmouseout="this.pause()"></video>`;
        } else if (job.thumbnail) {
          thumbContent = `<img src="${job.thumbnail}" alt="Thumbnail">`;
        } else if (isCompleted) {
          thumbContent = `<span>🎬</span>`;
        } else if (isFailed) {
          thumbContent = `<span>⚠️</span>`;
        }

        let actionHtml = "";
        if (isCompleted && job.mediaUrl) {
          actionHtml = `<a class="flow-ft-action-btn" href="${job.mediaUrl}" target="_blank" download>Tải về</a>`;
        }

        return `
          <div class="flow-ft-card" data-job-id="${job.id}">
            <div class="flow-ft-thumb">${thumbContent}</div>
            <div class="flow-ft-info">
              <div class="flow-ft-prompt" title="${escapeHtml(job.prompt)}">${escapeHtml(job.prompt)}</div>
              <div class="flow-ft-meta">
                ${statusHtml}
                <span class="flow-ft-timer" data-timer-id="${job.id}">${mins}:${secs}</span>
              </div>
            </div>
            ${actionHtml}
          </div>
        `;
      }).join("");
    }
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Khởi tạo Floating Tracker
  const tracker = new FlowFloatingTracker();
  root.flowFloatingTracker = tracker;

})(typeof globalThis !== "undefined" ? globalThis : self);
