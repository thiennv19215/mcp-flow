import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { watch } from "node:fs";
import { createServer } from "node:http";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const extensionDir = resolve(root, "extension");
const host = "127.0.0.1";
const port = 18898;
let revision = await fingerprint();
let updateTimer;

async function fingerprint() {
  const files = [];
  async function collect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "_metadata" || entry.name === ".DS_Store") continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await collect(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  await collect(extensionDir);
  files.sort();

  const hash = createHash("sha256");
  for (const path of files) {
    hash.update(relative(extensionDir, path).split(sep).join("/"));
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function refreshRevision() {
  try {
    const next = await fingerprint();
    if (next === revision) return;
    revision = next;
    console.log(`[extension] Change detected (${new Date().toLocaleTimeString()}); Chrome will reload it automatically.`);
  } catch (error) {
    console.error(`[extension] Could not read extension files: ${error.message}`);
  }
}

const server = createServer((request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Private-Network", "true");
  response.setHeader("Cache-Control", "no-store");
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    response.end();
    return;
  }
  if (request.method !== "GET" || request.url !== "/status") {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ revision }));
});

server.listen(port, host, () => {
  console.log(`Watching ${extensionDir}`);
  console.log(`Dev reload server: http://${host}:${port}/status`);
  console.log("Load the extension folder once in chrome://extensions, then leave this command running.");
  console.log("Changed extension files reload automatically; open Flow tabs refresh after the extension reloads.");
});

const watcher = watch(extensionDir, { recursive: true }, () => {
  clearTimeout(updateTimer);
  updateTimer = setTimeout(() => void refreshRevision(), 300);
});

function stop() {
  clearTimeout(updateTimer);
  watcher.close();
  server.close(() => process.exit(0));
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
