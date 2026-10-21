/**
 * FlowUploadClient - OOP Service chuyên trách chuyển giao media nhị phân lên Google Flow
 * Quản lý SHA-256 integrity, streaming chunk 256KB, báo cáo tiến độ và xác nhận upload.
 */
class FlowUploadClient {
  /**
   * Tải một file lên Google Flow và trả về tên tài nguyên đã xác nhận
   * @param {File|Blob} file
   * @param {Object} options { onProgress: (percent: number) => void, kind?: "image"|"video", name?: string }
   * @returns {Promise<string>} Tên asset trên Flow
   */
  static async upload(file, options = {}) {
    if (!(file instanceof Blob)) {
      throw new Error("File tải lên không hợp lệ");
    }

    const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
    const kind = options.kind === "video" ? "video" : "image";
    const transferId = "fm-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const size = bytes.byteLength;

    const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
    const sha256 = [...new Uint8Array(hashBuffer)].map(b => b.toString(16).padStart(2, "0")).join("");

    const ext = (file.name || "media").split(".").pop() || (kind === "video" ? "mp4" : "png");
    const safeName = options.name || ("ref-" + Date.now() + "." + ext);

    // 1. Khởi tạo phiên chuyển nhượng nhị phân
    await chrome.runtime.sendMessage({
      type: "flow-mcp:dispatch",
      operation: "flow.file.upload.begin",
      payload: {
        transferId,
        name: safeName,
        type: file.type || (kind === "video" ? "video/mp4" : "image/png"),
        size,
        sha256
      }
    });

    // 2. Stream các chunk 256KB kèm checksum
    const chunkSize = 256 * 1024;
    let offset = 0;
    let index = 0;
    while (offset < size) {
      const end = Math.min(offset + chunkSize, size);
      const chunkBytes = bytes.slice(offset, end);
      const chunkHashBuf = await crypto.subtle.digest("SHA-256", chunkBytes);
      const chunkSha256 = [...new Uint8Array(chunkHashBuf)].map(b => b.toString(16).padStart(2, "0")).join("");

      let binary = "";
      const len = chunkBytes.byteLength;
      for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(chunkBytes[i]);
      }
      const b64 = btoa(binary);

      await chrome.runtime.sendMessage({
        type: "flow-mcp:dispatch",
        operation: "flow.file.upload.chunk",
        payload: {
          transferId,
          index,
          offset,
          data: b64,
          chunkSha256
        }
      });

      offset = end;
      index++;
      if (onProgress) onProgress(Math.round((offset / size) * 100));
    }

    // 3. Hoàn tất phiên chuyển nhượng nhị phân
    await chrome.runtime.sendMessage({
      type: "flow-mcp:dispatch",
      operation: "flow.file.upload.finish",
      payload: { transferId }
    });

    // 4. Kích hoạt upload staging vào Flow Tab
    const uploadRes = await chrome.runtime.sendMessage({
      type: "flow-mcp:dispatch",
      operation: "flow.media.upload",
      payload: {
        transferId,
        name: safeName,
        kind
      }
    });

    if (!uploadRes?.ok) {
      throw new Error(uploadRes?.error?.message || "Lỗi tải media lên Google Flow");
    }

    return uploadRes.value?.name || safeName;
  }
}

if (typeof window !== "undefined") {
  window.FlowUploadClient = FlowUploadClient;
}
