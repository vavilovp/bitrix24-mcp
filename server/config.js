// HTTP-mode configuration from the environment. Do not import from the stdio entry points.
import { loadKey } from "./crypto.js";

const DEFAULT_KNOWN_HOSTS = "claude.ai,claude.com,localhost,127.0.0.1";
const DEFAULT_TOKEN_URL = "https://oauth.bitrix.info/oauth/token/";

function required(env, name) {
  const v = String(env[name] ?? "").trim();
  if (!v) throw new Error(`${name} is required`);
  return v;
}

/**
 * http(s) URL with a host. A bare host ("portal.example.com", "portal.example.com:8443/") gets "https://";
 * any other scheme ("ftp://", "mailto:", "javascript:") and URLs with credentials are refused.
 */
function httpUrl(name, value, { bareHost = false } = {}) {
  let v = String(value).trim();
  if (bareHost && !/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) {
    // "scheme:..." without "//" is not a host (a host may only be followed by ":<port>").
    if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(v)) throw new Error(`${name} must be an http(s) URL, e.g. https://host.example.com`);
    v = `https://${v}`;
  }
  let u;
  try {
    u = new URL(v);
  } catch {
    throw new Error(`${name} must be an absolute URL, e.g. https://host.example.com`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`${name} must be an http(s) URL`);
  if (!u.hostname || u.username || u.password) throw new Error(`${name} must be an http(s) URL with a host and no credentials`);
  return u;
}

const list = (v) => String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/** Comma-separated positive integer ids. Anything else is a config error: a typo must not drop a restriction. */
function idSet(name, v) {
  const raw = String(v ?? "").trim();
  if (!raw) return new Set();
  const out = new Set();
  for (const part of raw.split(",")) {
    const s = part.trim();
    if (!/^[1-9][0-9]*$/.test(s) || !Number.isSafeInteger(Number(s))) {
      throw new Error(`${name} must be a comma-separated list of positive integer ids (got ${JSON.stringify(s.slice(0, 40))}); put comments on their own line`);
    }
    out.add(Number(s));
  }
  return out;
}

function bool(name, v) {
  const s = String(v ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["", "0", "false", "no", "n", "off"].includes(s)) return false;
  throw new Error(`${name} must be one of 1/true/yes/y/on or 0/false/no/n/off`);
}

/**
 * Config: { publicUrl, portal (origin), clientId, oauthTokenUrl, memberId|null, readOnly, roUsers:Set<number>,
 * roDepts:Set<number>, knownClientHosts:Set<string>, dataDir, port } plus non-enumerable clientSecret and
 * secretKey (Buffer) so that logging or serialising the config never prints them.
 */
export function loadConfig(env = process.env) {
  const publicUrl = httpUrl("PUBLIC_URL", required(env, "PUBLIC_URL"), { bareHost: true });
  const portal = httpUrl("B24_PORTAL", required(env, "B24_PORTAL"), { bareHost: true });
  const clientId = required(env, "B24_CLIENT_ID");
  const clientSecret = required(env, "B24_CLIENT_SECRET");
  const secretKey = loadKey(required(env, "SECRET_KEY"));
  const tokenUrl = httpUrl("B24_OAUTH_TOKEN_URL", String(env.B24_OAUTH_TOKEN_URL || DEFAULT_TOKEN_URL).trim());
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT must be a port number");

  const config = {
    publicUrl: publicUrl.href.replace(/\/+$/, ""),
    portal: portal.origin,
    clientId,
    oauthTokenUrl: tokenUrl.href,
    memberId: String(env.B24_MEMBER_ID ?? "").trim() || null,
    readOnly: bool("READ_ONLY", env.READ_ONLY),
    roUsers: idSet("READ_ONLY_USERS", env.READ_ONLY_USERS),
    roDepts: idSet("READ_ONLY_DEPARTMENTS", env.READ_ONLY_DEPARTMENTS),
    knownClientHosts: new Set(list(env.KNOWN_CLIENT_HOSTS ?? DEFAULT_KNOWN_HOSTS).map((h) => h.toLowerCase())),
    dataDir: String(env.DATA_DIR || "/data"),
    port,
  };
  Object.defineProperty(config, "clientSecret", { value: clientSecret, enumerable: false });
  Object.defineProperty(config, "secretKey", { value: secretKey, enumerable: false });
  return config;
}
