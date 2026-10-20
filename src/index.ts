#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LocalCore, type Core } from "./core.js";
import { createFlowMcpServer } from "./mcp-tools.js";
import { ForwardingCore, RemoteCore } from "./remote.js";
import { PORT, PUBLIC_URL, startServer } from "./server.js";

const local = new LocalCore();
const forwarding = new ForwardingCore(local);
const deviceCores = new Map<string, LocalCore>();
const getDeviceCore = (deviceId: string): LocalCore => {
  let deviceCore = deviceCores.get(deviceId);
  if (!deviceCore) deviceCores.set(deviceId, (deviceCore = new LocalCore(deviceId)));
  return deviceCore;
};
const suspendDeviceCore = (deviceId: string) => deviceCores.get(deviceId)?.suspendDevice();
const role = await startServer(forwarding, getDeviceCore, suspendDeviceCore, (url, token) => forwarding.connectRemote(url, token));
const core: Core = role === "client" ? new RemoteCore() : forwarding;
const studio = role === "none" ? undefined : PUBLIC_URL ?? `http://127.0.0.1:${PORT}`;

const server = createFlowMcpServer(core, studio);
await server.connect(new StdioServerTransport());
