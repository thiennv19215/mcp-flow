# Kiểm tra Flow MCP native — 19/10/2026

Đã kiểm tra trên Flow thật qua API Studio tại cổng 18899, extension 0.2.4. Build TypeScript thành công. Clip kiểm thử được giới hạn một lần, tối đa 15 credit, không tự retry. Số dư trước/sau bài test trả phí: **62 → 47**.

## Kết quả

| Luồng | Kết quả thực tế | Bằng chứng / giới hạn |
|---|---|---|
| Build | Đạt | `npm run build`; launcher cũng build lại trước khi restart. |
| Test sẵn có | Hỏng | `tests/flow-settings.test.mjs` import `applySettings` từ `dist/flow.js`, nhưng hàm Playwright này đã bị bỏ khỏi bản native. Test chưa chạy tới assertion nào. |
| Health, status, credits | Đạt | Kết nối WebSocket, extension 0.2.4, đọc được project và số dư. |
| Liệt kê asset | Đạt | Đọc được ảnh và clip mới trong thư viện. |
| Download ảnh original | Đạt khi chạy độc lập | `clip-01.jpeg`. Lần thử ngay sau lỗi Characters thất bại do trang đang ở sai view; không phải mọi download đều hỏng. |
| Ảnh có reference trong project | Đạt toàn bộ | Job `2570cc16`, 0 credit, tạo và tải `scene-04.jpeg`. |
| Video từ prompt | Đạt toàn bộ | Job `998ddc8b`, 15 credit, tạo và tải `scene-05.mp4`. `ffprobe`: H.264 + AAC, 1280×720, 10.005 giây, 3,066,059 byte. |
| Video first frame | Hỏng trước submit | Job `0b01a5b9`: `Flow did not confirm that "Frames" was selected. Nothing was submitted.` Không dùng credit. |
| Đọc danh sách nhân vật | Hỏng | `A listener indicated an asynchronous response ... message channel closed ...`. Khi click Characters bằng browser, Flow chuyển tới trang New character. |
| Tạo nhân vật từ ảnh project | Hỏng | Ban đầu mất message channel; sau khi restart backend và dùng ảnh mug vừa upload: `Flow's new character page is not ready.` |
| Edit nhân vật | Chưa xác nhận end-to-end | Luồng đọc/tạo chưa cung cấp được nhân vật đã xác minh. Không coi việc này là một bài test edit đã chạy thành công hoặc đã tái hiện riêng. |
| Edit video | Kiểm tra được màn hình, chưa render edit | Mở được clip mới vào editor; có textbox `Describe how to edit this video…`, nút Start generation và nút Back đúng như UI. Chưa gửi edit vì đã dùng hết ngân sách 15 credit được cho phép. |
| Upload ảnh local | Đạt sau restart backend | Ban đầu HTTP 404 `Not found`. Sau restart: trả asset `fm-20e6a5b58eb0-upload.png`. Fixture là frame của clip mug kiểm thử, không dùng thêm dữ liệu cá nhân. |
| Ảnh từ prompt, thử độc lập | Flow từ chối render | Job `4af2dab0`: cảnh báo `We noticed some unusual activity ... browser extensions that modify the page may cause issues`. Flow báo không trừ credit. Đây là lỗi từ phía Flow, cần phân biệt với lỗi chọn control/điều hướng. Không retry bài này. |
| Trở về thư viện từ video editor | Đạt | Gọi API assets từ editor trả về 30 asset. |
| Phục hồi từ trang New character | Hỏng / không ổn định | Helper chỉ tìm Done; trang New character thực tế có Go back. Một lần `open_project` sau restart timeout `Flow did not finish loading its project page`; điều hướng browser trực tiếp phục hồi được. |

## Nguyên nhân và hướng sửa theo thứ tự

1. **Đồng bộ mã đang chạy.** Process Studio cũ khởi động 16:07 nhưng `core.ts` thay đổi 16:56; build trên đĩa không cập nhật process đang chạy. Điều này được xác nhận bằng upload từ 404 sang thành công sau restart. Nên thêm build ID, thời điểm process khởi động và danh sách capability backend vào health; launcher cần báo rõ khi bản đang chạy cũ hơn bản vừa build. Đã lưu snapshot jobs trước restart trong `runtime-before-restart.json`.

