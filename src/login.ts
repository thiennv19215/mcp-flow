#!/usr/bin/env node
// Opens the Flow tab so the user can sign in by hand.
import { FLOW_URL, getFlowPage, inEnglish } from "./chrome.js";
import { openUrl } from "./platform.js";

if ((process.env.FLOW_MCP_DRIVER ?? "extension") !== "cdp") {
  const url = inEnglish(FLOW_URL);
  openUrl(url);
  console.log(`Flow opened at ${url}`);
  console.log("Sign in to Google in your regular Chrome profile and open a Flow project. Load this repo's extension folder (Flow MCP Connector 0.4.0+), then use its Connect active Flow tab button. Keep the backend running.");
  process.exit(0);
}
const page = await getFlowPage();
await page.bringToFront();
console.log(`Chrome is open on ${page.url()}`);
console.log("Sign in to Google in your regular Chrome profile, then open or create a Flow project. Keep the Flow MCP Connector extension installed and connected.");
process.exit(0);
