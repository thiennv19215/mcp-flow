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

## Admission preflight

Before a generation job (or any job of a batch) enters the queue, the queue validates the fields it specifies against the local model capability registry (`flow-model-capabilities.json`): generation type, frames-vs-ingredients exclusivity, the per-model reference cap, and — when the model has a registry rule — duration, resolution, aspect ratio, and frame support. A failing single add throws the specific `FLOW_QUEUE_PREFLIGHT_*` code; a failing batch throws with a `problems` list naming every offending job index, and **no** job from that batch is queued, so a batch never spends credits on its first prompts only to fail on a later impossible one. Jobs for other operations, jobs with models the registry does not know, and submissions made while the registry cannot be read are not blocked here; the content-side capability check at run time remains the backstop.

## Batch drafts

The queue panel can save a composed batch as a persistent draft instead of
queueing it (the composer's "Save draft" submit), and run or re-run it any
number of times from the drafts list under the queue. Drafts live in
`chrome.storage.local` (`flowMcpBatchDraftsV1`, managed by
`src/background/flow-batch-drafts.js`) and are served to extension pages via
`flow-batch:list|save|run|remove` messages. A draft stores the job inputs
(1–100 jobs, each with an operation) plus a label, timestamps, and a run
counter with the last run's batch id. Running a draft materializes fresh
queue jobs: every stored job ID is reminted and `dependsOnId` chain edges
are rewritten through the same mapping, so chained batches keep their order
and re-runs never collide with earlier runs. Single-job drafts go through
`add`, multi-job drafts through `addBatch` (so admission preflight applies
to the whole run before anything executes), and the queue resumes under the
same conditions as a panel batch submit.

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

Before each Flow page action, the native DOM driver checks for blocking overlays. It closes recognized pickers/menus and the exact Agent-instruction dialog through its unique semantic `Done` control. For an unknown non-dialog surface, it attempts a DOM close only when the surface is non-risky and exactly one visible, enabled candidate has an exact `Close`/`Dismiss` name or recognized close icon; other controls may be present. It then verifies that the owning surface disappeared before continuing the same not-yet-submitted job. Unknown, risky, or ambiguous surfaces remain blocked. Agent instruction copy is handled by its dedicated owner/control check before generic risky-word detection, so ordinary instructional text does not block its safe `Done` action. A CDK backdrop is treated as non-blocking only when one recognized Settings owner is the sole visible overlay; extra or orphan backdrops still block. The driver lets an overlay transition settle for up to 2 seconds, capped by the operation deadline, before classifying a blocker. Only `FLOW_UNKNOWN_OVERLAY_BLOCKING` with outcome confirmed not dispatched gets one immediate recheck of the same job without the inter-job delay. If the blocker remains, the shared page queue pauses and later jobs stay pending; after the user resolves it, Resume retries the blocked job first and resets its one-recheck budget. This does not auto-close a general unknown dialog. An unknown submit outcome remains failed and is never replayed; Resume continues with later independent pending jobs after the user inspects Flow.

For jobs that have an `output_dir` and `file_stem`, the extension starts and completes Chrome downloads before it advances the queue. The result includes ordered `browserDownloads` records so the local MCP can copy those already-downloaded files into its output directory without touching the Flow page during a later queue item. A download error is recorded separately from generation success; retrying such a job would risk duplicate generation.

## Current payload shapes

- Generation: `{ type, prompt, aspect_ratio, variants, attachments, video_settings }`.
- Edit: `{ params: { edit_asset, prompt, ... } }`.
- Continue: `{ params: { continue_from, prompt, continue_mode, aspect_ratio, ... } }`.
- Agent batch: `{ params: { agent_scenes, aspect_ratio, ... } }`.
- Character create/edit: the corresponding existing Flow operation payload (`{ character: { name, describe, ... } }` for create).

The bridge translates the MCP workflow envelopes into the extension's queue jobs. Scene dependencies, project numbering, prompt additions, Flow actions, and retry decisions are owned by the extension. Local MCP remains the AI-facing MCP server and copies completed browser downloads into its configured local output folders; it does not send Flow work through the VPS backend.
