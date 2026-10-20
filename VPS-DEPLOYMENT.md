# VPS deployment (backend only)

This deploys the HTTP backend and Studio on one Linux VPS behind Caddy-managed HTTPS. It keeps the application port bound to loopback; only the reverse proxy should be reachable from the internet. The extension source is not changed by this setup.

## Before deployment

- A Linux VPS with Docker Engine and the Docker Compose plugin.
- A DNS name pointing to the VPS. Allow inbound TCP 80 and 443 for Caddy's TLS certificate.
- SSH access to the VPS.

The backend now has user and device accounts in SQLite. Device bearer tokens select a separate persisted job queue, Flow WebSocket connection, uploads, and output directory for each paired device. Keep the admin credentials private; users should receive only their pairing code.

The checked-in extension still restricts its bridge URL to localhost and does not perform pairing or send a device token. The backend is ready for that protocol, but browser control from a remote user's computer requires a later extension update. The public WebSocket rejects connections without a valid device token or the configured server WebSocket secret.

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
5. Open `https://<your-domain>`. The Studio is protected by the HTTP Basic username/password from `.env`; its API also requires `FLOW_MCP_TOKEN`.

The Compose port is published only on `127.0.0.1`. Do not change it to `0.0.0.0` or open port 18899 in the VPS firewall. Serve it through HTTPS at 443.

## Cloudflare Tunnel option

You can use a Cloudflare Tunnel instead of Caddy and inbound ports 80/443. Create a public hostname such as `flow.example.com` in Cloudflare Zero Trust and route it to `http://127.0.0.1:18899` on the VPS. Keep `FLOW_MCP_PUBLIC_URL=https://flow.example.com` and include `flow.example.com` in `FLOW_MCP_ALLOWED_HOSTS`. The tunnel forwards WebSocket upgrades. Keep the Compose loopback-only port binding and firewall closed; only `cloudflared` on the VPS should reach the app. `FLOW_MCP_TRUST_PROXY=true` lets pairing rate limits use Cloudflare's client IP header.

## User and device registry API

The backend can create users and issue a pairing code. Create a user with the admin Basic credentials; the returned `pairing_code` is only shown once:

```bash
curl -u admin -H 'content-type: application/json' \
  -d '{"label":"Customer A"}' https://<your-domain>/api/admin/users
```

List users at `GET /api/admin/users`. Rotate a user's code with `POST /api/admin/users/<user-id>/rotate-code`; suspend/reactivate with `POST /api/admin/users/<user-id>/status` and body `{"status":"disabled"}` or `{"status":"active"}`. Re-enabling a user requires rotating a new pairing code. Admin can list devices at `GET /api/admin/users/<user-id>/devices` and revoke one at `POST /api/admin/users/<user-id>/devices/<device-id>/revoke`.

The extension will exchange the user's code for a per-installation token using `POST /api/pair` with `{"user_code":"...","device_name":"..."}`. Send the returned token as `Authorization: Bearer <device_token>` to the `/api/<method>` endpoints and on the `/ws/bridge?token=<device_token>` connection. `GET /api/user/me` returns that device's account and device list; a user can revoke one of their devices through `POST /api/user/devices/<device-id>/revoke`. Pair attempts are rate-limited. Set `FLOW_MCP_TRUST_PROXY=true` only when requests can reach the app exclusively through the configured reverse proxy, so rate limits can use the forwarded client IP.

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
- The current extension only accepts localhost bridge URLs and has no pairing UI/token storage. It must be updated to use the public HTTPS/WSS URL, exchange the pairing code, store its device token securely, and reconnect with that token.
- A paired device represents one browser profile/Flow session. A person using multiple Chrome profiles should pair each profile separately; each gets its own device token and queue.
- The VPS does not host the user's Google Flow session. The extension stays on the user's computer and sends authenticated browser commands to the backend.
