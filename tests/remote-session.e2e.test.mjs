import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const readJson = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
};

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function close(server) {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

test("MCP status forwards through the local owner to the authenticated remote device core", { timeout: 30_000 }, async (t) => {
  const calls = [];
  const staged = [];
  let generated;
  const mediaBytes = Buffer.from("remote-media-e2e-fixture");
  const expectedToken = "test-device-token-1234567890";
  const remoteServer = createServer(async (request, response) => {
    const authorization = request.headers.authorization;
    calls.push({ method: request.method, url: request.url, authorization });
    if (request.method === "GET" && request.url === "/api/user/me") {
      if (authorization === `Bearer ${expectedToken}`) await new Promise((resolve) => setTimeout(resolve, 5_500));
      response.writeHead(authorization === `Bearer ${expectedToken}` ? 200 : 401, { "content-type": "application/json" });
      response.end(JSON.stringify(authorization === `Bearer ${expectedToken}`
        ? { device_id: "device-e2e", label: "E2E browser" }
        : { error: "Valid device bearer token required." }));
      return;
    }
    if (request.method === "POST" && request.url === "/api/status") {
      const body = await readJson(request);
      response.writeHead(authorization === `Bearer ${expectedToken}` ? 200 : 401, { "content-type": "application/json" });
      response.end(JSON.stringify(authorization === `Bearer ${expectedToken}`
        ? { flow: { url: "https://flow.google.com/project/e2e", signedIn: true, inProject: true, available: true }, jobs: [], detailed: body.detailed ?? false }
        : { error: "Valid device bearer token required." }));
      return;
    }
    if (request.method === "POST" && request.url.startsWith("/api/upload?")) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      staged.push({ authorization, name: new URL(request.url, "http://test").searchParams.get("name"), bytes });
      response.writeHead(authorization === `Bearer ${expectedToken}` ? 200 : 401, { "content-type": "application/json" });
      response.end(JSON.stringify(authorization === `Bearer ${expectedToken}`
        ? { path: "/data/flow/uploads/staged-reference.png" }
        : { error: "Valid device bearer token required." }));
      return;
    }
    if (request.method === "POST" && request.url === "/api/generate") {
      const body = await readJson(request);
      generated = { authorization, body };
      response.writeHead(authorization === `Bearer ${expectedToken}` ? 200 : 401, { "content-type": "application/json" });
      response.end(JSON.stringify(authorization === `Bearer ${expectedToken}`
        ? { output_dir: "/data/output/users/user-e2e/device-e2e/remote-e2e", jobs: [{ id: "job-e2e", status: "queued", project: "/data/output/users/user-e2e/device-e2e/remote-e2e", scene: "scene-01", files: [] }] }
        : { error: "Valid device bearer token required." }));
      return;
    }
    if (request.method === "POST" && request.url === "/api/wait") {
      response.writeHead(request.headers.authorization === `Bearer ${expectedToken}` ? 200 : 401, { "content-type": "application/json" });
      response.end(JSON.stringify(request.headers.authorization === `Bearer ${expectedToken}`
        ? { finished: true, jobs: [{ id: "job-e2e", status: "done", project: "/data/output/users/user-e2e/device-e2e/remote-e2e", scene: "scene-01", files: ["/data/output/users/user-e2e/device-e2e/remote-e2e/scene-01.png"] }] }
        : { error: "Valid device bearer token required." }));
      return;
    }
    if (request.method === "GET" && request.url.startsWith("/media?")) {
      const url = new URL(request.url, "http://test");
      calls.push({ method: request.method, url: request.url, authorization });
      response.writeHead(authorization === `Bearer ${expectedToken}` && url.searchParams.get("path") === "/data/output/users/user-e2e/device-e2e/remote-e2e/scene-01.png"
        ? 200
        : 404, { "content-type": "image/png", "content-length": String(mediaBytes.length) });
      response.end(authorization === `Bearer ${expectedToken}` ? mediaBytes : Buffer.alloc(0));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "Not found." }));
  });
  const remotePort = await listen(remoteServer);
  const localPortProbe = createServer();
  const localPort = await listen(localPortProbe);
  await close(localPortProbe);

  const scratch = mkdtempSync(join(tmpdir(), "flow-mcp-remote-e2e-"));
  const inputFile = join(scratch, "reference.png");
  const inputBytes = Buffer.from("local-reference-e2e-fixture");
  writeFileSync(inputFile, inputBytes);
  const backendUrl = `http://127.0.0.1:${remotePort}`;
  const extensionOrigin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
  const env = Object.fromEntries(Object.entries(process.env).filter((entry) => typeof entry[1] === "string"));
  Object.assign(env, {
    FLOW_MCP_HOST: "127.0.0.1",
    FLOW_MCP_PORT: String(localPort),
    FLOW_MCP_HOME: join(scratch, "home"),
    FLOW_MCP_OUTPUT: join(scratch, "output"),
    FLOW_MCP_DB_PATH: join(scratch, "users.sqlite"),
    FLOW_MCP_ALLOWED_HOSTS: `127.0.0.1:${localPort},localhost:${localPort}`,
    FLOW_MCP_REMOTE_URL: backendUrl,
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    cwd: resolve("."),
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "remote-session-e2e", version: "1.0.0" });
  t.after(async () => {
    await client.close().catch(() => {});
    await close(remoteServer);
    rmSync(scratch, { recursive: true, force: true });
  });

  await client.connect(transport);
  const localUrl = `http://127.0.0.1:${localPort}/api/extension/remote-session`;
  const preflight = await fetch(localUrl, {
    method: "OPTIONS",
    headers: {
      origin: extensionOrigin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), extensionOrigin);

  const badSession = await fetch(localUrl, {
    method: "POST",
    headers: { origin: extensionOrigin, "content-type": "application/json" },
    body: JSON.stringify({ backend_url: backendUrl, device_token: "wrong-device-token-123456" }),
  });
  assert.equal(badSession.status, 401);

  const session = await fetch(localUrl, {
    method: "POST",
    headers: { origin: extensionOrigin, "content-type": "application/json" },
    body: JSON.stringify({ backend_url: backendUrl, device_token: expectedToken }),
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(session.status, 200);
  assert.deepEqual(await session.json(), { ok: true, device_id: "device-e2e" });

  const result = await client.callTool({ name: "flow_status", arguments: {} });
  const status = JSON.parse(result.content[0].text);
  assert.equal(status.flow.available, true);
  assert.equal(status.flow.signedIn, true);
  assert.equal(status.studio, backendUrl);
  assert.equal(calls.some((call) => call.url === "/api/status" && call.authorization === `Bearer ${expectedToken}`), true);
  assert.equal(JSON.stringify(status).includes(expectedToken), false);

  const generatedResult = await client.callTool({ name: "flow_generate", arguments: {
    project: "remote-e2e",
    scenes: [{ prompt: "A test scene", type: "image", reference_images: [inputFile, "asset:Existing image"] }],
  } });
  const generatedReply = JSON.parse(generatedResult.content[0].text);
  assert.equal(generatedReply.output_dir, join(scratch, "output", "remote", "device-e2e", "remote-e2e"));
  assert.equal(staged.length, 1);
  assert.equal(staged[0].name, "reference.png");
  assert.deepEqual(staged[0].bytes, inputBytes);
  assert.equal(generated.body.scenes[0].reference_images[0], "/data/flow/uploads/staged-reference.png");
  assert.equal(generated.body.scenes[0].reference_images[1], "asset:Existing image");
  assert.equal(generated.authorization, `Bearer ${expectedToken}`);

  const waitResult = await client.callTool({ name: "flow_wait", arguments: { job_ids: ["job-e2e"], timeout_seconds: 5 } });
  const waitReply = JSON.parse(waitResult.content[0].text);
  const localMedia = join(scratch, "output", "remote", "device-e2e", "remote-e2e", "scene-01.png");
  assert.equal(waitReply.finished, true);
  assert.equal(waitReply.jobs[0].files[0], localMedia);
  assert.equal(existsSync(localMedia), true);
  assert.deepEqual(readFileSync(localMedia), mediaBytes);
  assert.equal(calls.some((call) => call.method === "GET" && call.url.startsWith("/media?") && call.authorization === `Bearer ${expectedToken}`), true);

  const localConnect = await fetch(`http://127.0.0.1:${localPort}/api/extension/connect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ protocol: 3, version: "0.2.23", capabilities: ["flow.native.downloads.read"] }),
  });
  assert.equal(localConnect.status, 200);
  const localConnector = await localConnect.json();
  const largeResult = await fetch(`http://127.0.0.1:${localPort}/api/extension/result`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_id: localConnector.session_id, id: "large-result", result: { ok: true, value: { data: "x".repeat(100_000) } } }),
  });
  assert.equal(largeResult.status, 200);
});
