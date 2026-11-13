import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startEnv, login, postForm, SECRET_KEY, CLIENT_SECRET } from "./fakes/env.js";
import { main } from "../server/http.js";
import { openStore } from "../server/store.js";
import { loadKey } from "../server/crypto.js";

/** REST methods the tools below need, answered per user. */
function restFor(fake) {
  fake.rest = {
    profile: (p, userId) => ({ result: { ID: String(userId), NAME: fake.users[userId].NAME, ADMIN: false } }),
    scope: () => ({ result: ["task", "im", "user"] }),
    "im.recent.list": () => ({ result: { items: [{ id: "chat44", chat_id: 44, title: "Team", date_update: new Date().toISOString() }], hasMore: false } }),
    "im.dialog.get": () => ({ result: { id: 44, name: "Team" } }),
    batch: () => ({ result: { result: { c0: { messages: [] } }, result_error: {} } }),
  };
}

async function setup(t, env) {
  const e = await startEnv(t, env);
  restFor(e.fake);
  return e;
}

async function mcpClient(t, env, accessToken) {
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${env.base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}

/** One raw JSON-RPC tools/call (no initialize: the server is stateless). */
async function rawCall(env, accessToken, name, args = {}) {
  const res = await fetch(`${env.base}/mcp`, {
    method: "POST",
    headers: {
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch { /* not JSON */ }
  return { status: res.status, headers: res.headers, text, body };
}

const resultJson = (r) => JSON.parse(r.body.result.content[0].text);

async function signedIn(env, opts) {
  const l = await login(env, opts);
  const info = await env.provider.verifyAccessToken(l.tokens.access_token);
  return { ...l, bearer: l.tokens.access_token, grantId: info.extra.grantId };
}

const restReqs = (fake, method) => fake.reqs.filter((r) => r.path === `/rest/${method}.json`).map((r) => JSON.parse(r.body || "{}"));
const refreshReqs = (fake) => fake.reqs.filter((r) => r.path === "/oauth/token/" && r.query.grant_type === "refresh_token");

function expireBitrixToken(env, grantId) {
  env.fake.access.get(env.store.getGrant(grantId).b24.accessToken).expired = true;
}

test("tools list over HTTP", async (t) => {
  const env = await setup(t);
  const { bearer } = await signedIn(env);
  const client = await mcpClient(t, env, bearer);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 35);
  assert.ok(tools.some((x) => x.name === "call_summaries"));
  assert.match(env.logs.join("\n"), /POST \/mcp 200 user=5/);
});

test("call_summaries over HTTP uses the user's token", async (t) => {
  const env = await setup(t);
  const { bearer, grantId } = await signedIn(env);
  const client = await mcpClient(t, env, bearer);
  const r = await client.callTool({ name: "call_summaries", arguments: {} });
  assert.ok(!r.isError, r.content[0].text);
  assert.equal(JSON.parse(r.content[0].text).chats_scanned, 1);
  const token = env.store.getGrant(grantId).b24.accessToken;
  const used = env.fake.reqs.filter((x) => x.path.startsWith("/rest/") && x.path !== "/rest/user.current.json");
  assert.ok(used.length >= 2);
  for (const x of used) assert.equal(JSON.parse(x.body).auth, token);
});

test("two grants in parallel", async (t) => {
  const env = await setup(t);
  const ann = await signedIn(env, { userId: 5 });
  const bob = await signedIn(env, { userId: 10 });
  const annToken = env.store.getGrant(ann.grantId).b24.accessToken;
  const bobToken = env.store.getGrant(bob.grantId).b24.accessToken;
  const before = env.fake.reqs.length;
  const calls = [];
  for (let i = 0; i < 4; i++) {
    calls.push(rawCall(env, ann.bearer, "b24_whoami").then((r) => ["5", r]));
    calls.push(rawCall(env, bob.bearer, "b24_whoami").then((r) => ["10", r]));
  }
  for (const [uid, r] of await Promise.all(calls)) {
    assert.equal(r.status, 200, r.text);
    assert.equal(resultJson(r).user.ID, uid);
    assert.equal(resultJson(r).portal, env.fake.origin);
  }
  const profiles = env.fake.reqs.slice(before).filter((x) => x.path === "/rest/profile.json").map((x) => JSON.parse(x.body).auth);
  assert.equal(profiles.length, 8);
  assert.equal(profiles.filter((a) => a === annToken).length, 4);
  assert.equal(profiles.filter((a) => a === bobToken).length, 4);
});

test("expired bitrix token is refreshed", async (t) => {
  const env = await setup(t);
  const { bearer, grantId } = await signedIn(env);
  const old = env.store.getGrant(grantId).b24;
  // a client is cached for the grant
  assert.equal((await rawCall(env, bearer, "b24_whoami")).status, 200);
  expireBitrixToken(env, grantId);
  const r = await rawCall(env, bearer, "b24_whoami");
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.result.isError, undefined, r.text);
  assert.equal(resultJson(r).user.ID, "5");
  assert.equal(refreshReqs(env.fake).length, 1);
  const now = env.store.getGrant(grantId).b24;
  assert.notEqual(now.accessToken, old.accessToken);
  assert.notEqual(now.refreshToken, old.refreshToken);
  assert.ok(env.fake.issued.includes(now.accessToken) && env.fake.issued.includes(now.refreshToken));
  assert.ok(now.expiresAt > Date.now() + 3000e3, "expires_in seconds converted to ms");
  assert.equal(now.endpoint, old.endpoint);
  // re-check after refresh: user.current with the new token
  assert.equal(restReqs(env.fake, "user.current").at(-1).auth, now.accessToken);
  // nothing secret in the logs
  const all = env.logs.join("\n");
  for (const s of [bearer, CLIENT_SECRET, SECRET_KEY, ...env.fake.issued]) assert.ok(!all.includes(s), "log leaks a secret");
});

test("token near expiry is refreshed before the request, and the re-check applies to that request", async (t) => {
  const env = await setup(t, { READ_ONLY_DEPARTMENTS: "7" });
  const { bearer, grantId } = await signedIn(env, { userId: 10 });
  assert.equal(resultJson(await rawCall(env, bearer, "b24_whoami")).read_only_mode, false);
  env.fake.users[10].UF_DEPARTMENT = [12]; // moved under read-only department 7
  const g = env.store.getGrant(grantId);
  env.store.updateGrantTokens(grantId, { ...g.b24, expiresAt: Date.now() + 1000 });
  env.restart(); // the cached client remembers the old expiry; a new process reads it from the store
  const r = await rawCall(env, bearer, "b24_whoami");
  assert.equal(r.status, 200, r.text);
  assert.equal(refreshReqs(env.fake).length, 1);
  assert.ok(env.store.getGrant(grantId).b24.expiresAt > Date.now() + 3000e3);
  assert.equal(resultJson(r).read_only_mode, true, "refreshed before the tools were registered");
});

test("revoked bitrix refresh token", async (t) => {
  const env = await setup(t);
  const { bearer, grantId } = await signedIn(env);
  env.fake.refresh.clear();
  expireBitrixToken(env, grantId);
  const r = await rawCall(env, bearer, "b24_whoami");
  assert.equal(r.status, 401, r.text);
  const www = r.headers.get("www-authenticate");
  assert.match(www, /^Bearer error="invalid_token"/);
  assert.ok(www.includes(`resource_metadata="${env.base}/.well-known/oauth-protected-resource/mcp"`), www);
  assert.equal(r.body.error, "invalid_token");
  assert.equal(env.store.getGrant(grantId), null);
  assert.equal(env.app.locals.grants.has(grantId), false, "cached client dropped");
  await assert.rejects(env.provider.verifyAccessToken(bearer));
  assert.equal((await rawCall(env, bearer, "b24_whoami")).status, 401);
});

test("deactivated user loses access at next refresh (errors swallowed inside a tool still end in 401)", async (t) => {
  const env = await setup(t);
  const { bearer, grantId } = await signedIn(env);
  assert.equal((await rawCall(env, bearer, "b24_whoami")).status, 200);
  env.fake.users[5].ACTIVE = false;
  expireBitrixToken(env, grantId);
  // call_summaries catches per-chat errors itself; the auth failure must still escape.
  const r = await rawCall(env, bearer, "call_summaries", { chat_ids: ["chat44"] });
  assert.equal(r.status, 401, r.text);
  assert.match(r.headers.get("www-authenticate"), /error="invalid_token"/);
  assert.equal(env.store.getGrant(grantId), null);
  assert.equal(env.store.countGrants(), 0);
});

test("transient refresh failure answers 503 and keeps the grant", async (t) => {
  const env = await setup(t);
  const { bearer, grantId } = await signedIn(env);
  env.fake.tokenFailure = { status: 502, body: { error: "bad_gateway" } };
  expireBitrixToken(env, grantId);
  const r = await rawCall(env, bearer, "b24_whoami");
  assert.equal(r.status, 503, r.text);
  assert.ok(Number(r.headers.get("retry-after")) > 0);
  assert.ok(env.store.getGrant(grantId));
  env.fake.tokenFailure = null;
  const again = await rawCall(env, bearer, "b24_whoami");
  assert.equal(again.status, 200, again.text);
  assert.equal(resultJson(again).user.ID, "5");
});

for (const error of ["expired_token", "invalid_token", "NO_AUTH_FOUND"]) {
  test(`token endpoint error ${error} counts as a revoked grant`, async (t) => {
    const env = await setup(t);
    const { bearer, grantId } = await signedIn(env);
    env.fake.tokenFailure = { status: 400, body: { error } };
    expireBitrixToken(env, grantId);
    assert.equal((await rawCall(env, bearer, "b24_whoami")).status, 401);
    assert.equal(env.store.getGrant(grantId), null);
  });
}

test("user added to READ_ONLY_DEPARTMENTS parent becomes read-only at next refresh", async (t) => {
  const env = await setup(t, { READ_ONLY_DEPARTMENTS: "7" });
  const { bearer, grantId } = await signedIn(env, { userId: 10 }); // department 1, parent of 7: not forced
  let r = await rawCall(env, bearer, "b24_whoami");
  assert.equal(resultJson(r).read_only_mode, false);
  env.fake.users[10].UF_DEPARTMENT = [12]; // child of 7
  env.fake.users[10].NAME = "Robert";
  // no refresh yet: still read-write
  r = await rawCall(env, bearer, "b24_whoami");
  assert.equal(resultJson(r).read_only_mode, false);
  expireBitrixToken(env, grantId);
  assert.equal((await rawCall(env, bearer, "b24_whoami")).status, 200);
  const g = env.store.getGrant(grantId);
  assert.deepEqual(g.departments, [12]);
  assert.equal(g.userName, "Robert Sample");
  r = await rawCall(env, bearer, "b24_whoami");
  assert.equal(resultJson(r).read_only_mode, true);
  const w = await rawCall(env, bearer, "task_create", { title: "x", responsible_id: 10 });
  assert.equal(w.status, 200);
  assert.equal(w.body.result.isError, true);
  assert.match(w.body.result.content[0].text, /read-only/);
});

test("user's own read-only choice applies over HTTP", async (t) => {
  const env = await setup(t);
  const { bearer } = await signedIn(env, { consent: { read_only: "1" } });
  assert.equal(resultJson(await rawCall(env, bearer, "b24_whoami")).read_only_mode, true);
});

test("restart keeps grant", async (t) => {
  const env = await setup(t);
  const { bearer } = await signedIn(env);
  assert.equal((await rawCall(env, bearer, "b24_whoami")).status, 200);
  env.restart();
  const r = await rawCall(env, bearer, "b24_whoami");
  assert.equal(r.status, 200, r.text);
  assert.equal(resultJson(r).user.ID, "5");
});

test("no bearer → 401 with resource metadata link", async (t) => {
  const env = await setup(t);
  const r = await rawCall(env, null, "b24_whoami");
  assert.equal(r.status, 401);
  const www = r.headers.get("www-authenticate");
  assert.match(www, /^Bearer error="invalid_token"/);
  const url = www.match(/resource_metadata="([^"]+)"/)?.[1];
  assert.equal(url, `${env.base}/.well-known/oauth-protected-resource/mcp`);
  const meta = await (await fetch(url)).json();
  assert.equal(meta.resource, `${env.base}/mcp`);
  assert.deepEqual(meta.authorization_servers.map((s) => s.replace(/\/$/, "")), [env.base]);
  const bad = await rawCall(env, "not-a-token", "b24_whoami");
  assert.equal(bad.status, 401);
});

test("GET and DELETE /mcp answer 405 (stateless server)", async (t) => {
  const env = await setup(t);
  const { bearer } = await signedIn(env);
  for (const method of ["GET", "DELETE"]) {
    const r = await fetch(`${env.base}/mcp`, { method, headers: { Authorization: `Bearer ${bearer}`, Accept: "text/event-stream" } });
    assert.equal(r.status, 405, method);
    assert.equal(r.headers.get("allow"), "POST");
  }
  assert.equal((await fetch(`${env.base}/mcp`, { method: "GET" })).status, 401, "auth first");
});

test("main runs store cleanup at start", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "http-main-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "bitrix24-mcp.sqlite");
  const s = openStore(file, loadKey(SECRET_KEY));
  s.createGrant({ userId: 5, userName: "A", clientId: "c", readOnlyChoice: false, departments: [], b24: { accessToken: "a", refreshToken: "r", expiresAt: 1, endpoint: "https://p.example/rest/" } });
  s.close();
  const db = new DatabaseSync(file);
  db.prepare("UPDATE grants SET created_at = 0").run();
  db.close();
  const logs = [];
  const m = main({
    PUBLIC_URL: "http://127.0.0.1:1", B24_PORTAL: "https://portal.example", B24_CLIENT_ID: "x", B24_CLIENT_SECRET: "y",
    SECRET_KEY, DATA_DIR: dir, PORT: "0",
  }, { log: (l) => logs.push(l), signals: false });
  t.after(() => m.close());
  await new Promise((r) => (m.server.listening ? r() : m.server.once("listening", r)));
  assert.equal(m.app.locals.store.countGrants(), 0);
  const h = await fetch(`http://127.0.0.1:${m.server.address().port}/healthz`);
  assert.equal(h.status, 200);
  assert.deepEqual(await h.json(), { status: "ok" });
});

