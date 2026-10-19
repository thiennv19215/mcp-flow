import { chromium, type Browser, type ConnectOverCDPTransport, type Page } from "playwright-core";
import type { WebSocket } from "ws";
import { ExtensionProtocolV2 } from "./vendor/playwright/cdpRelayV2.js";
import { VERSION } from "./vendor/playwright/protocol.js";

type Result = { ok: boolean; value?: unknown; error?: string };
type Pending = { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout };
type Connection = {
  ws: WebSocket; protocol: ExtensionProtocolV2; pending: Map<string, Pending>;
  ready: boolean; version?: string; nextId: number;
  tabId?: number; interactionEnabled?: boolean;
  transport?: ConnectOverCDPTransport; browser?: Browser; connecting?: Promise<Browser>;
};
let current: Connection | undefined;
let lastError: string | undefined;

export async function extensionDownloads(): Promise<Array<{ id: number; filename: string; state: string; error?: string; bytesReceived: number; totalBytes: number }>> {
  if (!current?.ready) throw new Error("Flow connector is offline.");
  return call(current, "flow.downloads.recent");
}

export function extensionConnected(): boolean { return Boolean(current?.ready && current.ws.readyState === 1); }
export function extensionStatus() {
  return { connected: extensionConnected(), transport: "websocket", protocol: VERSION, extension_version: current?.version, interaction_enabled: current?.interactionEnabled, error: lastError };
}

export async function setExtensionInteraction(enabled: boolean): Promise<void> {
  const connection = current;
  if (!connection?.browser?.isConnected() || connection.tabId === undefined) return;
  if (connection.interactionEnabled === enabled) return;
  await call(connection, "chrome.debugger.sendCommand", [{ tabId: connection.tabId }, "Emulation.setFocusEmulationEnabled", { enabled }]);
  connection.interactionEnabled = enabled;
}

function dispose(connection: Connection, reason: string): void {
  if (current !== connection) return;
  current = undefined;
  lastError = reason;
  connection.ready = false;
  connection.protocol.onExtensionDisconnect(reason);
  for (const pending of connection.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error(reason));
  }
  connection.pending.clear();
  connection.transport?.onclose?.(reason);
  if (connection.ws.readyState < 2) connection.ws.close(1000, reason.slice(0, 100));
}

function call(connection: Connection, method: string, args: unknown[] = []): Promise<any> {
  if (current !== connection || connection.ws.readyState !== 1) return Promise.reject(new Error("Flow extension disconnected. No command was sent."));
  const id = String(++connection.nextId);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      connection.pending.delete(id);
      const message = `Extension command ${method} timed out; its outcome is unknown. Check Flow before retrying a submit.`;
      reject(new Error(message));
      dispose(connection, message);
    }, 60_000);
    connection.pending.set(id, { resolve, reject, timer });
    try { connection.ws.send(JSON.stringify({ type: "command", id, method, args })); }
    catch (error) { dispose(connection, String(error)); }
  });
}

export function extensionSetWebSocket(ws: WebSocket): void {
  if (current) {
    ws.close(1008, "Another Flow connector is already connected");
    return;
  }
  const connection: Connection = { ws, protocol: undefined!, pending: new Map(), ready: false, nextId: 0 };
  connection.protocol = new ExtensionProtocolV2((method, args) => call(connection, method, args));
  current = connection;
  const initTimer = setTimeout(() => dispose(connection, "Extension handshake timed out. Reload Flow MCP Connector 0.4.0 or newer."), 10_000);
  ws.on("message", data => {
    if (current !== connection) return;
    try {
      const message = JSON.parse(data.toString());
      if (message.type === "ping") { ws.send(JSON.stringify({ type: "pong" })); return; }
      if (message.type === "result") {
        const item = connection.pending.get(String(message.id));
        if (!item) return;
        connection.pending.delete(String(message.id));
        clearTimeout(item.timer);
        const result = message.result as Result;
        if (result?.ok) item.resolve(result.value);
        else item.reject(new Error(result?.error || "Extension command failed"));
        return;
      }
      if (message.type !== "event" || !Array.isArray(message.params)) return;
      if (message.method === "chrome.tabs.onCreated") connection.tabId = message.params[0]?.id;
      if (message.method === "extension.initialized") {
        const info = message.params[0];
        if (info?.protocol !== VERSION) throw new Error("Incompatible connector protocol; reload Flow MCP Connector.");
        connection.version = info.version;
        connection.ready = true;
        lastError = undefined;
        clearTimeout(initTimer);
      }
      connection.protocol.handleExtensionEvent(message.method, message.params);
    } catch (error) { dispose(connection, `Invalid connector message: ${String(error)}`); }
  });
  ws.on("close", () => { clearTimeout(initTimer); dispose(connection, "Flow extension WebSocket disconnected. Reconnect before starting another operation."); });
  ws.on("error", error => { clearTimeout(initTimer); dispose(connection, `Flow extension socket error: ${error.message}`); });
}

