(function (root) {
  "use strict";

  const FlowSelectors = {
    // 1. Editor & Prompt Composer
    editor: {
      selectors: [
        ".ProseMirror[contenteditable='true']",
        ".ProseMirror",
        "flow-base-prompt-box [contenteditable='true']",
        "textarea[aria-label*='prompt']"
      ]
    },
    composerRoot: {
      selectors: [
        ".flow-composer",
        "flow-base-prompt-box",
        "form[class*='composer']",
        "[class*='composer']"
      ]
    },
    submitButton: {
      selectors: [
        "button[type='submit']",
        "button[data-action='submit']",
        "button[data-action='generate']",
        "button",
        "[role='button']"
      ],
      icons: ["arrow_forward", "arrow_upward", "send", "sparkle", "auto_awesome", "play_arrow", "north", "east"],
      textRegex: /(?:start generation|generate|bắt đầu tạo|tạo video|tạo ảnh|tạo hình ảnh|tạo prompt)/i,
      nearComposerTextRegex: /(?:create|tạo)/i,
      excludedTextRegex: /(?:project|dự án|character|nhân vật|folder|thư mục|settings|cài đặt|tune|clear prompt|xóa câu lệnh|xóa văn bản|quay lại|back|upload|tải lên|aspect ratio|tỷ lệ|resolution|độ phân giải|duration|thời lượng|download|tải xuống|share|chia sẻ|ingredient|thành phần)/i,
      excludedComposerIcons: ["tune", "settings", "close", "clear", "add", "add_circle", "delete", "aspect_ratio", "crop", "download", "share", "fullscreen", "undo", "redo", "history"],
      excludedComposerAria: /setting|cài đặt|clear|xóa|thành phần|ingredient|add media|thêm|aspect|tỷ lệ|resolution|độ phân giải/i
    },

    // 2. Tiles & Media Output
    tiles: {
      container: {
        selectors: [
          "flow-grid-tile-container",
          "[class*='grid-tile-container']",
          "[class*='grid-tile']"
        ],
        attribute: "data-tile-id"
      },
      progressBar: {
        selectors: [
          "flow-progress-tile",
          "mat-progress-bar",
          "[role='progressbar']",
          "[class*='progress-bar']",
          "[class*='progressbar']"
        ]
      },
      spinner: {
        selectors: [
          "mat-spinner",
          "mat-progress-spinner",
          "[class*='spinner']",
          "[class*='loading']",
          "[class*='loader']",
          "[class*='shimmer']",
          "[class*='skeleton']",
          "svg[class*='spin']"
        ]
      },
      placeholder: {
        selectors: [
          "flow-progress-tile",
          "flow-rendering-tile",
          "flow-generating-tile",
          "flow-placeholder-tile",
          "[class*='rendering']",
          "[class*='generating']",
          "[class*='placeholder']"
        ]
      },
      error: {
        selectors: [
          "flow-error-tile",
          "[class*='error-tile']",
          "[class*='error']",
          "[class*='failed']",
          "[class*='warning-tile']",
          "[role='alert']"
        ]
      },
      video: {
        selectors: [
          "flow-video-tile",
          "flow-scene-tile"
        ]
      },
      retryButton: {
        selectors: ["button", "[role='button']"],
        textRegex: /^(?:retry|try again|thử lại)(?:\s+.*)?$/i,
        iconRegex: /refresh|replay|retry/i
      }
    },

    // 3. Settings & Options
    settings: {
      triggerButton: {
        selectors: ["button", "[role='button']"],
        icon: "tune"
      },
      options: {
        selectors: [
          "[role='radio']",
          "mat-radio-button",
          "[role='tab']"
        ]
      }
    },

    // 4. Components & Characters
    components: {
      inlineChips: {
        selectors: [
          '[contenteditable="false"]',
          'button[aria-label="Ingredient"]',
          '[class*="ingredient-chip"]'
        ]
      },
      characterTile: {
        selectors: [
          "flow-character-tile"
        ]
      },
      listBox: {
        selectors: [
          '[role="listbox"]',
          "mat-select-panel"
        ]
      },
      optionItem: {
        selectors: [
          '[role="option"]',
          "mat-option"
        ]
      },
      voiceChip: {
        selectors: [
          '[data-ingredient-type="voice"]',
          '[data-kind="voice"]',
          '[class*="voice-chip" i]',
          'button[aria-label*="voice" i]',
          'button[aria-label*="giọng" i]'
        ]
      },
      voiceRemoveButton: {
        selectors: [
          'button[aria-label*="remove" i]',
          'button[aria-label*="delete" i]',
          'button[aria-label*="xóa" i]',
          '[role="button"][aria-label*="remove" i]'
        ]
      }
    },

    // 5. Navigation & Layout
    navigation: {
      newProjectButton: {
        selectors: ["button", "a[role='button']"],
        icons: ["add", "create", "new"],
        textRegex: /new project|tạo dự án|dự án mới|create project/i
      },
      scrollContainer: {
        selectors: [
          "[class*='scroll']",
          "main",
          ".flow-scroll-container",
          "flow-app"
        ]
      }
    },

    // 6. Quota & Credit Limit Alerts
    creditLimit: {
      selectors: [
        "[role='alert']",
        "mat-error",
        ".flow-alert",
        "[class*='alert']",
        "[class*='error']",
        "[class*='quota']",
        "[class*='credit']"
      ],
      patterns: [
        "run out of credits",
        "no credits remaining",
        "not enough credits",
        "credit limit reached",
        "bạn đã hết credit",
        "không đủ credit",
        "hết hạn mức credit",
        "public_error_user_quota_reached"
      ]
    },

    // 7. Flow Agent Controls
    agent: {
      toggleButton: {
        selectors: ["button", "[role='button']"],
        textRegex: /^Agent$/i
      },
      closeButton: {
        selectors: ["button", "[role='button']"],
        icon: "close"
      },
      instructionDoneButton: {
        selectors: ["button", "[role='button']"],
        textRegex: /^(?:Done|Xong|Hoàn tất)$/i
      }
    },

    // 8. Characters Elements
    characters: {
      createTile: {
        selectors: ["flow-custom-tile"]
      },
      characterTile: {
        selectors: ["flow-character-tile"]
      },
      portrait: {
        selectors: [
          "img[aria-label='Generated character image']",
          "img[aria-label='Ảnh nhân vật đã tạo']",
          "img[aria-label*='nhân vật']",
          "img[aria-label*='character']"
        ]
      }
    },

    // 9. Common & Shared Elements
    common: {
      icons: {
        selectors: [
          "mat-icon",
          ".mat-icon",
          ".google-symbols",
          ".material-symbols-outlined",
          "i",
          "svg"
        ]
      }
    }
  };

  /**
   * Truy xuất cấu hình selector theo chuỗi đường dẫn (dot notation).
   * Ví dụ: flowGetConfig("editor") hoặc flowGetConfig("tiles.container")
   */
  function flowGetConfig(path) {
    if (!path) return null;
    const parts = String(path).split(".");
    let current = FlowSelectors;
    for (const part of parts) {
      if (current == null) return null;
      current = current[part];
    }
    return current || null;
  }

  /**
   * Trả về mảng selector string cho một key.
   */
  function flowGetSelectors(path) {
    const config = flowGetConfig(path);
    if (!config) return [];
    if (Array.isArray(config)) return config;
    if (Array.isArray(config.selectors)) return config.selectors;
    return [];
  }

  /**
   * Truy vấn 1 element đầu tiên khớp với một key selector.
   * Hỗ trợ tìm kiếm theo nhiều tier ưu tiên và kiểm tra tính hiển thị.
   */
  function flowQuery(path, scope = document, options = {}) {
    const selectors = flowGetSelectors(path);
    if (!selectors.length) return null;
    for (const sel of selectors) {
      try {
        const el = scope.querySelector(sel);
        if (el) {
          if (options.checkVisible !== false && typeof root.visible === "function") {
            if (root.visible(el)) return el;
          } else {
            return el;
          }
        }
      } catch (_) {}
    }
    return null;
  }

  /**
   * Truy vấn tất cả các elements khớp với một key selector.
   */
  function flowQueryAll(path, scope = document, options = {}) {
    const selectors = flowGetSelectors(path);
    if (!selectors.length) return [];
    for (const sel of selectors) {
      try {
        const nodeList = scope.querySelectorAll(sel);
        if (nodeList.length > 0) {
          const arr = Array.from(nodeList);
          if (options.checkVisible !== false && typeof root.visible === "function") {
            const visibleArr = arr.filter(el => root.visible(el));
            if (visibleArr.length > 0) return visibleArr;
          } else {
            return arr;
          }
        }
      } catch (_) {}
    }
    return [];
  }

  /**
   * Tìm icon element bên trong một parent container theo danh sách icons chuẩn.
   */
  function flowFindIcon(element) {
    if (!element?.querySelector) return null;
    const iconSelectors = FlowSelectors.common.icons.selectors;
    for (const sel of iconSelectors) {
      try {
        const icon = element.querySelector(sel);
        if (icon) return icon;
      } catch (_) {}
    }
    return null;
  }

  /**
   * Chờ đợi một element xuất hiện với timeout (polling không tải).
   */
  async function flowWaitFor(path, { timeoutMs = 5000, intervalMs = 100, scope = document } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const el = flowQuery(path, scope);
      if (el) return el;
      if (typeof root.wait === "function") {
        await root.wait(intervalMs);
      } else {
        await new Promise(resolve => setTimeout(resolve, intervalMs));
      }
    }
    return null;
  }

  /**
   * Hợp nhất cấu hình selectors từ Remote Backend vào FlowSelectors cục bộ.
   */
  function flowMergeSelectors(remote) {
    if (!remote || typeof remote !== "object") return;
    function deepMerge(target, source) {
      for (const key of Object.keys(source)) {
        const val = source[key];
        if (val == null) continue;
        if (typeof val === "string" && (key.endsWith("Regex") || key.endsWith("Pattern") || target[key] instanceof RegExp)) {
          try {
            target[key] = new RegExp(val, "i");
          } catch (_) {
            target[key] = val;
          }
        } else if (Array.isArray(val)) {
          target[key] = [...val];
        } else if (typeof val === "object" && typeof target[key] === "object" && !Array.isArray(target[key])) {
          deepMerge(target[key], val);
        } else {
          target[key] = val;
        }
      }
    }
    deepMerge(FlowSelectors, remote);
    console.log("[FlowSelectors] 🔄 Merged dynamic remote selectors from backend successfully.");
  }

  // Tự động lắng nghe và đồng bộ từ Backend thông qua chrome.storage.local
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    try {
      chrome.storage.local.get("flow_remote_selectors", (res) => {
        if (res?.flow_remote_selectors) {
          flowMergeSelectors(res.flow_remote_selectors);
        }
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes.flow_remote_selectors?.newValue) {
          flowMergeSelectors(changes.flow_remote_selectors.newValue);
        }
      });
    } catch (_) {}
  }

  // Gắn lên global root (window hoặc globalThis)
  root.FlowSelectors = FlowSelectors;
  root.flowGetConfig = flowGetConfig;
  root.flowGetSelectors = flowGetSelectors;
  root.flowQuery = flowQuery;
  root.flowQueryAll = flowQueryAll;
  root.flowFindIcon = flowFindIcon;
  root.flowWaitFor = flowWaitFor;
  root.flowMergeSelectors = flowMergeSelectors;
})(typeof globalThis !== "undefined" ? globalThis : self);
