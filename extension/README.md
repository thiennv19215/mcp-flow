# Hướng dẫn Kiến trúc & Phát triển Extension (Flow Native Automation)

Tài liệu này hướng dẫn chi tiết về cấu trúc mã nguồn, nhiệm vụ của từng mô-đun và quy trình mở rộng/bảo trì cho Chrome Extension (`extension/`).

---

## 1. Sơ đồ Cấu trúc Thư mục

Mã nguồn được phân tách theo mô hình **Modular Provider Pattern**:

```text
extension/
├── manifest.json                    # Khai báo quyền, DNR rules, content scripts nạp tuần tự
├── background/
│   └── service-worker.js            # Kết nối WebSocket với backend MCP, quản lý tab và auto-inject
├── rules/
│   └── flow-media-headers.json      # DeclarativeNetRequest rules gỡ bỏ CORP headers để tải media
├── ui/
│   ├── popup.html / popup.js        # Giao diện popup kết nối trạng thái
│   └── options.html / options.js    # Cài đặt cấu hình URL backend MCP
└── content/
    ├── dom-actions.js               # Entry point router (~40 dòng), ủy quyền cho ProviderRegistry
    ├── shared/                      # CÁC TIỆN ÍCH DÙNG CHUNG (SHARED UTILS)
    │   ├── dom-utils.js             # Helper DOM nền tảng (visible, accessibleName, wait, error taxonomy...)
    │   ├── activity-overlay.js      # Overlay visual lock thông báo khi automation đang chạy
    │   └── native-file-transfer.js  # UploadAssembler xử lý chunk upload nhị phân từ backend
    ├── bridge/                      # CẦU NỐI MAIN WORLD (TRUY CẬP DOM GỐC CỦA TRANG)
    │   ├── flow-upload-main.js      # Hook file picker & drag-and-drop trong MAIN world
    │   ├── flow-correlation-observer.js # Intercept batchexecute RPC trong MAIN world (bắt media ID thời gian thực)
    │   └── slate-bridge.js          # Synthetic click listeners trong MAIN world để trigger Angular/Slate
    └── providers/                   # CÁC BỘ ĐIỀU KHIỂN NỀN TẢNG AI (PROVIDER DRIVERS)
        ├── BaseProviderDriver.js    # Base class & Interface chuẩn cho mọi AI Provider
        ├── ProviderRegistry.js      # Router URL: nhận diện domain (Flow, Gemini, ChatGPT...) và cấp Driver
        └── flow/                    # CÁC MÔ-ĐUN NGHIỆP VỤ RIÊNG BIỆT CỦA GOOGLE FLOW
            ├── FlowDriver.js        # Driver chính kết nối và điều phối các sub-module
            ├── FlowEditor.js        # ProseMirror editor, user text extraction, bảo tồn chip, submit & enter fallback
            ├── FlowSettings.js      # Bảng Cài đặt: Mode (Image/Video), Model, Ratio, Duration, Resolution, Quantity
            ├── FlowComponents.js    # Quản lý References, Ingredients, Frames, dọn chip cũ, upload staged media
            ├── FlowCharacters.js    # Quản lý Tạo & Chỉnh sửa nhân vật (Character Actions)
            ├── FlowNavigation.js    # Điều hướng, tự phục hồi sub-route (/character, /edit), thoát viewer, đóng overlay
            ├── FlowTiles.js         # Quét grid media, polling render progress, bắt lỗi (Quota alert, error taxonomy)
            ├── FlowMediaMenu.js     # Download media gốc/upscaled, đổi tên asset, chuyển vào thùng rác
            └── FlowAgent.js         # Flow Agent session & workflows
```

---

## 2. Chi tiết Nghiệp vụ Từng File trong `extension/content/`

### A. Tầng Điều hướng & Entry Point
- **`dom-actions.js`**:
  - Là entry point duy nhất lắng nghe `chrome.runtime.onMessage`.
  - Tiếp nhận lệnh `flowOperation` từ background service worker.
  - Gọi `ProviderRegistry.resolveForUrl(location.href)` để lấy Driver phù hợp cho trang hiện tại rồi ủy quyền chạy `driver.invoke(operation, payload, command)`.
  - **Không chứa logic DOM phức tạp**, giữ cho entry point luôn gọn gàng và không bao giờ bị lỗi chéo.

