// Shared HTTP-mode test environment: fake portal + our app on port 0, and helpers that walk the
// OAuth flow without cookies. Used by test/http-auth.test.js and test/http-mcp.test.js.
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { startFakePortal } from "./portal.js";
import { createApp } from "../../server/http.js";
import { loadConfig } from "../../server/config.js";

export const SECRET_KEY = Buffer.alloc(32, 7).toString("base64");
export const CLIENT_SECRET = "fake-client-secret";

/**
 * startEnv(t, env?) -> { fake, base, app, store, provider, logs, config, dir, restart() }.
 * restart() closes the app and its store and creates a new app on the same DATA_DIR and port.
 */
export async function startEnv(t, env = {}) {
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
  const out = { fake, base, logs, config, dir };
  const mount = () => {
    const app = createApp(config, { log: (line) => logs.push(line) });
    server.removeAllListeners("request");
    server.on("request", app);
    Object.assign(out, { app, store: app.locals.store, provider: app.locals.provider });
  };
  mount();
  out.restart = () => {
    out.app.locals.store.close();
    mount();
  };
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    out.app.locals.store.close();
    await fake.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return out;
}

export const get = (url, headers = {}) => fetch(url, { redirect: "manual", headers });
export const postForm = (url, fields, headers = {}) =>
  fetch(url, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
  });

export async function register(env, { redirectUri = "https://claude.ai/api/mcp/auth_callback", clientName = "Claude" } = {}) {
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

export function pkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export const hidden = (html, name) => html.match(new RegExp(`name="${name}" value="([^"]*)"`))?.[1];

/** register -> /authorize -> portal -> /b24/callback. Returns the callback response and flow state. */
export async function toConsent(env, { userId = 5, redirectUri, clientName } = {}) {
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

export async function submitConsent(env, html, extra = {}, headers = {}) {
  const fields = { consent_id: hidden(html, "consent_id"), csrf: hidden(html, "csrf"), action: "allow", ...extra };
  return postForm(`${env.base}/consent`, fields, headers);
}

export async function exchange(env, client, code, verifier) {
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
export async function login(env, opts = {}) {
  const c = await toConsent(env, opts);
  assert.equal(c.cb.status, 200, c.html);
  const res = await submitConsent(env, c.html, opts.consent ?? {});
  assert.equal(res.status, 302, await res.text());
  const back = new URL(res.headers.get("location"));
  const tokens = await exchange(env, c.client, back.searchParams.get("code"), c.verifier);
  assert.equal(tokens.status, 200, JSON.stringify(tokens.body));
  return { ...c, back, tokens: tokens.body };
}
