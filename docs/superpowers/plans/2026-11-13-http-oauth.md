# Remote HTTPS Mode with Bitrix24 OAuth — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the existing Bitrix24 MCP server as a multi-user HTTPS service on a Synology NAS, where each person signs in through the portal's own OAuth and the tools act with that person's rights.

**Architecture:** Tool registration moves out of the stdio entry into `server/tools.js`, parameterised by a per-request context (Bitrix client, read-only flag, mode). A new express entry `server/http.js` mounts the MCP SDK's `mcpAuthRouter` with our own provider (`server/oauth.js`), which delegates user login to the portal (`/oauth/authorize/` + `oauth.bitrix.info` token exchange), shows a consent page, and stores grants in SQLite (`server/store.js`). `/mcp` runs a stateless Streamable HTTP transport per request with a `Bitrix` client in OAuth mode that refreshes its tokens.

**Tech Stack:** Node 24 (`node:sqlite`, `node:crypto`, `node:test`), `@modelcontextprotocol/sdk` 1.32 (`StreamableHTTPServerTransport`, `mcpAuthRouter`, `requireBearerAuth`), express 5, zod 4, Docker (node:24-alpine) on Synology Container Manager behind the DSM reverse proxy.

**Spec:** `docs/superpowers/specs/2026-11-13-http-oauth-design.md`

## Global Constraints

- The `.mcpb` stdio mode keeps its behaviour, its 35 tools and its tests; it must not import `node:sqlite`, express or any HTTP-mode module (runtime floor there stays Node ≥ 18).
- One portal per server: `B24_PORTAL=https://portal.example.ru`. Public address `PUBLIC_URL=https://mcp.example.synology.me`; Bitrix handler/redirect `https://mcp.example.synology.me/b24/callback`.
- Bitrix token exchange/refresh: `https://oauth.bitrix.info/oauth/token/` (overridable by `B24_OAUTH_TOKEN_URL` for tests). REST: `{client_endpoint}{method}.json` with `auth=<access_token>`; expired token error code `expired_token`.
- Our tokens: access ≤ 1 h, refresh ≤ 30 days with rotation; authorization code 10 min, single use. Only SHA-256 hashes of our tokens are stored. Bitrix tokens stored encrypted with AES-256-GCM using `SECRET_KEY` (32 bytes, base64).
- Eligible user: `ACTIVE` true and not extranet. Anyone else gets a refusal page and nothing is stored.
- Effective read-only = `READ_ONLY` env OR user's checkbox OR user id in `READ_ONLY_USERS` OR any of the user's departments or their ancestors in `READ_ONLY_DEPARTMENTS`. Re-evaluated (user active + departments) on every Bitrix token refresh.
- DCR open to any `https://` redirect URI plus `http://localhost` / `http://127.0.0.1`. Consent page always shows client name and redirect host; hosts outside `KNOWN_CLIENT_HOSTS` (default `claude.ai,claude.com,localhost,127.0.0.1`) get a warning and an extra required checkbox. Client name is HTML-escaped and truncated.
- HTTP mode: `b24_call` rejects application-level methods (`event.*`, `placement.*`, `app.*`, `imbot.*`, `imconnector.*`, `userfieldtype.*`, `bizproc.activity.*`, `bizproc.robot.*`, `user.option.*`, `entity.*`, `feature.*`, `messageservice.*`, `pay_system.*`, `sale.paysystem.handler.*`); all tool output is scrubbed of `auth=`/`access_token=` URL parameters and `DOWNLOAD_URL` values; `disk_file` never writes to disk and returns `DETAIL_URL` for formats it cannot inline.
- No tokens or codes in logs. Logs: method, path, status, user id.
- Env: `PUBLIC_URL`, `B24_PORTAL`, `B24_CLIENT_ID`, `B24_CLIENT_SECRET`, `SECRET_KEY`, `READ_ONLY`, `READ_ONLY_USERS`, `READ_ONLY_DEPARTMENTS`, `KNOWN_CLIENT_HOSTS`, `DATA_DIR` (default `/data`), `PORT` (default 3000).
- Repo is public: fixtures and docs use invented names and `portal.example.ru`, never real colleagues or `portal.example.ru` tokens/secrets.

