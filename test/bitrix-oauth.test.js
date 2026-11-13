import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Bitrix, BitrixError } from "../server/bitrix.js";

async function fake(handler) {
  const reqs = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : {};
      reqs.push({ url: req.url, body: parsed });
      const out = handler(parsed, reqs.length);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${srv.address().port}`;
  return { reqs, origin, endpoint: `${origin}/rest/`, close: () => srv.close() };
}

const ok = { result: { ID: "1" } };

test("sends auth and calls endpoint", async () => {
  const f = await fake(() => ok);
  try {
    const b = new Bitrix({
      oauth: {
        endpoint: f.endpoint,
        origin: f.origin,
        getTokens: async () => ({ accessToken: "A1", expiresAt: Date.now() + 3600e3 }),
        refresh: async () => assert.fail("no refresh"),
      },
    });
    assert.equal(b.origin, f.origin);
    const r = await b.result("user.current", { X: 1 });
    assert.deepEqual(r, { ID: "1" });
    assert.equal(f.reqs[0].url, "/rest/user.current.json");
    assert.equal(f.reqs[0].body.auth, "A1");
    assert.equal(f.reqs[0].body.X, 1);
  } finally {
    f.close();
  }
});

test("refreshes on expired_token and retries once", async () => {
  const f = await fake((body) => (body.auth === "A1" ? { error: "expired_token" } : ok));
  try {
    let refreshed = 0;
    const b = new Bitrix({
      oauth: {
        endpoint: f.endpoint,
        origin: f.origin,
        getTokens: async () => ({ accessToken: "A1", expiresAt: Date.now() + 3600e3 }),
        refresh: async () => (refreshed++, { accessToken: "A2", expiresAt: Date.now() + 3600e3 }),
      },
    });
    await b.call("user.current");
    assert.equal(refreshed, 1);
    assert.deepEqual(f.reqs.map((r) => r.body.auth), ["A1", "A2"]);
  } finally {
    f.close();
  }
});

test("second expired_token gives AUTH_EXPIRED without leaking token", async () => {
  const f = await fake(() => ({ error: "expired_token" }));
  try {
    const b = new Bitrix({
      oauth: {
        endpoint: f.endpoint,
        origin: f.origin,
        getTokens: async () => ({ accessToken: "SECRET1", expiresAt: Date.now() + 3600e3 }),
        refresh: async () => ({ accessToken: "SECRET2", expiresAt: Date.now() + 3600e3 }),
      },
    });
    await assert.rejects(b.call("user.current"), (e) => {
      assert.ok(e instanceof BitrixError);
      assert.equal(e.code, "AUTH_EXPIRED");
      assert.ok(!e.message.includes("SECRET"));
      return true;
    });
    assert.equal(f.reqs.length, 2);
  } finally {
    f.close();
  }
});

test("refreshes proactively near expiry", async () => {
  const f = await fake(() => ok);
  try {
    const b = new Bitrix({
      oauth: {
        endpoint: f.endpoint,
        origin: f.origin,
        getTokens: async () => ({ accessToken: "A1", expiresAt: Date.now() + 30e3 }),
        refresh: async () => ({ accessToken: "A2", expiresAt: Date.now() + 3600e3 }),
      },
    });
    await b.call("user.current");
    assert.equal(f.reqs.length, 1);
    assert.equal(f.reqs[0].body.auth, "A2");
  } finally {
    f.close();
  }
});

test("concurrent calls refresh once", async () => {
  const f = await fake(() => ok);
  try {
    let refreshed = 0;
    const b = new Bitrix({
      oauth: {
        endpoint: f.endpoint,
        origin: f.origin,
        getTokens: async () => ({ accessToken: "A1", expiresAt: Date.now() - 1000 }),
        refresh: async () => {
          refreshed++;
          await new Promise((r) => setTimeout(r, 50));
          return { accessToken: "A2", expiresAt: Date.now() + 3600e3 };
        },
      },
    });
    await Promise.all([1, 2, 3, 4, 5].map(() => b.call("user.current")));
    assert.equal(refreshed, 1);
    assert.ok(f.reqs.every((r) => r.body.auth === "A2"));
  } finally {
    f.close();
  }
});

test("refresh failure gives AUTH_EXPIRED", async () => {
  const f = await fake(() => ok);
  try {
    const b = new Bitrix({
      oauth: {
        endpoint: f.endpoint,
        origin: f.origin,
        getTokens: async () => ({ accessToken: "A1", expiresAt: Date.now() - 1000 }),
        refresh: async () => {
          throw new Error("invalid_grant");
        },
      },
    });
    await assert.rejects(b.call("user.current"), (e) => e instanceof BitrixError && e.code === "AUTH_EXPIRED");
    assert.equal(f.reqs.length, 0);
  } finally {
    f.close();
  }
});
