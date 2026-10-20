import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { WebSocketServer } from "ws";
import { HOME_DIR } from "./paths.js";
import { OUTPUT_ROOT, shapes, type Core } from "./core.js";
import { extensionConnected, extensionRevokeDeviceConnection, extensionStatus, extensionSetWebSocket } from "./extension.js";
import { runWithDeviceContext } from "./request-context.js";
import { outputRootForContext, uploadDirForContext } from "./paths.js";
import { authenticateDevice, createUser, listDevicesForUser, listUsers, loginDevice, pairDevice, revokeDevice, rotatePairingCode, setUserPassword, setUserStatus } from "./users.js";

export const PORT = Number(process.env.FLOW_MCP_PORT ?? 18899);
export const HOST = process.env.FLOW_MCP_HOST ?? "127.0.0.1";
export const PUBLIC_URL = process.env.FLOW_MCP_PUBLIC_URL?.replace(/\/$/, "");
export const TOKEN_FILE = join(HOME_DIR, "token");
const isExtensionOrigin = (origin: string | undefined): origin is string => /^chrome-extension:\/\/[a-p]{32}$/.test(origin ?? "");
const UPLOAD_DIR = join(HOME_DIR, "uploads");
const STUDIO_HTML = fileURLToPath(new URL("../studio/index.html", import.meta.url));
const LOGIN_HTML = fileURLToPath(new URL("../studio/login.html", import.meta.url));
const ADMIN_HTML = fileURLToPath(new URL("../studio/admin.html", import.meta.url));
const MAX_UPLOAD = 200 * 1024 * 1024;
const ADMIN_SESSION_COOKIE = "__Host-flow_admin_session";
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

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

