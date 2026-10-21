import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HOME_DIR } from "./paths.js";
import type { Job } from "./job-types.js";

const databasePath = process.env.FLOW_MCP_DB_PATH ?? join(HOME_DIR, "flow-users.sqlite");
mkdirSync(dirname(databasePath), { recursive: true });

const db = new DatabaseSync(databasePath);
chmodSync(databasePath, 0o600);
db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
const { user_version: schemaVersion } = db.prepare("PRAGMA user_version").get() as { user_version: number };
if (schemaVersion > 3) throw new Error(`User database schema ${schemaVersion} is newer than this backend supports.`);
if (schemaVersion < 1) db.exec(`
  BEGIN IMMEDIATE;
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'disabled')) DEFAULT 'active',
    pairing_code_hash TEXT UNIQUE,
    created_at TEXT NOT NULL
  );
  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('active', 'revoked')) DEFAULT 'active',
    created_at TEXT NOT NULL,
    last_seen_at TEXT
  );
  CREATE INDEX devices_user_status ON devices(user_id, status);
  PRAGMA user_version = 1;
  COMMIT;
`);
if (schemaVersion < 2) db.exec(`
  BEGIN IMMEDIATE;
  CREATE TABLE jobs (
    scope_id TEXT NOT NULL,
    id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (scope_id, id)
  );
  CREATE INDEX jobs_scope_created ON jobs(scope_id, updated_at);
  PRAGMA user_version = 2;
  COMMIT;
`);
if (schemaVersion < 3) db.exec(`
  BEGIN IMMEDIATE;
  ALTER TABLE users ADD COLUMN password_hash TEXT;
  PRAGMA user_version = 3;
  COMMIT;
`);

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const passwordHash = (password: string): string => {
  const salt = randomBytes(16).toString("hex");
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString("hex")}`;
};
const passwordMatches = (password: string, stored: string | null): boolean => {
  if (!stored) return false;
  const [algorithm, salt, expectedHex] = stored.split("$");
  if (algorithm !== "scrypt" || !salt || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, "hex");
  const actual = scryptSync(password, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};
const randomCode = () => {
  const raw = randomBytes(12).toString("hex").toUpperCase();
  return `FLOW-${raw.match(/.{1,4}/g)!.join("-")}`;
};
const randomDeviceToken = () => randomBytes(32).toString("base64url");

export type UserSummary = {
  id: string;
  label: string;
  status: "active" | "disabled";
  created_at: string;
  device_count: number;
  pairing_enabled: boolean;
  login_enabled: boolean;
};

export function createUser(label: string): { id: string; label: string; pairing_code: string; created_at: string } {
  const cleanLabel = label.trim().slice(0, 100);
  if (!cleanLabel) throw new Error("User label is required.");
  const existing = db.prepare("SELECT 1 FROM users WHERE label = ? COLLATE NOCASE LIMIT 1").get(cleanLabel);
  if (existing) throw new Error("Account name is already in use.");
  const id = randomUUID();
  const pairingCode = randomCode();
  const createdAt = new Date().toISOString();
  db.prepare("INSERT INTO users (id, label, pairing_code_hash, created_at) VALUES (?, ?, ?, ?)").run(id, cleanLabel, hash(pairingCode), createdAt);
  return { id, label: cleanLabel, pairing_code: pairingCode, created_at: createdAt };
}

export function listUsers(): UserSummary[] {
  return db.prepare(`
    SELECT u.id, u.label, u.status, u.created_at,
      COUNT(CASE WHEN d.status = 'active' THEN 1 END) AS device_count,
      (u.pairing_code_hash IS NOT NULL AND u.status = 'active') AS pairing_enabled,
      (u.password_hash IS NOT NULL AND u.status = 'active') AS login_enabled
    FROM users u LEFT JOIN devices d ON d.user_id = u.id
    GROUP BY u.id ORDER BY u.created_at DESC
  `).all() as unknown as UserSummary[];
}

export function rotatePairingCode(userId: string): { pairing_code: string } {
  const pairingCode = randomCode();
  const result = db.prepare("UPDATE users SET pairing_code_hash = ? WHERE id = ? AND status = 'active'").run(hash(pairingCode), userId);
  if (Number(result.changes) !== 1) throw new Error("Active user not found.");
  return { pairing_code: pairingCode };
}

export function setUserStatus(userId: string, status: "active" | "disabled"): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = db.prepare("UPDATE users SET status = ?, pairing_code_hash = CASE WHEN ? = 'disabled' THEN NULL ELSE pairing_code_hash END WHERE id = ?").run(status, status, userId);
    if (Number(result.changes) !== 1) throw new Error("User not found.");
    if (status === "disabled") db.prepare("UPDATE devices SET status = 'revoked' WHERE user_id = ?").run(userId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function pairDevice(pairingCode: string, label: string): { user_id: string; device_id: string; device_token: string } {
  const user = db.prepare("SELECT id FROM users WHERE pairing_code_hash = ? AND status = 'active'").get(hash(pairingCode.trim().toUpperCase())) as { id: string } | undefined;
  if (!user) throw new Error("Invalid or disabled pairing code.");
  const deviceId = randomUUID();
  const deviceToken = randomDeviceToken();
  const cleanLabel = label.trim().slice(0, 100) || "Chrome device";
  db.prepare("INSERT INTO devices (id, user_id, label, token_hash, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(deviceId, user.id, cleanLabel, hash(deviceToken), new Date().toISOString());
  return { user_id: user.id, device_id: deviceId, device_token: deviceToken };
}

export function setUserPassword(userId: string, password: string): void {
  const result = db.prepare("UPDATE users SET password_hash = ? WHERE id = ? AND status = 'active'")
    .run(passwordHash(password), userId);
  if (Number(result.changes) !== 1) throw new Error("Active user not found.");
}

export function loginDevice(account: string, password: string, label: string): { user_id: string; device_id: string; device_token: string } {
  const matches = db.prepare("SELECT id, password_hash FROM users WHERE label = ? COLLATE NOCASE AND status = 'active' LIMIT 2")
    .all(account.trim()) as Array<{ id: string; password_hash: string | null }>;
  if (matches.length !== 1 || !passwordMatches(password, matches[0].password_hash)) {
    throw new Error("Account or password is incorrect, or the account is disabled.");
  }
  const userId = matches[0].id;
  const deviceId = randomUUID();
  const deviceToken = randomDeviceToken();
  const cleanLabel = label.trim().slice(0, 100) || "Chrome device";
  db.prepare("INSERT INTO devices (id, user_id, label, token_hash, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(deviceId, userId, cleanLabel, hash(deviceToken), new Date().toISOString());
  return { user_id: userId, device_id: deviceId, device_token: deviceToken };
}

export function authenticateDevice(token: string): { user_id: string; device_id: string; label: string } | undefined {
  const device = db.prepare(`
    SELECT d.id AS device_id, d.user_id, d.label
    FROM devices d JOIN users u ON u.id = d.user_id
    WHERE d.token_hash = ? AND d.status = 'active' AND u.status = 'active'
  `).get(hash(token)) as { device_id: string; user_id: string; label: string } | undefined;
  if (device) db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(new Date().toISOString(), device.device_id);
  return device;
}

export function listDevicesForUser(userId: string): Array<{ id: string; label: string; status: string; created_at: string; last_seen_at: string | null }> {
  return db.prepare("SELECT id, label, status, created_at, last_seen_at FROM devices WHERE user_id = ? ORDER BY created_at DESC").all(userId) as unknown as Array<{ id: string; label: string; status: string; created_at: string; last_seen_at: string | null }>;
}

export function revokeDevice(userId: string, deviceId: string): boolean {
  const result = db.prepare("UPDATE devices SET status = 'revoked' WHERE user_id = ? AND id = ? AND status = 'active'").run(userId, deviceId);
  return Number(result.changes) === 1;
}

/** Legacy job storage retained for reading old local MCP data; production Flow work uses the extension queue. */
export function loadJobs(scopeId: string): Job[] {
  const rows = db.prepare("SELECT data FROM jobs WHERE scope_id = ? ORDER BY updated_at, id").all(scopeId) as Array<{ data: string }>;
  return rows.map(({ data }) => JSON.parse(data) as Job);
}

/** Legacy local MCP queue compatibility; new Flow submissions are stored by the extension. */
export function saveJob(scopeId: string, job: Job): void {
  db.prepare(`
    INSERT INTO jobs (scope_id, id, status, data, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(scope_id, id) DO UPDATE SET status = excluded.status, data = excluded.data, updated_at = excluded.updated_at
  `).run(scopeId, job.id, job.status, JSON.stringify(job), new Date().toISOString());
}
