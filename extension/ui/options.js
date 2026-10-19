const I18N = {
  vi: {
    pageTitle: "Cài đặt Flow MCP Connector",
    title: "Cài đặt Flow MCP Connector",
    subtitle: "Cấu hình kết nối giữa Chrome Extension và Flow MCP Server cục bộ.",
    cardTitle: "Thông số kết nối",
    lblBridge: "Địa chỉ máy chủ (Bridge URL)",
    txtHelp: "Extension tự động xác thực bằng ID extension. Không cần nhập token bảo mật.",
    btnSave: "Lưu cấu hình & Kết nối lại",
    savedSuccess: "Đã lưu thành công! Hãy mở hoặc tải lại tab Google Flow; extension sẽ tự động liên kết.",
    guideTitle: "Hướng dẫn nhanh",
    step1: "<b>Khởi động server:</b> Chạy script <code>Start Flow.cmd</code> hoặc lệnh <code>npm run studio</code> để kích hoạt server cổng 18899.",
    step2: "<b>Mở dự án Flow:</b> Truy cập <code>flow.google.com</code>, mở dự án bất kỳ và giữ tab đó đang mở.",
    step3: "<b>Liên kết:</b> Nhấp vào biểu tượng Extension và bấm nút <b>\"Kết nối tab Flow hiện tại\"</b> để bắt đầu điều khiển tự động.",
  },
  en: {
    pageTitle: "Flow MCP Connector Settings",
    title: "Flow MCP Connector Settings",
    subtitle: "Configure the connection between Chrome Extension and local Flow MCP Server.",
    cardTitle: "Connection Settings",
    lblBridge: "Bridge URL",
    txtHelp: "The connector is verified by its extension identity. No token is needed.",
    btnSave: "Save and Connect",
    savedSuccess: "Saved! Open or refresh a Flow tab; the connector will attach automatically.",
    guideTitle: "Quick Guide",
    step1: "<b>Start the server:</b> Run <code>Start Flow.cmd</code> or <code>npm run studio</code> to start the backend on port 18899.",
    step2: "<b>Open Flow project:</b> Visit <code>flow.google.com</code>, open a project and keep the tab active.",
    step3: "<b>Connect:</b> Click the extension icon and select <b>\"Connect active Flow tab\"</b> to enable automation.",
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
  document.querySelector("#txtBtnSave").textContent = t("btnSave");
  document.querySelector("#txtGuideTitle").textContent = t("guideTitle");
  document.querySelector("#step1").innerHTML = t("step1");
  document.querySelector("#step2").innerHTML = t("step2");
  document.querySelector("#step3").innerHTML = t("step3");

  document.querySelector("#langVi").classList.toggle("active", currentLang === "vi");
  document.querySelector("#langEn").classList.toggle("active", currentLang === "en");
}

const bridgeInput = document.querySelector("#bridge");
const statusMsg = document.querySelector("#status");

// Load stored settings
chrome.storage.local.get({ bridge: "http://127.0.0.1:18899", lang: "vi" }).then(c => {
  if (["http://127.0.0.1:8799", "http://localhost:8799"].includes(c.bridge)) {
    c.bridge = "http://127.0.0.1:18899";
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
  const cleanUrl = bridgeInput.value.trim().replace(/\/$/, "");
  await chrome.storage.local.set({ bridge: cleanUrl });
  await chrome.storage.local.remove("token");
  await chrome.runtime.sendMessage({ type: "flow-mcp:connect" });

  statusMsg.className = "status-msg success show";
  statusMsg.textContent = t("savedSuccess");

  setTimeout(() => {
    statusMsg.classList.remove("show");
  }, 6000);
});
