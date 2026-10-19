# Native Flow MCP architecture

This repository is an isolated experimental fork of Flow MCP Connector. It preserves the current MCP tools, queue, Studio, and local file handling while separating browser integration into extension layers.

## Layout

- `src/` — existing MCP server, job orchestration, Flow workflow logic, and local media processing. The current Playwright-backed driver is preserved as a working baseline.
- `extension/background/` — Manifest V3 service worker and localhost WebSocket command router.
- `extension/content/` — scripts injected into Flow pages. The activity overlay is retained; future Flow-specific command handlers belong here.
- `extension/ui/` — popup and options pages.
- `studio/` — local control panel.

## Migration direction

The target architecture keeps MCP schemas and job orchestration in the backend. The backend will send high-level Flow commands over the existing localhost WebSocket. The extension will execute page-specific operations and return progress/results. Playwright/CDP remains the fallback baseline until each operation has an equivalent implementation.

Migration should proceed incrementally: status and library reads, basic generation, download/file transfer, uploads/references, then agent/edit/continue flows. Keep backend-owned filesystem work (queue, retries, media assembly, output paths) in the server.

This repository has not yet replaced Playwright automation. It is a clean, separately initialized workspace for that implementation.
