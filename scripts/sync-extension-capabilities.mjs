import { copyFileSync } from "node:fs";

copyFileSync(
  new URL("../flow-model-capabilities.json", import.meta.url),
  new URL("../extension/flow-model-capabilities.json", import.meta.url),
);

copyFileSync(
  new URL("../chatgpt-model-capabilities.json", import.meta.url),
  new URL("../extension/chatgpt-model-capabilities.json", import.meta.url),
);