2. **Sửa vòng đời điều hướng trước khi sửa từng nút nhân vật.** `service-worker.js` gọi prepare khi tab active có bất kỳ update; prepare có thể viết thêm `hl=en` bằng `chrome.tabs.update`, hoặc reload để nạp bridge. Flow chuyển sang `/character` có thể bỏ query. Đây là đường có thể cắt ngang promise trong content script. Cần gom các lần prepare theo tab, đợi load hoàn tất, và không tự điều hướng/reload trong lúc workflow đang giữ tab. Nên đưa các bước điều hướng/chờ page-ready ra worker hoặc backend, giữ content script thực hiện các bước DOM ngắn. Đây là hướng điều tra từ mã và lỗi mất channel; chưa có trace đủ để quy mọi lần mất channel về một nguyên nhân duy nhất.

3. **Tách trạng thái Characters.** Nhận biết library, New character và editor nhân vật riêng. Trang New character phải có đường Go back; không chờ Done trên trang này. Luồng list phải xử lý thư viện trống hoặc chuyển sang màn hình tạo mới và trả về kết quả phù hợp, thay vì để view đó làm hỏng lệnh kế tiếp. Khi tạo, đợi đúng Add from project/Upload và picker hết loading; không dựa vào một lần sleep 300 ms và chỉ các option đang render. Dùng search/media ID để chọn asset; báo lỗi nếu trùng tên.

4. **Sửa xác nhận Frames.** Video text đã chạy nên lỗi hiện tái hiện ở phần mode/frame. Kiểm tra control thực tế sau khi chọn model, vì đổi model có thể thay đổi mode. Xác nhận bằng control được chọn và sự xuất hiện của Start/End frame; xử lý popover đóng/mở lại và giới hạn mode theo model. Không chỉ mở rộng substring hoặc chọn đại option đầu tiên.

5. **Giữ kết quả không chắc chắn đúng trạng thái.** Mất channel trong một lệnh thay đổi dữ liệu hiện có thể được serialize thành `outcome_unknown=false`. Cần lưu phase trước/sau submit ở worker/backend; khi mất kết nối sau submit phải yêu cầu kiểm tra Flow trước khi retry. Không tự chạy lại thao tác tạo/edit chỉ dựa trên message channel error.

6. **Thay bộ test Playwright cũ bằng test native và smoke thực tế.** Giữ các trường hợp: Characters trống, Go back từ New character, đổi Image↔Video↔Frames, picker chậm/virtualized, upload local, navigation làm mất content context, render thành công nhưng download thất bại, backend/extension lệch build. Bộ test cần kiểm tra hành vi và lỗi rõ ràng, cùng báo cáo credit trước/sau.

Đối với cảnh báo unusual activity, nên kiểm tra tương thích của các hook hiện tại với Flow. `flow-submit-main.js` đang bọc listener và dựng event có thuộc tính isTrusted; đây là phần dễ vỡ. Không quy kết chắc chắn hook này gây cảnh báo chỉ từ một mẫu lỗi. Không thực hiện thử nghiệm nhằm vượt cảnh báo của Flow.

## Phạm vi chưa được xác nhận

Chưa chạy paid video edit, paid continuation, Agent batch, upscale download hoặc character edit render. Tạo nhân vật bằng mô tả cũng chưa chạy riêng vì vẫn phụ thuộc nhánh điều hướng/save nhân vật đang hỏng. Không kết luận các nhánh này hoạt động chỉ vì capability được quảng bá trong handshake.

## Artifact

- `native-audit.json`: lượt kiểm tra baseline, gồm cả lỗi dây chuyền sau Characters; một probe trần 0 bị guard là hành vi đúng, không phải render đã thất bại.
- `native-video-audit.json`: một clip trả phí đã hoàn thành, số dư 62 → 47.
- `native-supplemental-audit.json`: download độc lập, 404 upload trên process cũ, lỗi unusual activity của ảnh đơn.
- `upload-current-runtime.json`, `character-current-runtime.json`: kết quả sau restart backend.
- `native-runtime-retest.json`: lượt khôi phục project dừng ở điều hướng; không được tính là upload/character đã thực thi trong lượt này.
- `scripts/audit-native.mjs`: runner tuần tự; mặc định trần 0 credit. `--paid-video` là opt-in 1 clip với trần 15, chỉ chạy khi có ngân sách được cho phép.

Output media nằm trong `C:\Users\nguye\flow-mcp-out\NativeDiagnostic1019`.