### B. Tầng Nền tảng Đa Nền tảng (`providers/`)
- **`BaseProviderDriver.js`**:
  - Định nghĩa interface chuẩn cho tất cả các Driver (`key`, `origin`, `context`, `operations`, `supports`, `invoke`, `targetMismatch`, `error`).
  - Mọi AI Provider mới (Gemini, ChatGPT) đều kế thừa từ class này.
- **`ProviderRegistry.js`**:
  - Quản lý danh sách origin của các nhà cung cấp AI:
    - Google Flow: `https://flow.google.com`
    - Google Gemini: `https://gemini.google.com` (sẵn sàng mở rộng)
    - OpenAI ChatGPT: `https://chatgpt.com` (sẵn sàng mở rộng)
  - Phân tích URL (`describeUrl`, `parseFlowPath`) để nhận biết trang hiện tại thuộc provider nào và cấp phát driver tương ứng.

### C. Tầng Nghiệp vụ Chuyên biệt cho Google Flow (`providers/flow/`)

| File | Nghiệp vụ chính | Các hàm / tính năng quan trọng |
| :--- | :--- | :--- |
| **`FlowDriver.js`** | **Điều phối trung tâm** | Kế thừa `BaseProviderDriver`. Xử lý `flow.context`, kiểm tra context mismatch, kết nối các sub-module để thực hiện chuỗi hành động submit, observe, download, edit, agent. |
| **`FlowEditor.js`** | **Soạn thảo & Submit** | • `getEditorUserText()`: Đọc text thuần của prompt, loại trừ 100% các inline chips.<br>• `clearEditorTextPreservingChips()`: Dọn sạch prompt cũ nhưng bảo toàn các chip reference/nhân vật.<br>• `insertNativeFlowPrompt()`: Chèn prompt an toàn và xác minh.<br>• `activateFlowSubmitButton()`: Bấm submit qua Slate bridge.<br>• `pressFlowEditorSubmit()`: Enter fallback khi click không kích hoạt listener.<br>• `waitForGenerationCreditQuote()`: Đọc credit quote trước khi bấm submit. |
| **`FlowSettings.js`** | **Cài đặt tham số sinh** | • `openFlowSettings()` / `closeFlowSettings()`: Mở/đóng panel cài đặt an toàn (bằng Escape hoặc click composer).<br>• `chooseRadio()`, `chooseAspectRatio()`, `chooseDuration()`, `chooseResolution()`, `chooseNativeVariantCount()`: Chọn chính xác tham số.<br>• `chooseNativeModel()`: Chọn model thông minh qua aliases (Nano Banana, Veo 2, Imagen 3, Quality/Fast).<br>• `FlowImageActions.prepare()` & `FlowVideoActions.prepare()`: Chuẩn bị toàn bộ settings cho ảnh/video. |
| **`FlowComponents.js`** | **Thành phần đính kèm** | • `clearExistingIngredientChips()`: Dọn sạch các chip đính kèm cũ trước khi gắn chip mới.<br>• `FlowReferenceActions.attach()`: Đính kèm reference (`character:<name>`, `asset:<name>`) kèm xác nhận thẻ chip hiển thị.<br>• `chooseNativePickerAsset()`: Chọn asset/frame từ picker popup.<br>• `uploadStagedFlowMedia()`: Tải file media nhị phân lên Flow. |
| **`FlowCharacters.js`** | **Nhân vật Flow** | • `FlowCharacterActions.create()`: Tạo nhân vật mới, chọn giọng nói, tỉ lệ, tạo chân dung.<br>• `FlowCharacterActions.edit()`: Chỉnh sửa thông tin nhân vật có sẵn. |
| **`FlowNavigation.js`** | **Điều hướng & Phục hồi** | • `ensureFlowProjectEditor()`: Tự động phát hiện khi kẹt ở sub-routes (`/character`, `/edit`,...) và kéo người dùng về màn hình project editor gốc hoặc reload URL sạch.<br>• `exitFlowMediaViewer()`: Thoát media viewer 3 tầng (Nút Back -> `history.back()` -> Điều hướng URL gốc).<br>• `dismissBlockingOverlays()`: Đóng tự động các modal, dialog, backdrop che chắn màn hình. |
| **`FlowTiles.js`** | **Theo dõi Grid & Lỗi** | • `collectNativeMedia()`: Quét toàn bộ tiles media trong grid.<br>• `findFlowTile()`: Tìm tile theo tiêu đề có cuộn ảo (virtualized scroll).<br>• `waitForProgressResult()`: Polling tiến độ render, xử lý retry khi gặp lỗi tạm thời.<br>• `classifyFlowError()`: Phân loại lỗi (`FLOW_QUOTA_EXCEEDED`, `FLOW_UNUSUAL_ACTIVITY`, `FLOW_POLICY_VIOLATION`, `FLOW_RATE_LIMIT`).<br>• `checkFlowCreditLimitAlert()`: Phát hiện ngay lập tức banner hết credit/quota.<br>• `armNativeFlowCorrelation()`: Kích hoạt RPC correlation tracker. |
| **`FlowMediaMenu.js`** | **Menu thao tác Media** | • `triggerFlowDownload()`: Tải media chất lượng gốc hoặc upscaled.<br>• `scanNativeAssets()`: Quét toàn bộ thư viện assets của dự án.<br>• `scanNativeProjects()`: Quét danh sách dự án ở trang chủ.<br>• `flow.asset.rename`: Đổi tên asset trong menu 3 chấm.<br>• `flow.asset.trash`: Xóa asset vào thùng rác. |
| **`FlowAgent.js`** | **Agent Workflows** | • Chuyển đổi Agent mode, cấu hình chính sách Agent, trả lời câu hỏi tương tác tự động của Flow Agent (I2V/R2V). |

