import type { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

type ExtensionError = { code?: string; message?: string; retryable?: boolean; outcome_unknown?: boolean; diagnostics?: unknown };
type ExtensionResult = { ok: boolean; value?: unknown; error?: string | ExtensionError };
type OutboundMessage =
  | { type: "command"; id: string; method: string; args: unknown[]; timeout_ms: number }
  | { type: "event"; method: string; params: unknown[] };
type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout; delivered: boolean };
type PollWaiter = { resolve(message: OutboundMessage | null): void; timer: NodeJS.Timeout };
export type Connection = {
  deviceId: string;
  sessionId: string;
  transport: "websocket" | "http-poll";
  ws?: WebSocket;
  pending: Map<string, Pending>;
  ready: boolean;
  version?: string;
  capabilities: string[];
  nextId: number;
  outbound: OutboundMessage[];
  pollWaiters: Set<PollWaiter>;
  lastSeen: number;
};

const connections = new Map<string, Connection>();
const lastErrors = new Map<string, string>();
const events = new EventEmitter();
const initListeners: ((connection: Connection) => void)[] = [];
const HTTP_POLL_STALE_MS = 90_000;

function isConnected(connection: Connection | undefined): connection is Connection {
  if (!connection?.ready) return false;
  return connection.transport === "websocket"
    ? connection.ws?.readyState === 1
    : Date.now() - connection.lastSeen < HTTP_POLL_STALE_MS;
}

export function onExtensionInitialized(listener: (connection: Connection) => void): () => void {
  initListeners.push(listener);
  return () => {
    const idx = initListeners.indexOf(listener);
    if (idx >= 0) initListeners.splice(idx, 1);
  };
}

function wakePoller(connection: Connection): void {
  while (connection.outbound.length && connection.pollWaiters.size) {
    const waiter = connection.pollWaiters.values().next().value as PollWaiter | undefined;
    if (!waiter) return;
    connection.pollWaiters.delete(waiter);
    clearTimeout(waiter.timer);
    const message = connection.outbound.shift()!;
    if (message.type === "command") {
      const pending = connection.pending.get(message.id);
      if (pending) pending.delivered = true;
    }
    waiter.resolve(message);
  }
}

function enqueue(connection: Connection, message: OutboundMessage): void {
  if (connections.get(connection.deviceId) !== connection || !connection.ready) return;
  if (connection.transport === "websocket") {
    if (connection.ws?.readyState !== 1) return;
    try {
      connection.ws.send(JSON.stringify(message));
      if (message.type === "command") {
        const pending = connection.pending.get(message.id);
        if (pending) pending.delivered = true;
      }
    } catch (error) {
      dispose(connection, `Flow extension socket error: ${String(error)}`);
    }
    return;
  }
  connection.outbound.push(message);
  wakePoller(connection);
}

export function extensionBroadcastEvent(method: string, params: unknown[]): void {
  for (const connection of connections.values()) enqueue(connection, { type: "event", method, params });
}

export function extensionSendEvent(connection: Connection, method: string, params: unknown[]): void {
  enqueue(connection, { type: "event", method, params });
}

const selectedDevice = () => "local";
const selectedConnection = () => connections.get(selectedDevice());

export function onExtensionProgress(listener: (progress: { requestId: string; tabId?: number; progress: unknown; deviceId?: string }) => void): () => void {
  events.on("progress", listener);
  return () => events.off("progress", listener);
}

export function extensionConnected(): boolean {
  return [...connections.values()].some(isConnected);
}

export function extensionSupportsCapability(capability: string): boolean {
  const connection = selectedConnection();
  return Boolean(isConnected(connection) && connection.capabilities.includes(capability));
}

export function extensionStatus() {
  const connected = [...connections.values()].filter(isConnected);
  const transports = [...new Set(connected.map((item) => item.transport))];
  return {
    connected: connected.length > 0,
    connectors: connected.length,
    transport: transports.length === 1 ? transports[0] : transports.length ? "mixed" : "none",
    protocol: transports.includes("http-poll") ? 3 : 2,
  };
}

export type ExtensionDownload = { id: number; filename: string; state: string; error?: string; bytesReceived: number; totalBytes: number; url?: string; finalUrl?: string; referrer?: string };

export async function extensionDownloads(): Promise<ExtensionDownload[]> {
  const connection = selectedConnection();
  if (!isConnected(connection)) throw new Error("Flow connector is offline.");
  return call(connection, "flow.downloads.recent");
}

export async function extensionDownloadChunk(id: number, index: number, offset: number, length: number): Promise<{ index: number; offset: number; data: string; chunkSha256: string; totalBytes: number }> {
  const connection = selectedConnection();
  if (!isConnected(connection)) throw new Error("Flow connector is offline.");
  if (!connection.capabilities.includes("flow.native.downloads.read")) {
    throw Object.assign(new Error("The installed extension cannot transfer downloaded Flow files. Reload the Flow extension."), {
      code: "NATIVE_CAPABILITY_UNSUPPORTED", retryable: true, outcome_unknown: false,
    });
  }
  if (!Number.isSafeInteger(id) || id < 0 || !Number.isSafeInteger(index) || index < 0 || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 1024 * 1024) {
    throw new Error("Invalid Flow download chunk request.");
  }
  return call(connection, "flow.downloads.read", [{ id, index, offset, length }], 60_000);
}

