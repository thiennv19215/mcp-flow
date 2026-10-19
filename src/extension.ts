import type { WebSocket } from "ws";
import { EventEmitter } from "node:events";

type ExtensionError = { code?: string; message?: string; retryable?: boolean; outcome_unknown?: boolean };
type ExtensionResult = { ok: boolean; value?: unknown; error?: string | ExtensionError };
type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout };
type Connection = {
  ws: WebSocket;
  pending: Map<string, Pending>;
  ready: boolean;
  version?: string;
  capabilities: string[];
  nextId: number;
};

let current: Connection | undefined;
let lastError: string | undefined;
const events = new EventEmitter();

export function onExtensionProgress(listener: (progress: { requestId: string; tabId?: number; progress: unknown }) => void): () => void {
  events.on("progress", listener);
  return () => events.off("progress", listener);
}

export function extensionConnected(): boolean {
  return Boolean(current?.ready && current.ws.readyState === 1);
}

export function extensionSupportsCapability(capability: string): boolean {
  return Boolean(current?.ready && current.capabilities.includes(capability));
}

export function extensionStatus() {
  return { connected: extensionConnected(), transport: "websocket", protocol: 2, extension_version: current?.version, error: lastError };
}

export async function extensionDownloads(): Promise<Array<{ id: number; filename: string; state: string; error?: string; bytesReceived: number; totalBytes: number }>> {
  if (!current?.ready) throw new Error("Flow connector is offline.");
  return call(current, "flow.downloads.recent");
}

export async function executeFlowDom<T = unknown>(
  command: Record<string, unknown>,
  options: { timeoutMs?: number; onProgress?: (value: unknown) => void } = {},
): Promise<T> {
  const connection = current;
  if (!connection?.ready) throw new Error("Flow extension is offline.");
  const capability = String(command.capability ?? "");
  if (!connection.capabilities.includes(capability)) {
    throw Object.assign(new Error(`The installed extension does not support ${capability}. Reload this repository's extension.`), {
      code: "NATIVE_CAPABILITY_UNSUPPORTED", retryable: true, outcome_unknown: false,
    });
  }
  const requestId = String(++connection.nextId);
  const timeoutMs = options.timeoutMs ?? (Number(command.timeoutMs ?? command.timeout_ms) || 5 * 60_000);
  const progressListener = (value: { requestId: string; progress: unknown }) => {
    if (value.requestId === requestId) options.onProgress?.(value.progress);
  };
  if (options.onProgress) events.on("progress", progressListener);
  try {
    return await call(connection, "flow.dom.execute", [{ ...command, requestId }], timeoutMs) as T;
  } finally {
    events.off("progress", progressListener);
  }
}

function dispose(connection: Connection, reason: string): void {
  if (current !== connection) return;
  current = undefined;
  lastError = reason;
  connection.ready = false;
  for (const pending of connection.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error(reason));
  }
  connection.pending.clear();
}

function call(connection: Connection, method: string, args: unknown[] = [], timeoutMs = 5 * 60_000): Promise<any> {
  if (current !== connection || connection.ws.readyState !== 1) return Promise.reject(new Error("Flow extension disconnected. No command was sent."));
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

export function extensionSetWebSocket(ws: WebSocket): void {
  if (current) {
    ws.close(1008, "Another Flow connector is already connected");
    return;
  }
  const connection: Connection = { ws, pending: new Map(), ready: false, capabilities: [], nextId: 0 };
  current = connection;
  const initTimer = setTimeout(() => dispose(connection, "Extension handshake timed out. Reload Flow MCP Connector."), 10_000);

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
          if (progress && connection.pending.has(String(progress.requestId))) events.emit("progress", progress);
        } else if (message.method === "extension.initialized") {
          const info = message.params[0];
          if (info?.protocol !== 2) throw new Error("Incompatible connector protocol. Reload Flow MCP Connector.");
          connection.version = info.version;
          connection.capabilities = Array.isArray(info.capabilities) ? info.capabilities : [];
          connection.ready = true;
          lastError = undefined;
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
