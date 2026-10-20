import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { currentDeviceContext } from "./request-context.js";

export const HOME_DIR = process.env.FLOW_MCP_HOME ?? join(homedir(), ".flow-mcp");
export const OUTPUT_ROOT = process.env.FLOW_MCP_OUTPUT ?? join(homedir(), "flow-mcp-out");
export const CAST_DIR = join(OUTPUT_ROOT, "_cast");

export const outputRootForContext = (): string => {
  const context = currentDeviceContext();
  return context ? join(OUTPUT_ROOT, "users", context.userId, context.deviceId) : OUTPUT_ROOT;
};

export const uploadDirForContext = (): string => {
  const context = currentDeviceContext();
  return context ? join(HOME_DIR, "users", context.userId, context.deviceId, "uploads") : join(HOME_DIR, "uploads");
};

export const castDirForContext = (): string => join(outputRootForContext(), "_cast");

export const projectDir = (project = ""): string => resolve(outputRootForContext(), project.replace(/[^\w.-]+/g, "_"));
