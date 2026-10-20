const BACKEND_ORIGIN = "https://mcp.shopcongngheso5.io.vn";

const I18N = {
  vi: {
    pageTitle: "Cài đặt Flow MCP Connector",
    title: "Cài đặt Flow MCP Connector",
    subtitle: "Đăng nhập extension vào backend Flow MCP.",
    cardTitle: "Đăng nhập backend",
    txtHelp: `Máy chủ: ${BACKEND_ORIGIN}`,
    lblAccount: "Tài khoản",
    lblPassword: "Mật khẩu",
    txtPasswordHelp: "Mật khẩu do quản trị viên đặt. Extension chỉ lưu token thiết bị, không lưu mật khẩu.",
    btnSave: "Đăng nhập và kết nối",
    savedSuccess: "Đã đăng nhập và kết nối backend. Hãy mở hoặc tải lại tab Google Flow nếu cần.",
    guideTitle: "Hướng dẫn nhanh",
    step1: "Nhập tài khoản và mật khẩu do quản trị viên cấp.",
    step2: "Mở <code>flow.google.com</code> và đăng nhập Google Flow.",
    step3: "Bấm <b>Đăng nhập và kết nối</b> để bắt đầu.",
    saving: "Đang đăng nhập…",
    credentialsRequired: "Nhập cả tài khoản và mật khẩu.",
    loginRequired: "Hãy đăng nhập tài khoản để kết nối extension này.",
    connectFailed: "Chưa kết nối được backend. Kiểm tra trạng thái WSS trên VPS.",
  },
  en: {
    pageTitle: "Flow MCP Connector Settings",
    title: "Flow MCP Connector Settings",
    subtitle: "Sign in to the Flow MCP backend.",
    cardTitle: "Backend Sign In",
    txtHelp: `Server: ${BACKEND_ORIGIN}`,
    lblAccount: "Account",
    lblPassword: "Password",
    txtPasswordHelp: "Your administrator sets this password. The extension stores a device token, never the password.",
    btnSave: "Sign in and connect",
    savedSuccess: "Signed in and connected. Open or refresh a Google Flow tab if needed.",
    guideTitle: "Quick Guide",
    step1: "Enter the account name and password provided by your administrator.",
    step2: "Open <code>flow.google.com</code> and sign in to Google Flow.",
    step3: "Select <b>Sign in and connect</b> to continue.",
    saving: "Signing in…",
    credentialsRequired: "Enter both the account name and password.",
    loginRequired: "Sign in to connect this extension.",
    connectFailed: "Could not connect to the backend. Check the VPS WSS status.",
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
  document.querySelector("#txtGuideTitle").textContent = t("guideTitle");
  document.querySelector("#step1").textContent = t("step1");
  document.querySelector("#step2").innerHTML = t("step2");
  document.querySelector("#step3").innerHTML = t("step3");
  document.querySelector("#langVi").classList.toggle("active", currentLang === "vi");
  document.querySelector("#langEn").classList.toggle("active", currentLang === "en");
}

chrome.storage.local.get({ lang: "vi", loginAccount: "" }).then((stored) => {
  currentLang = stored.lang === "en" ? "en" : "vi";
  accountInput.value = stored.loginAccount || "";
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
    await chrome.storage.local.set({ bridge: BACKEND_ORIGIN });
    await chrome.runtime.sendMessage({ type: "flow-mcp:connect" });

    let connectionStatus;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      connectionStatus = await chrome.runtime.sendMessage({ type: "flow-mcp:status" });
      if (connectionStatus?.wsConnected) break;
      if (connectionStatus?.error && attempt >= 3) throw new Error(connectionStatus.error);
    }
    if (!connectionStatus?.wsConnected) {
      throw new Error(connectionStatus?.error || t("connectFailed"));
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