test("client_endpoint without a trailing slash works through login, tool call and refresh", async (t) => {
  const env = await setup(t);
  env.fake.clientEndpoint = `${env.fake.origin}/rest`;
  const { bearer, grantId } = await signedIn(env);
  assert.equal(env.store.getGrant(grantId).b24.endpoint, `${env.fake.origin}/rest/`);
  assert.equal(resultJson(await rawCall(env, bearer, "b24_whoami")).user.ID, "5");
  expireBitrixToken(env, grantId);
  const r = await rawCall(env, bearer, "b24_whoami");
  assert.equal(r.status, 200, r.text);
  assert.equal(refreshReqs(env.fake).length, 1);
  assert.equal(env.store.getGrant(grantId).b24.endpoint, `${env.fake.origin}/rest/`);
  assert.equal(restReqs(env.fake, "user.current").at(-1).auth, env.store.getGrant(grantId).b24.accessToken);
});

test("http mode instructions describe the signed-in user", async (t) => {
  const env = await setup(t);
  const { bearer } = await signedIn(env);
  const client = await mcpClient(t, env, bearer);
  const text = client.getInstructions();
  assert.match(text, /signed-in user/);
  assert.doesNotMatch(text, /webhook/i);
});

async function refreshAt(env, client, refreshToken) {
  const r = await postForm(`${env.base}/token`, { grant_type: "refresh_token", refresh_token: refreshToken, client_id: client.client_id });
  return { status: r.status, body: await r.json() };
}

