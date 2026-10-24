// GPT-12 — manifest/build contract for the ChatGPT provider.
//
// The shipped manifest gains ONE ChatGPT content-script entry (isolated
// world, NO MAIN-world scripts) plus the chatgpt.com host permission, and
// every file the entry references must exist in the built package. The
// entry composition follows study §D.4: shared i18n/dom-utils/
// native-file-transfer + base driver/registry + providers/chatgpt/**.
// Two deliberate deviations from the §D.4 sketch, both forced by what
// exists in the tree today:
//   - content/dom-actions.js IS included: it is the shared bootstrap that
//     answers the flow-mcp:execute envelope for every provider (GPT-10's
//     runner targets it); without it the entry could never serve a job.
//   - floating-tracker-chat is NOT included: no such file exists yet
//     (only floating-tracker-flow.js); it lands with a later UI item.
// build-revision.js leads the list, mirroring the Flow isolated entry
// (and the pattern tests/flow-build-info.test.mjs pins for Flow).
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildExtension, extensionPackageRoot } from "../scripts/build-extension.mjs";

const manifest = JSON.parse(readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8"));

const EXPECTED_CHATGPT_JS = [
  "build-revision.js",
  "content/shared/i18n.js",
  "content/shared/dom-utils.js",
  "content/shared/native-file-transfer.js",
  "content/providers/base/base-provider-driver.js",
  "content/providers/base/provider-registry.js",
  "content/providers/chatgpt/core/ref-resolution.js",
  "content/providers/chatgpt/core/submit-payload.js",
  "content/providers/chatgpt/generation/baseline.js",
  "content/providers/chatgpt/generation/error-detection.js",
  "content/providers/chatgpt/generation/outcome-classifier.js",
  "content/providers/chatgpt/generation/result-extraction.js",
  "content/dom-actions.js",
];

function chatgptEntry(m) {
  return (m.content_scripts || []).find(entry => (entry.matches || []).some(pattern => pattern.includes("chatgpt.com")));
}

test("manifest declares exactly one ChatGPT content-script entry with the §D.4 shape", () => {
  const entries = (manifest.content_scripts || []).filter(entry => (entry.matches || []).some(pattern => pattern.includes("chatgpt.com")));
  assert.equal(entries.length, 1, "exactly one content-script entry may target chatgpt.com");
  const entry = entries[0];
  assert.deepEqual(entry.matches, ["*://chatgpt.com/*"]);
  assert.equal(entry.run_at, "document_idle");
  assert.notEqual(entry.world, "MAIN", "the ChatGPT entry must not run in the MAIN world");
  assert.ok(entry.world === undefined || entry.world === "ISOLATED", "isolated world only (default or explicit ISOLATED)");
});

test("ChatGPT entry loads exactly the files that exist, in dependency order, with no MAIN-world bridge script", () => {
  const entry = chatgptEntry(manifest);
  assert.ok(entry, "chatgpt entry present");
  assert.deepEqual(entry.js, EXPECTED_CHATGPT_JS);
  const mainEntry = manifest.content_scripts.find(candidate => candidate.world === "MAIN");
  const mainFiles = new Set(mainEntry.js);
  for (const file of entry.js) {
    assert.ok(!mainFiles.has(file), `${file} is a Flow MAIN-world script and must not be declared for ChatGPT`);
    assert.ok(!file.startsWith("content/bridge/"), `${file} lives in the MAIN-world bridge tree`);
  }
});

test("host_permissions gain chatgpt.com and keep every existing grant", () => {
  assert.ok(manifest.host_permissions.includes("*://chatgpt.com/*"), "chatgpt.com host permission present");
  for (const existing of [
    "https://flow.google.com/*",
    "https://labs.google/*",
    "https://*.googleusercontent.com/*",
    "https://*.googleapis.com/*",
    "https://storage.googleapis.com/*",
    "https://*.usercontent.goog/*",
    "http://127.0.0.1:18899/*",
    "http://localhost:18899/*",
    "http://127.0.0.1:18898/*",
  ]) {
    assert.ok(manifest.host_permissions.includes(existing), `existing host permission kept: ${existing}`);
  }
});

test("extension_pages CSP admits chatgpt.com for images and connections (§D.4)", () => {
  const csp = manifest.content_security_policy.extension_pages;
  const imgSrc = csp.split(";").map(part => part.trim()).find(part => part.startsWith("img-src"));
  const connectSrc = csp.split(";").map(part => part.trim()).find(part => part.startsWith("connect-src"));
  assert.ok(imgSrc.split(/\s+/).includes("https://chatgpt.com"), "img-src carries https://chatgpt.com");
  assert.ok(connectSrc.split(/\s+/).includes("https://chatgpt.com"), "connect-src carries https://chatgpt.com");
});

test("the two Flow content-script entries are byte-for-byte unchanged and the ChatGPT entry is appended last", () => {
  assert.equal(manifest.content_scripts.length, 3);
  const [mainEntry, flowEntry] = manifest.content_scripts;
  // Full-shape pin (parsed deepEqual) of both pre-existing Flow entries:
  // matches, ordered js, run_at, world. The isolated entry's pin was
  // deliberately extended once after GPT-12 — FEAT-06b added
  // content/shared/selection-normalize.js (the shared selection layer must
  // load in the Flow content world before its consumers).
  assert.deepEqual(mainEntry, {
    matches: ["https://flow.google.com/*"],
    js: [
      "content/bridge/flow-v2-correlation-codec.js",
      "content/bridge/flow-upload-main.js",
      "content/bridge/flow-correlation-observer.js",
      "content/bridge/WatermarkRemover.js",
      "content/bridge/media-interceptor.js",
      "content/bridge/slate-bridge.js",
    ],
    run_at: "document_start",
    world: "MAIN",
  });
  assert.deepEqual(flowEntry, {
    matches: ["https://flow.google.com/*"],
    js: [
      "build-revision.js",
      "content/shared/i18n.js",
      "content/shared/dom-utils.js",
      "content/shared/selection-normalize.js",
      "content/providers/flow/core/selectors.js",
      "content/shared/activity-overlay.js",
      "content/shared/native-file-transfer.js",
      "content/providers/base/base-provider-driver.js",
      "content/providers/base/provider-registry.js",
      "content/providers/flow/core/navigation.js",
      "content/providers/flow/composer/flow-editor.js",
      "content/providers/flow/core/settings.js",
      "content/providers/flow/library/page-settings.js",
      "content/providers/flow/generation/image-settings.js",
      "content/providers/flow/generation/video-settings.js",
      "content/providers/flow/composer/reference-actions.js",
      "content/providers/flow/composer/voice-actions.js",
      "content/providers/flow/media/uploader.js",
      "content/providers/flow/generation/native-frame-picker.js",
      "content/providers/flow/compatibility/flow-components.js",
      "content/providers/flow/characters/flow-characters.js",
      "content/providers/flow/generation/tiles.js",
      "content/providers/flow/media/media-menu.js",
      "content/providers/flow/agent/flow-agent.js",
      "content/providers/flow/core/screen-state.js",
      "content/providers/flow/composer/prompt-operations.js",
      "content/providers/flow/composer/reference-operations.js",
      "content/providers/flow/media/upload-operations.js",
      "content/providers/flow/generation/generation-operations.js",
      "content/providers/flow/library/library-operations.js",
      "content/providers/flow/workflows/workflow-operations.js",
      "content/providers/flow/core/dom-operations.js",
      "content/providers/flow/core/flow-driver.js",
      "content/bridge/watermark-config.js",
      "content/dom-actions.js",
      "content/floating-tracker-flow.js",
    ],
    run_at: "document_idle",
  });
  assert.ok(chatgptEntry(manifest) === manifest.content_scripts[2], "chatgpt entry appended after the Flow entries");
});

test("after a real build, the packaged manifest carries the entry and every referenced file exists", async () => {
  await buildExtension();
  const packaged = JSON.parse(readFileSync(resolve(extensionPackageRoot, "manifest.json"), "utf8"));
  const entry = chatgptEntry(packaged);
  assert.ok(entry, "packaged manifest contains the ChatGPT entry");
  assert.deepEqual(entry.js, EXPECTED_CHATGPT_JS);
  for (const script of packaged.content_scripts) {
    for (const file of script.js || []) {
      assert.ok(existsSync(resolve(extensionPackageRoot, file)), `packaged file exists: ${file}`);
    }
  }
});
