const flowUrl = url => /^https:\/\/flow\.google\.com\//.test(url || "");

const allowedMediaHost = hostname => {
  const host = hostname.toLowerCase();
  return host === "storage.googleapis.com" || host === "googleusercontent.com" || host.endsWith(".googleusercontent.com") ||
    host.endsWith(".googleapis.com") || host.endsWith(".usercontent.goog");
};

export async function readFlowDownloadChunk(input, {
  downloads = chrome.downloads,
  fetchImpl = fetch,
  cryptoApi = crypto,
} = {}) {
  const id = Number(input?.id);
  const index = Number(input?.index);
  const offset = Number(input?.offset);
  const length = Number(input?.length);
  if (![id, index, offset, length].every(Number.isSafeInteger) || id < 0 || index < 0 || offset < 0 || length < 1 || length > 1024 * 1024) {
    throw new Error("Invalid Flow download range request.");
  }
  const [item] = await downloads.search({ id });
  if (!item || item.id !== id || item.state !== "complete" || !(flowUrl(item.referrer) || flowUrl(item.url))) {
    throw new Error("The selected item is not a completed Flow download.");
  }
  const mediaUrl = item.finalUrl || item.url;
  let parsed;
  try { parsed = new URL(mediaUrl); } catch { throw new Error("Flow did not provide a readable media URL for this download."); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || !allowedMediaHost(parsed.hostname)) {
    throw new Error("The Flow download URL is not on an approved Google media host.");
  }
  const requestedTotal = Number(item.totalBytes);
  if (requestedTotal > 0 && offset >= requestedTotal) throw new Error("Flow download range is beyond the file size.");
  const end = offset + length - 1;
  let response;
  try {
    response = await fetchImpl(mediaUrl, {
      headers: { Range: `bytes=${offset}-${end}` },
      credentials: "omit",
      cache: "no-store",
      redirect: "follow",
      signal: AbortSignal.timeout(45_000),
    });
  } catch {
    throw new Error("Could not read the completed Flow media URL. The signed link may have expired.");
  }
  if (response.status !== 206) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Flow media server did not honor the requested byte range (HTTP ${response.status}).`);
  }
  const range = response.headers.get("content-range")?.match(/^bytes (\d+)-(\d+)\/(\d+)$/i);
  if (!range || Number(range[1]) !== offset || Number(range[2]) > end) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Flow media server returned an invalid byte range.");
  }
  const totalBytes = Number(range[3]);
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 1 || (requestedTotal > 0 && totalBytes !== requestedTotal)) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Flow download size did not match Chrome's completed download record.");
  }
  const expectedLength = Math.min(length, totalBytes - offset);
  if (expectedLength < 1 || Number(range[2]) - offset + 1 !== expectedLength) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Flow media server returned an incomplete byte range.");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length !== expectedLength) throw new Error("Flow media server returned a truncated or oversized byte range.");
  const digest = new Uint8Array(await cryptoApi.subtle.digest("SHA-256", bytes));
  const chunkSha256 = [...digest].map(value => value.toString(16).padStart(2, "0")).join("");
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { index, offset, data: btoa(binary), chunkSha256, totalBytes };
}
