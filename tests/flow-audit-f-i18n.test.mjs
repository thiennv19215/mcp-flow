import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Scan test (audit cluster F): sidebar.js still carries many hardcoded
// Vietnamese literals. A full conversion to t() needs 160+ English
// translations (a missing key renders the raw key, which is worse than
// today's Vietnamese), so instead this test PINS the current literal set:
// any NEW hardcoded Vietnamese literal in sidebar.js fails the gate until
// it is either routed through t() (and dropped from this list) or
// deliberately added here with a reason. Three sites already converted
// to existing keys are pinned by the second test, not this list.
const PINNED = new Set([
  " (chạy tuần tự bắt buộc)",
  " Tự động tải đang tắt; có thể bấm Tải về ở tác vụ.",
  " Đã tải về ${downloads.length} tệp${downloads[0]?.filename ? ",
  "${album.imageCount || 0} ảnh",
  "${droppedLibraryRefs} tham chiếu thư viện Flow không được gửi sang ChatGPT; chỉ tệp tải lên mới dùng làm tham chiếu.",
  "${state.nodes.length} node, ${state.edges.length} cạnh${state.name ? ",
  "${task.results.length} kết quả",
  "${val.length} ký tự",
  "(Thiếu trường — xem nguyên văn ở ô dán phía trên.)",
  ").replace(/[đĐ]/g, ",
  ". Chọn nhân vật có ID hoặc bỏ chọn nhân vật.",
  ". Hãy đồng bộ lại nhân vật hoặc bỏ chọn nhân vật trước khi tạo ${type}.",
  ">Chèn</button></div>",
  ">Chạy lại</button></div><time class=",
  ">Chạy</button><button type=",
  ">Dùng mẫu</button><button type=",
  ">Flow chưa cung cấp ID nhân vật</span>",
  ">Nhân bản</button><button type=",
  ">Tạo workflow</button><button type=",
  ">Xoá album</button></div>",
  ">Xoá</button></div>",
  ">Xuất file</button><button type=",
  ">Đổi tên</button><button type=",
  "? Ảnh gốc trong thư viện Flow không bị xoá.",
  "Chuyển “${asset.name || asset.title}” vào thùng rác Flow?",
  "Chèn ${lang}",
  "Chưa chọn preset.",
  "Chưa chọn tác vụ nào để chạy.",
  "Chưa có album nào.",
  "Chưa có album nào. Nhập tên album mới:",
  "Chưa có node nào. Chọn loại node rồi bấm Thêm node.",
  "Chưa có — bấm Chọn ảnh nguồn để chọn hoặc tải ảnh lên.",
  "Chưa tách được I2P.",
  "Chưa tách được prompt.",
  "Chưa tạo được yêu cầu.",
  "Chỉ gửi ${attachments.length}/${stagedRefs.length} ảnh tham chiếu theo giới hạn ChatGPT.",
  "Chỉnh sửa nhân vật: ${selected}",
  "Chọn loại tham chiếu cần gỡ.",
  "Chọn một tệp ảnh hoặc video.",
  "Chọn nhân vật và nhập tên mới hoặc mô tả thay đổi.",
  "Chọn tài sản và nhập tên mới.",
  "Chờ chạy",
  "Chụp màn hình thất bại: ${err.message}",
  "Chủ đề: ${subject}",
  "Công cụ biến đổi chưa sẵn sàng.",
  "Dịch vụ tải media lên chưa sẵn sàng.",
  "Dịch vụ tải ảnh lên Flow chưa được khởi tạo",
  "Flow MCP · Tạo ảnh, video, tham chiếu, frames và đa tác vụ",
  "Flow không cung cấp ID nhân vật cho ",
  "Flow không cung cấp ID nhân vật; không thể dùng nhân vật này để tạo ảnh/video.",
  "Google Flow Provider đang hoạt động",
  "Hiệu ứng ảnh (Effects)",
  "Hoàn thành",
  "Hoàn thành một phần",
  "Hoàn tất.",
  "Hãy chọn một dự án.",
  "Hãy chọn một tài sản.",
  "Hãy chọn một ảnh nguồn trước.",
  "Hãy đợi hàng đợi Flow trống trước khi thực hiện thao tác này.",
  "Hủy tải lên: ${entry.label}",
  "Không dùng addon",
  "Không thể chạy lại bản ghi này.",
  "Không thể chạy tác vụ đã lưu.",
  "Không thể dùng mẫu cấu hình này.",
  "Không thể dừng hàng đợi: ${err.message}",
  "Không thể kết nối với extension background. Vui lòng mở tiện ích trong Chrome Side Panel.",
  "Không thể lưu mẫu cấu hình này.",
  "Không thể lưu mẫu workflow này.",
  "Không thể lưu tác vụ.",
  "Không thể lưu vào album.",
  "Không thể nhân bản tác vụ.",
  "Không thể nhập mẫu workflow này.",
  "Không thể thêm chỉnh sửa vào hàng đợi.",
  "Không thể thêm tác vụ ChatGPT vào hàng đợi",
  "Không thể thêm tác vụ vào hàng đợi Flow",
  "Không thể thêm tác vụ vào hàng đợi Flow.",
  "Không thể tạo album.",
  "Không thể tạo workflow từ mẫu này.",
  "Không thể xoá album.",
  "Không thể xoá mẫu cấu hình này.",
  "Không thể xoá mẫu workflow này.",
  "Không thể xoá tác vụ.",
  "Không thể xoá ảnh khỏi album.",
  "Không thể xuất mẫu workflow này.",
  "Không thể đổi tên album.",
  "Không tách được prompt nào — câu trả lời thiếu khối PROMPTS.",
  "Không tìm thấy album đã chọn.",
  "Không đọc được cấu hình ChatGPT cục bộ của extension. Hãy tải lại extension rồi thử lại.",
  "Không đọc được cấu hình model cục bộ của extension. Hãy tải lại extension rồi thử lại.",
  "Kích hoạt viền xanh 5s",
  "Lưu vào Album",
  "Lưu vào album nào?\\n${listing}",
  "Lỗi nhập tệp: ${err.message}",
  "Model video chưa có capability DOM được xác nhận trong cấu hình local.",
  "Mặc định (Không phong cách)",
  "Một phần",
  "Nhập ít nhất một tham chiếu.",
  "Nội dung text:",
  "Provider: ${provider.toUpperCase()} (Tự động thực thi qua Flow MCP Studio)",
  "Thao tác Flow hoàn tất.",
  "Thành công",
  "Thất bại",
  "Tiến trình",
  "Trình duyệt không trả về dữ liệu ảnh màn hình.",
  "Trình soạn workflow chưa sẵn sàng.",
  "Tuần tự",
  "Tác vụ Flow thất bại.",
  "Tên album mới:",
  "Tên tác vụ:",
  "Tìm nhân vật...",
  "Tạo video",
  "Tạo ảnh",
  "Tệp không có dòng văn bản hợp lệ.",
  "Tối đa ${cap} ảnh tham chiếu",
  "Vui lòng nhập câu lệnh prompt cho video!",
  "Vui lòng nhập câu lệnh prompt cho ảnh!",
  "Vui lòng nhập câu lệnh để lưu!",
  "Vui lòng nhập prompt ở tab Tạo trước khi lưu thành tác vụ.",
  "Xoá",
  "Xoá album ",
  "Yêu cầu kết nối lại Flow tab",
  "giây",
  "nhân vật này",
  "tệp",
  "×",
  "Đa góc nhìn (Angles)",
  "Đang chạy",
  "Đang chụp ảnh màn hình tab hiện tại...",
  "Đang có tác vụ đang chạy, vui lòng đợi!",
  "Đang tải danh sách nhân vật từ Flow...",
  "Đang tải media tham chiếu ${uploadedVideoCount}/${localVideoReferences.length} lên Flow...",
  "Đang tải tệp lên Flow: ${progress}%",
  "Đang tải ảnh tham chiếu ${uploadedImageCount}/${localImageReferences.length} lên Flow...",
  "Đã chụp ảnh màn hình và thêm vào danh sách tham chiếu!",
  "Đã dừng",
  "Đã gửi yêu cầu tạm dừng hàng đợi Flow.",
  "Đã hủy.",
  "Đã làm mới dữ liệu",
  "Đã lưu câu lệnh vào thư viện Prompts!",
  "Đã nhập ${lines.length} câu lệnh từ file!",
  "Đã đưa chỉnh sửa nhân vật vào hàng đợi Flow.",
  "Đồng bộ từ Flow",
  "Đổi tên album:",
  "đã chạy ${task.runCount} lần",
  "Ảnh",
  "Ảnh đã chọn",
  "ảnh",
  "☕ Cảm ơn bạn đã đồng hành và ủng hộ Flow MCP!",
  "✅ Đã hoàn tất thao tác nhân vật trong Flow.",
  "✅ Đã lưu mẫu cấu hình.",
  "✅ Đã lưu mẫu workflow.",
  "✅ Đã lưu tác vụ vào tab Tác vụ.",
  "✅ Đã mở workflow vào trình soạn.",
  "✅ Đã nhập mẫu workflow.",
  "✅ Đã nạp mẫu cấu hình vào khung tạo${refCount ? ",
  "✅ Đã tạo album.",
  "✅ Đã tạo workflow mới từ mẫu (tải xuống dạng JSON).",
  "✅ Đã xuất JSON workflow (chỉ field trong whitelist).",
  "✅ Đã đưa biến đổi ảnh vào hàng đợi Flow.",
  "✅ Đã đưa bản ghi vào hàng đợi Flow.",
  "✅ Đã đưa tác vụ vào hàng đợi Flow${note}.",
  "👤 ${name} · ID không khả dụng",
]);

