// HTTP mode: one Bitrix24 OAuth client per grant, Bitrix token refresh with a re-check of the user,
// and the effective read-only state. Do not import from the stdio entry points.
import { Bitrix, BitrixError } from "./bitrix.js";
import { isEligible, loadDepartmentTree, effectiveReadOnly, userDepartments, userName } from "./policy.js";

const B24_TIMEOUT_MS = 15000;
const TREE_TTL_MS = 60 * 60 * 1000;
// Token endpoint errors that mean the Bitrix24 grant is gone (oauth.bitrix.info uses all of these).
const REVOKED_ERRORS = new Set(["invalid_grant", "expired_token", "invalid_token", "NO_AUTH_FOUND"]);
/** BitrixError codes that a request handler must turn into an HTTP status (401 / 503). */
export const AUTH_CODES = new Set(["AUTH_EXPIRED", "AUTH_REFRESH_FAILED"]);

const revoked = (message) => Object.assign(new Error(message), { code: "invalid_grant" });

/**
 * Per-request view of a shared per-grant client: same tokens, refresh and caches, but every
 * AUTH_EXPIRED / AUTH_REFRESH_FAILED passing through it is reported to `onAuthError` before it is
 * rethrown, so the HTTP layer sees it even when a tool catches the error itself.
 * Methods inherited from Bitrix (result, batch, userNames) call `this.call`, i.e. the override below;
 * the overrides run on `shared` so that token state is never written onto the view.
 */
function observed(shared, onAuthError) {
  const watch = (e) => {
    if (e instanceof BitrixError && AUTH_CODES.has(e.code)) onAuthError(e.code);
    throw e;
  };
  const view = Object.create(shared);
  view.call = (...args) => shared.call(...args).catch(watch);
  view.ready = () => shared.ready().catch(watch);
  return view;
}

/**
 * createGrantClients({ config, store, oauthTokenUrl?, fetchImpl? }) -> {
 *   clientFor(grantId) -> Promise<{ bitrix, readOnly, authFailure() -> "AUTH_EXPIRED" | "AUTH_REFRESH_FAILED" | null }>,
 *   drop(grantId), has(grantId) }
 * Bitrix instances are cached by grantId and never shared between grants. clientFor refreshes tokens that are
 * about to expire before it returns, so a re-check after refresh applies to the request that triggered it.
 * Errors from clientFor: BitrixError AUTH_EXPIRED (grant gone; already dropped) or AUTH_REFRESH_FAILED / other
 * BitrixError (transient).
 */
