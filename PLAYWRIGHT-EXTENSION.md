# Official Playwright Extension driver

`FLOW_MCP_DRIVER=playwright-official` is an optional comparison driver using the official Playwright extension browser factory. The default `extension` driver instead uses this repo's Flow MCP Connector; see EXTENSION-PORT.md.

## Connect the existing Chrome profile

1. Install [Playwright Extension](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm) in the Chrome profile containing your signed-in Flow tab.
2. Disable the previous **Flow MCP Connector** at `chrome://extensions` to release its debugger attachment. Close DevTools on Flow if it owns the debugger.
3. Build and start Studio/MCP as usual. Open a Flow project in the existing Chrome.
4. Call Flow status. Playwright opens its connection page in that profile. Approve the connection and select the existing Flow tab. Interactive approval needs no token entry.
5. `/api/health` reports `playwright_extension.connected`, `connecting`, and the last connection error. Legacy connector polling does not count as an official connection.

If several profiles have the extension, use `FLOW_MCP_CHROME_PROFILE=Profile 1` (or the corresponding directory name). Connection approval and tab selection are controlled by the official extension. Flow MCP selects an existing Flow page exposed by that connection; it does not create a replacement Flow browser or project tab. The official factory opens a connection page through Chrome's existing profile.

## Version and fallback

The adapter calls `tools.createBrowserWithInfo` from the exported `playwright-core/lib/coreBundle` module, the factory used by Playwright MCP's extension mode. This factory is internal, not a stable Playwright Library API. The dependency is pinned to `1.63.0` and checked at runtime; upgrades require reviewing the factory API and repeating interaction/navigation/reconnection checks.

`FLOW_MCP_DRIVER=extension-legacy` explicitly selects the previous custom connector. `FLOW_MCP_DRIVER=cdp` explicitly selects the original dedicated Chrome profile. There is no automatic fallback to a dedicated browser when the official extension is missing.

Build checks and the missing-extension error path do not establish runtime compatibility. Real Flow interaction, navigation and reconnection must be verified after installing the extension and approving a connection. Generation tests may spend Flow credits.
