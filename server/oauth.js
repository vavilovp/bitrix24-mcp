// HTTP mode: our OAuth 2.1 authorization server (for MCP clients) delegating login to the Bitrix24 portal.
// Do not import from the stdio entry points.
import crypto from "node:crypto";
import express from "express";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { Bitrix } from "./bitrix.js";
import { encrypt, decrypt, hashToken, randomToken } from "./crypto.js";
import { isEligible, loadDepartmentTree, effectiveReadOnly, userDepartments, userName } from "./policy.js";
import { consentPage, refusalPage, errorPage } from "./pages.js";

export const ACCESS_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CODE_TTL_MS = 10 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;
// Login-flow cookie: covers /authorize -> portal -> /b24/callback (<= PENDING_TTL) and the consent form (<= PENDING_TTL).
const FLOW_COOKIE_MAX_AGE_S = 20 * 60;
const B24_TIMEOUT_MS = 15000;

const LOOPBACK = new Set(["localhost", "127.0.0.1"]);

/** Redirect URIs open to registration: any https:// (no fragment), or http:// on localhost / 127.0.0.1 (any port). */
export function allowedRedirectUri(uri) {
  let u;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash || u.username || u.password) return false;
  if (u.protocol === "https:") return !!u.hostname;
  return u.protocol === "http:" && LOOPBACK.has(u.hostname);
}

