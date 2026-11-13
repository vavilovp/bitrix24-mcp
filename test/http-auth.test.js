import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { startFakePortal } from "./fakes/portal.js";
import { createApp } from "../server/http.js";
import { loadConfig } from "../server/config.js";

const SECRET_KEY = Buffer.alloc(32, 7).toString("base64");
const CLIENT_SECRET = "fake-client-secret";

/** Fake portal + our app on port 0. Returns helpers to walk the OAuth flow without cookies. */
async function startEnv(t, env = {}) {
  const fake = await startFakePortal({ clientId: "local.test.app", clientSecret: CLIENT_SECRET });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "http-auth-"));
  const server = http.createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  fake.callbackUrl = `${base}/b24/callback`;
  const config = loadConfig({
    PUBLIC_URL: base,
    B24_PORTAL: fake.origin,
    B24_CLIENT_ID: "local.test.app",
    B24_CLIENT_SECRET: CLIENT_SECRET,
    B24_OAUTH_TOKEN_URL: fake.tokenUrl,
    SECRET_KEY,
    DATA_DIR: dir,
    ...env,
  });
  const logs = [];
  const app = createApp(config, { log: (line) => logs.push(line) });
  server.on("request", app);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    app.locals.store.close();
    await fake.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { fake, base, app, store: app.locals.store, provider: app.locals.provider, logs, config };
}

const get = (url, headers = {}) => fetch(url, { redirect: "manual", headers });
const postForm = (url, fields, headers = {}) =>
  fetch(url, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
  });

async function register(env, { redirectUri = "https://claude.ai/api/mcp/auth_callback", clientName = "Claude" } = {}) {
  const res = await fetch(`${env.base}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      client_name: clientName,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  return { status: res.status, body: await res.json() };
}

function pkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

const hidden = (html, name) => html.match(new RegExp(`name="${name}" value="([^"]*)"`))?.[1];

/** register -> /authorize -> portal -> /b24/callback. Returns the callback response and flow state. */
async function toConsent(env, { userId = 5, redirectUri, clientName } = {}) {
  env.fake.nextUserId = userId;
  const reg = await register(env, { redirectUri, clientName });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const client = reg.body;
  const { verifier, challenge } = pkce();
  const state = "client-state-" + crypto.randomBytes(4).toString("hex");
  const authUrl = new URL(`${env.base}/authorize`);
  authUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0],
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  }).toString();
  const a = await get(authUrl.href);
  assert.equal(a.status, 302);
  const portalUrl = new URL(a.headers.get("location"));
  assert.equal(portalUrl.origin, env.fake.origin);
  assert.equal(portalUrl.pathname, "/oauth/authorize/");
  assert.equal(portalUrl.searchParams.get("client_id"), "local.test.app");
  const p = await get(portalUrl.href);
  assert.equal(p.status, 302);
  const callbackUrl = p.headers.get("location");
  const cb = await get(callbackUrl);
  const html = await cb.text();
  return { client, verifier, state, callbackUrl, cb, html };
}

async function submitConsent(env, html, extra = {}, headers = {}) {
  const fields = { consent_id: hidden(html, "consent_id"), csrf: hidden(html, "csrf"), action: "allow", ...extra };
  return postForm(`${env.base}/consent`, fields, headers);
}

async function exchange(env, client, code, verifier) {
  const res = await postForm(`${env.base}/token`, {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0],
  });
  return { status: res.status, body: await res.json() };
}

/** Full flow to tokens. */
async function login(env, opts = {}) {
  const c = await toConsent(env, opts);
  assert.equal(c.cb.status, 200, c.html);
  const res = await submitConsent(env, c.html, opts.consent ?? {});
  assert.equal(res.status, 302, await res.text());
  const back = new URL(res.headers.get("location"));
  const tokens = await exchange(env, c.client, back.searchParams.get("code"), c.verifier);
  assert.equal(tokens.status, 200, JSON.stringify(tokens.body));
  return { ...c, back, tokens: tokens.body };
}

