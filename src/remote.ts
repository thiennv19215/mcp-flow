import { existsSync, readFileSync, statSync } from "node:fs";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Core } from "./core.js";
import { PORT, TOKEN_FILE } from "./server.js";
import { OUTPUT_ROOT } from "./paths.js";

type RemoteSession = { baseUrl: string; deviceToken: string };
const REMOTE_UPLOAD_LIMIT = 200 * 1024 * 1024;
const REMOTE_DOWNLOAD_LIMIT = 512 * 1024 * 1024;
const UPLOAD_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".mp4", ".m4v", ".webm", ".mov", ".gif", ".mp3", ".wav", ".m4a", ".heic", ".heif", ".avif", ".avi", ".mkv", ".3gp"]);
const REMOTE_MEDIA_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".gif", ".jpg", ".jpeg", ".png", ".webp", ".m4a", ".mp3", ".wav", ".aiff", ".aif"]);
const inside = (file: string, dir: string) => resolve(file).startsWith(resolve(dir) + sep);

// Calls the local owner when several MCP clients share one machine. A device session instead
// routes the local MCP/Studio owner to the same per-device core used by the remote connector.
export class RemoteCore implements Core {
  readonly baseUrl: string;
  private deviceId?: string;
  private readonly stagedFiles = new Map<string, Promise<string>>();

  constructor(private readonly session?: RemoteSession) {
    this.baseUrl = (session?.baseUrl ?? `http://127.0.0.1:${PORT}`).replace(/\/$/, "");
  }