async function connectBrowser(): Promise<Browser> {
  const connection = current;
  if (!connection) throw new Error("Flow MCP Connector is offline. Start this backend and reload the connector extension (0.4.0+) in Chrome.");
  if (connection.browser?.isConnected()) return connection.browser;
  if (connection.connecting) return connection.connecting;
  connection.connecting = (async () => {
    await connection.protocol.ready();
    if (current !== connection) throw new Error("Connector changed during initialization. Retry the read operation.");
    const protocol = connection.protocol;
    const transport: ConnectOverCDPTransport = {
      send(message: any) {
        const { id, sessionId, method, params } = message;
        // Commands may be in flight together. A Runtime promise must not block
        // delivery of the input/navigation command needed to settle it.
        void (async () => {
          if (method === "Browser.getVersion") return { protocolVersion: "1.3", product: "Chrome/Extension-Bridge", revision: "", userAgent: "CDP-Bridge-Server/1.0.0" };
          if (method === "Browser.setDownloadBehavior" || method === "Browser.close") return {};
          const handled = await protocol.handleCDPCommand(method, params, sessionId);
          return handled ? handled.result : protocol.forwardToExtension(method, params, sessionId);
        })().then(
          result => { if (current === connection) transport.onmessage?.({ id, sessionId, result: result ?? {} }); },
          error => { if (current === connection) transport.onmessage?.({ id, sessionId, error: { code: -32000, message: String(error?.message || error) } }); },
        );
      },
      close() { dispose(connection, "Playwright closed the extension connection"); },
    };
    connection.transport = transport;
    protocol.connectOverCDP(message => { if (current === connection) transport.onmessage?.(message); });
    try {
      // Match the original CDP driver: retain Playwright's focus emulation and
      // actionability defaults. Disabling them can stall RAF-based stability
      // checks when Studio has become the foreground tab.
      const browser = await chromium.connectOverCDP(transport, { isLocal: true, timeout: 30_000 });
      connection.browser = browser;
      await setExtensionInteraction(false);
      browser.on("disconnected", () => dispose(connection, "Playwright disconnected; the tab session must be initialized again."));
      return browser;
    } catch (error) {
      dispose(connection, String(error));
      throw error;
    }
  })();
  return connection.connecting;
}

export async function getExtensionPage(interactive = true): Promise<Page> {
  const browser = await connectBrowser();
  const pages = browser.contexts().flatMap(context => context.pages()).filter(page => !page.isClosed() && /^https:\/\/(flow\.google\.com|labs\.google\/fx)\//.test(page.url()));
  if (pages.length !== 1) throw new Error("Select one Flow tab using the connector popup, then reconnect. Flow MCP will not guess between projects.");
  const page = pages[0];
  // Selecting a Page is not a request to activate its Chrome tab. Studio polls
  // status repeatedly, including while generation is waiting. Focus emulation
  // supports background actions without taking the user's foreground tab.
  await page.waitForLoadState("domcontentloaded", { timeout: 30_000 });
  if (interactive) await setExtensionInteraction(true);
  return page;
}
