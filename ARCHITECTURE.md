# Architecture

Flow UI operations and the user-facing queue run in the Chrome extension. The VPS process is an isolated account/device verification service. AI clients can use a separate local stdio MCP process; it communicates with the local extension connector and does not use the VPS as a Flow relay.

## Runtime boundaries

- `extension/background/` owns tab selection, shared queue persistence, Flow workflow planning, queue controls, and dispatch to the selected Flow tab.
- `extension/content/providers/flow/` owns page-level Flow actions, generation observation, references, uploads, library operations, and workflow operations.
- `extension/ui/` contains the extension side panel and its queue UI. Side-panel jobs and AI MCP jobs use the same `chrome.storage.local` queue and run sequentially with the same pacing and recovery rules.
- `src/index.ts`, `src/mcp-tools.ts`, and `src/core.ts` form the optional local AI MCP process. `src/server.ts` provides its localhost bridge and local support APIs.
- `src/auth-server.ts` serves account login, device verification, and admin account/device management only. `src/serve.ts` is a compatibility entry point for this auth service. The auth server has no MCP, Flow command, upload, media, or job routes.

## Extension queue

The queue is serialized in extension storage. It persists operation payloads and progress, runs one item at a time, and lets the user pause, resume, stop, reorder, remove, or retry known-safe failures. A service-worker restart marks an interrupted operation as outcome-unknown and requires inspection in Flow before recovery; it is never automatically submitted again.

Queue execution calls the same content driver as direct extension operations. High-level batch planning, prompt additions, scene numbering, and dependency ordering run in extension-owned workflow planners. Reads may continue while a queue item runs; other state-changing tab operations wait until the current item finishes. Generation submit and observation are separate steps so a timeout after Flow accepts a request is reported as uncertain. The extension completes Chrome downloads before advancing a media job; local MCP copies the returned downloads to disk.

## MCP and authentication

The MCP server is optional and runs locally over stdio. Its tool schemas stay AI-facing, while queued Flow workflows are planned and executed by the extension through the local browser connector. Its tool files and runtime remain separate from the VPS auth entry point. The VPS is never in the Flow command path.

The extension calls the VPS only for account/device login and verification. Device records support revocation and account administration. `FLOW_AUTH_ALLOWED_HOSTS`, HTTPS, and admin credentials are required when the auth process binds beyond loopback. Deployment instructions are in [VPS-DEPLOYMENT.md](VPS-DEPLOYMENT.md).

## Flow constraints and recovery

The page driver validates supported operations and capability constraints before changing Flow. The extension uses Flow's visible UI and observation state for completion. If submission may have reached Flow but no completion can be confirmed, inspect the project before retrying to avoid duplicates.
