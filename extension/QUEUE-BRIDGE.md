# Local MCP to extension queue contract

The local MCP connector can operate on the same persistent queue used by the extension side panel. It sends a normal `flow.dom.execute` connector command with `op: "flowOperation"`, one of the `flow.queue.*` names below, and the matching `flow.native.queue.*` capability. The service worker handles these queue operations before sending any command to the Flow page.

Queue bridge operations are accepted only from the local MCP connector path. Extension page queue controls continue to use `flow-queue:*` runtime messages and share the same `FlowJobQueue` instance.

## Enqueue

`flow.queue.add` accepts:

```js
{
  job: {
    id: "optional-client-id",
    operation: "flow.generation.submit",
    payload: { type: "image", prompt: "...", aspect_ratio: "16:9", variants: 1 },
    label: "optional label",
    metadata: { projectId: "...", sceneId: "..." }
  },
  autoStart: true
}
```

`job` may also be supplied as the payload itself. `autoStart` defaults to `true`; set it to `false` to stage the item without starting the queue. Supported job operations are `flow.generation.submit`, `flow.edit.run`, `flow.continue.run`, `flow.agent.batch`, `flow.character.create`, and `flow.character.edit`.

`job.metadata` is optional and additive. Any JSON-serializable value is preserved on the persisted job and returned unchanged in job results and queue snapshots, so callers can associate queue items with project, scene, or other labels. For compatibility, metadata may also be supplied as `job.data.metadata`.

The result is `{ job, snapshot }`. `job.id` is the persistent queue ID; use it with get/wait/cancel/retry. The queue keeps the side panel's sequential execution, pacing, progress, and unknown-outcome handling.

## Extension-owned workflow planning

MCP callers should use `flow.queue.generate`, `flow.queue.edit`, `flow.queue.continue`, or `flow.queue.agent` for AI-requested workflows. These operations plan scene numbering, prompt additions, reference normalization, and per-project queue metadata inside the extension before enqueuing. They accept `output_dir` and `outputAssets` as local-output context; generation also accepts the Flow library as `knownAssets`, plus `characterLooks`, `techniques`, and `capabilityRegistry` inputs. `chain_previous` and `reference_previous` become dependency edges between queue jobs. Reordering that would put a dependent scene before its predecessor is rejected.

The high-level result returns `{ jobs, output_dir, batchId, snapshot }`. A job's `metadata` preserves its workflow context. Local MCP may materialize completed media into its own output folder and write those file paths back with `flow.queue.metadata`; the queue and generation workflow remain owned by the extension.

## Read and wait

- `flow.queue.get` with no `id` returns the full queue snapshot, including `jobs`/`items`, counts, and run state.
- `flow.queue.get` with `id` returns `{ job, queue }`; `job` is `null` if it is not present.
- `flow.queue.wait` requires `id` and accepts `timeoutMs` or `timeout_ms` (default 30 seconds, capped at 10 minutes). It returns `{ finished, job, snapshot }`. A timeout returns the current job with `finished: false`; a terminal job returns `finished: true`.

Terminal statuses are `completed`, `failed`, and `cancelled`. The job carries its result, progress, error code, `outcomeUnknown`, and `retrySafe` state where applicable.

## Cancel and retry

- `flow.queue.cancel` requires `id`. A pending job is marked `cancelled`. For a running job, the result has `cancelled: false` and `active: true`: the current Flow page action may continue, while later queue work stops after it reports its actual outcome. The API never claims an already-dispatched Flow action was undone.
- `flow.queue.retry` requires a failed job with `retrySafe: true`. Unknown outcomes and failures without explicit safe-to-retry state are rejected. For a completed Agent batch with confirmed missing scenes, it creates a new job containing only those scene numbers. A safe retry returns `{ job, snapshot }` and resumes the queue.
- `flow.queue.metadata` requires `id` and accepts `patch` to persist MCP-local materialization metadata such as downloaded output paths.

For jobs that have an `output_dir` and `file_stem`, the extension starts and completes Chrome downloads before it advances the queue. The result includes ordered `browserDownloads` records so the local MCP can copy those already-downloaded files into its output directory without touching the Flow page during a later queue item. A download error is recorded separately from generation success; retrying such a job would risk duplicate generation.

## Current payload shapes

- Generation: `{ type, prompt, aspect_ratio, variants, attachments, video_settings }`.
- Edit: `{ params: { edit_asset, prompt, ... } }`.
- Continue: `{ params: { continue_from, prompt, continue_mode, aspect_ratio, ... } }`.
- Agent batch: `{ params: { agent_scenes, aspect_ratio, ... } }`.
- Character create/edit: the corresponding existing Flow operation payload (`{ character: { name, describe, ... } }` for create).

The bridge translates the MCP workflow envelopes into the extension's queue jobs. Scene dependencies, project numbering, prompt additions, Flow actions, and retry decisions are owned by the extension. Local MCP remains the AI-facing MCP server and copies completed browser downloads into its configured local output folders; it does not send Flow work through the VPS backend.
