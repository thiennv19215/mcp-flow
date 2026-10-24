# Hướng dẫn Kiến trúc & Phát triển Extension (Flow Native Automation)

> 💡 **Dành cho lập trình viên cần sửa nhanh tính năng:**  
> Xem ngay [**Bản Đồ Tra Cứu Nhiệm Vụ & File Cần Sửa (DEVELOPER-GUIDE.md)**](DEVELOPER-GUIDE.md) để định vị đúng file cần sửa trong 30 giây mà không cần đọc toàn bộ dự án.

Tài liệu này hướng dẫn cấu trúc mã nguồn extension, nhiệm vụ mô-đun và quy trình phát triển. `extension/` là cây nguồn; gói Chrome đã build nằm tại `dist/extension/`.

---

## 1. Sơ đồ Cấu trúc Thư mục

Mã nguồn dùng kiến trúc **Modular Monolith**: một Chrome extension duy nhất khi đóng gói/cài đặt, bên trong chia module theo nghiệp vụ và provider để dễ bảo trì, cập nhật độc lập:

```text
extension/
├── manifest.json                  # Manifest nguồn; đường dẫn khớp gói sau khi build
├── icons/                         # Icon nguồn
├── rules/                         # DNR rules
├── flow-model-capabilities.json   # Cấu hình model được đồng bộ khi build
└── src/                           # Toàn bộ source extension
    ├── background/                # Service worker, queue, bridge và workflow planning
    ├── ui/                        # Popup, side panel, queue và options
    └── content/
        ├── dom-actions.js         # Entry point nhận command và gọi ProviderRegistry
        ├── floating-tracker-flow.js
        ├── bridge/                # MAIN-world hooks và observers
        ├── shared/                # DOM helpers, i18n, overlay, binary transfer
        └── providers/
            ├── base/              # Driver interface và registry đa provider
            └── flow/              # Modular monolith, chia theo nghiệp vụ
                ├── core/          # Driver, selectors, navigation, settings primitives
                ├── composer/      # Editor, prompt, reference và voice
                ├── generation/    # Submit/observe, image/video settings, frames, tiles
                ├── media/         # Upload và thao tác media
                ├── library/       # Project, asset listing và thao tác thư viện
                ├── characters/    # Character actions
                ├── agent/         # Flow Agent
                ├── workflows/     # Multi-step orchestration
                └── compatibility/ # Facade giữ API cũ trong thời gian chuyển đổi

dist/extension/                    # Gói cài được; build chép src/* vào package root
```

### Cập nhật selector khi Google Flow đổi DOM

Selector chỉ có một nguồn thật: `extension/src/content/providers/flow/core/selectors.js`
(kênh đồng bộ `flow-selectors.json` từ backend đã bị gỡ ngày 2026-10-24 vì trùng
nguồn thật; xem `ARCHITECTURE.md`).

Khi Flow đổi DOM, sửa key tương ứng trong `core/selectors.js`, rồi build lại
extension và reload. Nếu Flow đổi trình tự thao tác hoặc điều kiện xác minh, sửa
module nghiệp vụ tương ứng; không nhét nghiệp vụ vào selector. Sau thay đổi code,
tăng `package.json` và `extension/manifest.json` theo quy ước phát hành của repo
(xem "Quy ước version" trong `README.md`).

---

## 2. Hàng đợi Flow trong extension

Side panel lưu các tác vụ Flow trong `chrome.storage.local` và chạy lần lượt qua content driver. Tác vụ tạo ảnh/video được submit rồi theo dõi kết quả ngay trong extension; edit, continue, Agent batch và tạo/chỉnh sửa nhân vật cũng được gửi qua driver từ queue. Queue hỗ trợ pause/resume, stop sau tác vụ đang chạy, xóa/sắp xếp tác vụ và khoảng nghỉ ngẫu nhiên 5–10 giây giữa các lượt.

Trước khi phân loại một overlay còn mở là blocker không xác định, preflight chờ DOM settle tối đa 2 giây và vẫn bị giới hạn bởi deadline của thao tác. Dialog không rõ không bị tự đóng. Chỉ lỗi `FLOW_UNKNOWN_OVERLAY_BLOCKING` có kết quả xác nhận chưa dispatch mới được queue chạy lại chính tác vụ đó một lần ngay lập tức, không chờ khoảng nghỉ giữa tác vụ. Nếu blocker vẫn còn, queue pause, giữ các tác vụ sau ở trạng thái chờ; sau khi xử lý trang Flow, Resume sẽ chạy lại tác vụ bị chặn trước. Kết quả submit mơ hồ không bao giờ được replay tự động.

Nếu service worker khởi động lại giữa một tác vụ đang chạy, queue đánh dấu kết quả là chưa xác định và không cho retry tác vụ đó. Các tác vụ đang chờ cần được người dùng chạy tiếp từ side panel. Queue của MCP local là luồng riêng dành cho yêu cầu từ AI.