function extractLiterals(source) {
  const found = new Set();
  const re = /['"`]([^'"`\n]*[\u00C0-\u1EF9][^'"`\n]*)['"`]/g;
  for (const m of source.matchAll(re)) found.add(m[1]);
  return found;
}

test('sidebar.js introduces no new hardcoded Vietnamese literal', () => {
  const source = readFileSync(new URL('../extension/src/ui/sidebar.js', import.meta.url), 'utf8');
  const found = extractLiterals(source);
  const added = [...found].filter(s => !PINNED.has(s));
  assert.deepEqual(added, [], `new hardcoded literals (route through t() or pin deliberately): ${JSON.stringify(added)}`);
  const removed = [...PINNED].filter(s => !found.has(s));
  assert.deepEqual(removed, [], `pinned literals gone (converted to t()? drop them from PINNED): ${JSON.stringify(removed)}`);
});

test('previously converted sites use t() keys, not raw literals', () => {
  const source = readFileSync(new URL('../extension/src/ui/sidebar.js', import.meta.url), 'utf8');
  for (const key of ['sidebar.photosUseReference', 'sidebar.libraryNoVoice', 'sidebar.referencePickerLimit']) {
    assert.match(source, new RegExp(`t\\("${key}"\\)`), `${key} must be used`);
  }
  for (const raw of ['Dùng làm tham chiếu', 'Không dùng giọng nói', 'Tối đa 3 ảnh tham chiếu']) {
    assert.doesNotMatch(source, new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${raw} must not appear raw`);
  }
});
