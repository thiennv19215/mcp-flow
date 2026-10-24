import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { shapes, type Core } from "./core.js";
import { PLAYBOOK } from "./playbook.js";

export type Task = { task_id: string; tool: string; started: string; status: "running" | "done" | "failed"; result?: unknown; error?: string };

// Slow-call results are kept so flow_wait/flow_status can answer for them,
// but a long-lived MCP process must not accumulate every result forever:
// beyond the cap the oldest entries are evicted (Map order is insertion
// order). An evicted id is later answered like a restarted process's id —
// its answer is gone, and flow_wait says so instead of inventing one.
export const MAX_RETAINED_TASKS = 100;
export function retainTask(map: Map<string, Task>, task: Task): void {
  map.set(task.task_id, task);
  while (map.size > MAX_RETAINED_TASKS) {
    const oldest = map.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

export function createFlowMcpServer(core: Core, studio?: string): McpServer {
const server = new McpServer({ name: "flow-mcp", version: "0.2.0" });

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const reply = async (work: Promise<unknown>, extra: object = {}): Promise<ToolResult> => {
  try {
    const data = await work;
    const body = Array.isArray(data) ? data : { ...extra, ...(data as object) };
    return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
  } catch (err) {
    return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }, null, 2) }], isError: true };
  }
};

// Most AI apps stop waiting on a tool after about a minute (the MCP default, and Codex's), but Flow is often slower: a
// character edit takes one to two minutes. The work carried on while the app reported "Request timed out", so finished
// work looked failed - and a shot was once paid for twice. No call holds on longer than this now; anything slower hands
// back a task id and keeps going, and flow_wait collects the answer.
// FLOW_MCP_PATIENCE_MS lowers it for an app with a shorter limit (and lets a test reach the slow path quickly).
const PATIENCE_MS = Number(process.env.FLOW_MCP_PATIENCE_MS ?? 45_000);
const WAIT_MS = Math.max(5_000, PATIENCE_MS - 5_000);
const tasks = new Map<string, Task>();

const patient = async (tool: string, work: Promise<unknown>): Promise<unknown> => {
  const task: Task = { task_id: `task-${randomUUID().slice(0, 8)}`, tool, started: new Date().toISOString(), status: "running" };
  const settled = work.then(
    (result) => {
      task.status = "done";
      task.result = result;
    },
    (err) => {
      task.status = "failed";
      task.error = err instanceof Error ? err.message : String(err);
    },
  );
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<"late">((r) => (timer = setTimeout(() => r("late"), PATIENCE_MS)));
  const first = await Promise.race([settled.then(() => "settled" as const), late]);
  clearTimeout(timer);
  if (first === "settled") return work;
  retainTask(tasks, task);
  return {
    still_working: true,
    task_id: task.task_id,
    note: `Flow is still on it - this is not a failure. Call flow_wait with job_ids ["${task.task_id}"] for the result, and do not call ${tool} again: the work has not stopped.`,
  };
};

// Task ids are answered from here, queued job ids by the queue; either way the call comes back inside the app's limit.
async function waitFor({ job_ids, timeout_seconds }: { job_ids?: string[]; timeout_seconds: number }): Promise<unknown> {
  const deadline = Date.now() + Math.min(timeout_seconds * 1000, WAIT_MS);
  const isTask = (id: string) => tasks.has(id) || id.startsWith("task-");
  const mine = (job_ids ?? []).filter(isTask);
  const jobs = job_ids?.filter((id) => !isTask(id));
  while (Date.now() < deadline && mine.some((id) => tasks.get(id)?.status === "running")) await new Promise((r) => setTimeout(r, 1000));
  // A task id this process never issued belongs to a tool process that has since restarted: its answer is gone, but the
  // work may well have happened, so say that instead of reporting it finished.
  const done = mine.map(
    (id) =>
      tasks.get(id) ?? {
        task_id: id,
        status: "unknown",
        note: "This tool restarted since that call, so its answer is lost. Check Flow (flow_assets, flow_characters) for what it did before running it again.",
      },
  );
  const tasksFinished = done.every((t) => t.status !== "running");
  if (mine.length && !jobs?.length) return { finished: tasksFinished, tasks: done };
  const left = Math.max(5, Math.floor((deadline - Date.now()) / 1000));
  const queued = (await core.wait({ job_ids: jobs, timeout_seconds: left })) as { finished: boolean };
  return mine.length ? { ...queued, finished: queued.finished && tasksFinished, tasks: done } : queued;
}

