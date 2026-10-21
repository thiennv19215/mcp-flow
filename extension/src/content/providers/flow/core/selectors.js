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
      scene: {
        selectors: [
          "flow-scene-tile"
        ]
      },
      image: {
        selectors: [
          "flow-image-tile",
          "img"
        ]
      },
      mediaElements: {
        selectors: [
          "video",
          "img",
          "canvas",
          "[role='img']",
          "flow-video-tile",
          "flow-image-tile"
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
      panel: {
        selectors: [
          "[role='dialog']",
          "[role='menu']",
          "mat-dialog-container",
          "flow-dialog",
          ".cdk-overlay-pane",
          "mat-menu-panel"
        ]
      },
      options: {
        selectors: [
          "[role='radio']",
          "mat-radio-button",
          "[role='tab']"
        ]
      },
      optionCandidates: {
        selectors: [
          "[role='radio']",
          "mat-radio-button",
          "[role='tab']",
          "[role='option']",
          "button",
          "[role='button']"
        ]
      },
      dropdownItems: {
        selectors: [
          "[role='menuitem']",
          "[role='menuitemradio']",
          "mat-option",
          "[role='option']"
        ]
      },
      activeMenu: {
        selectors: [
          "[role='menu']:last-of-type",
          "[data-radix-popper-content-wrapper]:last-of-type",
          ".cdk-overlay-pane:last-of-type"
        ]
      },
      durationTrigger: {
        selectors: [
          "button[id*='-trigger-']"
        ]
      }
    },

    // 4. Components & Characters
    components: {
      inlineChips: {
        selectors: [
          '[contenteditable="false"]',
          'button[aria-label="Ingredient"]',
          'button[aria-label="Thành phần"]',
          'button[aria-label="Nguyên liệu"]',
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
      },
      categoryTabs: {
        selectors: [
          '[role="tab"]',
          "button"
        ]
      },
      searchInput: {
        selectors: [
          "input",
          '[role="textbox"]'
        ],
        textRegex: /(?:search assets|tìm kiếm|search)/i
      },
      dialog: {
        selectors: [
          '[role="dialog"]',
          "mat-dialog-container",
          "flow-dialog"
        ]
      },
      actionMenus: {
        selectors: [
          '[role="menu"]',
          "mat-menu-panel",
          ".cdk-overlay-pane"
        ]
      },
      actionMenuItems: {
        selectors: [
          '[role="menuitem"]',
          "button",
          '[role="button"]'
        ]
      },
      chips: {
        selectors: [
          'button[aria-label="Ingredient"]',
          'button[aria-label="Thành phần"]',
          'button[aria-label="Nguyên liệu"]',
          "button",
          '[role="button"]'
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
      },
      navContainer: {
        selectors: [
          "nav",
          "[role='navigation']",
          "mat-sidenav"
        ]
      },
      backButton: {
        selectors: ["button", "[role='button']"],
        icons: ["arrow_back", "arrow-back", "back"]
      },
      dialogCloseButton: {
        selectors: ["button", "[role='button']"],
        icons: ["close", "clear"]
      },
      overlayBackdrop: {
        selectors: [
          ".cdk-overlay-backdrop.cdk-overlay-backdrop-showing",
          ".cdk-overlay-backdrop"
        ]
      },
      projectLinks: {
        selectors: [
          "a[href*='/project/']"
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
      },
      nameInput: {
        selectors: [
          "input",
          "[role='textbox']"
        ],
        textRegex: /(?:Character name|Tên nhân vật)/i
      },
      personalityInput: {
        selectors: [
          "textarea",
          "input",
          "[role='textbox']"
        ],
        textRegex: /(?:Character personality|Tính cách nhân vật|Mô tả nhân vật)/i
      },
      searchInput: {
        selectors: [
          "input",
          "[role='textbox']"
        ]
      }
    },

    // 9. Media Menu
    mediaMenu: {
      triggerButton: {
        selectors: ["button", "[role='button']"],
        icons: ["more_vert", "more_horiz", "more"]
      },
      menuPanel: {
        selectors: ["[role='menu']", "mat-menu-panel"]
      },
      menuItems: {
        selectors: ["[role='menuitem']", "button", "[role='button']"]
      },
      menuItemLabel: {
        selectors: [".label", ".item-text"]
      },
      removeIcons: {
        selectors: ["mat-icon", ".mat-icon", "svg", ".google-symbols"]
      }
    },

    // 10. Common & Shared Elements
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
      },
      buttons: {
        selectors: [
          "button",
          "[role='button']",
          "a[role='button']"
        ]
      },
      loadingIndicator: {
        selectors: [
          "[role='progressbar']",
          "[aria-busy='true']"
        ]
      },
      headings: {
        selectors: [
          "h1",
          "h2",
          "[role='heading']"
        ]
      },
      textboxes: {
        selectors: [
          "input",
          "textarea",
          "[role='textbox']"
        ]
      },
      dialogs: {
        selectors: [
          "[role='dialog']",
          "mat-dialog-container",
          "flow-dialog",
          "[aria-modal='true']"
        ]
      },
      menus: {
        selectors: [
          "[role='menu']",
          "mat-menu-panel",
          ".cdk-overlay-pane"
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
    if (typeof path === "object" && !Array.isArray(path)) return path;
    const parts = String(path).split(".");
    let current = FlowSelectors;
    for (const part of parts) {
      if (current == null) return null;
      current = current[part];
    }
    return current || null;
  }

  /**
   * Trả về mảng selector string cho một key hoặc cấu hình.
   */
  function flowGetSelectors(path) {
    if (!path) return [];
    if (Array.isArray(path)) return path;
    if (typeof path === "object" && Array.isArray(path.selectors)) return path.selectors;
    const config = flowGetConfig(path);
    if (!config) {
      if (typeof path === "string" && (path.includes(" ") || path.includes(".") || path.includes("[") || path.includes(">") || path.includes("#") || path.includes(":") || path.includes(","))) {
        return [path];
      }
      return [];
    }
    if (Array.isArray(config)) return config;
    if (Array.isArray(config.selectors)) return config.selectors;
    return [];
  }

  /**
   * Kiểm tra một element có đang thực sự hiển thị trên DOM hay không (TobyFlow compatible).
   * Tiêu chuẩn: isConnected !== false và getBoundingClientRect().width > 0 && height > 0.
   */
  function flowIsVisible(el) {
    if (!el) return false;
    if (typeof el.isConnected === "boolean" && !el.isConnected) return false;
    if (typeof root.visible === "function") {
      try {
        if (!root.visible(el)) return false;
      } catch (_) {}
    }
    if (typeof el.getBoundingClientRect === "function") {
      try {
        const r = el.getBoundingClientRect();
        if (r && (r.width === 0 || r.height === 0)) return false;
      } catch (_) {}
    }
    return true;
  }

  /**
   * Truy vấn 1 element đầu tiên khớp với một key selector.
   */
  function flowQuery(path, scope = (typeof document !== "undefined" ? document : null), options = {}) {
    if (!scope || typeof scope.querySelector !== "function") return null;
    const selectors = flowGetSelectors(path);
    if (!selectors.length) return null;
    for (const sel of selectors) {
      try {
        const el = scope.querySelector(sel);
        if (el) {
          if (options.checkVisible !== false) {
            if (flowIsVisible(el)) return el;
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
  function flowQueryAll(path, scope = (typeof document !== "undefined" ? document : null), options = {}) {
    if (!scope || typeof scope.querySelectorAll !== "function") return [];
    const selectors = flowGetSelectors(path);
    if (!selectors.length) return [];
    const results = [];
    for (const sel of selectors) {
      try {
        const nodeList = scope.querySelectorAll(sel);
        for (const el of nodeList) {
          if (options.checkVisible !== false) {
            if (flowIsVisible(el) && !results.includes(el)) results.push(el);
          } else {
            if (!results.includes(el)) results.push(el);
          }
        }
      } catch (_) {}
    }
    return results;
  }

  /**
   * Duyệt candidates từ cấu hình selectors và chỉ chọn phần tử đang thực sự hiển thị trên DOM.
   * Tương tự _v2QueryVisibleConfigured của TobyFlow.
   */
  function flowQueryVisible(path, scope = (typeof document !== "undefined" ? document : null)) {
    if (!scope || typeof scope.querySelectorAll !== "function") return null;
    const selectors = flowGetSelectors(path);
    if (!selectors.length) return null;
    for (const sel of selectors) {
      try {
        const candidates = scope.querySelectorAll(sel);
        for (const el of candidates) {
          if (flowIsVisible(el)) return el;
        }
      } catch (_) {}
    }
    return null;
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
   * Tìm phần tử thỏa mãn selector kết hợp icon text / button text (Semantic Query Engine).
   */
  function flowFindSemantic(path, scope = (typeof document !== "undefined" ? document : null), options = {}) {
    if (!scope || typeof scope.querySelectorAll !== "function") return null;
    const config = flowGetConfig(path) || {};
    const selectors = flowGetSelectors(path);
    if (!selectors.length) return null;

    const targetIcon = options.icon || config.icon;
    const targetIcons = (options.icons || config.icons || (targetIcon ? [targetIcon] : [])).map(i => String(i).toLowerCase());
    const targetTextRegex = options.textRegex || (config.textRegex instanceof RegExp ? config.textRegex : (config.textRegex ? new RegExp(config.textRegex, "i") : null));
    const targetText = options.text || config.text;
    const excludedTextRegex = options.excludedTextRegex || (config.excludedTextRegex instanceof RegExp ? config.excludedTextRegex : (config.excludedTextRegex ? new RegExp(config.excludedTextRegex, "i") : null));
    const excludedIcons = (options.excludedIcons || config.excludedComposerIcons || []).map(i => String(i).toLowerCase());

    for (const sel of selectors) {
      try {
        const candidates = scope.querySelectorAll(sel);
        for (const el of candidates) {
          if (options.checkVisible !== false && !flowIsVisible(el)) continue;

          // Check icon
          const iconEl = flowFindIcon(el);
          const iconName = iconEl ? (iconEl.getAttribute?.("fonticon") || iconEl.textContent || "").trim().toLowerCase() : "";
          if (excludedIcons.length && iconName && excludedIcons.includes(iconName)) continue;

          // Check text
          const text = (typeof root.semanticActionText === "function" ? root.semanticActionText(el) : null) ||
                       (typeof root.accessibleName === "function" ? root.accessibleName(el) : null) ||
                       el.getAttribute?.("aria-label") || el.innerText || el.textContent || "";
          const cleanText = text.replace(/\s+/g, " ").trim();

          if (excludedTextRegex && excludedTextRegex.test(cleanText)) continue;

          if (targetTextRegex) {
            if (!targetTextRegex.test(cleanText)) continue;
          } else if (targetText) {
            if (options.exact) {
              if (cleanText.toLowerCase() !== String(targetText).toLowerCase()) continue;
            } else {
              if (!cleanText.toLowerCase().includes(String(targetText).toLowerCase())) continue;
            }
          }

          if (targetIcons.length) {
            const iconMatched = iconName && targetIcons.includes(iconName);
            if (options.requireIcon && !iconMatched) continue;
            if (!targetTextRegex && !targetText && !iconMatched) continue;
          }

          return el;
        }
      } catch (_) {}
    }
    return null;
  }

  /**
   * Chờ đợi một element xuất hiện với timeout (polling không tải).
   */
  async function flowWaitFor(path, { timeoutMs = 5000, intervalMs = 100, scope = (typeof document !== "undefined" ? document : null) } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const el = flowQueryVisible(path, scope) || flowQuery(path, scope);
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
        if (typeof val === "string" && (key.endsWith("Regex") || key.endsWith("Pattern") || key.endsWith("Aria") || target[key] instanceof RegExp)) {
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
  root.flowIsVisible = flowIsVisible;
  root.flowQuery = flowQuery;
  root.flowQueryAll = flowQueryAll;
  root.flowQueryVisible = flowQueryVisible;
  root.flowFindSemantic = flowFindSemantic;
  root.flowFindIcon = flowFindIcon;
  root.flowWaitFor = flowWaitFor;
  root.flowMergeSelectors = flowMergeSelectors;
})(typeof globalThis !== "undefined" ? globalThis : self);
