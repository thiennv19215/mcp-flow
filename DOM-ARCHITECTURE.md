# Kiến Trúc DOM & Quản Lý Selectors (DOM Architecture & Guidelines)

> **MỤC ĐÍCH TÀI LIỆU**: Tài liệu này quy định chuẩn kiến trúc truy vấn DOM trên trang Google Flow (`https://flow.google.com/*`) cho dự án `flow-mcp-extension-native`. Bất kỳ ai sửa đổi hoặc phát triển tính năng mới **BẮT BUỘC TUÂN THỦ** các nguyên tắc dưới đây để tránh làm phân mảnh mã nguồn, gãy test hoặc gây lỗi khi Google Flow cập nhật giao diện.

---

## 1. Triết Lý Thiết Kế (Theo Mô Hình TobyFlow)

Trước đây, selectors bị hardcode rải rác trong hàng chục file provider (`extension/src/content/providers/flow/compatibility/flow-components.js`, `extension/src/content/providers/flow/characters/flow-characters.js`, `extension/src/content/providers/flow/core/settings.js`...). Khi Google Flow đổi một tên class hay thuộc tính `aria-label`, việc bảo trì trở thành một thảm họa vì phải tìm và sửa hàng trăm vị trí.

Hệ thống hiện tại tách thành **cấu hình selector, query engine và các module nghiệp vụ**. Các module được chia theo trách nhiệm (prompt, reference, upload, generation, library, workflow); `extension/src/content/providers/flow/compatibility/flow-components.js` chỉ còn là facade tương thích cho API cũ.

```
[Tầng 1: Registry Cấu Hình]
         flow-selectors.json (Local config & Hot-reload)
                   ↕ (Sync qua src/selectors.ts & WebSocket / storage)
[Tầng 2: Query Engine]
         extension/src/content/providers/flow/core/selectors.js (Content Script Layer)
         ├── flowGetConfig(path)
         ├── flowQuery(path, scope)
         ├── flowQueryAll(path, scope, options)
         ├── flowQueryVisible(path, scope)
         └── flowFindSemantic(path, scope, options)
                   ↓
[Tầng 3: Driver và module nghiệp vụ]
         FlowDriver → Prompt / Reference / Upload / Generation / Library / Workflow Operations
         UI primitives: FlowEditor, FlowReferenceActions, FlowUploader,
         FlowImageSettings, FlowVideoSettings, FlowTiles, FlowMediaMenu...
```

---

## 2. Quy Tắc Vàng (The Golden Rules)

> [!CAUTION]
> **1. Ưu tiên selector cấu hình cho điểm nhận diện DOM cần thay đổi theo Flow**:
> Dùng `flowQuery`/`flowQueryAll` với key trong `flow-selectors.json` cho vùng DOM dùng lại hoặc selector có khả năng đổi theo giao diện. Nếu cần key mới, khai báo giá trị mặc định trong `extension/src/content/providers/flow/core/selectors.js` và cấu hình trong `flow-selectors.json`. Với thao tác đặc thù hoặc semantic matching, module nghiệp vụ có thể dùng selector cục bộ có giải thích và xác minh rõ ràng; không đưa quy trình nghiệp vụ vào file selector.

> [!IMPORTANT]
> **2. Fallback phải an toàn và kiểm chứng được**:
> Một fallback chỉ dùng khi query engine không sẵn có hoặc key chưa được cấu hình. Sau khi tìm thấy element, vẫn xác minh đúng ngữ cảnh, trạng thái hiển thị và tính duy nhất trước khi click/chọn. Không click tất cả hoặc chọn phần tử đầu tiên khi kết quả mơ hồ.
> ```javascript
> // ✅ ĐÚNG CHUẨN:
> const button = (typeof root.flowQuery === "function" 
>   ? root.flowQuery("components.actionButton", container) 
>   : null) || container.querySelector('button[aria-label="Action"]');
> ```

> [!TIP]
> **3. Kiểm tra hiển thị thực tế (Visibility Check)**:
> Các phần tử trong Google Flow thường được render ẩn hoặc nằm trong virtual list. Hãy ưu tiên sử dụng `flowQueryVisible` hoặc `checkVisible: true` thay vì query thông thường.

---

## 3. Bản Đồ Phân Nhóm Trong `flow-selectors.json`

File [`flow-selectors.json`](./flow-selectors.json) được tổ chức thành 10 nhóm chính:

