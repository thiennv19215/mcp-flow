# Flow MCP Native Automation

The Chrome extension owns Flow operations and its queue. A separate local stdio MCP process remains available for AI clients. The system is local-only: the hosted account/device service was removed (2026-10-24); the backend is a thin local bridge (MCP host + extension connector + file services). Unsupported extension inputs fail before dispatch. See [ARCHITECTURE.md](ARCHITECTURE.md) and [NATIVE-MIGRATION-RUNBOOK.md](NATIVE-MIGRATION-RUNBOOK.md) for operation coverage and limitations.

The side panel uses the Flow MCP Native interface, with Create, Prompts, Tasks, Photos and Flow Images, History, Queue, and Settings. Prompts and local history use `chrome.storage.local`; Flow actions still enter the shared extension queue and execute through native DOM operations in the selected Flow tab.

Start the local MCP process with `npm start`; it binds port **18899** (or `FLOW_MCP_PORT`) on loopback. If another flow-mcp process already owns the port, new processes forward to it instead of driving Flow twice.

Drive **Google Flow** (flow.google.com) from Claude, Codex or any other MCP app, or from a local control
panel, using Flow's own credits (free with any Google account: 50 a day), not the pay-per-use video API.

It runs on your machine and uses this repo's Flow MCP Connector to control an existing, signed-in Chrome Flow tab with the native content-script driver by default. See [EXTENSION-PORT.md](EXTENSION-PORT.md) for setup.

```
AI client → local stdio MCP → selected Chrome tab → Flow
Extension side panel → extension queue → selected Chrome tab → Flow
```

**MCP** = Model Context Protocol, the standard that lets Claude use outside tools.
New here? [GETTING-STARTED.md](GETTING-STARTED.md) takes you from nothing to your first video, step by step, and
[OVERVIEW.md](OVERVIEW.md) explains what it does in plain English, with no code names.

---

## What you need

