import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseRangeHeader, resolveServerToken } from "../dist/server.js";
import { OUTPUT_ROOT, projectDir } from "../dist/paths.js";
import { hasFlowDownloadProvenance, selectCompletedFlowDownload } from "../dist/native-downloads.js";
import { MAX_RETAINED_TASKS, retainTask } from "../dist/mcp-tools.js";
import { RemoteCore } from "../dist/remote.js";
import { extractZip } from "../dist/platform.js";
import { createServer } from "node:http";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// --- Fix 1: Range parsing must never produce an invalid/negative span, and
// suffix ranges mean the LAST bytes (the old inline math served the first
// N+1 bytes for "bytes=-N" and crashed the process for a start past EOF).
test("parseRangeHeader handles normal, open-ended, suffix and unsatisfiable ranges", () => {
  assert.deepEqual(parseRangeHeader(undefined, 1000), null);
  assert.deepEqual(parseRangeHeader("bytes=0-99", 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRangeHeader("bytes=100-", 1000), { start: 100, end: 999 });
  assert.deepEqual(parseRangeHeader("bytes=900-5000", 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRangeHeader("bytes=-500", 1000), { start: 500, end: 999 });
  assert.deepEqual(parseRangeHeader("bytes=-2000", 1000), { start: 0, end: 999 });
  assert.equal(parseRangeHeader("bytes=5000-", 1000), "unsatisfiable");
  assert.equal(parseRangeHeader("bytes=500-400", 1000), "unsatisfiable");
  assert.equal(parseRangeHeader("bytes=-0", 1000), "unsatisfiable");
  assert.equal(parseRangeHeader("bytes=0-0", 0), "unsatisfiable");
  assert.deepEqual(parseRangeHeader("bytes=-", 1000), null);
  assert.deepEqual(parseRangeHeader("items=0-10", 1000), null);
});

// --- Fix 2: a blank env var / blank token file must never resolve to the
// empty token (every route's `given !== token` check passes for "").
test("resolveServerToken never returns an empty token", () => {
  assert.equal(resolveServerToken("abc123", "filetoken"), "abc123");
  assert.equal(resolveServerToken("  abc123  ", undefined), "abc123");
  assert.equal(resolveServerToken(undefined, "filetoken"), "filetoken");
  assert.equal(resolveServerToken("", "filetoken"), "filetoken");
  const generated = resolveServerToken(undefined, "");
  assert.match(generated, /^[0-9a-f]{48}$/);
  assert.match(resolveServerToken("   ", "  \n "), /^[0-9a-f]{48}$/);
  assert.notEqual(resolveServerToken(undefined, undefined), resolveServerToken(undefined, undefined));
});

// --- Fix 3: "." and ".." project names must stay inside OUTPUT_ROOT.
test("projectDir keeps dot-segment project names inside the output root", () => {
  for (const hostile of ["..", "."]) {
    const dir = projectDir(hostile);
    assert.ok(dir.startsWith(OUTPUT_ROOT + "/"), `${hostile} escaped to ${dir}`);
    assert.notEqual(dir, join(OUTPUT_ROOT, ".."));
  }
  assert.equal(projectDir("My Film"), join(OUTPUT_ROOT, "My_Film"));
  assert.equal(projectDir("plain"), join(OUTPUT_ROOT, "plain"));
  assert.equal(projectDir(""), OUTPUT_ROOT);
});

// --- Fix 5: waitForNativeDownload's selection must ignore the user's own
// unrelated downloads and accept only Flow/Google-media provenance.
test("selectCompletedFlowDownload only accepts Flow-provenance downloads", () => {
  const before = new Set([1]);
  const unrelated = { id: 2, state: "complete", filename: "/tmp/unrelated.mp4", totalBytes: 10, bytesReceived: 10, url: "https://example.com/big-file.mp4", finalUrl: "https://example.com/big-file.mp4", referrer: "" };
  const flow = { id: 3, state: "complete", filename: "/tmp/scene.mp4", totalBytes: 10, bytesReceived: 10, url: "https://flow.google.com/project/abc", finalUrl: "https://storage.googleapis.com/flow/scene.mp4", referrer: "https://flow.google.com/" };
  const alreadySeen = { ...flow, id: 1 };
  assert.equal(hasFlowDownloadProvenance(unrelated), false);
  assert.equal(hasFlowDownloadProvenance(flow), true);
  assert.equal(hasFlowDownloadProvenance({ url: "blob:https://flow.google.com/xyz" }), true);
  assert.equal(selectCompletedFlowDownload([unrelated], before), undefined);
  assert.equal(selectCompletedFlowDownload([alreadySeen], before), undefined);
  assert.equal(selectCompletedFlowDownload([unrelated, flow], before), flow);
  assert.equal(selectCompletedFlowDownload([{ ...flow, id: 4, state: "in_progress" }], before), undefined);
});

// --- Fix 6: retained slow-call tasks are FIFO-bounded.
test("retainTask evicts the oldest tasks beyond the cap", () => {
  const map = new Map();
  for (let i = 0; i < MAX_RETAINED_TASKS + 25; i++) {
    retainTask(map, { task_id: `task-${i}`, tool: "flow_x", started: "", status: "done", result: i });
  }
  assert.equal(map.size, MAX_RETAINED_TASKS);
  assert.equal(map.has("task-0"), false);
  assert.equal(map.has("task-24"), false);
  assert.equal(map.has("task-25"), true);
  assert.equal(map.has(`task-${MAX_RETAINED_TASKS + 24}`), true);
});

// --- Fix 7: a hung owner process must surface a clear timeout error instead
// of hanging the client MCP forever.
test("RemoteCore request times out with a clear error", async (t) => {
  const hanging = createServer(() => { /* accepts, never answers */ });
  await new Promise((resolve) => hanging.listen(0, "127.0.0.1", resolve));
  t.after(() => { hanging.closeAllConnections(); hanging.close(); });
  const { port } = hanging.address();
  const core = new RemoteCore(`http://127.0.0.1:${port}`, 200);
  const outcome = await Promise.race([
    core.status({}).then(() => "resolved", (err) => err),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 4_000)),
  ]);
  assert.notEqual(outcome, "hung", "request hung past the test guard — no timeout was applied");
  assert.notEqual(outcome, "resolved");
  assert.match(outcome.message, /did not answer "status" within 0s|did not answer/);
});

