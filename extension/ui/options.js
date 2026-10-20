const I18N = {
  vi: {
    pageTitle: "Cài đặt Flow MCP Connector",
    title: "Cài đặt Flow MCP Connector",
    subtitle: "Kết nối extension với backend Flow MCP trên máy tính hoặc VPS.",
    cardTitle: "Thông số kết nối",
    lblBridge: "Địa chỉ máy chủ (Bridge URL)",
    txtHelp: "Backend VPS cần HTTPS. Nhập mã ghép đôi do quản trị viên cấp để xác thực thiết bị Chrome này.",
    lblPairingCode: "Mã ghép đôi VPS",
    txtPairingHelp: "Mã này được đổi lấy token riêng cho profile Chrome hiện tại và sẽ được xóa sau khi ghép đôi.",
    btnSave: "Lưu và ghép đôi / kết nối",
    savedSuccess: "Đã lưu và kết nối. Hãy mở hoặc tải lại tab Google Flow nếu cần.",
    guideTitle: "Hướng dẫn nhanh",
    step1: "<b>Cấu hình backend:</b> Nhập URL HTTPS của VPS và mã ghép đôi do quản trị viên cấp. Dùng HTTP chỉ với backend localhost.",
    step2: "<b>Mở dự án Flow:</b> Truy cập <code>flow.google.com</code>, mở dự án bất kỳ và giữ tab đó đang mở.",
    step3: "<b>Kết nối:</b> Bấm lưu và ghép đôi. Extension sẽ tự kết nối lại bằng token riêng của thiết bị.",
  },
  en: {
    pageTitle: "Flow MCP Connector Settings",
    title: "Flow MCP Connector Settings",
    subtitle: "Connect the extension to a local or VPS Flow MCP backend.",
    cardTitle: "Connection Settings",
    lblBridge: "Bridge URL",
    txtHelp: "VPS backends require HTTPS. Enter the pairing code from your administrator to authorize this Chrome profile.",
    lblPairingCode: "VPS pairing code",
    txtPairingHelp: "The code is exchanged for a token for this Chrome profile and cleared after pairing.",
    btnSave: "Save and pair / connect",
    savedSuccess: "Saved and connected. Open or refresh a Flow tab if needed.",
    guideTitle: "Quick Guide",
    step1: "<b>Configure backend:</b> Enter the VPS HTTPS URL and the pairing code from your administrator. HTTP is only allowed for localhost.",
    step2: "<b>Open Flow project:</b> Visit <code>flow.google.com</code>, open a project and keep the tab active.",
    step3: "<b>Connect:</b> Save and pair. The extension reconnects using this device's token.",
  }
};

let currentLang = "vi";

function t(key) {
  const dict = I18N[currentLang] || I18N.vi;
  return dict[key] || key;
}

function applyLanguage() {
  document.documentElement.lang = currentLang;
  document.title = t("pageTitle");
  document.querySelector("#txtTitle").textContent = t("title");
  document.querySelector("#txtSubtitle").textContent = t("subtitle");
  document.querySelector("#txtCardTitle").textContent = t("cardTitle");
  document.querySelector("#lblBridge").textContent = t("lblBridge");
  document.querySelector("#txtHelp").textContent = t("txtHelp");
  document.querySelector("#lblPairingCode").textContent = t("lblPairingCode");
  document.querySelector("#txtPairingHelp").textContent = t("txtPairingHelp");
  document.querySelector("#txtBtnSave").textContent = t("btnSave");
  document.querySelector("#txtGuideTitle").textContent = t("guideTitle");
  document.querySelector("#step1").innerHTML = t("step1");
  document.querySelector("#step2").innerHTML = t("step2");
  document.querySelector("#step3").innerHTML = t("step3");

  document.querySelector("#langVi").classList.toggle("active", currentLang === "vi");
  document.querySelector("#langEn").classList.toggle("active", currentLang === "en");
}

const bridgeInput = document.querySelector("#bridge");
const pairingCodeInput = document.querySelector("#pairingCode");
const statusMsg = document.querySelector("#status");

