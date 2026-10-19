function visible(el) {
  const r = el.getBoundingClientRect();
  const s = getComputedStyle(el);
  return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
}
function accessibleName(el) {
  const labels = el.labels ? [...el.labels].map(l => l.innerText).join(" ") : "";
  const labelledBy = (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean).map(id => document.getElementById(id)?.innerText || document.getElementById(id)?.textContent || "").join(" ").trim();
  return el.getAttribute("aria-label") || labelledBy || el.getAttribute("title") || el.getAttribute("alt") || labels || el.getAttribute("placeholder") || el.innerText || el.textContent || "";
}
function matchesName(value, expected, regex, exact) {
  if (regex?.__regexp || regex?.source) { try { return new RegExp(regex.source, regex.flags).test(value); } catch {} }
  return expected === undefined || (exact ? value === expected : value.toLowerCase().includes(String(expected).toLowerCase()));
}
function select(root, spec) {
  let nodes = [...root.querySelectorAll(spec.css || "*")];
  if (spec.role) nodes = nodes.filter(e => {
    const implicit={BUTTON:"button",A:"link",OPTION:"option",SELECT:"combobox",TEXTAREA:"textbox",NAV:"navigation",IMG:"img",DIALOG:"dialog",H1:"heading",H2:"heading",H3:"heading",H4:"heading",H5:"heading",H6:"heading"};
    const role=e.getAttribute("role") || (e.tagName==="INPUT" ? (e.type==="radio"?"radio":e.type==="checkbox"?"checkbox":"textbox") : (e.isContentEditable?"textbox":implicit[e.tagName]));
    return role===spec.role && matchesName(accessibleName(e),spec.name,spec.regex,spec.exact);
  });
  if (spec.label !== undefined) nodes = nodes.filter(e => { const id=e.id; return [...document.querySelectorAll("label")].some(l => (id && l.htmlFor===id || l.contains(e)) && matchesName(l.innerText.trim(), spec.name, spec.regex, spec.exact)); });
  if (spec.placeholder !== undefined) nodes = nodes.filter(e => matchesName(e.getAttribute("placeholder") || "", spec.name, spec.regex, spec.exact));
  if (spec.text !== undefined) nodes = nodes.filter(e => matchesName((e.innerText || e.textContent || "").trim(), spec.text, spec.regex, spec.exact));
  if (spec.hasText !== undefined) nodes = nodes.filter(e => new RegExp(spec.hasText.source, spec.hasText.flags).test(e.innerText || e.textContent || ""));
  if (spec.has) nodes = nodes.filter(e => select(e, spec.has).length > 0);
  if (spec.visible) nodes = nodes.filter(visible);
  if (spec.index !== undefined) { const i = spec.index < 0 ? nodes.length + spec.index : spec.index; return nodes[i] ? [nodes[i]] : []; }
  return nodes;
}
function resolve(spec) {
  let root = document;
  for (const step of spec.chain || []) {
    const found = select(root, step);
    root = found[step.index ?? 0];
    if (!root) return [];
  }
  return select(root, spec.query || {});
}
function mediaId(tile) {
  const media = tile.querySelector("img[data-media-id], video[data-media-id], img[src], video[src]");
  const id = media && (media.getAttribute("data-media-id") || media.getAttribute("src")?.match(/[0-9a-f]{8}-[0-9a-f-]{27}/)?.[0]);
  if (id) return id;
  const title = tile.getAttribute("aria-label");
  return title ? `title:${title}` : undefined;
}
function evaluateKnown(name, args) {
  if (name === "documentLang") return document.documentElement.lang;
  if (name === "scrollTop") { document.querySelectorAll(".page-container").forEach(e => e.scrollTop = 0); return undefined; }
  if (name === "mediaIds") return [...document.querySelectorAll("flow-grid-tile-container")].map(mediaId).filter(Boolean);
  if (name === "newErrorCount") {
    const seen = new Set(args[0]); let errors = 0;
    for (const tile of document.querySelectorAll("flow-grid-tile-container")) {
      const id = mediaId(tile); if (id && seen.has(id)) break;
      if (tile.querySelector("flow-error-tile")) errors++;
    }
    return errors;
  }
  if (name === "retryErrorState") {
    const seen = new Set(args[0]);
    for (const tile of document.querySelectorAll("flow-grid-tile-container")) {
      const id = mediaId(tile), title = tile.getAttribute("aria-label");
      if ((id && seen.has(id)) || (title && seen.has(title))) return "known";
      if (tile.querySelector("flow-error-tile")) return "error";
    }
    return "none";
  }
  if (name === "scrollPage") {
    const el = document.querySelector(".page-container"); if (!el) return false;
    const top = el.scrollTop; el.scrollTop = top + el.clientHeight * 0.8; return el.scrollTop > top;
  }
  if (name === "freshMedia") return [...document.querySelectorAll("flow-grid-tile-container")].map(t => ({
    id: mediaId(t), kind: t.querySelector("flow-video-tile") ? "video" : t.querySelector("flow-image-tile") ? "image" : "other",
    label: t.getAttribute("aria-label") ?? "",
    busy: /\d+%/.test(t.innerText) || (!!t.querySelector("flow-video-tile") && !t.querySelector('img[alt="Generated video thumbnail"], video')),
  }));
  if (name === "progressPercentages") return [...document.querySelectorAll("flow-grid-tile-container")].slice(0, 8).map(t => t.innerText.match(/\d+%/)?.[0]).filter(Boolean);
  if (name === "gridBatch") return [...document.querySelectorAll("flow-grid-tile-container")].map(t => ({
    name: t.getAttribute("aria-label") ?? "",
    kind: t.querySelector("flow-scene-tile") ? "scene" : t.querySelector("flow-video-tile") ? "video" : "image",
    id: mediaId(t),
  }));
  if (name === "characterNames") return [...document.querySelectorAll("flow-character-tile")].map(t => t.innerText.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (name === "titledMediaIds") return [...document.querySelectorAll("flow-grid-tile-container")].filter(t => t.getAttribute("aria-label") === args[1]).map(t => mediaId(t) ?? "");
  if (name === "blurSideMenu") { const focused = document.activeElement; if (focused?.closest("mat-sidenav")) focused.blur(); return undefined; }
  if (name === "agentQuestion") return /Would you like to|which you prefer|I2V|R2V/i.test(document.body.innerText);
  if (name === "bodyHasProgress") return /\d{1,3}%/.test(document.body.innerText);
  if (name === "menuItemTexts") return args[0].map(m => (m.textContent ?? "").replace(/\s+/g, " ").trim());
  throw new Error(`Unsupported CSP-safe page operation: ${name}`);
}
let uploadFile;
async function execute(c) {
  const args = c.args || [];
  if (c.op === "evaluate") return evaluateKnown(c.evaluator, args);
  if (c.op === "evaluateElement" || c.op === "evaluateAll") {
    const els = resolve(c.spec);
    if (c.op === "evaluateAll" && c.evaluator === "menuItemTexts") return evaluateKnown(c.evaluator, [els]);
    if (c.op === "evaluateElement" && c.evaluator === "menuItemTexts") return (els[0]?.textContent ?? "").replace(/\s+/g, " ").trim();
    throw new Error(`Unsupported CSP-safe locator operation: ${c.evaluator}`);
  }
  if (c.op === "page") {
    if (c.method === "url") return location.href;
    if (c.method === "goto") { location.href = c.value; return true; }
    if (c.method === "title") return document.title;
  }
  if (c.op === "key") {
    const target = document.activeElement || document.body;
    const value = String(c.value);
    if (c.method === "type") {
      if (target.isContentEditable) { document.execCommand("insertText", false, value); }
      else if ("value" in target) { const proto=target instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto,"value")?.set?.call(target,(target.value||"")+value); target.dispatchEvent(new InputEvent("input", {bubbles:true,inputType:"insertText",data:value})); }
      return true;
    }
    if (/^(ControlOrMeta|Control|Meta)\+a$/i.test(value)) {
      if (target.isContentEditable) document.execCommand("selectAll"); else if ("select" in target) target.select();
    } else if (value === "Delete" || value === "Backspace") {
      if (target.isContentEditable) document.execCommand("delete"); else if ("value" in target) { target.value=""; target.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"deleteContentBackward"})); }
    } else {
      const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }); target.dispatchEvent(event);
      if (value === "Enter") { const form=target.closest?.("form"); if(form) form.requestSubmit(); else if(target.matches?.("button,[role=button]")) target.click(); }
      if (value === "Escape" || value === "Enter") target.dispatchEvent(new KeyboardEvent("keyup", { key: value, bubbles: true }));
    }
    return true;
  }
  if (c.op === "mouse") { const e=document.elementFromPoint(c.x,c.y); if(c.method === "click") e?.dispatchEvent(new MouseEvent("click",{bubbles:true,clientX:c.x,clientY:c.y,view:window})); else e?.dispatchEvent(new MouseEvent("mouseover",{bubbles:true,clientX:c.x,clientY:c.y,view:window})); return true; }
  if (c.op === "setFile") {
    const input = [...document.querySelectorAll('input[type="file"]')].find(e => e.isConnected);
    if (!input) throw new Error("Flow's upload file input is not available. Try the upload again.");
    const binary=atob(c.data), bytes=new Uint8Array(binary.length); for(let i=0;i<binary.length;i++) bytes[i]=binary.charCodeAt(i);
    const file=new File([bytes],c.name,{type:({".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".webp":"image/webp",".mp4":"video/mp4",".mov":"video/quicktime",".mp3":"audio/mpeg",".wav":"audio/wav"}[c.mime]||"application/octet-stream")});
    const dt=new DataTransfer(); dt.items.add(file); input.files=dt.files; input.dispatchEvent(new Event("change",{bubbles:true})); input.dispatchEvent(new Event("input",{bubbles:true})); return true;
  }
  if (c.op === "locator") {
    const els = resolve(c.spec);
    if (c.method === "count") return els.length;
    if (c.method === "allInnerTexts") return els.map(e => e.innerText || e.textContent || "");
    if (c.method === "innerText") return els[0]?.innerText ?? "";
    if (c.method === "textContent") return els[0]?.textContent ?? null;
    if (c.method === "getAttribute") return els[0]?.getAttribute(c.value) ?? null;
    if (c.method === "isVisible") return Boolean(els[0] && visible(els[0]));
    if (c.method === "isEnabled") return Boolean(els[0] && !els[0].disabled && els[0].getAttribute("aria-disabled") !== "true");
    if (c.method === "isChecked") return Boolean(els[0]?.checked);
    if (c.method === "boundingBox") { const r = els[0]?.getBoundingClientRect(); return r ? { x:r.x, y:r.y, width:r.width, height:r.height } : null; }
    if (c.method === "waitFor") return Boolean(els.length);
    const el = els[0];
    if (!el) throw new Error("Locator resolved to no element");
    if (c.method === "click") {
      el.scrollIntoView({block:"center"});
      if (c.fileChooserArmed) { const input=document.querySelector('input[type="file"]'); if(!input) throw new Error("Flow's upload input is not available yet."); return true; }
      if (c.value?.button === "right") { el.dispatchEvent(new MouseEvent("contextmenu", {bubbles:true,cancelable:true,button:2,view:window})); return true; }
      el.click(); return true;
    }
    if (c.method === "hover") { const r=el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent("mouseover",{bubbles:true,clientX:r.x+r.width/2,clientY:r.y+r.height/2,view:window})); return true; }
    if (c.method === "fill" || c.method === "type") {
      el.focus();
      if (el.isContentEditable) { el.focus(); el.textContent = c.value; }
      else { const proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto,"value")?.set?.call(el,c.method === "fill"?c.value:(el.value||"")+c.value); }
      el.dispatchEvent(new InputEvent("input", { bubbles:true, inputType:"insertText", data:c.value }));
      el.dispatchEvent(new Event("change", { bubbles:true })); return true;
    }
    if (c.method === "press") { el.focus(); el.dispatchEvent(new KeyboardEvent("keydown", {key:c.value,bubbles:true})); if(c.value === "Enter" && el.form) el.form.requestSubmit(); return true; }
    if (c.method === "scrollIntoViewIfNeeded") { el.scrollIntoView({block:"center"}); return true; }
  }
  return null;
}
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type === "flow-mcp:file-start") { uploadFile={name:message.name,mime:message.mime,parts:[],size:0}; respond({ok:true}); return; }
  if (message?.type === "flow-mcp:file-chunk") { if(uploadFile){const part=new Uint8Array(message.data);uploadFile.parts.push(part);uploadFile.size+=part.length;} respond({ok:true}); return; }
  if (message?.type === "flow-mcp:file-end") {
    try {
      const input=document.querySelector('input[type="file"]'); if(!input||!uploadFile) throw new Error("Flow's upload input is not available.");
      const bytes=new Uint8Array(uploadFile.size); let offset=0; for(const part of uploadFile.parts){bytes.set(part,offset);offset+=part.length;}
      const file=new File([bytes],uploadFile.name,{type:({".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".webp":"image/webp",".mp4":"video/mp4",".mov":"video/quicktime",".mp3":"audio/mpeg",".wav":"audio/wav"}[uploadFile.mime]||"application/octet-stream")});
      const dt=new DataTransfer();dt.items.add(file);input.files=dt.files;input.dispatchEvent(new Event("change",{bubbles:true}));input.dispatchEvent(new Event("input",{bubbles:true}));uploadFile=undefined;respond({ok:true,value:true});
    } catch(error) { uploadFile=undefined;respond({ok:false,error:String(error?.message||error)}); }
    return;
  }
  if (message?.type !== "flow-mcp:execute") return;
  execute(message.command).then(result => respond({ ok:true, value:result }), error => respond({ ok:false, error:String(error?.message || error) }));
  return true;
});
