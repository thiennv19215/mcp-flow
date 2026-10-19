#!/usr/bin/env node
// Opens Flow in the user's regular browser for sign-in and project selection.
import { openUrl } from "./platform.js";

const url = "https://flow.google.com/?hl=en";
openUrl(url);
console.log(`Flow opened at ${url}`);
console.log("Sign in, open a Flow project, then connect the Flow MCP Connector extension to that tab.");
