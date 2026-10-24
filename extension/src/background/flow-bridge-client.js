// flow-bridge-client.js
// Dedicated module managing the bidirectional transport between the Chrome Extension
// and the local Backend MCP / Studio server (WebSocket with HTTP long-polling fallback).

const LOCAL_BRIDGE = "http://127.0.0.1:18899";
const defaults = { bridge: LOCAL_BRIDGE };

export async function readBridgeConfig() {
  const stored = await chrome.storage.local.get(null);
  const desiredBridge = LOCAL_BRIDGE;
  if (stored.backendMode !== "local" || stored.bridge !== desiredBridge) {
    stored.backendMode = "local";
    stored.bridge = desiredBridge;
    await chrome.storage.local.set({ backendMode: "local", bridge: desiredBridge });
  }
  return { ...defaults, ...stored, backendMode: "local", bridge: desiredBridge };
}

export function bridgeUrl(value) {
  const url = new URL(value);
  const local = ["127.0.0.1", "localhost"].includes(url.hostname) && url.port === "18899" && url.protocol === "http:";
  if (url.username || url.password || url.search || url.hash || !local) {
    throw new Error("Use the local MCP at http://127.0.0.1:18899.");
  }
  return url;
}

export function endpoint(value, token) {
  const url = bridgeUrl(value);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws/bridge";
  url.search = "";
  if (token) url.searchParams.set("token", token);
  return url.href;
}

export async function fetchBackend(url, token, body, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    return await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal, cache: "no-store" });
  } finally { clearTimeout(timer); }
}

export async function postHttpMessage(session, path, body, options = {}) {
  let lastFailure;
  const retries = Math.max(1, Number(options.retries) || 3);
  const timeoutMs = Math.max(250, Number(options.timeoutMs) || 15_000);
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const response = await fetchBackend(`${session.bridge}${path}`, session.token, body, timeoutMs);
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        const error = new Error(detail.error || `Local MCP returned HTTP ${response.status}.`);
        error.status = response.status;
        if (response.status < 500 || attempt === 2) throw error;
        lastFailure = error;
      } else return { transport: "http-poll", httpStatus: response.status, body: await response.json().catch(() => ({})) };
    } catch (error) {
      lastFailure = error;
      if (error?.status && error.status < 500) throw error;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw lastFailure || new Error("Could not send a message to the local MCP host.");
}

export class FlowBridgeClient {
  constructor({ onCommand, onEvent, getSelectedTabId, getCapabilities }) {
    this.onCommand = onCommand;
    this.onEvent = onEvent;
    this.getSelectedTabId = getSelectedTabId;
    this.getCapabilities = getCapabilities;

    this.socket = null;
    this.httpSession = null;
    this.bridgeTransport = "disconnected";
    this.lastError = "";
    this.opening = false;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.heartbeat = null;
  }

  isConnected() {
    return this.bridgeTransport === "http-poll"
      ? Boolean(this.httpSession && !this.httpSession.stopped)
      : this.socket?.readyState === WebSocket.OPEN;
  }

  getStatus() {
    return {
      connected: this.isConnected(),
      transport: this.bridgeTransport,
      lastError: this.lastError,
    };
  }

  send(message) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  async sendEvent(method, params) {
    if (this.httpSession && !this.httpSession.stopped) {
      return postHttpMessage(this.httpSession, "/api/extension/progress", { ...params[0], method, session_id: this.httpSession.sessionId }, { timeoutMs: 2500, retries: 1 });
    }
    if (this.socket) {
      this.send({ type: "event", method, params });
      return { transport: "websocket", sent: this.socket.readyState === WebSocket.OPEN };
    }
    return { transport: "disconnected", sent: false };
  }

  stopHttpSession() {
    if (!this.httpSession) return;
    this.httpSession.stopped = true;
    this.httpSession.pollAbort?.abort();
    this.httpSession = null;
  }

  scheduleReconnect(delayMs) {
    if (this.reconnectTimer) return;
    const backoff = Math.min(1500 * (2 ** this.reconnectAttempt++), 30_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delayMs ?? backoff);
  }

  disconnect(reason = "User reconnect") {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    this.stopHttpSession();
    this.bridgeTransport = "disconnected";
    const prevSocket = this.socket;
    this.socket = null;
    if (prevSocket) prevSocket.close(1000, reason);
  }

  applyBackendEvent(message) {
    this.onEvent?.(message);
  }

  dispatchCommand(command, sendResult) {
    const commandId = command.id ?? command.request_id ?? command.requestId;
    if (commandId === undefined || commandId === null) throw new Error("Command is missing request id");
    if (!this.onCommand) throw new Error("No command handler registered");
    void this.onCommand(command).then(
      value => sendResult({ type: "result", id: commandId, result: { ok: true, value } }),
      error => sendResult({
        type: "result",
        id: commandId,
        result: {
          ok: false,
          error: {
            code: error?.code || "EXTENSION_COMMAND_FAILED",
            message: String(error?.message || error),
            retryable: Boolean(error?.retryable),
            outcome_unknown: Boolean(error?.outcome_unknown),
            noRetry: error?.noRetry === true,
            noReplay: error?.noReplay === true,
            ...(error?.diagnostics ? { diagnostics: error.diagnostics } : {}),
          },
        },
      }),
    );
  }

