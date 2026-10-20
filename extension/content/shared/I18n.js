(function (root) {
  "use strict";

  class I18n {
    static SUPPORTED_LOCALES = [
      { code: "vi", name: "Tiếng Việt", flag: "VI" },
      { code: "en", name: "English", flag: "EN" }
    ];

    static _translations = {
      vi: {
        common: {
          status: "Trạng thái",
          connected: "Đã kết nối",
          disconnected: "Mất kết nối",
          connecting: "Đang kết nối…",
          save: "Lưu",
          saved: "Đã lưu",
          cancel: "Hủy",
          retry: "Thử lại",
          loading: "Đang tải...",
        },
        popup: {
          title: "Flow MCP Connector",
          checking: "Đang kiểm tra…",
          wsConnected: "Đã kết nối WebSocket",
          wsDisconnected: "Mất kết nối máy chủ",
          flowTabs: "Tab Google Flow:",
          selectedTab: "Tab điều khiển:",
          bridgeUrl: "Địa chỉ máy chủ:",
          tabNone: "Chưa chọn tab",
          tabsCount: "{count} tab đang mở",
          tabsNone: "Chưa mở tab Flow",
          btnConnect: "Kết nối lại tab Flow",
          btnPreview: "Xem viền (5s)",
          btnOptions: "Cài đặt",
          reconnecting: "Đang kết nối lại tab Flow hiện tại...",
          previewTriggered: "Đang hiển thị viền xanh trên tab Flow...",
          errNoFlowTab: "Mở Google Flow; tiện ích sẽ tự kết nối với tab đang hoạt động.",
          selectingTab: "Đang tự chọn tab Flow…",
          errBackendDown: "Chưa bật Flow MCP backend (cổng 18899). Hãy chạy Start Flow.cmd.",
          errGeneric: "Lỗi kết nối:",
        },
        errors: {
          navUnavailable: "Không thể mở mục \"{label}\" từ giao diện này.",
          libraryLoading: "Thư viện \"{label}\" của Flow chưa sẵn sàng sau khi chuyển trang.",
          projectRequired: "Vui lòng mở một dự án Flow trước khi thực hiện tác vụ.",
          quotaExceeded: "Đã hết hạn ngạch/credit tạo của Flow: {detail}",
          unusualActivity: "Flow phát hiện hoạt động bất thường hoặc yêu cầu xác minh captcha.",
          policyViolation: "Chính sách an toàn của Flow đã chặn câu lệnh này.",
          rateLimit: "Flow đang bị giới hạn tần suất yêu cầu. Vui lòng chờ giây lát.",
          submitDisabled: "Nút tạo đang bị vô hiệu hóa hoặc chưa sẵn sàng.",
          promptInputUnconfirmed: "Flow không nhận đủ nội dung câu lệnh.",
          referenceAttachUnconfirmed: "Không thể gắn tệp tham chiếu vào hộp câu lệnh."
        },
        patterns: {
          // Nút bấm & Thao tác
          "settings_trigger": ["cài đặt", "kích hoạt cài đặt", "cài đặt tham số", "tune", "settings", "settings trigger"],
          "start_generation": ["tạo", "bắt đầu tạo", "tạo video", "tạo ảnh", "tạo hình ảnh", "bắt đầu", "generate", "create", "start generation"],
          "clear_prompt": ["xóa câu lệnh", "xóa lời nhắc", "xóa văn bản", "xóa prompt", "clear prompt", "clear text"],
          "add_ingredients": [
            "thêm thành phần vào hộp câu lệnh", "thêm thành phần vào hộp lời nhắc",
            "thêm thành phần", "thêm nguyên liệu", "thêm nội dung nghe nhìn", "thêm tệp",
            "add ingredients to the prompt box", "add ingredients", "add media"
          ],
          "add_to_prompt": ["thêm vào câu lệnh", "thêm vào lời nhắc", "thêm vào lời nhắc văn bản", "thêm vào prompt", "thêm", "add to prompt"],
          "start_frame": ["bắt đầu", "khung bắt đầu", "start", "start frame"],
          "end_frame": ["kết thúc", "khung kết thúc", "end", "end frame"],
          "back": ["quay lại", "quay về", "trở lại", "nút quay lại", "go back", "back", "back button to go to previous page"],
          "done": ["xong", "hoàn tất", "lưu", "done", "done editing"],
          "close": ["đóng", "bỏ qua", "hủy", "close", "dismiss", "got it"],
          "save": ["lưu", "áp dụng", "save"],
          "more_options": ["tùy chọn khác", "tác vụ khác", "thêm tùy chọn", "thêm", "more options", "more"],
          "download_scene": ["tải xuống cảnh", "tải cảnh", "download scene"],
          "download_image": ["tải xuống hình ảnh", "tải xuống ảnh", "tải ảnh", "download image"],
          "download_video": ["tải xuống video", "tải video", "download video"],
          "reuse_prompt": ["sử dụng lại câu lệnh", "dùng lại lời nhắc", "dùng lại câu lệnh", "sử dụng lại lời nhắc", "reuse prompt"],
          "start_new_session": ["bắt đầu phiên mới", "phiên mới", "start new session"],
          "account_details": ["chi tiết tài khoản", "tài khoản", "account details"],
          "close_account_panel": ["đóng bảng tài khoản", "đóng tài khoản", "close account panel"],
          "add_media_menu": ["thêm nội dung nghe nhìn", "menu thêm tệp", "thêm tệp", "add media menu", "add media"],
          "skip_to_next_clip": ["chuyển đến đoạn video tiếp theo", "bỏ qua đến clip tiếp theo", "clip tiếp theo", "skip to next clip"],
          "save_frame": ["lưu khung hình", "lưu khung ảnh", "lưu khung", "save frame"],
          "animate": ["tạo hiệu ứng động", "làm chuyển động", "tạo animation", "animate"],
          "agent": ["trợ lý", "agent"],
          "select_a_voice": ["chọn giọng nói", "giọng nói", "select a voice"],
          "add_to_character": ["thêm vào nhân vật", "thêm giọng nói", "add to character"],
          "add_from_project": ["thêm từ dự án", "chọn từ dự án", "add from project"],
          "upload": ["tải lên", "tải tệp lên", "upload"],
          "new_project": ["tạo dự án", "dự án mới", "new project", "create project"],

          // Điều hướng
          "characters": ["nhân vật", "nhan vat", "characters"],
          "all_media": [
            "tất cả nội dung nghe nhìn", "tất cả phương tiện", "tất cả media", "tất cả",
            "nội dung nghe nhìn", "nội dung đa phương tiện", "phương tiện", "nội dung",
            "media", "thư viện", "library", "tất cả tệp", "all media"
          ],

          // Chế độ & Thành phần
          "image": ["hình ảnh", "ảnh", "image", "photo"],
          "video": ["video", "clip"],
          "ingredients": ["thành phần", "nguyên liệu", "ingredients"],
          "frames": ["khung hình", "khung ảnh", "khung", "frames"]
        }
      },
      en: {
        common: {
          status: "Status",
          connected: "Connected",
          disconnected: "Disconnected",
          connecting: "Connecting…",
          save: "Save",
          saved: "Saved",
          cancel: "Cancel",
          retry: "Retry",
          loading: "Loading...",
        },
        popup: {
          title: "Flow MCP Connector",
          checking: "Checking…",
          wsConnected: "Connected via WebSocket",
          wsDisconnected: "Disconnected from server",
          flowTabs: "Google Flow tabs:",
          selectedTab: "Controlled tab:",
          bridgeUrl: "Bridge URL:",
          tabNone: "Not selected",
          tabsCount: "{count} open tab{s}",
          tabsNone: "No Flow tab open",
          btnConnect: "Reconnect Flow tab",
          btnPreview: "Preview border (5s)",
          btnOptions: "Settings",
          reconnecting: "Reconnecting to the active Flow tab...",
          previewTriggered: "Displaying activity border on Flow tab...",
          errNoFlowTab: "Open Google Flow; the extension connects to the active Flow tab automatically.",
          selectingTab: "Selecting a Flow tab automatically…",
          errBackendDown: "Cannot connect to Flow MCP backend (port 18899). Run Start Flow.cmd.",
          errGeneric: "Connector error:",
        },
        errors: {
          navUnavailable: "Flow's project navigation could not open \"{label}\" from this view.",
          libraryLoading: "Flow's \"{label}\" library did not become ready after navigation.",
          projectRequired: "Open a signed-in Flow project first.",
          quotaExceeded: "Flow credit limit reached: {detail}",
          unusualActivity: "Flow detected unusual activity or requires captcha verification.",
          policyViolation: "Flow safety policy blocked this generation: {detail}",
          rateLimit: "Flow rate limited: {detail}",
          submitDisabled: "Flow's Start generation button is disabled or not ready.",
          promptInputUnconfirmed: "Flow did not confirm the full prompt text.",
          referenceAttachUnconfirmed: "Flow did not confirm attaching reference chips."
        },
        patterns: {
          "settings_trigger": ["settings trigger", "tune", "settings", "cài đặt", "kích hoạt cài đặt"],
          "start_generation": ["start generation", "generate", "create", "bắt đầu tạo", "tạo", "tạo video", "tạo ảnh"],
          "clear_prompt": ["clear prompt", "clear text", "xóa câu lệnh", "xóa lời nhắc", "xóa prompt"],
          "add_ingredients": [
            "add ingredients to the prompt box", "add ingredients", "add media",
            "thêm thành phần vào hộp câu lệnh", "thêm thành phần", "thêm nguyên liệu"
          ],
          "add_to_prompt": ["add to prompt", "thêm vào câu lệnh", "thêm vào lời nhắc", "thêm"],
          "start_frame": ["start", "start frame", "bắt đầu", "khung bắt đầu"],
          "end_frame": ["end", "end frame", "kết thúc", "khung kết thúc"],
          "back": ["go back", "back", "back button to go to previous page", "quay lại", "quay về"],
          "done": ["done", "done editing", "xong", "hoàn tất"],
          "close": ["close", "dismiss", "got it", "đóng", "bỏ qua"],
          "save": ["save", "lưu", "áp dụng"],
          "more_options": ["more options", "more", "tùy chọn khác", "thêm"],
          "download_scene": ["download scene", "tải xuống cảnh"],
          "download_image": ["download image", "tải xuống ảnh"],
          "download_video": ["download video", "tải xuống video"],
          "reuse_prompt": ["reuse prompt", "sử dụng lại câu lệnh"],
          "start_new_session": ["start new session", "bắt đầu phiên mới"],
          "account_details": ["account details", "chi tiết tài khoản"],
          "close_account_panel": ["close account panel", "đóng bảng tài khoản"],
          "add_media_menu": ["add media menu", "add media", "thêm tệp"],
          "skip_to_next_clip": ["skip to next clip", "bỏ qua đến clip tiếp theo"],
          "save_frame": ["save frame", "lưu khung hình"],
          "animate": ["animate", "tạo animation"],
          "agent": ["agent", "trợ lý"],
          "select_a_voice": ["select a voice", "chọn giọng nói"],
          "add_to_character": ["add to character", "thêm vào nhân vật"],
          "add_from_project": ["add from project", "thêm từ dự án"],
          "upload": ["upload", "tải lên"],
          "new_project": ["new project", "create project", "tạo dự án"],
          "characters": ["characters", "nhân vật", "nhan vat"],
          "all_media": ["all media", "tất cả nội dung nghe nhìn", "tất cả phương tiện", "tất cả", "library", "tất cả tệp"],
          "image": ["image", "photo", "hình ảnh", "ảnh"],
          "video": ["video", "clip"],
          "ingredients": ["ingredients", "thành phần", "nguyên liệu"],
          "frames": ["frames", "khung hình", "khung"]
        }
      }
    };

    static _currentLocale = "vi";
    static _fallbackLocale = "en";
    static _initialized = false;

    static async init(defaultLocale = null) {
      if (this._initialized && !defaultLocale) return;
      const saved = await this._getSavedLocale();
      this._currentLocale = defaultLocale || saved || this._detectBrowserLocale() || "vi";
      this._initialized = true;
    }

    static async _getSavedLocale() {
      try {
        if (typeof chrome !== "undefined" && chrome.storage?.local) {
          const res = await chrome.storage.local.get(["af_locale", "lang"]);
          return res.af_locale || res.lang || null;
        }
      } catch (_) {}
      try {
        return localStorage.getItem("af_locale") || localStorage.getItem("lang") || null;
      } catch (_) { return null; }
    }

    static _detectBrowserLocale() {
      try {
        const lang = (navigator.language || "").split("-")[0].toLowerCase();
        return this.SUPPORTED_LOCALES.some(l => l.code === lang) ? lang : "vi";
      } catch (_) { return "vi"; }
    }

    static getLocale() {
      return this._currentLocale;
    }

    static async setLocale(locale) {
      if (!this.SUPPORTED_LOCALES.some(l => l.code === locale)) {
        console.warn("[I18n] Unsupported locale:", locale);
        return;
      }
      this._currentLocale = locale;
      try {
        if (typeof chrome !== "undefined" && chrome.storage?.local) {
          await chrome.storage.local.set({ af_locale: locale, lang: locale });
        }
      } catch (_) {}
      try {
        localStorage.setItem("af_locale", locale);
        localStorage.setItem("lang", locale);
      } catch (_) {}
    }

    static t(key, params = {}) {
      const getNested = (obj, path) => {
        if (!obj || !path) return undefined;
        return path.split(".").reduce((o, k) => (o || {})[k], obj);
      };

      let translation = getNested(this._translations[this._currentLocale], key);
      if (translation === undefined && this._currentLocale !== this._fallbackLocale) {
        translation = getNested(this._translations[this._fallbackLocale], key);
      }
      if (translation === undefined) return key;

      if (typeof translation === "function") {
        return translation(params);
      }

      if (typeof params === "number") {
        params = { count: params, s: params === 1 ? "" : "s" };
      } else if (params && typeof params === "object" && params.count !== undefined && params.s === undefined) {
        params = { ...params, s: Number(params.count) === 1 ? "" : "s" };
      }

      if (typeof translation === "string" && params && typeof params === "object") {
        let result = translation;
        for (const [p, v] of Object.entries(params)) {
          result = result.replace(new RegExp(`\\{${p}\\}`, "g"), v);
        }
        return result;
      }

      return translation;
    }

    static getPatterns(key) {
      const normKey = String(key || "").trim().toLowerCase().replace(/[\s.-]/g, "_");
      const current = this._translations[this._currentLocale]?.patterns?.[normKey] || [];
      const fallback = this._translations[this._fallbackLocale]?.patterns?.[normKey] || [];
      // Combine patterns from both languages, ensuring current language has higher priority
      return [...new Set([...current, ...fallback])];
    }

    static getAllPatterns(category = "patterns") {
      const dict = this._translations[this._currentLocale]?.[category] || {};
      const fallback = this._translations[this._fallbackLocale]?.[category] || {};
      const allKeys = new Set([...Object.keys(dict), ...Object.keys(fallback)]);
      const result = {};
      for (const k of allKeys) {
        result[k] = this.getPatterns(k);
      }
      return result;
    }

    static applyTranslations(container = document) {
      if (!container?.querySelectorAll) return;

      container.querySelectorAll("[data-i18n]").forEach(el => {
        const key = el.getAttribute("data-i18n");
        const val = this.t(key);
        if (val !== undefined && val !== key) el.textContent = val;
      });

      container.querySelectorAll("[data-i18n-placeholder]").forEach(el => {
        const key = el.getAttribute("data-i18n-placeholder");
        const val = this.t(key);
        if (val !== undefined && val !== key) el.placeholder = val;
      });

      container.querySelectorAll("[data-i18n-title]").forEach(el => {
        const key = el.getAttribute("data-i18n-title");
        const val = this.t(key);
        if (val !== undefined && val !== key) {
          el.setAttribute("title", val);
          el.setAttribute("aria-label", val);
        }
      });
    }

    static formatDate(date, options = {}) {
      const d = date instanceof Date ? date : new Date(date);
      const code = this._currentLocale === "vi" ? "vi-VN" : "en-US";
      return new Intl.DateTimeFormat(code, { day: "2-digit", month: "2-digit", year: "numeric", ...options }).format(d);
    }
  }

  // Pre-initialize locale from storage synchronously if possible
  try {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      chrome.storage.local.get(["af_locale", "lang"], res => {
        if (res?.af_locale || res?.lang) I18n._currentLocale = res.af_locale || res.lang;
      });
    }
  } catch (_) {}

  root.I18n = I18n;
})(typeof globalThis !== "undefined" ? globalThis : self);