export function createGrantClients({ config, store, oauthTokenUrl = config.oauthTokenUrl, fetchImpl = fetch }) {
  const cache = new Map(); // grantId -> Bitrix
  let tree = null;
  let treeAt = 0;

  function drop(grantId) {
    cache.delete(grantId);
    store.deleteTokensOfGrant(grantId);
    store.deleteGrant(grantId);
  }

  // Not shared between concurrent loads on purpose: an auth failure of one grant must not reach another.
  async function departmentTree(client) {
    if (!config.roDepts.size) return new Map();
    if (!tree || Date.now() - treeAt > TREE_TTL_MS) {
      const t = await loadDepartmentTree(client);
      tree = t;
      treeAt = Date.now();
    }
    return tree;
  }

  async function requestTokens(refreshToken) {
    const url = new URL(oauthTokenUrl);
    url.search = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
    }).toString();
    let res;
    try {
      res = await fetchImpl(url, { signal: AbortSignal.timeout(B24_TIMEOUT_MS), headers: { Accept: "application/json" } });
    } catch {
      throw new Error("Bitrix24 token endpoint is unreachable");
    }
    let data = null;
    try {
      data = await res.json();
    } catch { /* handled below */ }
    const error = data && data.error ? String(data.error) : null;
    // Only the error code is kept: the request URL carries the client secret and the refresh token.
    if (error && REVOKED_ERRORS.has(error)) throw revoked(`Bitrix24 refresh rejected: ${error}`);
    if (!res.ok || error || !data?.access_token || !data?.refresh_token) {
      throw new Error(`Bitrix24 token refresh failed: ${(error || `HTTP ${res.status}`).slice(0, 60)}`);
    }
    const expiresIn = Number(data.expires_in) > 0 ? Number(data.expires_in) : 3600; // seconds
    return {
      accessToken: String(data.access_token),
      refreshToken: String(data.refresh_token),
      expiresAt: Date.now() + expiresIn * 1000,
    };
  }

  /** REST client bound to fixed tokens (used for the re-check right after a refresh). */
  function fixedClient(endpoint, tokens) {
    return new Bitrix({
      oauth: {
        endpoint,
        origin: new URL(endpoint).origin,
        getTokens: async () => tokens,
        refresh: async () => {
          throw new Error("fresh Bitrix24 token was rejected");
        },
      },
    }, { timeoutMs: B24_TIMEOUT_MS });
  }

  /**
   * Bitrix refresh for one grant: new tokens are saved, then the user is checked again with them.
   * Rejects with code "invalid_grant" (Bitrix client -> AUTH_EXPIRED) when the grant is gone, the portal
   * revoked it, or the user is no longer an eligible employee; with a plain error when transient.
   */
  async function refresh(grantId) {
    const grant = store.getGrant(grantId);
    if (!grant) {
      cache.delete(grantId);
      throw revoked("grant no longer exists");
    }
    let tokens;
    try {
      tokens = await requestTokens(grant.b24.refreshToken);
    } catch (e) {
      if (e.code === "invalid_grant") drop(grantId);
      throw e;
    }
    // The endpoint stays the one validated at login.
    store.updateGrantTokens(grantId, { ...tokens, endpoint: grant.b24.endpoint });

    const probe = fixedClient(grant.b24.endpoint, tokens);
    const user = await probe.result("user.current");
    if (!isEligible(user) || Number(user.ID) !== grant.userId) {
      drop(grantId);
      throw revoked("user is no longer an active employee");
    }
    store.updateGrantUser(grantId, { departments: userDepartments(user), userName: userName(user) });
    return { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt };
  }

  function shared(grant) {
    let b = cache.get(grant.id);
    if (!b) {
      const endpoint = grant.b24.endpoint.endsWith("/") ? grant.b24.endpoint : `${grant.b24.endpoint}/`;
      b = new Bitrix({
        oauth: {
          endpoint,
          origin: new URL(endpoint).origin,
          getTokens: async () => {
            const g = store.getGrant(grant.id);
            return g ? { accessToken: g.b24.accessToken, expiresAt: g.b24.expiresAt } : null;
          },
          refresh: () => refresh(grant.id),
        },
      });
      cache.set(grant.id, b);
    }
    return b;
  }

  const gone = () => new BitrixError("grant", "AUTH_EXPIRED", "no Bitrix24 grant for this user; sign in again");

  async function clientFor(grantId) {
    const grant = store.getGrant(grantId);
    if (!grant) {
      drop(grantId);
      throw gone();
    }
    const failures = new Set();
    const bitrix = observed(shared(grant), (code) => failures.add(code));
    try {
      await bitrix.ready(); // refresh (and re-check) now if the Bitrix token is about to expire
      const current = store.getGrant(grantId);
      if (!current) throw gone();
      const { readOnly } = effectiveReadOnly({
        global: config.readOnly,
        choice: current.readOnlyChoice,
        userId: current.userId,
        departments: current.departments,
        roUsers: config.roUsers,
        roDepts: config.roDepts,
        tree: await departmentTree(bitrix),
      });
      return {
        bitrix,
        readOnly,
        authFailure: () => (failures.has("AUTH_EXPIRED") ? "AUTH_EXPIRED" : failures.has("AUTH_REFRESH_FAILED") ? "AUTH_REFRESH_FAILED" : null),
      };
    } catch (e) {
      if (e instanceof BitrixError && e.code === "AUTH_EXPIRED") drop(grantId);
      throw e;
    }
  }

  return { clientFor, drop, has: (grantId) => cache.has(grantId) };
}
