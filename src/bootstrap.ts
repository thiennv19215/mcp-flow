import { LocalCore } from "./core.js";
import { startServer } from "./server.js";

// Entry-point wiring for the MCP process (index.ts): one local core, and
// the local HTTP/WebSocket bridge the extension and sibling MCP client
// processes talk to.
export async function startFlowServer() {
  const local = new LocalCore();
  const role = await startServer(local);
  return { role, local };
}