const grantCount = (store) => store.countGrants();

test("full login flow issues tokens", async (t) => {
  const env = await startEnv(t);
  const c = await toConsent(env);
  assert.equal(c.cb.status, 200);
  assert.match(c.cb.headers.get("content-type"), /text\/html/);
  assert.match(c.html, /Ann Example/);
  assert.match(c.html, /claude\.ai/);
  assert.match(c.cb.headers.get("content-security-policy"), /default-src 'none'/);
  assert.doesNotMatch(c.html, /<script|<link|src=|https?:\/\/(?!claude\.ai)/i);

  const res = await submitConsent(env, c.html);
  assert.equal(res.status, 302);
  const back = new URL(res.headers.get("location"));
  assert.equal(back.origin + back.pathname, "https://claude.ai/api/mcp/auth_callback");
  assert.equal(back.searchParams.get("state"), c.state);
  const code = back.searchParams.get("code");
  assert.ok(code);

  const tok = await exchange(env, c.client, code, c.verifier);
  assert.equal(tok.status, 200, JSON.stringify(tok.body));
  assert.ok(tok.body.access_token);
  assert.ok(tok.body.refresh_token);
  assert.equal(tok.body.token_type.toLowerCase(), "bearer");
  assert.ok(tok.body.expires_in > 0 && tok.body.expires_in <= 3600);

  // code is single use
  const again = await exchange(env, c.client, code, c.verifier);
  assert.equal(again.status, 400);
  assert.equal(again.body.error, "invalid_grant");

  // access token verifies and points at a grant of user 5 with the Bitrix tokens stored
  const info = await env.provider.verifyAccessToken(tok.body.access_token);
  assert.equal(info.clientId, c.client.client_id);
  assert.deepEqual(info.scopes, []);
  assert.ok(info.expiresAt <= Date.now() / 1000 + 3600 && info.expiresAt > Date.now() / 1000);
  const grant = env.store.getGrant(info.extra.grantId);
  assert.equal(grant.userId, 5);
  assert.equal(grant.userName, "Ann Example");
  assert.deepEqual(grant.departments, [12]);
  assert.equal(grant.readOnlyChoice, false);
  assert.ok(env.fake.issued.includes(grant.b24.accessToken));
  assert.equal(grant.b24.endpoint, `${env.fake.origin}/rest/`);
  assert.ok(grant.b24.expiresAt > Date.now() + 3000e3 && grant.b24.expiresAt <= Date.now() + 3600e3);

  // metadata
  const meta = await (await fetch(`${env.base}/.well-known/oauth-authorization-server`)).json();
  assert.equal(meta.issuer, `${env.base}/`);
  assert.equal(meta.registration_endpoint, `${env.base}/register`);
});

test("wrong PKCE verifier is rejected", async (t) => {
  const env = await startEnv(t);
  const c = await toConsent(env);
  const res = await submitConsent(env, c.html);
  const code = new URL(res.headers.get("location")).searchParams.get("code");
  const bad = await exchange(env, c.client, code, pkce().verifier);
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, "invalid_grant");
  const good = await exchange(env, c.client, code, c.verifier);
  assert.equal(good.status, 400, "code burned after a failed attempt");
});

