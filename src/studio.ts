#!/usr/bin/env node
// Standalone Studio: runs the panel without Claude. If Claude's MCP process already serves it, just opens that.
import { LocalCore } from "./core.js";
import { PORT, startServer } from "./server.js";
import { openUrl } from "./platform.js";
import { ForwardingCore } from "./remote.js";

const deviceCores = new Map<string, LocalCore>();
const local = new LocalCore();
const forwarding = new ForwardingCore(local);
const getDeviceCore = (deviceId: string): LocalCore => {
  let deviceCore = deviceCores.get(deviceId);
  if (!deviceCore) deviceCores.set(deviceId, (deviceCore = new LocalCore(deviceId)));
  return deviceCore;
};
const suspendDeviceCore = (deviceId: string) => deviceCores.get(deviceId)?.suspendDevice();
const role = await startServer(forwarding, getDeviceCore, suspendDeviceCore, (url, token) => forwarding.connectRemote(url, token));
const url = `http://127.0.0.1:${PORT}`;
if (role === "none") {
  console.error(`Port ${PORT} is used by another program. Set FLOW_MCP_PORT to a free port.`);
  process.exit(1);
}
console.log(role === "owner" ? `Flow Studio running at ${url} (Ctrl+C to stop)` : `Flow Studio is already served by Claude's flow-mcp at ${url}`);
openUrl(url);
if (role === "client") process.exit(0);
