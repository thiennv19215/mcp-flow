import { readFileSync } from "node:fs";
import type { Core } from "./core.js";
import { PORT, TOKEN_FILE } from "./server.js";

// Forwards tool calls to the local owner process when several MCP clients
// share one machine. Only the owner binds the port and drives the Flow tab
// (two live cores would double-charge generations); client processes relay
// through the owner's local API with the shared per-machine token. Paths
// need no translation: owner and clients are on the same filesystem.
export class RemoteCore implements Core {
  readonly baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = (baseUrl ?? `http://127.0.0.1:${PORT}`).replace(/\/$/, "");
  }

  private async request(method: string, args?: unknown): Promise<unknown> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    try { headers["x-flow-token"] = readFileSync(TOKEN_FILE, "utf8").trim(); } catch { /* the owner writes the token file before clients connect */ }
    const res = await fetch(`${this.baseUrl}/api/${method}`, {
      method: "POST",
      headers,
      body: JSON.stringify(args ?? {}),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(data.error ?? `flow-mcp backend answered ${res.status}`);
    return data;
  }

  status = (a: Parameters<Core["status"]>[0]) => this.request("status", a);
  observer_health = (a: Parameters<Core["observer_health"]>[0]) => this.request("observer_health", a);
  clear_prompt = (a: Parameters<Core["clear_prompt"]>[0]) => this.request("clear_prompt", a);
  generate = (a: Parameters<Core["generate"]>[0]) => this.request("generate", a);
  cancel = (a: Parameters<Core["cancel"]>[0]) => this.request("cancel", a);
  retry = (a: Parameters<Core["retry"]>[0]) => this.request("retry", a);
  assets = (a: Parameters<Core["assets"]>[0]) => this.request("assets", a);
  attach_references = (a: Parameters<Core["attach_references"]>[0]) => this.request("attach_references", a);
  clear_references = (a: Parameters<Core["clear_references"]>[0]) => this.request("clear_references", a);
  remove_reference_kind = (a: Parameters<Core["remove_reference_kind"]>[0]) => this.request("remove_reference_kind", a);
  upload_media = (a: Parameters<Core["upload_media"]>[0]) => this.request("upload_media", a);
  projects = () => this.request("projects", {});
  voice_options = () => this.request("voice_options", {});
  create_project = () => this.request("create_project", {});
  open_project = (a: Parameters<Core["open_project"]>[0]) => this.request("open_project", a);
  download = (a: Parameters<Core["download"]>[0]) => this.request("download", a);
  assemble = (a: Parameters<Core["assemble"]>[0]) => this.request("assemble", a);
  techniques = (a: Parameters<Core["techniques"]>[0]) => this.request("techniques", a);
  character = (a: Parameters<Core["character"]>[0]) => this.request("character", a);
  characters = () => this.request("characters", {});
  character_edit = (a: Parameters<Core["character_edit"]>[0]) => this.request("character_edit", a);
  edit = (a: Parameters<Core["edit"]>[0]) => this.request("edit", a);
  trash = (a: Parameters<Core["trash"]>[0]) => this.request("trash", a);
  rename_asset = (a: Parameters<Core["rename_asset"]>[0]) => this.request("rename_asset", a);
  discard = (a: Parameters<Core["discard"]>[0]) => this.request("discard", a);
  continue_shot = (a: Parameters<Core["continue_shot"]>[0]) => this.request("continue_shot", a);
  agent = (a: Parameters<Core["agent"]>[0]) => this.request("agent", a);
  outputs = () => this.request("outputs", {});

  async wait(a: Parameters<Core["wait"]>[0]): Promise<unknown> {
    const deadline = Date.now() + a.timeout_seconds * 1000;
    for (;;) {
      const left = Math.ceil((deadline - Date.now()) / 1000);
      const out = (await this.request("wait", { ...a, timeout_seconds: Math.max(5, Math.min(120, left)) })) as { finished: boolean };
      if (out.finished || left <= 120) return out;
    }
  }
}