test("refresh rotates", async (t) => {
  const env = await startEnv(t);
  const { tokens, client } = await login(env);
  const refresh = (rt) =>
    postForm(`${env.base}/token`, { grant_type: "refresh_token", refresh_token: rt, client_id: client.client_id }).then(
      async (r) => ({ status: r.status, body: await r.json() }));
  const r1 = await refresh(tokens.refresh_token);
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.ok(r1.body.access_token && r1.body.refresh_token);
  assert.notEqual(r1.body.refresh_token, tokens.refresh_token);
  assert.ok(r1.body.expires_in <= 3600);
  const old = await refresh(tokens.refresh_token);
  assert.equal(old.status, 400);
  assert.equal(old.body.error, "invalid_grant");
  await assert.rejects(env.provider.verifyAccessToken(tokens.access_token));
  const info = await env.provider.verifyAccessToken(r1.body.access_token);
  assert.ok(info.extra.grantId);
  const r2 = await refresh(r1.body.refresh_token);
  assert.equal(r2.status, 200);
  // an access token is not a refresh token
  const wrongKind = await refresh(r2.body.access_token);
  assert.equal(wrongKind.status, 400);
});

test("revoke removes the grant's tokens", async (t) => {
  const env = await startEnv(t);
  const { tokens, client } = await login(env);
  const info = await env.provider.verifyAccessToken(tokens.access_token);
  const r = await postForm(`${env.base}/revoke`, { token: tokens.refresh_token, client_id: client.client_id });
  assert.equal(r.status, 200);
  await assert.rejects(env.provider.verifyAccessToken(tokens.access_token));
  assert.equal(env.store.getGrant(info.extra.grantId), null);
});

for (const [name, userId] of [["inactive user is refused", 6], ["extranet user is refused", 8], ["extranet USER_TYPE is refused", 9]]) {
  test(name, async (t) => {
    const env = await startEnv(t);
    const c = await toConsent(env, { userId });
    assert.equal(c.cb.status, 403);
    assert.doesNotMatch(c.html, /consent_id/);
    assert.equal(grantCount(env.store), 0);
    assert.equal(env.store.getMeta("member_id"), null, "nothing stored for a refused user");
  });
}

test("foreign portal is refused", async (t) => {
  const env = await startEnv(t);
  await login(env); // pins member-aaa
  assert.equal(env.store.getMeta("member_id"), "member-aaa");
  env.fake.memberId = "member-bbb";
  const c = await toConsent(env);
  assert.equal(c.cb.status, 403);
  assert.doesNotMatch(c.html, /consent_id/);
  assert.equal(grantCount(env.store), 1);
});

test("configured B24_MEMBER_ID is enforced from the first login", async (t) => {
  const env = await startEnv(t, { B24_MEMBER_ID: "member-zzz" });
  const c = await toConsent(env);
  assert.equal(c.cb.status, 403);
  assert.equal(grantCount(env.store), 0);
});

test("foreign client_endpoint is refused", async (t) => {
  const env = await startEnv(t);
  env.fake.clientEndpoint = "https://other-portal.example.ru/rest/";
  const c = await toConsent(env);
  assert.equal(c.cb.status, 403);
  assert.equal(grantCount(env.store), 0);
  assert.ok(!env.fake.reqs.some((r) => r.path.startsWith("/rest/")), "no REST call with a foreign token");
});

