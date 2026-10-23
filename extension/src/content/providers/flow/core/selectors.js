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
    signed_out_indicator: {
      selectors: ["main button", "main a[href]", "[role='main'] button", "[role='main'] a[href]"],
      textRegex: /^(?:sign in|log in|continue to sign in|sign in with google|đăng nhập|tiếp tục đăng nhập)(?:\s+.*)?$/i
    },
    video_upload_confirm: {
      selectors: ["button", "[role='button']"],
      textMatch: ["Upload", "Continue", "Confirm", "Agree and continue", "Tải lên", "Tiếp tục", "Xác nhận", "Đồng ý", "Chấp nhận", "Tải video lên"],
      dialogTextRegex: /(?:video|upload|tải lên|tải video|tải tệp)/i
    },
    project_error_indicator: {
      selectors: ["[role='alert']", "mat-error", "flow-error", "[class*='project-error']", "[data-error]", "main h1", "main h2", "[role='main'] h1", "[role='main'] h2"],
      textRegex: /(?:project (?:not found|unavailable|could not be loaded)|(?:we )?couldn['’]?t find (?:this )?project|unable to load (?:this )?project|failed to load project|dự án (?:không tồn tại|không khả dụng|bị xóa)|không thể tải (?:dự án|project)|không tìm thấy dự án|không có quyền truy cập dự án)/i
    },
    media_viewer_owner: {
      selectors: ["flow-media-viewer", "flow-video-viewer", "flow-image-viewer", "[data-testid*='media-viewer']", "[class*='media-viewer']"]
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
          "[role='tab']",
          "button[id*='-trigger-']",
          "button[data-state]"
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

    // 3b. Flow's persistent library layout preferences.
    pageSettings: {
      triggerButton: {
        selectors: ["button", "[role='button']"],
        icons: ["settings_2"]
      },
      panel: {
        selectors: ["[role='dialog']", "[role='menu']", "[aria-modal='true']", "mat-dialog-container", "flow-dialog", ".cdk-overlay-pane", "mat-menu-panel"]
      },
      candidates: {
        selectors: ["[role='tab']", "[role='radio']", "[role='switch']", "[role='checkbox']", "button", "[role='button']", "mat-slide-toggle"]
      },
      detailsRow: {
        selectors: ["label", "[role='group']", "[role='switch']", "[role='checkbox']", "mat-slide-toggle", "button", "[role='button']"]
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
      addToPromptMenuItem: {
        selectors: ['[role="menuitem"]', "mat-menu-item", "button", '[role="button"]'],
        textMatch: ["Add to prompt", "Add To Prompt", "Thêm vào câu lệnh", "Thêm vào lời nhắc", "Thêm vào lời nhắc văn bản", "Thêm vào prompt"],
        iconText: ["add"]
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
      allMediaButton: {
        selectors: ["nav a", "nav button", "[role='navigation'] a", "[role='navigation'] button", "mat-sidenav a", "mat-sidenav button", "[role='navigation'] [role='button']", "mat-sidenav [role='button']"],
        textRegex: /^(?:all media|all content|tất cả nội dung nghe nhìn|tất cả nội dung|nội dung nghe nhìn|tất cả phương tiện|tất cả media|thư viện|tất cả tệp)$/i,
        icons: ["dashboard", "perm_media", "movie", "video_library", "photo_library", "grid_view", "auto_awesome_motion", "folder", "collections"]
      },
      charactersButton: {
        selectors: ["nav a", "nav button", "[role='navigation'] a", "[role='navigation'] button", "mat-sidenav a", "mat-sidenav button", "[role='navigation'] [role='button']", "mat-sidenav [role='button']"],
        textRegex: /^(?:characters|nhân vật|nhan vat)$/i,
        icons: ["accessibility_new", "person", "face"]
      },
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
        "không đủ tín dụng",
        "không đủ điểm tín dụng",
        "đã hết tín dụng",
        "đã hết lượt tạo",
        "đã đạt giới hạn tạo hàng ngày",
        "public_error_user_quota_reached"
      ]
    },

    // 7. Flow Agent Controls
    agent: {
      toggleButton: {
        selectors: ["button", "[role='button']"],
        textRegex: /^(?:Agent|Trợ lý)$/i
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
    agent_instruction_dialog: {
      selectors: ["[role='dialog']", "mat-dialog-container", "flow-dialog", "[aria-modal='true']"],
      textRegex: /(?:agent|assistant|trợ lý).{0,160}(?:instruction|instructions|welcome|hướng dẫn|chỉ dẫn)|(?:instruction|instructions|hướng dẫn).{0,160}(?:agent|assistant|trợ lý)/i
    },
    agent_instruction_done: {
      selectors: ["button", "[role='button']"],
      textRegex: /^(?:Done|Xong|Hoàn tất)$/i
    },
    agent_panel_owner: {
      selectors: ["flow-chat-agent-panel", "flow-agent-panel", "[data-testid*='agent-panel' i]", "[data-test-id*='agent-panel' i]", "[aria-label*='agent panel' i]", "[aria-label*='assistant panel' i]"]
    },
    agent_panel_close: {
      selectors: ["button", "[role='button']"],
      textRegex: /^(?:close|dismiss|đóng|thoát)$/i,
      icon: "close"
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
    },

    // Toby-compatible selector aliases.  They intentionally point at
    // semantic, locale-tolerant defaults so a remote selector update can
    // override one alias without changing operation code.
    toby: {
      slate_editor: { selectors: [".ProseMirror[contenteditable='true']", "flow-base-prompt-box [contenteditable='true']", "[contenteditable='true']"] },
      editor: { selectors: [".ProseMirror[contenteditable='true']", "flow-base-prompt-box [contenteditable='true']", "[contenteditable='true']"] },
      submit_button: { selectors: ["button[type='submit']", "button[data-action='submit']", "button[data-action='generate']", "button", "[role='button']"], icons: ["arrow_forward", "arrow_upward", "send", "sparkle", "auto_awesome", "play_arrow", "north", "east"], textRegex: /(?:start generation|generate|bắt đầu tạo|tạo video|tạo ảnh|tạo hình ảnh)/i },
      tile_container: { selectors: ["flow-grid-tile-container", "[class*='grid-tile-container']", "[class*='grid-tile']"] },
      tile_pending: { selectors: ["flow-progress-tile", "flow-rendering-tile", "flow-generating-tile", "flow-placeholder-tile", "[aria-busy='true']", "[role='progressbar']"] },
      tile_retry_button: { selectors: ["button", "[role='button']"], textRegex: /(?:retry|try again|thử lại|tạo lại)/i, iconRegex: /refresh|replay|retry/i },
      tile_video: { selectors: ["flow-video-tile", "flow-scene-tile", "video"] },
      ingredient_bar: { selectors: ["[contenteditable='true']", "[class*='ingredient' i]", "flow-base-prompt-box"] },
      ingredient_image_chip: { selectors: ["[data-ingredient-type='image']", "[data-kind='image']", "[class*='image-chip' i]"] },
      ingredient_video_chip: { selectors: ["[data-ingredient-type='video']", "[data-kind='video']", "[class*='video-chip' i]"] },
      mention_inline_chip: { selectors: ["[contenteditable='false']", "[data-mention]", "[class*='mention' i]"] },
      ingredient_remove_button: { selectors: ["button", "[role='button']"], icons: ["close", "clear", "cancel"], textRegex: /(?:remove|delete|clear|close|xóa|gỡ|loại bỏ|bỏ khỏi)/i },
      settings_button: { selectors: ["button", "[role='button']"], icons: ["tune", "settings", "settings_2"], textRegex: /(?:settings|cài đặt)/i },
      settings_panel_candidates: { selectors: ["[role='dialog']", "[role='menu']", "mat-dialog-container", "flow-dialog", ".cdk-overlay-pane", "mat-menu-panel"] },
      settings_panel_marker: { selectors: ["[role='radio']", "mat-radio-button", "[role='tab']", "button[id*='-trigger-']"] },
      page_settings_root: { selectors: ["[role='dialog']", "[role='menu']", "[aria-modal='true']", "mat-dialog-container", ".cdk-overlay-pane"] },
      page_settings_trigger: { selectors: ["button", "[role='button']"], icons: ["settings_2", "settings"] },
      page_settings_grid_size: { selectors: ["button", "[role='button']", "[role='radio']"], textRegex: /(?:small|nhỏ|grid|lưới)/i },
      page_settings_grid_view: { selectors: ["button", "[role='button']", "[role='tab']"], icons: ["grid_view", "dashboard", "view_module"], textRegex: /(?:grid|lưới)/i },
      add_component_root: { selectors: ["[role='dialog']", "[role='listbox']", "mat-dialog-container", "flow-dialog", ".cdk-overlay-pane"] },
      add_component_listbox: { selectors: ["[role='listbox']", "mat-select-panel", "[role='dialog']"] },
      add_component_option: { selectors: ["[role='option']", "mat-option", "button", "[role='button']"] },
      add_component_apply_button: { selectors: ["button", "[role='button']"], textRegex: /(?:add to prompt|thêm vào câu lệnh|apply|áp dụng|done|xong)/i },
      add_to_prompt_menu_item: { selectors: ["[role='menuitem']", "mat-menu-item", "button", "[role='button']"], textRegex: /(?:add to prompt|thêm vào câu lệnh|thêm vào lời nhắc)/i, icons: ["add"] },
      download_menu_trigger: { selectors: ["button", "[role='button']"], icons: ["download", "more_vert", "more_horiz"] },
      menu_item: { selectors: ["[role='menuitem']", "button", "[role='button']"] },
      icon_element: { selectors: ["mat-icon", ".mat-icon", ".google-symbols", ".material-symbols-outlined", "i", "svg"] },
      warning_icon: { selectors: ["mat-icon", ".mat-icon", ".google-symbols", "svg"], icons: ["warning", "error", "report_problem"] },
      signed_out_indicator: { selectors: ["main button", "main a[href]", "[role='main'] button", "[role='main'] a[href]"], textRegex: /(?:sign in|log in|đăng nhập|tiếp tục đăng nhập)/i },
      video_upload_confirm: { selectors: ["button", "[role='button']"], textRegex: /(?:upload|continue|confirm|agree|tải lên|tiếp tục|xác nhận|đồng ý|chấp nhận)/i },
      flow_scroll_container: { selectors: ["[class*='scroll']", "main", ".flow-scroll-container", "flow-app"] },
      mode_tab_video: { selectors: ["button[id*='-trigger-VIDEO']", "[role='tab']", "button"], icons: ["videocam"], textRegex: /(?:video)/i },
      mode_tab_image: { selectors: ["button[id*='-trigger-IMAGE']", "[role='tab']", "button"], icons: ["image"], textRegex: /(?:image|ảnh|hình ảnh)/i },
      video_mode_frames: { selectors: ["button[id*='-trigger-VIDEO_FRAMES']", "[role='tab']", "[role='radio']", "button"], icons: ["movie_edit"], textMatch: ["Frames", "Khung hình", "Khung"] },
      video_mode_ingredients: { selectors: ["button[id*='-trigger-VIDEO_REFERENCES']", "[role='tab']", "[role='radio']", "button"], icons: ["interests"], textMatch: ["Ingredients", "Thành phần", "Nguyên liệu"] },
      video_duration_tab: { selectors: ["button[id*='-trigger-']", "[role='tab']", "[role='radio']", "button"], textMatch: ["4s", "5s", "6s", "8s", "10s"] },
      video_resolution_tab: { selectors: ["button[id*='-trigger-']", "[role='tab']", "[role='radio']", "button"], textMatch: ["720p", "1080p"] },
      ratio_button: { selectors: ["button[id*='-trigger-']", "[role='radio']", "[role='tab']", "button"] },
      quantity_button: { selectors: ["button[id*='-trigger-']", "[role='radio']", "[role='tab']", "button"] }
    }
  };

  const selectorFailureLog = [];
  let selectorFailureSequence = 0;
  // Toby's content driver uses flat selector keys while the native extension
  // keeps related keys grouped. Resolve both forms so an updated Toby profile
  // can be copied into flow-selectors.json without forcing every DOM module to
  // know which config layout supplied it.
  const TOBY_SELECTOR_ALIASES = Object.freeze({
    slate_editor: "toby.slate_editor",
    editor: "toby.editor",
    submit_button: "toby.submit_button",
    tile_container: "toby.tile_container",
    tile_pending: "toby.tile_pending",
    tile_retry_button: "toby.tile_retry_button",
    tile_video: "toby.tile_video",
    ingredient_bar: "toby.ingredient_bar",
    ingredient_image_chip: "toby.ingredient_image_chip",
    ingredient_video_chip: "toby.ingredient_video_chip",
    mention_inline_chip: "toby.mention_inline_chip",
    ingredient_remove_button: "toby.ingredient_remove_button",
    settings_button: "toby.settings_button",
    settings_panel_candidates: "toby.settings_panel_candidates",
    settings_panel_marker: "toby.settings_panel_marker",
    page_settings_root: "toby.page_settings_root",
    page_settings_trigger: "toby.page_settings_trigger",
    page_settings_grid_size: "toby.page_settings_grid_size",
    page_settings_grid_view: "toby.page_settings_grid_view",
    add_component_root: "toby.add_component_root",
    add_component_listbox: "toby.add_component_listbox",
    add_component_option: "toby.add_component_option",
    add_component_apply_button: "toby.add_component_apply_button",
    add_to_prompt_menu_item: "toby.add_to_prompt_menu_item",
    download_menu_trigger: "toby.download_menu_trigger",
    menu_item: "toby.menu_item",
    icon_element: "toby.icon_element",
    warning_icon: "toby.warning_icon",
    signed_out_indicator: "toby.signed_out_indicator",
    video_upload_confirm: "toby.video_upload_confirm",
    flow_scroll_container: "toby.flow_scroll_container",
    mode_tab_video: "toby.mode_tab_video",
    mode_tab_image: "toby.mode_tab_image",
    video_mode_frames: "toby.video_mode_frames",
    video_mode_ingredients: "toby.video_mode_ingredients",
    video_duration_tab: "toby.video_duration_tab",
    video_resolution_tab: "toby.video_resolution_tab",
    ratio_button: "toby.ratio_button",
    quantity_button: "toby.quantity_button",
  });
  function recordSelectorFailure(path, details = {}) {
    const record = {
      sequence: ++selectorFailureSequence,
      at: new Date().toISOString(),
      key: typeof path === "string" ? path.slice(0, 120) : "configured-selector",
      reason: String(details.reason || "no_match").slice(0, 40),
      selectorCount: Number(details.selectorCount) || 0,
      candidateCount: Number(details.candidateCount) || 0,
      visibleCandidateCount: Number(details.visibleCandidateCount) || 0,
      invalidSelectors: (details.invalidSelectors || []).slice(0, 6).map(item => ({
        selector: String(item.selector || "").slice(0, 160),
        error: String(item.error || "invalid_selector").slice(0, 100),
      })),
    };
    selectorFailureLog.push(record);
    if (selectorFailureLog.length > 60) selectorFailureLog.splice(0, selectorFailureLog.length - 60);
  }

  function getSelectorFailureDiagnostics(options = {}) {
    const after = Number(options.after) || 0;
    const limit = Math.max(1, Math.min(20, Number(options.limit) || 12));
    return selectorFailureLog.filter(record => record.sequence > after).slice(-limit).map(record => ({ ...record, invalidSelectors: record.invalidSelectors.map(item => ({ ...item })) }));
  }

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
    if (current) return current;
    if (parts.length === 1 && TOBY_SELECTOR_ALIASES[parts[0]]) {
      let alias = FlowSelectors;
      for (const part of TOBY_SELECTOR_ALIASES[parts[0]].split(".")) {
        if (alias == null) return null;
        alias = alias[part];
      }
      return alias || null;
    }
    return null;
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
    if (!scope || typeof scope.querySelectorAll !== "function") return null;
    const selectors = flowGetSelectors(path);
    if (!selectors.length) return null;
    let candidateCount = 0;
    let visibleCandidateCount = 0;
    const invalidSelectors = [];
    const failed = () => {
      if (options.recordFailure !== false) recordSelectorFailure(path, {
        reason: "no_match", selectorCount: selectors.length, candidateCount, visibleCandidateCount, invalidSelectors,
      });
      return null;
    };
    if (options.latestFirst === true) {
      const candidates = [];
      for (const sel of selectors) {
        try {
          const found = scope.querySelectorAll(sel);
          candidateCount += found.length;
          // Keep duplicates across selector tiers: Toby inspects the raw
          // concatenated matches in reverse, so overlapping selectors must
          // retain their tier priority when selecting the newest control.
          for (const el of found) candidates.push(el);
        } catch (error) { invalidSelectors.push({ selector: sel, error: error?.message || error }); }
      }
      for (let index = candidates.length - 1; index >= 0; index--) {
        const element = candidates[index];
        if (options.checkVisible === false) return element;
        if (flowIsVisible(element)) { visibleCandidateCount++; return element; }
      }
      return failed();
    }
    for (const sel of selectors) {
      try {
        // Do not stop at the first DOM match: Flow often leaves hidden stale
        // controls ahead of the active overlay in document order.
        const found = scope.querySelectorAll(sel);
        candidateCount += found.length;
        for (const el of found) {
          if (options.checkVisible === false) return el;
          if (flowIsVisible(el)) { visibleCandidateCount++; return el; }
        }
      } catch (error) { invalidSelectors.push({ selector: sel, error: error?.message || error }); }
    }
    return failed();
  }

  /**
   * Truy vấn tất cả các elements khớp với một key selector.
   */
  function flowQueryAll(path, scope = (typeof document !== "undefined" ? document : null), options = {}) {
    if (!scope || typeof scope.querySelectorAll !== "function") return [];
    const selectors = flowGetSelectors(path);
    if (!selectors.length) return [];
    const results = [];
    const rawResults = [];
    const invalidSelectors = [];
    let candidateCount = 0;
    for (const sel of selectors) {
      try {
        const nodeList = scope.querySelectorAll(sel);
        candidateCount += nodeList.length;
        for (const el of nodeList) {
          if (options.checkVisible !== false) {
            if (flowIsVisible(el)) rawResults.push(el);
          } else {
            rawResults.push(el);
          }
        }
      } catch (error) { invalidSelectors.push({ selector: sel, error: error?.message || error }); }
    }
    if (invalidSelectors.length && options.recordFailure !== false) recordSelectorFailure(path, {
      reason: "invalid_selector",
      selectorCount: selectors.length,
      candidateCount,
      visibleCandidateCount: options.checkVisible === false ? candidateCount : rawResults.length,
      invalidSelectors,
    });
    const ordered = options.latestFirst === true ? rawResults.reverse() : rawResults;
    for (const element of ordered) if (!results.includes(element)) results.push(element);
    return results;
  }

  /**
   * Duyệt candidates từ cấu hình selectors và chỉ chọn phần tử đang thực sự hiển thị trên DOM.
   * Tương tự _v2QueryVisibleConfigured của TobyFlow.
   */
  function flowQueryVisible(path, scope = (typeof document !== "undefined" ? document : null), options = {}) {
    // Toby's configured visible-query helper gathers candidates from every
    // configured selector and inspects the most recently mounted one first.
    // Flow keeps stale/hidden controls mounted behind active dialogs, so use
    // that ordering by default while preserving an explicit first-match opt-out.
    return flowQuery(path, scope, {
      ...options,
      latestFirst: options.latestFirst !== false,
      checkVisible: true,
    });
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
    const configuredIcons = options.icons || config.icons || config.iconText || config.icon_text || (targetIcon ? [targetIcon] : []);
    const targetIcons = (Array.isArray(configuredIcons) ? configuredIcons : [configuredIcons]).map(i => String(i).toLowerCase()).filter(Boolean);
    const configuredIconRegex = options.iconRegex || config.iconRegex || config.icon_regex;
    let targetIconRegex = null;
    try { targetIconRegex = configuredIconRegex instanceof RegExp ? configuredIconRegex : configuredIconRegex ? new RegExp(String(configuredIconRegex), "i") : null; } catch {}
    const configuredTextMatch = options.textMatch || config.textMatch || config.text_match;
    const targetTextValues = (Array.isArray(configuredTextMatch) ? configuredTextMatch : [configuredTextMatch]).map(value => String(value || "").trim()).filter(Boolean);
    const configuredTextRegex = options.textRegex || config.textRegex || config.text_regex;
    let targetTextRegex = null;
    try { targetTextRegex = configuredTextRegex instanceof RegExp ? configuredTextRegex : configuredTextRegex ? new RegExp(String(configuredTextRegex), "i") : null; } catch {}
    const targetText = options.text || config.text;
    const excludedTextRegex = options.excludedTextRegex || (config.excludedTextRegex instanceof RegExp ? config.excludedTextRegex : (config.excludedTextRegex ? new RegExp(config.excludedTextRegex, "i") : null));
    const excludedIcons = (options.excludedIcons || config.excludedComposerIcons || []).map(i => String(i).toLowerCase());

    const configuredCandidates = [];
    const invalidSelectors = [];
    for (const selector of selectors) {
      try {
        for (const candidate of scope.querySelectorAll(selector)) {
          // Preserve cross-tier duplicates so reverse traversal matches
          // Toby's configured selector semantics for overlapping selectors.
          configuredCandidates.push(candidate);
        }
      } catch (error) { invalidSelectors.push({ selector, error: error?.message || error }); }
    }
    const candidates = options.latestFirst === false ? configuredCandidates : configuredCandidates.reverse();
    let visibleCandidateCount = 0;
    for (const el of candidates) {
      try {
          if (options.checkVisible !== false) {
            if (!flowIsVisible(el)) continue;
            visibleCandidateCount++;
          }

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
            const matches = typeof root.matchesFlowUiRegex === "function"
              ? root.matchesFlowUiRegex(cleanText, targetTextRegex)
              : new RegExp(targetTextRegex.source, targetTextRegex.flags.replace("g", "").replace("y", "")).test(cleanText);
            if (!matches) continue;
          } else if (targetText || targetTextValues.length) {
            const normalizedText = typeof root.normalizeFlowUiText === "function" ? root.normalizeFlowUiText(cleanText) : cleanText.toLowerCase();
            const targets = targetTextValues.length ? targetTextValues : [targetText];
            const matchesText = targets.some(value => {
              const normalizedTarget = typeof root.normalizeFlowUiText === "function" ? root.normalizeFlowUiText(value) : String(value).toLowerCase();
              return options.exact ? normalizedText === normalizedTarget : normalizedText.includes(normalizedTarget);
            });
            if (!matchesText) continue;
          }

          if (targetIcons.length || targetIconRegex) {
            const iconMatched = Boolean(iconName && (targetIcons.includes(iconName) || targetIconRegex?.test(iconName)));
            if (options.requireIcon && !iconMatched) continue;
            if (!targetTextRegex && !targetText && !targetTextValues.length && !iconMatched) continue;
          }

          return el;
      } catch (_) {}
    }
    if (options.recordFailure !== false) recordSelectorFailure(path, {
      reason: "semantic_no_match",
      selectorCount: selectors.length,
      candidateCount: candidates.length,
      visibleCandidateCount,
      invalidSelectors,
    });
    return null;
  }

  /**
   * Chờ đợi một element xuất hiện với timeout (polling không tải).
   */
  async function flowWaitFor(path, { timeoutMs = 5000, intervalMs = 100, scope = (typeof document !== "undefined" ? document : null) } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const el = flowQueryVisible(path, scope, { recordFailure: false }) || flowQuery(path, scope, { recordFailure: false });
      if (el) return el;
      if (typeof root.wait === "function") {
        await root.wait(intervalMs);
      } else {
        await new Promise(resolve => setTimeout(resolve, intervalMs));
      }
    }
    recordSelectorFailure(path, { reason: "wait_timeout", selectorCount: flowGetSelectors(path).length });
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
  root.flowSelectorDiagnosticCursor = () => selectorFailureSequence;
  root.flowGetSelectorDiagnostics = getSelectorFailureDiagnostics;
})(typeof globalThis !== "undefined" ? globalThis : self);