Capability local khai báo số lượng video x1–x4 cho Omni 1.1 Flash. Sidebar chỉ hiện lựa chọn số lượng khi model có trường `quantities` tường minh, nhớ lựa chọn riêng theo model và chuyển count đã chọn vào DOM queue. Validator chỉ enforce allowlist quantity được khai báo rõ cho video; model không có allowlist không bị xem mặc định là chỉ hỗ trợ x1. Các model versioned được so theo family, version và tier chính xác: Veo Lite/Fast/Quality không khớp với Veo 3.1 chung và chưa kế thừa capability Veo chung cho tới khi xác nhận settings tương ứng trong Flow DOM.

Khi bật nối chuỗi video, sidebar khóa số lượng ở x1; giá trị số lượng hợp lệ trước đó vẫn được nhớ theo model và khôi phục khi tắt nối chuỗi. Guard từ chối count khác x1 trước khi upload hoặc đưa tác vụ vào queue. Control chọn voice hiện nằm ngay trong form tạo video thay vì bên trong nhóm công cụ thư viện đang thu gọn. Các tổ hợp model/voice/character/Frames vẫn cần xác minh runtime trên Flow DOM.

`flow.components.select` chuẩn hóa reference không phải voice trong `dom-operations.js` thành `{ assetName, kind }`, ánh xạ `name` của object sang `assetName` nếu cần. `slot` và `expectedId` tiếp tục được truyền tới reference action; xác minh identity và chip hiện hữu vẫn quyết định thao tác có được xác nhận hay không.

---

## 3. Chi tiết Nghiệp vụ Từng File trong `extension/src/content/`

### A. Tầng Điều hướng & Entry Point
- **`dom-actions.js`**:
  - Là entry point duy nhất lắng nghe `chrome.runtime.onMessage`.
  - Tiếp nhận lệnh `flowOperation` từ background service worker.
  - Gọi `ProviderRegistry.resolveForUrl(location.href)` để lấy Driver phù hợp cho trang hiện tại rồi ủy quyền chạy `driver.invoke(operation, payload, command)`.
  - **Không chứa logic DOM phức tạp**, giữ cho entry point luôn gọn gàng và không bao giờ bị lỗi chéo.

### B. Tầng Nền tảng Đa Nền tảng (`providers/`)
- **`extension/src/content/providers/base/base-provider-driver.js`**:
  - Định nghĩa interface chuẩn cho tất cả các Driver (`key`, `origin`, `context`, `operations`, `supports`, `invoke`, `targetMismatch`, `error`).
  - Mọi AI Provider mới (Gemini, ChatGPT) đều kế thừa từ class này.
- **`extension/src/content/providers/base/provider-registry.js`**:
  - Quản lý danh sách origin của các nhà cung cấp AI:
    - Google Flow: `https://flow.google.com`
    - Google Gemini: `https://gemini.google.com` (sẵn sàng mở rộng)
    - OpenAI ChatGPT: `https://chatgpt.com` (sẵn sàng mở rộng)
  - Phân tích URL (`describeUrl`, `parseFlowPath`) để nhận biết trang hiện tại thuộc provider nào và cấp phát driver tương ứng.

### C. Tầng Nghiệp vụ Chuyên biệt cho Google Flow (`providers/flow/`)

