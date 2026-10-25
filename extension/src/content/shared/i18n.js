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
          checking: "Đang kiểm tra…",
          wsConnected: "Đã kết nối backend",
          wsDisconnected: "Mất kết nối máy chủ",
          flowTabs: "Tab Google Flow:",
          selectedTab: "Tab điều khiển:",
          tabNone: "Chưa chọn tab",
          tabsCount: "{count} tab đang mở",
          tabsNone: "Chưa mở tab Flow",
          noFlowTabHint: "Chưa có tab Flow nào đang mở. Mở Flow để bắt đầu tạo ảnh/video.",
          btnOpenFlow: "Mở Google Flow",
          reconnecting: "Đang kết nối lại tab Flow hiện tại...",
          previewTriggered: "Đang hiển thị viền xanh trên tab Flow...",
        },
        character: {
          none: "Nhân vật",
        },
        voice: {
          random: "Giọng ngẫu nhiên",
        },
        header: {
          lightMode: "Chế độ sáng",
          darkMode: "Chế độ tối",
        },
        sidebar: {
          title: "Flow MCP Studio",
          subtitle: "Tự động hóa trình duyệt Google Flow",
          tabGen: "Tạo nội dung",
          tabWorkflow: "Quy trình",
          tabPrompts: "Prompt",
          tabLibrary: "Thư viện",
          tabTasks: "Tác vụ",
          tabHistory: "Lịch sử",
          tabStatus: "Trạng thái",
          tabLogs: "Nhật ký MCP",
          tabSettings: "Cài đặt",
          viewCreateTitle: "Tạo nội dung",
          viewCreateSubtitle: "Tạo ảnh, video hoặc nhân vật trên tab Flow đang kết nối.",
          viewWorkflowTitle: "Quy trình Flow",
          viewWorkflowSubtitle: "Chạy Agent batch, chỉnh sửa hoặc tiếp tục video bằng DOM Flow.",
          viewPromptsTitle: "Prompt đã lưu",
          viewPromptsSubtitle: "Lưu prompt cục bộ và đưa lại vào màn hình tạo.",
          viewLibraryTitle: "Thư viện Flow",
          viewLibrarySubtitle: "Dự án, media, nhân vật và tham chiếu.",
          viewTasksTitle: "Tác vụ",
          viewTasksSubtitle: "Theo dõi và điều khiển hàng đợi trên extension.",
          viewHistoryTitle: "Lịch sử cục bộ",
          viewHistorySubtitle: "Các lệnh đã chạy trên extension, không đồng bộ qua FlowAPI.",
          viewStatusTitle: "Trạng thái Flow",
          viewStatusSubtitle: "Tab Flow mà extension đang điều khiển.",
          viewLogsTitle: "Nhật ký MCP",
          viewLogsSubtitle: "Các lệnh và kết quả gần đây từ extension.",
          viewSettingsTitle: "Kết nối",
          viewSettingsSubtitle: "Thiết lập backend mà extension nhận lệnh.",
          libraryToolsTitle: "Thư viện và thao tác Flow",
          librarySelectProject: "Chọn dự án", librarySelectAsset: "Chọn tài sản", librarySelectCharacter: "Chọn nhân vật",
          libraryProject: "Dự án", libraryProjectsPlaceholder: "Tải danh sách dự án", libraryRefreshProjects: "Làm mới dự án", libraryOpenProject: "Mở dự án", libraryCreateProject: "Tạo dự án mới",
          libraryAsset: "Tài sản", libraryAssetsPlaceholder: "Tải danh sách tài sản", libraryRefreshAssets: "Làm mới tài sản", libraryDownloadAsset: "Tải xuống", libraryNewName: "Tên mới", libraryAssetName: "Tên tài sản mới", libraryRenameAsset: "Đổi tên", libraryTrashAsset: "Chuyển vào thùng rác",
          libraryCharacter: "Nhân vật", libraryCharactersPlaceholder: "Tải danh sách nhân vật", libraryRefreshCharacters: "Làm mới nhân vật", libraryNewCharacterName: "Tên nhân vật mới", libraryCharacterChange: "Mô tả thay đổi cho nhân vật", libraryEditCharacter: "Đưa chỉnh sửa vào hàng đợi",
          libraryReferences: "Gắn tham chiếu (mỗi dòng một tên, ví dụ asset:Tên ảnh)", libraryReferencesPlaceholder: "asset:Tên ảnh\ncharacter:Tên nhân vật", libraryAttachReferences: "Gắn tham chiếu", libraryClearReferences: "Xóa tham chiếu", referenceKindImage: "Ảnh", referenceKindVideo: "Video", referenceKindCharacter: "Nhân vật", referenceKindVoice: "Giọng nói", removeReferenceKind: "Gỡ loại đã chọn",
          photosTitle: "Ảnh và video Flow", photosSummary: "Duyệt media trong project hiện tại.", photosRefresh: "Quét lại", photosSearch: "Tìm theo tên…", photosAll: "Tất cả", photosImages: "Ảnh", photosVideos: "Video", photosEmpty: "Chưa quét media.", photosMore: "Xem thêm", photosCount: "{shown} / {total} media", photosNoResults: "Không tìm thấy media phù hợp.", photosUseReference: "Dùng làm tham chiếu", photosDownload: "Tải xuống", photosPreview: "Xem trước", photosVideoUnavailable: "Flow không cung cấp URL phát trực tiếp cho video này. Bạn vẫn có thể tải media từ thẻ bên dưới.",
          libraryUpload: "Tải media lên Flow", libraryUploadFile: "Tải tệp lên", libraryVoices: "Xem tùy chọn giọng nói", libraryNoVoice: "Không dùng giọng nói",
          typeImage: "Tạo Ảnh",
          typeVideo: "Tạo Video",
          typeCharacter: "Tạo Nhân Vật",
          promptLabel: "Câu lệnh Prompt",
          multiPromptToggle: "Chia prompt theo đoạn trống và xếp hàng tuần tự",
          multiPromptQueued: "Đã thêm {count} prompt vào batch Flow",
          multiPromptRefs: "Gán tham chiếu",
          multiPromptRefCount: "Số tham chiếu mỗi prompt",
          multiPromptRefsNone: "Không dùng tham chiếu",
          multiPromptRefsAll: "Dùng chung cho mỗi prompt",
          multiPromptRefsSequential: "Chia lần lượt, một tham chiếu mỗi prompt",
          multiPromptRefsMention: "Chỉ gắn ảnh được gọi bằng @tên",
          multiPromptRefsMissing: "Chế độ chia lần lượt cần ít nhất một tham chiếu cho mỗi prompt.",
          multiPromptMentionAmbiguous: "Tên @{name} khớp với nhiều ảnh tham chiếu. Hãy đổi tên để phân biệt rồi thử lại.",
          multiPromptMentionUnresolved: "Không tìm thấy tham chiếu cho: {names}. Các prompt vẫn được xếp hàng, không gắn các ảnh này.",
          multiPromptLimit: "Mỗi batch Flow tối đa 100 prompt.",
          multiPromptCount: "{count} prompt",
          multiPromptImport: "Nhập .txt/.csv",
          multiPromptHint: "Mỗi đoạn cách nhau bằng một dòng trống sẽ thành một tác vụ.",
          imageConfirmTitle: "Xác nhận tạo ảnh",
          imageConfirmDescription: "Kiểm tra thiết lập trước khi thêm vào hàng đợi Flow.",
          imageConfirmPrompts: "Số prompt",
          imageConfirmSinglePrompt: "1 prompt",
          imageConfirmBatchPrompts: "{count} prompt · chạy lần lượt",
          imageConfirmModel: "Mô hình",
          imageConfirmQuantity: "Tổng số ảnh",
          imageConfirmQuantityDetail: "{total} ảnh · {count} mỗi prompt",
          imageConfirmReferences: "Ảnh tham chiếu",
          imageConfirmCharacter: "Nhân vật",
          imageConfirmNone: "Không chọn",
          imageConfirmCancel: "Hủy",
          imageConfirmRun: "Xác nhận và thêm hàng đợi",
          multiPromptEmptyFile: "Tệp không có prompt nào để nhập.",
          multiPromptImportFailed: "Không thể đọc tệp prompt.",
          videoFrameStartLabel: "Khung đầu · tên ảnh trong Flow",
          videoFrameEndLabel: "Khung cuối · tên ảnh trong Flow (không bắt buộc)",
          videoFrameNamesPlaceholder: "Một tên dùng chung hoặc một tên mỗi prompt",
          videoFrameNamesHint: "Trong chế độ Frames, chọn khung đầu cho mỗi prompt; khung cuối không bắt buộc. Không kết hợp với Ingredients.",
          videoChainToggle: "Nối video trước bằng khung hình cuối",
          videoChainHint: "Mỗi clip sau dùng khung cuối của clip trước. Cần ít nhất 2 prompt. Chuỗi không dùng kèm ảnh Ingredients, nhân vật hoặc giọng nói; trong Frames, chỉ cần chọn khung đầu cho prompt đầu tiên.",
          videoChainNeedsPrompts: "Chuỗi video cần ít nhất 2 prompt.",
          videoChainNeedsSingleVariant: "Chuỗi video chỉ hỗ trợ số lượng x1 cho mỗi prompt.",
          videoChainReferencesConflict: "Chuỗi video chỉ dùng prompt văn bản hoặc Frames; hãy gỡ ảnh tham chiếu, nhân vật và giọng nói trước khi tạo.",
          videoChainNeedsStart: "Chọn khung đầu cho prompt đầu tiên của chuỗi video.",
          videoFramesNeedMode: "Hãy chọn chế độ Frames để dùng tên khung hình.",
          videoFramesNeedStart: "Mỗi prompt trong chế độ Frames cần có tên khung đầu.",
          videoFramesLineMismatch: "Tên khung hình cần có một mục dùng chung hoặc một mục cho mỗi prompt.",
          videoFramesReferenceConflict: "Chế độ Frames không thể dùng kèm ảnh tham chiếu Ingredients hoặc nhân vật.",
          videoFramesNeedInput: "Hãy chọn ít nhất một ảnh nguồn cho Frames.",
          videoFramesHint: "Chọn ảnh từ thư viện Flow hoặc tải ảnh lên; bấm Start/End để chọn. Start bắt buộc, End tùy chọn. Tối đa 2 ảnh.",
          framePickerSlotHint: "Thư viện Flow hoặc máy tính",
          frameImage: "Ảnh Frames",
          frameStart: "Khung bắt đầu",
          frameEnd: "Khung cuối",
          frameClearSlot: "Xóa ảnh khung này",
          frameUploading: "Đang tải ảnh Frames {n}/{total}: {name}",
          frameSlotPickerTitle: "Chọn ảnh cho khung video",
          framePairPickerTitle: "Chọn tối đa 2 ảnh khung video",
          referencePickerTitle: "Chọn / Tải ảnh lên",
          frameSlotPickerLimit: "Chọn 1 ảnh; nhấn ảnh trong thư viện để gán ngay vào ô này.",
          framePairPickerLimit: "Ảnh đầu là Start; ảnh thứ hai là End, không bắt buộc.",
          referencePickerLimit: "Tối đa 3 ảnh tham chiếu",
          frameSlotPickerUploadHint: "Ảnh từ máy được gán ngay và tải lên Flow khi tạo video.",
          referencePickerUploadHint: "Ảnh sẽ được tải lên Flow khi bạn bấm Tạo ảnh hoặc Tạo video.",
          framePickerFlowTab: "Thư viện Flow",
          referencePickerFlowTab: "Ảnh trên Flow",
          framePickerLocalTab: "Máy tính",
          referencePickerLocalTab: "Upload",
          frameSlotPickerConfirm: "Chọn ảnh",
          framePairPickerConfirm: "Dùng ảnh đã chọn",
          framePairPickerNeedImage: "Hãy chọn ít nhất một ảnh cho Frames.",
          referencePickerConfirm: "Xác nhận",
          frameSlotPickerNeedImage: "Hãy chọn một ảnh cho khung video.",
          referencePickerTooMany: "Flow chỉ nhận tối đa 3 ảnh tham chiếu. Hãy bỏ bớt ảnh rồi thử lại.",
          videoReferencePickerTitle: "Chọn ảnh hoặc video tham chiếu",
          videoReferencePickerUploadHint: "Ảnh từ máy có thể dùng làm tham chiếu; video phải được chọn từ Thư viện Flow.",
          videoReferencePickerFlowTab: "Ảnh & video trên Flow",
          framePickerLocalDescription: "Chọn ảnh từ máy hoặc kéo thả ảnh vào đây",
          referencePickerLocalDescription: "Chỉ nhận ảnh từ máy; video từ máy chưa được hỗ trợ.",
          referencePickerVideoUploadUnsupported: "Không hỗ trợ tải video từ máy. Hãy chọn video có sẵn trong Thư viện Flow.",
          uploadLibraryChecking: "Đang kiểm tra thư viện Flow cho {name}...",
          uploadLibraryUsingExisting: "Dùng media có sẵn trong thư viện Flow: {name}",
          uploadLibraryMissing: "Thư viện Flow chưa có media tên {name}; đang tải lên...",
          uploadLibraryProjectUnknown: "Không xác định được project Flow hiện tại nên chưa thể kiểm tra media trùng. Hãy mở project Flow rồi thử lại.",
          uploadLibraryInvalid: "Flow trả về danh sách thư viện không hợp lệ; chưa tải media nào lên.",
          uploadLibraryScanFailed: "Không thể xác minh thư viện Flow; chưa tải media lên. Hãy mở mục All media rồi thử lại.",
          uploadLibraryProjectChanged: "Project Flow đã đổi trong lúc quét thư viện; hãy thử lại.",
          uploadLibraryAmbiguous: "Thư viện Flow có nhiều media tên \"{name}\" nên chưa thể chọn chính xác. Hãy chọn trực tiếp từ thư viện Flow.",
          uploadLibraryBusy: "Media \"{name}\" đã có trong thư viện Flow nhưng chưa sẵn sàng. Chờ Flow xử lý xong rồi thử lại.",
          promptPlaceholder: "Nhập mô tả hình ảnh hoặc video bạn muốn tạo...",
          promptPlaceholderVideo: "Mô tả chuyển động video, góc máy...",
          projectGateTitle: "Chọn project Flow",
          projectGateHint: "Đang ở trang chủ. Chọn project trước khi tạo ảnh hoặc video.",
          projectGatePlaceholder: "Chọn project…",
          projectGateOpen: "Mở project",
          projectGateLoading: "Đang tải danh sách project…",
          projectGateOpening: "Đang mở project…",
          projectGateReady: "Đã chọn project: {name}",
          projectGateEmpty: "Chưa có project. Hãy tạo project trong Flow rồi làm mới.",
          charNameLabel: "Tên nhân vật",
          charNamePlaceholder: "Ví dụ: Cô gái áo dài, Chàng trai đeo kính...",
          charDescLabel: "Mô tả ngoại hình nhân vật",
          charDescPlaceholder: "Khuôn mặt, trang phục, phong cách...",
          aspectRatio: "Tỷ lệ khung hình",
          quantity: "Số lượng",
          videoMode: "Chế độ Video",
          videoDuration: "Thời lượng",
          videoDurationFixed: "Thời lượng (cố định {seconds} giây)",
          imageModel: "Mô hình ảnh",
          videoModel: "Mô hình video",
          videoResolution: "Độ phân giải",
          characterSelect: "Nhân vật tham chiếu",
          characterNone: "Không chọn (Mặc định)",
          btnGenerateImage: "Thêm ảnh vào hàng đợi",
          btnGenerateVideo: "Thêm video vào hàng đợi",
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
          ,workflowType: "Loại quy trình", workflowAgent: "Agent batch (mỗi dòng một cảnh)", workflowEdit: "Chỉnh sửa video", workflowContinue: "Tiếp tục video",
          workflowScenes: "Cảnh / prompt", workflowScenesPlaceholder: "Mỗi dòng là một cảnh hoặc prompt", workflowAspect: "Tỷ lệ", workflowExtra: "Prompt bổ sung", workflowOptional: "Tùy chọn", historyActivity: "Hoạt động DOM Flow",
          workflowAsset: "Tên video nguồn", workflowAssetPlaceholder: "Tên đầy đủ hoặc tiền tố video trong Flow",
          workflowRun: "Thêm quy trình vào hàng đợi", workflowQueued: "Đã thêm vào hàng đợi Flow và bắt đầu chạy tuần tự. Nếu hàng đợi đang tạm dừng, bấm Chạy tiếp trong tab Tác vụ.", workflowNeedScenes: "Hãy nhập ít nhất một cảnh.", workflowNeedAsset: "Hãy nhập tên video nguồn.",
          promptSave: "Lưu prompt hiện tại", promptName: "Tên prompt", promptNamePlaceholder: "Ví dụ: Product hero", promptSaved: "Đã lưu prompt cục bộ.", promptLocalNote: "Lưu cục bộ trên thiết bị này.", promptEmpty: "Chưa có prompt nào được lưu.", promptUse: "Dùng prompt", promptDelete: "Xóa", promptSaveError: "Không thể lưu prompt.",
          historyEmpty: "Chưa có lịch sử cục bộ.", historyRefresh: "Làm mới", historyClear: "Xóa lịch sử", historyUsePrompt: "Dùng lại prompt"
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
          "frames": ["khung hình", "khung ảnh", "khung", "frames"],
          "grid_view": ["lưới", "dạng lưới", "chế độ lưới", "grid", "grid view"],
          "grid_size": ["kích thước lưới", "kích thước ô", "grid size", "tile size"],
          "small": ["nhỏ", "cỡ nhỏ", "small"],
          "show_tile_details": ["hiển thị chi tiết ô", "hiển thị thông tin chi tiết", "show tile details", "show details"]
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
          checking: "Checking…",
          wsConnected: "Backend connected",
          wsDisconnected: "Disconnected from server",
          flowTabs: "Google Flow tabs:",
          selectedTab: "Controlled tab:",
          tabNone: "Not selected",
          tabsCount: "{count} open tab{s}",
          tabsNone: "No Flow tab open",
          noFlowTabHint: "No Flow tab is open yet. Open Flow to start generating images and videos.",
          btnOpenFlow: "Open Google Flow",
          reconnecting: "Reconnecting to the active Flow tab...",
          previewTriggered: "Displaying activity border on Flow tab...",
        },
        character: {
          none: "Character",
        },
        voice: {
          random: "Random voice",
        },
        header: {
          lightMode: "Light Mode",
          darkMode: "Dark Mode",
        },
        sidebar: {
          title: "Flow MCP Studio",
          subtitle: "Google Flow Browser Automation",
          tabGen: "Create",
          tabWorkflow: "Workflows",
          tabPrompts: "Prompts",
          tabLibrary: "Library",
          tabTasks: "Tasks",
          tabHistory: "History",
          tabStatus: "Status",
          tabLogs: "MCP Logs",
          tabSettings: "Settings",
          viewCreateTitle: "Create content",
          viewCreateSubtitle: "Create images, videos, or characters in the connected Flow tab.",
          viewWorkflowTitle: "Flow workflows",
          viewWorkflowSubtitle: "Run Agent batches, edits, or video continuations through Flow DOM.",
          viewPromptsTitle: "Saved prompts",
          viewPromptsSubtitle: "Save prompts locally and reuse them in the creator.",
          viewLibraryTitle: "Flow library",
          viewLibrarySubtitle: "Projects, media, characters, and references.",
          viewTasksTitle: "Tasks",
          viewTasksSubtitle: "Monitor and control the extension queue.",
          viewHistoryTitle: "Local history",
          viewHistorySubtitle: "Commands run by the extension; no FlowAPI sync is used.",
          viewStatusTitle: "Flow status",
          viewStatusSubtitle: "The Flow tab currently controlled by the extension.",
          viewLogsTitle: "MCP logs",
          viewLogsSubtitle: "Recent commands and results from the extension.",
          viewSettingsTitle: "Connection",
          viewSettingsSubtitle: "Configure the backend that sends commands to this extension.",
          libraryToolsTitle: "Flow library and actions",
          librarySelectProject: "Select a project", librarySelectAsset: "Select an asset", librarySelectCharacter: "Select a character",
          libraryProject: "Project", libraryProjectsPlaceholder: "Load project list", libraryRefreshProjects: "Refresh projects", libraryOpenProject: "Open project", libraryCreateProject: "Create project",
          libraryAsset: "Asset", libraryAssetsPlaceholder: "Load asset list", libraryRefreshAssets: "Refresh assets", libraryDownloadAsset: "Download", libraryNewName: "New name", libraryAssetName: "New asset name", libraryRenameAsset: "Rename", libraryTrashAsset: "Move to trash",
          libraryCharacter: "Character", libraryCharactersPlaceholder: "Load character list", libraryRefreshCharacters: "Refresh characters", libraryNewCharacterName: "New character name", libraryCharacterChange: "Describe the character changes", libraryEditCharacter: "Add edit to queue",
          libraryReferences: "Attach references (one name per line, e.g. asset:Image name)", libraryReferencesPlaceholder: "asset:Image name\ncharacter:Character name", libraryAttachReferences: "Attach references", libraryClearReferences: "Clear references", referenceKindImage: "Image", referenceKindVideo: "Video", referenceKindCharacter: "Character", referenceKindVoice: "Voice", removeReferenceKind: "Remove selected kind",
          photosTitle: "Flow Images and Videos", photosSummary: "Browse media in the current project.", photosRefresh: "Scan again", photosSearch: "Search by name…", photosAll: "All", photosImages: "Images", photosVideos: "Videos", photosEmpty: "No media scanned yet.", photosMore: "Show more", photosCount: "{shown} / {total} media", photosNoResults: "No matching media found.", photosUseReference: "Use as reference", photosDownload: "Download", photosPreview: "Preview", photosVideoUnavailable: "Flow did not provide a direct playback URL for this video. You can still download it from its card below.",
          libraryUpload: "Upload media to Flow", libraryUploadFile: "Upload file", libraryVoices: "View voice options", libraryNoVoice: "No voice",
          typeImage: "Image",
          typeVideo: "Video",
          typeCharacter: "Character",
          promptLabel: "Prompt",
          multiPromptToggle: "Split blank-line paragraphs into prompts and queue them in order",
          multiPromptQueued: "Added {count} prompts to the Flow batch",
          multiPromptRefs: "Assign references",
          multiPromptRefCount: "References per prompt",
          multiPromptRefsNone: "Do not use references",
          multiPromptRefsAll: "Use the same references for every prompt",
          multiPromptRefsSequential: "Assign one reference per prompt in order",
          multiPromptRefsMention: "Attach references named with @ in each prompt",
          multiPromptRefsMissing: "Sequential assignment needs at least one reference for each prompt.",
          multiPromptMentionAmbiguous: "@{name} matches multiple selected references. Rename them so each can be distinguished, then retry.",
          multiPromptMentionUnresolved: "No selected reference matches: {names}. The prompts will still be queued without those images.",
          multiPromptLimit: "Each Flow batch can contain at most 100 prompts.",
          multiPromptCount: "{count} prompts",
          multiPromptImport: "Import .txt/.csv",
          multiPromptHint: "Each paragraph separated by a blank line becomes a separate task.",
          imageConfirmTitle: "Confirm image generation",
          imageConfirmDescription: "Review the settings before adding this work to the Flow queue.",
          imageConfirmPrompts: "Prompts",
          imageConfirmSinglePrompt: "1 prompt",
          imageConfirmBatchPrompts: "{count} prompts · run in order",
          imageConfirmModel: "Model",
          imageConfirmQuantity: "Total images",
          imageConfirmQuantityDetail: "{total} images · {count} per prompt",
          imageConfirmReferences: "Reference images",
          imageConfirmCharacter: "Character",
          imageConfirmNone: "None selected",
          imageConfirmCancel: "Cancel",
          imageConfirmRun: "Confirm and add to queue",
          multiPromptEmptyFile: "The file contains no prompts to import.",
          multiPromptImportFailed: "Could not read the prompt file.",
          videoFrameStartLabel: "First frame · Flow image name",
          videoFrameEndLabel: "Last frame · Flow image name (optional)",
          videoFrameNamesPlaceholder: "One shared name or one name per prompt",
          videoFrameNamesHint: "In Frames mode, choose a start frame for each prompt; a last frame is optional. Do not combine with Ingredients.",
          videoChainToggle: "Continue each video from the previous video's last frame",
          videoChainHint: "Each clip starts from the previous clip's last frame. Requires at least 2 prompts. Chaining cannot use ingredient references, characters, or voice; in Frames mode, choose a start frame only for the first prompt.",
          videoChainNeedsPrompts: "Video chaining needs at least 2 prompts.",
          videoChainNeedsSingleVariant: "Video chaining only supports one variant per prompt (x1).",
          videoChainReferencesConflict: "Video chaining supports text prompts or Frames only; remove ingredient references, characters, and voice before generating.",
          videoChainNeedsStart: "Choose a start frame for the first prompt in the video chain.",
          videoFramesNeedMode: "Select Frames mode to use frame names.",
          videoFramesNeedStart: "Every prompt in Frames mode needs a first-frame name.",
          videoFramesLineMismatch: "Frame names need one shared entry or one entry for every prompt.",
          videoFramesReferenceConflict: "Frames mode cannot be combined with Ingredients or character references.",
          videoFramesNeedInput: "Choose at least one image source for Frames.",
          videoFramesHint: "Choose from the Flow library or upload an image; click Start/End to choose. Start is required, End is optional. Up to 2 images.",
          framePickerSlotHint: "Flow library or this device",
          frameImage: "Frame image",
          frameStart: "Start frame",
          frameEnd: "Last frame",
          frameClearSlot: "Remove this frame image",
          frameUploading: "Uploading Frames image {n}/{total}: {name}",
          frameSlotPickerTitle: "Choose an image for this video frame",
          framePairPickerTitle: "Choose up to two video frame images",
          referencePickerTitle: "Choose / Upload images",
          frameSlotPickerLimit: "Choose one image; click a library image to assign it to this slot.",
          framePairPickerLimit: "The first image is Start; the second image is End and is optional.",
          referencePickerLimit: "Up to 3 ingredient references",
          frameSlotPickerUploadHint: "Images from this device are assigned now and upload to Flow when you generate.",
          referencePickerUploadHint: "Images upload to Flow when you submit image or video generation.",
          framePickerFlowTab: "Flow library",
          referencePickerFlowTab: "Flow images",
          framePickerLocalTab: "This device",
          referencePickerLocalTab: "Upload",
          frameSlotPickerConfirm: "Choose image",
          framePairPickerConfirm: "Use selected images",
          framePairPickerNeedImage: "Choose at least one image for Frames.",
          referencePickerConfirm: "Confirm",
          frameSlotPickerNeedImage: "Choose one image for the video frame.",
          referencePickerTooMany: "Flow supports up to 3 ingredient references. Remove an image and try again.",
          videoReferencePickerTitle: "Choose reference image or video",
          videoReferencePickerUploadHint: "Local images can be used as references; videos must be picked from the Flow library.",
          videoReferencePickerFlowTab: "Images & videos on Flow",
          framePickerLocalDescription: "Choose images from your computer or drop them here",
          referencePickerLocalDescription: "Local images only; local videos are not supported yet.",
          referencePickerVideoUploadUnsupported: "Uploading videos from your computer is not supported. Please choose a video from the Flow library.",
          uploadLibraryChecking: "Checking the Flow library for {name}...",
          uploadLibraryUsingExisting: "Using media already in the Flow library: {name}",
          uploadLibraryMissing: "The Flow library has no media named {name}; uploading...",
          uploadLibraryProjectUnknown: "The current Flow project could not be identified, so duplicate media cannot be checked. Open a Flow project and try again.",
          uploadLibraryInvalid: "Flow returned an invalid library list; no media was uploaded.",
          uploadLibraryScanFailed: "Could not verify the Flow library, so no media was uploaded. Open All media and try again.",
          uploadLibraryProjectChanged: "The Flow project changed while its library was being scanned. Try again.",
          uploadLibraryAmbiguous: "The Flow library has multiple media items named \"{name}\", so one cannot be selected safely. Choose it directly from the Flow library.",
          uploadLibraryBusy: "The media item \"{name}\" is already in the Flow library but is not ready. Wait for Flow to finish processing it, then try again.",
          promptPlaceholder: "Describe the image or video you want to generate...",
          promptPlaceholderVideo: "Describe video motion, camera angles, actions...",
          projectGateTitle: "Choose a Flow project",
          projectGateHint: "You are on the Flow home page. Choose a project before generating.",
          projectGatePlaceholder: "Choose a project…",
          projectGateOpen: "Open project",
          projectGateLoading: "Loading projects…",
          projectGateOpening: "Opening project…",
          projectGateReady: "Selected project: {name}",
          projectGateEmpty: "No projects found. Create one in Flow, then refresh.",
          charNameLabel: "Character Name",
          charNamePlaceholder: "e.g. Cyberpunk Girl, Detective John...",
          charDescLabel: "Character Appearance Description",
          charDescPlaceholder: "Face details, clothes, hair, style...",
          aspectRatio: "Aspect Ratio",
          quantity: "Quantity",
          videoMode: "Video Mode",
          videoDuration: "Duration",
          videoDurationFixed: "Duration (fixed at {seconds} seconds)",
          imageModel: "Image model",
          videoModel: "Video model",
          videoResolution: "Resolution",
          characterSelect: "Reference Character",
          characterNone: "None (Default)",
          btnGenerateImage: "Add Image to Queue",
          btnGenerateVideo: "Add Video to Queue",
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
          settingsSaved: "Settings saved successfully!",
          workflowType: "Workflow type", workflowAgent: "Agent batch (one scene per line)", workflowEdit: "Edit video", workflowContinue: "Continue video",
          workflowScenes: "Scenes / prompts", workflowScenesPlaceholder: "One scene or prompt per line", workflowAspect: "Aspect ratio", workflowExtra: "Additional prompt", workflowOptional: "Optional", historyActivity: "Flow DOM activity",
          workflowAsset: "Source video name", workflowAssetPlaceholder: "Full name or video prefix in Flow",
          workflowRun: "Add workflow to queue", workflowQueued: "Added to the Flow queue and started sequentially. If the queue is paused, choose Resume in the Tasks tab.", workflowNeedScenes: "Enter at least one scene.", workflowNeedAsset: "Enter a source video name.",
          promptSave: "Save current prompt", promptName: "Prompt name", promptNamePlaceholder: "Example: Product hero", promptSaved: "Prompt saved locally.", promptLocalNote: "Saved locally on this device.", promptEmpty: "No saved prompts yet.", promptUse: "Use prompt", promptDelete: "Delete", promptSaveError: "Could not save prompt.",
          historyEmpty: "No local history yet.", historyRefresh: "Refresh", historyClear: "Clear history", historyUsePrompt: "Reuse prompt"
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
          "frames": ["frames", "khung hình", "khung"],
          "grid_view": ["grid", "grid view", "lưới", "dạng lưới", "chế độ lưới"],
          "grid_size": ["grid size", "tile size", "kích thước lưới", "kích thước ô"],
          "small": ["small", "nhỏ", "cỡ nhỏ"],
          "show_tile_details": ["show tile details", "show details", "hiển thị chi tiết ô", "hiển thị thông tin chi tiết"]
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
