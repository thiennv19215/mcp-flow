import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, extname, join, resolve, sep } from "node:path";
import { z } from "zod";
import { WebSocketServer } from "ws";
import { HOME_DIR, OUTPUT_ROOT, UPLOAD_DIR } from "./paths.js";
import { shapes, type Core } from "./core.js";
import {
  extensionConnected, extensionHttpPoll, extensionHttpProgress, extensionHttpResult,
  extensionRegisterHttpPoll, extensionStatus, extensionSetWebSocket,
} from "./extension.js";

export const PORT = Number(process.env.FLOW_MCP_PORT ?? 18899);
export const HOST = process.env.FLOW_MCP_HOST ?? "127.0.0.1";
export const TOKEN_FILE = join(HOME_DIR, "token");
const isExtensionOrigin = (origin: string | undefined): origin is string => /^chrome-extension:\/\/[a-p]{32}$/.test(origin ?? "");
const MAX_UPLOAD = 200 * 1024 * 1024;

const MIME: Record<string, string> = {
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".gif": "image/gif",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4",
};

const json = (res: ServerResponse, code: number, data: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", ...headers });
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

function sendMedia(req: IncomingMessage, res: ServerResponse, file: string, allowedRoots = [OUTPUT_ROOT, UPLOAD_DIR]) {
  if (!allowedRoots.some((root) => inside(file, root)) || !existsSync(file)) return json(res, 404, { error: "Not found." });
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

// Local-only bridge: serves the JSON API sibling MCP processes forward to,
// the extension connector endpoints, and media/upload file services on
// loopback. Returns "client" when another flow-mcp process already owns
// the port (that process owns the Flow tab and the queue), "none" when the
// port is taken by something else.
export async function startServer(core: Core): Promise<ServerRole> {
  if (!["127.0.0.1", "localhost", "::1"].includes(HOST.toLowerCase())) {
    throw new Error("Flow MCP is local-only: set FLOW_MCP_HOST to 127.0.0.1 (the hosted remote/account build was removed).");
  }
  mkdirSync(HOME_DIR, { recursive: true });
  mkdirSync(UPLOAD_DIR, { recursive: true });
  const token = process.env.FLOW_MCP_TOKEN?.trim() || (existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, "utf8").trim() : randomBytes(24).toString("hex"));
  const allowedHosts = new Set(
    (process.env.FLOW_MCP_ALLOWED_HOSTS ?? `127.0.0.1:${PORT},localhost:${PORT}`)
      .split(",").map((host) => host.trim().toLowerCase()).filter(Boolean),
  );
  const wsToken = process.env.FLOW_MCP_WS_TOKEN ?? "";

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") return json(res, 404, { error: "Not found." });
      // The Host check blocks DNS rebinding. API calls require the per-machine token.
      if (!allowedHosts.has(req.headers.host ?? "")) return json(res, 403, { error: "Bad host." });
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

      if (req.method === "GET" && url.pathname === "/api/health") {
        return json(res, 200, { name: "flow-mcp", driver: "native", extension_connected: extensionConnected(), connector: extensionStatus() });
      }
      if (url.pathname.startsWith("/api/extension/")) {
        if (req.method !== "POST" || !["/api/extension/connect", "/api/extension/poll", "/api/extension/result", "/api/extension/progress"].includes(url.pathname)) {
          return json(res, 404, { error: "Not found." });
        }
        const bodyLimit = url.pathname === "/api/extension/result" ? 2 * 1024 * 1024 : 64 * 1024;
        const raw = (await readBody(req, bodyLimit)).toString() || "{}";
        const body = JSON.parse(raw) as Record<string, unknown>;
        if (url.pathname === "/api/extension/connect") {
          if (typeof body.protocol !== "number" || (body.version !== undefined && typeof body.version !== "string") ||
              (body.capabilities !== undefined && (!Array.isArray(body.capabilities) || body.capabilities.length > 100 || body.capabilities.some((value) => typeof value !== "string" || value.length > 120)))) {
            return json(res, 400, { error: "Invalid connector handshake." });
          }
          const sessionId = extensionRegisterHttpPoll("local", body as { protocol: number; version?: string; capabilities?: unknown });
          return json(res, 200, { ok: true, protocol: 3, transport: "http-poll", session_id: sessionId });
        }
        if (url.pathname === "/api/extension/poll") {
          if (typeof body.session_id !== "string" || body.session_id.length > 100) return json(res, 400, { error: "A connector session is required." });
          const controller = new AbortController();
          res.on("close", () => { if (!res.writableEnded) controller.abort(); });
          const message = await extensionHttpPoll("local", body.session_id, typeof body.wait_ms === "number" ? body.wait_ms : 20_000, controller.signal);
          if (!res.destroyed) return json(res, 200, { message });
          return;
        }
        if (url.pathname === "/api/extension/result") {
          if (typeof body.session_id !== "string" || body.session_id.length > 100 || typeof body.id !== "string" || body.id.length > 100 || !body.result || typeof body.result !== "object" || typeof (body.result as { ok?: unknown }).ok !== "boolean") {
            return json(res, 400, { error: "Invalid extension result." });
          }
          if (!extensionHttpResult("local", body.session_id, body.id, body.result as Parameters<typeof extensionHttpResult>[3])) return json(res, 409, { error: "Connector session was replaced." });
          return json(res, 200, { ok: true });
        }
        if (url.pathname === "/api/extension/progress") {
          if (typeof body.session_id !== "string" || body.session_id.length > 100 || (body.requestId !== undefined && typeof body.requestId !== "string" && typeof body.requestId !== "number")) {
            return json(res, 400, { error: "Invalid extension progress." });
          }
          const receipt = extensionHttpProgress("local", body.session_id, { requestId: body.requestId, tabId: typeof body.tabId === "number" ? body.tabId : undefined, progress: body.progress });
          if (!receipt.accepted) return json(res, 409, { error: "Connector session was replaced." });
          return json(res, 200, { ok: true, matched: receipt.matched });
        }
      }
      if (url.pathname === "/favicon.ico") return void res.writeHead(204).end();

      const given = req.headers["x-flow-token"] ?? url.searchParams.get("token");
      const apiMethod = url.pathname.match(/^\/api\/(\w+)$/)?.[1] as keyof Core | undefined;
      if (req.method === "POST" && apiMethod && typeof core[apiMethod] === "function") {
        if (given !== token) return json(res, 401, { error: "Missing or wrong token." });
        const raw = (await readBody(req, 1024 * 1024)).toString() || "{}";
        const shape = (shapes as Record<string, z.ZodRawShape>)[apiMethod];
        const args = shape ? z.object(shape).parse(JSON.parse(raw)) : undefined;
        return json(res, 200, await (core[apiMethod] as (a: unknown) => Promise<unknown>)(args));
      }

      if (req.method === "GET" && url.pathname === "/media") {
        if (given !== token) return json(res, 401, { error: "Missing or wrong token." });
        return sendMedia(req, res, url.searchParams.get("path") ?? "");
      }

      if (req.method === "POST" && url.pathname === "/api/upload") {
        if (given !== token) return json(res, 401, { error: "Missing or wrong token." });
        const originalName = basename(url.searchParams.get("name") ?? "upload");
        const extension = extname(originalName).toLowerCase();
        const allowed = [".png", ".jpg", ".jpeg", ".webp", ".mp4", ".m4v", ".webm", ".mov", ".gif", ".mp3", ".wav", ".m4a", ".heic", ".heif", ".avif", ".avi", ".mkv", ".3gp"];
        if (!allowed.includes(extension)) return json(res, 415, { error: `Unsupported file type "${extension || "(no extension)"}".` });
        const name = originalName.replace(/[^\w.-]+/g, "_");
        const path = join(UPLOAD_DIR, `${randomBytes(4).toString("hex")}-${name}`);
        const body = await readBody(req, MAX_UPLOAD);
        if (!body.length) return json(res, 400, { error: "The selected file is empty." });
        writeFileSync(path, body);
        return json(res, 200, { path });
      }
      if (given !== token) return json(res, 401, { error: "Missing or wrong token." });
      json(res, 404, { error: "Not found." });
    } catch (err) {
      const message = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : err instanceof Error ? err.message : String(err);
      json(res, 400, { error: message });
    }
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const host = request.headers.host ?? "";
    const extensionOrigin = isExtensionOrigin(request.headers.origin);
    if (!allowedHosts.has(host)) {
      console.warn(`[ws] rejected upgrade: host not allowed (host=${host || "<missing>"})`);
      socket.destroy();
      return;
    }
    if (!extensionOrigin) {
      console.warn(`[ws] rejected upgrade: invalid extension origin (originPresent=${Boolean(request.headers.origin)})`);
      socket.destroy();
      return;
    }
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    if (url.pathname === "/ws/bridge") {
      const credential = url.searchParams.get("token") ?? "";
      if (wsToken && credential !== wsToken) {
        console.warn("[ws] rejected upgrade: invalid local credential");
        socket.destroy();
        return;
      }
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
    server.listen(PORT, HOST, () => ok(true));
  });
  if (listening) {
    mkdirSync(HOME_DIR, { recursive: true });
    writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
    return "owner";
  }
  // The port is taken. Who has it matters enormously: becoming a second LOCAL core means two processes drive the same
  // Flow tab with separate queues, which is how a shot got generated and charged twice while flow_status reported an
  // empty queue (2026-09-20). Claude Desktop starts several of these at once and the owner is often still booting,
  // so one 2 s health check timing out proves nothing.
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
