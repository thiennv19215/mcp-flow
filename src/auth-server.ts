import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  authenticateDevice,
  createUser,
  listDevicesForUser,
  listUsers,
  loginDevice,
  pairDevice,
  revokeDevice,
  rotatePairingCode,
  setUserPassword,
  setUserStatus,
} from "./users.js";
import { HOME_DIR } from "./paths.js";

export const AUTH_PORT = Number(process.env.FLOW_AUTH_PORT ?? 18900);
export const AUTH_HOST = process.env.FLOW_AUTH_HOST ?? "127.0.0.1";
export const AUTH_PUBLIC_URL = process.env.FLOW_AUTH_PUBLIC_URL?.replace(/\/$/, "");

const ADMIN_SESSION_COOKIE = "__Host-flow_admin_session";
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const JSON_BODY_LIMIT = 8192;
const isExtensionOrigin = (origin: string | undefined): origin is string => /^chrome-extension:\/\/[a-p]{32}$/.test(origin ?? "");
const isLoopbackHost = (host: string) => ["127.0.0.1", "localhost", "[::1]", "::1"].includes(host.toLowerCase());

type Attempt = { count: number; resetsAt: number };
type AuthServerOptions = {
  host?: string;
  port?: number;
  allowedHosts?: string[];
  publicUrl?: string;
  adminUser?: string;
  adminPassword?: string;
  trustProxy?: boolean;
};

const json = (res: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
    ...headers,
  });
  res.end(JSON.stringify(data));
};

function readJson(req: IncomingMessage, limit = JSON_BODY_LIMIT): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        rejectBody(new Error("BODY_TOO_LARGE"));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => {
      if (size > limit) return;
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON_OBJECT_REQUIRED");
        resolveBody(parsed as Record<string, unknown>);
      } catch {
        rejectBody(new Error("INVALID_JSON"));
      }
    });
    req.on("error", rejectBody);
  });
}

function noContent(res: ServerResponse, headers: Record<string, string> = {}) {
  res.writeHead(204, { "cache-control": "no-store", ...headers });
  res.end();
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseCookie(req: IncomingMessage, cookieName: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === cookieName) return value.join("=");
  }
  return undefined;
}

function takeRateLimit(attempts: Map<string, Attempt>, key: string, now: number, max = 10): { allowed: boolean; retryAfter?: number } {
  if (attempts.size > 1000) {
    for (const [entryKey, entry] of attempts) if (entry.resetsAt <= now) attempts.delete(entryKey);
  }
  const previous = attempts.get(key);
  if (previous && previous.resetsAt > now && previous.count >= max) {
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((previous.resetsAt - now) / 1000)) };
  }
  if (!previous || previous.resetsAt <= now) attempts.set(key, { count: 1, resetsAt: now + 60_000 });
  else previous.count += 1;
  return { allowed: true };
}

function rateLimited(res: ServerResponse, retryAfter: number | undefined, message: string, headers: Record<string, string> = {}) {
  if (retryAfter) res.setHeader("retry-after", String(retryAfter));
  return json(res, 429, { error: message }, headers);
}

function adminHtml(fileName: string): Buffer | undefined {
  // The server can be launched from source or from dist/. Resolve from the module's
  // current directory first, then fall back to the installed source tree.
  const candidates = [
    resolve(dirname(fileURLToPath(import.meta.url)), "..", "studio", fileName),
    resolve(process.cwd(), "studio", fileName),
    resolve(process.cwd(), "..", "studio", fileName),
    resolve(HOME_DIR, "studio", fileName),
  ];
  for (const path of candidates) {
    try { if (existsSync(path)) return readFileSync(path); }
    catch { /* try the next known application root */ }
  }
  return undefined;
}

function sendHtml(res: ServerResponse, fileName: string) {
  const body = adminHtml(fileName);
  if (!body) return json(res, 404, { error: "Admin page not found." });
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
    "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  });
  res.end(body);
}

/**
 * Start the isolated account and device authentication service.
 * It deliberately has no MCP, Flow automation, upload, media, queue, or job routes.
 */
