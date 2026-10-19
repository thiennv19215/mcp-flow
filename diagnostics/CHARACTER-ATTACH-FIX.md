# Gán nhân vật — 19/10/2026

Đã xác nhận qua MCP rằng nhân vật đã lưu `MCP Test Mug` được gán vào prompt. Phản hồi có `kind: "character"`, `confirmed: true`, `submitted: false`. Quan sát DOM sau lệnh cho thấy đúng một `flow-character-ingredient-chip`; đây là nhân vật đã lưu, không phải reference ảnh thường. 

## Thay đổi

- Dùng `character:<name>` để yêu cầu đúng tab Characters; giữ `asset:<title>` cho media. Studio giữ `kind: character` khi bấm Use trong Cast. Các API nhân vật trả `use_as: character:<name>`.
- Chọn tên chính xác và duy nhất; không chọn kết quả đầu tiên khi trùng tên hoặc chọn tên chỉ khớp tiền tố.
- Xác nhận từ option đã chọn và chip mới có đúng loại. Không đối chiếu URL thumbnail ở `flow-content.google` với URL chip `/asb/` như thể chúng là cùng một định danh.
- Lưu nguồn gốc lựa chọn trong phiên content script. Bản 0.2.6 kiểm tra chip đã xác nhận trước khi mở picker, vì Flow ẩn nhân vật đã gán khỏi danh sách. Không dùng việc trùng ảnh portrait để suy ra hai nhân vật là một.
- Đọc danh sách nhân vật qua picker, tránh điều hướng tới New character. Thêm `flow_attach_references` và API `attach_references` để kiểm tra/gán mà không submit generation.
- Tránh re-prepare/reload theo mọi URL update của SPA. Không đổi URL chỉ để thêm `hl=en` khi tài liệu đã là English.

## Kiểm tra

- Build TypeScript: đạt.
- `node --test tests/native-references.test.mjs`: 6/6 đạt, gồm khác CDN, không nhận chip ảnh là nhân vật, trùng tên/tên gần giống, gọi lặp khi Flow loại nhân vật đã gán khỏi picker, và truyền `character:` qua backend mà không coi là file local.
- MCP smoke trực tiếp trên extension **0.2.6**: gán lần đầu trả `confirmed: true`; gọi lại trả `reused: true` dù Flow ẩn nhân vật khỏi picker; tên không tồn tại bị từ chối.
- Tài khoản có 47 credit trước và sau phép thử; không gửi generation. Flow DOM sau smoke có đúng một nút `Ingredient` chứa ảnh character.
- Smoke test live được lưu thành kết quả tóm tắt tại `character-mcp-smoke.json`.
- Không submit thêm ảnh/video trong lượt sửa gán này. Chưa xác nhận chất lượng một render mới sử dụng nhân vật.

Có thể chạy lại smoke sau khi prompt không còn chip từ phiên thử trước: `node scripts/check-character-attach.mjs`. Bắt đầu từ prompt trống để kiểm tra cả gán đầu tiên và gán lặp trong cùng một content-script session.
