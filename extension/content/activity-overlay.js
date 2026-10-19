(() => {
  if (globalThis.__flowMcpActivityOverlay) return;
  globalThis.__flowMcpActivityOverlay = true;
  // Isolated shadow styles and pointer-events:none keep Flow's controls intact.
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important;display:block!important;";
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    :host { pointer-events: none; }
    .frame { position:fixed; inset:0; box-sizing:border-box; border-radius:9px; pointer-events:none;
      border:3px solid #c6ff00; opacity:0; transition:opacity 160ms ease-out;
      box-shadow:inset 0 0 7px 2px #b6ff0088, 0 0 7px 1px #c6ff00aa; }
    .frame.active { opacity:1; }
    .status { position:fixed; top:20px; left:50%; transform:translateX(-50%);
      display:flex; align-items:center; gap:10px; box-sizing:border-box;
      width:max-content; max-width:calc(100vw - 48px); padding:13px 20px;
      border:1px solid #a5a04d; border-radius:999px; background:rgba(32,34,36,.94);
      box-shadow:0 3px 16px #0005; color:#f5f5f5;
      font:600 13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;
      pointer-events:none; user-select:none; opacity:0; visibility:hidden;
      transition:opacity 160ms ease-out,visibility 160ms; }
    .frame.active + .status { opacity:1; visibility:visible; }
    .spinner { width:14px; height:14px; flex-shrink:0; border:2px solid #ffffff26;
      border-top-color:#bfff42; border-radius:50%; animation:spin 1s linear infinite; }
    @keyframes spin { to { transform:rotate(360deg); } }
    @media(prefers-reduced-motion:reduce) { .frame,.status { transition:none; } .spinner { animation:none; } }
  `;
  const frame = document.createElement("div");
  frame.className = "frame";
  const status = document.createElement("div");
  status.className = "status";
  const spinner = document.createElement("span");
  spinner.className = "spinner";
  const label = document.createElement("span");
  label.textContent = "Flow MCP đang thao tác · Tạm khóa thao tác trên trang · Có thể chuyển tab";
  try {
    chrome.storage.local.get({ lang: "vi" }).then(res => {
      if (res?.lang === "en") {
        label.textContent = "Flow MCP active · Page input paused · You can switch tabs";
      } else {
        label.textContent = "Flow MCP đang thao tác · Tạm khóa thao tác trên trang · Có thể chuyển tab";
      }
    }).catch(() => {});
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.lang) {
        label.textContent = changes.lang.newValue === "en"
          ? "Flow MCP active · Page input paused · You can switch tabs"
          : "Flow MCP đang thao tác · Tạm khóa thao tác trên trang · Có thể chuyển tab";
      }
    });
  } catch {}
  status.append(spinner, label);
  shadow.append(style, frame, status);
  document.documentElement.append(host);
  let previewUntil = 0;
  let locked = false;
  let lockDeadline = 0;
  let textInputUntil = 0;
  const allowedInput = [];
  const display = active => {
    locked = Boolean(active);
    lockDeadline = active ? Date.now() + 6000 : 0;
    frame.classList.toggle("active", locked || Date.now() < previewUntil);
  };
  // Both physical and CDP events are trusted. Match the timestamp stamped by
  // our worker rather than isTrusted, which would block Playwright as well.
  function guard(event) {
    if (!locked || Date.now() > lockDeadline || !event.isTrusted) return;
    if ((event.type === "beforeinput" || event.type === "input") && Date.now() < textInputUntil) return;
    const absoluteTime = performance.timeOrigin + event.timeStamp;
    if (allowedInput.some(item => Date.now() < item.expires && Math.abs(item.time - absoluteTime) < 2)) return;
    if (event.cancelable) event.preventDefault();
    event.stopImmediatePropagation();
  }
  for (const type of ["pointerdown", "pointerup", "pointermove", "pointerover", "pointerout",
    "mousedown", "mouseup", "mousemove", "mouseover", "mouseout", "click", "dblclick", "auxclick",
    "contextmenu", "wheel", "touchstart", "touchmove", "touchend", "keydown", "keyup", "keypress",
    "beforeinput", "input", "paste", "cut", "drop", "dragstart", "compositionstart", "compositionupdate", "compositionend"]) {
    window.addEventListener(type, guard, { capture:true, passive:false });
  }
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type === "flow-mcp:allow-input") {
      display(true);
      while (allowedInput.length && (allowedInput[0].expires < Date.now() || allowedInput.length >= 128)) allowedInput.shift();
      if (typeof message.timestamp === "number") allowedInput.push({ time:message.timestamp * 1000, expires:Date.now() + 3000 });
      // Text editing events follow an authorized key command or insertText;
      // the originating physical key/click/paste is still blocked separately.
      if (message.text) textInputUntil = Date.now() + 1000;
      respond({ ok:true });
      return;
    }
    if (message?.type === "flow-mcp:activity-preview") {
      previewUntil = Date.now() + 5000;
      display(locked);
      setTimeout(() => { void sync(); }, 5100);
    }
    if (message?.type === "flow-mcp:activity") display(message.active);
  });
  let checking = false;
  async function sync() {
    if (checking) return;
    checking = true;
    try { display((await chrome.runtime.sendMessage({ type: "flow-mcp:activity-state" }))?.active); }
    catch { display(false); allowedInput.length = 0; }
    finally { checking = false; }
  }
  // Also clears the border if the service worker is stopped or reloaded.
  let timer = setInterval(sync, 2000);
  window.addEventListener("pagehide", () => { clearInterval(timer); display(false); });
  window.addEventListener("pageshow", () => { clearInterval(timer); timer = setInterval(sync, 2000); void sync(); });
  void sync();
})();
