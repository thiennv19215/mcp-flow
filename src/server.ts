import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { WebSocketServer } from "ws";
import { HOME_DIR } from "./chrome.js";
import { OUTPUT_ROOT, shapes, type Core } from "./core.js";
import { extensionConnected, extensionStatus, extensionSetWebSocket } from "./extension.js";
import { officialExtensionStatus } from "./playwright-extension.js";

export const PORT = Number(process.env.FLOW_MCP_PORT ?? 8799);
export const TOKEN_FILE = join(HOME_DIR, "token");
const isExtensionOrigin = (origin: string | undefined): origin is string => /^chrome-extension:\/\/[a-p]{32}$/.test(origin ?? "");
const hasConnectorHeader = (req: IncomingMessage) => req.headers["x-flow-connector"] === "flow-mcp-extension";
const requestsConnectorHeader = (req: IncomingMessage) => String(req.headers["access-control-request-headers"] ?? "").toLowerCase().split(/\s*,\s*/).includes("x-flow-connector");
const UPLOAD_DIR = join(HOME_DIR, "uploads");
const STUDIO_HTML = fileURLToPath(new URL("../studio/index.html", import.meta.url));
const MAX_UPLOAD = 200 * 1024 * 1024;
let bridgeLastPollAt: string | null = null;
let bridgeLastAuthFailureAt: string | null = null;
let bridgeLastRequestAt: string | null = null;
let bridgeLastOrigin: string | null = null;
let bridgeLastAuthFailurePath: string | null = null;
let bridgeLastAuthFailureHasMarker: boolean | null = null;

const MIME: Record<string, string> = {
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".gif": "image/gif",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4",
};

const json = (res: ServerResponse, code: number, data: unknown) => {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
};

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        fail(new Error("Body too large."));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => ok(Buffer.concat(chunks)));
    req.on("error", fail);
  });
}

const inside = (file: string, dir: string) => resolve(file).startsWith(resolve(dir) + sep);

