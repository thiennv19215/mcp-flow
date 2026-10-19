# Native Flow operation runbook

The extension is the sole Flow page driver. Backend MCP tools, job orchestration, local files, and media assembly remain in `src/`; Flow DOM interaction runs in the extension content driver.

## Operation coverage

The WebSocket command path carries request IDs, deadlines, progress events, capabilities, and structured errors. The extension handles Flow status and library reads, generation, downloads, rename/trash, characters, video editing and continuation, and Agent batches. Backend policy and output processing remain in place.

Uploads use Chrome's native file-input selection through DevTools Protocol, with validated image types, size limits, unique temporary names, and cleanup after Flow confirms processing. Chrome owns downloads; the backend collects completed downloads and creates the requested output paths. Media matching, retry policy, credit limits, scene matching, and local assembly remain backend responsibilities.

## Operational rules

- Do not replay a state-changing operation after a timeout or disconnect. Check Flow first because the UI may have accepted it.
- Reject an operation if the connector does not advertise its capability or the selected page is not a supported Flow project route.
- Treat a paid submit timeout as an unknown outcome and surface that state to the caller.
- Keep file staging bounded and clean up abandoned transfers.
- Keep backend queue ownership singular; sibling MCP processes should forward to the process that owns the localhost server.

## Known limits

Virtualized library scans are bounded and may omit items in very large projects. Local file selection requires the extension's Chrome debugger permission; if Chrome DevTools is already attached to the Flow tab, close it and retry. Long jobs require the Flow tab, extension, backend, and WebSocket to remain available. Browser downloads also depend on Chrome's configured download directory.
