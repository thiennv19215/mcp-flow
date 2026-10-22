# Flow parity tasklist (DOM only)

This tasklist compares the current extension with `C:\Users\nguye\Downloads\1.3.103_0` and tracks implementation order. Flow actions must use the visible Flow page DOM. Do not add Flow API calls, private endpoints, or request replay. Keep existing uncommitted work intact.

## P0 — Recover safe Flow dialogs before the next queued task

**Status:** Partially implemented; P0 remains open pending the live popup signature and controls. `extension/src/content/providers/flow/core/navigation.js` handles identified Agent-instruction and safe informational dialogs, and no longer mistakes a recognized Settings panel's sole CDK backdrop for an unknown dialog. An unknown non-dialog overlay is only auto-closed when its content is not risky and exactly one visible, enabled Close/Dismiss or recognized close-icon candidate exists; unrelated buttons on the same surface do not by themselves block that unique candidate. The extension clicks the candidate through DOM and verifies the owning surface disappears. Other cases remain `FLOW_UNKNOWN_OVERLAY_BLOCKING`. The user screenshot shows only the queue error row, not the actual Flow popup or its controls, so it does not confirm the reported error is resolved or that the popup has a safely dismissible control. Do not add a generic unknown-overlay auto-click.

**Reference:** `src/core/flow/FlowPageDriver.js` preflight and the dedicated Agent instruction dialog handler in `content.js`. The 1.3.103 reference has known Agent cleanup and its legacy queue proceeds after terminal failures, but there is no universal unknown-dialog handler. Do not copy that queue-skip behavior into shared DOM: later jobs would touch the same blocked Flow page. `src/core/FlowWebRecovery.js` includes request/replay paths; those are out of scope.

**Target:** `extension/src/content/providers/flow/core/navigation.js`; queue behavior is in `extension/src/background/flow-job-queue.js` and user messaging in `extension/src/ui/flow-queue-panel.js`.

**Observed gap:** the native extension still pauses on `FLOW_UNKNOWN_OVERLAY_BLOCKING` when an unknown surface does not pass the narrow safe-close guard. The screenshot shows “An unrecognized Flow dialog is open. It was left …” on the queue error row, but not the underlying popup's text, role, DOM attributes, or buttons. It therefore cannot confirm that this specific popup has one safe Close/Dismiss button or recognized close icon; do not claim the user's reported error is resolved, arbitrary dialogs auto-dismiss, or unknown overlays are clicked generically.

**Implement:** identify only dialogs with a stable, specific Flow signature and one unambiguous, non-destructive dismissal control. For unknown non-dialog surfaces, consider visible/enabled controls and proceed only when exactly one candidate has an exact Close/Dismiss name or recognized close icon and the surface is not risky; this means exactly one safe candidate, not exactly one total button. Click through DOM and verify the same owning surface disappears before continuing the original not-yet-submitted operation. Keep bounded waits and honor task deadlines. A missing/ambiguous candidate, risky content, or failed verification remains `FLOW_UNKNOWN_OVERLAY_BLOCKING`; unknown dialogs, confirmations, delete/submit/payment actions, and any control that could save or dispatch work must remain untouched and explain the needed user action.

**Acceptance:** a recognized informational dialog closes and the same pre-submit task proceeds. An unknown non-dialog surface closes only when exactly one visible/enabled safe Close/Dismiss or recognized close-icon candidate exists (other controls may be present), its content passes the non-risky guard, and its owner is confirmed gone. If any guard fails, the surface remains open and `FLOW_UNKNOWN_OVERLAY_BLOCKING` pauses the queue; the task is not dispatched. The screenshot is only the queue error row and does not confirm the underlying popup meets the safe-close guard. No API or request replay is introduced.

## P1 — Keep queue progress isolated and actionable

**Status:** Narrow recovery implemented in `extension/src/background/flow-job-queue.js`; broader queue lifecycle behavior remains as described below.

The current queue pauses on page blockers and unknown outcomes, bounds retries to explicitly retryable pre-submit failures, keeps later jobs pending, prevents unknown-outcome replay, skips dependent tasks after a failed parent, and restores those descendants when the parent is safely retried. Before classifying an overlay blocker, preflight lets it settle for up to 2 seconds, bounded by the operation deadline. Only `FLOW_UNKNOWN_OVERLAY_BLOCKING` with an explicitly known not-dispatched outcome gets one immediate recheck of the same task, without the inter-task delay. If the blocker persists, the queue pauses and later jobs stay pending; Resume retries the blocked job first and resets its one-recheck budget. Ambiguous submit outcomes are never replayed. The queue panel marks the blocked job and explains whether Resume retries it or continues after manual inspection.

