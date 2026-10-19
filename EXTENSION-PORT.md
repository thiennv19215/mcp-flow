# Flow MCP Connector

The Chrome extension is the only Flow browser driver. The backend connects to it over a localhost WebSocket and keeps MCP tools, job orchestration, local files, downloads, and media assembly.

## Install or update

1. Build and start the backend or Studio at `http://127.0.0.1:18899`.
2. Load this repository's `extension/` directory as an unpacked extension, or reload it at `chrome://extensions`.
3. Open the existing signed-in Flow project tab. In the connector popup, click **Connect active Flow tab**.
4. Confirm the popup shows a WebSocket connection and selected tab. `/api/health` reports the connector protocol and extension version.

The connector remembers the selected tab while you browse elsewhere. Use the popup to select another Flow tab. If multiple Flow tabs are open and none is selected, choose one explicitly.

## Transport and lifecycle

Commands, progress, and results use one WebSocket. Every operation is capability-gated and carries a request ID and deadline. The extension rejects unsupported operations before dispatch. On disconnect, the backend rejects pending calls; it does not replay commands. Inspect Flow before retrying any operation whose result is uncertain, especially a paid generation.

The extension injects its content scripts into an already-open Flow tab when needed. It requires the selected tab to remain open and the extension to stay enabled. The backend binds to localhost and accepts WebSocket upgrades from a Chrome extension origin; no HTTP bridge transport is provided.

## File handling

Uploads are staged in temporary files, streamed to the extension in bounded, checksummed chunks, and reconstructed as a `File` in the Flow tab. The upload bridge arms before clicking Flow's Upload control, assigns the staged `File` with `DataTransfer` when Flow's file input opens, then dispatches the normal `input` and `change` events. Temporary staged files are removed after Flow confirms processing. Flow downloads are initiated in the tab and tracked through Chrome's downloads API. The backend collects the completed file, applies output names, and extracts ZIP takes when needed.

## Limits

Large virtualized Flow libraries may exceed the bounded scan. Long generation, upscale downloads, and Agent jobs depend on the browser tab, extension, backend, and socket remaining available. An interrupted paid operation may have completed in Flow even when the backend has not received its result; check the project before retrying.