function sendMedia(req: IncomingMessage, res: ServerResponse, file: string) {
  if (!(inside(file, OUTPUT_ROOT) || inside(file, UPLOAD_DIR)) || !existsSync(file)) return json(res, 404, { error: "Not found." });
  const { size } = statSync(file);
  const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(206, { "content-type": type, "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { "content-type": type, "accept-ranges": "bytes", "content-length": size });
  createReadStream(file).pipe(res);
}

export type ServerRole = "owner" | "client" | "none";

// Serves the Studio panel and a JSON API on localhost. Returns "client" when another flow-mcp process already
// owns the port (that process owns the Flow tab and the queue), "none" when the port is taken by something else.
export async function startServer(core: Core): Promise<ServerRole> {
  mkdirSync(HOME_DIR, { recursive: true });
  mkdirSync(UPLOAD_DIR, { recursive: true });
  const token = existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, "utf8").trim() : randomBytes(24).toString("hex");
  const allowedHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

  const server = createServer(async (req, res) => {
    try {
      const origin = req.headers.origin;
      const bridgeRequest = (req.url ?? "").startsWith("/api/bridge/");
      if (bridgeRequest && isExtensionOrigin(origin)) res.setHeader("access-control-allow-origin", origin);
      if (req.method === "OPTIONS") {
        if (!bridgeRequest || (!isExtensionOrigin(origin) && !(origin == null && requestsConnectorHeader(req)))) return json(res, 403, { error: "Untrusted extension origin." });
        res.setHeader("access-control-allow-headers", "content-type,x-flow-connector");
        res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
        return void res.writeHead(204).end();
      }
      // The Host check blocks DNS rebinding. Bridge calls require the connector marker when Chrome omits Origin; Studio's API uses its token.
      if (!allowedHosts.has(req.headers.host ?? "")) return json(res, 403, { error: "Bad host." });
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

      if (req.method === "GET" && url.pathname === "/api/health") {
        const driver = process.env.FLOW_MCP_DRIVER ?? "extension";
        const official = officialExtensionStatus();
        return json(res, 200, { name: "flow-mcp", driver, extension_connected: driver === "playwright-official" ? official.connected : extensionConnected(), ...(driver === "playwright-official" ? { playwright_extension: official } : { connector: extensionStatus() }), bridge_last_poll_at: bridgeLastPollAt, bridge_last_auth_failure_at: bridgeLastAuthFailureAt, bridge_last_request_at: bridgeLastRequestAt, bridge_last_origin: bridgeLastOrigin, bridge_last_auth_failure_path: bridgeLastAuthFailurePath, bridge_last_auth_failure_has_marker: bridgeLastAuthFailureHasMarker });
      }
      if (url.pathname === "/favicon.ico") return void res.writeHead(204).end();
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(readFileSync(STUDIO_HTML, "utf8").replace("__FLOW_TOKEN__", token));
      }

      if (url.pathname.startsWith("/api/bridge/")) {
        bridgeLastRequestAt = new Date().toISOString();
        bridgeLastOrigin = origin ?? null;
        if (url.pathname === "/api/bridge/next") bridgeLastPollAt = bridgeLastRequestAt;
        if (!isExtensionOrigin(origin) && !(origin == null && hasConnectorHeader(req))) {
          bridgeLastAuthFailureAt = new Date().toISOString();
          bridgeLastAuthFailurePath = url.pathname;
          bridgeLastAuthFailureHasMarker = hasConnectorHeader(req);
          return json(res, 403, { error: "Untrusted extension origin." });
        }
      } else {
        const given = req.headers["x-flow-token"] ?? url.searchParams.get("token");
        if (given !== token) return json(res, 401, { error: "Missing or wrong token." });
      }

      if (req.method === "GET" && url.pathname === "/api/bridge/next") {
        return json(res, 426, { error: "HTTP polling has been removed. Reload Flow MCP Connector 0.4.0+ to connect via WebSocket." });
      }
      if (req.method === "POST" && url.pathname === "/api/bridge/result") {
        return json(res, 426, { error: "Use the connector WebSocket." });
      }
      if (req.method === "POST" && url.pathname === "/api/bridge/event") {
        return json(res, 426, { error: "Use the connector WebSocket." });
      }
      if (req.method === "GET" && url.pathname === "/api/bridge/file") {
        const path = url.searchParams.get("path") ?? "";
        if (!path || !existsSync(path) || !statSync(path).isFile()) return json(res, 404, { error: "Upload source file not found." });
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": statSync(path).size, "cache-control": "no-store" });
        return createReadStream(path).pipe(res);
      }

      if (req.method === "GET" && url.pathname === "/media") return sendMedia(req, res, url.searchParams.get("path") ?? "");

      if (req.method === "POST" && url.pathname === "/api/upload") {
        const name = basename(url.searchParams.get("name") ?? "upload").replace(/[^\w.-]+/g, "_");
        const path = join(UPLOAD_DIR, `${randomBytes(4).toString("hex")}-${name}`);
        writeFileSync(path, await readBody(req, MAX_UPLOAD));
        return json(res, 200, { path });
      }

      const method = url.pathname.match(/^\/api\/(\w+)$/)?.[1] as keyof Core | undefined;
      if (req.method === "POST" && method && typeof core[method] === "function") {
        const raw = (await readBody(req, 1024 * 1024)).toString() || "{}";
        const shape = (shapes as Record<string, z.ZodRawShape>)[method];
        const args = shape ? z.object(shape).parse(JSON.parse(raw)) : undefined;
        return json(res, 200, await (core[method] as (a: unknown) => Promise<unknown>)(args));
      }
      json(res, 404, { error: "Not found." });
    } catch (err) {
      const message = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : err instanceof Error ? err.message : String(err);
      json(res, 400, { error: message });
    }
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    if (!allowedHosts.has(request.headers.host ?? "") || !isExtensionOrigin(request.headers.origin)) { socket.destroy(); return; }
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    if (url.pathname === "/ws/bridge") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on("connection", (ws) => {
    extensionSetWebSocket(ws);
  });

  const listening = await new Promise<boolean>((ok) => {
    server.once("error", () => ok(false));
    server.listen(PORT, "127.0.0.1", () => ok(true));
  });
  if (listening) {
    mkdirSync(HOME_DIR, { recursive: true });
    writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
    return "owner";
  }
  // The port is taken. Who has it matters enormously: becoming a second LOCAL core means two processes drive the same
  // Flow tab with separate queues, which is how a shot got generated and charged twice while flow_status reported an
  // empty queue (2026-09-20). Claude Desktop starts several of these at once and the owner is often still booting, or
  // busy inside a Playwright call, so one 2 s health check timing out proves nothing.
  for (let attempt = 0; attempt < 8; attempt++) {
    const other = (await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(3000) }).then(
      (r) => r.json(),
      () => null,
    )) as { name?: string } | null;
    if (other?.name === "flow-mcp") return "client";
    // A valid answer from something that is NOT us means the port belongs to an unrelated program, and driving Flow
    // locally is safe.
    if (other) return "none";
    await new Promise((r) => setTimeout(r, 1500));
  }
  // Never confirmed, but something holds the port and it is most likely a busy sibling. Defer to it: a client whose
  // calls fail loudly is far better than a second process silently spending the user's credits.
  return "client";
}
