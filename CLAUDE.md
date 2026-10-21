# Repository notes

This project exposes Google Flow workflows through MCP and a local Studio panel. The backend owns schemas, job queues, credit limits, retry behavior, filesystem access, downloads, and media assembly. The Chrome extension is the only component that interacts with the Flow page.

## Runtime path

`src/server.ts` hosts the local API and extension WebSocket. `extension/src/background/service-worker.js` selects a Flow tab, reconnects to the backend, and routes capability-gated commands. `extension/src/content/` contains the Flow page driver and operation handlers. `npm run build` emits the installable extension to `dist/extension/`. Local uploads move to the page in bounded chunks; Chrome downloads are collected by the backend.

## Safety and workflow behavior

- Never automatically replay a generation or another state-changing operation after an uncertain result. Check Flow before retrying.
- Keep credit caps and queue ownership in the backend.
- Keep local file paths and media assembly in the backend; send file bytes to the extension only through the bounded transfer protocol.
- Update `ARCHITECTURE.md`, `EXTENSION-PORT.md`, and `NATIVE-MIGRATION-RUNBOOK.md` when changing the command protocol or operation responsibilities.

Start on Windows with **Start Flow.cmd**. The extension must be loaded in Chrome and connected to an open Flow project.