| File | Nghiệp vụ chính | Các hàm / tính năng quan trọng |
| :--- | :--- | :--- |
| **`extension/src/content/providers/flow/core/flow-driver.js`** | **Router của Flow** | Kế thừa `BaseProviderDriver`, xác thực project/target rồi chuyển từng operation tới một nhóm nghiệp vụ. Không giữ toàn bộ chuỗi xử lý trong một dispatcher dài. |
| **`extension/src/content/providers/flow/generation/generation-operations.js`** | **Submit & quan sát tạo ảnh/video** | Chuẩn bị reference/prompt/settings, xác minh tín hiệu submit và tương quan request; `flow.generation.observe` theo dõi kết quả. Không sở hữu riêng settings ảnh/video. |
| **`extension/src/content/providers/flow/composer/prompt-operations.js`** | **Prompt** | Xóa đúng nội dung prompt theo expected text, xác minh project/editor, và đảm bảo chip tham chiếu được giữ nguyên. |
| **`extension/src/content/providers/flow/composer/reference-operations.js`** | **API nghiệp vụ tham chiếu** | Nhận lệnh attach/clear reference và trả danh sách voice cho client. Attach xử lý từng reference qua `FlowReferenceActions`; xác minh trạng thái/chip/media identity, không coi click là thành công. |
| **`extension/src/content/providers/flow/media/upload-operations.js`** | **Upload protocol** | Preflight Flow, nhận các chunk ảnh/video, ráp file và chuyển file đã staging cho uploader DOM. |
| **`extension/src/content/providers/flow/library/library-operations.js`** | **Project & thư viện** | Đọc trạng thái, liệt kê project/assets/characters, tải media, đổi tên và chuyển asset vào thùng rác. |
| **`extension/src/content/providers/flow/workflows/workflow-operations.js`** | **Workflow nhiều bước** | Tạo/sửa character, chỉnh sửa video, Agent batch và tiếp tục video. |
| **`extension/src/content/providers/flow/composer/flow-editor.js`** | **Soạn thảo & Submit** | • `getEditorUserText()`: Đọc text thuần của prompt, loại trừ 100% các inline chips.<br>• `clearEditorTextPreservingChips()`: Dọn sạch prompt cũ nhưng bảo toàn các chip reference/nhân vật.<br>• `insertNativeFlowPrompt()`: Chèn prompt an toàn và xác minh.<br>• `activateFlowSubmitButton()`: Bấm submit qua Slate bridge.<br>• `waitForGenerationCreditQuote()`: Đọc credit quote trước khi bấm submit. |
| **`extension/src/content/providers/flow/core/settings.js`** | **DOM settings dùng chung** | Cung cấp thao tác panel/dropdown/options và xác minh model đang chọn qua DOM; model/version không khớp hoặc không xác nhận được sẽ dừng trước submit. |
| **`extension/src/content/providers/flow/generation/image-settings.js`** | **Settings sinh ảnh** | `FlowImageActions.prepare()` cấu hình Image mode, model, ratio và số lượng; `prepareCharacterPortrait()` dùng cho chân dung character. |
| **`extension/src/content/providers/flow/generation/video-settings.js`** | **Settings sinh video** | `FlowVideoActions.prepare()` cấu hình model video, ratio, duration, resolution, quantity và Ingredients/Frames mode; kiểm tra `disabled`/`aria-disabled` và dừng trước submit nếu chế độ được yêu cầu bị khóa. |
| **`extension/src/content/providers/flow/compatibility/flow-components.js`** | **Facade tương thích** | Giữ tên API cũ và chuyển tiếp sang uploader, frame picker, voice/reference actions. Quy tắc mới thuộc module nghiệp vụ, không thêm vào facade. |
| **`extension/src/content/providers/flow/media/uploader.js`** | **Upload ảnh/video qua DOM** | Điều khiển file input/dropzone, xác nhận upload video khi cần, đối chiếu tile và media ID. Byte upload từ MCP được nhận/ráp riêng ở `native-file-transfer.js` và `extension/src/content/providers/flow/media/upload-operations.js`. |
| **`extension/src/content/providers/flow/composer/reference-actions.js`** | **Reference ảnh/nhân vật** | Quét picker phân trang/virtualized, gắn reference, xác nhận chip và media identity. |
| **`extension/src/content/providers/flow/composer/voice-actions.js`** | **Voice** | Chọn voice chính xác, thay chip voice hiện tại, và quét đầy đủ danh sách voice trong picker ảo hóa. |
| **`extension/src/content/providers/flow/generation/native-frame-picker.js`** | **Ảnh frame video** | Chọn đúng asset vào frame Start/End và xác nhận media ID + trạng thái picker sau thao tác. |
| **`extension/src/content/providers/flow/characters/flow-characters.js`** | **Nhân vật Flow** | • `FlowCharacterActions.create()`: Tạo nhân vật mới, chọn giọng nói, tỉ lệ, tạo chân dung.<br>• `FlowCharacterActions.edit()`: Chỉnh sửa thông tin nhân vật có sẵn. |
| **`extension/src/content/providers/flow/core/navigation.js`** | **Điều hướng & Phục hồi** | • `ensureFlowProjectEditor()`: Tự động phát hiện khi kẹt ở sub-routes (`/character`, `/edit`,...) và kéo người dùng về màn hình project editor gốc hoặc reload URL sạch.<br>• `exitFlowMediaViewer()`: Thoát media viewer 3 tầng (Nút Back -> `history.back()` -> Điều hướng URL gốc).<br>• `dismissBlockingOverlays()`: Đóng picker/menu đã nhận diện, dialog Agent hướng dẫn qua đúng nút Done duy nhất và dialog thông tin có một nút đóng an toàn; xác nhận dialog đã biến mất trước khi chạy thao tác đang chờ. Guard nội dung rủi ro chỉ áp dụng cho dialog chung, không chặn Done của dialog Agent đã xác thực. Với unknown non-dialog surface, chỉ thử đóng khi nội dung không risky và có đúng một candidate visible/enabled mang tên Close/Dismiss chính xác hoặc icon close được nhận diện; các control khác trên surface vẫn có thể tồn tại. Sau click phải xác nhận owner biến mất. Surface không rõ, risky hoặc có nhiều candidate vẫn chặn thao tác và làm queue pause. Tấm nền CDK thuộc riêng panel Settings được nhận diện cùng owner nên không gây lỗi “dialog lạ”. Dialog không rõ, xác nhận/xóa/thanh toán hoặc không có nút an toàn sẽ dừng trước submit và queue báo cần xử lý thủ công. |
| **`extension/src/content/providers/flow/generation/tiles.js`** | **Theo dõi Grid & Lỗi** | • `collectNativeMedia()`: Quét toàn bộ tiles media trong grid.<br>• `findFlowTile()`: Tìm tile theo tiêu đề có cuộn ảo (virtualized scroll).<br>• `waitForProgressResult()`: Polling tiến độ render, xử lý retry khi gặp lỗi tạm thời.<br>• `classifyFlowError()`: Phân loại lỗi (`FLOW_QUOTA_EXCEEDED`, `FLOW_UNUSUAL_ACTIVITY`, `FLOW_POLICY_VIOLATION`, `FLOW_RATE_LIMIT`).<br>• `checkFlowCreditLimitAlert()`: Phát hiện ngay lập tức banner hết credit/quota.<br>• `armNativeFlowCorrelation()`: Kích hoạt RPC correlation tracker. |
| **`extension/src/content/providers/flow/media/media-menu.js`** | **Menu thao tác Media** | • `triggerFlowDownload()`: Tải media chất lượng gốc hoặc upscaled.<br>• `scanNativeAssets()`: Quét toàn bộ thư viện assets của dự án.<br>• `scanNativeProjects()`: Quét danh sách dự án ở trang chủ.<br>• `flow.asset.rename`: Đổi tên asset trong menu 3 chấm.<br>• `flow.asset.trash`: Xóa asset vào thùng rác. |
| **`extension/src/content/providers/flow/agent/flow-agent.js`** | **Agent Workflows** | • Chuyển đổi Agent mode, cấu hình chính sách Agent, trả lời câu hỏi tương tác tự động của Flow Agent (I2V/R2V). |

