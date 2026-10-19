const I18N = {
  vi: {
    checking: "Đang kiểm tra…",
    wsConnected: "Đã kết nối WebSocket",
    wsDisconnected: "Mất kết nối máy chủ",
    flowTabs: "Tab Google Flow:",
    selectedTab: "Tab điều khiển:",
    bridgeUrl: "Địa chỉ máy chủ:",
    tabNone: "Chưa chọn tab",
    tabsCount: (n) => `${n} tab đang mở`,
    tabsNone: "Chưa mở tab Flow",
    btnConnect: "Kết nối lại tab Flow",
    btnPreview: "Xem viền (5s)",
    btnOptions: "Cài đặt",
    reconnecting: "Đang kết nối lại tab Flow hiện tại...",
    previewTriggered: "Đang hiển thị viền xanh trên tab Flow...",
    errNoFlowTab: "Mở Google Flow; tiện ích sẽ tự kết nối với tab đang hoạt động.",
    selectingTab: "Đang tự chọn tab Flow…",
    errBackendDown: "Chưa bật Flow MCP backend (cổng 18899). Hãy chạy Start Flow.cmd.",
    errGeneric: "Lỗi kết nối:",
  },
  en: {
    checking: "Checking…",
    wsConnected: "Connected via WebSocket",
    wsDisconnected: "Disconnected from server",
    flowTabs: "Google Flow tabs:",
    selectedTab: "Controlled tab:",
    bridgeUrl: "Bridge URL:",
    tabNone: "Not selected",
    tabsCount: (n) => `${n} open tab${n === 1 ? "" : "s"}`,
    tabsNone: "No Flow tab open",
    btnConnect: "Reconnect Flow tab",
    btnPreview: "Preview border (5s)",
    btnOptions: "Settings",
    reconnecting: "Reconnecting to the active Flow tab...",
    previewTriggered: "Displaying activity border on Flow tab...",
    errNoFlowTab: "Open Google Flow; the extension connects to the active Flow tab automatically.",
    selectingTab: "Selecting a Flow tab automatically…",
    errBackendDown: "Cannot connect to Flow MCP backend (port 18899). Run Start Flow.cmd.",
    errGeneric: "Connector error:",
  }
};

let currentLang = "vi";
let cachedStatus = null;

function t(key, ...args) {
  const dict = I18N[currentLang] || I18N.vi;
  const val = dict[key];
  if (typeof val === "function") return val(...args);
  return val || key;
}

function mapErrorMessage(raw) {
  if (!raw) return "";
  const str = String(raw);
  if (/Open a Flow project/i.test(str)) return t("errNoFlowTab");
  if (/Cannot connect to the local backend|ECONNREFUSED/i.test(str)) return t("errBackendDown");
  return `${t("errGeneric")} ${str}`;
}

function applyLanguage() {
  document.documentElement.lang = currentLang;
  document.querySelector("#langVi").classList.toggle("active", currentLang === "vi");
  document.querySelector("#langEn").classList.toggle("active", currentLang === "en");

  document.querySelector("#lblFlowTabs").textContent = t("flowTabs");
  document.querySelector("#lblSelectedTab").textContent = t("selectedTab");
  document.querySelector("#lblBridgeUrl").textContent = t("bridgeUrl");
  document.querySelector("#txtConnect").textContent = t("btnConnect");
  document.querySelector("#txtPreview").textContent = t("btnPreview");
  document.querySelector("#txtOptions").textContent = t("btnOptions");

  if (cachedStatus) {
    renderStatus(cachedStatus);
  } else {
    document.querySelector("#wsText").textContent = t("checking");
  }
}

function renderStatus(s) {
  cachedStatus = s;
  const wsBadge = document.querySelector("#wsBadge");
  const wsText = document.querySelector("#wsText");
  const valFlowTabs = document.querySelector("#valFlowTabs");
  const valSelectedTab = document.querySelector("#valSelectedTab");
  const valBridgeUrl = document.querySelector("#valBridgeUrl");
  const bridgeSummary = document.querySelector("#bridgeSummary");
  const alertBox = document.querySelector("#alertBox");
  const alertText = document.querySelector("#alertText");

  // WebSocket status
  if (s.wsConnected) {
    wsBadge.className = "status-badge connected";
    wsText.textContent = t("wsConnected");
  } else {
    wsBadge.className = "status-badge disconnected";
    wsText.textContent = t("wsDisconnected");
  }

  // Flow tabs
  const count = s.flowTabs ?? 0;
  valFlowTabs.textContent = count > 0 ? t("tabsCount", count) : t("tabsNone");

  // Selected tab
  valSelectedTab.textContent = s.selectedTabId ? `Tab #${s.selectedTabId}` : t("tabNone");

  // Bridge URL
  if (s.bridge) {
    valBridgeUrl.textContent = s.bridge;
    try {
      const u = new URL(s.bridge);
      bridgeSummary.textContent = u.host || s.bridge;
    } catch {
      bridgeSummary.textContent = s.bridge;
    }
  }

  // Error / Alert handling
  const errorMsg = mapErrorMessage(s.error);
  if (errorMsg) {
    alertBox.className = "alert-box error show";
    alertText.textContent = errorMsg;
  } else if (!s.wsConnected) {
    alertBox.className = "alert-box warn show";
    alertText.textContent = t("errBackendDown");
  } else if (count === 0) {
    alertBox.className = "alert-box warn show";
    alertText.textContent = t("errNoFlowTab");
  } else if (!s.selectedTabId) {
    alertBox.className = "alert-box warn show";
    alertText.textContent = t("selectingTab");
  } else {
    alertBox.className = "alert-box";
    alertText.textContent = "";
  }
}

function setFeedback(msg, isSuccess = true) {
  const el = document.querySelector("#feedback");
  el.textContent = msg;
  el.className = isSuccess ? "feedback active" : "feedback";
}

// Initial setup
const manifest = chrome.runtime.getManifest();
document.querySelector("#versionBadge").textContent = `v${manifest.version || "0.4.6"}`;

// Load language and status
chrome.storage.local.get({ lang: "vi" }).then(data => {
  currentLang = data.lang === "en" ? "en" : "vi";
  applyLanguage();

  return chrome.runtime.sendMessage({ type: "flow-mcp:status" });
}).then(s => {
  if (s) renderStatus(s);
}).catch(err => {
  renderStatus({
    wsConnected: false,
    flowTabs: 0,
    selectedTabId: null,
    bridge: "http://127.0.0.1:18899",
    error: err.message
  });
});

// Language switch listeners
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

// Actions
document.querySelector("#connect").onclick = async () => {
  setFeedback(t("reconnecting"), true);
  try {
    await chrome.runtime.sendMessage({ type: "flow-mcp:connect" });
    // Re-check status after a short delay
    setTimeout(async () => {
      try {
        const s = await chrome.runtime.sendMessage({ type: "flow-mcp:status" });
        if (s) renderStatus(s);
        setFeedback("");
      } catch {}
    }, 700);
  } catch (err) {
    setFeedback(mapErrorMessage(err.message), false);
  }
};

document.querySelector("#preview").onclick = async () => {
  setFeedback(t("previewTriggered"), true);
  try {
    const result = await chrome.runtime.sendMessage({ type: "flow-mcp:preview" });
    if (result?.error) throw new Error(result.error);
    setTimeout(() => window.close(), 500);
  } catch (err) {
    setFeedback(mapErrorMessage(err.message), false);
  }
};

document.querySelector("#options").onclick = () => {
  chrome.runtime.openOptionsPage();
};