export async function executeFlowDom<T = unknown>(
  command: Record<string, unknown>,
  options: { timeoutMs?: number; onProgress?: (value: unknown) => void } = {},
): Promise<T> {
  const connection = selectedConnection();
  if (!isConnected(connection)) throw new Error("Flow extension is offline.");
  const capability = String(command.capability ?? "");
  if (!connection.capabilities.includes(capability)) {
    throw Object.assign(new Error(`The installed extension does not support ${capability}. Reload this repository's extension.`), {
      code: "NATIVE_CAPABILITY_UNSUPPORTED", retryable: true, outcome_unknown: false,
    });
  }
  // call() allocates the transport ID next; keep it equal to the Flow command
  // requestId so progress events map back to the pending MCP call.
  const requestId = String(connection.nextId + 1);
  const timeoutMs = options.timeoutMs ?? (Number(command.timeoutMs ?? command.timeout_ms) || 5 * 60_000);
  const progressListener = (value: { requestId: string; progress: unknown; deviceId?: string }) => {
    if (value.requestId === requestId && value.deviceId === connection.deviceId) options.onProgress?.(value.progress);
  };
  if (options.onProgress) events.on("progress", progressListener);
  try {
    return await call(connection, "flow.dom.execute", [{ ...command, requestId }], timeoutMs) as T;
  } finally {
    events.off("progress", progressListener);
  }
}

function makeConnection(deviceId: string, transport: Connection["transport"]): Connection {
  return { deviceId, sessionId: randomUUID(), transport, pending: new Map(), ready: false, capabilities: [], nextId: 0, outbound: [], pollWaiters: new Set(), lastSeen: Date.now() };
}

function replaceConnection(connection: Connection): void {
  const existing = connections.get(connection.deviceId);
  if (existing) {
    dispose(existing, "A replacement connector connected for this device.");
    try { existing.ws?.close(1000, "Replaced by a newer device connection"); } catch {}
  }
  connections.set(connection.deviceId, connection);
}

function dispose(connection: Connection, reason: string): void {
  if (connections.get(connection.deviceId) !== connection) return;
  connections.delete(connection.deviceId);
  lastErrors.set(connection.deviceId, reason);
  connection.ready = false;
  for (const pending of connection.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(Object.assign(new Error(reason), { outcome_unknown: pending.delivered }));
  }
  connection.pending.clear();
  connection.outbound.length = 0;
  for (const waiter of connection.pollWaiters) {
    clearTimeout(waiter.timer);
    waiter.resolve(null);
  }
  connection.pollWaiters.clear();
}

function acceptResult(connection: Connection, id: string, result: ExtensionResult): void {
  const item = connection.pending.get(id);
  if (!item) return;
  connection.pending.delete(id);
  clearTimeout(item.timer);
  if (result?.ok) item.resolve(result.value);
  else {
    const detail = typeof result?.error === "string" ? { message: result.error } : result?.error || {};
    item.reject(Object.assign(new Error(detail.message || "Extension command failed"), {
      code: detail.code || "EXTENSION_COMMAND_FAILED",
      retryable: Boolean(detail.retryable),
      outcome_unknown: Boolean(detail.outcome_unknown),
      diagnostics: detail.diagnostics,
    }));
  }
}

function acceptProgress(connection: Connection, progress: { requestId?: unknown; tabId?: number; progress?: unknown }): boolean {
  const requestId = String(progress?.requestId ?? "");
  if (!requestId || !connection.pending.has(requestId)) return false;
  events.emit("progress", { ...progress, requestId, deviceId: connection.deviceId });
  return true;
}

function acceptInitialized(connection: Connection, info: { protocol?: number; version?: string; capabilities?: unknown }): void {
  if (info?.protocol !== 2) throw new Error("Incompatible connector protocol. Reload Flow MCP Connector.");
  connection.version = typeof info.version === "string" ? info.version : undefined;
  connection.capabilities = Array.isArray(info.capabilities) ? info.capabilities.filter((value): value is string => typeof value === "string") : [];
  connection.ready = true;
  connection.lastSeen = Date.now();
  lastErrors.delete(connection.deviceId);
  for (const listener of initListeners) {
    try { listener(connection); } catch (e) { console.warn("[extension] initListener error:", e); }
  }
}

export function extensionRegisterHttpPoll(deviceId: string, info: { protocol: number; version?: string; capabilities?: unknown }): string {
  if (info.protocol !== 3) throw new Error("Incompatible HTTP connector protocol. Reload Flow MCP Connector.");
  const connection = makeConnection(deviceId, "http-poll");
  replaceConnection(connection);
  connection.version = typeof info.version === "string" ? info.version : undefined;
  connection.capabilities = Array.isArray(info.capabilities) ? info.capabilities.filter((value): value is string => typeof value === "string") : [];
  connection.ready = true;
  connection.lastSeen = Date.now();
  lastErrors.delete(deviceId);
  for (const listener of initListeners) {
    try { listener(connection); } catch (e) { console.warn("[extension] initListener error:", e); }
  }
  return connection.sessionId;
}

