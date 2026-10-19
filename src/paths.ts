import { homedir } from "node:os";
import { join } from "node:path";

export const HOME_DIR = process.env.FLOW_MCP_HOME ?? join(homedir(), ".flow-mcp");
