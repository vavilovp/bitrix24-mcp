#!/usr/bin/env node
// HTTP-mode entry point: OAuth 2.1 authorization server for MCP clients, login through the Bitrix24 portal.
// Never imported by the stdio entry (server/index.js).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import express from "express";
import { rateLimit } from "express-rate-limit";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { BitrixError } from "./bitrix.js";
import { loadConfig } from "./config.js";
import { openStore } from "./store.js";
import { createProvider, createB24Login, b24Routes } from "./oauth.js";
import { createGrantClients } from "./grants.js";
import { registerTools, SERVER_INSTRUCTIONS, VERSION } from "./tools.js";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const RETRY_AFTER_S = 30;
// Request headers the MCP transport looks at; nothing else (Authorization included) is handed to it.
const MCP_HEADERS = ["accept", "content-type", "mcp-protocol-version", "mcp-session-id", "last-event-id"];
const DEFAULT_LIMITS = {
  "/register": { windowMs: 60 * MINUTE, limit: 20 },
  "/authorize": { windowMs: 15 * MINUTE, limit: 60 },
  "/token": { windowMs: 15 * MINUTE, limit: 100 },
  "/revoke": { windowMs: 15 * MINUTE, limit: 50 },
  "/b24/callback": { windowMs: 15 * MINUTE, limit: 30 },
  "/consent": { windowMs: 15 * MINUTE, limit: 30 },
};

const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; frame-ancestors 'none'; base-uri 'none'";

/** One line per request: method, path without query string, status, user id if known. Never query, body or headers. */
function requestLog(log) {
  return (req, res, next) => {
    if (req.path === "/healthz") return next();
    res.on("finish", () => {
      const p = String(req.originalUrl || req.url || "").split("?")[0].slice(0, 200);
      const uid = res.locals.userId ?? req.auth?.extra?.userId;
      log(`${req.method} ${p} ${res.statusCode}${uid ? ` user=${uid}` : ""}`);
    });
    next();
  };
}

/**
 * createApp(config, deps?) -> express app.
 * deps: { store?, b24? (createB24Login-compatible), grants? (createGrantClients-compatible), log?(line),
 *   rateLimits? (false | per-path overrides) }.
 * app.locals: { store, provider, config, grants }.
 */
export function createApp(config, deps = {}) {
  const log = deps.log ?? ((line) => console.log(line));
  let store = deps.store;
  if (!store) {
    fs.mkdirSync(config.dataDir, { recursive: true });
    store = openStore(path.join(config.dataDir, "bitrix24-mcp.sqlite"), config.secretKey);
  }
  const b24 = deps.b24 ?? createB24Login({ config });
  const provider = createProvider({ config, store, b24 });
  const grants = deps.grants ?? createGrantClients({ config, store, oauthTokenUrl: config.oauthTokenUrl });
  const resourceServerUrl = new URL("/mcp", config.publicUrl);
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceServerUrl);

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // one reverse proxy (Synology) in front
  app.locals.store = store;
  app.locals.provider = provider;
  app.locals.config = config;
  app.locals.grants = grants;

  app.use(requestLog(log));
  app.get("/healthz", (req, res) => res.json({ status: "ok" }));
  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "same-origin",
      "Content-Security-Policy": CSP,
    });
    next();
  });

  if (deps.rateLimits !== false) {
    for (const [p, opts] of Object.entries({ ...DEFAULT_LIMITS, ...(deps.rateLimits || {}) })) {
      app.use(p, rateLimit({ ...opts, standardHeaders: "draft-7", legacyHeaders: false,
        message: { error: "too_many_requests", error_description: "Too many requests, try again later" } }));
    }
  }

  app.use(mcpAuthRouter({
    provider,
    issuerUrl: new URL(config.publicUrl),
    // Protected-resource metadata at /.well-known/oauth-protected-resource/mcp, linked from /mcp 401s.
    resourceServerUrl,
    scopesSupported: [],
    resourceName: "Bitrix24",
    // Our own limiters above cover these paths.
    authorizationOptions: { rateLimit: false },
    tokenOptions: { rateLimit: false },
    clientRegistrationOptions: { rateLimit: false },
    revocationOptions: { rateLimit: false },
  }));

  app.use((req, res, next) => {
    if (req.path === "/b24/callback" || req.path === "/consent") res.set("Cache-Control", "no-store");
    next();
  });
  app.use(b24Routes({ config, store, provider, b24 }));

  const bearer = requireBearerAuth({ verifier: provider, resourceMetadataUrl });
  app.post("/mcp", bearer, express.json({ limit: "4mb" }), mcpHandler({ config, grants, resourceMetadataUrl }));
  // Stateless server: no standalone SSE stream and no sessions to delete.
  app.all("/mcp", bearer, (req, res) => {
    res.set("Allow", "POST").status(405).json({
      jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null,
    });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    log(`error ${req.method} ${String(req.originalUrl || "").split("?")[0].slice(0, 200)}: ${err?.type || err?.name || "Error"}`);
    if (!res.headersSent) res.status(err?.status && err.status < 500 ? err.status : 500).json({ error: "server_error" });
  });

  return app;
}

