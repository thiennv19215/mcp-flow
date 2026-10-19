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
  let submitPermit = null;
  const display = active => {
    locked = Boolean(active);
    lockDeadline = active ? Date.now() + 6000 : 0;
    frame.classList.toggle("active", locked || Date.now() < previewUntil);
  };
  // Pause direct user input while the content driver owns the Flow page.
  function submitButtonName(button) {
    const labelledBy = (button.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean)
      .map(id => document.getElementById(id)?.innerText || document.getElementById(id)?.textContent || "").join(" ").trim();
    const labels = button.labels ? [...button.labels].map(label => label.innerText || label.textContent || "").join(" ").trim() : "";
    const explicit = button.getAttribute("aria-label") || labelledBy || button.getAttribute("title") || labels || button.getAttribute("alt");
    if (explicit) return explicit.replace(/\s+/g, " ").trim();
    const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
    const text = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.parentElement?.closest('[aria-hidden="true"]')) continue;
      text.push(node.nodeValue || "");
    }
    return text.join(" ").replace(/\s+/g, " ").trim();
  }
  function allowSubmitEvent(event) {
    const permit = submitPermit;
    if (!permit) return false;
    if (Date.now() > permit.expiresAt) { submitPermit = null; return false; }
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY) ||
        Math.abs(event.clientX - permit.x) > 3 || Math.abs(event.clientY - permit.y) > 3) return false;
    const target = event.target instanceof Element ? event.target : null;
    const button = target?.closest('button,[role="button"]');
    const hit = document.elementFromPoint(permit.x, permit.y);
    const hitButton = hit instanceof Element ? hit.closest('button,[role="button"]') : null;
    if (!button || button !== hitButton || submitButtonName(button) !== permit.label) return false;
    const type = event.type;
    if (["pointerover", "pointermove", "mouseover", "mousemove"].includes(type)) return true;
    if (type === "pointerdown" || type === "mousedown") {
      permit.pressed = true;
      return true;
    }
    if (type === "pointerup" || type === "mouseup") return permit.pressed;
    if (type === "click" && permit.pressed) {
      submitPermit = null;
      return true;
    }
    return false;
  }
  function guard(event) {
    if (!locked || Date.now() > lockDeadline || !event.isTrusted) return;
    if (allowSubmitEvent(event)) return;
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
    if (message?.type === "flow-mcp:permit-submit-click") {
      const x = Number(message.x), y = Number(message.y);
      if (typeof message.requestId !== "string" || !message.requestId || message.label !== "Start generation" ||
          !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) {
        respond({ ok: false });
        return;
      }
      const hit = document.elementFromPoint(x, y);
      const button = hit instanceof Element ? hit.closest('button,[role="button"]') : null;
      const expectedPrompt = String(message.prompt || "").replace(/[\u200B\u200C\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim();
      let composer = button?.parentElement;
      while (composer && composer !== document.body && !composer.querySelector(".ProseMirror[contenteditable='true']")) composer = composer.parentElement;
      const editor = composer?.querySelector(".ProseMirror[contenteditable='true']");
      const currentPrompt = String(editor?.innerText || editor?.textContent || "").replace(/[\u200B\u200C\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim();
      const rect = button?.getBoundingClientRect();
      if (!button || button.disabled || button.getAttribute("aria-disabled") === "true" ||
          submitButtonName(button) !== message.label || !expectedPrompt || !currentPrompt.endsWith(expectedPrompt) ||
          !rect || rect.width < 8 || rect.height < 8 || x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
        respond({ ok: false });
        return;
      }
      submitPermit = { requestId: message.requestId, x, y, label: message.label, expiresAt: Date.now() + 1800, pressed: false };
      respond({ ok: true });
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
    catch { display(false); }
    finally { checking = false; }
  }
  // Also clears the border if the service worker is stopped or reloaded.
  let timer = setInterval(sync, 2000);
  window.addEventListener("pagehide", () => { clearInterval(timer); display(false); });
  window.addEventListener("pageshow", () => { clearInterval(timer); timer = setInterval(sync, 2000); void sync(); });
  void sync();
})();
