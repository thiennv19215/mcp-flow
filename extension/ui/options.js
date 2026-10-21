const BACKEND_ORIGIN = "https://mcp.shopcongngheso5.io.vn";
const LOCAL_BACKEND_ORIGIN = "http://127.0.0.1:18897";

const I18N = {
  vi: {
    pageTitle: "Cài đặt Flow MCP Connector",
    title: "Cài đặt Flow MCP Connector",
    subtitle: "Kết nối extension với MCP local hoặc VPS.",
    cardTitle: "Đăng nhập backend",
    txtHelp: `Máy chủ: ${BACKEND_ORIGIN}`,
    lblAccount: "Tài khoản",
    lblPassword: "Mật khẩu",
    txtPasswordHelp: "Mật khẩu do quản trị viên đặt. Extension chỉ lưu token thiết bị, không lưu mật khẩu.",
    btnSave: "Đăng nhập và kết nối",
    savedSuccess: "Đã đăng nhập và kết nối backend. Hãy mở hoặc tải lại tab Google Flow nếu cần.",
    guideTitle: "Hướng dẫn nhanh",
    step1: "Mở <code>flow.google.com</code> và đăng nhập Google Flow.",
    step2: "Nhập tài khoản và mật khẩu backend do quản trị viên cấp.",
    step3: "Chọn backend local hoặc đăng nhập VPS. Extension và MCP phải cùng kết nối một backend.",
    useLocal: "Dùng MCP local (127.0.0.1:18897)",
    localConnected: "Đã chuyển extension sang MCP local.",
    saving: "Đang đăng nhập…",
    credentialsRequired: "Nhập cả tài khoản và mật khẩu.",
    loginRequired: "Hãy đăng nhập tài khoản để kết nối extension này.",
    connectFailed: "Chưa kết nối được backend. Kiểm tra HTTPS trên VPS và phiên bản backend.",
    mcpTitle: "MCP kết nối trực tiếp tới VPS",
    mcpToken: "Token thiết bị là bí mật. Chỉ dán vào cấu hình MCP cá nhân của bạn.",
    tokenLabel: "Device token",
    configLabel: "Codex config (~/.codex/config.toml)",
  },
  en: {
    pageTitle: "Flow MCP Connector Settings",
    title: "Flow MCP Connector Settings",
    subtitle: "Connect the extension to the local MCP or the VPS.",
    cardTitle: "Backend Sign In",
    txtHelp: `Server: ${BACKEND_ORIGIN}`,
    lblAccount: "Account",
    lblPassword: "Password",
    txtPasswordHelp: "Your administrator sets this password. The extension stores a device token, never the password.",
    btnSave: "Sign in and connect",
    savedSuccess: "Signed in and connected. Open or refresh a Google Flow tab if needed.",
    guideTitle: "Quick Guide",
    step1: "Open <code>flow.google.com</code> and sign in to Google Flow.",
    step2: "Enter the backend account and password provided by your administrator.",
    step3: "Select the local backend or sign in to the VPS. The extension and MCP must use the same backend.",
    useLocal: "Use local MCP (127.0.0.1:18897)",
    localConnected: "The extension is now set to the local MCP.",
    saving: "Signing in…",
    credentialsRequired: "Enter both the account name and password.",
    loginRequired: "Sign in to connect this extension.",
    connectFailed: "Could not connect to the backend. Check VPS HTTPS and the deployed backend version.",
    mcpTitle: "Connect MCP directly to the VPS",
    mcpToken: "The device token is secret. Only paste it into your personal MCP configuration.",
    tokenLabel: "Device token",
    configLabel: "Codex config (~/.codex/config.toml)",
  },
};

let currentLang = "vi";
const accountInput = document.querySelector("#account");
const passwordInput = document.querySelector("#password");
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
  document.querySelector("#txtHelp").textContent = t("txtHelp");
  document.querySelector("#lblAccount").textContent = t("lblAccount");
  document.querySelector("#lblPassword").textContent = t("lblPassword");
  document.querySelector("#txtPasswordHelp").textContent = t("txtPasswordHelp");
  document.querySelector("#txtBtnSave").textContent = t("btnSave");
  document.querySelector("#txtUseLocal").textContent = t("useLocal");
  document.querySelector("#txtGuideTitle").textContent = t("guideTitle");
  document.querySelector("#step1").textContent = t("step1");
  document.querySelector("#step2").innerHTML = t("step2");
  document.querySelector("#step3").innerHTML = t("step3");
  document.querySelector("#mcpConfig summary").textContent = t("mcpTitle");
  document.querySelector("#mcpConfig .help-text").textContent = t("mcpToken");
  document.querySelector('label[for="deviceToken"]').textContent = t("tokenLabel");
  document.querySelector('label[for="mcpSnippet"]').textContent = t("configLabel");
  document.querySelector("#langVi").classList.toggle("active", currentLang === "vi");
  document.querySelector("#langEn").classList.toggle("active", currentLang === "en");
}