| | |
|---|---|
| **macOS or Windows 10/11** | Developed and tested on macOS. Windows is supported (Chrome, the computer's own voices, the Recycle Bin and the panel launcher all have Windows versions), but it hasn't been run on a real PC yet, so please report anything that breaks |
| **Node.js 22.13 or newer** | `node --version` |
| **Google Chrome** | Any recent version |
| **A Google account** | Free. Flow gives every account 50 credits a day; a paid Google AI plan adds more and unlocks 1080p downloads. Developed on a Pro plan |
| **FFmpeg** *(optional)* | Mac: `brew install ffmpeg` · Windows: `winget install Gyan.FFmpeg`. Needed only to join clips, mix music or record narration |
| **A Google AI Studio key** *(optional, free)* | Only for the Google narration voices. See below |

A display must stay awake: the Chrome window is really being driven, so the machine cannot be
headless or asleep mid-run.

---

## Install

This experimental repository is currently local and has no remote configured. From its checkout, install dependencies and build:

```bash
npm install
npm run build
```

For day-to-day changes, `npm test` runs the focused smoke suite (10 files, 193 tests). Run `npm run test:full` before a release to execute every test file in `tests/`.

> **Mac: do not put this folder in `~/Desktop`, `~/Documents` or `~/Downloads`.** macOS protects those
> folders, and apps that launch the server from there can be refused permission to read its own
> files (`EPERM: operation not permitted`). `~/flow-mcp` or anywhere in your home folder is fine.
>
> **Windows: keep it out of folders OneDrive syncs** (often Desktop and Documents), where files can be held
> online-only. `C:\Users\<you>\flow-mcp` is fine.

Then sign in, once:

```bash
npm run login
```

That opens Flow in your regular browser. Build the project, then load `dist/extension/` in Chrome (Developer mode → Load unpacked). For an existing installation, click Reload and confirm the version shown in `extension/manifest.json`. The extension connects automatically to the active Flow tab and follows when you switch to another Flow tab. No token entry is required.
You sign in yourself; the program never handles your Google password.

The extension handles Flow operations and its queue locally in the browser. MCP remains available as a separate local stdio process for AI clients; it talks to the same local extension connector. There is no account backend.

---

## Connect it to Claude, Codex or Antigravity

**Claude Code**

```bash
claude mcp add --scope user flow -- node /absolute/path/to/flow-mcp/dist/index.js
```

`--scope user` makes it available in every folder; the default (`local`) only works in the folder you ran it from.

**Claude Desktop**: add to `claude_desktop_config.json` (Mac: `~/Library/Application Support/Claude/`, Windows:
`%APPDATA%\Claude\`). On Windows, write the path with doubled backslashes, like
`"C:\\Users\\you\\flow-mcp\\dist\\index.js"`:

```json
{ "mcpServers": { "flow": { "command": "node", "args": ["/absolute/path/to/flow-mcp/dist/index.js"] } } }
```

**Codex**: add to `~/.codex/config.toml` (on Windows, `%USERPROFILE%\.codex\config.toml`):

```toml
[mcp_servers.flow]
command = "node"
args = ["/absolute/path/to/flow-mcp/dist/index.js"]
```

The local MCP process uses the extension on the same computer. The extension side panel and MCP calls share its persistent Flow queue; MCP is the separate AI-facing entry point. No device token is needed by the MCP client. No timeout setting is needed:
Codex, like most MCP apps, gives up on a tool call after 60 seconds, so any call that runs longer than about
45 seconds (creating a character, a 1080p download) answers with a task id instead and keeps working, and
`flow_wait` collects the result.

**Antigravity** (Google's coding app): add a `flow` entry to `mcp_config.json`. On a Mac it lives in
`~/.gemini/antigravity/`; you can also open it from the agent panel's **…** menu → **Manage MCP Servers** →
**View raw config**. Keep any servers already listed and add this one beside them:

```json
{ "mcpServers": { "flow": { "command": "node", "args": ["/absolute/path/to/flow-mcp/dist/index.js"] } } }
```

Other MCP apps can use the same local stdio command format supported by their MCP client.

Developed and tested with Claude. Codex and Antigravity speak the same protocol, so they should work the
same way, but neither has been tried yet, so please report how it goes. Running two of them at once is safe:
the first one started drives Flow, and the others pass their requests to it.

Restart the app, then ask it: *"check my Flow session"*. You should get your sign-in and project state, plus the generation credit quote when Flow displays one.
back. Everything after that is plain English; you never type tool names.

---

## Your first film

Nothing below costs a credit until step 4, and the assistant asks before spending.

1. **Check the session.** *"Check my Flow session."* This confirms sign-in and project state without opening the account menu.
2. **Make a character.** *"Create a character called Pip, a small lamplighter in a flat cartoon style."*
   Flow draws the portrait. Free.
3. **Draw the key frames.** *"Draw three stills with Pip: a dark rooftop, him lighting a lamp, the
   whole hillside glowing. Match each one to the last."* Free: stills cost nothing, so get the look
   right here before spending.
4. **Shoot it.** *"Turn those into three 10-second shots, each starting where the last one ended,
   720p, no more than 15 credits each."* This spends credits. The price is read from Flow's own
   quote first and the scene is skipped if it is over your cap.
5. **Cut it.** *"Join the three shots into one video, with optional music or voiceover."*
   The finished file lands in `~/flow-mcp-out/<project>/`.

---

## The control panel

The same features, without an AI assistant in the loop: use the extension's
side panel. It shares the same extension queue, so panel work and MCP work
never double-drive the Flow tab.

The web Studio panel was removed with the hosted account build (2026-10-24).
The local bridge listens on 127.0.0.1 and uses a local per-machine token
(`~/.flow-mcp/token`) for the sibling-process API and media/upload routes.

## Quy ước version

Hai version trong repo này version độc lập, vì backend và extension phát hành
theo nhịp khác nhau — đừng "đồng bộ" chúng cho bằng nhau:

- `package.json` → version của backend/MCP server (hiện `0.1.16`).
- `extension/manifest.json` → version của extension (hiện `0.2.51`).

Khi bump một bên, chỉ bump bên đó. Test không hardcode version: giá trị
version trong fixture lấy từ `extension/manifest.json` thật.

---

## Tools

| Tool | Purpose |
|---|---|
| `flow_status` | Session state (signed in, project open, visible generation credit quote), queue, pacing, prompt playbook |
| `flow_generate` | Queue scenes: prompt, image or video, model, aspect, duration, resolution, variants, first/last frame, reference images. Videos use a `max_credits` cap; image generation skips the quote check |
| `flow_wait` | Wait for jobs, or for the task id of a slow call; returns file paths and results. Answers within about 40 s, so call again until `finished` is true |
| `flow_cancel` | Cancel a job that has not started |
| `flow_retry` | Re-queue failed jobs with the same settings and file names (a failed tile is first retried inside Flow with its own free Retry button: `retries`, default 1) |
| `flow_assets` | List images and videos already in the Flow project (usable as `asset:<title>`) |
| `flow_download` | Download existing project media without regenerating. Free, including the 1080p / 2K upscale. A scene comes down as one stitched film |
| `flow_trash` | Move an image, video or scene in the Flow project to Flow's Trash, where it can be restored. Exact title only; refuses if two items share it; never deletes permanently |
| `flow_agent_images` | Fast image batch: hands up to 50 scenes to Flow's own Agent mode, rendered in parallel (20 images in ~204 s), 0 credits. Each image is matched back to its scene by its stored prompt, so file numbers are right in any finish order. Scenes the agent drops are re-asked of it (up to 2 rounds), then re-run one by one |
| `flow_edit` | Video-to-video edit of a clip already in the project (relight, weather, remove objects). Flow shows no quote first; about 20 credits for a 4 s clip |
| `flow_continue` | Start a clip from the last frame of an existing one **with a character or your avatar still attached**. The composer allows a start frame or attached characters, never both, so this drives Flow's agent mode, which does both. No quote beforehand |
| `flow_character` | Create a reusable character from a description (Flow draws the portrait) or an image, with a personality and a stock voice; use it as `asset:<name>` |
| `flow_character_edit` | Restyle an existing character in place (free) and save the new portrait; name, personality and voice are kept, so every scene referencing it updates. Pass `look` with the updated description; with only a name it re-saves the current portrait |
| `flow_characters` | List the project's characters |
| `flow_techniques` | 39 film-technique prompt presets (camera moves, product shots, transitions, image commands); pass an id as a scene's `technique` |
| `flow_assemble` | Join clips into one MP4 (a project's clips, or any you list, in order) with optional music and voiceover, and separate volume for the clips' own sound (local FFmpeg, no credits) |

**Continuity between shots:** `chain_previous` (this clip starts on the last frame of the previous
one), `first_frame` + `last_frame` (animate between two stills you chose), `reference_images` (keep a
character or product consistent). Flow's *composer* takes either frames or references, never both, so
when you need a start frame **and** a character locked together, use `flow_continue`, which goes through
Flow's agent mode and does both.

Output lands in `~/flow-mcp-out/<project>/scene-NN.ext`.

## Behaviour and settings

- One generation at a time, with a random 5–10 second pause between jobs. Set
  `FLOW_MCP_PAUSE_MIN_S` and `FLOW_MCP_PAUSE_MAX_S` to adjust the pause. The page carries an
  invisible reCAPTCHA; this drives the real interface at human pace and does nothing to evade it.
- Before each video generation the server reads Flow's own credit quote and skips the scene if it exceeds
  `max_credits` (default 25). Image generation skips this quote check.
- Flow keeps the locale already active in the selected tab; the extension does not rewrite the URL
  to force English. `flow_open_project` can optionally take a locale such as `vi` or `en`.
  Prompts can be written in any language.
- Environment variables: `FLOW_MCP_PORT` (18899), `FLOW_MCP_OUTPUT`,
  `FLOW_MCP_HOME`, `FLOW_MCP_PAUSE_MIN_S`,
  `FLOW_MCP_PAUSE_MAX_S`.

## If something goes wrong

| Symptom | Cause |
|---|---|
| Mac: the server will not start, `EPERM: operation not permitted` | The folder is in a macOS-protected location. Move it out of `~/Desktop`, `~/Documents` or `~/Downloads` and update the path in your Claude config |
| *"Not signed in"* or *"no project open"* | Open the Flow tab in Chrome, sign in, and open a project |
| A clip generated but no file arrived | The media is still in Flow. `flow_download` pulls it back for nothing. Never re-generate and pay twice |
| Everything times out | Reopen the Flow tab in Chrome and check that the connector extension is connected |

---

## Updating

Tell your assistant: *"Update Flow MCP: in my flow-mcp folder, run git pull, then npm install, then npm run
build."* Then fully quit and reopen your assistant app so it loads the new version.

---

## Licence and risk

This automates Flow's web interface. It can break whenever Google changes that interface, and
automated use may be against Google's terms of service. Use it on your own account, at your own
risk.
