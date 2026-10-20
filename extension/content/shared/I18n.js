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
          wsConnected: "Đã kết nối backend",
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
          btnSidebar: "Mở thanh bên",
          btnStudio: "Mở Studio (Tạo Ảnh / Video / Nhân Vật)",
          btnOpenFlow: "Mở Google Flow",
          reconnecting: "Đang kết nối lại tab Flow hiện tại...",
          previewTriggered: "Đang hiển thị viền xanh trên tab Flow...",
          errNoFlowTab: "Mở Google Flow; tiện ích sẽ tự kết nối với tab đang hoạt động.",
          selectingTab: "Đang tự chọn tab Flow…",
          errBackendDown: "Không kết nối được backend Flow MCP. Hãy đăng nhập tài khoản và kiểm tra HTTPS/phiên bản backend trên VPS.",
          errGeneric: "Lỗi kết nối:",
        },
        sidebar: {
          title: "Flow MCP Studio",
          subtitle: "Tự động hóa trình duyệt Google Flow",
          tabGen: "Tạo nội dung",
          tabStatus: "Trạng thái",
          tabLogs: "Nhật ký MCP",
          tabSettings: "Cài đặt",
          typeImage: "Tạo Ảnh",
          typeVideo: "Tạo Video",
          typeCharacter: "Tạo Nhân Vật",
          promptLabel: "Câu lệnh Prompt",
          promptPlaceholder: "Nhập mô tả hình ảnh hoặc video bạn muốn tạo...",
          promptPlaceholderVideo: "Mô tả chuyển động video, góc máy...",
          charNameLabel: "Tên nhân vật",
          charNamePlaceholder: "Ví dụ: Cô gái áo dài, Chàng trai đeo kính...",
          charDescLabel: "Mô tả ngoại hình nhân vật",
          charDescPlaceholder: "Khuôn mặt, trang phục, phong cách...",
          aspectRatio: "Tỷ lệ khung hình",
          quantity: "Số lượng",
          videoMode: "Chế độ Video",
          videoDuration: "Thời lượng",
          characterSelect: "Nhân vật tham chiếu",
          characterNone: "Không chọn (Mặc định)",
          btnGenerateImage: "Tạo ảnh ngay",
          btnGenerateVideo: "Tạo video ngay",
          btnCreateCharacter: "Tạo nhân vật Flow",
          generating: "Đang gửi lệnh tới Flow...",
          creatingChar: "Đang tạo nhân vật trên Flow...",
          genSuccess: "Đã gửi lệnh tạo thành công tới Flow!",
          charSuccess: "Đã tạo nhân vật thành công!",
          bridgeStatus: "Trạng thái máy chủ",
          activeFlowTab: "Tab Flow kết nối",
          quickActions: "Thao tác nhanh",
          btnReconnect: "Kết nối lại tab Flow",
          btnPreview: "Kiểm tra viền (5s)",
          btnOpenFlow: "Mở Google Flow",
          logsEmpty: "Chưa có hoạt động MCP nào.",
          clearLogs: "Xóa nhật ký",
          saveSettings: "Lưu thiết lập",
          settingsSaved: "Đã lưu cài đặt thành công!"
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
          "start_generation": ["bắt đầu tạo", "tạo video", "tạo ảnh", "tạo hình ảnh", "tạo", "start generation", "generate", "create"],
          "clear_prompt": ["xóa câu lệnh", "xóa lời nhắc", "xóa văn bản", "xóa prompt", "clear prompt", "clear text"],
          "add_ingredients": [
            "thêm thành phần vào hộp câu lệnh", "thêm thành phần vào hộp lời nhắc",
            "thêm thành phần", "thêm nguyên liệu", "thêm nội dung nghe nhìn", "thêm tệp",
            "add ingredients to the prompt box", "add ingredients", "add media"
          ],
          "add_to_prompt": ["thêm vào câu lệnh", "thêm vào lời nhắc", "thêm vào lời nhắc văn bản", "thêm vào prompt", "add to prompt"],
          "add_media": ["thêm nội dung nghe nhìn", "thêm tệp", "thêm phương tiện", "thêm ảnh", "add media"],
          "start_frame": ["khung bắt đầu", "khung đầu", "bắt đầu", "start", "start frame"],
          "end_frame": ["khung kết thúc", "khung cuối", "kết thúc", "end", "end frame"],
          "back": ["quay lại", "quay về", "trở lại", "nút quay lại", "go back", "back", "back button to go to previous page"],
          "done": ["xong", "hoàn tất", "xong việc chỉnh sửa", "xong chỉnh sửa", "done", "done editing"],
          "close": ["đóng", "bỏ qua", "got it", "đóng lại", "close", "dismiss"],
          "save": ["lưu", "áp dụng", "lưu lại", "save"],
          "more_options": ["tùy chọn khác", "tác vụ khác", "thêm tùy chọn", "các tùy chọn khác", "menu tùy chọn", "more options"],
          "download_scene": ["tải xuống cảnh", "tải cảnh", "download scene"],
          "download_image": ["tải xuống hình ảnh", "tải xuống ảnh", "tải ảnh", "tải hình ảnh", "download image"],
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
          "select_a_voice": ["chọn giọng nói", "giọng nói", "chọn một giọng nói", "select a voice"],
          "add_to_character": ["thêm vào nhân vật", "thêm giọng nói vào nhân vật", "thêm giọng nói", "add to character"],
          "add_from_project": ["thêm từ dự án", "chọn từ dự án", "từ dự án", "add from project"],
          "upload": ["tải lên", "tải tệp lên", "tải ảnh lên", "upload"],
          "new_project": ["tạo dự án", "dự án mới", "new project", "create project"],

          // Điều hướng
          "characters": ["nhân vật", "nhan vat", "characters"],
          "all_media": [
            "tất cả nội dung nghe nhìn", "tất cả phương tiện", "tất cả media",
            "thư viện", "tất cả tệp", "all media"
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
          wsConnected: "Backend connected",
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
          btnSidebar: "Open Side Panel",
          btnStudio: "Open Studio (Image / Video / Character)",
          btnOpenFlow: "Open Google Flow",
          reconnecting: "Reconnecting to the active Flow tab...",
          previewTriggered: "Displaying activity border on Flow tab...",
          errNoFlowTab: "Open Google Flow; the extension connects to the active Flow tab automatically.",
          selectingTab: "Selecting a Flow tab automatically…",
          errBackendDown: "Cannot connect to the Flow MCP backend. Sign in and check VPS HTTPS and the deployed backend version.",
          errGeneric: "Connector error:",
        },
        sidebar: {
          title: "Flow MCP Studio",
          subtitle: "Google Flow Browser Automation",
          tabGen: "Create",
          tabStatus: "Status",
          tabLogs: "MCP Logs",
          tabSettings: "Settings",
          typeImage: "Image",
          typeVideo: "Video",
          typeCharacter: "Character",
          promptLabel: "Prompt",
          promptPlaceholder: "Describe the image or video you want to generate...",
          promptPlaceholderVideo: "Describe video motion, camera angles, actions...",
          charNameLabel: "Character Name",
          charNamePlaceholder: "e.g. Cyberpunk Girl, Detective John...",
          charDescLabel: "Character Appearance Description",
          charDescPlaceholder: "Face details, clothes, hair, style...",
          aspectRatio: "Aspect Ratio",
          quantity: "Quantity",
          videoMode: "Video Mode",
          videoDuration: "Duration",
          characterSelect: "Reference Character",
          characterNone: "None (Default)",
          btnGenerateImage: "Generate Image",
          btnGenerateVideo: "Generate Video",
          btnCreateCharacter: "Create Character",
          generating: "Sending generation command to Flow...",
          creatingChar: "Creating character on Flow...",
          genSuccess: "Generation submitted successfully to Flow!",
          charSuccess: "Character created successfully!",
          bridgeStatus: "Server Status",
          activeFlowTab: "Connected Flow Tab",
          quickActions: "Quick Actions",
          btnReconnect: "Reconnect Flow Tab",
          btnPreview: "Preview Border (5s)",
          btnOpenFlow: "Open Google Flow",
          logsEmpty: "No MCP operations recorded yet.",
          clearLogs: "Clear Logs",
          saveSettings: "Save Settings",
          settingsSaved: "Settings saved successfully!"
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
          "start_generation": ["start generation", "generate", "create", "bắt đầu tạo", "tạo", "tạo video", "tạo ảnh", "tạo hình ảnh"],
          "clear_prompt": ["clear prompt", "clear text", "xóa câu lệnh", "xóa lời nhắc", "xóa prompt"],
          "add_ingredients": [
            "add ingredients to the prompt box", "add ingredients", "add media",
            "thêm thành phần vào hộp câu lệnh", "thêm thành phần", "thêm nguyên liệu"
          ],
          "add_to_prompt": ["add to prompt", "thêm vào câu lệnh", "thêm vào lời nhắc"],
          "add_media": ["add media", "thêm nội dung nghe nhìn", "thêm tệp", "thêm phương tiện", "thêm ảnh"],
          "start_frame": ["start frame", "khung bắt đầu", "khung đầu", "bắt đầu", "start"],
          "end_frame": ["end frame", "khung kết thúc", "khung cuối", "kết thúc", "end"],
          "back": ["go back", "back", "back button to go to previous page", "quay lại", "quay về"],
          "done": ["done", "done editing", "xong", "hoàn tất"],
          "close": ["close", "dismiss", "got it", "đóng", "bỏ qua"],
          "save": ["save", "lưu", "áp dụng"],
          "more_options": ["more options", "tùy chọn khác", "thêm tùy chọn", "tác vụ khác", "các tùy chọn khác"],
          "download_scene": ["download scene", "tải xuống cảnh"],
          "download_image": ["download image", "tải xuống ảnh", "tải xuống hình ảnh"],
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
          "all_media": ["all media", "tất cả nội dung nghe nhìn", "tất cả phương tiện", "library", "tất cả tệp"],
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
