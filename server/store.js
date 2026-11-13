// HTTP-mode only (node:sqlite, Node >= 22/24). Do not import from the stdio entry points.
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import { encrypt, decrypt } from "./crypto.js";

// A grant is created at consent; its tokens appear only when the client exchanges the code (<= code TTL).
const GRANT_GRACE_MS = 10 * 60 * 1000;
const CLIENT_IDLE_MS = 30 * 24 * 60 * 60 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY, info TEXT NOT NULL, last_used_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pending (
  id TEXT PRIMARY KEY, data TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS codes (
  hash TEXT PRIMARY KEY, data TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, user_name TEXT,
  client_id TEXT NOT NULL, read_only_choice INTEGER NOT NULL, departments TEXT NOT NULL,
  b24_access TEXT NOT NULL, b24_refresh TEXT NOT NULL, b24_expires_at INTEGER NOT NULL,
  b24_endpoint TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tokens (
  hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL, kind TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS tokens_grant ON tokens(grant_id);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export function openStore(file, key) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);
  const q = (sql) => db.prepare(sql);

  function take(table, col, id) {
    const row = q(`DELETE FROM ${table} WHERE ${col} = ? RETURNING data, expires_at`).get(id);
    if (!row) return null;
    return row.expires_at > Date.now() ? JSON.parse(row.data) : null;
  }

  function deleteGrant(id) {
    q("DELETE FROM tokens WHERE grant_id = ?").run(id);
    q("DELETE FROM grants WHERE id = ?").run(id);
  }

  return {
    close: () => db.close(),

    getClient(id) {
      const row = q("SELECT info FROM clients WHERE id = ?").get(id);
      return row ? JSON.parse(row.info) : null;
    },
    saveClient(info) {
      q("INSERT OR REPLACE INTO clients (id, info, last_used_at) VALUES (?, ?, ?)").run(
        info.client_id, JSON.stringify(info), Date.now());
    },
    touchClient(id) {
      q("UPDATE clients SET last_used_at = ? WHERE id = ?").run(Date.now(), id);
    },

    savePending(id, data, ttlMs) {
      q("INSERT OR REPLACE INTO pending (id, data, expires_at) VALUES (?, ?, ?)").run(
        id, JSON.stringify(data), Date.now() + ttlMs);
    },
    takePending: (id) => take("pending", "id", id),

    saveCode(hash, data, ttlMs) {
      q("INSERT OR REPLACE INTO codes (hash, data, expires_at) VALUES (?, ?, ?)").run(
        hash, JSON.stringify(data), Date.now() + ttlMs);
    },
    takeCode: (hash) => take("codes", "hash", hash),
    /** Non-consuming read of an unexpired code (for PKCE challenge lookup). */
    getCode(hash) {
      const row = q("SELECT data, expires_at FROM codes WHERE hash = ?").get(hash);
      return row && row.expires_at > Date.now() ? JSON.parse(row.data) : null;
    },

    getMeta(key) {
      const row = q("SELECT value FROM meta WHERE key = ?").get(key);
      return row ? row.value : null;
    },
    setMeta(key, value) {
      q("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, String(value));
    },
    /** First-seen value: stores `value` only if the key is absent, returns whatever is stored afterwards. */
    initMeta(key, value) {
      q("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)").run(key, String(value));
      return q("SELECT value FROM meta WHERE key = ?").get(key).value;
    },

    createGrant({ userId, userName, clientId, readOnlyChoice, departments, b24 }) {
      const id = crypto.randomUUID();
      q(`INSERT INTO grants (id, user_id, user_name, client_id, read_only_choice, departments,
           b24_access, b24_refresh, b24_expires_at, b24_endpoint, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, userId, userName ?? null, clientId, readOnlyChoice ? 1 : 0,
        JSON.stringify(departments ?? []),
        encrypt(b24.accessToken, key), encrypt(b24.refreshToken, key),
        b24.expiresAt, b24.endpoint, Date.now());
      return id;
    },
    getGrant(id) {
      const r = q("SELECT * FROM grants WHERE id = ?").get(id);
      if (!r) return null;
      let accessToken, refreshToken, departments;
      try {
        departments = JSON.parse(r.departments);
        accessToken = decrypt(r.b24_access, key);
        refreshToken = decrypt(r.b24_refresh, key);
      } catch {
        deleteGrant(id);
        return null;
      }
      return {
        id: r.id,
        userId: r.user_id,
        userName: r.user_name,
        clientId: r.client_id,
        readOnlyChoice: !!r.read_only_choice,
        departments,
        createdAt: r.created_at,
        b24: { accessToken, refreshToken, expiresAt: r.b24_expires_at, endpoint: r.b24_endpoint },
      };
    },
    updateGrantTokens(id, b24) {
      q("UPDATE grants SET b24_access = ?, b24_refresh = ?, b24_expires_at = ?, b24_endpoint = ? WHERE id = ?").run(
        encrypt(b24.accessToken, key), encrypt(b24.refreshToken, key), b24.expiresAt, b24.endpoint, id);
    },
    updateGrantUser(id, { departments, userName }) {
      q("UPDATE grants SET departments = ?, user_name = ? WHERE id = ?").run(
        JSON.stringify(departments ?? []), userName ?? null, id);
    },
    deleteGrant,
    countGrants: () => q("SELECT COUNT(*) AS n FROM grants").get().n,

    saveToken(hash, { grantId, kind, expiresAt }) {
      q("INSERT OR REPLACE INTO tokens (hash, grant_id, kind, expires_at) VALUES (?, ?, ?, ?)").run(
        hash, grantId, kind, expiresAt);
    },
    getToken(hash) {
      const r = q("SELECT grant_id, kind, expires_at FROM tokens WHERE hash = ?").get(hash);
      return r ? { grantId: r.grant_id, kind: r.kind, expiresAt: r.expires_at } : null;
    },
    deleteToken(hash) {
      q("DELETE FROM tokens WHERE hash = ?").run(hash);
    },
    deleteTokensOfGrant(grantId) {
      q("DELETE FROM tokens WHERE grant_id = ?").run(grantId);
    },

    cleanup(now = Date.now()) {
      q("DELETE FROM pending WHERE expires_at <= ?").run(now);
      q("DELETE FROM codes WHERE expires_at <= ?").run(now);
      q("DELETE FROM tokens WHERE expires_at <= ?").run(now);
      q(`DELETE FROM tokens WHERE grant_id IN (SELECT id FROM grants WHERE created_at <= ? AND id NOT IN
           (SELECT grant_id FROM tokens WHERE kind = 'refresh'))`).run(now - GRANT_GRACE_MS);
      q("DELETE FROM grants WHERE created_at <= ? AND id NOT IN (SELECT grant_id FROM tokens WHERE kind = 'refresh')").run(
        now - GRANT_GRACE_MS);
      q("DELETE FROM clients WHERE last_used_at <= ?").run(now - CLIENT_IDLE_MS);
    },
  };
}
