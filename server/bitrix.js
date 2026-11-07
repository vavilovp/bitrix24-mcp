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
  constructor(webhookUrl, { timeoutMs = 60000 } = {}) {
    this.base = normalizeWebhook(webhookUrl);
    this.origin = new URL(this.base).origin;
    this.timeoutMs = timeoutMs;
    this._userCache = new Map();
  }

  async call(method, params = {}, attempt = 0) {
    const url = `${this.base}${method}.json`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(params ?? {}),
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
      if (RETRYABLE.has(data.error) && attempt < 4) {
        await new Promise((r) => setTimeout(r, 600 * 2 ** attempt));
        return this.call(method, params, attempt + 1);
      }
      throw new BitrixError(method, data.error, data.error_description, res.status);
    }
    return data; // { result, next?, total?, time }
  }

  async result(method, params) {
    return (await this.call(method, params)).result;
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
