import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const quickTests = [
  "backend-hardening.test.mjs",
  "flow-background-regressions.test.mjs",
  "flow-generation-submit-acceptance.test.mjs",
  "flow-queue-consistency.test.mjs",
  "flow-upload-media.test.mjs",
  "flow-video-diagnostics.test.mjs",
  "flow-watermark-activation.test.mjs",
  "flow-workflow-graph.test.mjs",
  "chatgpt-queue-runner.test.mjs",
  "chatgpt-submit-payload.test.mjs",
].map((file) => resolve(repoRoot, "tests", file));

const result = spawnSync(process.execPath, ["--test", ...quickTests], { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? (result.signal ? 1 : 0));
