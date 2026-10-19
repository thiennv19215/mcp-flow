# Flow MCP Connector 0.4.0

The default driver uses this repository's extension and real Playwright Page/Locator objects. Microsoft's Playwright Extension is not required. Tab/session routing uses the Apache-2.0 Playwright v1.63.0 source in src/vendor/playwright; see its LICENSE, NOTICE and source notes.

## Install or update

1. Build and restart the backend/Studio at http://127.0.0.1:8799.
2. Load this repository's extension/ directory as an unpacked extension, or click Reload on the existing Flow MCP Connector card at chrome://extensions. Confirm version **0.4.0**.
3. Keep your existing Flow project tab active. Open the connector popup and click **Connect active Flow tab**. Settings should use the backend's localhost URL. No token entry or separate Chrome profile is required.
4. Check the popup for Connected via WebSocket and the selected tab ID. Run Flow status. /api/health reports connector.transport=websocket, protocol 2, and the loaded connector version.

The selection stays with that tab while you browse elsewhere. Use the popup's Connect button to select another Flow tab. Several Flow tabs without a saved/active choice require explicit selection; the connector does not guess a project.

Selecting the Flow Page does not bring its Chrome tab to the foreground. Interactive operations enable Playwright focus emulation, while the regular image/video result-wait loop disables it and only reads progress/new media. Retry clicks temporarily enable interaction; downloading resumes interaction after a result arrives. Job completion/failure releases it again. Basic Studio status polling never reacquires focus; detailed account-panel reads are coalesced and release focus on completion. The health endpoint exposes connector.interaction_enabled for verification.

## Transport and lifecycle

Commands, results and events share one ordered WebSocket. CDP commands can be in flight concurrently: an awaited Runtime promise does not block input or navigation commands. Initialization publishes the selected tab before Playwright auto-attach. Child-frame/worker sessions and detach events use the upstream Playwright model.

On disconnect the backend rejects pending calls and invalidates its Playwright transport. The extension releases debugger attachments and initializes a fresh session after reconnect. Responses from an old socket cannot enter a replacement session. Commands are not automatically replayed; after an interrupted submit, check Flow before retrying. Input calls are never silently retried on another session.

HTTP polling endpoints return 426 so an outdated connector cannot look connected. The server binds localhost; WebSocket upgrades require a localhost Host and Chrome extension Origin. Chrome DevTools or another debugger can still conflict with the selected tab.

FLOW_MCP_DRIVER=cdp explicitly selects the original dedicated-profile driver. FLOW_MCP_DRIVER=playwright-official is an optional comparison mode requiring Microsoft's extension (PLAYWRIGHT-EXTENSION.md). extension-legacy is a compatibility alias for the new connector, not the old HTTP transport.

## Verification

npm run test:bridge builds and checks child-session routing, detach invalidation, non-blocking CDP dispatch and stale response isolation using a mocked Chrome worker. These tests do not establish that all Flow workflows work in a real Chrome. Live interaction/navigation/reconnection checks require reloading the installed connector and restarting the backend. Generation checks may spend credits.

Live checks completed on 2026-10-19: detailed status (including credits), empty library/character scans, trusted keyboard input and mouse click on a temporary test control, page reload followed by renewed status, and automatic connector reconnection after backend restart. A single Nano Banana image was subsequently generated at a quoted cost of zero credits, renamed and downloaded at original quality. The combined job initially failed during download; after correcting the browser-session dependency, its existing image was downloaded without regeneration. Uploads, video generation and upscaled downloads remain unverified. Empty project scans do not validate extraction from populated grids.

Generation cost lookup matches only numeric credit quotes so the low-balance banner's Add AI credits link cannot make the locator ambiguous. The extension download path leaves Chrome's native download settings alone because attaching a browser-level CDP session is not allowed. The file collector watches the tool's download folder and the standard user Downloads folder; a custom Chrome download directory has not been verified.

Passive-wait verification used a temporary hidden DOM tile on the existing Flow page without submitting a generation: focus emulation was false during observation, basic status left it false, completion restored the interaction phase, and cleanup left it false. No additional credits were used. This does not verify all specialized Agent-mode wait loops or Chrome window minimization behavior.
# Activity border (0.4.3)

Version 0.4.6 adds a page input guard during interactive phases: direct mouse, touch, wheel, keyboard, paste and drag actions are blocked while authorized CDP input is identified by a worker-assigned timestamp. The guard is released during generation waits and on disconnect; its lease expires if the worker cannot renew it. Previewing the border does not lock input. Reload the extension and refresh Flow when upgrading this guard. Browser toolbar shortcuts and other tabs remain available. This guard still needs live Chrome verification after reloading 0.4.6.

Reload the connector and refresh the Flow tab to load the activity overlay. A bright lime-green border with an inner glow surrounds the viewport during interactive operations and disappears when focus emulation is released for generation waits, completion, errors, or disconnection. It does not intercept clicks or cycle colors. Reduced-motion preferences disable its fade transition. Chrome's native debugger notification is controlled by Chrome, not by this page overlay.