## Review Focus

1. Two users calling `/mcp` at the same time each see only their own data (no shared `Bitrix` instance or user-name cache across grants) — Task 7 test `two grants in parallel`.
2. A Bitrix refresh token that is revoked or expired yields HTTP 401 with `WWW-Authenticate` and deletes the grant, not a 500 — Task 7 test `revoked bitrix refresh token`.
3. A client name containing HTML/script is rendered escaped and the real redirect host is shown next to it — Task 6 test `consent escapes client name`.
4. Container restart keeps grants working (store on disk), and a changed `SECRET_KEY` makes old grants fail closed (401, grant deleted), not crash — Task 4 test `wrong key fails closed`, Task 7 test `restart keeps grant`.
5. Parallel tool calls of one grant whose Bitrix token just expired cause exactly one refresh request — Task 3 test `concurrent calls refresh once`.

---

### Task 1: Spike — Bitrix OAuth works for the box portal (throwaway, gate)

Needs the owner: create the local app on the portal (instructions below), then sign in once in a browser.

**Files:**
- Create (scratch, not committed): `<scratchpad>/spike-b24-oauth.mjs`

- [ ] **Step 1: Give the owner the portal setup steps** (also the draft of the README section in Task 8): Приложения → Разработчикам → Другое → Локальное приложение; тип «Серверное»; галочка «Приложение использует только API»; путь обработчика `https://mcp.example.synology.me/b24/callback`; права `user`, `department`, `task`, `im`, `disk`, `calendar`, `crm`, `sonet_group`; сохранить, прислать `client_id` (секрет — не в чат, а в файл `.env.spike` в scratchpad, который владелец создаёт сам). Record the exact menu and scope labels the owner sees.
- [ ] **Step 2: Script prints** `https://portal.example.ru/oauth/authorize/?client_id=<id>&state=spike`. Owner opens it, signs in, copies the full URL of the (not yet existing) callback page.
- [ ] **Step 3: Script exchanges** the `code` at `oauth.bitrix.info` (`grant_type=authorization_code`, `client_id`, `client_secret`, `code`), prints the response keys (not values) and `client_endpoint`, `member_id`, `expires_in`.
- [ ] **Step 4: Script calls** `user.current`, `im.dialog.messages.search` (CHAT_ID of any chat from `im.recent.list`, `SEARCH_MESSAGE=BitrixGPT`), `disk.storage.getList`, then refreshes (`grant_type=refresh_token`) and calls `user.current` again with the new token.
- [ ] **Step 5: Gate.** All calls succeed → continue to Task 2. Any failure (exchange refused, scopes missing, `oauth.bitrix.info` rejects the box) → stop, report to the owner; approach 2 (per-user webhooks) gets its own design. Delete the scratch script and `.env.spike`.

### Task 2: Extract tool registration into `server/tools.js`

**Files:**
- Create: `server/tools.js`
- Modify: `server/index.js` (becomes the stdio entry: env → `Bitrix` → `registerTools` → `StdioServerTransport`)
- Test: `test/server.test.js` (unchanged, must still pass), `test/tools.test.js`

**Interfaces:**
- Produces: `export function registerTools(server: McpServer, ctx: ToolContext): void` where `ToolContext = { client: () => Bitrix, readOnly: boolean, mode: "stdio" | "http", downloadDir?: string }`.
- Produces: `export const SERVER_INSTRUCTIONS: string` (the current `instructions` text) and `export const VERSION`.
- All current reads of `READ_ONLY`, `DOWNLOAD_DIR`, `client()` and `b24` inside tools go through `ctx`. `compactMessages` takes the portal origin from `ctx.client().origin`.

