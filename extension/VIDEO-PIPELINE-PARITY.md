# Video pipeline parity notes

Comparison of the reference extension's Google Flow **video creation**
pipeline against this repo's, and what was aligned. Reference build:
TobyFlow 1.3.103 (readable extraction, kept outside this repo).

## Reference video pipeline (stages)

1. **Gen form (GenTab)** — provider/model selects; video input type
   **Ingredients** or **Frames**; per-model duration tier + resolution from a
   data-driven model registry (`ModelRegistry`/`ProviderConfigManager`);
   multi-prompt drafts; per-prompt reference modes (`all` / `sequential` /
   `mention` / `none`); per-prompt frame slots (`frameFileIds`: first/last
   frame, from uploads or the Flow library); character (ingredients only),
   voice (ingredients only), style; chain-from-previous (text-to-video or
   Frames only).
2. **Upload (FileUploader / ImmediateUploader)** — local files go to a local
   store first; the content driver uploads to Flow when the job runs, opens
   the component picker (switching Frames→Ingredients first if the "+"
   trigger is hidden), clicks "Tải nội dung nghe nhìn lên" behind a
   slate-bridge file-picker trap, then confirms by tile-ID diff with a
   persistent-ID read from the tile container attributes.
3. **Prompt assembly** — `@mention` components resolve to attached media;
   references attach via the tile context menu ("Add to prompt") with a
   global menu lock and retries.
4. **Settings apply (FlowV2GenerationSettings → content driver)** — media
   type, aspect ratio, model, duration, resolution, output count, then the
   Ingredients/Frames mode with trigger-ID (`-trigger-VIDEO_FRAMES` /
   `-trigger-VIDEO_REFERENCES`) and icon fallbacks.
5. **Submit + tracking (FlowV2Editor / correlation observer / tile
   resolver)** — prompt inserted and verified, submit clicked, the Flow
   request correlated to new tiles, results followed to completion.
6. **Post** — downloads with a chosen video download resolution and
   watermark modes; chain/continue and edit flows reuse the saved media
   identity.

## This repo's equivalents

| Stage | Here |
| --- | --- |
| Gen form | `src/ui/sidebar.*` Gen tab + `flow-model-capabilities.json` registry |
| Upload | `FlowUploadClient` (sidebar) → `flow.media.upload` → `FlowUploader.uploadStagedMedia`, tile confirmation in `waitForNativeMediaTile` |
| Prompt assembly | `generation-operations.js` + `FlowReferenceActions.attach`, per-prompt ref modes, `FlowNativeFramePicker` for frame slots |
| Settings apply | `FlowVideoActions.prepare` (`video-settings.js`) over `FlowSettings` |
| Submit + tracking | `FlowEditor` submit + correlation observer + `FlowTiles` |
| Post | queue downloads, `flow.video.chain` / continue / edit operations |

Both frame references (Start/End) and ingredient references (≤3 media:
image, video, character, voice, style) are supported for Veo 3.1 (all tiers)
and Omni Flash; Frames and Ingredients stay mutually exclusive per job,
matching Flow itself.

## Aligned in this change

- **Tile identity for upload confirmation** — `mediaId()` now reads the
  persistent media ID from the tile container's
  `data-persistent-media-id`/`data-media-id` (then descendant wrappers)
  before src-derived IDs, mirroring the reference driver's
  `_getPersistentMediaId2` precedence; `collectAssets` falls back to the
  `persistentMediaId` it already resolves. Fixes uploads that reached the
  Flow library but could never be confirmed (blob:/UUID-less preview srcs).
- **Veo 3.1 tiers** — Lite/Fast/Quality added to the local capability
  registry (canonical `flow-model-capabilities.json` at the repo root, which
  the build syncs into `extension/`), the sidebar model selects, and
  capability validation: tiers previously skipped registry validation in
  the content script (`hasUnverifiedVeoTier`) and were unselectable in the
  panel. Tiers keep the Veo contract: fixed 8s, 16:9/9:16, ≤3 references,
  Frames supported.
