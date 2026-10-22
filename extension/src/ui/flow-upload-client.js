/**
 * FlowUploadClient - OOP Service chuyên trách chuyển giao media nhị phân lên Google Flow
 * Quản lý SHA-256 integrity, streaming chunk 256KB, báo cáo tiến độ và xác nhận upload.
 */
class FlowUploadClient {
  /**
   * Flow uses the uploaded filename as the project asset title. Keep the
   * original stem readable, but add a short per-upload suffix so two local
   * files called e.g. "image.png" can never collide in the picker.
   */
  static uniqueAssetName(fileName, transferId, kind = "image", referenceIndex) {
    const fallbackExt = kind === "video" ? "mp4" : "png";
    const rawName = String(fileName || "").trim();
    const lastDot = rawName.lastIndexOf(".");
    const rawBase = lastDot > 0 ? rawName.slice(0, lastDot) : rawName;
    const rawExt = lastDot > 0 ? rawName.slice(lastDot + 1).toLowerCase() : fallbackExt;
    const base = rawBase
      .replace(/[/\\?%*:|"<>#]/g, "-")
      .replace(/\s+/g, " ")
      .replace(/[. ]+$/g, "")
      .trim() || `ref-${kind}`;
    const ext = rawExt.replace(/[^a-z0-9]+/g, "").slice(0, 12) || fallbackExt;
    const token = String(transferId || "")
      .replace(/[^a-z0-9]/gi, "")
      .slice(-10)
      .toLowerCase() || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const numericIndex = Number(referenceIndex);
    const index = Number.isInteger(numericIndex) && numericIndex > 0 ? numericIndex : null;
    const prefix = index !== null ? `ref-${String(index).padStart(2, "0")}` : kind === "video" ? "upload-video" : "upload-image";
    const suffix = `-${token}`;
    // Keep titles comfortably below Flow/browser filename limits while
    // retaining enough of the original name to identify the source image.
    const maxBaseLength = 120;
    return `${prefix}-${base.slice(0, Math.max(1, maxBaseLength - prefix.length - suffix.length))}${suffix}.${ext}`;
  }

  /**
   * Tải một file lên Google Flow và trả về tên tài nguyên đã xác nhận
   * @param {File|Blob} file
   * @param {Object} options { onProgress: (percent: number) => void, kind?: "image"|"video", name?: string, referenceIndex?: number }
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

    // Do not send the browser's original filename as the Flow asset title:
    // separate local files often share names such as "image.png". A unique
    // title lets Flow's picker and tile correlation resolve every reference
    // by exact name and verified media ID.
    const safeName = FlowUploadClient.uniqueAssetName(options.name || file.name, transferId, kind, options.referenceIndex);

    // 1. Khởi tạo phiên chuyển nhượng nhị phân
    const beginRes = await chrome.runtime.sendMessage({
      type: "flow-mcp:dispatch",
      operation: "flow.file.upload.begin",
      payload: {
        transfer: {
          transferId,
          name: safeName,
          type: file.type || (kind === "video" ? "video/mp4" : "image/png"),
          size,
          sha256
        }
      }
    });
    if (!beginRes?.ok) {
      throw new Error(beginRes?.error?.message || "Không thể khởi tạo phiên tải file lên Flow");
    }

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

      const chunkRes = await chrome.runtime.sendMessage({
        type: "flow-mcp:dispatch",
        operation: "flow.file.upload.chunk",
        payload: {
          chunk: {
            transferId,
            index,
            offset,
            data: b64,
            chunkSha256
          }
        }
      });
      if (!chunkRes?.ok) {
        throw new Error(chunkRes?.error?.message || `Lỗi truyền dữ liệu chunk ${index}`);
      }

      offset = end;
      index++;
      if (onProgress) onProgress(Math.round((offset / size) * 100));
    }

    // 3. Hoàn tất phiên chuyển nhượng nhị phân
    const finishRes = await chrome.runtime.sendMessage({
      type: "flow-mcp:dispatch",
      operation: "flow.file.upload.finish",
      payload: { transferId }
    });
    if (!finishRes?.ok) {
      throw new Error(finishRes?.error?.message || "Không thể hoàn tất phiên tải file lên Flow");
    }

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

    const resultName = uploadRes.value?.name || safeName;
    const resultId = uploadRes.value?.id || uploadRes.value?.mediaId || uploadRes.value?.receipt?.id || null;
    return {
      name: resultName,
      id: resultId,
      toString() { return this.name; }
    };
  }
}

if (typeof window !== "undefined") {
  window.FlowUploadClient = FlowUploadClient;
}