- [ ] **Step 1: Write failing test** `test/tools.test.js` → `registerTools exposes the same tools in both modes`: build two `McpServer`s with a stub `client`, `readOnly: false`, modes `stdio` and `http`; list tools through an in-memory client (`InMemoryTransport.createLinkedPair()` from the SDK); assert both have 35 tools with identical names, and `b24_call.annotations.readOnlyHint === false`.
- [ ] **Step 2: Second test** `readOnly ctx disables write tools`: with `readOnly: true`, calling `task_create` returns `isError: true` with text containing `read-only`, and `b24_call.annotations.readOnlyHint === true`.
- [ ] **Step 3: Run** `node --test test/tools.test.js` → FAIL (module not found).
- [ ] **Step 4: Move the tool code** from `server/index.js` to `server/tools.js` unchanged except for `ctx`. `b24_whoami` reports `download_dir` only in stdio mode.
- [ ] **Step 5: Run** `npm test` → all tests pass (12 existing + 2 new). Run `npm run check` (add `server/tools.js` to it).
- [ ] **Step 6: Commit** `refactor: move tool registration to server/tools.js with a per-request context`.

### Task 3: OAuth mode in `Bitrix`

**Files:**
- Modify: `server/bitrix.js`
- Test: `test/bitrix-oauth.test.js`

**Interfaces:**
- Produces: `new Bitrix({ oauth: { endpoint: string, origin: string, getTokens: () => Promise<{accessToken, expiresAt:number}>, refresh: () => Promise<{accessToken, expiresAt:number}> } }, opts?)`. Webhook form `new Bitrix(webhookUrl, opts)` unchanged.
- In OAuth mode `call()` posts to `${endpoint}${method}.json` with `auth` added to the JSON body; `origin` is the portal origin (for links). Before a call, if `expiresAt - now < 60 s`, refresh first; on `expired_token` refresh and retry once; a second `expired_token` or a refresh failure throws `BitrixError` with code `AUTH_EXPIRED`. Concurrent refreshes of one instance share one promise.
- `batch()` works unchanged on top of `call()`.

