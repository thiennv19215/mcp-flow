#!/usr/bin/env node
// Standalone Studio: runs the panel without Claude. If Claude's MCP process already serves it, just opens that.
import { PORT } from "./server.js";
import { openUrl } from "./platform.js";
import { startFlowServer } from "./bootstrap.js";

const { role } = await startFlowServer();
const url = `http://127.0.0.1:${PORT}`;
if (role === "none") {
  console.error(`Port ${PORT} is used by another program. Set FLOW_MCP_PORT to a free port.`);
  process.exit(1);
}
console.log(role === "owner" ? `Flow Studio running at ${url} (Ctrl+C to stop)` : `Flow Studio is already served by Claude's flow-mcp at ${url}`);
openUrl(url);
if (role === "client") process.exit(0);