export function extensionHttpPoll(deviceId: string, sessionId: string, waitMs: number, signal?: AbortSignal): Promise<OutboundMessage | null> {
  const connection = connections.get(deviceId);
  if (!isConnected(connection) || connection.transport !== "http-poll" || connection.sessionId !== sessionId) {
    return Promise.reject(new Error("Connector session was replaced. Reconnect the extension."));
  }
  connection.lastSeen = Date.now();
  const message = connection.outbound.shift();
  if (message) {
    if (message.type === "command") {
      const pending = connection.pending.get(message.id);
      if (pending) pending.delivered = true;
    }
    return Promise.resolve(message);
  }
  if (signal?.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    const waiter: PollWaiter = {
      resolve: (value) => { signal?.removeEventListener("abort", abort); resolve(value); },
      timer: setTimeout(() => {
        connection.pollWaiters.delete(waiter);
        waiter.resolve(null);
      }, Math.min(Math.max(waitMs, 0), 25_000)),
    };
    const abort = () => {
      clearTimeout(waiter.timer);
      connection.pollWaiters.delete(waiter);
      resolve(null);
    };
    connection.pollWaiters.add(waiter);
    signal?.addEventListener("abort", abort, { once: true });
    wakePoller(connection);
  });
}

export function extensionHttpResult(deviceId: string, sessionId: string, id: string, result: ExtensionResult): boolean {
  const connection = connections.get(deviceId);
  if (!isConnected(connection) || connection.transport !== "http-poll" || connection.sessionId !== sessionId) return false;
  connection.lastSeen = Date.now();
  acceptResult(connection, id, result);
  return true;
}

export function extensionHttpProgress(deviceId: string, sessionId: string, progress: { requestId?: unknown; tabId?: number; progress?: unknown }): { accepted: boolean; matched: boolean } {
  const connection = connections.get(deviceId);
  if (!isConnected(connection) || connection.transport !== "http-poll" || connection.sessionId !== sessionId) return { accepted: false, matched: false };
  connection.lastSeen = Date.now();
  return { accepted: true, matched: acceptProgress(connection, progress) };
}

function call(connection: Connection, method: string, args: unknown[] = [], timeoutMs = 5 * 60_000): Promise<any> {
  if (!isConnected(connection)) return Promise.reject(new Error("Flow extension disconnected. No command was sent."));
  const id = String(++connection.nextId);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const delivered = connection.pending.get(id)?.delivered ?? false;
      connection.pending.delete(id);
      connection.outbound = connection.outbound.filter((message) => message.type !== "command" || message.id !== id);
      reject(Object.assign(new Error(`Extension command ${method} timed out after ${timeoutMs}ms; its outcome may be unknown.`), {
        code: "EXTENSION_TIMEOUT", retryable: false, outcome_unknown: delivered,
      }));
    }, timeoutMs);
    connection.pending.set(id, { resolve, reject, timer, delivered: false });
    enqueue(connection, { type: "command", id, method, args, timeout_ms: timeoutMs });
  });
}

export function extensionSetWebSocket(ws: WebSocket, deviceId = "local"): void {
  const connection = makeConnection(deviceId, "websocket");
  connection.ws = ws;
  replaceConnection(connection);
  const initTimer = setTimeout(() => dispose(connection, "Extension handshake timed out. Reload Flow MCP Connector."), 10_000);

  ws.on("message", data => {
    if (connections.get(deviceId) !== connection) return;
    try {
      const message = JSON.parse(data.toString());
      connection.lastSeen = Date.now();
      if (message.type === "ping") { ws.send(JSON.stringify({ type: "pong" })); return; }
      if (message.type === "result") {
        acceptResult(connection, String(message.id), message.result as ExtensionResult);
        return;
      }
      if (message.type === "event" && Array.isArray(message.params)) {
        if (message.method === "extension.progress") acceptProgress(connection, message.params[0]);
        else if (message.method === "extension.initialized") {
          acceptInitialized(connection, message.params[0]);
          clearTimeout(initTimer);
        }
      }
    } catch (error) {
      dispose(connection, `Invalid connector message: ${String(error)}`);
    }
  });
  ws.on("close", (_code, reason) => {
    clearTimeout(initTimer);
    dispose(connection, `Flow extension WebSocket disconnected${reason?.toString() ? `: ${reason.toString()}` : ". Reconnect before starting another operation."}`);
  });
  ws.on("error", error => {
    clearTimeout(initTimer);
    dispose(connection, `Flow extension socket error: ${error.message}`);
  });
}

const staleConnectionSweep = setInterval(() => {
  const now = Date.now();
  for (const connection of connections.values()) {
    if (connection.transport === "http-poll" && now - connection.lastSeen >= HTTP_POLL_STALE_MS) {
      dispose(connection, "Flow extension HTTP connection timed out. Reconnect the extension.");
    }
  }
}, 30_000);
staleConnectionSweep.unref();
