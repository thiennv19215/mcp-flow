#!/usr/bin/env node
// HTTP-only entry point for a VPS/container. Unlike index.ts, this does not attach an MCP stdio transport.
import { LocalCore } from "./core.js";
import { HOST, PORT, PUBLIC_URL, startServer } from "./server.js";

const deviceCores = new Map<string, LocalCore>();
const local = new LocalCore();
const getDeviceCore = (deviceId: string): LocalCore => {
  let deviceCore = deviceCores.get(deviceId);
  if (!deviceCore) deviceCores.set(deviceId, (deviceCore = new LocalCore(deviceId)));
  return deviceCore;
};
const suspendDeviceCore = (deviceId: string) => deviceCores.get(deviceId)?.suspendDevice();
const role = await startServer(local, getDeviceCore, suspendDeviceCore);
if (role !== "owner") {
  console.error(`Could not own Flow MCP server at ${HOST}:${PORT} (role: ${role}).`);
  process.exit(1);
}

console.log(`Flow MCP server listening on ${HOST}:${PORT}${PUBLIC_URL ? ` (${PUBLIC_URL})` : ""}`);
