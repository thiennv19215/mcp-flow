import { createRequire } from "node:module";
import type { Browser, Page } from "playwright-core";

export const PLAYWRIGHT_EXTENSION_URL = "https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm";
const require = createRequire(import.meta.url);
const SUPPORTED_VERSION = "1.63.0";
let browser: Browser | undefined;
let connecting: Promise<Browser> | undefined;
let lastError: string | undefined;

export function officialExtensionStatus() {
  return {
    connected: browser?.isConnected() ?? false,
    connecting: Boolean(connecting),
    error: lastError,
    install_url: PLAYWRIGHT_EXTENSION_URL,
  };
}

async function getBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  if (connecting) return connecting;
  // This factory is the one used by Playwright MCP's --extension mode. It owns
  // the official relay, handshake and CDP session model; no local protocol clone.
  // It is an internal exported API, so pin and check the package version.
  const version = require("playwright-core/package.json").version;
  if (version !== SUPPORTED_VERSION) throw new Error(`Official extension integration requires playwright-core ${SUPPORTED_VERSION}; found ${version}.`);
  const { tools } = require("playwright-core/lib/coreBundle");
  if (typeof tools?.createBrowserWithInfo !== "function") throw new Error("Playwright's extension browser factory is unavailable. Reinstall the pinned playwright-core package.");
  const options = { browser: "chrome", profileDirName: process.env.FLOW_MCP_CHROME_PROFILE };
  lastError = undefined;
  connecting = (async () => {
    try {
      const config = {
        extension: true,
        browser: { browserName: "chromium", launchOptions: {} },
      };
      const result = await tools.createBrowserWithInfo(config, { clientName: "Flow MCP" }, options) as { browser: Browser };
      const attached = result.browser;
      browser = attached;
      attached.on("disconnected", () => { if (browser === attached) browser = undefined; });
      return attached;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (/Playwright Extension not found/.test(lastError)) {
        throw new Error(`Install Playwright Extension in the Chrome profile containing Flow: ${PLAYWRIGHT_EXTENSION_URL}. Then retry and approve the connection/select the Flow tab. Disable Flow MCP Connector to release its debugger attachment. Details: ${lastError}`);
      }
      throw error;
    } finally {
      connecting = undefined;
    }
  })();
  return connecting;
}

export async function getOfficialExtensionPage(): Promise<Page> {
  const attached = await getBrowser();
  const pages = attached.contexts().flatMap(context => context.pages())
    .filter(page => !page.isClosed() && /^https:\/\/(flow\.google\.com|labs\.google\/fx)\//.test(page.url()));
  const page = pages.find(page => /\/project\//.test(page.url())) ?? pages[0];
  if (!page) throw new Error("Select your existing Flow tab in Playwright Extension's connection page, then retry.");
  await page.waitForLoadState("domcontentloaded", { timeout: 30_000 });
  return page;
}