  private async request(method: string, args?: unknown): Promise<unknown> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.session) headers.authorization = `Bearer ${this.session.deviceToken}`;
    else headers["x-flow-token"] = readFileSync(TOKEN_FILE, "utf8").trim();
    const res = await fetch(`${this.baseUrl}/api/${method}`, {
      method: "POST",
      headers,
      body: JSON.stringify(args ?? {}),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(data.error ?? `flow-mcp backend answered ${res.status}`);
    return data;
  }

  private authorizationHeaders(): Record<string, string> {
    return this.session ? { authorization: `Bearer ${this.session.deviceToken}` } : { "x-flow-token": readFileSync(TOKEN_FILE, "utf8").trim() };
  }

  private async stageLocalPath(value: string): Promise<string> {
    // The role=client route talks to another owner on this same machine; its paths are already shared.
    if (!this.session) return value;
    if (!isAbsolute(value)) throw new Error(`Remote Flow input must be an absolute local file path or a Flow reference: ${value}`);
    const path = resolve(value);
    const info = statSync(path);
    if (!info.isFile()) throw new Error(`Remote Flow input is not a regular file: ${path}`);
    if (info.size < 1 || info.size > REMOTE_UPLOAD_LIMIT) throw new Error(`Remote Flow input must be non-empty and no larger than ${REMOTE_UPLOAD_LIMIT / 1024 / 1024} MiB.`);
    const extension = extname(path).toLowerCase();
    if (!UPLOAD_EXTENSIONS.has(extension)) throw new Error(`Unsupported remote Flow input type "${extension || "(no extension)"}".`);
    const key = `${path}\0${info.size}\0${info.mtimeMs}`;
    const cached = this.stagedFiles.get(key);
    if (cached) return cached;
    const pending = (async () => {
      const bytes = readFileSync(path);
      if (bytes.length !== info.size) throw new Error(`Remote Flow input changed while it was being staged: ${path}`);
      const url = new URL("/api/upload", `${this.baseUrl}/`);
      url.searchParams.set("name", basename(path));
      const response = await fetch(url, {
        method: "POST",
        headers: { ...this.authorizationHeaders(), "content-type": "application/octet-stream", "content-length": String(bytes.length) },
        body: bytes,
        signal: AbortSignal.timeout(180_000),
        cache: "no-store",
      });
      const result = await response.json().catch(() => ({})) as { path?: string; error?: string };
      if (!response.ok || typeof result.path !== "string") throw new Error(result.error ?? `Remote upload staging failed (HTTP ${response.status}).`);
      return result.path;
    })();
    this.stagedFiles.set(key, pending);
    try { return await pending; }
    catch (error) { this.stagedFiles.delete(key); throw error; }
  }

  private async stageReference(value: string): Promise<string> {
    if (/^(?:asset|character):/i.test(value)) return value;
    return this.stageLocalPath(value);
  }

  private localOutputRoot(): string {
    if (!this.session) return OUTPUT_ROOT;
    return this.deviceId ? join(OUTPUT_ROOT, "remote", this.deviceId) : join(OUTPUT_ROOT, "remote");
  }

  private remoteRelativePath(value: string): string | undefined {
    if (!this.deviceId) return;
    const parts = value.replace(/\\/g, "/").split("/").filter(Boolean);
    const index = parts.findIndex((part, i) => part === this.deviceId && parts[i - 2] === "users");
    if (index < 0) return;
    const relativeParts = parts.slice(index + 1);
    if (relativeParts.some(part => part === "." || part === ".." || part.includes("\0"))) return;
    return relativeParts.join("/");
  }

  private async materializeFile(remotePath: string, relativePath: string): Promise<string> {
    const root = this.localOutputRoot();
    const destination = resolve(root, ...relativePath.split("/"));
    if (!inside(destination, root)) throw new Error("Remote media path escapes the local output directory.");
    if (existsSync(destination)) return destination;
    const url = new URL("/media", `${this.baseUrl}/`);
    url.searchParams.set("path", remotePath);
    const response = await fetch(url, { headers: this.authorizationHeaders(), signal: AbortSignal.timeout(180_000), cache: "no-store" });
    if (!response.ok || !response.body) {
      const detail = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(detail.error ?? `Could not fetch remote Flow output (HTTP ${response.status}).`);
    }
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > REMOTE_DOWNLOAD_LIMIT) throw new Error(`Remote Flow output exceeds the ${REMOTE_DOWNLOAD_LIMIT / 1024 / 1024} MiB transfer limit.`);
    await mkdir(dirname(destination), { recursive: true });
    const temporary = `${destination}.${randomUUID()}.part`;
    let received = 0;
    const limit = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      callback(received > REMOTE_DOWNLOAD_LIMIT ? new Error("Remote Flow output exceeded the transfer limit.") : null, chunk);
    } });
    try {
      await pipeline(Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>), limit, createWriteStream(temporary, { flags: "wx" }));
      if (contentLength && received !== contentLength) throw new Error(`Remote Flow output was truncated (${received}/${contentLength} bytes).`);
      await rename(temporary, destination);
      return destination;
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  private async mapRemotePaths(value: unknown): Promise<unknown> {
    if (typeof value === "string") {
      const relative = this.remoteRelativePath(value);
      if (relative === undefined) return value;
      if (!relative) return this.localOutputRoot();
      const extension = extname(relative).toLowerCase();
      if (REMOTE_MEDIA_EXTENSIONS.has(extension)) return this.materializeFile(value, relative);
      return resolve(this.localOutputRoot(), ...relative.split("/"));
    }
    if (Array.isArray(value)) return Promise.all(value.map(item => this.mapRemotePaths(item)));
    if (value && typeof value === "object") {
      const mapped: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) mapped[key] = await this.mapRemotePaths(item);
      return mapped;
    }
    return value;
  }

  private async stagedRequest(method: string, args: Record<string, any>): Promise<unknown> {
    if (method === "generate") {
      const scenes = await Promise.all((args.scenes ?? []).map(async (scene: Record<string, any>) => ({
        ...scene,
        ...(scene.first_frame ? { first_frame: await this.stageReference(scene.first_frame) } : {}),
        ...(scene.last_frame ? { last_frame: await this.stageReference(scene.last_frame) } : {}),
        ...(scene.reference_images ? { reference_images: await Promise.all(scene.reference_images.map((value: string) => this.stageReference(value))) } : {}),
      })));
      return this.request(method, { ...args, scenes });
    }
    if (method === "upload_media") return this.request(method, { ...args, path: await this.stageLocalPath(args.path) });
    if (method === "character" && args.image && !/^(?:asset|character):/i.test(args.image)) {
      return this.request(method, { ...args, image: await this.stageLocalPath(args.image) });
    }
    if (method === "reangle" && args.reference_image && !/^(?:asset|character):/i.test(args.reference_image)) {
      return this.request(method, { ...args, reference_image: await this.stageLocalPath(args.reference_image) });
    }
    if (method === "assemble") {
      const clips = args.clips ? await Promise.all(args.clips.map((path: string) => this.stageLocalPath(path))) : undefined;
      const music = args.music ? await this.stageLocalPath(args.music) : undefined;
      const voiceover = args.voiceover ? await this.stageLocalPath(args.voiceover) : undefined;
      return this.request(method, { ...args, ...(clips ? { clips } : {}), ...(music ? { music } : {}), ...(voiceover ? { voiceover } : {}) });
    }
    return this.request(method, args);
  }

  async identifyDevice(): Promise<{ device_id: string; label: string }> {
    if (!this.session) throw new Error("A remote device session is required.");
    const res = await fetch(`${this.baseUrl}/api/user/me`, {
      headers: { authorization: `Bearer ${this.session.deviceToken}` },
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    const data = (await res.json().catch(() => ({}))) as { device_id?: string; label?: string; error?: string };
    if (!res.ok || typeof data.device_id !== "string" || typeof data.label !== "string") {
      throw new Error(data.error ?? `Remote device authentication failed (HTTP ${res.status}).`);
    }
    this.deviceId = data.device_id;
    return { device_id: data.device_id, label: data.label };
  }

  async status(a: Parameters<Core["status"]>[0]): Promise<unknown> {
    const result = await this.request("status", a) as Record<string, unknown>;
    const mapped = await this.mapRemotePaths(result) as Record<string, unknown>;
    return this.session ? { ...mapped, output_root: this.localOutputRoot() } : mapped;
  }
  async generate(a: Parameters<Core["generate"]>[0]): Promise<unknown> { return this.mapRemotePaths(await this.stagedRequest("generate", a)); }
  cancel = async (a: Parameters<Core["cancel"]>[0]) => this.mapRemotePaths(await this.request("cancel", a));
  retry = async (a: Parameters<Core["retry"]>[0]) => this.mapRemotePaths(await this.request("retry", a));
  assets = (a: Parameters<Core["assets"]>[0]) => this.request("assets", a);
  attach_references = (a: Parameters<Core["attach_references"]>[0]) => this.request("attach_references", a);
  upload_media = (a: Parameters<Core["upload_media"]>[0]) => this.stagedRequest("upload_media", a);
  projects = () => this.request("projects", {});
  open_project = (a: Parameters<Core["open_project"]>[0]) => this.request("open_project", a);
  download = async (a: Parameters<Core["download"]>[0]) => this.mapRemotePaths(await this.request("download", a));
  assemble = async (a: Parameters<Core["assemble"]>[0]) => this.mapRemotePaths(await this.stagedRequest("assemble", a));
  techniques = (a: Parameters<Core["techniques"]>[0]) => this.request("techniques", a);
  voices = () => this.request("voices", {});
  narrate = async (a: Parameters<Core["narrate"]>[0]) => this.mapRemotePaths(await this.request("narrate", a));
  character = async (a: Parameters<Core["character"]>[0]) => this.mapRemotePaths(await this.stagedRequest("character", a));
  characters = () => this.request("characters", {});
  character_edit = async (a: Parameters<Core["character_edit"]>[0]) => this.mapRemotePaths(await this.request("character_edit", a));
  edit = async (a: Parameters<Core["edit"]>[0]) => this.mapRemotePaths(await this.request("edit", a));
  trash = (a: Parameters<Core["trash"]>[0]) => this.request("trash", a);
  discard = (a: Parameters<Core["discard"]>[0]) => this.request("discard", a);
  set_key = (a: Parameters<Core["set_key"]>[0]) => this.request("set_key", a);
  continue_shot = async (a: Parameters<Core["continue_shot"]>[0]) => this.mapRemotePaths(await this.request("continue_shot", a));
  agent = async (a: Parameters<Core["agent"]>[0]) => this.mapRemotePaths(await this.request("agent", a));
  outputs = async () => this.mapRemotePaths(await this.request("outputs", {}));
  reangle = async (a: Parameters<Core["reangle"]>[0]) => this.mapRemotePaths(await this.stagedRequest("reangle", a));
  angle_presets = () => this.request("angle_presets", {});

  async wait(a: Parameters<Core["wait"]>[0]): Promise<unknown> {
    const deadline = Date.now() + a.timeout_seconds * 1000;
    for (;;) {
      const left = Math.ceil((deadline - Date.now()) / 1000);
      const out = (await this.request("wait", { ...a, timeout_seconds: Math.max(5, Math.min(120, left)) })) as { finished: boolean };
      const mapped = await this.mapRemotePaths(out) as { finished: boolean };
      if (mapped.finished || left <= 120) return mapped;
    }
  }
}

export class ForwardingCore implements Core {
  private remote?: RemoteCore;

  constructor(private readonly local: Core) {}

  get remoteBaseUrl(): string | undefined {
    return this.remote?.baseUrl;
  }

  async connectRemote(baseUrl: string, deviceToken: string): Promise<{ device_id: string; label: string }> {
    const candidate = new RemoteCore({ baseUrl, deviceToken });
    const identity = await candidate.identifyDevice();
    this.remote = candidate;
    return identity;
  }

  private active(): Core {
    return this.remote ?? this.local;
  }

  async status(a: Parameters<Core["status"]>[0]): Promise<unknown> {
    const result = await this.active().status(a);
    if (!this.remote || !result || typeof result !== "object" || Array.isArray(result)) return result;
    return { ...(result as object), studio: this.remoteBaseUrl };
  }
  generate = (a: Parameters<Core["generate"]>[0]) => this.active().generate(a);
  wait = (a: Parameters<Core["wait"]>[0]) => this.active().wait(a);
  cancel = (a: Parameters<Core["cancel"]>[0]) => this.active().cancel(a);
  retry = (a: Parameters<Core["retry"]>[0]) => this.active().retry(a);
  assets = (a: Parameters<Core["assets"]>[0]) => this.active().assets(a);
  attach_references = (a: Parameters<Core["attach_references"]>[0]) => this.active().attach_references(a);
  upload_media = (a: Parameters<Core["upload_media"]>[0]) => this.active().upload_media(a);
  projects = () => this.active().projects();
  open_project = (a: Parameters<Core["open_project"]>[0]) => this.active().open_project(a);
  download = (a: Parameters<Core["download"]>[0]) => this.active().download(a);
  assemble = (a: Parameters<Core["assemble"]>[0]) => this.active().assemble(a);
  techniques = (a: Parameters<Core["techniques"]>[0]) => this.active().techniques(a);
  voices = () => this.active().voices();
  narrate = (a: Parameters<Core["narrate"]>[0]) => this.active().narrate(a);
  character = (a: Parameters<Core["character"]>[0]) => this.active().character(a);
  characters = () => this.active().characters();
  character_edit = (a: Parameters<Core["character_edit"]>[0]) => this.active().character_edit(a);
  edit = (a: Parameters<Core["edit"]>[0]) => this.active().edit(a);
  trash = (a: Parameters<Core["trash"]>[0]) => this.active().trash(a);
  // discard is a local filesystem action; remote outputs are materialized under this owner's OUTPUT_ROOT first.
  discard = (a: Parameters<Core["discard"]>[0]) => this.local.discard(a);
  set_key = (a: Parameters<Core["set_key"]>[0]) => this.active().set_key(a);
  continue_shot = (a: Parameters<Core["continue_shot"]>[0]) => this.active().continue_shot(a);
  agent = (a: Parameters<Core["agent"]>[0]) => this.active().agent(a);
  outputs = () => this.active().outputs();
  reangle = (a: Parameters<Core["reangle"]>[0]) => this.active().reangle(a);
  angle_presets = () => this.active().angle_presets();
}
