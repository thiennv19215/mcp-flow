import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fix 8: ffprobe reporting no duration (or "N/A") used to put NaN into the
// ffmpeg atrim/tpad filter arguments, failing with an unreadable filter
// error. probe() must reject up front with an error naming the clip.
// FLOW_MCP_FFPROBE is read when dist/assemble.js loads, so point it at a
// fake ffprobe before the dynamic import.
const work = mkdtempSync(join(tmpdir(), "flow-assemble-test-"));
const probeScript = join(work, "fake-probe.mjs");
writeFileSync(probeScript, `
const last = process.argv.at(-1) || "";
const body = last.includes("noduration")
  ? { streams: [{ codec_type: "video", width: 320, height: 240 }], format: {} }
  : last.includes("navalue")
    ? { streams: [{ codec_type: "video", width: 320, height: 240 }], format: { duration: "N/A" } }
    : { streams: [{ codec_type: "video", width: 320, height: 240 }], format: { duration: "2.5" } };
process.stdout.write(JSON.stringify(body));
`);
const fakeProbe = process.platform === "win32" ? join(work, "ffprobe.cmd") : join(work, "ffprobe");
if (process.platform === "win32") {
  writeFileSync(fakeProbe, `@echo off\r\n"${process.execPath}" "${probeScript}" %*\r\n`);
} else {
  writeFileSync(fakeProbe, `#!/bin/sh\nexec "${process.execPath}" "${probeScript}" "$@"\n`);
  chmodSync(fakeProbe, 0o755);
}
process.env.FLOW_MCP_FFPROBE = fakeProbe;
process.env.FLOW_MCP_FFMPEG = join(work, "ffmpeg-missing");

const { assemble } = await import("../dist/assemble.js");

test("assemble rejects clips whose ffprobe duration is missing or NaN", async () => {
  for (const name of ["noduration.mp4", "navalue.mp4"]) {
    const clip = join(work, name);
    writeFileSync(clip, "not really a video");
    await assert.rejects(
      assemble({ dir: work, clips: [clip], output_name: "out.mp4", music_volume: 0.5 }),
      (err) => {
        assert.match(err.message, /no readable duration/);
        assert.ok(err.message.includes(name), `error should name the clip, got: ${err.message}`);
        return true;
      },
    );
  }
  rmSync(work, { recursive: true, force: true });
});
