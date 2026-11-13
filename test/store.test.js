import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { encrypt, decrypt, hashToken, randomToken, loadKey } from "../server/crypto.js";
import { openStore } from "../server/store.js";

const keyA = Buffer.alloc(32, 1);
const keyB = Buffer.alloc(32, 2);

function tmpDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "store-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "db.sqlite");
}

const b24 = (over = {}) => ({
  accessToken: "ACCESS-SECRET-123",
  refreshToken: "REFRESH-SECRET-456",
  expiresAt: 5000,
  endpoint: "https://p.example/rest/",
  ...over,
});
const grantInput = (over = {}) => ({
  userId: 7,
  userName: "Ann",
  clientId: "c1",
  readOnlyChoice: true,
  departments: [1, 2],
  b24: b24(),
  ...over,
});

test("encrypt round trip", () => {
  const blob = encrypt("hello", keyA);
  assert.notEqual(blob, "hello");
  assert.equal(decrypt(blob, keyA), "hello");
  assert.notEqual(encrypt("hello", keyA), blob);
  assert.throws(() => decrypt(blob, keyB));
  const buf = Buffer.from(blob, "base64");
  buf[buf.length - 1] ^= 1;
  assert.throws(() => decrypt(buf.toString("base64"), keyA));
});

test("hashToken, randomToken, loadKey", () => {
  assert.match(hashToken("x"), /^[0-9a-f]{64}$/);
  assert.notEqual(randomToken(), randomToken());
  assert.equal(Buffer.from(randomToken(), "base64url").length, 32);
  assert.equal(loadKey(keyA.toString("base64")).length, 32);
  assert.throws(() => loadKey(Buffer.alloc(16).toString("base64")));
});

test("clients: save, get, touch", (t) => {
  const s = openStore(tmpDb(t), keyA);
  assert.equal(s.getClient("c1"), null);
  s.saveClient({ client_id: "c1", redirect_uris: ["http://x/cb"], client_name: "X" });
  assert.deepEqual(s.getClient("c1").redirect_uris, ["http://x/cb"]);
  s.touchClient("c1");
  assert.equal(s.getClient("c1").client_name, "X");
  s.close?.();
});

test("pending and codes are single use and expire", (t) => {
  const s = openStore(tmpDb(t), keyA);
  s.savePending("p1", { a: 1 }, 60_000);
  assert.deepEqual(s.takePending("p1"), { a: 1 });
  assert.equal(s.takePending("p1"), null);
  s.savePending("p2", { a: 2 }, -1);
  assert.equal(s.takePending("p2"), null);
  s.saveCode("h1", { b: 1 }, 60_000);
  assert.deepEqual(s.takeCode("h1"), { b: 1 });
  assert.equal(s.takeCode("h1"), null);
  s.saveCode("h2", { b: 2 }, -1);
  assert.equal(s.takeCode("h2"), null);
});

test("grant create/get/update/delete", (t) => {
  const s = openStore(tmpDb(t), keyA);
  const id = s.createGrant(grantInput());
  const g = s.getGrant(id);
  assert.equal(g.userId, 7);
  assert.equal(g.userName, "Ann");
  assert.equal(g.clientId, "c1");
  assert.equal(g.readOnlyChoice, true);
  assert.deepEqual(g.departments, [1, 2]);
  assert.deepEqual(g.b24, b24());
  s.updateGrantTokens(id, b24({ accessToken: "NEW", expiresAt: 9 }));
  assert.equal(s.getGrant(id).b24.accessToken, "NEW");
  assert.equal(s.getGrant(id).b24.expiresAt, 9);
  s.updateGrantUser(id, { departments: [3], userName: "Bob" });
  assert.deepEqual(s.getGrant(id).departments, [3]);
  assert.equal(s.getGrant(id).userName, "Bob");
  s.saveToken("t1", { grantId: id, kind: "access", expiresAt: 100 });
  assert.equal(s.getToken("t1").grantId, id);
  assert.equal(s.getToken("t1").kind, "access");
  s.deleteGrant(id);
  assert.equal(s.getGrant(id), null);
  assert.equal(s.getToken("t1"), null);
});