/** BitrixError AUTH_EXPIRED -> drop the grant, 401 invalid_token; anything else -> 503 with Retry-After. */
function authFailure(res, { code, grantId, grants, resourceMetadataUrl }) {
  if (code === "AUTH_EXPIRED") {
    grants.drop(grantId);
    const description = "The Bitrix24 sign-in is no longer valid; sign in again";
    res.set("WWW-Authenticate",
      `Bearer error="invalid_token", error_description="${description}", resource_metadata="${resourceMetadataUrl}"`);
    return res.status(401).json({ error: "invalid_token", error_description: description });
  }
  res.set("Retry-After", String(RETRY_AFTER_S));
  return res.status(503).json({ error: "temporarily_unavailable", error_description: "Bitrix24 is temporarily unavailable; try again later" });
}

/**
 * POST /mcp. Stateless: a new McpServer and transport per request, with the grant's own Bitrix client.
 * The transport answers with JSON (not SSE), so the whole result exists before anything is written: if a
 * Bitrix call during the request reported AUTH_EXPIRED / AUTH_REFRESH_FAILED (even one a tool caught and
 * turned into text), the result is discarded and the request ends in 401 / 503 instead.
 */
function mcpHandler({ config, grants, resourceMetadataUrl }) {
  return async (req, res, next) => {
    const grantId = req.auth.extra.grantId;
    let session;
    try {
      session = await grants.clientFor(grantId);
    } catch (e) {
      if (e instanceof BitrixError) return authFailure(res, { code: e.code, grantId, grants, resourceMetadataUrl });
      return next(e);
    }
    const server = new McpServer({ name: "bitrix24", version: VERSION }, { instructions: SERVER_INSTRUCTIONS });
    registerTools(server, { client: () => session.bitrix, readOnly: session.readOnly, mode: "http" });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      const headers = new Headers();
      for (const h of MCP_HEADERS) if (typeof req.headers[h] === "string") headers.set(h, req.headers[h]);
      const response = await transport.handleRequest(
        new Request(new URL("/mcp", config.publicUrl), { method: "POST", headers }),
        { authInfo: req.auth, parsedBody: req.body },
      );
      const failed = session.authFailure();
      if (failed) return authFailure(res, { code: failed, grantId, grants, resourceMetadataUrl });
      res.status(response.status);
      response.headers.forEach((value, key) => res.setHeader(key, value));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (e) {
      next(e);
    }
  };
}

/**
 * Start the HTTP server. Returns { server, app, close() }.
 * opts: { log?(line), signals? (default true: SIGTERM/SIGINT close and exit) }.
 */
export function main(env = process.env, { log, signals = true } = {}) {
  const config = loadConfig(env);
  const app = createApp(config, log ? { log } : {});
  const store = app.locals.store;
  const say = log ?? ((line) => console.log(line));
  const cleanup = () => {
    try {
      store.cleanup(Date.now());
    } catch (e) {
      say(`cleanup failed: ${e?.name || "Error"}`);
    }
  };
  cleanup();
  const timer = setInterval(cleanup, HOUR);
  timer.unref();
  const server = app.listen(config.port, () => {
    say(`Bitrix24 MCP (HTTP) listening on :${server.address().port}, public URL ${config.publicUrl}`);
  });
  let closing = null;
  const close = () => (closing ??= new Promise((resolve) => {
    clearInterval(timer);
    server.close(() => {
      store.close();
      resolve();
    });
    server.closeIdleConnections?.();
  }));
  if (signals) {
    const stop = () => close().then(() => process.exit(0));
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  }
  return { server, app, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try {
    main();
  } catch (e) {
    console.error(`Configuration error: ${e.message}`);
    process.exit(1);
  }
}
