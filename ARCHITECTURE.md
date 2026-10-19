# Flow MCP architecture

MCP tools, validation, job queue, retries, local file handling, media assembly, and the Studio API run in the backend. The Chrome extension owns every interaction with the Flow page.

## Layout

- `src/` contains MCP tools, job orchestration, backend file transfer, Chrome download collection, and local media processing.
- `extension/background/` selects the Flow tab and keeps a localhost WebSocket connection to the backend.
- `extension/content/` resolves the Flow route to a page driver and implements Flow operations.
- `extension/ui/` contains the connector popup and settings.
- `studio/` contains the local control panel.

## Command path

An MCP tool creates or queues a backend job. The backend sends a capability-gated command with a request ID and deadline over WebSocket. The extension routes it to the selected tab, where the Flow V2 content driver checks the project context and executes the operation. Progress and structured results return over the same socket.

The backend retains credit policy, retries, job state, output naming, local file access, and media assembly. Uploads move in bounded checksummed chunks to the extension. Chrome owns browser downloads; the backend collects completed files and materializes the requested outputs. State-changing operations that time out are marked as uncertain and are never automatically replayed.

Native Flow handlers cover session and library reads, generation, asset download/rename/trash, character create/edit, video edit/continue, and Agent batches. Unsupported routes, capabilities, or inputs fail before operation dispatch.

## Limits

Asset and character scans have bounded virtualized-grid traversal. Local file selection is synthetic and may not satisfy every Flow upload state. Long-running commands depend on the Flow tab, extension service worker, backend, and WebSocket remaining available. After an uncertain submit or disconnect, inspect the Flow project before retrying.
