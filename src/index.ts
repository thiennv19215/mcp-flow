#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Core } from "./core.js";
import { createFlowMcpServer } from "./mcp-tools.js";
import { RemoteCore } from "./remote.js";
import { startFlowServer } from "./bootstrap.js";

const { role, local } = await startFlowServer();
const core: Core = role === "client" ? new RemoteCore() : local;

const server = createFlowMcpServer(core);
await server.connect(new StdioServerTransport());
