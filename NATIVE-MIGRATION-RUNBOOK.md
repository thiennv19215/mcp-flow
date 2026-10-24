# Native Flow operation runbook

The extension is the Flow page driver and owns its side-panel queue. The optional AI MCP is a separate local stdio process in `src/`; the local backend handles per-machine token authentication.

## Operation coverage

The local MCP connector carries request IDs, deadlines, progress events, capabilities, and structured errors for AI-originated operations. AI tools and the side panel share the extension's persistent queue. The extension owns scene planning, prompts, dependencies, generation, edits, continuation, Agent batches, character mutations, and Flow page interactions.

Uploads use Chrome's native file-input selection through DevTools Protocol, with validated image types, size limits, unique temporary names, and cleanup after Flow confirms processing. Chrome owns downloads; the extension completes each queued media download before advancing, then local MCP copies the already-downloaded file into the requested output directory. Queue state, retries, progress, pacing, and recovery remain in extension storage.

## Operational rules

- Do not replay a state-changing operation after a timeout or disconnect. Check Flow first because the UI may have accepted it.
- Reject an operation if the connector does not advertise its capability or the selected page is not a supported Flow project route.
- Treat a paid submit timeout as an unknown outcome and surface that state to the caller.
- Keep file staging bounded and clean up abandoned transfers.
- Keep the extension queue local to the browser and use its `flow.queue.*` bridge for AI-originated jobs. The MCP host owns AI-facing tool schemas and local file materialization, not a second Flow queue.

## Known limits

Named character references use `character:<name>` in `reference_images` or `flow_attach_references.references`. The latter only prepares the composer and returns `submitted: false`. Confirmed attachment means a unique selected option produced a matching ingredient-chip type; it does not mean a generation was submitted or completed. Character enumeration reads the Characters category in the same picker rather than navigating to the character editor. When no exact match exists or a name is ambiguous, attachment fails before submit.

Virtualized library scans are bounded and may omit items in very large projects. Local file selection requires the extension's Chrome debugger permission; if Chrome DevTools is already attached to the Flow tab, close it and retry. Long extension jobs require the Flow tab and extension service worker to remain available. AI MCP calls also require the local MCP process and connector. Browser downloads depend on Chrome's configured download directory.
