# Hướng Dẫn Phát Triển & Bản Đồ Mã Nguồn Extension (Developer Guide)

> **Mục tiêu của tài liệu này:** Giúp bất kỳ ai khi tiếp nhận dự án có thể **nhanh chóng định vị đúng file cần sửa trong vòng 30 giây** mà **không cần phải đọc toàn bộ dự án**.

---

## 1. Bản Đồ Tra Cứu Nhanh: "Cần Sửa Gì $\rightarrow$ Mở File Nào"

Dưới đây là bảng ma trận tính năng thực tế. Khi gặp lỗi hoặc cần nâng cấp một chức năng cụ thể, bạn chỉ cần mở đúng file tương ứng:

| Nhiệm vụ / Tính năng cần sửa | File đảm nhiệm | Mô tả chi tiết & Điểm bắt đầu |
| :--- | :--- | :--- |
| **1. Kết nối Backend & Transport (WebSocket / HTTP Poll)** | [`extension/src/background/flow-bridge-client.js`](file:///c:/Users/nguye/Documents/flow-mcp-extension-native/extension/src/background/flow-bridge-client.js)<br>[`extension/src/background/service-worker.js`](file:///c:/Users/nguye/Documents/flow-mcp-extension-native/extension/src/background/service-worker.js) | • `flow-bridge-client.js`: Quản lý kết nối WebSocket (`ws://127.0.0.1:18899/ws/bridge`), HTTP long-polling fallback, cơ chế tự động reconnect và heartbeat.<br>• `service-worker.js`: Entry point nền của extension, quản lý tab Flow và điều phối lệnh. |
| **2. Tải media về máy & Đặt tên file (`.mp4`, `.png`)** | [`extension/src/background/flow-queue-downloads.js`](file:///c:/Users/nguye/Documents/flow-mcp-extension-native/extension/src/background/flow-queue-downloads.js) | Lắng nghe `chrome.downloads`, khớp ID tải về với task, đổi tên file theo quy chuẩn (`safeQueueFilenameStem`), kiểm tra trạng thái tải. |
| **3. Quản lý hàng đợi tác vụ (Job Queue)** | [`extension/src/background/flow-job-queue.js`](file:///c:/Users/nguye/Documents/flow-mcp-extension-native/extension/src/background/flow-job-queue.js) | Lưu trữ queue vào `chrome.storage.local`, quản lý trạng thái (`pending`, `running`, `completed`, `failed`), độ trễ ngẫu nhiên 5-10s giữa các tác vụ. |
| **4. Lập kế hoạch workflow nhiều bước (Batch, Continue, Edit)** | [`extension/src/background/flow-workflows.js`](file:///c:/Users/nguye/Documents/flow-mcp-extension-native/extension/src/background/flow-workflows.js) | Chia nhỏ tác vụ phức tạp (như tiếp nối video, sửa ảnh/video, tạo nhiều cảnh liên tiếp) thành các jobs nhỏ chạy tuần tự. |
| **5. Khi Google Flow đổi giao diện (Đổi nút, đổi class, đổi DOM)** | [`flow-selectors.json`](file:///c:/Users/nguye/Documents/flow-mcp-extension-native/flow-selectors.json)<br>[`extension/src/content/providers/flow/core/selectors.js`](file:///c:/Users/nguye/Documents/flow-mcp-extension-native/extension/src/content/providers/flow/core/selectors.js) | **Chỉ sửa selector tại đây!** File này tập trung toàn bộ CSS Selector / XPath. Backend sẽ tự đồng bộ xuống extension mà không cần hardcode lại logic. |
| **6. Soạn thảo Prompt & Nút Tạo (Submit Button)** | [`extension/src/content/providers/flow/composer/flow-editor.js`](file:///c:/Users/nguye/Documents/flow-mcp-extension-native/extension/src/content/providers/flow/composer/flow-editor.js) | Điền văn bản prompt vào Slate editor, đọc credit quote, kích hoạt nút Tạo/Submit, xóa text nhưng giữ nguyên các chip tham chiếu. |
| **7. Gắn / Xóa ảnh tham chiếu & nhân vật (Reference / Ingredients)** | [`extension/src/content/providers/flow/composer/reference-actions.js`](file:///c:/Users/nguye/Documents/flow-mcp-extension-native/extension/src/content/providers/flow/composer/reference-actions.js)<br>[`extension/src/content/providers/flow/composer/reference-operations.js`](file:///c:/Users/nguye/Documents/flow-mcp-extension-native/extension/src/content/providers/flow/composer/reference-operations.js) | Thao tác mở menu "Thêm thành phần", chọn ảnh tham chiếu style/nhân vật, kiểm tra chip đã gắn thành công chưa. |
| **8. Cấu hình thông số sinh ảnh (Image Mode, Tỷ lệ, Số lượng)** | [`extension/src/content/providers/flow/generation/image-settings.js`](file:///c:/Users/nguye/Documents/flow-mcp-extension-native/extension/src/content/providers/flow/generation/image-settings.js) | Chọn chế độ Tạo ảnh, tỷ lệ khung hình (16:9, 9:16, 1:1), số lượng ảnh tạo trong 1 lượt. |
| **9. Cấu hình thông số sinh video (Model Veo, Tỷ lệ, Thời lượng)** | [`extension/src/content/providers/flow/generation/video-settings.js`](file:///c:/Users/nguye/Documents/flow-mcp-extension-native/extension/src/content/providers/flow/generation/video-settings.js) | Chọn model video (Veo 2, Veo 3.1, Omni), thời lượng, độ phân giải, kiểm tra chế độ có bị vô hiệu hóa (`disabled`) hay không. |
| **10. Theo dõi tiến độ render & Bắt kết quả (Tiles)** | [`extension/src/content/providers/flow/generation/tiles.js`](file:///c:/Users/nguye/Documents/flow-mcp-extension-native/extension/src/content/providers/flow/generation/tiles.js)<br>[`extension/src/content/bridge/flow-correlation-observer.js`](file:///c:/Users/nguye/Documents/flow-mcp-extension-native/extension/src/content/bridge/flow-correlation-observer.js) | Bắt tile đang render, phát hiện lỗi hết credit/quota, quét thẻ kết quả khi render xong để lấy video ID và URL tải. |
| **11. Upload file từ máy tính lên thư viện Flow** | [`extension/src/content/providers/flow/media/upload-operations.js`](file:///c:/Users/nguye/Documents/flow-mcp-extension-native/extension/src/content/providers/flow/media/upload-operations.js)<br>[`extension/src/content/providers/flow/media/uploader.js`](file:///c:/Users/nguye/Documents/flow-mcp-extension-native/extension/src/content/providers/flow/media/uploader.js) | Nhận dữ liệu nhị phân (chunks) từ backend truyền sang, inject vào input file của trang Flow và chờ xử lý hoàn tất. |
| **12. Chọn giọng đọc (Voice Picker)** | [`extension/src/content/providers/flow/composer/voice-actions.js`](file:///c:/Users/nguye/Documents/flow-mcp-extension-native/extension/src/content/providers/flow/composer/voice-actions.js) | Mở danh sách giọng đọc, cuộn tìm giọng đọc được chỉ định (tiếng Việt, tiếng Anh) và xác nhận chip giọng đọc. |
| **13. Quản lý Nhân vật (Characters)** | [`extension/src/content/providers/flow/characters/flow-characters.js`](file:///c:/Users/nguye/Documents/flow-mcp-extension-native/extension/src/content/providers/flow/characters/flow-characters.js) | Quét danh sách nhân vật có sẵn trong project, tạo nhân vật mới từ ảnh tham chiếu, lưu tên nhân vật an toàn. |
| **14. Điều hướng trang (Navigation & Projects)** | [`extension/src/content/providers/flow/core/navigation.js`](file:///c:/Users/nguye/Documents/flow-mcp-extension-native/extension/src/content/providers/flow/core/navigation.js) | Chuyển đổi qua lại giữa Trang chủ, Dự án, Thư viện "Tất cả nội dung", "Nhân vật", đảm bảo không click nhầm khi dùng tiếng Việt. |
| **15. Giao diện Sidebar người dùng (Side Panel)** | [`extension/src/ui/sidebar.js`](file:///c:/Users/nguye/Documents/flow-mcp-extension-native/extension/src/ui/sidebar.js)<br>[`extension/src/ui/sidebar.html`](file:///c:/Users/nguye/Documents/flow-mcp-extension-native/extension/src/ui/sidebar.html) | Giao diện điều khiển bên phải Chrome: form nhập prompt, danh sách queue, nút pause/resume, trạng thái kết nối. |
| **16. Đa ngôn ngữ (Tiếng Việt / Tiếng Anh)** | [`extension/src/content/shared/i18n.js`](file:///c:/Users/nguye/Documents/flow-mcp-extension-native/extension/src/content/shared/i18n.js) | Từ điển nhãn nút ("Tạo", "Thêm thành phần", "Tất cả dự án"...), giúp nhận diện nút chính xác bất kể tài khoản dùng ngôn ngữ nào. |

---

## 2. Luồng Đi Của Một Yêu Cầu (End-to-End Request Flow)

Khi một lệnh sinh video hoặc thao tác Flow được phát đi:

```
[ Backend MCP Server / Local Studio ]
               │
               ▼ (WebSocket ws://127.0.0.1:18899 hoặc HTTP Poll)
[ Background: service-worker.js ]
   ├── Quản lý kết nối ──► flow-bridge-client.js
   ├── Nếu cần tải file ──► flow-queue-downloads.js
   ├── Quản lý hàng đợi ──► flow-job-queue.js
   └── Gửi lệnh vào tab ──► chrome.tabs.sendMessage()
               │
               ▼
[ Content Script: dom-actions.js ]
   └── Ủy quyền cho Driver ──► flow-driver.js
               │
               ▼
[ Domain Operations ]
   ├── flow-editor.js (Điền prompt, kiểm tra credit)
   ├── image-settings.js / video-settings.js (Chỉnh model, ratio)
   ├── reference-actions.js (Gắn ảnh tham chiếu)
   └── Bấm nút Submit (activateFlowSubmitButton)
               │
               ▼
[ Bridge (MAIN World): flow-correlation-observer.js ]
   ├── Bắt Correlation ID & theo dõi tiến độ render
   └── Khi hoàn thành: Báo kết quả ngược lại cho Driver -> Service Worker -> Backend
```

---

## 3. Kiến Trúc Thư Mục `extension/src/`

```text
extension/src/
├── background/                      # Tầng chạy nền (Service Worker)
│   ├── service-worker.js            # Entry point background: quản lý tab Flow, điều phối lệnh
│   ├── flow-bridge-client.js        # Bóc tách: Quản lý WebSocket, HTTP poll, reconnect với Backend
│   ├── flow-queue-downloads.js      # Bóc tách: Quản lý tải media từ Chrome Downloads
│   ├── flow-job-queue.js            # Quản lý hàng đợi tác vụ cục bộ trong extension
│   ├── flow-workflows.js            # Lập kế hoạch các chuỗi tác vụ phức tạp
│   ├── flow-download-relay.js       # Tiếp sóng dữ liệu file tải về cho backend
│   └── flow-observer-health.js      # Giám sát tình trạng sống của observer
│
├── content/                         # Tầng tương tác DOM trên trang flow.google.com
│   ├── dom-actions.js               # Entry point duy nhất nhận chrome.runtime.onMessage
│   ├── bridge/                      # Chạy trong MAIN World (can thiệp sâu vào context trang)
│   │   ├── flow-correlation-observer.js  # Lắng nghe trạng thái render của Google Flow
│   │   ├── slate-bridge.js          # Can thiệp vào trình soạn thảo Slate/ProseMirror
│   │   └── WatermarkRemover.js      # Tự động xử lý watermark
│   │
│   ├── shared/                      # Tiện ích dùng chung
│   │   ├── dom-utils.js             # Hàm helper DOM (click, wait, find, query)
│   │   ├── i18n.js                  # Hỗ trợ đa ngữ (khớp nút tiếng Việt/Anh)
│   │   └── native-file-transfer.js  # Cơ chế nhận file nhị phân chia nhỏ (chunked)
│   │
│   └── providers/flow/              # Module nghiệp vụ chuyên biệt của Google Flow
│       ├── core/                    # selectors.js, navigation.js, settings.js
│       ├── composer/                # flow-editor.js, reference-actions.js, voice-actions.js
│       ├── generation/              # generation-operations.js, tiles.js, video-settings.js
│       ├── media/                   # upload-operations.js, uploader.js, media-menu.js
│       ├── library/                 # library-operations.js, page-settings.js
│       └── characters/              # flow-characters.js
│
└── ui/                              # Giao diện tiện ích Chrome
    ├── sidebar.js & sidebar.html    # Side panel điều khiển và theo dõi queue
    ├── options.js & options.html    # Trang cài đặt tiện ích
    └── popup.js & popup.html        # Popup icon trên thanh công cụ trình duyệt
```

---

## 4. Ba Quy Tắc Vàng Khi Sửa Code

1. **Không Gọi Thẳng DOM Từ Background Hoặc UI Panel:**
   - Background (`service-worker.js`) và Sidebar (`sidebar.js`) **không bao giờ** được truy cập DOM trực tiếp của trang Flow. Mọi thao tác phải gửi thông qua `driver.invoke(operation, payload)` tới Content Script.
2. **Không Hardcode Selector Trong File Nghiệp Vụ:**
   - Khi cần tìm một phần tử trên trang Flow, luôn truy xuất thông qua `flowSelectors` (trong `flow-selectors.json` hoặc `core/selectors.js`). Điều này giúp khi Google thay đổi UI, bạn chỉ cần sửa selector mà không làm vỡ logic nghiệp vụ.
3. **Tuyệt Đối Không Tự Động Replay Khi Kết Quả Chưa Rõ Ràng:**
   - Nếu nút Submit bấm xong mà mạng bị lag hoặc không rõ Flow đã trừ credit hay chưa, hệ thống **không bao giờ tự ý submit lại**. Cần kiểm tra DOM trước để tránh làm hao hụt credit của người dùng.

---

## 5. Lệnh Phát Triển & Kiểm Thử

Sau khi sửa code trong `extension/`:

```bash
# 1. Chạy toàn bộ 255 bài kiểm thử tự động để đảm bảo không làm gãy tính năng cũ
npm test

# 2. Đóng gói lại extension vào dist/extension/ để cài hoặc nạp vào Chrome
npm run build

# 3. Chạy chế độ phát triển (tự động reload khi sửa file)
npm run dev:extension
```
Sau khi build xong, vào `chrome://extensions`, bấm nút **Tải lại (Reload)** ở tiện ích **Flow MCP Native Automation** để áp dụng thay đổi.

---

## 6. Kiến Trúc Pipeline Sinh Video & Xử Lý Lỗi DOM (Video Pipeline & Error Handling)

### 6.1 Cơ chế chọn Mode & Model Video (`video-settings.js` & `settings.js`)
* **Không ép buộc mode "Ingredients":** Khi người dùng tạo video thuần bằng prompt văn bản (Text-to-Video), hệ thống đánh dấu `{ optional: true }`. Nếu trang Flow không hiển thị radio button "Ingredients", hệ thống tiếp tục gửi lệnh bình thường thay vì chặn lại bằng lỗi `FLOW_VIDEO_MODE_UNAVAILABLE`.
* **Khớp điều khiển Radix UI:** Hệ thống hỗ trợ nhận diện các trigger button Radix UI hiện đại qua ID suffix (ví dụ `button[id*="-trigger-VIDEO_FRAMES"]`, `button[id*="-trigger-VIDEO_REFERENCES"]`, `button[id*="-trigger-PORTRAIT"]`) và Material symbols (`movie_edit`, `interests`, `videocam`).
* **Cho phép thông số tự động/cố định (`allowAbsent: true`):** Đối với các model video như Veo 2 hoặc Omni vốn cố định độ dài (ví dụ 5s/8s) hoặc độ phân giải mà không cung cấp tab tùy chọn, hệ thống tự động bỏ qua kiểm tra bắt buộc thay vì báo lỗi `FLOW_VIDEO_DURATION_UNAVAILABLE` hoặc `FLOW_VIDEO_RESOLUTION_UNAVAILABLE`.

### 6.2 Bắt lỗi Toast Sonner & Phân loại lỗi (`flow-editor.js`, `tiles.js`, `dom-utils.js`)
* **Bắt Sonner Toasts:** Google Flow sử dụng thư viện toast thông báo Sonner. Hệ thống quét qua các selector `[data-sonner-toast]`, `[data-sonner-toaster] [data-toast]`, `[data-title]` để bắt thông báo lỗi tức thì ngay khi nhấn nút Submit.
* **Phân loại mã lỗi API `PUBLIC_ERROR_*`:** `classifyFlowError()` tự động nhận diện regex `\bPUBLIC_ERROR_[A-Z0-9_]+\b` (ví dụ `PUBLIC_ERROR_USER_QUOTA_REACHED`, `PUBLIC_ERROR_UNUSUAL_ACTIVITY`, `PUBLIC_ERROR_SERVICE_UNAVAILABLE`) để phân loại chính xác lỗi hệ thống và dừng lại an toàn mà không retry gây tốn quota.