function sha256url(s) {
  return crypto.createHash("sha256").update(s).digest("base64url");
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Login-flow cookie binding /authorize, /b24/callback and /consent to the browser that started the flow, so that a
 * portal authorize link started by someone else cannot be completed in a victim's signed-in browser.
 * With an https PUBLIC_URL it is `__Host-mcp_flow` (Secure, Path=/, no Domain: bound to exactly this host). Browsers
 * refuse `__Host-` cookies without Secure, and Secure cookies are not sent over plain http, so with an http
 * PUBLIC_URL (local development, tests) it is `mcp_flow` without Secure. Only its SHA-256 hash is stored.
 */
export function flowCookieName(config) {
  return new URL(config.publicUrl).protocol === "https:" ? "__Host-mcp_flow" : "mcp_flow";
}

function flowCookieHeader(config, value, maxAgeS) {
  const secure = new URL(config.publicUrl).protocol === "https:" ? "; Secure" : "";
  return `${flowCookieName(config)}=${value}; Max-Age=${maxAgeS}; Path=/; HttpOnly${secure}; SameSite=Lax`;
}

/** Value of cookie `name` in a Cookie request header, or "". */
function readCookie(header, name) {
  for (const part of String(header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}

/** True when the request carries the flow cookie whose hash was stored with the pending login. */
function flowMatches(req, config, flowHash) {
  const value = readCookie(req.headers.cookie, flowCookieName(config));
  return !!value && typeof flowHash === "string" && safeEqual(hashToken(value), flowHash);
}

/** Bitrix24 side of the login: code exchange at oauth.bitrix.info and a REST client for the fresh tokens. */
export function createB24Login({ config, fetchImpl = fetch }) {
  return {
    async exchangeCode(code) {
      const url = new URL(config.oauthTokenUrl);
      url.search = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
      }).toString();
      let data;
      try {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(B24_TIMEOUT_MS), headers: { Accept: "application/json" } });
        data = await res.json();
      } catch {
        throw new Error("Bitrix24 token endpoint is unreachable or returned non-JSON");
      }
      if (!data || data.error || !data.access_token || !data.refresh_token || !data.client_endpoint) {
        // error/error_description only; never the request URL (it carries the client secret and the code)
        throw new Error(`Bitrix24 code exchange failed: ${String(data?.error || "no tokens").slice(0, 60)}`);
      }
      const expiresIn = Number(data.expires_in) > 0 ? Number(data.expires_in) : 3600;
      return {
        accessToken: String(data.access_token),
        refreshToken: String(data.refresh_token),
        expiresAt: Date.now() + expiresIn * 1000,
        endpoint: String(data.client_endpoint).replace(/\/*$/, "/"),
        memberId: String(data.member_id ?? ""),
      };
    },

    /** REST client bound to just-issued tokens (login only: no refresh). */
    client(tokens) {
      const endpoint = tokens.endpoint.endsWith("/") ? tokens.endpoint : `${tokens.endpoint}/`;
      return new Bitrix(
        {
          oauth: {
            endpoint,
            origin: new URL(endpoint).origin,
            getTokens: async () => ({ accessToken: tokens.accessToken, expiresAt: tokens.expiresAt }),
            refresh: async () => {
              throw Object.assign(new Error("no refresh during login"), { code: "invalid_grant" });
            },
          },
        },
        { timeoutMs: B24_TIMEOUT_MS }
      );
    },
  };
}

/** SDK OAuthServerProvider backed by the store. Only SHA-256 hashes of our codes/tokens are stored. */
export function createProvider({ config, store, b24 }) {
  function issueTokens(grantId) {
    const now = Date.now();
    const access = randomToken();
    const refresh = randomToken();
    store.saveToken(hashToken(access), { grantId, kind: "access", expiresAt: now + ACCESS_TTL_MS });
    store.saveToken(hashToken(refresh), { grantId, kind: "refresh", expiresAt: now + REFRESH_TTL_MS });
    return { access_token: access, token_type: "Bearer", expires_in: Math.floor(ACCESS_TTL_MS / 1000), refresh_token: refresh };
  }

  function dropGrant(grantId) {
    store.deleteTokensOfGrant(grantId);
    store.deleteGrant(grantId);
  }

  return {
    b24,
    // We verify PKCE ourselves in exchangeAuthorizationCode so that the code is consumed exactly once.
    skipLocalPkceValidation: true,

    clientsStore: {
      async getClient(clientId) {
        return store.getClient(clientId) ?? undefined;
      },
      async registerClient(client) {
        const uris = client.redirect_uris ?? [];
        if (!uris.length) throw new InvalidClientMetadataError("redirect_uris is required");
        for (const uri of uris) {
          if (!allowedRedirectUri(uri)) {
            throw new InvalidClientMetadataError("redirect_uris must be https:// or http://localhost / http://127.0.0.1");
          }
        }
        store.saveClient(client);
        return client;
      },
    },

    async authorize(client, params, res) {
      const pendingId = randomToken();
      const flow = randomToken();
      store.savePending(
        pendingId,
        {
          stage: "authorize",
          clientId: client.client_id,
          redirectUri: params.redirectUri,
          codeChallenge: params.codeChallenge,
          state: params.state ?? null,
          scopes: params.scopes ?? [],
          resource: params.resource?.href ?? null,
          flowHash: hashToken(flow),
        },
        PENDING_TTL_MS
      );
      res.append("Set-Cookie", flowCookieHeader(config, flow, FLOW_COOKIE_MAX_AGE_S));
      const url = new URL("/oauth/authorize/", config.portal);
      url.search = new URLSearchParams({ client_id: config.clientId, state: pendingId }).toString();
      res.redirect(302, url.href);
    },

    async challengeForAuthorizationCode(client, code) {
      const data = store.getCode(hashToken(code));
      if (!data || data.clientId !== client.client_id) throw new InvalidGrantError("Invalid or expired authorization code");
      return data.codeChallenge;
    },

    async exchangeAuthorizationCode(client, code, codeVerifier, redirectUri) {
      const data = store.takeCode(hashToken(code));
      if (!data) throw new InvalidGrantError("Invalid or expired authorization code");
      const fail = (msg) => {
        dropGrant(data.grantId);
        throw new InvalidGrantError(msg);
      };
      if (data.clientId !== client.client_id) fail("Authorization code was issued to another client");
      if (redirectUri !== undefined && redirectUri !== data.redirectUri) fail("redirect_uri does not match");
      if (typeof codeVerifier !== "string" || !/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier) ||
          !safeEqual(sha256url(codeVerifier), data.codeChallenge)) {
        fail("code_verifier does not match the challenge");
      }
      if (!store.getGrant(data.grantId)) throw new InvalidGrantError("Grant no longer exists");
      store.touchClient(client.client_id);
      return issueTokens(data.grantId);
    },

    async exchangeRefreshToken(client, refreshToken) {
      const hash = hashToken(refreshToken);
      const t = store.getToken(hash);
      if (!t || t.kind !== "refresh" || t.expiresAt <= Date.now()) throw new InvalidGrantError("Invalid or expired refresh token");
      const grant = store.getGrant(t.grantId);
      if (!grant) {
        store.deleteToken(hash);
        throw new InvalidGrantError("Grant no longer exists");
      }
      if (grant.clientId !== client.client_id) throw new InvalidGrantError("Refresh token was issued to another client");
      // Rotation: the previous refresh token and access token of this grant stop working.
      store.deleteTokensOfGrant(t.grantId);
      store.touchClient(client.client_id);
      return issueTokens(t.grantId);
    },

    async verifyAccessToken(token) {
      const t = store.getToken(hashToken(token));
      if (!t || t.kind !== "access" || t.expiresAt <= Date.now()) throw new InvalidTokenError("Invalid or expired access token");
      const grant = store.getGrant(t.grantId);
      if (!grant) throw new InvalidTokenError("Invalid or expired access token");
      return {
        token,
        clientId: grant.clientId,
        scopes: [],
        expiresAt: Math.floor(t.expiresAt / 1000),
        extra: { grantId: grant.id, userId: grant.userId },
      };
    },

    async revokeToken(client, { token }) {
      const t = store.getToken(hashToken(token));
      if (!t) return; // RFC 7009: unknown tokens are not an error
      const grant = store.getGrant(t.grantId);
      if (grant && grant.clientId !== client.client_id) return;
      dropGrant(t.grantId);
    },
  };
}

/** Portal callback and consent form. */
export function b24Routes({ config, store, provider, b24 = provider.b24 }) {
  const router = express.Router();
  const publicOrigin = new URL(config.publicUrl).origin;
  const portalOrigin = new URL(config.portal).origin;

  const page = (res, status, html) => res.status(status).type("html").send(html);
  const clearFlow = (res) => res.append("Set-Cookie", flowCookieHeader(config, "", 0));
  const WRONG_BROWSER = "Вход нужно завершить в том же браузере, в котором он был начат. Подключитесь заново из приложения.";

  router.get("/b24/callback", async (req, res) => {
    const { code, state } = req.query;
    if (typeof state !== "string" || !state) return page(res, 400, errorPage("Нет параметра state."));
    const pending = store.takePending(state);
    if (!pending || pending.stage !== "authorize") {
      return page(res, 400, errorPage("Ссылка входа устарела или уже использована."));
    }
    // The pending login is already consumed: a wrong or missing cookie ends it for good.
    if (!flowMatches(req, config, pending.flowHash)) return page(res, 400, errorPage(WRONG_BROWSER));
    if (req.query.error !== undefined) {
      // The user declined on the portal: hand control back to the client (RFC 6749 4.1.2.1).
      const back = new URL(pending.redirectUri);
      if (pending.state !== null && pending.state !== undefined) back.searchParams.set("state", pending.state);
      back.searchParams.set("error", "access_denied");
      return res.redirect(302, back.href);
    }
    if (typeof code !== "string" || !code) return page(res, 400, errorPage("Битрикс24 не вернул код авторизации."));
    const client = store.getClient(pending.clientId);
    if (!client) return page(res, 400, errorPage("Приложение не зарегистрировано."));

    let tokens;
    try {
      tokens = await b24.exchangeCode(code);
    } catch {
      return page(res, 502, errorPage("Не удалось завершить вход в Битрикс24."));
    }

    let endpointOrigin = null;
    try {
      endpointOrigin = new URL(tokens.endpoint).origin;
    } catch { /* refused below */ }
    const pinned = config.memberId || store.getMeta("member_id");
    if (endpointOrigin !== portalOrigin || !tokens.memberId || (pinned && pinned !== tokens.memberId)) {
      return page(res, 403, refusalPage("Вход выполнен на другом портале Битрикс24. Этот сервер работает только со своим порталом."));
    }

    let user, forced;
    try {
      const bitrix = b24.client(tokens);
      user = await bitrix.result("user.current");
      res.locals.userId = Number(user?.ID) || undefined;
      if (!isEligible(user)) {
        return page(res, 403, refusalPage("Доступ есть только у активных сотрудников портала."));
      }
      const departments = userDepartments(user);
      const tree = config.roDepts.size ? await loadDepartmentTree(bitrix) : new Map();
      ({ forced } = effectiveReadOnly({
        global: config.readOnly, choice: false, userId: user.ID, departments,
        roUsers: config.roUsers, roDepts: config.roDepts, tree,
      }));
      user = { id: Number(user.ID), name: userName(user), departments };
    } catch {
      return page(res, 502, errorPage("Не удалось получить данные пользователя из Битрикс24."));
    }

    // Strictly first-seen: a concurrent first login from another portal may have pinned meanwhile.
    if (!pinned && store.initMeta("member_id", tokens.memberId) !== tokens.memberId) {
      return page(res, 403, refusalPage("Вход выполнен на другом портале Битрикс24. Этот сервер работает только со своим порталом."));
    }

    const consentId = randomToken();
    const csrf = randomToken();
    store.savePending(
      consentId,
      {
        stage: "consent",
        csrf,
        expiresAt: Date.now() + PENDING_TTL_MS,
        request: pending,
        user,
        forced,
        b24: encrypt(JSON.stringify({
          accessToken: tokens.accessToken, refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt, endpoint: tokens.endpoint,
        }), config.secretKey),
      },
      PENDING_TTL_MS
    );
    const redirect = new URL(pending.redirectUri);
    page(res, 200, consentPage({
      user,
      client: { name: client.client_name || client.client_id },
      redirectHost: redirect.host,
      known: config.knownClientHosts.has(redirect.hostname.toLowerCase()),
      forcedReadOnly: forced,
      consentId,
      csrf,
    }));
  });

  router.post("/consent", express.urlencoded({ extended: false, limit: "8kb" }), (req, res) => {
    const origin = req.get("origin");
    if (origin !== undefined && origin !== publicOrigin) return page(res, 403, errorPage("Запрос отклонён."));
    const body = req.body || {};
    const id = typeof body.consent_id === "string" ? body.consent_id : "";
    const data = id ? store.takePending(id) : null;
    if (!data || data.stage !== "consent" || !safeEqual(body.csrf, data.csrf)) {
      return page(res, 400, errorPage("Форма устарела или уже отправлена."));
    }
    if (!flowMatches(req, config, data.request?.flowHash)) return page(res, 400, errorPage(WRONG_BROWSER));
    const reqd = data.request;
    res.locals.userId = data.user.id;
    const back = new URL(reqd.redirectUri);
    if (reqd.state !== null && reqd.state !== undefined) back.searchParams.set("state", reqd.state);

    if (body.action === "deny") {
      clearFlow(res);
      back.searchParams.set("error", "access_denied");
      return res.redirect(302, back.href);
    }

    const known = config.knownClientHosts.has(back.hostname.toLowerCase());
    if (!known && body.unknown_ok !== "1") {
      // Put the form back for its remaining lifetime so that "back" + ticking the box works.
      const left = data.expiresAt - Date.now();
      if (left > 0) store.savePending(id, data, left);
      return page(res, 400, errorPage("Подтвердите, что доверяете адресу приложения (отметьте флажок), и отправьте форму ещё раз."));
    }

    let b24tokens;
    try {
      b24tokens = JSON.parse(decrypt(data.b24, config.secretKey));
    } catch {
      return page(res, 400, errorPage("Форма устарела. Подключитесь заново."));
    }
    // A forced read-only user cannot clear the box: the posted value is ignored.
    const readOnlyChoice = data.forced || body.read_only === "1";
    // Grant and code are created together: the store's cleanup expects the code to be exchanged within its TTL.
    const grantId = store.createGrant({
      userId: data.user.id,
      userName: data.user.name,
      clientId: reqd.clientId,
      readOnlyChoice,
      departments: data.user.departments,
      b24: b24tokens,
    });
    const code = randomToken();
    store.saveCode(hashToken(code), {
      grantId, clientId: reqd.clientId, redirectUri: reqd.redirectUri, codeChallenge: reqd.codeChallenge,
    }, CODE_TTL_MS);
    back.searchParams.set("code", code);
    clearFlow(res);
    res.redirect(302, back.href);
  });

  return router;
}