export async function startAuthServer(options: AuthServerOptions = {}): Promise<Server> {
  const host = options.host ?? AUTH_HOST;
  const port = options.port ?? AUTH_PORT;
  const publicUrl = (options.publicUrl ?? AUTH_PUBLIC_URL)?.replace(/\/$/, "");
  const adminUser = options.adminUser ?? process.env.FLOW_AUTH_ADMIN_USER ?? process.env.FLOW_MCP_ADMIN_USER ?? "";
  const adminPassword = options.adminPassword ?? process.env.FLOW_AUTH_ADMIN_PASSWORD ?? process.env.FLOW_MCP_ADMIN_PASSWORD ?? "";
  const trustProxy = options.trustProxy ?? (process.env.FLOW_AUTH_TRUST_PROXY === "true" || process.env.FLOW_MCP_TRUST_PROXY === "true");
  const localOnly = isLoopbackHost(host);
  const configuredHosts = options.allowedHosts ?? (process.env.FLOW_AUTH_ALLOWED_HOSTS ?? "")
    .split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
  const allowedHosts = new Set((configuredHosts.length ? configuredHosts : [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`])
    .map(value => value.toLowerCase()));

  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("FLOW_AUTH_PORT must be a valid TCP port.");
  if (!localOnly) {
    if (!process.env.FLOW_AUTH_ALLOWED_HOSTS && !options.allowedHosts) throw new Error("Set FLOW_AUTH_ALLOWED_HOSTS before binding the auth service to a non-local address.");
    if (!adminUser || adminPassword.length < 16) throw new Error("Set FLOW_AUTH_ADMIN_USER and a FLOW_AUTH_ADMIN_PASSWORD of at least 16 characters for a public auth service.");
    if (!publicUrl?.startsWith("https://")) throw new Error("Set FLOW_AUTH_PUBLIC_URL to the HTTPS URL used by the reverse proxy.");
  }

  const loginAttempts = new Map<string, Attempt>();
  const deviceLoginAttempts = new Map<string, Attempt>();
  const pairAttempts = new Map<string, Attempt>();
  const sessions = new Map<string, { username: string; expiresAt: number }>();

  const trustedClientIp = (req: IncomingMessage): string => {
    const forwarded = req.headers["cf-connecting-ip"] ?? req.headers["x-forwarded-for"]?.toString().split(",")[0].trim();
    return trustProxy && forwarded ? forwarded.toString() : req.socket.remoteAddress ?? "unknown";
  };
  const sameOriginAllowed = (req: IncomingMessage): boolean => {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      const expected = publicUrl ? new URL(publicUrl).origin : `http://${req.headers.host}`;
      return new URL(origin).origin === expected;
    } catch { return false; }
  };
  const extensionCors = (origin: string) => ({
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-max-age": "600",
    "access-control-allow-private-network": "true",
    vary: "Origin",
  });
  const extensionRoute = (pathname: string) => pathname === "/api/device/login" || pathname === "/api/pair" || pathname === "/api/user/me" || /^\/api\/user\/devices\/[0-9a-f-]+\/revoke$/i.test(pathname);
  const corsFor = (req: IncomingMessage): Record<string, string> => isExtensionOrigin(req.headers.origin) && extensionRoute(new URL(req.url ?? "/", `http://${req.headers.host}`).pathname)
    ? extensionCors(req.headers.origin)
    : {};
  const originAllowed = (req: IncomingMessage, allowExtension: boolean): boolean => {
    const origin = req.headers.origin;
    if (!origin) return true;
    if (allowExtension && isExtensionOrigin(origin)) return true;
    return sameOriginAllowed(req);
  };
  const sessionFor = (req: IncomingMessage) => {
    const id = parseCookie(req, ADMIN_SESSION_COOKIE);
    if (!id) return undefined;
    const session = sessions.get(id);
    if (!session) return undefined;
    if (session.expiresAt <= Date.now()) {
      sessions.delete(id);
      return undefined;
    }
    return session;
  };
  const adminAuthenticated = (req: IncomingMessage): boolean => {
    if (localOnly || sessionFor(req)) return true;
    const encoded = req.headers.authorization?.match(/^Basic\s+(.+)$/i)?.[1];
    if (!encoded || !adminUser || !adminPassword) return false;
    let decoded = "";
    try { decoded = Buffer.from(encoded, "base64").toString("utf8"); }
    catch { return false; }
    const splitAt = decoded.indexOf(":");
    return splitAt >= 0 && safeEqual(decoded.slice(0, splitAt), adminUser) && safeEqual(decoded.slice(splitAt + 1), adminPassword);
  };
  const requireAdmin = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (adminAuthenticated(req)) return true;
    json(res, 401, { error: "Admin authentication required." });
    return false;
  };
  const deviceFor = (req: IncomingMessage) => {
    const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    return token ? authenticateDevice(token) : undefined;
  };

  const server = createServer(async (req, res) => {
    try {
      const hostHeader = (req.headers.host ?? "").toLowerCase();
      if (!allowedHosts.has(hostHeader)) return json(res, 403, { error: "Bad host." });
      const url = new URL(req.url ?? "/", `http://${hostHeader}`);
      const cors = corsFor(req);

      if (req.method === "OPTIONS") {
        if (isExtensionOrigin(req.headers.origin) && extensionRoute(url.pathname)) return noContent(res, extensionCors(req.headers.origin));
        return json(res, 404, { error: "Not found." });
      }

      if (req.method === "GET" && url.pathname === "/api/health") {
        return json(res, 200, { name: "flow-auth", role: "auth" });
      }

      if (req.method === "GET" && url.pathname === "/api/auth/session") {
        const session = sessionFor(req);
        return localOnly || session
          ? json(res, 200, { authenticated: true, username: session?.username ?? adminUser, local: localOnly })
          : json(res, 401, { authenticated: false });
      }

      if (req.method === "POST" && url.pathname === "/api/auth/login") {
        if (localOnly) return json(res, 200, { ok: true });
        if (!sameOriginAllowed(req)) return json(res, 403, { error: "Request origin is not allowed." });
        const now = Date.now();
        const ip = trustedClientIp(req);
        const limit = takeRateLimit(loginAttempts, ip, now);
        if (!limit.allowed) return rateLimited(res, limit.retryAfter, "Quá nhiều lần đăng nhập. Hãy thử lại sau một phút.", cors);
        const body = await readJson(req);
        if (typeof body.username !== "string" || typeof body.password !== "string" || body.username.length > 256 || body.password.length > 1024) {
          return json(res, 400, { error: "Vui lòng nhập tên đăng nhập và mật khẩu." });
        }
        if (!safeEqual(body.username, adminUser) || !safeEqual(body.password, adminPassword)) return json(res, 401, { error: "Tên đăng nhập hoặc mật khẩu chưa đúng." });
        loginAttempts.delete(ip);
        if (sessions.size > 1000) for (const [id, session] of sessions) if (session.expiresAt <= now) sessions.delete(id);
        const sessionId = randomBytes(32).toString("base64url");
        sessions.set(sessionId, { username: adminUser, expiresAt: now + ADMIN_SESSION_TTL_MS });
        res.setHeader("set-cookie", `${ADMIN_SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${ADMIN_SESSION_TTL_MS / 1000}`);
        return json(res, 200, { ok: true });
      }

      if (req.method === "POST" && url.pathname === "/api/auth/logout") {
        if (!sameOriginAllowed(req)) return json(res, 403, { error: "Request origin is not allowed." });
        const sessionId = parseCookie(req, ADMIN_SESSION_COOKIE);
        if (sessionId) sessions.delete(sessionId);
        res.setHeader("set-cookie", `${ADMIN_SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
        return json(res, 200, { ok: true });
      }

      if (req.method === "POST" && url.pathname === "/api/device/login") {
        if (!originAllowed(req, true)) return json(res, 403, { error: "Request origin is not allowed." }, cors);
        const ip = trustedClientIp(req);
        const limit = takeRateLimit(deviceLoginAttempts, ip, Date.now());
        if (!limit.allowed) return rateLimited(res, limit.retryAfter, "Quá nhiều lần đăng nhập. Hãy thử lại sau một phút.", cors);
        const body = await readJson(req);
        if (typeof body.account !== "string" || typeof body.password !== "string" || typeof body.device_name !== "string" || body.account.length > 100 || body.password.length > 1024 || body.device_name.length > 256) {
          return json(res, 400, { error: "Vui lòng nhập tài khoản và mật khẩu." }, cors);
        }
        try {
          const device = loginDevice(body.account, body.password, body.device_name);
          deviceLoginAttempts.delete(ip);
          return json(res, 200, device, cors);
        } catch {
          return json(res, 401, { error: "Tài khoản hoặc mật khẩu chưa đúng, hoặc tài khoản đã bị khóa." }, cors);
        }
      }

      if (req.method === "POST" && url.pathname === "/api/pair") {
        if (!originAllowed(req, true)) return json(res, 403, { error: "Request origin is not allowed." }, cors);
        const ip = trustedClientIp(req);
        const limit = takeRateLimit(pairAttempts, ip, Date.now());
        if (!limit.allowed) return rateLimited(res, limit.retryAfter, "Too many pairing attempts. Try again in a minute.", cors);
        const body = await readJson(req);
        if (typeof body.user_code !== "string" || body.user_code.length > 100 || typeof body.device_name !== "string" || body.device_name.length > 256) {
          return json(res, 400, { error: "user_code and device_name are required." }, cors);
        }
        try { return json(res, 200, pairDevice(body.user_code, body.device_name), cors); }
        catch { return json(res, 401, { error: "Invalid or disabled pairing code." }, cors); }
      }

      if (req.method === "GET" && url.pathname === "/api/user/me") {
        if (!originAllowed(req, true)) return json(res, 403, { error: "Request origin is not allowed." }, cors);
        const device = deviceFor(req);
        return device
          ? json(res, 200, { ...device, devices: listDevicesForUser(device.user_id) }, cors)
          : json(res, 401, { error: "Valid device bearer token required." }, cors);
      }

      const ownDeviceRevoke = url.pathname.match(/^\/api\/user\/devices\/([0-9a-f-]{36})\/revoke$/i);
      if (req.method === "POST" && ownDeviceRevoke) {
        if (!originAllowed(req, true)) return json(res, 403, { error: "Request origin is not allowed." }, cors);
        const device = deviceFor(req);
        if (!device) return json(res, 401, { error: "Valid device bearer token required." }, cors);
        const revoked = revokeDevice(device.user_id, ownDeviceRevoke[1]);
        return json(res, revoked ? 200 : 404, { ok: revoked }, cors);
      }

      if (url.pathname === "/api/admin/users" || url.pathname.startsWith("/api/admin/users/")) {
        if (!requireAdmin(req, res)) return;
        if (req.method !== "GET" && !sameOriginAllowed(req)) return json(res, 403, { error: "Request origin is not allowed." });
        if (req.method === "GET" && url.pathname === "/api/admin/users") return json(res, 200, { users: listUsers() });
        if (req.method === "POST" && url.pathname === "/api/admin/users") {
          const body = await readJson(req);
          if (typeof body.label !== "string" || body.label.length > 100) return json(res, 400, { error: "label is required." });
          try { return json(res, 201, createUser(body.label)); }
          catch (error) { return json(res, 409, { error: error instanceof Error ? error.message : "Could not create user." }); }
        }

        const passwordRoute = url.pathname.match(/^\/api\/admin\/users\/([0-9a-f-]{36})\/password$/i);
        if (req.method === "POST" && passwordRoute) {
          const body = await readJson(req);
          if (typeof body.password !== "string" || body.password.length < 12 || body.password.length > 1024) return json(res, 400, { error: "Mật khẩu phải có từ 12 ký tự trở lên." });
          try {
            setUserPassword(passwordRoute[1], body.password);
            return json(res, 200, { ok: true, login_enabled: true });
          } catch { return json(res, 404, { error: "Không tìm thấy người dùng đang hoạt động." }); }
        }

        const actionRoute = url.pathname.match(/^\/api\/admin\/users\/([0-9a-f-]{36})\/(rotate-code|status)$/i);
        if (req.method === "POST" && actionRoute) {
          const [, userId, action] = actionRoute;
          if (action.toLowerCase() === "rotate-code") {
            try { return json(res, 200, rotatePairingCode(userId)); }
            catch { return json(res, 404, { error: "Active user not found." }); }
          }
          const body = await readJson(req);
          if (body.status !== "active" && body.status !== "disabled") return json(res, 400, { error: "status must be active or disabled." });
          try {
            setUserStatus(userId, body.status);
            return json(res, 200, { ok: true });
          } catch { return json(res, 404, { error: "User not found." }); }
        }

        const adminRevoke = url.pathname.match(/^\/api\/admin\/users\/([0-9a-f-]{36})\/devices\/([0-9a-f-]{36})\/revoke$/i);
        if (req.method === "POST" && adminRevoke) {
          const revoked = revokeDevice(adminRevoke[1], adminRevoke[2]);
          return json(res, revoked ? 200 : 404, { ok: revoked });
        }

        const devicesRoute = url.pathname.match(/^\/api\/admin\/users\/([0-9a-f-]{36})\/devices$/i);
        if (req.method === "GET" && devicesRoute) return json(res, 200, { devices: listDevicesForUser(devicesRoute[1]) });
        return json(res, 404, { error: "Not found." });
      }

      if (req.method === "GET" && url.pathname === "/") {
        return sendHtml(res, localOnly || sessionFor(req) ? "admin.html" : "login.html");
      }
      if (req.method === "GET" && url.pathname === "/admin") {
        if (!localOnly && !sessionFor(req)) {
          res.writeHead(302, { location: "/", "cache-control": "no-store" });
          return res.end();
        }
        return sendHtml(res, "admin.html");
      }
      if (req.method === "GET" && url.pathname === "/favicon.ico") return noContent(res);
      return json(res, 404, { error: "Not found." });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "BODY_TOO_LARGE") return json(res, 413, { error: "Request body is too large." });
      if (message === "INVALID_JSON" || message === "JSON_OBJECT_REQUIRED") return json(res, 400, { error: "Request body must be a valid JSON object." });
      if (!res.headersSent && !res.writableEnded) return json(res, 500, { error: "Authentication request failed." });
      if (!res.writableEnded) res.destroy();
    }
  });

  server.requestTimeout = 30_000;
  server.headersTimeout = 35_000;
  server.keepAliveTimeout = 5_000;
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  return server;
}

const invokedFile = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedFile) {
  const server = await startAuthServer();
  console.log(`Flow Auth listening at http://${AUTH_HOST}:${AUTH_PORT}${AUTH_PUBLIC_URL ? ` (${AUTH_PUBLIC_URL})` : ""}`);
  const stop = () => server.close(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
