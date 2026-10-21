// Deprecated compatibility entry point. VPS serving is auth-only; the local MCP
// stdio entry remains `src/index.ts` and is intentionally separate.
import { AUTH_HOST, AUTH_PORT, AUTH_PUBLIC_URL, startAuthServer } from "./auth-server.js";

console.warn("`dist/serve.js` is deprecated; use `npm run serve` for the auth-only service.");
const server = await startAuthServer();
console.log(`Flow Auth listening at http://${AUTH_HOST}:${AUTH_PORT}${AUTH_PUBLIC_URL ? ` (${AUTH_PUBLIC_URL})` : ""}`);

const stop = () => server.close(() => process.exit(0));
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
