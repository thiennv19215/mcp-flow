import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const HOME_DIR = process.env.FLOW_MCP_HOME ?? join(homedir(), ".flow-mcp");
export const OUTPUT_ROOT = process.env.FLOW_MCP_OUTPUT ?? join(homedir(), "flow-mcp-out");
export const CAST_DIR = join(OUTPUT_ROOT, "_cast");
export const UPLOAD_DIR = join(HOME_DIR, "uploads");

// Single local user/device: these used to vary per remote-device request
// context; the names stay so callers read the same, the values are fixed.
export const outputRootForContext = (): string => OUTPUT_ROOT;

export const uploadDirForContext = (): string => UPLOAD_DIR;

export const castDirForContext = (): string => CAST_DIR;

export const projectDir = (project = ""): string => resolve(OUTPUT_ROOT, project.replace(/[^\w.-]+/g, "_"));
