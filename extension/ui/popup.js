let cachedStatus = null;

function t(key, params) {
  const fullKey = key.includes(".") ? key : `popup.${key}`;
  return typeof I18n !== "undefined" ? I18n.t(fullKey, params) : key;
}

function mapErrorMessage(raw) {
  if (!raw) return "";
  const str = String(raw);
  if (/Open a Flow project/i.test(str)) return t("errNoFlowTab");
  if (/Cannot connect to the local backend|ECONNREFUSED/i.test(str)) return t("errBackendDown");
  return `${t("errGeneric")} ${str}`;
}

function applyLanguage() {
  const currentLang = typeof I18n !== "undefined" ? I18n.getLocale() : "vi";
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
const initLocale = typeof I18n !== "undefined" ? I18n.init() : Promise.resolve();
initLocale.then(() => {
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
document.querySelector("#langVi").onclick = async () => {
  if (typeof I18n !== "undefined") {
    if (I18n.getLocale() === "vi") return;
    await I18n.setLocale("vi");
  }
  applyLanguage();
};

document.querySelector("#langEn").onclick = async () => {
  if (typeof I18n !== "undefined") {
    if (I18n.getLocale() === "en") return;
    await I18n.setLocale("en");
  }
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
