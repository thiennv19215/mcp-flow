import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const regressionTests = [
  "backend-hardening.test.mjs",
  "base-provider-driver.test.mjs",
  "core-forwards.test.mjs",
  "chatgpt-queue-runner.test.mjs",
  "chatgpt-queue-preflight.test.mjs",
  "chatgpt-submit-payload.test.mjs",
  "chatgpt-provider-router.test.mjs",
  "chatgpt-error-detection.test.mjs",
  "chatgpt-outcome-classifier.test.mjs",
  "flow-background-regressions.test.mjs",
  "flow-generation-submit-acceptance.test.mjs",
  "flow-generation-partial-success.test.mjs",
  "flow-generation-observe-diagnostics.test.mjs",
  "flow-generation-dispatch-deadline.test.mjs",
  "flow-queue-consistency.test.mjs",
  "flow-queue-preflight.test.mjs",
  "flow-queue-preflight-overrides.test.mjs",
  "flow-queue-retry-budget.test.mjs",
  "flow-upload-media.test.mjs",
  "flow-upload-client-cancel.test.mjs",
  "flow-video-diagnostics.test.mjs",
  "flow-video-modes.test.mjs",
  "flow-video-reference.test.mjs",
  "flow-watermark-activation.test.mjs",
  "flow-watermark-variants.test.mjs",
  "flow-workflow-graph.test.mjs",
  "flow-workflow-submit-acceptance.test.mjs",
  "flow-workflow-editor.test.mjs",
  "flow-ref-preflight.test.mjs",
  "selection-normalize.test.mjs",
].map((file) => resolve(repoRoot, "tests", file));

const result = spawnSync(process.execPath, ["--test", ...regressionTests], { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? (result.signal ? 1 : 0));