**Reference:** semantics in `src/core/BatchQueue.js`, `src/core/ExecutionTracker.js`, and DOM-safe parts of `src/core/FlowWebRecovery.js` only.

**Target:** `extension/src/background/flow-job-queue.js`, `extension/src/ui/flow-queue-panel.js`, `extension/src/content/providers/flow/generation/generation-operations.js`.

**Implement:** confirm bounded retries apply only to known pre-submit/transient failures; unknown submit outcome is never replayed. An unresolved shared-page blocker must prevent unsafe later DOM actions, while deterministic failure of one independent job should not strand unrelated pending jobs. Preserve dependencies: failed parents block dependent jobs, and a safe parent retry restores them only after success. A worker restart must not silently replay the interrupted job. Queue UI must say which job is blocked and what action is safe.

**Acceptance:** queue state remains durable; every running job reaches a terminal or explicit attention state; no unknown-outcome job auto-replays; independent jobs resume only after the shared page is safe; dependent jobs never run before their parent.

## P2 — Match visible model controls and capabilities

**Status:** Partially implemented. `settings.js` fails closed when the visible selector/options/selected model cannot be verified; versioned Veo/Imagen/Nano Banana matching requires exact version and exact `lite|fast|quality` tier equality in both chooser and video post-check. Tiered Veo labels do not inherit generic Veo capability claims and remain DOM/UI-authoritative until their settings are verified. Exact aspect-ratio choices are verified, and `video-settings.js` detects disabled Frames/Ingredients controls before submit. Omni quantity is capability-driven: the sidebar offers x1–x4, remembers the choice per model, and passes the selected count to the DOM queue. MCP scene validation enforces only explicit video `quantities` allowlists; it does not assert that Veo is limited to x1 without evidence. Live visible Flow DOM confirmed Omni 1.1 Flash and its current controls (16:9/9:16, 360p/720p, 4/6/8/10 seconds, x1–x4); the extension model label now matches `Omni 1.1 Flash`. The image-model inventory and per-tier Veo settings still need DOM confirmation before adding tier-specific capabilities to the extension UI.

**Reference:** model/settings and constraints in `sidebar.html` and `src/prompts/GenTab.js`.

**Target:** `extension/src/ui/sidebar.html`, `extension/src/ui/sidebar.js`, `extension/flow-model-capabilities.json`, `src/flow-capabilities.ts`, `extension/src/content/providers/flow/generation/image-settings.js`, `extension/src/content/providers/flow/generation/video-settings.js`, `extension/src/content/providers/flow/core/settings.js`.

**Implement:** compare model, aspect ratio, resolution, duration, quantity, input mode, and reference/frame compatibility against controls actually exposed in Flow DOM. Populate quantity choices from explicit video capability `quantities`, remember a valid selection per model, and pass it to the DOM queue. MCP scene validation rejects counts only when the matched video rule explicitly provides an allowlist; do not infer that Veo only supports x1. Keep versioned tier identity exact in model selection and post-check, while tiered Veo remains UI-authoritative until the tier's settings are confirmed. Keep labels and enabled states aligned; disable unsupported combinations with an explanation. Do not infer capability from APIs or stale reference implementation details.

**Acceptance:** each offered model option and setting can be selected and verified through DOM; Omni x1–x4 selection survives model changes and reaches the queue; explicit video quantity allowlists reject unsupported counts while rules without `quantities` make no x1-only claim; generic Veo 3.1 cannot match a Lite/Fast/Quality tier and post-check uses the same identity helper; invalid combinations are rejected before submit; no Flow API use. Model selection now satisfies the verification/fail-closed portion; dynamic inventory and setting parity remain open.

## P3 — Verify native video references

**Status:** Pending live picker confirmation. Static target code classifies Flow video tiles and video chips, but the extension picker filters video assets out, the sidebar drops `kind`, and generation accepts staged local images only. A DOM-only existing-library-video route may be possible; do not expose it until the live picker proves the exact selected media ID and resulting video chip. Local video upload and the reference's API-backed `video_reference`/video-edit route remain unsupported under the no-API scope.

**Reference:** `src/core/providers/FlowAdapter.js` and `src/prompts/GenTab.js` video-reference picker behavior.

**Target:** `extension/src/ui/reference-picker.js`, `extension/src/ui/sidebar.js`, `extension/src/content/providers/flow/composer/reference-actions.js`, `extension/src/content/providers/flow/generation/generation-operations.js`, `extension/flow-model-capabilities.json`.