server.registerTool(
  "flow_observer_health",
  {
    title: "Check Flow request observer",
    description: "Check the Flow submit-request observer and make one bounded reinjection attempt if its XHR/fetch hooks were replaced. This does not navigate, click, attach media, or submit a generation request.",
    inputSchema: shapes.observer_health,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  (args) => reply(core.observer_health(args)),
);

server.registerTool(
  "flow_status",
  {
    title: "Flow status",
    description:
      "Check the Flow Chrome session (signed in, project open, visible generation credit quote) and the generation queue. Call this first; it says what the user must fix before generating, and returns the prompt playbook. It does not open the account menu to read the remaining credit balance.",
    inputSchema: shapes.status,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  (args) => reply(core.status(args), { studio, playbook: PLAYBOOK, ...(tasks.size ? { slow_calls: [...tasks.values()].map(({ result, ...t }) => t) } : {}) }),
);

server.registerTool(
  "flow_clear_prompt",
  {
    title: "Clear the exact Flow prompt",
    description: "Clear the prompt editor only when the active Flow project is verified, exactly one visible prompt control matches expected_prompt, and the local job queue is idle. References and picker state are preserved and verified.",
    inputSchema: shapes.clear_prompt,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(patient("flow_clear_prompt", core.clear_prompt(args))),
);

server.registerTool(
  "flow_projects",
  {
    title: "List Flow projects",
    description: "List the projects visible from Flow's home page. This is a read-only library lookup and does not open or create a project.",
    inputSchema: shapes.projects,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  () => reply(patient("flow_projects", core.projects())),
);

server.registerTool(
  "flow_create_project",
  {
    title: "Create a Flow project",
    description: "Create a new project from Flow's home page and return its confirmed project ID and URL. If the current tab is inside a project, Flow opens a temporary home tab for the creation. If Flow does not return a new project ID after the click, the result is marked unknown; check the project list before retrying.",
    inputSchema: shapes.create_project,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  () => reply(patient("flow_create_project", core.create_project())),
);

server.registerTool(
  "flow_open_project",
  {
    title: "Open a Flow project",
    description: "Open the specified existing Flow project by UUID in the connected Flow tab. Keeps the locale already active in Flow unless language is provided (for example, vi or en). Use flow_projects to find project IDs.",
    inputSchema: shapes.open_project,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  (args) => reply(patient("flow_open_project", core.open_project(args))),
);

server.registerTool(
  "flow_generate",
  {
    title: "Queue Flow generations",
    description:
      "Queue one clip or image per scene in the open Flow project. Runs one at a time with human-like pauses and spends the user's Google AI credits. Video scenes are checked against max_credits using Flow's own live quote before anything is spent (never assume a per-model price — Flow's quote is the only authoritative price); image scenes are submitted without a credit quote check. Returns job ids immediately; use flow_wait for results. A scene may set manual_submit=true to prepare its prompt and settings and wait for you to click Create in Flow; then choose Continue on the extension queue. A scene may set submit_only=true to finish after Flow's correlated request is dispatched, without waiting for render/download; flow_wait reports status=\"submitted\" and request_dispatched=true. Dispatch does not prove server acceptance or a finished result; server_acceptance_observed is reported separately.",
    inputSchema: shapes.generate,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(patient("flow_generate", core.generate(args))),
);

// The chatgpt_generate and run_workflow_graph input shapes live in
// schemas.ts alongside every other Core method shape: the generic HTTP
// bridge validates /api/<method> bodies against schemas, and RemoteCore
// forwards both surfaces to the owner like any other method.

server.registerTool(
  "chatgpt_generate",
  {
    title: "Generate an image with ChatGPT",
    description:
      "Queue one ChatGPT image generation in the signed-in ChatGPT tab (a separate provider from Flow: no project, no credits — the job view always reports credits as null). Returns the queued job immediately; use flow_wait or flow_status for the result and the downloaded file paths, and flow_cancel to cancel a job that has not started. Reference images must be payload records (base64/dataUrl/bytes); library or tile ids are not accepted.",
    inputSchema: shapes.chatgpt_generate,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(core.chatgpt_generate
    ? core.chatgpt_generate(args)
    : Promise.reject(new Error("chatgpt_generate is not available in this process: this core does not implement chatgpt_generate."))),
);

// FEAT-07: run a node-graph workflow. The extension's graph module
// validates, levels and compiles the graph into the same queue-job
// shapes the existing planners produce; the core forwards the document
// to the flow.queue.workflow bridge command. The Core interface declares
// run_workflow_graph as optional, so an absent method answers a clear
// error instead of a TypeError.
server.registerTool(
  "flow_run_workflow",
  {
    title: "Run a workflow graph",
    description:
      "Run a node-graph workflow on the generation queue. Nodes (text and image sources, Flow generate, ChatGPT, download, delay) are validated against the port-compatibility matrix, topologically leveled, and compiled into queue jobs with workflow metadata; each level is enqueued as its dependencies complete, and a node whose dependency failed is skipped together with everything downstream of it. Returns the run record and the first level's queued jobs; use flow_status or the run id to follow progress.",
    inputSchema: shapes.run_workflow_graph,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(core.run_workflow_graph
    ? core.run_workflow_graph(args)
    : Promise.reject(new Error("run_workflow_graph is not available in this process: this core does not implement run_workflow_graph yet. The extension bridge command flow.queue.workflow is ready for it."))),
);

server.registerTool(
  "flow_wait",
  {
    title: "Wait for Flow jobs",
    description:
      "Wait for queued jobs (default: all), or for the task_id of a call that answered still_working, then return their status, results and file paths. Comes back within about 40 s even when they are still running: call again until finished is true. If a job has manual_submit=true, finished remains false with status=waiting_for_user until you submit in Flow and continue the job from the extension queue.",
    inputSchema: shapes.wait,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  (args) => reply(waitFor(args)),
);

server.registerTool(
  "flow_cancel",
  {
    title: "Cancel a queued Flow job",
    description: "Cancel a job that has not started yet. A running generation cannot be cancelled.",
    inputSchema: shapes.cancel,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  (args) => reply(core.cancel(args)),
);

server.registerTool(
  "flow_retry",
  {
    title: "Retry failed Flow jobs",
    description: "Put failed jobs back in the queue with the same settings and file names (default: all failed jobs). Scenes already retry once on their own when Flow reports a failure. An image batch that finished with some images still failed (its job lists failed_scenes) is not run again whole: only those images are made again, saved under their own scene numbers.",
    inputSchema: shapes.retry,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(core.retry(args)),
);

server.registerTool(
  "flow_assets",
  {
    title: "List project media",
    description: "List the images and videos in the open Flow project (title and kind). Titles can be used as 'asset:<title>' in flow_generate or with flow_download.",
    inputSchema: shapes.assets,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  (args) => reply(patient("flow_assets", core.assets(args))),
);

server.registerTool(
  "flow_attach_references",
  {
    title: "Attach named references",
    description: "Attach saved characters or project images to the current Flow prompt without generating or spending credits. Use character:<name> to require a character, asset:<title> for project media. Returns confirmed attachment types.",
    inputSchema: shapes.attach_references,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  (args) => reply(patient("flow_attach_references", core.attach_references(args))),
);

server.registerTool(
  "flow_clear_references",
  {
    title: "Remove Flow prompt references",
    description: "Remove all image and character reference chips from the current Flow prompt while preserving prompt text. Each chip removal is confirmed with a bounded wait; fails if Flow does not visibly remove every reference.",
    inputSchema: shapes.clear_references,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  (args) => reply(patient("flow_clear_references", core.clear_references(args))),
);

server.registerTool(
  "flow_remove_reference_kind",
  {
    title: "Remove one kind of Flow prompt reference",
    description: "Remove only image, video, character, or voice chips of the selected kind from the current Flow prompt. Confirms each removal and verifies that prompt text and other chip kinds are preserved.",
    inputSchema: shapes.remove_reference_kind,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  (args) => reply(patient("flow_remove_reference_kind", core.remove_reference_kind(args))),
);

server.registerTool(
  "flow_upload_media",
  {
    title: "Upload media to Flow",
    description: "Upload one local image or video into the open Flow project's media library. Supports PNG, JPG, WebP, GIF, HEIC, HEIF, AVIF, MP4, MOV, WebM, AVI, MKV and 3GP; images up to 25 MiB and videos up to 200 MiB. Returns the uploaded title and kind for use with flow_assets or flow_generate.",
    inputSchema: shapes.upload_media,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(patient("flow_upload_media", core.upload_media(args))),
);

server.registerTool(
  "flow_download",
  {
    title: "Download existing project media",
    description:
      "Download media that already exists in the Flow project, without regenerating it (no credits, including 1080p/2K upscales). Matches by the start of the title.",
    inputSchema: shapes.download,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  (args) => reply(patient("flow_download", core.download(args))),
);

server.registerTool(
  "flow_agent_images",
  {
    title: "Fast image batch via Flow's agent",
    description:
      "Hand up to 50 image scenes to Flow's own Agent mode, which renders them all in parallel (about a minute for a whole batch) and enriches each prompt itself. Images only, 0 credits. Less exact than flow_generate: the agent picks the wording, no techniques/reference images, and file order is best-effort. Use flow_generate when every scene needs exact settings. Returns a job id; use flow_wait. Set submit_only=true to return after the correlated request dispatch without waiting for renders or downloads.",
    inputSchema: shapes.agent,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(patient("flow_agent_images", core.agent(args))),
);

server.registerTool(
  "flow_edit",
  {
    title: "Edit an existing video",
    description:
      "Video-to-video edit of a clip already in the Flow project (relight, change weather/background, remove or restyle objects) using Flow's edit view. Queued like a generation; use flow_wait for the file. Spends credits without a prior quote, so ask the user before calling. Set submit_only=true to return after the correlated request dispatch without waiting for rendering or download.",
    inputSchema: shapes.edit,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(patient("flow_edit", core.edit(args))),
);

server.registerTool(
  "flow_continue",
  {
    title: "Continue a clip, keeping a character attached",
    description:
      "Start a new clip from the last frame of one already in the project, for a continuous take across a cut. It saves the source clip's real final frame, animates it through Flow's agent mode, and downloads the result. mode 'exact' (default) gives an invisible join - the clip opens on the actual last frame - but attached characters are ignored, so the likeness must come from that frame; mode 'likeness' keeps a character or your avatar locked at the cost of an only-approximate opening frame. Flow cannot do both at once. Agent mode shows no credit quote beforehand, so ask the user before calling. Queued like a generation; use flow_wait for the file. Set submit_only=true to return after the correlated request dispatch without waiting for rendering or download.",
    inputSchema: shapes.continue_shot,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(patient("flow_continue", core.continue_shot(args))),
);

server.registerTool(
  "flow_trash",
  {
    title: "Move an item to Flow's Trash",
    description:
      "Move one image, video or scene in the open Flow project to Flow's Trash, by its exact title from flow_assets. Recoverable: Flow keeps it in Trash with a Restore button. Never deletes permanently. Flow asks no confirmation of its own, so confirm with the user before calling. Refuses if two items share the title.",
    inputSchema: shapes.trash,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(patient("flow_trash", core.trash(args))),
);

server.registerTool(
  "flow_asset_rename",
  {
    title: "Rename a Flow asset",
    description: "Rename one image, video, or scene in the open Flow project. Use the exact title from flow_assets; optionally include its UUID to guard against stale or mismatched titles. Refuses duplicate source titles and an already-used destination title. The rename must be verified in Flow before success is returned.",
    inputSchema: shapes.rename_asset,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  args => reply(patient("flow_asset_rename", core.rename_asset(args))),
);

server.registerTool(
  "flow_character",
  {
    title: "Create a reusable character",
    description:
      "Create a reusable Flow character (person, mascot, product) so it looks the same in every scene. Free. Give `describe` and Flow draws the portrait first, or `image` to use a picture you already have; optionally a personality and a stock voice. Afterwards pass 'asset:<name>' in a scene's reference_images.",
    inputSchema: shapes.character,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(patient("flow_character", core.character(args))),
);

server.registerTool(
  "flow_character_edit",
  {
    title: "Edit or rename an existing character",
    description:
      "Rename an existing character without changing its portrait, or change how it looks without creating a new one (Flow redraws the portrait in place, free). A rename is confirmed in Flow's Characters library. For a look change, save the new portrait to <films>/_cast; the character keeps its name, personality and voice. Pass `look` with the full updated description so scene prompts stop quoting the old one. With no `change` or `rename` it only saves the character's current portrait.",
    inputSchema: shapes.character_edit,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(patient("flow_character_edit", core.character_edit(args))),
);

server.registerTool(
  "flow_characters",
  {
    title: "List characters",
    description: "List the reusable characters in the open Flow project. Each includes its name and use_as reference; uuid is included only when Flow exposes a stable character UUID. The detailed Flow status reports whether the latest character scan completed successfully.",
    inputSchema: shapes.characters,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  () => reply(patient("flow_characters", core.characters())),
);

server.registerTool(
  "flow_techniques",
  {
    title: "Film technique presets",
    description:
      "List ready-made prompt phrases for camera moves, product shots, first→last-frame transitions and image commands. Pass an id as a scene's `technique` in flow_generate.",
    inputSchema: shapes.techniques,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  (args) => reply(core.techniques(args)),
);

server.registerTool(
  "flow_voice_options",
  {
    title: "Inspect Flow video voice options",
    description: "Read the exact voice labels currently visible in Flow's v2 composer picker. It opens the picker only when needed, never selects a voice or submits a generation, and closes only a picker it opened. These are Flow prompt voice chips for spoken dialogue in generated videos.",
    inputSchema: shapes.voice_options,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  () => reply(patient("flow_voice_options", core.voice_options())),
);

server.registerTool(
  "flow_assemble",
  {
    title: "Assemble clips into one video",
    description:
      "Join a project's downloaded scene clips in order into one MP4 (local ffmpeg, no credits). Keeps each clip's own sound and can lay a music track and a voiceover on top.",
    inputSchema: shapes.assemble,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  (args) => reply(patient("flow_assemble", core.assemble(args))),
);

return server;
}