// Serves the Studio panel and a JSON API on localhost. Returns "client" when another flow-mcp process already
// owns the port (that process owns the Flow tab and the queue), "none" when the port is taken by something else.
export async function startServer(core: Core, getDeviceCore?: (deviceId: string) => Core, suspendDeviceCore?: (deviceId: string) => void): Promise<ServerRole> {
  mkdirSync(HOME_DIR, { recursive: true });
  mkdirSync(UPLOAD_DIR, { recursive: true });
  const token = process.env.FLOW_MCP_TOKEN?.trim() || (existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, "utf8").trim() : randomBytes(24).toString("hex"));
  const localOnly = ["127.0.0.1", "localhost", "::1"].includes(HOST.toLowerCase());
  const allowedHosts = new Set(
    (process.env.FLOW_MCP_ALLOWED_HOSTS ?? `127.0.0.1:${PORT},localhost:${PORT}`)
      .split(",").map((host) => host.trim().toLowerCase()).filter(Boolean),
  );
  const adminUser = process.env.FLOW_MCP_ADMIN_USER ?? "";
  const adminPassword = process.env.FLOW_MCP_ADMIN_PASSWORD ?? "";
  const wsToken = process.env.FLOW_MCP_WS_TOKEN ?? "";
  const pairAttempts = new Map<string, { count: number; resetsAt: number }>();
  const deviceLoginAttempts = new Map<string, { count: number; resetsAt: number }>();
  const loginAttempts = new Map<string, { count: number; resetsAt: number }>();
  const adminSessions = new Map<string, { username: string; expiresAt: number }>();

  // Public deployments must explicitly configure the host allowlist and credentials.
  if (!localOnly) {
    if (!process.env.FLOW_MCP_ALLOWED_HOSTS) throw new Error("Set FLOW_MCP_ALLOWED_HOSTS before binding Flow MCP to a non-local address.");
    if ((process.env.FLOW_MCP_TOKEN?.trim().length ?? 0) < 32) throw new Error("Set FLOW_MCP_TOKEN to a random secret of at least 32 characters for a non-local deployment.");
    if (!adminUser || adminPassword.length < 16) throw new Error("Set FLOW_MCP_ADMIN_USER and a FLOW_MCP_ADMIN_PASSWORD of at least 16 characters for a non-local deployment.");
    if (wsToken.length < 32) throw new Error("Set FLOW_MCP_WS_TOKEN to a random secret of at least 32 characters for a non-local deployment.");
    if (!PUBLIC_URL?.startsWith("https://")) throw new Error("Set FLOW_MCP_PUBLIC_URL to the HTTPS URL used by the reverse proxy.");
  }

  const basicCredentialsMatch = (authorization: string | undefined): boolean => {
    const encoded = authorization?.match(/^Basic\s+(.+)$/i)?.[1];
    if (!encoded) return false;
    const value = Buffer.from(encoded, "base64").toString("utf8");
    const separator = value.indexOf(":");
    if (separator < 0) return false;
    const providedUser = Buffer.from(value.slice(0, separator));
    const providedPassword = Buffer.from(value.slice(separator + 1));
    const expectedUser = Buffer.from(adminUser);
    const expectedPassword = Buffer.from(adminPassword);
    return providedUser.length === expectedUser.length && providedPassword.length === expectedPassword.length &&
      timingSafeEqual(providedUser, expectedUser) && timingSafeEqual(providedPassword, expectedPassword);
  };
  const trustedClientIp = (req: IncomingMessage): string => {
    const proxyIp = req.headers["cf-connecting-ip"] ?? req.headers["x-forwarded-for"]?.toString().split(",")[0].trim();
    return process.env.FLOW_MCP_TRUST_PROXY === "true" && proxyIp ? proxyIp.toString() : req.socket.remoteAddress ?? "unknown";
  };
  const sessionIdFromRequest = (req: IncomingMessage): string | undefined => {
    const cookieHeader = req.headers.cookie;
    if (!cookieHeader) return;
    for (const part of cookieHeader.split(";")) {
      const [name, ...value] = part.trim().split("=");
      if (name === ADMIN_SESSION_COOKIE) return value.join("=");
    }
  };
  const sessionFromRequest = (req: IncomingMessage): { username: string } | undefined => {
    const sessionId = sessionIdFromRequest(req);
    if (!sessionId) return;
    const session = adminSessions.get(sessionId);
    if (!session) return;
    if (session.expiresAt <= Date.now()) {
      adminSessions.delete(sessionId);
      return;
    }
    return { username: session.username };
  };
  const sessionAuthAllowed = (req: IncomingMessage): boolean => Boolean(sessionFromRequest(req));
  const adminAuthAllowed = (req: IncomingMessage): boolean => localOnly || sessionAuthAllowed(req) ||
    (Boolean(adminUser && adminPassword) && basicCredentialsMatch(req.headers.authorization));
  const requireAdmin = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (adminAuthAllowed(req)) return true;
    json(res, 401, { error: "Admin authentication required." });
    return false;
  };
  const credentialsMatch = (username: string, password: string): boolean => {
    const providedUser = Buffer.from(username);
    const providedPassword = Buffer.from(password);
    const expectedUser = Buffer.from(adminUser);
    const expectedPassword = Buffer.from(adminPassword);
    return providedUser.length === expectedUser.length && providedPassword.length === expectedPassword.length &&
      timingSafeEqual(providedUser, expectedUser) && timingSafeEqual(providedPassword, expectedPassword);
  };
  const originAllowed = (req: IncomingMessage): boolean => {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      const expected = PUBLIC_URL ? new URL(PUBLIC_URL).origin : `http://${req.headers.host}`;
      return new URL(origin).origin === expected;
    } catch { return false; }
  };
  const cleanExpiredSessions = (now: number): void => {
    if (adminSessions.size > 1000) {
      for (const [id, session] of adminSessions) if (session.expiresAt <= now) adminSessions.delete(id);
    }
  };
  const deviceFromRequest = (req: IncomingMessage) => {
    const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    return bearer ? authenticateDevice(bearer) : undefined;
  };
  const suspendDevice = (deviceId: string) => {
    extensionRevokeDeviceConnection(deviceId);
    suspendDeviceCore?.(deviceId);
  };

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") return json(res, 404, { error: "Not found." });
      // The Host check blocks DNS rebinding. Studio API calls require the per-run token.
      if (!allowedHosts.has(req.headers.host ?? "")) return json(res, 403, { error: "Bad host." });
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

      if (req.method === "GET" && url.pathname === "/api/health") {
        return json(res, 200, localOnly
          ? { name: "flow-mcp", driver: "native", extension_connected: extensionConnected(), connector: extensionStatus() }
          : { name: "flow-mcp", driver: "native" });
      }
      if (url.pathname === "/api/auth/session" && req.method === "GET") {
        const session = sessionFromRequest(req);
        return localOnly || session
          ? json(res, 200, { authenticated: true, username: session?.username ?? adminUser, local: localOnly })
          : json(res, 401, { authenticated: false });
      }
      if (url.pathname === "/api/auth/login" && req.method === "POST") {
        if (localOnly) return json(res, 200, { ok: true });
        if (!originAllowed(req)) return json(res, 403, { error: "Request origin is not allowed." });
        const now = Date.now();
        if (loginAttempts.size > 1000) {
          for (const [ip, attempt] of loginAttempts) if (attempt.resetsAt <= now) loginAttempts.delete(ip);
        }
        const ip = trustedClientIp(req);
        const attempt = loginAttempts.get(ip);
        if (attempt && attempt.resetsAt > now && attempt.count >= 10) {
          res.setHeader("retry-after", String(Math.max(1, Math.ceil((attempt.resetsAt - now) / 1000))));
          return json(res, 429, { error: "Bạn đã thử đăng nhập quá nhiều lần. Hãy thử lại sau một phút." });
        }
        if (!attempt || attempt.resetsAt <= now) loginAttempts.set(ip, { count: 1, resetsAt: now + 60_000 });
        else attempt.count += 1;
        const body = JSON.parse((await readBody(req, 8192)).toString() || "{}");
        if (typeof body.username !== "string" || typeof body.password !== "string" || body.username.length > 256 || body.password.length > 1024) {
          return json(res, 400, { error: "Vui lòng nhập tên đăng nhập và mật khẩu." });
        }
        if (!credentialsMatch(body.username, body.password)) return json(res, 401, { error: "Tên đăng nhập hoặc mật khẩu chưa đúng." });
        loginAttempts.delete(ip);
        cleanExpiredSessions(now);
        const sessionId = randomBytes(32).toString("base64url");
        adminSessions.set(sessionId, { username: adminUser, expiresAt: now + ADMIN_SESSION_TTL_MS });
        res.setHeader("set-cookie", `${ADMIN_SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${ADMIN_SESSION_TTL_MS / 1000}`);
        return json(res, 200, { ok: true });
      }
      if (url.pathname === "/api/auth/logout" && req.method === "POST") {
        if (!originAllowed(req)) return json(res, 403, { error: "Request origin is not allowed." });
        const sessionId = sessionIdFromRequest(req);
        if (sessionId) adminSessions.delete(sessionId);
        res.setHeader("set-cookie", `${ADMIN_SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/device/login") {
        const ip = trustedClientIp(req);
        const now = Date.now();
        if (deviceLoginAttempts.size > 1000) {
          for (const [key, attempt] of deviceLoginAttempts) if (attempt.resetsAt <= now) deviceLoginAttempts.delete(key);
        }
        const attempt = deviceLoginAttempts.get(ip);
        if (attempt && attempt.resetsAt > now && attempt.count >= 10) {
          res.setHeader("retry-after", String(Math.max(1, Math.ceil((attempt.resetsAt - now) / 1000))));
          return json(res, 429, { error: "Quá nhiều lần đăng nhập. Hãy thử lại sau một phút." });
        }
        if (!attempt || attempt.resetsAt <= now) deviceLoginAttempts.set(ip, { count: 1, resetsAt: now + 60_000 });
        else attempt.count += 1;
        const body = JSON.parse((await readBody(req, 8192)).toString() || "{}");
        if (typeof body.account !== "string" || typeof body.password !== "string" || typeof body.device_name !== "string" || body.account.length > 100 || body.password.length > 1024) {
          return json(res, 400, { error: "Vui lòng nhập tài khoản và mật khẩu." });
        }
        try {
          const device = loginDevice(body.account, body.password, body.device_name);
          deviceLoginAttempts.delete(ip);
          return json(res, 200, device);
        } catch {
          return json(res, 401, { error: "Tài khoản hoặc mật khẩu chưa đúng, hoặc tài khoản đã bị khóa." });
        }
      }
      if (req.method === "POST" && url.pathname === "/api/pair") {
        const ip = trustedClientIp(req);
        const now = Date.now();
        if (pairAttempts.size > 1000) {
          for (const [key, value] of pairAttempts) if (value.resetsAt <= now) pairAttempts.delete(key);
        }
        const attempt = pairAttempts.get(ip);
        if (attempt && attempt.resetsAt > now && attempt.count >= 10) return json(res, 429, { error: "Too many pairing attempts. Try again in a minute." });
        if (!attempt || attempt.resetsAt <= now) pairAttempts.set(ip, { count: 1, resetsAt: now + 60_000 });
        else attempt.count += 1;
        const body = JSON.parse((await readBody(req, 8192)).toString() || "{}");
        if (typeof body.user_code !== "string" || typeof body.device_name !== "string") return json(res, 400, { error: "user_code and device_name are required." });
        return json(res, 200, pairDevice(body.user_code, body.device_name));
      }
      if (url.pathname.startsWith("/api/admin/users")) {
        if (!requireAdmin(req, res)) return;
        if (req.method === "GET" && url.pathname === "/api/admin/users") return json(res, 200, { users: listUsers() });
        if (req.method === "POST" && url.pathname === "/api/admin/users") {
          const body = JSON.parse((await readBody(req, 8192)).toString() || "{}");
          if (typeof body.label !== "string") return json(res, 400, { error: "label is required." });
          return json(res, 201, createUser(body.label));
        }
        const userActionRoute = url.pathname.match(/^\/api\/admin\/users\/([0-9a-f-]+)\/(rotate-code|status)$/i);
        const userPasswordRoute = url.pathname.match(/^\/api\/admin\/users\/([0-9a-f-]+)\/password$/i);
        if (userPasswordRoute && req.method === "POST") {
          const body = JSON.parse((await readBody(req, 8192)).toString() || "{}");
          if (typeof body.password !== "string" || body.password.length < 12 || body.password.length > 1024) return json(res, 400, { error: "Mật khẩu phải có từ 12 ký tự trở lên." });
          try {
            setUserPassword(userPasswordRoute[1], body.password);
            return json(res, 200, { ok: true, login_enabled: true });
          } catch {
            return json(res, 404, { error: "Không tìm thấy người dùng đang hoạt động." });
          }
        }
        if (userActionRoute && req.method === "POST") {
          const [, userId, action] = userActionRoute;
          if (action === "rotate-code") return json(res, 200, rotatePairingCode(userId));
          if (action === "status") {
            const body = JSON.parse((await readBody(req, 8192)).toString() || "{}");
            if (body.status !== "active" && body.status !== "disabled") return json(res, 400, { error: "status must be active or disabled." });
            setUserStatus(userId, body.status);
            if (body.status === "disabled") listDevicesForUser(userId).forEach(({ id }) => suspendDevice(id));
            return json(res, 200, { ok: true });
          }
        }
        const adminRevokeDevice = url.pathname.match(/^\/api\/admin\/users\/([0-9a-f-]+)\/devices\/([0-9a-f-]+)\/revoke$/i);
        if (req.method === "POST" && adminRevokeDevice) {
          const revoked = revokeDevice(adminRevokeDevice[1], adminRevokeDevice[2]);
          if (revoked) suspendDevice(adminRevokeDevice[2]);
          return json(res, revoked ? 200 : 404, { ok: revoked });
        }
        const userDevicesRoute = url.pathname.match(/^\/api\/admin\/users\/([0-9a-f-]+)\/devices$/i);
        if (req.method === "GET" && userDevicesRoute) {
          return json(res, 200, { devices: listDevicesForUser(userDevicesRoute[1]) });
        }
        return json(res, 404, { error: "Not found." });
      }
      if (url.pathname === "/api/user/me" && req.method === "GET") {
        const device = deviceFromRequest(req);
        return device ? json(res, 200, { ...device, devices: listDevicesForUser(device.user_id) }) : json(res, 401, { error: "Valid device bearer token required." });
      }
      const revokeOwnDevice = url.pathname.match(/^\/api\/user\/devices\/([0-9a-f-]+)\/revoke$/i);
      if (req.method === "POST" && revokeOwnDevice) {
        const device = deviceFromRequest(req);
        if (!device) return json(res, 401, { error: "Valid device bearer token required." });
        const revoked = revokeDevice(device.user_id, revokeOwnDevice[1]);
        if (revoked) suspendDevice(revokeOwnDevice[1]);
        return json(res, revoked ? 200 : 404, { ok: revoked });
      }
      if (url.pathname === "/favicon.ico") return void res.writeHead(204).end();
      if (req.method === "GET" && url.pathname === "/admin") {
        if (!localOnly && !sessionAuthAllowed(req)) {
          res.writeHead(302, { location: "/", "cache-control": "no-store" });
          return res.end();
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
        return res.end(readFileSync(ADMIN_HTML, "utf8"));
      }
      if (req.method === "GET" && url.pathname === "/") {
        if (!localOnly && !sessionAuthAllowed(req)) {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
          return res.end(readFileSync(LOGIN_HTML, "utf8"));
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(readFileSync(STUDIO_HTML, "utf8").replace("__FLOW_TOKEN__", token));
      }

      const given = req.headers["x-flow-token"] ?? url.searchParams.get("token");
      const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
      const apiMethod = url.pathname.match(/^\/api\/(\w+)$/)?.[1] as keyof Core | undefined;
      if (req.method === "POST" && apiMethod && typeof core[apiMethod] === "function") {
        const raw = (await readBody(req, 1024 * 1024)).toString() || "{}";
        const shape = (shapes as Record<string, z.ZodRawShape>)[apiMethod];
        const args = shape ? z.object(shape).parse(JSON.parse(raw)) : undefined;
        if (bearer) {
          const device = authenticateDevice(bearer);
          if (!device) return json(res, 401, { error: "Valid device bearer token required." });
          const deviceCore = getDeviceCore?.(device.device_id);
          if (!deviceCore) return json(res, 503, { error: "Device execution is not configured." });
          return runWithDeviceContext({ userId: device.user_id, deviceId: device.device_id }, async () =>
            json(res, 200, await (deviceCore[apiMethod] as (a: unknown) => Promise<unknown>)(args)),
          );
        }
        if (given !== token) return json(res, 401, { error: "Missing or wrong token." });
        return json(res, 200, await (core[apiMethod] as (a: unknown) => Promise<unknown>)(args));
      }

      if (req.method === "GET" && url.pathname === "/media") {
        const file = url.searchParams.get("path") ?? "";
        if (given === token) return sendMedia(req, res, file);
        const device = bearer ? authenticateDevice(bearer) : undefined;
        if (!device) return json(res, 401, { error: "Missing or wrong token." });
        return runWithDeviceContext({ userId: device.user_id, deviceId: device.device_id }, () =>
          sendMedia(req, res, file, [outputRootForContext(), uploadDirForContext()]),
        );
      }

      if (req.method === "POST" && url.pathname === "/api/upload") {
        const device = given === token ? undefined : bearer ? authenticateDevice(bearer) : undefined;
        if (given !== token && !device) return json(res, 401, { error: "Missing or wrong token." });
        const originalName = basename(url.searchParams.get("name") ?? "upload");
        const extension = extname(originalName).toLowerCase();
        const allowed = [".png", ".jpg", ".jpeg", ".webp", ".mp4", ".webm", ".mov", ".gif", ".mp3", ".wav", ".m4a"];
        if (!allowed.includes(extension)) return json(res, 415, { error: `Unsupported file type "${extension || "(no extension)"}".` });
        const save = async () => {
          const directory = device ? uploadDirForContext() : UPLOAD_DIR;
          mkdirSync(directory, { recursive: true });
          const name = originalName.replace(/[^\w.-]+/g, "_");
          const path = join(directory, `${randomBytes(4).toString("hex")}-${name}`);
          const body = await readBody(req, MAX_UPLOAD);
          if (!body.length) return json(res, 400, { error: "The selected file is empty." });
          writeFileSync(path, body);
          return json(res, 200, { path });
        };
        return device ? runWithDeviceContext({ userId: device.user_id, deviceId: device.device_id }, save) : save();
      }
      if (given !== token) return json(res, 401, { error: "Missing or wrong token." });
      json(res, 404, { error: "Not found." });
    } catch (err) {
      const message = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : err instanceof Error ? err.message : String(err);
      json(res, 400, { error: message });
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  const socketDevices = new WeakMap<IncomingMessage, string>();

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
      const device = credential ? authenticateDevice(credential) : undefined;
      if (device) socketDevices.set(request, device.device_id);
      else if (!localOnly && credential !== wsToken) {
        console.warn(`[ws] rejected upgrade: invalid credential (credentialPresent=${Boolean(credential)})`);
        socket.destroy();
        return;
      }
      else if (credential && credential !== wsToken && localOnly) {
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

  wss.on("connection", (ws, request) => {
    extensionSetWebSocket(ws, socketDevices.get(request) ?? "local");
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
  // empty queue (2026-09-20). Claude Desktop starts several of these at once and the owner is often still booting, or
  // still booting, so one 2 s health check timing out proves nothing.
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
