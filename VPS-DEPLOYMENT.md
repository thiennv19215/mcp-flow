# VPS account verification service

The VPS runs the account and device verification service only. Flow automation, generation queues, uploads, media, and the AI MCP process stay on the user's computer. The extension calls the VPS only to verify account credentials and receive a revocable device token; its Flow operations run inside the extension.

## Requirements

- Linux VPS with Docker Engine and Docker Compose.
- A DNS name pointing to the VPS. Allow inbound TCP 80 and 443 for HTTPS through Caddy.
- SSH access to the VPS.

## Configure and start

1. Copy the project to the VPS and enter its project directory.
2. Create `.env` and set unique values:

   ```bash
   cp .env.example .env
   openssl rand -hex 32
   ```

   Set `FLOW_AUTH_PUBLIC_URL` to the HTTPS URL and include that host plus the container health-check hosts in `FLOW_AUTH_ALLOWED_HOSTS`. Set a private `FLOW_AUTH_ADMIN_USER` and a `FLOW_AUTH_ADMIN_PASSWORD` with at least 16 characters. Keep `.env` private; it is ignored by Git.

3. Build and start the auth service:

   ```bash
   docker compose up -d --build
   docker compose ps
   docker compose logs --tail=100 flow-auth
   ```

4. Configure Caddy to reverse proxy `flow.example.com` to `http://127.0.0.1:18899`. Caddy's `reverse_proxy` preserves the Host header and handles HTTPS certificates. For Cloudflare Tunnel, route the hostname to the same loopback address and set `FLOW_AUTH_TRUST_PROXY=true` only when the app can be reached exclusively through the trusted proxy.
5. Open `https://<your-domain>` and sign in with the auth admin credentials. Use `/admin` to create user accounts, set passwords, inspect devices, revoke devices, or disable accounts.

The container's port is published only on `127.0.0.1`. Keep it behind the HTTPS reverse proxy and do not expose port 18899 to the public internet.

## User and device accounts

Create users through `/admin`, then set a password for each account. The extension signs in with the account label and password; the server stores scrypt password hashes and issues a per-profile device token. Login and pairing attempts are rate limited. An administrator can revoke a device or disable an account at any time.

The extension stores the returned token for account/device management. It does not use that token to send Flow commands to the VPS. The local stdio MCP for AI is a separate process on the user's computer and does not use the VPS auth service.

## Data and operations

Docker stores the SQLite account/device database in the `flow-data` named volume. Back it up before upgrades or host migration:

```bash
docker compose down
docker volume inspect <compose-project>_flow-data
docker compose up -d --build
```

`docker compose down` preserves the named volume. Do not add `-v` unless intentionally deleting account and device records.