// Load stored settings
chrome.storage.local.get({ bridge: "https://mcp.shopcongngheso5.io.vn", lang: "vi" }).then(c => {
  if (["http://127.0.0.1:8799", "http://localhost:8799"].includes(c.bridge)) {
    c.bridge = "https://mcp.shopcongngheso5.io.vn";
    chrome.storage.local.set({ bridge: c.bridge });
  } else if (["http://127.0.0.1:18899", "http://localhost:18899"].includes(c.bridge)) {
    c.bridge = "https://mcp.shopcongngheso5.io.vn";
    chrome.storage.local.set({ bridge: c.bridge });
  }
  bridgeInput.value = c.bridge;
  currentLang = c.lang === "en" ? "en" : "vi";
  applyLanguage();
});

// Language switches
document.querySelector("#langVi").onclick = () => {
  if (currentLang === "vi") return;
  currentLang = "vi";
  chrome.storage.local.set({ lang: "vi" });
  applyLanguage();
};

document.querySelector("#langEn").onclick = () => {
  if (currentLang === "en") return;
  currentLang = "en";
  chrome.storage.local.set({ lang: "en" });
  applyLanguage();
};

// Preset chips click
document.querySelectorAll(".preset-chip").forEach(chip => {
  chip.onclick = () => {
    const url = chip.getAttribute("data-url");
    if (url) bridgeInput.value = url;
  };
});

// Save and connect
document.querySelector("#save").addEventListener("click", async () => {
  const button = document.querySelector("#save");
  button.disabled = true;
  statusMsg.className = "status-msg show";
  statusMsg.textContent = currentLang === "vi" ? "Đang lưu cấu hình…" : "Saving settings…";
  try {
    const cleanUrl = bridgeInput.value.trim().replace(/\/$/, "");
    const base = new URL(cleanUrl);
    if (base.username || base.password || base.search || base.hash) throw new Error(currentLang === "vi" ? "URL backend không được chứa thông tin đăng nhập, query hoặc hash." : "Backend URL cannot contain credentials, a query, or a fragment.");
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname);
    const configuredVps = base.hostname === "mcp.shopcongngheso5.io.vn";
    if (!(local ? ["http:", "https:"].includes(base.protocol) : configuredVps && base.protocol === "https:")) {
      throw new Error(currentLang === "vi" ? "Dùng URL VPS https://mcp.shopcongngheso5.io.vn; HTTP chỉ dùng cho localhost." : "Use VPS URL https://mcp.shopcongngheso5.io.vn; HTTP is only allowed for localhost.");
    }
    base.pathname = "/";
    const normalizedUrl = base.origin;
    const previous = await chrome.storage.local.get(["bridge", "tokenBridgeOrigin"]);
    const updates = { bridge: normalizedUrl };
    if (previous.tokenBridgeOrigin && previous.tokenBridgeOrigin !== base.origin) {
      await chrome.storage.local.remove(["deviceToken", "deviceId", "tokenBridgeOrigin"]);
    }
    await chrome.storage.local.set(updates);

    const code = pairingCodeInput.value.trim();
    if (code) {
      const response = await fetch(`${base.origin}/api/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user_code: code, device_name: "Chrome Flow Extension" }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || typeof result.device_token !== "string" || !result.device_token) {
        throw new Error(result.error || (currentLang === "vi" ? `Ghép đôi thất bại (HTTP ${response.status}).` : `Pairing failed (HTTP ${response.status}).`));
      }
      await chrome.storage.local.set({ deviceToken: result.device_token, deviceId: result.device_id, tokenBridgeOrigin: base.origin });
      pairingCodeInput.value = "";
    }
    await chrome.runtime.sendMessage({ type: "flow-mcp:connect" });
    let connectionStatus;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
      connectionStatus = await chrome.runtime.sendMessage({ type: "flow-mcp:status" });
      if (connectionStatus?.wsConnected) break;
      if (connectionStatus?.error && attempt >= 3) throw new Error(connectionStatus.error);
    }
    if (!connectionStatus?.wsConnected) {
      throw new Error(connectionStatus?.error || (currentLang === "vi" ? "Chưa kết nối được backend. Kiểm tra URL VPS, mã ghép đôi và trạng thái WSS." : "Backend did not connect. Check the VPS URL, pairing code, and WSS status."));
    }
    statusMsg.className = "status-msg success show";
    statusMsg.textContent = t("savedSuccess");
  } catch (error) {
    statusMsg.className = "status-msg error show";
    statusMsg.textContent = error?.message || String(error);
  } finally {
    button.disabled = false;
    setTimeout(() => statusMsg.classList.remove("show"), 8000);
  }
});