- [ ] **Step 1: Write failing tests** against a local fake HTTP server: `sends auth and calls endpoint` (body contains `auth: "A1"`, URL `/rest/user.current.json`); `refreshes on expired_token and retries once` (first response `{error:"expired_token"}`, refresh returns `A2`, second request carries `A2`); `refreshes proactively near expiry` (`expiresAt = now + 30 s` → refresh before first request); `concurrent calls refresh once` (5 parallel calls after expiry → `refresh` called exactly 1 time); `refresh failure gives AUTH_EXPIRED`.
- [ ] **Step 2: Run** `node --test test/bitrix-oauth.test.js` → FAIL.
- [ ] **Step 3: Implement** in `server/bitrix.js`.
- [ ] **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(bitrix): OAuth mode with token refresh`.

### Task 4: Store and crypto

**Files:**
- Create: `server/store.js`, `server/crypto.js`
- Test: `test/store.test.js`

**Interfaces:**
- `crypto.js`: `encrypt(plain: string, key: Buffer): string`, `decrypt(blob: string, key: Buffer): string` (AES-256-GCM, random 12-byte IV, throws on wrong key/tamper), `hashToken(token: string): string` (SHA-256 hex), `randomToken(): string` (32 bytes base64url), `loadKey(b64: string): Buffer` (throws unless 32 bytes).
- `store.js`: `openStore(file: string, key: Buffer)` returning an object with:
  - clients: `getClient(id)`, `saveClient(info)`, `touchClient(id)`
  - pending authorize requests: `savePending(id, data, ttlMs)`, `takePending(id)` (single read, deletes)
  - auth codes: `saveCode(hash, data, ttlMs)`, `takeCode(hash)`
  - grants: `createGrant({userId, userName, clientId, readOnlyChoice, departments, b24: {accessToken, refreshToken, expiresAt, endpoint}}) → grantId`, `getGrant(id)` (Bitrix tokens decrypted; on decrypt failure deletes the grant and returns `null`), `updateGrantTokens(id, b24)`, `updateGrantUser(id, {departments, userName})`, `deleteGrant(id)`
  - our tokens: `saveToken(hash, {grantId, kind: "access"|"refresh", expiresAt})`, `getToken(hash)`, `deleteToken(hash)`, `deleteTokensOfGrant(grantId)`
  - `cleanup(now)`: expired pending/codes/tokens, grants with no live refresh token, clients unused for 30 days.
- Uses `node:sqlite` `DatabaseSync`; schema created on open.

- [ ] **Step 1: Write failing tests:** `encrypt round trip`; `wrong key fails closed` (store opened with key B returns `null` for a grant written with key A and the grant row is gone); `pending and codes are single use and expire`; `grant tokens are encrypted at rest` (raw sqlite row does not contain the access token string); `cleanup removes expired`.
- [ ] **Step 2: Run** `node --test test/store.test.js` → FAIL.
- [ ] **Step 3: Implement** `server/crypto.js` and `server/store.js`.
- [ ] **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Commit** `feat: grant store on node:sqlite with encrypted Bitrix tokens`.

### Task 5: Access policy and HTTP-mode tool guards

**Files:**
- Create: `server/policy.js`
- Modify: `server/tools.js` (use the guards when `ctx.mode === "http"`)
- Test: `test/policy.test.js`, `test/tools.test.js`

**Interfaces:**
- `isEligible(user): boolean` — `user` is the `user.current` result; true when `ACTIVE` is true and the user is not extranet (`USER_TYPE` is `"employee"`, or, if absent, `UF_DEPARTMENT` is non-empty).
- `departmentAncestors(deptIds: number[], tree: Map<number, number|null>): Set<number>` — the ids and all their parents.
- `loadDepartmentTree(client: Bitrix): Promise<Map<number, number|null>>` — all pages of `department.get`, `ID → PARENT`; cached by the caller for 1 h.
- `effectiveReadOnly({ global, choice, userId, departments, roUsers: Set<number>, roDepts: Set<number>, tree }): { readOnly: boolean, forced: boolean }` — `forced` when global, user listed, or any ancestor listed.
- `isBlockedAppMethod(method: string): boolean` — the prefixes from Global Constraints, case-insensitive.
- `scrubOutput(text: string): string` — removes `auth=…` and `access_token=…` query parameters and replaces `"DOWNLOAD_URL":"…"` values with `"[removed]"`.

- [ ] **Step 1: Write failing tests** `test/policy.test.js`: `eligible employee / inactive / extranet`; `sub-department is forced read-only` (tree 1←7←12, `roDepts={7}`, user in 12 → `{readOnly:true, forced:true}`); `choice alone is not forced`; `blocked methods` (`event.bind`, `PLACEMENT.bind`, `app.option.set`, `imbot.register` true; `crm.deal.list`, `crm.deal.userfield.list`, `user.current` false); `scrubOutput` on `https://p/x?auth=SECRET&a=1` → no `SECRET`, `a=1` kept, and on a JSON with `DOWNLOAD_URL`.
- [ ] **Step 2: Add to** `test/tools.test.js`: `http mode blocks app methods in b24_call` (stub client must not be called; error text names the method); `http mode scrubs tokens` (stub `disk_list` result containing `DOWNLOAD_URL` with `auth=` → output has neither); `http disk_file does not write files` (stub `disk.file.get` for a `.pdf` → result has `DETAIL_URL`, `saved_to` absent, no file in a temp `downloadDir`).
- [ ] **Step 3: Run** → FAIL. **Step 4: Implement.** **Step 5: Run** `npm test` → PASS.
- [ ] **Step 6: Commit** `feat: access policy and HTTP-mode tool guards`.

### Task 6: OAuth provider, portal login and consent page

**Files:**
- Create: `server/config.js`, `server/oauth.js`, `server/pages.js`, `server/http.js` (auth routes only in this task)
- Test: `test/http-auth.test.js`, `test/fakes/portal.js` (fake portal REST + `/oauth/authorize/` + fake `oauth.bitrix.info` token endpoint)