test("consent escapes client name", async (t) => {
  const env = await startEnv(t);
  const c = await toConsent(env, { clientName: "<script>x</script>" + "A".repeat(500) });
  assert.equal(c.cb.status, 200);
  assert.doesNotMatch(c.html, /<script>/);
  assert.match(c.html, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.doesNotMatch(c.html, /A{200}/, "client name truncated");
  assert.match(c.html, /claude\.ai/);
});

test("unknown host needs the extra checkbox", async (t) => {
  const env = await startEnv(t);
  const c = await toConsent(env, { redirectUri: "https://evil.example.org/cb", clientName: "Claude" });
  assert.equal(c.cb.status, 200);
  assert.match(c.html, /evil\.example\.org/);
  assert.match(c.html, /name="unknown_ok"[^>]*required/);
  const without = await submitConsent(env, c.html);
  assert.equal(without.status, 400);
  assert.equal(grantCount(env.store), 0);
  const withIt = await submitConsent(env, c.html, { unknown_ok: "1" });
  assert.equal(withIt.status, 302);
  assert.equal(new URL(withIt.headers.get("location")).host, "evil.example.org");
});

test("known host has no extra checkbox; localhost any port is known", async (t) => {
  const env = await startEnv(t);
  const c = await toConsent(env, { redirectUri: "http://localhost:43123/callback" });
  assert.equal(c.cb.status, 200);
  assert.doesNotMatch(c.html, /unknown_ok/);
  assert.match(c.html, /localhost:43123/);
});

test("registration accepts https and loopback http only", async (t) => {
  const env = await startEnv(t);
  for (const uri of ["https://claude.ai/api/mcp/auth_callback", "http://localhost:9999/cb", "http://127.0.0.1:1234/cb", "https://x.example/cb"]) {
    assert.equal((await register(env, { redirectUri: uri })).status, 201, uri);
  }
  for (const uri of ["http://evil.example/cb", "http://localhost.evil.example/cb", "javascript:alert(1)", "ftp://x.example/", "myapp://cb", "https://x.example/cb#frag"]) {
    const r = await register(env, { redirectUri: uri });
    assert.equal(r.status, 400, uri);
  }
});

test("forced read-only checkbox cannot be cleared", async (t) => {
  const env = await startEnv(t, { READ_ONLY_USERS: "5, 77" });
  const c = await toConsent(env);
  assert.match(c.html, /<input[^>]*name="read_only"[^>]*checked[^>]*disabled|<input[^>]*name="read_only"[^>]*disabled[^>]*checked/);
  const res = await submitConsent(env, c.html, { read_only: "0" });
  assert.equal(res.status, 302);
  const code = new URL(res.headers.get("location")).searchParams.get("code");
  const tok = await exchange(env, c.client, code, c.verifier);
  const info = await env.provider.verifyAccessToken(tok.body.access_token);
  assert.equal(env.store.getGrant(info.extra.grantId).readOnlyChoice, true);
});

test("department ancestor forces read-only", async (t) => {
  const env = await startEnv(t, { READ_ONLY_DEPARTMENTS: "7" });
  const c = await toConsent(env); // user 5 is in 12, child of 7
  assert.match(c.html, /name="read_only"[^>]*disabled/);
  const other = await startEnv(t, { READ_ONLY_DEPARTMENTS: "7" });
  const c2 = await toConsent(other, { userId: 10 }); // department 1, parent of 7
  assert.doesNotMatch(c2.html, /name="read_only"[^>]*disabled/);
});

test("user choice of read-only is kept", async (t) => {
  const env = await startEnv(t);
  const { tokens } = await login(env, { consent: { read_only: "1" } });
  const info = await env.provider.verifyAccessToken(tokens.access_token);
  assert.equal(env.store.getGrant(info.extra.grantId).readOnlyChoice, true);
});

test("state reuse fails", async (t) => {
  const env = await startEnv(t);
  const c = await toConsent(env);
  assert.equal(c.cb.status, 200);
  const again = await get(c.callbackUrl);
  assert.equal(again.status, 400);
  // consent is single use too
  assert.equal((await submitConsent(env, c.html)).status, 302);
  assert.equal((await submitConsent(env, c.html)).status, 400);
  // unknown state
  const bogus = await get(`${env.base}/b24/callback?code=x&state=nope`);
  assert.equal(bogus.status, 400);
});

test("consent rejects wrong csrf and foreign Origin", async (t) => {
  const env = await startEnv(t);
  const c = await toConsent(env);
  const foreign = await submitConsent(env, c.html, {}, { Origin: "https://evil.example" });
  assert.equal(foreign.status, 403);
  const badCsrf = await submitConsent(env, c.html, { csrf: "nope" });
  assert.equal(badCsrf.status, 400);
  assert.equal(grantCount(env.store), 0);
});

test("deny redirects with access_denied and stores nothing", async (t) => {
  const env = await startEnv(t);
  const c = await toConsent(env);
  const res = await submitConsent(env, c.html, { action: "deny" });
  assert.equal(res.status, 302);
  const back = new URL(res.headers.get("location"));
  assert.equal(back.searchParams.get("error"), "access_denied");
  assert.equal(back.searchParams.get("state"), c.state);
  assert.equal(back.searchParams.get("code"), null);
  assert.equal(grantCount(env.store), 0);
});

test("logs carry no codes or tokens", async (t) => {
  const env = await startEnv(t);
  const { tokens, client, callbackUrl } = await login(env);
  await postForm(`${env.base}/token`, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id });
  const all = env.logs.join("\n");
  assert.ok(env.logs.length >= 5, all);
  assert.match(all, /GET \/b24\/callback 200 user=5/);
  assert.match(all, /POST \/consent 302 user=5/);
  assert.doesNotMatch(all, /code=|state=|\?/);
  const cbCode = new URL(callbackUrl).searchParams.get("code");
  for (const secret of [tokens.access_token, tokens.refresh_token, cbCode, CLIENT_SECRET, SECRET_KEY, ...env.fake.issued]) {
    assert.ok(!all.includes(secret), "log leaks a secret");
  }
});