---

## 4. Các Cơ Chế Ổn Định Trọng Yếu

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

## 5. Hướng dẫn Mở Rộng Thêm Nền Tảng Mới (Gemini / ChatGPT)

Để tích hợp thêm nền tảng AI mới mà không ảnh hưởng đến Flow:

1. **Bước 1: Đăng ký Domain trong `extension/src/content/providers/base/provider-registry.js`**:
   ```javascript
   ProviderRegistry.ORIGINS = Object.freeze({
     flow: "https://flow.google.com",
     gemini: "https://gemini.google.com",
     chatgpt: "https://chatgpt.com",
   });
   ```

2. **Bước 2: Tạo thư mục Provider mới**:
   - Tạo thư mục: `extension/src/content/providers/gemini/`
   - Tạo file `driver.js`, `editor.js`... theo tên thường kebab-case; class bên trong có thể giữ PascalCase và kế thừa từ `BaseProviderDriver`:
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

## 6. Build, nạp và cập nhật Extension trên Google Chrome

`extension/` chứa source và manifest nguồn. `npm run build` tạo gói Chrome đã kiểm tra đường dẫn tại `dist/extension/`; hãy dùng thư mục này với **Load unpacked**.

1. Mở trình duyệt Chrome và truy cập: `chrome://extensions/`
2. Bật công tắc **Developer mode** (Chế độ dành cho nhà phát triển) ở góc trên bên phải.
3. Nhấp vào nút **Load unpacked** (Tải tiện ích đã giải nén).
4. Chọn thư mục `dist/extension` trong repository này:
   ```text
   c:\Users\nguye\Documents\flow-mcp-extension-native\dist\extension
   ```
5. Khi chỉ build thủ công, chạy `npm run build` trước khi nhấn Reload. Trong lúc phát triển:
   - Chỉ cần nhấn nút **Reload** (biểu tượng mũi tên xoay tròn) của extension trên trang `chrome://extensions/`.
   - Sau đó F5 lại trang Google Flow tab đang mở để nhận mã nguồn mới nhất.

   Để tự build và reload: load unpacked `dist/extension/` một lần, rồi chạy `npm run dev:extension` ở thư mục gốc repo. Watcher theo dõi toàn bộ `extension/` (source, manifest, icon, rules và capabilities), build lại gói rồi yêu cầu Chrome reload khi an toàn.

---

## 7. Kiểm thử và build

Repo dùng Node test runner; các lệnh dưới đây chạy test và build đã khai báo trong `package.json`:

```bash
npm test
npm run build
```

Test DOM/mock kiểm tra logic offline, không thay thế xác minh trực tiếp trên Flow. Khi chỉ cập nhật tài liệu, không cần chạy test hay build.