  async pollHttp(session) {
    while (this.httpSession === session && !session.stopped) {
      const controller = new AbortController();
      session.pollAbort = controller;
      const timer = setTimeout(() => controller.abort(), 35_000);
      try {
        const headers = { "content-type": "application/json" };
        if (session.token) headers.authorization = `Bearer ${session.token}`;
        const response = await fetch(`${session.bridge}/api/extension/poll`, {
          method: "POST", headers, body: JSON.stringify({ wait_ms: 20_000, session_id: session.sessionId }), signal: controller.signal, cache: "no-store",
        });
        if (!response.ok) {
          const detail = await response.json().catch(() => ({}));
          throw new Error(detail.error || `Backend polling failed (HTTP ${response.status}).`);
        }
        const payload = await response.json();
        const message = payload?.message;
        if (message?.type === "event") this.applyBackendEvent(message);
        else if (message?.type === "command") this.dispatchCommand(message, result => {
          void postHttpMessage(session, "/api/extension/result", { id: String(result.id), result: result.result, session_id: session.sessionId }).catch(error => {
            if (this.httpSession === session) this.lastError = `Command result could not reach the local MCP host: ${String(error?.message || error)}`;
          });
        });
      } finally {
        clearTimeout(timer);
        if (session.pollAbort === controller) session.pollAbort = null;
      }
    }
  }

  async connectHttp(settings, token) {
    const bridge = new URL(settings.bridge).origin;
    const capabilities = this.getCapabilities ? this.getCapabilities() : [];
    const response = await fetchBackend(`${bridge}/api/extension/connect`, token, {
      protocol: 3,
      version: chrome.runtime.getManifest().version,
      capabilities,
    });
    if (response.status === 404 || response.status === 405) return false;
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      if (response.status === 401 && detail.error === "Missing or wrong token.") return false;
      throw new Error(detail.error || `Backend connection failed (HTTP ${response.status}).`);
    }
    const connection = await response.json().catch(() => ({}));
    if (typeof connection.session_id !== "string" || !connection.session_id) throw new Error("Local MCP did not return a connector session. Update the local MCP and try again.");
    const session = { bridge, token, sessionId: connection.session_id, stopped: false, pollAbort: null };
    this.httpSession = session;
    this.bridgeTransport = "http-poll";
    this.reconnectAttempt = 0;
    this.lastError = "";
    void this.pollHttp(session).catch(error => {
      if (this.httpSession !== session || session.stopped) return;
      this.stopHttpSession();
      this.bridgeTransport = "disconnected";
      this.lastError = `HTTPS polling disconnected: ${String(error?.message || error)}`;
      this.scheduleReconnect();
    });
    return true;
  }

  async connect() {
    if (this.opening || this.isConnected() || this.socket?.readyState === WebSocket.CONNECTING) return;
    this.opening = true;
    this.lastError = "";
    let backendOrigin = "";
    try {
      const settings = await readBridgeConfig();
      backendOrigin = new URL(settings.bridge).origin;
      // The backend server token the user saved once on the options page
      // (chrome.storage.local key "serverToken"). Empty means "not saved":
      // HTTP connect then 401s and the client falls back to WebSocket, the
      // pre-D5 behaviour. The same token is also passed to the WebSocket
      // endpoint, so WS auth works when FLOW_MCP_WS_TOKEN is set.
      const token = typeof settings.serverToken === "string" ? settings.serverToken : "";
      this.stopHttpSession();
      const httpConnected = await this.connectHttp(settings, token);
      if (httpConnected) return;

      const ws = new WebSocket(endpoint(settings.bridge, token));
      this.socket = ws;
      ws.onopen = () => {
        if (this.socket !== ws) return;
        this.bridgeTransport = "websocket";
        this.reconnectAttempt = 0;
        this.lastError = "";
        const capabilities = this.getCapabilities ? this.getCapabilities() : [];
        this.send({ type: "event", method: "extension.initialized", params: [{ protocol: 2, version: chrome.runtime.getManifest().version, capabilities }] });
        this.heartbeat = setInterval(() => {
          this.send({ type: "ping" });
          const selectedId = this.getSelectedTabId?.();
          if (selectedId) chrome.tabs.get(selectedId).catch(() => {});
        }, 20_000);
      };
      ws.onmessage = message => {
        if (this.socket !== ws) return;
        let command;
        try { command = JSON.parse(message.data); } catch { ws.close(1002, "Invalid JSON"); return; }
        if (command.type === "event") { this.applyBackendEvent(command); return; }
        if (command.type !== "command") return;
        try { this.dispatchCommand(command, result => this.send(result)); }
        catch (error) { ws.close(1002, String(error?.message || error)); }
      };
      ws.onclose = close => {
        if (this.socket !== ws) return;
        this.socket = null;
        this.bridgeTransport = "disconnected";
        if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
        const intentionalClose = ["User reconnect", "Bridge URL changed"].includes(close.reason);
        this.lastError = intentionalClose ? "" : close.reason || this.lastError || "Backend disconnected";
        this.scheduleReconnect(close.code === 1008 ? 10_000 : undefined);
      };
      ws.onerror = () => {
        this.bridgeTransport = "disconnected";
        this.lastError = `Cannot connect to the local MCP at ${new URL(settings.bridge).origin}. Start it if you need AI access.`;
        ws.close();
      };
    } catch (error) {
      this.bridgeTransport = "disconnected";
      this.lastError = `Cannot connect to the local MCP${backendOrigin ? ` at ${backendOrigin}` : ""}: ${String(error?.message || error)}`;
      this.scheduleReconnect();
    } finally {
      this.opening = false;
    }
  }
}
