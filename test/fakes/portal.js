// Fake Bitrix24 portal for HTTP-mode tests: portal OAuth page, oauth.bitrix.info token endpoint and REST.
// All names and ids are invented.
import http from "node:http";
import crypto from "node:crypto";

export const DEPARTMENTS = [
  { ID: "1", NAME: "Company", PARENT: "" },
  { ID: "7", NAME: "Sales", PARENT: "1" },
  { ID: "12", NAME: "Sales East", PARENT: "7" },
];

export const USERS = {
  5: { ID: "5", ACTIVE: true, NAME: "Ann", LAST_NAME: "Example", UF_DEPARTMENT: [12] },
  6: { ID: "6", ACTIVE: false, NAME: "Ivan", LAST_NAME: "Gone", UF_DEPARTMENT: [7] },
  8: { ID: "8", ACTIVE: true, NAME: "Ext", LAST_NAME: "Partner", UF_DEPARTMENT: [] },
  9: { ID: "9", ACTIVE: true, NAME: "Typed", LAST_NAME: "Extranet", USER_TYPE: "extranet", UF_DEPARTMENT: [7] },
  10: { ID: "10", ACTIVE: true, NAME: "Bob", LAST_NAME: "Sample", UF_DEPARTMENT: [1] },
};

const rand = (p) => `${p}-${crypto.randomBytes(12).toString("hex")}`;

/**
 * startFakePortal({ clientId, clientSecret }) -> {
 *   origin, tokenUrl, reqs, users, departments,
 *   callbackUrl (set by the test), nextUserId, memberId, clientEndpoint (override), issued (Bitrix tokens handed out),
 *   close() }
 */
export async function startFakePortal({ clientId = "local.test.app", clientSecret = "fake-client-secret" } = {}) {
  const codes = new Map(); // bitrix code -> userId
  const access = new Map(); // access token -> { userId, expired }
  const refresh = new Map(); // refresh token -> userId
  const fake = {
    reqs: [],
    users: structuredClone(USERS),
    departments: structuredClone(DEPARTMENTS),
    callbackUrl: null,
    nextUserId: 5,
    memberId: "member-aaa",
    clientEndpoint: null,
    issued: [],
    access,
    refresh,
  };

  function issue(userId) {
    const a = rand("b24access");
    const r = rand("b24refresh");
    access.set(a, { userId, expired: false });
    refresh.set(r, userId);
    fake.issued.push(a, r);
    return {
      access_token: a,
      refresh_token: r,
      client_endpoint: fake.clientEndpoint ?? `${fake.origin}/rest/`,
      server_endpoint: "https://oauth.bitrix.info/rest/",
      domain: "oauth.bitrix.info",
      expires: Math.floor(Date.now() / 1000) + 3600,
      expires_in: 3600,
      member_id: fake.memberId,
      scope: "app",
      status: "L",
      user_id: Number(userId),
    };
  }

  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url, fake.origin);
      const json = (status, obj) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      fake.reqs.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });

      if (url.pathname === "/oauth/authorize/") {
        if (url.searchParams.get("client_id") !== clientId) return json(400, { error: "invalid_client" });
        const code = rand("b24code");
        codes.set(code, fake.nextUserId);
        const to = new URL(fake.callbackUrl);
        to.searchParams.set("code", code);
        to.searchParams.set("state", url.searchParams.get("state") ?? "");
        to.searchParams.set("domain", new URL(fake.origin).host);
        to.searchParams.set("member_id", fake.memberId);
        to.searchParams.set("scope", "app");
        to.searchParams.set("server_domain", "oauth.bitrix.info");
        res.writeHead(302, { Location: to.href });
        return res.end();
      }

      if (url.pathname === "/oauth/token/") {
        const q = url.searchParams;
        if (q.get("client_id") !== clientId || q.get("client_secret") !== clientSecret) {
          return json(401, { error: "invalid_client", error_description: "Invalid client" });
        }
        if (q.get("grant_type") === "authorization_code") {
          const userId = codes.get(q.get("code"));
          codes.delete(q.get("code"));
          if (userId === undefined) return json(400, { error: "invalid_grant", error_description: "Invalid code" });
          return json(200, issue(userId));
        }
        if (q.get("grant_type") === "refresh_token") {
          const userId = refresh.get(q.get("refresh_token"));
          refresh.delete(q.get("refresh_token"));
          if (userId === undefined) return json(400, { error: "invalid_grant", error_description: "Invalid refresh token" });
          return json(200, issue(userId));
        }
        return json(400, { error: "unsupported_grant_type" });
      }

      const m = url.pathname.match(/^\/rest\/([a-z0-9_.]+)\.json$/i);
      if (m && req.method === "POST") {
        let params = {};
        try {
          params = body ? JSON.parse(body) : {};
        } catch {
          return json(400, { error: "INVALID_REQUEST" });
        }
        const t = access.get(params.auth);
        if (!t) return json(401, { error: "invalid_token", error_description: "Unable to authorize user" });
        if (t.expired) return json(401, { error: "expired_token", error_description: "The access token provided has expired." });
        if (m[1] === "user.current") return json(200, { result: fake.users[t.userId] });
        if (m[1] === "department.get") return json(200, { result: fake.departments, total: fake.departments.length });
        if (fake.rest?.[m[1]]) return json(200, fake.rest[m[1]](params, t.userId));
        return json(400, { error: "ERROR_METHOD_NOT_FOUND", error_description: "Method not found!" });
      }

      json(404, { error: "NOT_FOUND" });
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  fake.origin = `http://127.0.0.1:${srv.address().port}`;
  fake.tokenUrl = `${fake.origin}/oauth/token/`;
  fake.close = () =>
    new Promise((r) => {
      srv.closeAllConnections?.();
      srv.close(() => r());
    });
  return fake;
}
