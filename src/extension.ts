import type { WebSocket } from "ws";
import { EventEmitter } from "node:events";
import { currentDeviceContext } from "./request-context.js";

type ExtensionError = { code?: string; message?: string; retryable?: boolean; outcome_unknown?: boolean };
type ExtensionResult = { ok: boolean; value?: unknown; error?: string | ExtensionError };
type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout };
export type Connection = {
  deviceId: string;
  ws: WebSocket;
  pending: Map<string, Pending>;
  ready: boolean;
  version?: string;
  capabilities: string[];
  nextId: number;
};

const connections = new Map<string, Connection>();
const lastErrors = new Map<string, string>();
const events = new EventEmitter();
const initListeners: ((connection: Connection) => void)[] = [];

export function onExtensionInitialized(listener: (connection: Connection) => void): () => void {
  initListeners.push(listener);
  return () => {
    const idx = initListeners.indexOf(listener);
    if (idx >= 0) initListeners.splice(idx, 1);
  };
}

export function extensionBroadcastEvent(method: string, params: unknown[]): void {
  const message = JSON.stringify({ type: "event", method, params });
  for (const connection of connections.values()) {
    if (connection.ws.readyState === 1) {
      try { connection.ws.send(message); } catch {}
    }
  }
}

export function extensionSendEvent(connection: Connection, method: string, params: unknown[]): void {
  if (connection.ws.readyState === 1) {
    try { connection.ws.send(JSON.stringify({ type: "event", method, params })); } catch {}
  }
}
const selectedDevice = () => currentDeviceContext()?.deviceId ?? "local";
const selectedConnection = () => connections.get(selectedDevice());

export function onExtensionProgress(listener: (progress: { requestId: string; tabId?: number; progress: unknown; deviceId?: string }) => void): () => void {
  events.on("progress", listener);
  return () => events.off("progress", listener);
}

export function extensionConnected(): boolean {
  const context = currentDeviceContext();
  const available = context ? [connections.get(context.deviceId)] : [...connections.values()];
  return available.some((connection) => Boolean(connection?.ready && connection.ws.readyState === 1));
}

export function extensionSupportsCapability(capability: string): boolean {
  const connection = selectedConnection();
  return Boolean(connection?.ready && connection.capabilities.includes(capability));
}

export function extensionStatus() {
  const context = currentDeviceContext();
  if (!context) return { connected: extensionConnected(), connectors: [...connections.values()].filter((item) => item.ready && item.ws.readyState === 1).length, transport: "websocket", protocol: 2 };
  const connection = selectedConnection();
  return { connected: Boolean(connection?.ready && connection.ws.readyState === 1), device_id: context.deviceId, transport: "websocket", protocol: 2, extension_version: connection?.version, error: lastErrors.get(context.deviceId) };
}

export function extensionRevokeDeviceConnection(deviceId: string): void {
  const connection = connections.get(deviceId);
  if (!connection) return;
  dispose(connection, "This device's backend credential was revoked.");
  connection.ws.close(1008, "Device credential revoked");
}

export async function extensionDownloads(): Promise<Array<{ id: number; filename: string; state: string; error?: string; bytesReceived: number; totalBytes: number }>> {
  const connection = selectedConnection();
  if (!connection?.ready) throw new Error("Flow connector is offline.");
  return call(connection, "flow.downloads.recent");
}

export async function executeFlowDom<T = unknown>(
  command: Record<string, unknown>,
  options: { timeoutMs?: number; onProgress?: (value: unknown) => void } = {},
): Promise<T> {
  const connection = selectedConnection();
  if (!connection?.ready) throw new Error("Flow extension is offline.");
  const capability = String(command.capability ?? "");
  if (!connection.capabilities.includes(capability)) {
    throw Object.assign(new Error(`The installed extension does not support ${capability}. Reload this repository's extension.`), {
      code: "NATIVE_CAPABILITY_UNSUPPORTED", retryable: true, outcome_unknown: false,
    });
  }
  const requestId = String(++connection.nextId);
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

function dispose(connection: Connection, reason: string): void {
  if (connections.get(connection.deviceId) !== connection) return;
  connections.delete(connection.deviceId);
  lastErrors.set(connection.deviceId, reason);
  connection.ready = false;
  for (const pending of connection.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(Object.assign(new Error(reason), { outcome_unknown: true }));
  }
  connection.pending.clear();
}

function call(connection: Connection, method: string, args: unknown[] = [], timeoutMs = 5 * 60_000): Promise<any> {
  if (connections.get(connection.deviceId) !== connection || connection.ws.readyState !== 1) return Promise.reject(new Error("Flow extension disconnected. No command was sent."));
  const id = String(++connection.nextId);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      connection.pending.delete(id);
      reject(Object.assign(new Error(`Extension command ${method} timed out after ${timeoutMs}ms; its outcome may be unknown.`), {
        code: "EXTENSION_TIMEOUT", retryable: false, outcome_unknown: true,
      }));
    }, timeoutMs);
    connection.pending.set(id, { resolve, reject, timer });
    try {
      connection.ws.send(JSON.stringify({ type: "command", id, method, args, timeout_ms: timeoutMs }));
    } catch (error) {
      dispose(connection, String(error));
    }
  });
}

export function extensionSetWebSocket(ws: WebSocket, deviceId = "local"): void {
  const existing = connections.get(deviceId);
  if (existing) {
    dispose(existing, "A replacement connector connected for this device.");
    existing.ws.close(1000, "Replaced by a newer device connection");
  }
  const connection: Connection = { deviceId, ws, pending: new Map(), ready: false, capabilities: [], nextId: 0 };
  connections.set(deviceId, connection);
  const initTimer = setTimeout(() => dispose(connection, "Extension handshake timed out. Reload Flow MCP Connector."), 10_000);

  ws.on("message", data => {
    if (connections.get(deviceId) !== connection) return;
    try {
      const message = JSON.parse(data.toString());
      if (message.type === "ping") { ws.send(JSON.stringify({ type: "pong" })); return; }
      if (message.type === "result") {
        const item = connection.pending.get(String(message.id));
        if (!item) return;
        connection.pending.delete(String(message.id));
        clearTimeout(item.timer);
        const result = message.result as ExtensionResult;
        if (result?.ok) item.resolve(result.value);
        else {
          const detail = typeof result?.error === "string" ? { message: result.error } : result?.error || {};
          item.reject(Object.assign(new Error(detail.message || "Extension command failed"), {
            code: detail.code || "EXTENSION_COMMAND_FAILED",
            retryable: Boolean(detail.retryable),
            outcome_unknown: Boolean(detail.outcome_unknown),
          }));
        }
        return;
      }
      if (message.type === "event" && Array.isArray(message.params)) {
        if (message.method === "extension.progress") {
          const progress = message.params[0];
          if (progress && connection.pending.has(String(progress.requestId))) events.emit("progress", { ...progress, deviceId });
        } else if (message.method === "extension.initialized") {
          const info = message.params[0];
          if (info?.protocol !== 2) throw new Error("Incompatible connector protocol. Reload Flow MCP Connector.");
          connection.version = info.version;
          connection.capabilities = Array.isArray(info.capabilities) ? info.capabilities : [];
          connection.ready = true;
          lastErrors.delete(deviceId);
          clearTimeout(initTimer);
          for (const listener of initListeners) {
            try { listener(connection); } catch (e) { console.warn("[extension] initListener error:", e); }
          }
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