test("/revoke evicts the grant's cached Bitrix client", async (t) => {
  const env = await setup(t);
  const { bearer, grantId, client, tokens } = await signedIn(env);
  assert.equal((await rawCall(env, bearer, "b24_whoami")).status, 200);
  assert.equal(env.app.locals.grants.has(grantId), true, "client cached after a call");
  const r = await postForm(`${env.base}/revoke`, { token: tokens.refresh_token, client_id: client.client_id });
  assert.equal(r.status, 200);
  assert.equal(env.app.locals.grants.has(grantId), false, "cached client evicted");
  assert.equal(env.store.getGrant(grantId), null);
  assert.equal((await rawCall(env, bearer, "b24_whoami")).status, 401);
});

test("reuse of a rotated refresh token revokes the whole grant", async (t) => {
  const env = await setup(t);
  const { bearer, grantId, client, tokens } = await signedIn(env);
  assert.equal((await rawCall(env, bearer, "b24_whoami")).status, 200);
  const r1 = await refreshAt(env, client, tokens.refresh_token);
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.equal((await rawCall(env, r1.body.access_token, "b24_whoami")).status, 200);
  assert.equal(env.app.locals.grants.has(grantId), true);
  // a second rotation must not forget the first rotated token
  const r2 = await refreshAt(env, client, r1.body.refresh_token);
  assert.equal(r2.status, 200, JSON.stringify(r2.body));

  const reuse = await refreshAt(env, client, tokens.refresh_token);
  assert.equal(reuse.status, 400);
  assert.equal(reuse.body.error, "invalid_grant");
  assert.equal(env.store.getGrant(grantId), null, "grant deleted");
  assert.equal(env.app.locals.grants.has(grantId), false, "cached client evicted");
  assert.equal((await rawCall(env, r2.body.access_token, "b24_whoami")).status, 401, "current access token revoked");
  const next = await refreshAt(env, client, r2.body.refresh_token);
  assert.equal(next.status, 400, "current refresh token revoked");
  assert.equal(next.body.error, "invalid_grant");
});

test("restart with a different SECRET_KEY: old bearer gets 401 and the grant is gone", async (t) => {
  const env = await setup(t);
  const { bearer, grantId, client, tokens } = await signedIn(env);
  assert.equal((await rawCall(env, bearer, "b24_whoami")).status, 200);
  env.restart({ SECRET_KEY: Buffer.alloc(32, 9).toString("base64") });
  restFor(env.fake);
  const r = await rawCall(env, bearer, "b24_whoami");
  assert.equal(r.status, 401, r.text);
  assert.match(r.headers.get("www-authenticate") ?? "", /invalid_token/);
  assert.equal(env.store.getGrant(grantId), null);
  assert.equal(env.store.countGrants(), 0, "unreadable grant deleted");
  assert.equal((await refreshAt(env, client, tokens.refresh_token)).status, 400);
  // the server keeps working: a new login succeeds with the new key
  const again = await signedIn(env);
  assert.equal((await rawCall(env, again.bearer, "b24_whoami")).status, 200);
});
