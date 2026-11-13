#!/usr/bin/env node
// HTTP-mode entry point: OAuth 2.1 authorization server for MCP clients, login through the Bitrix24 portal.
// Never imported by the stdio entry (server/index.js).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import express from "express";
import { rateLimit } from "express-rate-limit";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { loadConfig } from "./config.js";
import { openStore } from "./store.js";
import { createProvider, createB24Login, b24Routes } from "./oauth.js";

const MINUTE = 60 * 1000;
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
 * deps: { store?, b24? (createB24Login-compatible), log?(line), rateLimits? (false | per-path overrides) }.
 * app.locals: { store, provider, config }.
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

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // one reverse proxy (Synology) in front
  app.locals.store = store;
  app.locals.provider = provider;
  app.locals.config = config;

  app.use(requestLog(log));
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

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    log(`error ${req.method} ${String(req.originalUrl || "").split("?")[0].slice(0, 200)}: ${err?.type || err?.name || "Error"}`);
    if (!res.headersSent) res.status(err?.status && err.status < 500 ? err.status : 500).json({ error: "server_error" });
  });

  return app;
}

export function main(env = process.env) {
  const config = loadConfig(env);
  const app = createApp(config);
  const server = app.listen(config.port, () => {
    console.log(`Bitrix24 MCP (HTTP) listening on :${config.port}, public URL ${config.publicUrl}`);
  });
  const stop = () => server.close(() => {
    app.locals.store.close();
    process.exit(0);
  });
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try {
    main();
  } catch (e) {
    console.error(`Configuration error: ${e.message}`);
    process.exit(1);
  }
}