test("tokens: delete and deleteTokensOfGrant", (t) => {
  const s = openStore(tmpDb(t), keyA);
  const id = s.createGrant(grantInput());
  s.saveToken("a", { grantId: id, kind: "access", expiresAt: 100 });
  s.saveToken("r", { grantId: id, kind: "refresh", expiresAt: 100 });
  s.deleteToken("a");
  assert.equal(s.getToken("a"), null);
  s.deleteTokensOfGrant(id);
  assert.equal(s.getToken("r"), null);
  assert.notEqual(s.getGrant(id), null);
});

test("grant tokens are encrypted at rest", (t) => {
  const file = tmpDb(t);
  const s = openStore(file, keyA);
  s.createGrant(grantInput());
  s.close?.();
  const raw = new DatabaseSync(file);
  const rows = raw.prepare("SELECT * FROM grants").all();
  raw.close();
  assert.equal(rows.length, 1);
  const text = JSON.stringify(rows);
  assert.ok(!text.includes("ACCESS-SECRET-123"));
  assert.ok(!text.includes("REFRESH-SECRET-456"));
});

test("wrong key fails closed", (t) => {
  const file = tmpDb(t);
  const a = openStore(file, keyA);
  const id = a.createGrant(grantInput());
  a.close?.();
  const b = openStore(file, keyB);
  assert.equal(b.getGrant(id), null);
  b.close?.();
  const raw = new DatabaseSync(file);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM grants").get().n, 0);
  raw.close();
});

test("cleanup removes expired", (t) => {
  const s = openStore(tmpDb(t), keyA);
  const now = Date.now() + 11 * 60_000; // grants created above are older than the 10 min grace
  s.savePending("old", {}, -1);
  s.saveCode("oldc", {}, -1);
  const g1 = s.createGrant(grantInput());
  const g2 = s.createGrant(grantInput());
  const g3 = s.createGrant(grantInput());
  s.saveToken("lr", { grantId: g1, kind: "refresh", expiresAt: now + 1000 });
  s.saveToken("la", { grantId: g1, kind: "access", expiresAt: now - 1 });
  s.saveToken("dr", { grantId: g2, kind: "refresh", expiresAt: now - 1 });
  s.saveToken("na", { grantId: g3, kind: "access", expiresAt: now + 1000 });
  s.cleanup(now);
  assert.equal(s.getToken("la"), null);
  assert.notEqual(s.getToken("lr"), null);
  assert.equal(s.getToken("dr"), null);
  assert.notEqual(s.getGrant(g1), null);
  assert.equal(s.getGrant(g2), null);
  assert.equal(s.getGrant(g3), null);
  assert.equal(s.getToken("na"), null);
});

test("cleanup keeps a fresh grant without tokens (awaiting code exchange)", (t) => {
  const s = openStore(tmpDb(t), keyA);
  const fresh = s.createGrant(grantInput());
  s.cleanup(Date.now() + 5 * 60_000);
  assert.notEqual(s.getGrant(fresh), null);
  s.cleanup(Date.now() + 11 * 60_000);
  assert.equal(s.getGrant(fresh), null);
});

test("corrupt grant data fails closed", (t) => {
  const file = tmpDb(t);
  const s = openStore(file, keyA);
  const id = s.createGrant(grantInput());
  s.close();
  const raw = new DatabaseSync(file);
  raw.prepare("UPDATE grants SET departments = 'not json'").run();
  raw.close();
  const s2 = openStore(file, keyA);
  assert.equal(s2.getGrant(id), null);
  s2.close();
});

test("cleanup removes clients unused for 30 days", (t) => {
  const s = openStore(tmpDb(t), keyA);
  s.saveClient({ client_id: "c" });
  s.cleanup(Date.now() + 29 * 86_400_000);
  assert.notEqual(s.getClient("c"), null);
  s.cleanup(Date.now() + 31 * 86_400_000);
  assert.equal(s.getClient("c"), null);
});