// --- Fix 9: extractZip must not follow or return symlink entries.
test("extractZip skips symlink entries instead of returning their targets", () => {
  const work = mkdtempSync(join(tmpdir(), "flow-zip-test-"));
  try {
    const stage = join(work, "stage");
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, "take1.mp4"), "real-take");
    symlinkSync("/etc/passwd", join(stage, "evil.mp4"));
    const zip = join(work, "takes.zip");
    execFileSync("python3", ["-c", `
import zipfile, os
with zipfile.ZipFile(${JSON.stringify(zip)}, "w") as z:
    z.write(${JSON.stringify(join(stage, "take1.mp4"))}, "take1.mp4")
    info = zipfile.ZipInfo("evil.mp4")
    info.external_attr = (0o120777 << 16)
    z.writestr(info, "/etc/passwd")
`]);
    const dest = join(work, "out");
    const files = extractZip(zip, dest);
    // The old walk() used statSync (follows symlinks), so the symlink entry
    // was returned as a "take" pointing at /etc/passwd.
    assert.deepEqual(files.map((f) => f.split("/").pop()), ["take1.mp4"]);
    assert.equal(readFileSync(join(dest, "take1.mp4"), "utf8"), "real-take");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// --- Fix 4: the build's clean step removes dist (or a given target) so
// outputs of deleted sources cannot survive as ghosts.
test("clean-dist script removes its target directory", () => {
  const work = mkdtempSync(join(tmpdir(), "flow-clean-test-"));
  const target = join(work, "dist");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "queue.js"), "// ghost of a deleted source");
  execFileSync(process.execPath, [join(repoRoot, "scripts", "clean-dist.mjs"), target]);
  assert.equal(existsSync(target), false);
  rmSync(work, { recursive: true, force: true });
});
