import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../server/config.js";
import { truncate } from "../server/pages.js";
import {
  SECRET_KEY, CLIENT_SECRET, startEnv, get, postForm, register, pkce, toConsent, submitConsent, exchange, login,
} from "./fakes/env.js";

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
  const c = loadConfig({ ...base, READ_ONLY_USERS: "1, 2", READ_ONLY_DEPARTMENTS: "7", KNOWN_CLIENT_HOSTS: "Claude.AI, example.org", READ_ONLY: "true" });
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

/** Module specifiers of static (`import x from`, `export … from`, bare `import "x"`) and dynamic `import("x")` imports. */
function importSpecs(src) {
  const re = /(?:import|export)\s[^"';]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;
  return [...src.matchAll(re)].map((m) => m[1] ?? m[2] ?? m[3]).filter(Boolean);
}

test("import walker sees static, bare and dynamic imports", () => {
  const src = `import a from "./a.js";\nexport { b } from './b.js';\nimport "./c.js";\nconst d = await import( "./d.js" );\nimport("node:sqlite");`;
  assert.deepEqual(importSpecs(src), ["./a.js", "./b.js", "./c.js", "./d.js", "node:sqlite"]);
});

test("stdio entry does not import HTTP-mode modules", () => {
  const seen = new Set();
  const external = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const spec of importSpecs(fs.readFileSync(file, "utf8"))) {
      if (spec.startsWith(".")) walk(path.resolve(path.dirname(file), spec));
      else external.add(spec);
    }
  };
  walk(path.resolve("server/index.js"));
  const local = [...seen].map((f) => path.basename(f));
  for (const m of ["http.js", "oauth.js", "config.js", "pages.js", "store.js", "crypto.js", "grants.js"]) assert.ok(!local.includes(m), m);
  for (const m of external) assert.doesNotMatch(m, /^(express|express-rate-limit|node:sqlite)$|server\/auth|streamableHttp/i, m);
  assert.ok(local.includes("tools.js"));
});

test("portal decline redirects to the client with access_denied and state", async (t) => {
  const env = await startEnv(t);
  env.fake.denyLogin = true;
  const c = await toConsent(env);
  assert.equal(c.cb.status, 302, c.html);
  const back = new URL(c.cb.headers.get("location"));
  assert.equal(back.origin + back.pathname, "https://claude.ai/api/mcp/auth_callback");
  assert.equal(back.searchParams.get("error"), "access_denied");
  assert.equal(back.searchParams.get("state"), c.state);
  assert.equal(back.searchParams.get("code"), null);
  assert.equal(env.store.countGrants(), 0);
  // the pending login is used up
  assert.equal((await get(c.callbackUrl)).status, 400);
});

test("client name loses Unicode format characters", () => {
  assert.equal(truncate("Cl\u202Eaude\u200B\u2066x\u2069\uFEFF"), "Claudex");
  assert.equal(truncate("a\u0000b"), "a b");
});

test("member_id pin is first-seen even when another login pins it meanwhile", async (t) => {
  const env = await startEnv(t);
  // Another login (from a different portal) pins its member_id while this one is between check and pin.
  env.fake.beforeRest = (method) => {
    if (method === "user.current" && env.store.getMeta("member_id") === null) env.store.setMeta("member_id", "member-other");
  };
  const c = await toConsent(env);
  assert.equal(c.cb.status, 403);
  assert.doesNotMatch(c.html, /consent_id/);
  assert.equal(env.store.getMeta("member_id"), "member-other", "first pin is kept");
});

const CONFIG_BASE = {
  PUBLIC_URL: "https://mcp.example.ru",
  B24_PORTAL: "https://portal.example.ru",
  B24_CLIENT_ID: "local.1",
  B24_CLIENT_SECRET: "s",
  SECRET_KEY,
};

test("loadConfig accepts a bare host for B24_PORTAL and PUBLIC_URL (https assumed)", () => {
  const c = loadConfig({ ...CONFIG_BASE, B24_PORTAL: "your-portal.example.com", PUBLIC_URL: "mcp.example.com" });
  assert.equal(c.portal, "https://your-portal.example.com");
  assert.equal(c.publicUrl, "https://mcp.example.com");
  const p = loadConfig({ ...CONFIG_BASE, B24_PORTAL: "portal.example.com:8443/", PUBLIC_URL: "mcp.example.com/" });
  assert.equal(p.portal, "https://portal.example.com:8443");
  assert.equal(p.publicUrl, "https://mcp.example.com");
  assert.equal(loadConfig({ ...CONFIG_BASE, B24_PORTAL: "http://box.local" }).portal, "http://box.local");
  for (const name of ["B24_PORTAL", "PUBLIC_URL"]) {
    for (const bad of ["ftp://x.example", "javascript:alert(1)", "https://", "not a url", "mailto:a@b.example", "file:///etc/passwd"]) {
      assert.throws(() => loadConfig({ ...CONFIG_BASE, [name]: bad }), new RegExp(name), `${name}=${bad}`);
    }
  }
});

test("loadConfig is strict about read-only lists and READ_ONLY", () => {
  assert.deepEqual([...loadConfig({ ...CONFIG_BASE, READ_ONLY_USERS: " 1, 2 ,3 " }).roUsers], [1, 2, 3]);
  assert.deepEqual([...loadConfig({ ...CONFIG_BASE, READ_ONLY_USERS: "", READ_ONLY_DEPARTMENTS: "  " }).roUsers], []);
  for (const name of ["READ_ONLY_USERS", "READ_ONLY_DEPARTMENTS"]) {
    for (const bad of ["1,x", "5,8        (needs the \"department\" scope)", "0", "-3", "1.5", "1,,2", "12abc", "1e3"]) {
      assert.throws(() => loadConfig({ ...CONFIG_BASE, [name]: bad }), new RegExp(name), `${name}=${bad}`);
    }
  }
  for (const v of ["1", "true", "TRUE", "yes", "Y", "y", "on", " On "]) {
    assert.equal(loadConfig({ ...CONFIG_BASE, READ_ONLY: v }).readOnly, true, v);
  }
  for (const v of ["0", "false", "No", "n", "off", "", "  "]) {
    assert.equal(loadConfig({ ...CONFIG_BASE, READ_ONLY: v }).readOnly, false, v);
  }
  assert.equal(loadConfig(CONFIG_BASE).readOnly, false);
  for (const v of ["2", "maybe", "true # comment", "enabled"]) {
    assert.throws(() => loadConfig({ ...CONFIG_BASE, READ_ONLY: v }), /READ_ONLY/, v);
  }
});
