import { LocalCore } from "./core.js";
import { ForwardingCore } from "./remote.js";
import { startServer } from "./server.js";

// Shared entry-point wiring for the MCP process (index.ts) and the
// standalone Studio (studio.ts): one local core, one forwarding core, and
// a lazily-created core per connected device.
export async function startFlowServer() {
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
  return { role, local, forwarding };
}