| Nhóm (Category) | Mô Tả & Các Thành Phần Quản Lý | Ví Dụ Key |
| :--- | :--- | :--- |
| `editor` | Ô soạn thảo prompt, ProseMirror, Slate container | `editor.selectors` |
| `composerRoot` | Vùng bao quanh khung soạn thảo, thanh công cụ | `composerRoot.selectors` |
| `submitButton` | Nút Tạo/Generate, icon submit, regex loại trừ | `submitButton.selectors`, `textRegex` |
| `tiles` | Vòng đời render video/ảnh: container, progress, spinner, placeholder, error, video, retry | `tiles.container`, `tiles.video`, `tiles.error` |
| `settings` | Menu cài đặt: model dropdown, aspect ratio, duration, resolution | `settings.panel`, `settings.options` |
| `components` | Tham chiếu & Picker: ingredient chips, listbox, options, category tabs, voice chips | `components.chips`, `components.optionItem` |
| `characters` | Quản lý nhân vật: nút tạo, thẻ nhân vật, input tên, input personality | `characters.createTile`, `characters.nameInput` |
| `mediaMenu` | Menu 3 chấm trên media: trigger, panel, item, nút xóa/tải xuống | `mediaMenu.triggerButton`, `mediaMenu.menuPanel` |
| `navigation` | Điều hướng Flow: tạo project, nút back, đóng dialog, sidebar links | `navigation.newProjectButton`, `navigation.backButton` |
| `common` | Các primitive nguyên tử dùng chung: icons, buttons, dialogs, spinners | `common.icons`, `common.buttons` |

---

## 4. Hướng Dẫn Sử Dụng Query Engine (`extension/src/content/providers/flow/core/selectors.js`)

Mọi phương thức của Query Engine đều được đính kèm vào `globalThis` (hoặc `root`):

### 4.1. `flowQuery(path, scope = document)`
Tìm phần tử **đầu tiên** khớp với danh sách selector của `path`.
```javascript
// Tìm editor trong document
const editor = root.flowQuery("editor");

// Tìm nút retry bên trong một tile cụ thể
const retryBtn = root.flowQuery("tiles.retryButton", tileElement);
```

### 4.2. `flowQueryAll(path, scope = document, { checkVisible = false } = {})`
Tìm **tất cả** phần tử khớp với selector. Có thể bật lọc phần tử hiển thị.
```javascript
// Lấy tất cả các option trong picker
const options = root.flowQueryAll("components.optionItem", listbox, { checkVisible: true });
```

### 4.3. `flowQueryVisible(path, scope = document)`
Tìm phần tử **đầu tiên đang thực sự hiển thị** trên giao diện:
- Phần tử phải đang gắn vào cây DOM (`isConnected === true`).
- Kích thước hiển thị phải lớn hơn 0 (`getBoundingClientRect().width > 0 && height > 0`).
```javascript
const activeMenu = root.flowQueryVisible("settings.activeMenu");
```

### 4.4. `flowFindSemantic(path, scope = document, { textMatch, iconMatch, checkVisible = false } = {})`
Tìm phần tử thỏa mãn selector kết hợp kiểm tra nội dung text hoặc icon (rất hữu ích khi Google Flow đổi layout nhưng giữ nguyên tên icon Material Icons).
```javascript
const saveBtn = root.flowFindSemantic("common.buttons", modal, {
  textMatch: /^(?:Lưu|Save)$/i,
  iconMatch: /check|save/i,
  checkVisible: true
});
```

---

## 5. Quy Trình 3 Bước Khi Google Flow Đổi Giao Diện (UI Update Runbook)

Khi Google Flow cập nhật UI khiến extension không tìm thấy nút hoặc tile:

1. **Bước 1: Inspect DOM trên trình duyệt**
   - Mở DevTools trên Flow, kiểm tra thẻ DOM mới (class, role, tag, aria-label).
2. **Bước 2: Cập nhật cấu hình hoặc module sở hữu thao tác**
   - Mở file [`flow-selectors.json`](./flow-selectors.json) và cập nhật selector cho key hiện có nếu cấu hình đủ biểu đạt thay đổi.
   - Nếu cần key mới, khai báo default trong `extension/src/content/providers/flow/core/selectors.js` rồi thêm cấu hình trong `flow-selectors.json`.
   - Nếu đổi luồng thao tác, điều kiện an toàn hoặc xác minh kết quả, cập nhật module nghiệp vụ sở hữu hành động (ví dụ `extension/src/content/providers/flow/composer/reference-actions.js` cho picker reference, `extension/src/content/providers/flow/media/uploader.js` cho upload UI, `extension/src/content/providers/flow/composer/prompt-operations.js` cho clear prompt). Selector JSON không thay thế code khi hành vi thay đổi.
   ```json
   {
     "submitButton": {
       "selectors": [
         "button[data-new-action='generate']",
         "button[type='submit']",
         "button[data-action='submit']"
       ]
     }
   }
   ```
3. **Bước 3: Kiểm tra thay đổi**
   ```bash
   npm test
   npm run build
   ```
   > Nếu chỉ cập nhật selector đã có key, backend có thể phát cấu hình nóng. Nếu thêm key hoặc đổi code extension, cần build/reload extension và tab Flow để nạp mã mới.

---

## 6. Checklist Kiểm Tra Trước Khi Commit Code
- [ ] Selector có khả năng đổi theo DOM được khai báo trong cấu hình; key mới có default trong `extension/src/content/providers/flow/core/selectors.js`.
- [ ] Hành vi được đặt ở module nghiệp vụ đúng miền, không nhồi vào `extension/src/content/providers/flow/compatibility/flow-components.js` facade.
- [ ] Submit, thao tác destructive và chọn reference kiểm tra project, uniqueness và kết quả sau hành động.
- [ ] Chạy `npm test` và `npm run build` khi có thay đổi code; không tuyên bố live Flow đã xác minh nếu chỉ chạy mock/offline.