**Observed gap:** extension Flow picker currently offers image assets and local `image/*` files. Existing DOM helpers can identify Flow video tiles and video chips, but the active native picker option type and exact video identity flow have not been confirmed live.

**Implement:** add video selection only if Flow's visible native picker/composer exposes it and the extension can verify both media kind and exact selected identity through DOM. Otherwise document that video references are unsupported in DOM mode.

**Acceptance:** no image is silently treated as a video or vice versa; selected media identity is confirmed before submit; no API route.

## P4 — Verify voice, character, Frames, and chaining combinations

**Status:** No further safe static fix was identified in this audit. DOM paths exist for chain dependencies, Frames, character identity, the global voice chip, and sequential reference assignment, but no live DOM verification was performed. Per-prompt `@voice`/`@character` parity from the reference depends on model-registry flags and the exact labels exposed by Flow's live picker, so it remains pending rather than being inferred. The existing chain x1 lock/restore/submit guard and voice picker placement remain implemented. No API route was added.

**Reference:** `src/shared/VoiceSelectModal.js`, `src/shared/CharacterSelectModal.js`, `src/shared/CharacterPicker.js`, and `src/prompts/GenTab.js`.

**Target:** `extension/src/ui/sidebar.html`, `extension/src/ui/sidebar.js`, `extension/src/content/providers/flow/composer/voice-actions.js`, `extension/src/content/providers/flow/generation/video-settings.js`, `extension/src/content/providers/flow/generation/native-frame-picker.js`, `extension/src/content/providers/flow/characters/flow-characters.js`, `extension/src/content/providers/flow/workflows/workflow-operations.js`, `extension/flow-model-capabilities.json`.

**Implement:** compare combinations against native Flow controls and keep existing identity checks/dependency guards. Add image-result chaining only if DOM can identify the exact newly generated tile and select that exact media. Do not parallel-submit multiple tasks through one shared composer when results cannot be correlated safely.

**Acceptance:** permitted combinations work through DOM; forbidden combinations are disabled before submit; failed parent tasks do not trigger dependent tasks; no ambiguous parallel submit or API-only chain.

## P5 — Finish remaining native Flow actions

**Status:** Most operation families are present. `flow.components.select` now normalizes non-voice references in `dom-operations.js` to the `assetName`/`kind` shape consumed by `FlowReferenceActions.parse/attach`, mapping object `name` aliases while preserving slot and expected ID checks. The focused audit found no broader unproven gap to add; other feature claims remain limited to verified DOM behavior.

**Reference:** operation inventory in `src/core/flow/FlowPageDriver.js` and DOM-backed `src/core/flow/drivers/FlowV2Driver.js`.

**Target:** `extension/src/content/providers/flow/workflows/workflow-operations.js`, `extension/src/content/providers/flow/library/library-operations.js`, `extension/src/content/providers/flow/media/media-menu.js`, `extension/src/content/providers/flow/characters/flow-characters.js`, `extension/src/content/providers/flow/agent/flow-agent.js` and the relevant sidebar controls.

**Implement:** add only verified DOM feature gaps. Existing project/library, download, rename/trash, character, Agent, edit/continue, and frame extraction flows should be retained and documented if equivalent.

**Acceptance:** every supported user-visible action maps to a DOM operation with a checked result; unsupported API-only reference actions are clearly excluded.

## P6 — Documentation and final parity inventory

**Status:** Dialog recovery and queue behavior have been documented. Remaining parity and DOM limitations are still pending.

**Target:** `extension/README.md`, `extension/QUEUE-BRIDGE.md`, `FLOW-E2E-PLAN.md`; update root `README.md` only when public behavior claims change.

**Implement:** document verified parity, DOM-only route, bounded retry and dialog recovery, unknown-outcome handling, model/mode limitations, and manual recovery for unclassifiable dialogs. Replace broad claims that every modal/dialog auto-closes with the verified-safe behavior.

**Acceptance:** docs match actual implementation and clearly distinguish confirmed behavior from items that require live Flow verification.

## Change sequence

Implement one file at a time. After each file, inspect its diff and preserve unrelated pre-existing edits before moving to the next file in this order: P0 navigation logic, P1 queue policy, P1 queue UI, P2 model/capability files, P3 video references, P4 combinations/chaining, P5 only proven action gaps, P6 documentation. Keep each change narrowly scoped and stop if the next task depends on a capability Flow does not expose in its DOM.
