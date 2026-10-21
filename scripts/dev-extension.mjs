import { watch } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDevExtensionServer, DEV_RELOAD_HOST } from "./dev-extension-server.mjs";
import { buildExtension, extensionPackageRoot, extensionSourceRoot } from "./build-extension.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifestPath = resolve(extensionSourceRoot, "manifest.json");
const port = 18898;
let updateTimer;
let buildRunning = false;
let rebuildPending = false;

const initialBuild = await buildExtension();
const reloadServer = await createDevExtensionServer({
  extensionDir: extensionPackageRoot,
  epochFile: resolve(root, ".flow-extension-reload-epoch"),
  port,
  onRevisionChange: (revision, reloadEpoch) => {
    console.log(`[extension] Revision ${revision} (reload epoch ${reloadEpoch}); Chrome will reload it when idle.`);
  },
});
await reloadServer.listen();
console.log(`Watching extension source: ${extensionSourceRoot}`);
console.log(`Packaged extension: ${extensionPackageRoot}`);
console.log(`Dev reload server: http://${DEV_RELOAD_HOST}:${port}/status`);
console.log(`Manual reload trigger: POST http://${DEV_RELOAD_HOST}:${port}/reload with header X-Flow-MCP-Reload: 1`);
console.log(`Initial package revision ${initialBuild.revision}. Load ${extensionPackageRoot} in chrome://extensions, then leave this command running.`);
console.log("Changes anywhere under extension/ rebuild the package before Chrome is asked to reload.");

function scheduleRebuild() {
  clearTimeout(updateTimer);
  updateTimer = setTimeout(() => {
    if (buildRunning) {
      rebuildPending = true;
      return;
    }
    buildRunning = true;
    void (async () => {
      try {
        const result = await buildExtension();
        const changed = await reloadServer.refreshFiles();
        if (changed) console.log(`[extension] Rebuilt ${result.packageRoot} at revision ${result.revision}; Chrome will reload it when idle.`);
      } catch (error) {
        console.error(`[extension] Build failed; packaged output was not refreshed: ${error.message}`);
      } finally {
        buildRunning = false;
        if (rebuildPending) {
          rebuildPending = false;
          scheduleRebuild();
        }
      }
    })();
  }, 300);
}

const sourceWatcher = watch(extensionSourceRoot, { recursive: true }, scheduleRebuild);

function stop() {
  clearTimeout(updateTimer);
  sourceWatcher.close();
  void reloadServer.close().then(() => process.exit(0));
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
