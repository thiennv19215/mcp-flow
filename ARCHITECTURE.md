# Architecture

Flow UI operations and the user-facing queue run in the Chrome extension. The VPS process is an isolated account/device verification service. AI clients can use a separate local stdio MCP process; it communicates with the local extension connector and does not use the VPS as a Flow relay. Extension source lives in `extension/src/`; `npm run build` packages a loadable extension at `dist/extension/` while the MCP build remains under `dist/`.

## Runtime boundaries

- `extension/src/background/` owns tab selection, shared queue persistence, Flow workflow planning, queue controls, and dispatch to the selected Flow tab.
- `extension/src/content/providers/flow/` owns page-level Flow actions, generation observation, references, uploads, library operations, and workflow operations.
- `extension/src/ui/` contains the extension side panel and its queue UI. Side-panel jobs and AI MCP jobs use the same `chrome.storage.local` queue and run sequentially with the same pacing and recovery rules.
- `src/index.ts`, `src/mcp-tools.ts`, and `src/core.ts` form the optional local AI MCP process. `src/server.ts` provides its localhost bridge and local support APIs.
- `src/auth-server.ts` serves account login, device verification, and admin account/device management only. `src/serve.ts` is a compatibility entry point for this auth service. The auth server has no MCP, Flow command, upload, media, or job routes.

## Flow module ownership

`extension/src/content/providers/flow/core/flow-driver.js` routes each supported operation to one of six operation groups. Keep operation dispatch separate from the page actions that manipulate Flow's DOM:

| Domain | Operation/API layer | DOM/action layer | Responsibility |
| --- | --- | --- | --- |
| Prompt | `extension/src/content/providers/flow/composer/prompt-operations.js` | `extension/src/content/providers/flow/composer/flow-editor.js` | Clear prompt text by expected value, insert/verify generation prompts, validate editor/project context, and preserve reference chips when requested. |
| References and voices | `extension/src/content/providers/flow/composer/reference-operations.js` | `extension/src/content/providers/flow/composer/reference-actions.js`, `extension/src/content/providers/flow/composer/voice-actions.js` | Attach references one at a time, clear reference chips, inspect picker state, verify selected chip/media identity, and enumerate/select voices. |
| Upload | `extension/src/content/providers/flow/media/upload-operations.js` | `native-file-transfer.js`, `extension/src/content/providers/flow/media/uploader.js` | Receive and assemble MCP file chunks, preflight the page, then use Flow's file input/dropzone and verify the uploaded media. |
| Image generation | `extension/src/content/providers/flow/generation/generation-operations.js` | `extension/src/content/providers/flow/generation/image-settings.js`, `extension/src/content/providers/flow/composer/flow-editor.js`, `extension/src/content/providers/flow/generation/tiles.js` | Prepare image-specific settings (also used for character portraits), submit through the shared generation lifecycle, correlate dispatch, and observe output. |
| Video generation | `extension/src/content/providers/flow/generation/generation-operations.js` | `extension/src/content/providers/flow/generation/video-settings.js`, `extension/src/content/providers/flow/generation/native-frame-picker.js`, `extension/src/content/providers/flow/composer/flow-editor.js`, `extension/src/content/providers/flow/generation/tiles.js` | Prepare video settings and Ingredients/Frames mode, select start/end frame assets where applicable, submit and observe through shared generation lifecycle. |
| Library/media | `extension/src/content/providers/flow/library/library-operations.js` | `extension/src/content/providers/flow/media/media-menu.js`, `extension/src/content/providers/flow/generation/tiles.js` | Read projects/assets/characters and perform media download, rename, or trash actions. |
| Multi-step workflows | `extension/src/content/providers/flow/workflows/workflow-operations.js` | `extension/src/content/providers/flow/characters/flow-characters.js`, `extension/src/content/providers/flow/agent/flow-agent.js`, generation/reference modules | Orchestrate character, edit, Agent, and continue workflows by invoking focused operations/actions. |

`extension/src/content/providers/flow/core/settings.js` supplies shared settings-panel primitives. `extension/src/content/providers/flow/compatibility/flow-components.js` is a compatibility facade for legacy callers; new business logic belongs in the domain module that owns the operation. `extension/src/content/providers/flow/core/flow-driver.js` should remain a router rather than accumulating selector logic or end-to-end workflows.

### Reference-aware generation lifecycle

For a generation request with references, the operation layer validates the request and editor context, clears existing reference chips while preserving the user's prompt, prepares image- or video-specific settings, then attaches each requested reference sequentially through the picker action layer. Each attach must verify the resulting chip/identity before proceeding; generation also checks the confirmed attachment count against the requested count, so a partial set fails before submit instead of silently proceeding. The supported picker limit is three references. The prompt is inserted and verified after reference selection so the chips remain intact. The flow then submits once and observes correlated dispatch/render evidence. Ambiguous picker state or a mismatch in attached references fails before submit; a timeout after possible submit is an unknown outcome and must not be automatically replayed.

Image creation and video creation share the submit/observe lifecycle but do not share mode-specific settings. Video frame selection is a separate slot-specific picker flow and must validate the asset identity for the selected Start/End slot.

### Selector updates and release versions

`flow-selectors.json` is the backend-managed selector configuration. `src/selectors.ts` watches its containing directory (including atomic editor saves), reloads the file, and broadcasts updates to connected extensions. The extension persists the received configuration in `chrome.storage.local`; `extension/src/content/providers/flow/core/selectors.js` merges it with local defaults. Existing selector keys can therefore be adjusted without rebuilding the extension. A new selector key needs a code default in `extension/src/content/providers/flow/core/selectors.js`, and a behavior change needs an extension code update/reload.

When shipping code changes, update both release identifiers: `package.json` for the package and `extension/manifest.json` for Chrome. The values are intentionally read from those files rather than duplicated here. Selector-only backend configuration changes do not require a package or extension version bump.

## Extension queue

The queue is serialized in extension storage. It persists operation payloads and progress, runs one item at a time, and lets the user pause, resume, stop, reorder, remove, or retry known-safe failures. A service-worker restart marks an interrupted operation as outcome-unknown and requires inspection in Flow before recovery; it is never automatically submitted again.

Queue execution calls the same content driver as direct extension operations. High-level batch planning, prompt additions, scene numbering, and dependency ordering run in extension-owned workflow planners. Reads may continue while a queue item runs; other state-changing tab operations wait until the current item finishes. Generation submit and observation are separate steps so a timeout after Flow accepts a request is reported as uncertain. The extension completes Chrome downloads before advancing a media job; local MCP copies the returned downloads to disk.

## MCP and authentication

The MCP server is optional and runs locally over stdio. Its tool schemas stay AI-facing, while queued Flow workflows are planned and executed by the extension through the local browser connector. Its tool files and runtime remain separate from the VPS auth entry point. The VPS is never in the Flow command path.

The extension calls the VPS only for account/device login and verification. Device records support revocation and account administration. `FLOW_AUTH_ALLOWED_HOSTS`, HTTPS, and admin credentials are required when the auth process binds beyond loopback. Deployment instructions are in [VPS-DEPLOYMENT.md](VPS-DEPLOYMENT.md).

## Flow constraints and recovery

The page driver validates supported operations and capability constraints before changing Flow. The extension uses Flow's visible UI and observation state for completion. If submission may have reached Flow but no completion can be confirmed, inspect the project before retrying to avoid duplicates.