- **Omni label matching** — `getModelAliases` accepts both "Omni Flash" and
  "Omni 1.1 Flash" picker labels in both directions.

## Queue logic comparison

The reference runs a two-layer design: persistent per-project **batches**
(admitted atomically after a full validation pass) feeding a serial
runtime queue. This repo's `FlowJobQueue` already matches or exceeds the
runtime half — sequential draining with randomized inter-job pacing,
bounded auto-retry for explicitly retryable pre-submit errors with the
failed job re-queued at the tail, unknown-outcome pause with an attention
record, page-blocker pause, dependency edges with skip propagation, and
checkpoint-based recovery after a worker restart.

The one missing piece was the admission half, now aligned:

- **Batch admission preflight** (`flow-queue-preflight.js`, wired into
  `FlowJobQueue.add`/`addBatch`): every generation job in a submission is
  validated against the local capability registry before any job is
  queued — frames/ingredients exclusivity, reference cap, and per-rule
  duration/resolution/aspect/frame support. Any failure rejects the whole
  submission with per-job problem codes; nothing is queued and no credits
  are spent. Deliberate differences from the reference: unknown models are
  not rejected (MCP callers may omit or name future models; the run-time
  content check decides), and an unreadable registry skips preflight
  instead of blocking the queue.
- **Item identity across enqueue**: the reference persists a mapping from
  batch items to runtime job IDs at admission so cross-item references
  stay valid. The panel handlers (`flow-queue:add` / `flow-queue:add-batch`)
  silently dropped client-assigned job IDs while the bridge path kept
  them, which orphaned every `dependsOnId` edge — chained videos from the
  panel ran their first prompt, then cancelled the rest as
  dependency-skipped. The panel handlers now forward job IDs like the
  bridge path does.

## Feature gaps (Flow + extension + queue, audited 2026-10-24)

The sidebar shell mirrors the reference's tabs, but several tabs are
visual ports without engines behind them. Verified by handler audit of
`src/ui/sidebar.js`:

**Generation / Flow features**
- No camera-angles generator (multi-view from one image), no effects
  presets, no Auto CapCut project builder (hidden shell button), no
  standalone prompt-assistant. The Tools tab buttons (Angles, watermark,
  CapCut) have no backing logic in the panel.
- No per-item settings overrides in panel batches (each prompt in a batch
  shares one settings snapshot; MCP-planned scenes can vary).
- Generation history is a local list only — no re-run/regenerate with the
  original settings from a history entry.

**Extension UI**
- Workflow tab is `module-pending` (blocked overlay): no visual workflow
  editor, workflow templates, or sharing. Workflow execution exists only
  as MCP-planned queue jobs.
- Templates tab and My Prompts are empty states: no user template
  library, no prompt snippets insertable into the Gen form.
- Photos tab albums are an empty state: no album organization of results.

**Queue / job submission**
- Saved batch drafts: IMPLEMENTED (2026-10-24, commit after this audit) —
  the panel composer can save a batch as a persistent draft and run/re-run
  it from the drafts list, with fresh job IDs and rewritten chain edges per
  run (`src/background/flow-batch-drafts.js`). Still missing versus the
  reference: per-item resume inside a partially-run batch (here a re-run
  starts the whole batch; failed items inside a run use the queue's own
  retry), and draft organization per project.
- No saved multi-task lists (named prompt sets with run-all) in the
  panel; the Tasks tab is the live queue view.
- No remote submission channel (the reference accepts jobs via
  Telegram/SSE remote control); submission here is panel + local MCP.

## Deliberately not ported

- The reference's **Flow API V2 driver** and its model/selector configs are
  delivered from the vendor's server with device-key authentication; they
  are not present in the readable build and this repo's plan already
  excludes depending on them. Generation here stays on the DOM/native path
  with the local capability registry.
- Server-side account/telemetry, remote control, and watermark removal are
  out of scope for the video creation pipeline.