**Interfaces:**
- `config.js`: `loadConfig(env = process.env): Config` — parses the env list from Global Constraints, validates required ones, returns sets for `roUsers`, `roDepts`, `knownClientHosts`.
- `oauth.js`: `createProvider({ config, store, b24 })` implementing the SDK `OAuthServerProvider`: `clientsStore.getClient/registerClient` (registerClient validates redirect URIs per Global Constraints), `authorize(client, params, res)` (saves pending, redirects to `${B24_PORTAL}/oauth/authorize/?client_id=…&state=<pendingId>`), `challengeForAuthorizationCode`, `exchangeAuthorizationCode`, `exchangeRefreshToken` (rotates), `verifyAccessToken(token) → { token, clientId, scopes: [], expiresAt, extra: { grantId } }`, `revokeToken`.
- `oauth.js`: `b24Routes({ config, store, provider }) → express.Router` with `GET /b24/callback` (validate state → exchange code → check `member_id`/endpoint is the configured portal → `user.current` → eligibility → render consent) and `POST /consent` (CSRF token tied to the pending id; unknown-host checkbox required; creates grant, issues code, 302 to client `redirect_uri` with `code` and original `state`).
- `pages.js`: `consentPage({ user, client, redirectHost, known, forcedReadOnly, csrf })`, `refusalPage(reason)`, `errorPage(message)` — plain HTML, no external resources, all interpolations escaped.
- `http.js`: `createApp(config, deps?) → express.Application` (`trust proxy`, rate limits on `/register`, `/authorize`, `/token`, `/b24/callback`, `/consent`; `mcpAuthRouter({ provider, issuerUrl: PUBLIC_URL, scopesSupported: [] })`); `main()` starts it when run directly.

- [ ] **Step 1: Write failing end-to-end tests** using `createApp` against the fakes and a cookie-less HTTP client: `full login flow issues tokens` (register → `/authorize` with PKCE → follow to fake portal → `/b24/callback` → consent HTML contains user name and `claude.ai` → POST consent → 302 to redirect_uri with `code` and `state` → `/token` returns `access_token`, `refresh_token`, `expires_in ≤ 3600`); `refresh rotates` (old refresh token rejected after use); `inactive user is refused` (no grant row); `extranet user is refused`; `foreign portal is refused` (exchange returns another `member_id`); `consent escapes client name` (`client_name: "<script>x</script>"` → escaped, host shown); `unknown host needs the extra checkbox` (POST without it → 400, with it → 302); `forced read-only checkbox cannot be cleared` (user in `READ_ONLY_USERS`, POST `read_only=0` → grant has read-only); `state reuse fails`.
- [ ] **Step 2: Run** `node --test test/http-auth.test.js` → FAIL.
- [ ] **Step 3: Implement** config, pages, provider, routes, app. Add `express` to `dependencies` at the version the SDK already uses. Request log line per request: method, path without query string, status, user id if known — test `logs carry no codes or tokens` captures the log output of the full flow and asserts no `code=`, issued access/refresh token or Bitrix token appears.
- [ ] **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Commit** `feat: OAuth login through the Bitrix24 portal with consent page`.

### Task 7: `/mcp` endpoint, per-grant clients and re-checks

**Files:**
- Modify: `server/http.js`
- Create: `server/grants.js`
- Test: `test/http-mcp.test.js`

**Interfaces:**
- `grants.js`: `createGrantClients({ config, store, oauthTokenUrl }) → { clientFor(grantId): Promise<{ bitrix: Bitrix, readOnly: boolean }> }`. Builds a `Bitrix` in OAuth mode per grant (cached by grantId, never shared); its `refresh` calls the Bitrix token endpoint, saves new tokens, then runs `user.current` + department tree check: inactive → `deleteGrant` + `deleteTokensOfGrant` and throw `AUTH_EXPIRED`; otherwise `updateGrantUser`. `readOnly` from `effectiveReadOnly`.
- `http.js`: `POST/GET/DELETE /mcp` behind `requireBearerAuth({ verifier: provider, resourceMetadataUrl })`; per request: `clientFor(req.auth.extra.grantId)` → new `McpServer` + `registerTools(server, { client: () => bitrix, readOnly, mode: "http" })` + `new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })`. `AUTH_EXPIRED` from Bitrix → respond 401 with `WWW-Authenticate: Bearer error="invalid_token"`. `main()` runs `store.cleanup(Date.now())` at start and hourly.

