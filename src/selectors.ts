import { readFileSync, existsSync, watch } from "node:fs";
import { join, resolve } from "node:path";
import { HOME_DIR } from "./paths.js";
import { extensionBroadcastEvent, extensionSendEvent, onExtensionInitialized, type Connection } from "./extension.js";

const LOCAL_SELECTORS_PATH = resolve(process.cwd(), "flow-selectors.json");
const HOME_SELECTORS_PATH = join(HOME_DIR, "flow-selectors.json");

let cachedSelectors: Record<string, unknown> | null = null;
let watcherInitialized = false;

export function getSelectorsFilePath(): string {
  if (existsSync(HOME_SELECTORS_PATH)) return HOME_SELECTORS_PATH;
  if (existsSync(LOCAL_SELECTORS_PATH)) return LOCAL_SELECTORS_PATH;
  return LOCAL_SELECTORS_PATH;
}

export function loadFlowSelectors(): Record<string, unknown> {
  const filePath = getSelectorsFilePath();
  if (existsSync(filePath)) {
    try {
      const content = readFileSync(filePath, "utf-8");
      cachedSelectors = JSON.parse(content);
      return cachedSelectors!;
    } catch (err) {
      console.warn(`[FlowSelectors] Failed to read ${filePath}:`, err);
    }
  }
  return cachedSelectors || {};
}

export function getFlowSelectors(): Record<string, unknown> {
  if (!cachedSelectors) {
    loadFlowSelectors();
    initSelectorsWatcher();
  }
  return cachedSelectors || {};
}

export function syncSelectorsToConnection(connection: Connection): void {
  const selectors = getFlowSelectors();
  if (selectors && Object.keys(selectors).length > 0) {
    extensionSendEvent(connection, "flow.selectors.sync", [selectors]);
  }
}

export function initSelectorsWatcher(): void {
  if (watcherInitialized) return;
  watcherInitialized = true;
  const filePath = getSelectorsFilePath();
  if (existsSync(filePath)) {
    try {
      watch(filePath, (eventType) => {
        if (eventType === "change" || eventType === "rename") {
          console.log(`[FlowSelectors] Selectors file updated on disk (${filePath}), broadcasting to extension...`);
          try {
            const updated = loadFlowSelectors();
            extensionBroadcastEvent("flow.selectors.sync", [updated]);
          } catch (e) {
            console.warn("[FlowSelectors] Error reloading selectors:", e);
          }
        }
      });
    } catch (err) {
      console.warn(`[FlowSelectors] Could not watch ${filePath}:`, err);
    }
  }
}

// Automatically sync selectors whenever an extension connector initializes
onExtensionInitialized((connection) => {
  syncSelectorsToConnection(connection);
});