---

## 3. Các Cơ Chế Ổn Định Trọng Yếu

1. **Vòng đời Submit 3 Tín hiệu (Triple Confirmation Signals)**:
   - Khi kích hoạt nút Submit, extension không chỉ dựa vào sự kiện click mà chờ ít nhất 1 trong 3 tín hiệu để khẳng định Flow đã nhận lệnh:
     1. Nút Submit chuyển sang trạng thái disabled (`aria-disabled="true"` hoặc `disabled`).
     2. Editor text được Flow tự động dọn sạch (nhưng vẫn giữ nguyên chips nhân vật).
     3. Tile media mới xuất hiện trên Grid hiển thị trạng thái loading/busy.
   - Nếu sau 1.2s chưa có tín hiệu nào và listener chưa kích hoạt, extension sẽ tự động kích hoạt **Enter fallback** trên editor.

2. **Cơ chế Phục hồi Sub-route (`ensureFlowProjectEditor`)**:
   - Nếu URL là `flow.google.com/project/:id/character` hoặc `/project/:id/edit/:video_id`, extension nhận diện `isProjectEditor: false`.
   - Trước khi thực hiện lệnh upload hoặc submit, `ensureFlowProjectEditor` sẽ tự động bấm nút quay lại hoặc điều hướng về URL gốc `/project/:id` để tránh lỗi màn hình sai.

3. **Thoát Media Viewer 3 Tầng (`exitFlowMediaViewer`)**:
   - Tầng 1: Tìm và click nút Back có icon `arrow_back`.
   - Tầng 2: Gọi `history.back()`.
   - Tầng 3: Tải lại URL project editor sạch nếu 2 tầng trên bị kẹt.

4. **Bảo tồn Chip Nhân vật khi Soạn thảo Prompt**:
   - Khi thay đổi prompt, `clearEditorTextPreservingChips()` duyệt qua cây DOM của ProseMirror và chỉ xóa các TextNode tự do, giữ nguyên toàn bộ các thẻ `<span contenteditable="false">` (chip nhân vật).

