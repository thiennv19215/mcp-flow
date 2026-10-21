# Kiến Trúc DOM & Quản Lý Selectors (DOM Architecture & Guidelines)

> **MỤC ĐÍCH TÀI LIỆU**: Tài liệu này quy định chuẩn kiến trúc truy vấn DOM trên trang Google Flow (`https://flow.google.com/*`) cho dự án `flow-mcp-extension-native`. Bất kỳ ai sửa đổi hoặc phát triển tính năng mới **BẮT BUỘC TUÂN THỦ** các nguyên tắc dưới đây để tránh làm phân mảnh mã nguồn, gãy test hoặc gây lỗi khi Google Flow cập nhật giao diện.

---

## 1. Triết Lý Thiết Kế (Theo Mô Hình TobyFlow)

Trước đây, selectors bị hardcode rải rác trong hàng chục file provider (`FlowComponents.js`, `FlowCharacters.js`, `FlowSettings.js`...). Khi Google Flow đổi một tên class hay thuộc tính `aria-label`, việc bảo trì trở thành một thảm họa vì phải tìm và sửa hàng trăm vị trí.

Hệ thống hiện tại đã được tái cấu trúc thành **3 tầng độc lập**:

```
[Tầng 1: Registry Cấu Hình]
         flow-selectors.json (Local config & Hot-reload)
                   ↕ (Sync qua src/selectors.ts & WebSocket / storage)
[Tầng 2: Query Engine]
         FlowSelectors.js (Content Script Layer)
         ├── flowGetConfig(path)
         ├── flowQuery(path, scope)
         ├── flowQueryAll(path, scope, options)
         ├── flowQueryVisible(path, scope)
         └── flowFindSemantic(path, scope, options)
                   ↓
[Tầng 3: Page Drivers / Providers]
         FlowComponents, FlowCharacters, FlowSettings, FlowTiles, FlowMediaMenu, FlowNavigation...
```

---

## 2. Quy Tắc Vàng (The Golden Rules)

> [!CAUTION]
> **1. TUYỆT ĐỐI KHÔNG hardcode selector tĩnh mới trực tiếp trong file logic**:
> Không viết `document.querySelector(".new-google-class")` hoặc `document.querySelectorAll('button[aria-label="New Feature"]')` trong các file provider.
> Mọi selector mới **phải được khai báo vào `flow-selectors.json` và `FlowSelectors.js` trước**.

> [!IMPORTANT]
> **2. LUÔN viết theo mô hình 2 tầng (Query Engine + Safe Fallback)**:
> Vì hệ thống test suite (`tests/*.test.mjs`) chạy trên môi trường Node/Bun với DOM giả lập (JSDOM/mock DOM), bạn luôn phải giữ mẫu fallback:
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

## 4. Hướng Dẫn Sử Dụng Query Engine (`FlowSelectors.js`)

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
2. **Bước 2: Cập nhật `flow-selectors.json`**
   - Mở file [`flow-selectors.json`](./flow-selectors.json).
   - Thêm selector mới lên **đầu mảng** `selectors` (ưu tiên Tier 1) của key tương ứng. Giữ selector cũ phía sau làm fallback.
   ```json
   "submitButton": {
     "selectors": [
       "button[data-new-action='generate']",  // <-- Thêm mới vào đây
       "button[type='submit']",
       "button[data-action='submit']"
     ]
   }
   ```
3. **Bước 3: Chạy lại Test Suite & Build**
   ```bash
   bun test
   bun run build
   ```
   > Không cần đụng vào code trong `FlowComponents.js` hay các Provider khác!

---

## 6. Checklist Kiểm Tra Trước Khi Commit Code
- [ ] Không có `document.querySelector` trần trụi cho các thành phần nghiệp vụ chính.
- [ ] Toàn bộ selector mới đã có trong `flow-selectors.json`.
- [ ] Chạy `bun test` đạt 100% (223/223 pass).
- [ ] Chạy `bun run build` không có lỗi TypeScript hay build script.
