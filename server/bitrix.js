// Minimal Bitrix24 REST client over an incoming webhook.

const RETRYABLE = new Set(["QUERY_LIMIT_EXCEEDED", "OPERATION_TIME_LIMIT"]);

export class BitrixError extends Error {
  constructor(method, code, description, status) {
    super(`${method}: ${code}${description ? ` — ${description}` : ""}`);
    this.method = method;
    this.code = code;
    this.status = status;
  }
}

export function normalizeWebhook(url) {
  if (!url || typeof url !== "string") {
    throw new Error("BITRIX_WEBHOOK_URL is not set. Specify the incoming webhook URL in the extension settings.");
  }
  let u = url.trim();
  // Allow a URL copied together with a method name, e.g. .../profile.json
  u = u.replace(/\/[a-z0-9_.]+\.json$/i, "/");
  if (!u.endsWith("/")) u += "/";
  if (!/^https?:\/\/[^/]+\/rest\/\d+\/[^/]+\/$/i.test(u)) {
    throw new Error(
      "The webhook URL looks wrong. Expected: https://<portal>/rest/<user_id>/<secret>/"
    );
  }
  return u;
}

export class Bitrix {
  /**
   * Webhook mode: new Bitrix(webhookUrl, opts).
   * OAuth mode: new Bitrix({ oauth: { endpoint, origin, getTokens, refresh } }, opts)
   * where getTokens/refresh resolve to { accessToken, expiresAt (ms epoch) }.
   * Contract: getTokens() resolving null/undefined means the grant is gone -> BitrixError AUTH_EXPIRED;
   * getTokens() throwing propagates as-is. refresh() rejecting with error.code === "invalid_grant" means
   * the grant was revoked -> AUTH_EXPIRED; any other refresh failure is transient -> AUTH_REFRESH_FAILED.
   */
  constructor(source, { timeoutMs = 60000 } = {}) {
    if (source && typeof source === "object" && source.oauth) {
      const o = source.oauth;
      this.oauth = o;
      this.base = o.endpoint;
      this.origin = o.origin;
      this._tokens = null;
      this._refreshing = null;
    } else {
      this.base = normalizeWebhook(source);
      this.origin = new URL(this.base).origin;
    }
    this.timeoutMs = timeoutMs;
    this._userCache = new Map();
  }

  async _currentTokens() {
    if (!this._tokens) {
      if (!this._loading) {
        this._loading = Promise.resolve()
          .then(() => this.oauth.getTokens())
          .then((t) => {
            if (!t) throw new BitrixError("oauth.getTokens", "AUTH_EXPIRED", "no Bitrix24 grant for this user; sign in again");
            if (!this._tokens) this._tokens = t;
          })
          .finally(() => {
            this._loading = null;
          });
      }
      await this._loading;
    }
    if (this._tokens.expiresAt - Date.now() < 60000) await this._refresh(this._tokens.accessToken);
    return this._tokens;
  }

  // Refresh once per instance at a time; a caller whose token was already replaced skips the refresh.
  async _refresh(usedToken) {
    if (!this._refreshing && this._tokens && this._tokens.accessToken !== usedToken) return;
    if (!this._refreshing) {
      this._refreshing = Promise.resolve()
        .then(() => this.oauth.refresh())
        .then(
          (t) => {
            this._tokens = t;
          },
          (e) => {
            if (e && e.code === "invalid_grant") {
              throw new BitrixError("oauth.refresh", "AUTH_EXPIRED", "the Bitrix24 grant was revoked; sign in again");
            }
            throw new BitrixError("oauth.refresh", "AUTH_REFRESH_FAILED", "could not refresh the Bitrix24 access token; try again later");
          }
        )
        .finally(() => {
          this._refreshing = null;
        });
    }
    await this._refreshing;
  }

  async call(method, params = {}, attempt = 0, authRetried = false) {
    const url = `${this.base}${method}.json`;
    let body = JSON.stringify(params ?? {});
    let usedToken;
    if (this.oauth) {
      usedToken = (await this._currentTokens()).accessToken;
      body = JSON.stringify({ ...(params ?? {}), auth: usedToken });
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body,
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new BitrixError(
        method,
        "NETWORK_ERROR",
        `${e.name === "AbortError" ? "timeout" : e.message}. Is ${this.origin} reachable from this computer?`
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new BitrixError(method, `HTTP_${res.status}`, text.slice(0, 300), res.status);
    }

    if (data && data.error) {
      if (this.oauth && data.error === "expired_token") {
        if (authRetried) throw new BitrixError(method, "AUTH_EXPIRED", "access token rejected after refresh; sign in again", res.status);
        await this._refresh(usedToken);
        return this.call(method, params, attempt, true);
      }
      if (RETRYABLE.has(data.error) && attempt < 4) {
        await new Promise((r) => setTimeout(r, 600 * 2 ** attempt));
        return this.call(method, params, attempt + 1, authRetried);
      }
      throw new BitrixError(method, data.error, data.error_description, res.status);
    }
    return data; // { result, next?, total?, time }
  }

  async result(method, params) {
    return (await this.call(method, params)).result;
  }

  /**
   * Run up to 50 calls in one request via the `batch` method.
   * cmds: { key: [method, flatParams] }. Returns { results: {key: result}, errors: {key: "CODE: description"} }.
   * A failing command does not fail the others.
   */
  async batch(cmds) {
    const entries = Object.entries(cmds);
    if (entries.length > 50) throw new Error("batch: at most 50 commands per call");
    const cmd = {};
    for (const [key, [method, params]] of entries) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params || {})) {
        if (v === undefined || v === null || v === "") continue;
        if (typeof v === "object") throw new Error(`batch: parameter ${k} of ${method} must be a scalar`);
        qs.append(k, String(v));
      }
      cmd[key] = `${method}?${qs}`;
    }
    const r = (await this.call("batch", { halt: 0, cmd })).result || {};
    const errors = {};
    for (const [key, e] of Object.entries(r.result_error || {})) {
      errors[key] = e?.error ? `${e.error}${e.error_description ? `: ${e.error_description}` : ""}` : String(e);
    }
    return { results: Array.isArray(r.result) ? {} : r.result || {}, errors };
  }

  /** Resolve user IDs to "Name Surname" strings, with caching. */
  async userNames(ids) {
    const want = [...new Set(ids.map(String).filter((x) => x && x !== "0" && !this._userCache.has(x)))];
    if (want.length) {
      try {
        const users = await this.result("user.get", { FILTER: { ID: want } });
        for (const u of users || []) {
          this._userCache.set(String(u.ID), [u.NAME, u.LAST_NAME].filter(Boolean).join(" ") || u.EMAIL || `#${u.ID}`);
        }
      } catch {
        // user scope may be missing — names stay unresolved
      }
      for (const id of want) if (!this._userCache.has(id)) this._userCache.set(id, null);
    }
    const out = {};
    for (const id of ids.map(String)) out[id] = this._userCache.get(id) ?? null;
    return out;
  }
}