5. **Hỗ trợ Đa Ngôn ngữ Song ngữ (Tiếng Anh & Tiếng Việt)**:
   - Toàn bộ các selector, regex, button matching, category navigation, option aliases, frame picker, dialog confirmation và trích xuất hạn mức credit đều được tích hợp song ngữ Anh - Việt:
     - **Buttons**: Nhận diện `"Cài đặt"`, `"Bắt đầu tạo"`, `"Xóa câu lệnh"`, `"Thêm thành phần"`, `"Thêm nguyên liệu"`, `"Quay lại"`, `"Xong"`, `"Tùy chọn khác"`, `"Tải xuống"`,... kết hợp fallback tự động qua Material Icon (`tune`, `settings`, `arrow_forward`, `add`, `more_vert`).
     - **Credit Quote**: Regex nhận diện song ngữ `sẽ dùng X tín dụng`, `sẽ sử dụng X tín dụng`, `tiêu tốn X tín dụng`, `will use X credits`.
     - **Options & Modes**: Hỗ trợ `"Hình ảnh"`, `"Video"`, `"Thành phần"`, `"Khung hình"`, tỉ lệ dọc/ngang/vuông (`"9:16"`, `"dọc"`, `"16:9"`, `"ngang"`, `"1:1"`, `"vuông"`), thời lượng (`"5s"`, `"5 giây"`).
     - **Navigation & Library**: Nhận diện tab thư viện `"Tất cả nội dung nghe nhìn"`, `"Tất cả phương tiện"`, `"Nhân vật"`.

---

## 4. Hướng dẫn Mở Rộng Thêm Nền Tảng Mới (Gemini / ChatGPT)

Để tích hợp thêm nền tảng AI mới mà không ảnh hưởng đến Flow:

1. **Bước 1: Đăng ký Domain trong `ProviderRegistry.js`**:
   ```javascript
   ProviderRegistry.ORIGINS = Object.freeze({
     flow: "https://flow.google.com",
     gemini: "https://gemini.google.com",
     chatgpt: "https://chatgpt.com",
   });
   ```

2. **Bước 2: Tạo thư mục Provider mới**:
   - Tạo thư mục: `extension/content/providers/gemini/`
   - Tạo file: `GeminiDriver.js`, `GeminiEditor.js`,... kế thừa từ `BaseProviderDriver`:
   ```javascript
   class GeminiDriver extends globalThis.BaseProviderDriver {
     constructor(context = {}) {
       super({
         ...context,
         key: "gemini",
         origin: globalThis.ProviderRegistry.ORIGINS.gemini,
         operations: ["gemini.generate", "gemini.chat"],
       });
     }
     async invoke(operation, payload, command) {
       // Xử lý các thao tác DOM trên giao diện Gemini
     }
   }
   globalThis.ProviderRegistry.register("gemini", ctx => new GeminiDriver(ctx));
   ```

3. **Bước 3: Khai báo trong `extension/manifest.json`**:
   - Thêm URL pattern vào `host_permissions` và `content_scripts.matches` (`https://gemini.google.com/*`).
   - Thêm các file của `providers/gemini/` vào danh sách `js`.

---

## 5. Hướng dẫn Nạp & Cập nhật Extension trên Google Chrome

1. Mở trình duyệt Chrome và truy cập: `chrome://extensions/`
2. Bật công tắc **Developer mode** (Chế độ dành cho nhà phát triển) ở góc trên bên phải.
3. Nhấp vào nút **Load unpacked** (Tải tiện ích đã giải nén).
4. Chọn thư mục `extension` trong repository này:
   ```text
   c:\Users\nguye\Documents\flow-mcp-extension-native\extension
   ```
5. Khi có bất kỳ thay đổi code nào trong thư mục `extension/`:
   - Chỉ cần nhấn nút **Reload** (biểu tượng mũi tên xoay tròn) của extension trên trang `chrome://extensions/`.
   - Sau đó F5 lại trang Google Flow tab đang mở để nhận mã nguồn mới nhất.

---

## 6. Kiểm thử Đơn vị (Unit Tests)

Mọi thay đổi trong extension đều có thể kiểm thử tự động offline bằng runner Bun / Node VM:

```bash
bun test tests/native-references.test.mjs
```

Đảm bảo 18/18 tests luôn pass trước khi commit và push mã nguồn.