test("loadConfig validates and parses", () => {
  const base = {
    PUBLIC_URL: "https://mcp.example.ru/",
    B24_PORTAL: "https://portal.example.ru",
    B24_CLIENT_ID: "local.1",
    B24_CLIENT_SECRET: "s",
    SECRET_KEY,
  };
  const c = loadConfig({ ...base, READ_ONLY_USERS: "1, 2,,x", READ_ONLY_DEPARTMENTS: "7", KNOWN_CLIENT_HOSTS: "Claude.AI, example.org", READ_ONLY: "true" });
  assert.equal(c.publicUrl, "https://mcp.example.ru");
  assert.equal(c.portal, "https://portal.example.ru");
  assert.deepEqual([...c.roUsers], [1, 2]);
  assert.deepEqual([...c.roDepts], [7]);
  assert.deepEqual([...c.knownClientHosts], ["claude.ai", "example.org"]);
  assert.equal(c.readOnly, true);
  assert.equal(c.dataDir, "/data");
  assert.equal(c.port, 3000);
  assert.equal(c.oauthTokenUrl, "https://oauth.bitrix.info/oauth/token/");
  const d = loadConfig(base);
  assert.deepEqual([...d.knownClientHosts], ["claude.ai", "claude.com", "localhost", "127.0.0.1"]);
  assert.equal(d.readOnly, false);
  assert.doesNotMatch(JSON.stringify(c), /"s"|clientSecret|secretKey/, "secrets are not enumerable");
  for (const k of Object.keys(base)) {
    const env = { ...base };
    delete env[k];
    assert.throws(() => loadConfig(env), new RegExp(k));
  }
  assert.throws(() => loadConfig({ ...base, SECRET_KEY: "short" }), /SECRET_KEY/);
  assert.throws(() => loadConfig({ ...base, B24_PORTAL: "not a url" }), /B24_PORTAL/);
});

test("stdio entry does not import HTTP-mode modules", () => {
  const seen = new Set();
  const external = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = fs.readFileSync(file, "utf8");
    for (const [, spec] of src.matchAll(/(?:import|export)\s[^"']*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) {
      if (!spec) continue;
      if (spec.startsWith(".")) walk(path.resolve(path.dirname(file), spec));
      else external.add(spec);
    }
  };
  walk(path.resolve("server/index.js"));
  const local = [...seen].map((f) => path.basename(f));
  for (const m of ["http.js", "oauth.js", "config.js", "pages.js", "store.js", "crypto.js"]) assert.ok(!local.includes(m), m);
  for (const m of external) assert.doesNotMatch(m, /^(express|express-rate-limit|node:sqlite)$|server\/auth/, m);
  assert.ok(local.includes("tools.js"));
});
