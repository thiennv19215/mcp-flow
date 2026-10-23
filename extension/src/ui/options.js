const LOCAL_MCP_ORIGIN = "http://127.0.0.1:18899";

const I18N = {
  vi: {
    pageTitle: "Cài đặt Flow MCP Connector",
    title: "Cài đặt Flow MCP Connector",
    subtitle: "Flow chạy trực tiếp trong extension; MCP local chạy riêng trên máy này.",
    cardTitle: "Thông số kết nối",
    guideTitle: "Hướng dẫn nhanh",
    step1: "Mở <code>flow.google.com</code> và đăng nhập Google Flow.",
    step2: "Khởi động Flow MCP trên máy này, rồi bấm nút kết nối MCP local bên trên.",
    step3: "MCP cho AI chạy riêng trên máy này; nghiệp vụ Flow của extension không đi qua backend.",
    useLocal: "Kết nối MCP local (127.0.0.1:18899)",
    localConnected: "Đã kết nối extension với MCP local.",
    saving: "Đang kết nối…",
    connectFailed: "Chưa kết nối được MCP cục bộ. Hãy khởi động Flow MCP trên máy này.",
  },
  en: {
    pageTitle: "Flow MCP Connector Settings",
    title: "Flow MCP Connector Settings",
    subtitle: "Flow runs directly in the extension; the local MCP runs separately on this computer.",
    cardTitle: "Connection",
    guideTitle: "Quick Guide",
    step1: "Open <code>flow.google.com</code> and sign in to Google Flow.",
    step2: "Start Flow MCP on this computer, then use the local MCP connect button above.",
    step3: "The AI MCP runs separately on this computer; extension Flow work does not pass through the backend.",
    useLocal: "Connect local MCP (127.0.0.1:18899)",
    localConnected: "The extension is connected to the local MCP.",
    saving: "Connecting…",
    connectFailed: "Could not connect to the local MCP. Start Flow MCP on this computer.",
  },
};

let currentLang = "vi";
const statusMsg = document.querySelector("#status");

function t(key) {
  return I18N[currentLang]?.[key] || I18N.vi[key] || key;
}

function applyLanguage() {
  document.documentElement.lang = currentLang;
  document.title = t("pageTitle");
  document.querySelector("#txtTitle").textContent = t("title");
  document.querySelector("#txtSubtitle").textContent = t("subtitle");
  document.querySelector("#txtCardTitle").textContent = t("cardTitle");
  document.querySelector("#txtUseLocal").textContent = t("useLocal");
  document.querySelector("#txtGuideTitle").textContent = t("guideTitle");
  document.querySelector("#step1").innerHTML = t("step1");
  document.querySelector("#step2").innerHTML = t("step2");
  document.querySelector("#step3").innerHTML = t("step3");
  document.querySelector("#langVi").classList.toggle("active", currentLang === "vi");
  document.querySelector("#langEn").classList.toggle("active", currentLang === "en");
}

chrome.storage.local.get({ lang: "vi" }).then((stored) => {
  currentLang = stored.lang === "en" ? "en" : "vi";
  applyLanguage();
});

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

document.querySelector("#useLocal").addEventListener("click", async () => {
  const button = document.querySelector("#useLocal");
  button.disabled = true;
  statusMsg.className = "status-msg show";
  statusMsg.textContent = t("saving");

  try {
    await chrome.storage.local.set({ backendMode: "local", bridge: LOCAL_MCP_ORIGIN });
    await chrome.runtime.sendMessage({ type: "flow-mcp:connect" });

    let connectionStatus;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      connectionStatus = await chrome.runtime.sendMessage({ type: "flow-mcp:status" });
      if (connectionStatus?.connected) break;
      if (connectionStatus?.error && attempt >= 3) throw new Error(connectionStatus.error);
    }
    if (!connectionStatus?.connected) throw new Error(connectionStatus?.error || t("connectFailed"));

    statusMsg.className = "status-msg success show";
    statusMsg.textContent = t("localConnected");
  } catch (error) {
    statusMsg.className = "status-msg error show";
    statusMsg.textContent = error?.message || String(error);
  } finally {
    button.disabled = false;
    setTimeout(() => statusMsg.classList.remove("show"), 8000);
  }
});
