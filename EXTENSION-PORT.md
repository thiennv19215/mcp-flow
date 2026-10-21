# Flow MCP Connector

The Chrome extension is the only Flow browser driver. It connects to the backend over authenticated HTTPS long-poll requests, locally over localhost or remotely over HTTPS to a VPS. The backend keeps MCP tools, job orchestration, local files, downloads, and media assembly. WebSocket remains available as a compatibility fallback for older backends.

## Install or update

1. Build and start the backend or Studio at `http://127.0.0.1:18899`.
2. Load this repository's `extension/` directory as an unpacked extension, or reload it at `chrome://extensions`.
3. Open the existing signed-in Flow project tab. In the connector popup, click **Connect active Flow tab**.
4. Confirm the popup shows a backend connection and selected tab. `/api/health` reports the connector transport, protocol, and extension version on local deployments.

## Local extension development

For automatic reload while editing, load the repository's `extension/` folder once as an unpacked extension, then run `npm run dev:extension` from the repository root and leave it running. The watcher detects changes under `extension/`; Chrome reloads the extension and refreshes open Flow tabs automatically (the check runs on the extension's existing 30-second alarm). Stop it with Ctrl+C. This development helper uses `http://127.0.0.1:18898` on loopback.

To request that same idle-only reload without changing a source file, send `POST http://127.0.0.1:18898/reload` with `X-Flow-MCP-Reload: 1` (for example, `curl.exe -X POST -H "X-Flow-MCP-Reload: 1" http://127.0.0.1:18898/reload`). The watcher increments a persisted reload epoch; `/status.revision` changes with that epoch so older service workers detect it, while `/status.buildRevision` retains the exact extension-file fingerprint used by build diagnostics. New service workers adopt `/status.reloadKey` (equal to `revision`) before reloading, avoiding repeated reloads; the tab operation guard remains in force. The extension must already be loaded unpacked from this repository and the updated watcher must be running. A `202` means the epoch was recorded, not that Chrome has completed reloading; confirm the loaded background and Flow content revisions through the existing build diagnostic. Browser-origin requests are restricted to the extension origin and require the custom header; command-line clients can omit `Origin`.

The connector remembers the selected tab while you browse elsewhere. Use the popup to select another Flow tab. If multiple Flow tabs are open and none is selected, choose one explicitly.

## Transport and lifecycle

Commands use a backend queue delivered through a bounded HTTPS long poll. Results and progress return through authenticated HTTPS POSTs. Every operation is capability-gated and carries a request ID and deadline. The extension rejects unsupported operations before dispatch. The backend does not replay commands after delivery: a disconnect before delivery is safe to retry, while a disconnect after delivery is reported as an unknown outcome. Inspect Flow before retrying any operation whose result is uncertain, especially a paid generation.

The extension connects to the backend independently of whether a Flow tab is open. Flow commands require an open Flow tab, which the extension selects when a command arrives. For the VPS, the HTTPS URL is fixed in the extension. The user signs in with an account name and password; the backend returns a per-device token that the extension stores and sends in the Authorization header. The backend also accepts the existing WebSocket protocol while older deployments are being upgraded. Deploy the backend before updating the extension so both sides support protocol 3.

## File handling

Uploads are staged in temporary files, streamed to the extension in bounded, checksummed chunks, and reconstructed as a `File` in the Flow tab. The upload bridge arms before clicking Flow's Upload control, assigns the staged `File` with `DataTransfer` when Flow's file input opens, then dispatches the normal `input` and `change` events. Temporary staged files are removed after Flow confirms processing. Flow downloads are initiated in the tab and tracked through Chrome's downloads API. The backend collects the completed file, applies output names, and extracts ZIP takes when needed.

## Limits

Version 0.2.6 adds and verifies named-reference preparation, including reuse of a character already attached in the current prompt. Call `flow_attach_references` with `references: ["character:Name"]` to select a saved character and confirm its character ingredient chip without submitting or spending credits. `asset:Title` remains supported for media. Reload the extension and refresh Flow after updating content scripts; refresh alone can leave Chrome's cached unpacked-extension scripts in use.

Large virtualized Flow libraries may exceed the bounded scan. Long generation, upscale downloads, and Agent jobs depend on the browser tab, extension, backend, and socket remaining available. An interrupted paid operation may have completed in Flow even when the backend has not received its result; check the project before retrying.
