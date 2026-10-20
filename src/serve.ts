#!/usr/bin/env node
// HTTP-only entry point for a VPS/container. Unlike index.ts, this does not attach an MCP stdio transport.
import { LocalCore } from "./core.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createFlowMcpServer } from "./mcp-tools.js";
import { HOST, PORT, PUBLIC_URL, startServer } from "./server.js";

const deviceCores = new Map<string, LocalCore>();
const local = new LocalCore();
const getDeviceCore = (deviceId: string): LocalCore => {
  let deviceCore = deviceCores.get(deviceId);
  if (!deviceCore) deviceCores.set(deviceId, (deviceCore = new LocalCore(deviceId)));
  return deviceCore;
};
const suspendDeviceCore = (deviceId: string) => deviceCores.get(deviceId)?.suspendDevice();
type RemoteMcpRuntime = { server: ReturnType<typeof createFlowMcpServer>; transport: StreamableHTTPServerTransport };
const remoteMcpRuntimes = new Map<string, RemoteMcpRuntime>();
const handleRemoteMcp = async (
  device: { user_id: string; device_id: string; label: string },
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
) => {
  let runtime = remoteMcpRuntimes.get(device.device_id);
  if (!runtime) {
    const server = createFlowMcpServer(getDeviceCore(device.device_id), PUBLIC_URL);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    runtime = { server, transport };
    remoteMcpRuntimes.set(device.device_id, runtime);
  }
  await runtime.transport.handleRequest(req, res, body);
};
const role = await startServer(local, getDeviceCore, suspendDeviceCore, undefined, handleRemoteMcp);
if (role !== "owner") {
  console.error(`Could not own Flow MCP server at ${HOST}:${PORT} (role: ${role}).`);
  process.exit(1);
}

console.log(`Flow MCP server listening on ${HOST}:${PORT}${PUBLIC_URL ? ` (${PUBLIC_URL})` : ""}`);
