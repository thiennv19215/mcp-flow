const AUTH_ORIGIN = "https://mcp.shopcongngheso5.io.vn";
const LOCAL_MCP_ORIGIN = "http://127.0.0.1:18899";

const I18N = {
  vi: {
    pageTitle: "Cài đặt Flow MCP Connector",
    title: "Cài đặt Flow MCP Connector",
    subtitle: "Flow chạy trực tiếp trong extension; tài khoản được xác thực riêng.",
    cardTitle: "Xác thực tài khoản",
    txtHelp: `Máy chủ xác thực: ${AUTH_ORIGIN}`,
    lblAccount: "Tài khoản",
    lblPassword: "Mật khẩu",
    txtPasswordHelp: "Mật khẩu do quản trị viên đặt. Extension chỉ lưu token thiết bị, không lưu mật khẩu.",
    btnSave: "Xác thực tài khoản",
    savedSuccess: "Tài khoản đã được xác thực. MCP local có thể chạy riêng khi bạn cần dùng AI.",
    guideTitle: "Hướng dẫn nhanh",
    step1: "Mở <code>flow.google.com</code> và đăng nhập Google Flow.",
    step2: "Nhập tài khoản và mật khẩu backend do quản trị viên cấp.",
    step3: "MCP cho AI chạy riêng trên máy này; nghiệp vụ Flow của extension không đi qua backend.",
    useLocal: "Dùng MCP local (127.0.0.1:18899)",
    localConnected: "Đã chuyển extension sang MCP local.",
    saving: "Đang đăng nhập…",
    credentialsRequired: "Nhập cả tài khoản và mật khẩu.",
    loginRequired: "Hãy đăng nhập tài khoản để xác thực extension này.",
    connectFailed: "Chưa kết nối được MCP cục bộ. Hãy khởi động Flow MCP trên máy này.",
  },
  en: {
    pageTitle: "Flow MCP Connector Settings",
    title: "Flow MCP Connector Settings",
    subtitle: "Flow runs directly in the extension; account verification stays separate.",
    cardTitle: "Account Verification",
    txtHelp: `Authentication server: ${AUTH_ORIGIN}`,
    lblAccount: "Account",
    lblPassword: "Password",
    txtPasswordHelp: "Your administrator sets this password. The extension stores a device token, never the password.",
    btnSave: "Verify account",
    savedSuccess: "Account verified. The local MCP can run separately when you need AI access.",
    guideTitle: "Quick Guide",
    step1: "Open <code>flow.google.com</code> and sign in to Google Flow.",
    step2: "Enter the backend account and password provided by your administrator.",
    step3: "The AI MCP runs separately on this computer; extension Flow work does not pass through the backend.",
    useLocal: "Use local MCP (127.0.0.1:18899)",
    localConnected: "The extension is now set to the local MCP.",
    saving: "Signing in…",
    credentialsRequired: "Enter both the account name and password.",
    loginRequired: "Sign in to verify this extension.",
    connectFailed: "Could not connect to the local MCP. Start Flow MCP on this computer.",
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
  document.querySelector("#langVi").classList.toggle("active", currentLang === "vi");
  document.querySelector("#langEn").classList.toggle("active", currentLang === "en");
}

chrome.storage.local.get({ lang: "vi", loginAccount: "", deviceToken: "" }).then((stored) => {
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
    let token = existing.tokenBridgeOrigin === AUTH_ORIGIN ? existing.deviceToken : "";

    const sameAccount = account && existing.loginAccount &&
      account.toLocaleLowerCase() === existing.loginAccount.toLocaleLowerCase();
    if (account && password) {
      const response = await fetch(`${AUTH_ORIGIN}/api/device/login`, {
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
        backendMode: "local",
        bridge: LOCAL_MCP_ORIGIN,
        loginAccount: account,
        deviceToken: result.device_token,
        deviceId: result.device_id,
        tokenBridgeOrigin: AUTH_ORIGIN,
      });
      passwordInput.value = "";
    } else if (account && sameAccount && token) {
      // Verify the saved device token below without storing the password.
    } else if (!account && !password && token) {
      accountInput.value = existing.loginAccount || "";
    } else if (!token) {
      throw new Error(t("loginRequired"));
    } else {
      throw new Error(t("credentialsRequired"));
    }

    if (!password && token) {
      const response = await fetch(`${AUTH_ORIGIN}/api/user/me`, {
        headers: { authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      const profile = await response.json().catch(() => ({}));
      if (!response.ok || profile.device_id !== existing.deviceId) {
        throw new Error(profile.error || "This device sign-in has expired or been revoked. Sign in again.");
      }
    }
    if (!token) throw new Error(t("loginRequired"));
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
    await chrome.storage.local.set({ backendMode: "local", bridge: LOCAL_MCP_ORIGIN });
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
