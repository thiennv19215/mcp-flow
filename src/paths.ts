import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const HOME_DIR = process.env.FLOW_MCP_HOME ?? join(homedir(), ".flow-mcp");
export const OUTPUT_ROOT = process.env.FLOW_MCP_OUTPUT ?? join(homedir(), "flow-mcp-out");
export const CAST_DIR = join(OUTPUT_ROOT, "_cast");

export const projectDir = (project = ""): string => resolve(OUTPUT_ROOT, project.replace(/[^\w.-]+/g, "_"));
