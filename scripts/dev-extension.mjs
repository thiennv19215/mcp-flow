import { watch } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDevExtensionServer, DEV_RELOAD_HOST } from "./dev-extension-server.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const extensionDir = resolve(root, "extension");
const port = 18898;
let updateTimer;
const reloadServer = await createDevExtensionServer({
  extensionDir,
  epochFile: resolve(root, ".flow-extension-reload-epoch"),
  port,
  onRevisionChange: (revision, reloadEpoch) => {
    console.log(`[extension] Revision ${revision} (reload epoch ${reloadEpoch}); Chrome will reload it when idle.`);
  },
});
await reloadServer.listen();
console.log(`Watching ${extensionDir}`);
console.log(`Dev reload server: http://${DEV_RELOAD_HOST}:${port}/status`);
console.log(`Manual reload trigger: POST http://${DEV_RELOAD_HOST}:${port}/reload with header X-Flow-MCP-Reload: 1`);
console.log("Load the extension folder once in chrome://extensions, then leave this command running.");
console.log("Changed extension files reload automatically; open Flow tabs refresh after the extension reloads.");

const watcher = watch(extensionDir, { recursive: true }, () => {
  clearTimeout(updateTimer);
  updateTimer = setTimeout(() => {
    void reloadServer.refreshFiles().catch(error => console.error(`[extension] Could not read extension files: ${error.message}`));
  }, 300);
});

function stop() {
  clearTimeout(updateTimer);
  watcher.close();
  void reloadServer.close().then(() => process.exit(0));
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
