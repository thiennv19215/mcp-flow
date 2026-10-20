# VPS deployment (backend only)

This deploys the HTTP backend and Studio on one Linux VPS behind Caddy-managed HTTPS. It keeps the application port bound to loopback; only the reverse proxy should be reachable from the internet. The extension source is not changed by this setup.

## Before deployment

- A Linux VPS with Docker Engine and the Docker Compose plugin.
- A DNS name pointing to the VPS. Allow inbound TCP 80 and 443 for Caddy's TLS certificate.
- SSH access to the VPS.

The backend has user and device accounts in SQLite. Device bearer tokens select a separate persisted job queue, browser connector session, uploads, and output directory for each device. Keep admin credentials private; users sign in with the account label and a password set by an administrator.

The extension signs in to the public HTTPS endpoint with a user account and password. The backend issues a per-profile device token, then accepts authenticated HTTPS long-poll requests for commands, progress, and results. The WebSocket endpoint remains available to older extensions during migration.

The backend also exposes a stateless Streamable HTTP MCP endpoint at `https://<your-domain>/mcp`. MCP clients authenticate with the device token returned during extension sign-in. Each device gets its own queue and output directory; no local MCP process is needed on the desktop.

## Configure and start

1. Copy the project to the VPS and enter its project directory.
2. Create the runtime environment file and strong secrets:

   ```bash
   cp .env.example .env
   openssl rand -hex 32
   ```

   Run `openssl rand -hex 32` separately for `FLOW_MCP_TOKEN` and `FLOW_MCP_WS_TOKEN`. Set a different long random value for `FLOW_MCP_ADMIN_PASSWORD`. Set `FLOW_MCP_DOMAIN` to the DNS name, and make `FLOW_MCP_PUBLIC_URL` and `FLOW_MCP_ALLOWED_HOSTS` match it exactly. Keep `.env` private; it is ignored by Git.

3. Build and start the service:

   ```bash
   docker compose up -d --build
   docker compose ps
   docker compose logs --tail=100 flow-mcp
   ```

4. Install Caddy on the host, copy `deploy/Caddyfile.example` to its Caddy configuration, replace `flow.example.com`, then reload Caddy. The reverse proxy must preserve the Host header and WebSocket upgrades; Caddy's `reverse_proxy` does this automatically. To use Cloudflare Tunnel instead, see the next section and do not expose the app port publicly.
5. Open `https://<your-domain>`. The Studio displays a login page and uses the `FLOW_MCP_ADMIN_USER` and `FLOW_MCP_ADMIN_PASSWORD` credentials from `.env`. A successful login creates a 12-hour, HttpOnly, Secure, SameSite=Strict session cookie. The admin registry API accepts this browser session or HTTP Basic credentials for CLI use. Studio job APIs continue to require `FLOW_MCP_TOKEN`.
6. Open `https://<your-domain>/admin` to create users, set their login passwords, inspect devices, revoke devices, or disable/reactivate a user. Passwords must be at least 12 characters. Disabling a user revokes all their devices; after reactivation, set a password if the account does not have one.

The Compose port is published only on `127.0.0.1`. Do not change it to `0.0.0.0` or open port 18899 in the VPS firewall. Serve it through HTTPS at 443.

## Cloudflare Tunnel option

You can use a Cloudflare Tunnel instead of Caddy and inbound ports 80/443. Create a public hostname such as `flow.example.com` in Cloudflare Zero Trust and route it to `http://127.0.0.1:18899` on the VPS. Keep `FLOW_MCP_PUBLIC_URL=https://flow.example.com` and include `flow.example.com` in `FLOW_MCP_ALLOWED_HOSTS`. The HTTPS long-poll transport works through the standard HTTP proxy path; the existing WebSocket upgrade remains only for older extension versions. Keep the Compose loopback-only port binding and firewall closed; only `cloudflared` on the VPS should reach the app. `FLOW_MCP_TRUST_PROXY=true` lets login rate limits use Cloudflare's client IP header.

## User and device registry API

The backend can create user accounts through the admin UI. Set a password for each account in the user list. The extension signs in with the account label and that password:

```bash
curl -u admin -H 'content-type: application/json' \
  -d '{"label":"Customer A"}' https://<your-domain>/api/admin/users
```

List users at `GET /api/admin/users`. Set a password with `POST /api/admin/users/<user-id>/password` and body `{"password":"at-least-12-characters"}`. Suspend/reactivate with `POST /api/admin/users/<user-id>/status` and body `{"status":"disabled"}` or `{"status":"active"}`. Admin can list devices at `GET /api/admin/users/<user-id>/devices` and revoke one at `POST /api/admin/users/<user-id>/devices/<device-id>/revoke`.

The extension signs in using `POST /api/device/login` with `{"account":"...","password":"...","device_name":"..."}` and receives a per-profile device token. Passwords are stored as scrypt hashes. Device login attempts are rate-limited. Send the returned token as `Authorization: Bearer <device_token>` to the `/api/<method>` endpoints and on the `/ws/bridge?token=<device_token>` connection. `GET /api/user/me` returns that device's account and device list; a user can revoke one of their devices through `POST /api/user/devices/<device-id>/revoke`. Set `FLOW_MCP_TRUST_PROXY=true` only when requests can reach the app exclusively through the configured reverse proxy, so rate limits can use the forwarded client IP.

## Data and operations

Docker stores the app's token, uploads, and generated output in the `flow-data` named volume. Find its fully qualified name with `docker volume ls` and back it up before upgrades or host migration:

```bash
docker compose down
docker volume inspect <compose-project>_flow-data
docker compose up -d --build
```

`docker compose down` preserves the named volume. Do not add `-v` unless intentionally deleting that data. Store an encrypted backup outside the VPS; the volume contains the SQLite account/device database as well as uploads and output files.

## Current limitations

- SQLite persists each device's job queue and output/upload paths are isolated per device. Queued work resumes when the paired extension reconnects and reports status. A job that was already running during a server restart is marked as an unknown outcome and cannot be retried automatically; check Flow first to avoid duplicate generation or charges.
- VPS sign-in is configured in the extension options: the backend URL is fixed and the user enters their account and password. The extension stores the returned device token and reconnects over authenticated HTTPS long polling. Revoke a lost Chrome profile from the admin UI.
- Configure Codex with `url = "https://<your-domain>/mcp"` and `bearer_token_env_var = "FLOW_MCP_DEVICE_TOKEN"`; configure that environment variable with the device token returned by extension sign-in. Protect the token like a password and revoke the device in the admin UI if it is exposed.
- Direct remote MCP calls run on the VPS. Input file paths refer to the VPS filesystem; upload local media from the extension/Flow UI or stage files on the VPS before using path-based tools.
- A signed-in device represents one browser profile/Flow session. A person using multiple Chrome profiles should sign in on each profile; each gets its own device token and queue.
- The VPS does not host the user's Google Flow session. The extension stays on the user's computer and sends authenticated browser commands to the backend.
