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
      // Only queue jobs explicitly submitted through the extension belong in
      // this widget. Flow itself contains many unrelated tiles and emits
      // correlation events for those tiles as well.
      this.jobs = new Map(); // queue job id -> job object
      this.queueSnapshot = null;
      this.minimized = false;
      this.positionLocked = false;
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
      void this.refreshQueueSnapshot();
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
        .flow-ft-status-tag.cancelled {
          color: #9ca3af;
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
        /* Queue panel layout: compact summary + Auto Gen groups. */
        #flow-mcp-tracker-root {
          box-sizing: border-box;
          width: min(500px, calc(100vw - 24px));
          max-height: min(470px, calc(100vh - 32px));
          border-radius: 14px;
          background: linear-gradient(180deg, rgba(25, 29, 37, 0.94), rgba(11, 14, 20, 0.97));
        }
        #flow-mcp-tracker-root.expanded {
          width: min(620px, calc(100vw - 24px));
          max-height: min(640px, calc(100vh - 24px));
        }
        .flow-ft-header {
          gap: 8px;
          padding: 7px 9px;
          background: rgba(255, 255, 255, 0.045);
        }
        .flow-ft-icon {
          width: 25px;
          height: 25px;
          border-radius: 50%;
          background: #ccff00;
          color: #172000;
        }
        .flow-ft-title {
          font-size: 15px;
          letter-spacing: 0;
        }
        .flow-ft-auto {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 4px 8px;
          border-radius: 12px;
          background: rgba(66, 153, 225, 0.22);
          color: #78b9ff;
          font-size: 11px;
          font-weight: 700;
        }
        .flow-ft-auto::before { content: "↗"; font-size: 12px; }
        .flow-ft-queue-state { display: inline-flex; align-items: center; padding: 3px 7px; border-radius: 10px; background: rgba(148,163,184,.14); color: #cbd5e1; font-size: 10px; font-weight: 700; white-space: nowrap; }
        .flow-ft-queue-state.running { color: #d9ff5f; background: rgba(204,255,0,.13); }
        .flow-ft-queue-state.paused { color: #facc15; background: rgba(250,204,21,.13); }
        .flow-ft-queue-state.waiting { color: #93c5fd; background: rgba(96,165,250,.14); }
        .flow-ft-resume-btn { color: #d9ff5f; }
        .flow-ft-summary {
          display: flex;
          align-items: center;
          gap: 9px;
          padding: 6px 12px 5px;
          color: #9ca3af;
          font-size: 11px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.07);
          white-space: nowrap;
          overflow-x: auto;
        }
        .flow-ft-summary-total { color: #f3f4f6; font-family: ui-monospace, monospace; margin-right: 2px; }
        .flow-ft-summary-item { display: inline-flex; align-items: center; gap: 4px; }
        .flow-ft-summary-item strong { font-size: 12px; color: #e5e7eb; }
        .flow-ft-summary-item.sent strong { color: #93c5fd; }
        .flow-ft-summary-item.rendering strong { color: #ccff00; }
        .flow-ft-summary-item.queued strong { color: #facc15; }
        .flow-ft-summary-item.completed strong { color: #34d399; }
        .flow-ft-summary-item.failed strong { color: #fb7185; }
        .flow-ft-group {
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
          padding: 5px 0 4px;
        }
        .flow-ft-group:last-child { border-bottom: 0; }
        .flow-ft-group-header {
          display: flex;
          align-items: center;
          gap: 8px;
          min-height: 22px;
          padding: 0 4px 4px;
        }
        .flow-ft-group-dot { width: 8px; height: 8px; border-radius: 50%; background: #60a5fa; flex: 0 0 auto; }
        .flow-ft-group-name { color: #f3f4f6; font-weight: 700; }
        .flow-ft-group-time { color: #9ca3af; font-family: ui-monospace, monospace; font-size: 11px; }
        .flow-ft-group-actions { margin-left: auto; display: flex; align-items: center; gap: 5px; }
        .flow-ft-mini-btn {
          width: 27px;
          height: 25px;
          border: 0;
          border-radius: 6px;
          background: rgba(255,255,255,0.08);
          color: #aeb6c3;
          cursor: pointer;
          font-size: 12px;
        }
        .flow-ft-mini-btn:hover { background: rgba(255,255,255,0.18); color: #fff; }
        .flow-ft-mini-btn.danger { color: #fb7185; }
        .flow-ft-group-progress {
          position: relative;
          height: 3px;
          margin: 0 4px 6px;
          border-radius: 4px;
          overflow: hidden;
          background: rgba(255,255,255,0.08);
        }
        .flow-ft-group-progress > span { display: block; height: 100%; border-radius: 4px; background: #ccff00; transition: width .25s ease; }
        .flow-ft-task {
          display: flex;
          align-items: flex-start;
          gap: 9px;
          min-height: 39px;
          padding: 3px 4px;
          border-radius: 8px;
        }
        .flow-ft-task:hover { background: rgba(255,255,255,0.05); }
        .flow-ft-task-index {
          width: 24px;
          height: 38px;
          display: flex;
          align-items: center;
          justify-content: center;
          color: #9ca3af;
          font-family: ui-monospace, monospace;
          font-size: 11px;
          flex: 0 0 auto;
        }
        .flow-ft-task-info { min-width: 0; flex: 1 1 0; }
        .flow-ft-task-line { display: flex; align-items: center; gap: 7px; min-width: 0; }
        .flow-ft-task-type { color: #c4d4e8; font-size: 11px; font-weight: 700; white-space: nowrap; }
        .flow-ft-task-prompt { min-width: 0; flex: 1 1 auto; color: #f3f4f6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
        .flow-ft-task-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; min-width: 0; min-height: 16px; color: #8b95a5; font-size: 10px; }
        .flow-ft-task-error { min-width: 0; margin-top: 3px; color: #fda4af; font-size: 10px; line-height: 1.4; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
        .flow-ft-task-remove { flex: 0 0 auto; opacity: .7; }
        .flow-ft-task-remove:hover { opacity: 1; color: #fb7185; }
        .flow-ft-status-tag { display: inline-flex; align-items: center; padding: 2px 6px; border-radius: 5px; background: rgba(148,163,184,.12); font-weight: 700; line-height: 1.2; }
        .flow-ft-status-tag.queued { color: #facc15; background: rgba(250,204,21,.13); }
        .flow-ft-status-tag.rendering { color: #d9ff5f; background: rgba(204,255,0,.13); }
        .flow-ft-status-tag.completed { color: #34d399; background: rgba(52,211,153,.13); }
        .flow-ft-status-tag.failed { color: #fb7185; background: rgba(251,113,133,.14); }
        .flow-ft-status-tag.cancelled { color: #9ca3af; background: rgba(148,163,184,.14); }
        .flow-ft-status-tag.awaiting-user { color: #93c5fd; background: rgba(96,165,250,.14); }
        .flow-ft-task .flow-ft-thumb { width: 28px; height: 28px; border-radius: 6px; }
        .flow-ft-task .flow-ft-spinner { width: 15px; height: 15px; }
        .flow-ft-task .flow-ft-action-btn { padding: 3px 7px; }
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
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4.5 4.5c0 4 2.4 4.3 5 6.1 1.4 1 2.6 1.4 4.1 1.4h5.9M4.5 19.5c0-4 2.4-4.3 5-6.1 1.4-1 2.6-1.4 4.1-1.4h5.9"/>
              <circle cx="4.5" cy="4.5" r="1.7" fill="currentColor" stroke="none"/>
              <circle cx="4.5" cy="19.5" r="1.7" fill="currentColor" stroke="none"/>
              <circle cx="19.5" cy="12" r="2" fill="currentColor" stroke="none"/>
            </svg>
          </div>
          <div class="flow-ft-title">Flow MCP</div>
          <div class="flow-ft-auto">Auto</div>
          <div class="flow-ft-queue-state" id="flow-ft-queue-state">Sẵn sàng</div>
          <div class="flow-ft-controls">
            <button class="flow-ft-btn" data-ft-action="expand" title="Mở rộng/thu gọn">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
            </button>
            <button class="flow-ft-btn" data-ft-action="lock" title="Khóa vị trí">🔒</button>
            <button class="flow-ft-btn" data-ft-action="clear" title="Xóa các task đã xong">🗑</button>
            <button class="flow-ft-btn flow-ft-resume-btn" data-ft-action="resume" title="Chạy tiếp hàng chờ" style="display:none">▶</button>
            <button class="flow-ft-btn" data-ft-action="pause" title="Tạm dừng hàng chờ">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="4" width="5" height="16" rx="1"/><rect x="14" y="4" width="5" height="16" rx="1"/></svg>
            </button>
            <button class="flow-ft-btn flow-ft-stop-btn" data-ft-action="stop" title="Dừng hàng chờ">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>
            </button>
            <button class="flow-ft-btn" id="flow-ft-minimize-btn" title="Thu nhỏ">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </button>
            <button class="flow-ft-btn" id="flow-ft-close-btn" title="Đóng">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        </div>
        <div class="flow-ft-summary" id="flow-ft-summary">
          <span class="flow-ft-summary-total" id="flow-ft-total">0/0</span>
          <span class="flow-ft-summary-item sent">➤ <strong id="flow-ft-sent">0</strong> đã gửi</span>
          <span class="flow-ft-summary-item rendering">⚡ <strong id="flow-ft-rendering">0</strong> đang tạo</span>
          <span class="flow-ft-summary-item queued">Ⅱ <strong id="flow-ft-queued">0</strong> chờ</span>
          <span class="flow-ft-summary-item completed">✓ <strong id="flow-ft-completed">0</strong> xong</span>
          <span class="flow-ft-summary-item failed">× <strong id="flow-ft-failed">0</strong> lỗi</span>
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
      this.summaryEl = rootEl.querySelector("#flow-ft-summary");
      this.totalEl = rootEl.querySelector("#flow-ft-total");
      this.sentEl = rootEl.querySelector("#flow-ft-sent");
      this.renderingEl = rootEl.querySelector("#flow-ft-rendering");
      this.queuedEl = rootEl.querySelector("#flow-ft-queued");
      this.completedEl = rootEl.querySelector("#flow-ft-completed");
      this.failedEl = rootEl.querySelector("#flow-ft-failed");
      this.progressFillEl = rootEl.querySelector("#flow-ft-progress-fill");
      this.queueStateEl = rootEl.querySelector("#flow-ft-queue-state");
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

      this.rootEl?.querySelector('[data-ft-action="expand"]')?.addEventListener("click", () => {
        this.rootEl?.classList.toggle("expanded");
      });
      this.rootEl?.querySelector('[data-ft-action="lock"]')?.addEventListener("click", event => {
        this.positionLocked = !this.positionLocked;
        event.currentTarget.classList.toggle("active", this.positionLocked);
        event.currentTarget.title = this.positionLocked ? "Mở khóa vị trí" : "Khóa vị trí";
      });
      this.rootEl?.querySelector('[data-ft-action="pause"]')?.addEventListener("click", () => {
        void this.sendQueueAction("flow-queue:pause");
      });
      this.rootEl?.querySelector('[data-ft-action="resume"]')?.addEventListener("click", () => {
        void this.sendQueueAction("flow-queue:resume");
      });
      this.rootEl?.querySelector('[data-ft-action="stop"]')?.addEventListener("click", () => {
        void this.sendQueueAction("flow-queue:stop");
      });
      this.rootEl?.querySelector('[data-ft-action="clear"]')?.addEventListener("click", () => {
        this.clearFinishedTasks();
      });

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

      // Queue broadcasts are the source of truth for tasks submitted by the
      // user. This also keeps multiple submissions visible independently.
      if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
        chrome.runtime.onMessage.addListener((message) => {
          if (message?.type === "flow-queue:changed") this.syncQueueSnapshot(message.snapshot);
        });
      }
    }

    async sendQueueAction(type, id) {
      if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;
      try {
        await chrome.runtime.sendMessage({ type, ...(id ? { id } : {}) });
      } catch (_) {}
    }

    clearFinishedTasks() {
      for (const job of this.jobs.values()) {
        if (["completed", "failed", "cancelled"].includes(job.status)) void this.sendQueueAction("flow-queue:remove", job.id);
      }
    }

    async refreshQueueSnapshot() {
      if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;
      try {
        const response = await chrome.runtime.sendMessage({ type: "flow-queue:get" });
        if (response?.ok) this.syncQueueSnapshot(response);
      } catch (_) {
        // The tracker is optional; Flow can still be used when the worker is
        // restarting or the extension context is being torn down.
      }
    }

    resolveQueueType(job) {
      const payload = job?.payload || job?.data?.payload || {};
      const params = payload?.params || {};
      const raw = String(payload?.type || params?.type || "").toLowerCase();
      const operation = String(job?.operation || "").toLowerCase();
      if (operation.includes("download-generated")) return "download";
      if (raw.includes("video") || operation.includes("video") || operation.includes("edit") || operation.includes("continue")) return "video";
      if (raw.includes("character")) return "character";
      return "image";
    }

    resolveQueuePrompt(job) {
      if (String(job?.operation || "") === "flow.queue.download-generated") return "Kết quả Flow đã tạo";
      const payload = job?.payload || job?.data?.payload || {};
      const params = payload?.params || {};
      const prompt = payload?.prompt || params?.prompt || params?.description || "";
      const label = String(job?.label || job?.name || "").replace(/^\[(?:IMAGE|VIDEO)\]\s*/i, "").trim();
      return String(prompt || label || "").trim();
    }

    queueStatus(status) {
      if (status === "running") return "rendering";
      if (status === "completed") return "completed";
      if (status === "failed") return "failed";
      if (status === "cancelled") return "cancelled";
      if (status === "waiting_for_user") return "awaiting-user";
      return "queued";
    }

    syncQueueSnapshot(snapshot) {
      this.queueSnapshot = snapshot || null;
      const queueJobs = Array.isArray(snapshot?.jobs)
        ? snapshot.jobs
        : Array.isArray(snapshot?.items) ? snapshot.items : [];
      const visibleIds = new Set();
      for (const queueJob of queueJobs) {
        // Sidebar/queue-panel jobs and explicit MCP queue jobs carry one of
        // these markers. Ignore persisted or Flow-created items without a
        // submission source.
        if (!(["extension", "mcp"].includes(String(queueJob?.metadata?.source || ""))) || !queueJob.id) continue;
        const id = String(queueJob.id);
        visibleIds.add(id);
        const type = this.resolveQueueType(queueJob);
        const typeLabel = type === "download" ? "Tải kết quả" : type === "video" ? "Tạo video" : type === "character" ? "Tạo nhân vật" : "Tạo ảnh";
        const detail = this.resolveQueuePrompt(queueJob);
        const previous = this.jobs.get(id) || {};
        const completed = queueJob.status === "completed";
        Object.assign(previous, {
          id,
          queueJobId: id,
          source: "queue",
          metadata: queueJob.metadata,
          batchId: queueJob.batchId || queueJob.metadata?.batchId,
          createdAt: Number(queueJob.addedAt) || previous.createdAt || Date.now(),
          completedAt: Number(queueJob.finishedAt) || previous.completedAt,
          title: typeLabel,
          prompt: detail ? `${typeLabel}: ${detail}` : typeLabel,
          detailPrompt: detail,
          type,
          status: this.queueStatus(queueJob.status),
          progress: queueJob.progress,
          error: queueJob.error,
          result: queueJob.result,
          mediaUrl: previous.mediaUrl,
          thumbnail: previous.thumbnail,
          completed,
        });
        this.jobs.set(id, previous);
      }

      // A removed/cleared queue item should disappear from the tracker too.
      for (const id of this.jobs.keys()) if (!visibleIds.has(id)) this.jobs.delete(id);
      this.render();
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
      if (this.positionLocked || e.target.closest("button")) return;
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

      // Completion comes from the main-world correlation observer and queue
      // broadcasts. Do not poll every Flow tile here; old tiles are unrelated
      // to the user's queue and DOM polling causes unnecessary page work.
      this.domScanInterval = null;
    }

    handleCorrelationReceipt(detail) {
      if (!detail) return;
      const candidates = [detail.jobId, detail.job_id, detail.operationId, detail.attemptId, detail.mediaUuid]
        .filter(Boolean).map(String);
      const existing = candidates.map(id => this.jobs.get(id)).find(Boolean)
        || Array.from(this.jobs.values()).find(job => candidates.includes(String(job.operationId || job.attemptId || job.mediaUuid || "")));
      // Never create a card from a passive Flow event. It may belong to a tile
      // created outside this extension's queue.
      if (!existing) return;

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

      this.render();
    }

    handleMediaIdentities(detail) {
      if (!detail?.entries || !Array.isArray(detail.entries)) return;
      for (const entry of detail.entries) {
        const id = entry.mediaUuid || entry.mediaId;
        if (!id) continue;
        const job = this.jobs.get(id) || Array.from(this.jobs.values()).find(item => String(item.mediaUuid || item.mediaId || "") === String(id));
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
      const id = String(payload.id);
      const job = this.jobs.get(id);
      // Custom events must identify a queue submission before they can add a
      // card. This prevents background observer noise from creating extras.
      if (!job && payload.source !== "queue" && payload.userSubmitted !== true) return;
      const target = job || { id, queueJobId: id, createdAt: Date.now(), source: "queue" };
      Object.assign(target, payload);
      this.jobs.set(id, target);
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

        const job = this.jobs.get(tileId) || Array.from(this.jobs.values()).find(item => String(item.mediaUuid || item.mediaId || "") === String(tileId));
        if (job) {
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
      const queuedCount = jobList.filter(j => j.status === "queued").length;
      const completedCount = jobList.filter(j => j.status === "completed").length;
      const failedCount = jobList.filter(j => j.status === "failed").length;
      const firstCreatedAt = jobList.length ? Math.min(...jobList.map(job => Number(job.createdAt) || Date.now())) : Date.now();

      if (this.totalEl) this.totalEl.textContent = `${completedCount}/${jobList.length}  ${this.formatDuration(Date.now() - firstCreatedAt)}`;
      if (this.sentEl) this.sentEl.textContent = String(jobList.length);
      if (this.renderingEl) this.renderingEl.textContent = String(activeCount);
      if (this.queuedEl) this.queuedEl.textContent = String(queuedCount);
      if (this.completedEl) this.completedEl.textContent = String(completedCount);
      if (this.failedEl) this.failedEl.textContent = String(failedCount);

      const pendingCount = Number(this.queueSnapshot?.pending ?? this.queueSnapshot?.pendingCount ?? queuedCount);
      const waitingForUser = Number(this.queueSnapshot?.waitingForUser) > 0 || jobList.some(job => job.status === "awaiting-user");
      const isRunning = this.queueSnapshot?.isRunning === true || activeCount > 0;
      const isPaused = this.queueSnapshot?.isPaused === true;
      const stateText = isRunning ? "Đang chạy" : waitingForUser ? "Chờ bạn thao tác" : isPaused ? "Tạm dừng" : pendingCount > 0 ? `Chờ chạy · ${pendingCount}` : jobList.length && completedCount + failedCount === jobList.length ? "Đã xong" : "Sẵn sàng";
      if (this.queueStateEl) {
        this.queueStateEl.textContent = stateText;
        this.queueStateEl.className = `flow-ft-queue-state ${isRunning ? "running" : isPaused ? "paused" : waitingForUser ? "waiting" : pendingCount ? "stopped" : ""}`;
      }
      const resumeButton = this.rootEl?.querySelector('[data-ft-action="resume"]');
      const pauseButton = this.rootEl?.querySelector('[data-ft-action="pause"]');
      if (resumeButton) resumeButton.style.display = !isRunning && !waitingForUser && (pendingCount > 0 || isPaused) ? "inline-flex" : "none";
      if (pauseButton) pauseButton.style.display = isRunning ? "inline-flex" : "none";

      // Update progress bar
      if (this.progressFillEl) {
        const ratio = jobList.length ? completedCount / jobList.length : 0;
        this.progressFillEl.classList.toggle("active", activeCount > 0);
        this.progressFillEl.style.transform = `scaleX(${Math.max(0, Math.min(1, ratio))})`;
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
        this.contentEl.innerHTML = `<div class="flow-ft-empty">Chưa có task nào trong hàng chờ.</div>`;
        return;
      }

      const groups = new Map();
      for (const job of jobList) {
        const groupId = String(job.batchId || job.metadata?.batchId || `job-${job.id}`);
        if (!groups.has(groupId)) groups.set(groupId, []);
        groups.get(groupId).push(job);
      }

      this.contentEl.innerHTML = Array.from(groups.values()).map(groupJobs => {
        const groupStart = Math.min(...groupJobs.map(job => Number(job.createdAt) || Date.now()));
        const groupElapsed = this.formatDuration(Date.now() - groupStart);
        const groupDone = groupJobs.filter(job => job.status === "completed").length;
        const groupPercent = groupJobs.length ? Math.round(groupDone * 100 / groupJobs.length) : 0;
        const groupId = String(groupJobs[0].batchId || groupJobs[0].metadata?.batchId || `job-${groupJobs[0].id}`);
        const tasks = groupJobs.map((job, index) => this.renderTask(job, index + 1)).join("");
        return `
          <section class="flow-ft-group" data-group-id="${escapeHtml(groupId)}">
            <div class="flow-ft-group-header">
              <span class="flow-ft-group-dot"></span>
              <span class="flow-ft-group-name">Auto Gen</span>
              <span class="flow-ft-group-time">${groupElapsed}</span>
              <div class="flow-ft-group-actions">
                <button class="flow-ft-mini-btn" data-ft-action="pause-group" title="Tạm dừng">Ⅱ</button>
                <button class="flow-ft-mini-btn" data-ft-action="stop-group" title="Dừng">■</button>
                <button class="flow-ft-mini-btn" data-ft-action="download-group" title="Tải kết quả">↓</button>
                <button class="flow-ft-mini-btn danger" data-ft-action="remove-group" data-group-job-id="${escapeHtml(groupJobs[0].id)}" title="Xóa nhóm">🗑</button>
              </div>
            </div>
            <div class="flow-ft-group-progress"><span style="width:${groupPercent}%"></span></div>
            ${tasks}
          </section>
        `;
      }).join("");

      this.contentEl.querySelectorAll("[data-ft-action='remove-group']").forEach(button => {
        button.addEventListener("click", () => {
          const group = button.closest(".flow-ft-group");
          const ids = [...(group?.querySelectorAll("[data-task-id]") || [])].map(item => item.dataset.taskId).filter(Boolean);
          if (!ids.length && button.dataset.groupJobId) ids.push(button.dataset.groupJobId);
          for (const id of ids) void this.sendQueueAction("flow-queue:remove", id);
        });
      });
      this.contentEl.querySelectorAll("[data-ft-action='pause-group']").forEach(button => {
        button.addEventListener("click", () => void this.sendQueueAction("flow-queue:pause"));
      });
      this.contentEl.querySelectorAll("[data-ft-action='stop-group']").forEach(button => {
        button.addEventListener("click", () => void this.sendQueueAction("flow-queue:stop"));
      });
      this.contentEl.querySelectorAll("[data-ft-action='download-group']").forEach(button => {
        button.addEventListener("click", () => {
          const group = button.closest(".flow-ft-group");
          const pendingDownloads = [...(group?.querySelectorAll("button[data-ft-action='download-task']") || [])];
          if (pendingDownloads.length) {
            for (const taskButton of pendingDownloads) void this.sendQueueAction("flow-queue:download", taskButton.dataset.taskId);
            return;
          }
          const media = group?.querySelector("a.flow-ft-action-btn");
          media?.click();
        });
      });
      this.contentEl.querySelectorAll("[data-ft-action='download-task']").forEach(button => {
        button.addEventListener("click", () => void this.sendQueueAction("flow-queue:download", button.dataset.taskId));
      });
      this.contentEl.querySelectorAll("[data-ft-action='remove-task']").forEach(button => {
        button.addEventListener("click", () => void this.sendQueueAction("flow-queue:remove", button.dataset.taskId));
      });
    }

    formatDuration(durationMs) {
      const seconds = Math.max(0, Math.floor(Number(durationMs || 0) / 1000));
      const mins = Math.floor(seconds / 60).toString().padStart(2, "0");
      const secs = (seconds % 60).toString().padStart(2, "0");
      return `${mins}:${secs}`;
    }

    renderTask(job, index) {
      const isQueued = job.status === "queued";
      const isAwaitingUser = job.status === "awaiting-user";
      const isRendering = job.status === "rendering";
      const isCompleted = job.status === "completed";
      const isFailed = job.status === "failed";
      const isCancelled = job.status === "cancelled";
      const typeLabel = job.title || (job.type === "video" ? "Tạo video" : job.type === "character" ? "Tạo nhân vật" : "Tạo ảnh");
      const statusLabel = isQueued ? "Chờ chạy" : isAwaitingUser ? "Chờ bạn bấm Tạo" : isRendering ? (job.type === "download" ? "Đang tải" : "Đang tạo") : isCompleted ? "Xong" : isFailed ? "Thất bại" : isCancelled ? "Đã hủy" : "Đang xử lý";
      const statusClass = isQueued ? "queued" : isAwaitingUser ? "awaiting-user" : isRendering ? "rendering" : isCompleted ? "completed" : isFailed ? "failed" : isCancelled ? "cancelled" : "";
      const elapsed = this.formatDuration((job.completedAt || Date.now()) - job.createdAt);
      const percent = Number.isFinite(Number(job.progress?.percent)) ? `${Math.max(0, Math.min(100, Number(job.progress.percent)))}%` : elapsed;
      const prompt = job.detailPrompt || String(job.prompt || "").replace(/^(Tạo ảnh|Tạo video|Tạo nhân vật):\s*/i, "");
      let thumbContent = isRendering || isQueued ? `<div class="flow-ft-spinner"></div>` : (isFailed ? "⚠️" : isCancelled ? "✕" : "✓");
      if (job.thumbnail) thumbContent = `<img src="${escapeHtml(job.thumbnail)}" alt="Thumbnail">`;
      let actionHtml = "";
      const download = Array.isArray(job.result?.result?.browserDownloads) ? job.result.result.browserDownloads[0] : Array.isArray(job.result?.browserDownloads) ? job.result.browserDownloads[0] : null;
      const checkpoint = job.metadata?.generationResultCheckpoint?.media;
      const resultMedia = job.result?.result?.result?.media || job.result?.result?.media || job.result?.media;
      const generatedMedia = Array.isArray(checkpoint) && checkpoint.length ? checkpoint : resultMedia;
      const downloadState = String(job.progress?.download?.state || "skipped").toLowerCase();
      const canDownload = job.operation !== "flow.queue.download-generated" && (isCompleted || isFailed) && Array.isArray(generatedMedia) && generatedMedia.some(item =>
        item?.id && (item?.title || item?.name) && ["image", "video"].includes(String(item?.kind || item?.type || "").toLowerCase()),
      ) && !["queued", "downloading", "completed"].includes(downloadState);
      if (canDownload) actionHtml = `<button class="flow-ft-action-btn" data-ft-action="download-task" data-task-id="${escapeHtml(job.id)}" title="Tải media đã tạo">↓</button>`;
      else if (isCompleted && job.mediaUrl) actionHtml = `<a class="flow-ft-action-btn" href="${escapeHtml(job.mediaUrl)}" target="_blank" download>↓</a>`;
      else if (download?.filename) actionHtml = `<span class="flow-ft-action-btn" title="${escapeHtml(download.filename)}">↓</span>`;
      return `
        <div class="flow-ft-task" data-job-id="${escapeHtml(job.id)}">
          <div class="flow-ft-task-index">#${index}</div>
          <div class="flow-ft-thumb">${thumbContent}</div>
          <div class="flow-ft-task-info">
            <div class="flow-ft-task-line">
              <span class="flow-ft-task-type">${escapeHtml(typeLabel)}</span>
              <span class="flow-ft-task-prompt" title="${escapeHtml(prompt)}">${escapeHtml(prompt || "Không có prompt")}</span>
            </div>
            <div class="flow-ft-task-meta">
              <span class="flow-ft-status-tag ${statusClass}">${statusLabel}</span>
              <span class="flow-ft-timer" data-timer-id="${escapeHtml(job.id)}">${percent}</span>
            </div>
            ${job.error ? `<div class="flow-ft-task-error">${escapeHtml(String(job.error))}</div>` : ""}
          </div>
          ${actionHtml}
          <button class="flow-ft-mini-btn flow-ft-task-remove danger" data-ft-action="remove-task" data-task-id="${escapeHtml(job.id)}" title="Xóa task">🗑</button>
        </div>
      `;
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