- [ ] **Step 1: Write failing tests** (MCP SDK `Client` + `StreamableHTTPClientTransport` with a bearer header from the Task 6 flow helper): `tools list over HTTP` (35 tools); `call_summaries over HTTP uses the user's token` (fake portal sees `auth` of that grant); `two grants in parallel` (two users, parallel `b24_whoami` → each gets own user id; fake portal saw each token only with its own requests); `expired bitrix token is refreshed`; `revoked bitrix refresh token` → 401 and grant deleted; `deactivated user loses access at next refresh`; `user added to READ_ONLY_DEPARTMENTS parent becomes read-only at next refresh`; `restart keeps grant` (close app, `createApp` again on the same `DATA_DIR`, same bearer works); `no bearer → 401 with resource metadata link`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Commit** `feat: /mcp endpoint with per-user Bitrix clients`.

### Task 8: Container, docs, version

**Files:**
- Create: `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `.env.example`, `docs/deploy-synology.md`
- Modify: `README.md`, `package.json` (scripts `start:http`, version `1.2.0`), `manifest.json` / `server/tools.js` VERSION `1.2.0`, `.mcpbignore` (exclude the new files and `docs/`)

- [ ] **Step 1: Dockerfile:** `node:24-alpine`, `npm ci --omit=dev`, copy `server/`, user `node`, `ENV DATA_DIR=/data PORT=3000`, `CMD ["node","server/http.js"]`, `HEALTHCHECK` on `/.well-known/oauth-authorization-server`. Compose: port `127.0.0.1:3000:3000`, volume `./data:/data`, `env_file: .env`, `restart: unless-stopped`.
- [ ] **Step 2: Verify:** `docker build -t bitrix24-mcp .` succeeds; `docker run --rm -e …(test values) -p 3000:3000 bitrix24-mcp` and `curl -s localhost:3000/.well-known/oauth-authorization-server` returns JSON with `issuer` = `PUBLIC_URL`.
- [ ] **Step 3: `docs/deploy-synology.md`:** portal app creation (labels confirmed in Task 1), `SECRET_KEY` generation (`openssl rand -base64 32`), Container Manager project from the repo, DSM certificate with subdomains, reverse proxy `mcp.example.synology.me:443 → localhost:3000`, connecting from claude.ai (Settings → Connectors → Add custom connector → `https://mcp.example.synology.me/mcp`) and from Claude Code (`claude mcp add --transport http bitrix24 https://mcp.example.synology.me/mcp`), updating the container, read-only lists. README links to it.
- [ ] **Step 4: Run** `npm test`, `npm run pack` (bundle must not contain `server/http.js` deps issue: stdio entry still starts; bundle file list contains no `Dockerfile`/`docs`).
- [ ] **Step 5: Commit** `feat: Docker deployment and Synology guide; version 1.2.0`.

### Task 9: Deploy and live check (with the owner)

- [ ] **Step 1:** Owner creates `.env` on the NAS (client id/secret, `SECRET_KEY`), starts the project, sets certificate and reverse proxy per the guide. Confirm `https://mcp.example.synology.me/.well-known/oauth-authorization-server` from outside.
- [ ] **Step 2:** Owner connects from claude.ai; check consent page, `b24_whoami`, `call_summaries` (expect the 26 overviews since 2026-09-08), `chat_messages`.
- [ ] **Step 3:** Connect from Claude Code; second account if available (or owner with read-only checkbox) to see read-only enforced.
- [ ] **Step 4:** Release `v1.2.0` with the `.mcpb` and push after owner approval.
