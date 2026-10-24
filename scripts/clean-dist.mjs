import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// tsc never deletes outputs whose sources were removed or renamed, so a
// deleted backend module kept living in dist (a ghost dist/queue.js once
// passed tests after src/queue.ts was deleted). Wipe dist at the start of
// every build; tsc recreates the backend output and build-extension.mjs
// recreates dist/extension from scratch. An explicit target may be passed
// (the regression test uses a scratch directory).
const target = process.argv[2]
  ? resolve(process.argv[2])
  : fileURLToPath(new URL("../dist", import.meta.url));
rmSync(target, { recursive: true, force: true });