async function showMcpConfig(token, backendMode = "vps") {
  const section = document.querySelector("#mcpConfig");
  if (!token || backendMode !== "vps") { section.hidden = true; return; }
  section.hidden = false;
  document.querySelector("#deviceToken").value = token;
  document.querySelector("#mcpSnippet").value = `[mcp_servers.flow]\nurl = "${BACKEND_ORIGIN}/mcp"\nbearer_token_env_var = "FLOW_MCP_DEVICE_TOKEN"`;
}

chrome.storage.local.get({ lang: "vi", loginAccount: "", deviceToken: "" }).then((stored) => {
  currentLang = stored.lang === "en" ? "en" : "vi";
  accountInput.value = stored.loginAccount || "";
  void showMcpConfig(stored.deviceToken, stored.backendMode || "local");
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

document.querySelector("#save").addEventListener("click", async () => {
  const button = document.querySelector("#save");
  button.disabled = true;
  statusMsg.className = "status-msg show";
  statusMsg.textContent = t("saving");

  try {
    const account = accountInput.value.trim();
    const password = passwordInput.value;

    const existing = await chrome.storage.local.get([
      "loginAccount",
      "deviceToken",
      "deviceId",
      "tokenBridgeOrigin",
    ]);
    let token = existing.tokenBridgeOrigin === BACKEND_ORIGIN ? existing.deviceToken : "";

    const sameAccount = account && existing.loginAccount &&
      account.toLocaleLowerCase() === existing.loginAccount.toLocaleLowerCase();
    if (account && password) {
      const response = await fetch(`${BACKEND_ORIGIN}/api/device/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          account,
          password,
          device_name: "Chrome Flow Extension",
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || typeof result.device_token !== "string" || !result.device_token) {
        throw new Error(result.error || `Sign in failed (HTTP ${response.status}).`);
      }
      token = result.device_token;
      await chrome.storage.local.set({
        backendMode: "vps",
        bridge: BACKEND_ORIGIN,
        loginAccount: account,
        deviceToken: result.device_token,
        deviceId: result.device_id,
        tokenBridgeOrigin: BACKEND_ORIGIN,
      });
      passwordInput.value = "";
    } else if (account && sameAccount && token) {
      // Reuse this profile's saved device token for reconnects; never persist its password.
    } else if (!account && !password && token) {
      accountInput.value = existing.loginAccount || "";
    } else if (!token) {
      throw new Error(t("loginRequired"));
    } else {
      throw new Error(t("credentialsRequired"));
    }

    if (!token) throw new Error(t("loginRequired"));
    await chrome.storage.local.set({ backendMode: "vps", bridge: BACKEND_ORIGIN });
    await chrome.runtime.sendMessage({ type: "flow-mcp:connect" });

    let connectionStatus;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      connectionStatus = await chrome.runtime.sendMessage({ type: "flow-mcp:status" });
      if (connectionStatus?.connected) break;
      if (connectionStatus?.error && attempt >= 3) throw new Error(connectionStatus.error);
    }
    if (!connectionStatus?.connected) {
      throw new Error(connectionStatus?.error || t("connectFailed"));
    }

    await showMcpConfig(token, "vps");

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

document.querySelector("#useLocal").addEventListener("click", async () => {
  const button = document.querySelector("#useLocal");
  button.disabled = true;
  statusMsg.className = "status-msg show";
  statusMsg.textContent = t("saving");

  try {
    await chrome.storage.local.set({ backendMode: "local", bridge: LOCAL_BACKEND_ORIGIN });
    await chrome.runtime.sendMessage({ type: "flow-mcp:connect" });

    let connectionStatus;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      connectionStatus = await chrome.runtime.sendMessage({ type: "flow-mcp:status" });
      if (connectionStatus?.connected) break;
      if (connectionStatus?.error && attempt >= 3) throw new Error(connectionStatus.error);
    }
    if (!connectionStatus?.connected) throw new Error(connectionStatus?.error || "Local MCP did not accept the connection.");

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
