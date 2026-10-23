#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Core } from "./core.js";
import { createFlowMcpServer } from "./mcp-tools.js";
import { RemoteCore } from "./remote.js";
import { PORT, PUBLIC_URL } from "./server.js";
import { startFlowServer } from "./bootstrap.js";

const { role, forwarding } = await startFlowServer();
const core: Core = role === "client" ? new RemoteCore() : forwarding;
const studio = role === "none" ? undefined : PUBLIC_URL ?? `http://127.0.0.1:${PORT}`;

const server = createFlowMcpServer(core, studio);
await server.connect(new StdioServerTransport());
