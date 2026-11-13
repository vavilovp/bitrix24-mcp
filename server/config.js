// HTTP-mode configuration from the environment. Do not import from the stdio entry points.
import { loadKey } from "./crypto.js";

const DEFAULT_KNOWN_HOSTS = "claude.ai,claude.com,localhost,127.0.0.1";
const DEFAULT_TOKEN_URL = "https://oauth.bitrix.info/oauth/token/";

function required(env, name) {
  const v = String(env[name] ?? "").trim();
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function httpUrl(name, value) {
  let u;
  try {
    u = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`${name} must be an http(s) URL`);
  return u;
}

const list = (v) => String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const idSet = (v) => new Set(list(v).map(Number).filter((n) => Number.isInteger(n) && n > 0));
const bool = (v) => /^(1|true|yes|on)$/i.test(String(v ?? "").trim());

/**
 * Config: { publicUrl, portal (origin), clientId, oauthTokenUrl, memberId|null, readOnly, roUsers:Set<number>,
 * roDepts:Set<number>, knownClientHosts:Set<string>, dataDir, port } plus non-enumerable clientSecret and
 * secretKey (Buffer) so that logging or serialising the config never prints them.
 */
export function loadConfig(env = process.env) {
  const publicUrl = httpUrl("PUBLIC_URL", required(env, "PUBLIC_URL"));
  const portal = httpUrl("B24_PORTAL", required(env, "B24_PORTAL"));
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
    readOnly: bool(env.READ_ONLY),
    roUsers: idSet(env.READ_ONLY_USERS),
    roDepts: idSet(env.READ_ONLY_DEPARTMENTS),
    knownClientHosts: new Set(list(env.KNOWN_CLIENT_HOSTS ?? DEFAULT_KNOWN_HOSTS).map((h) => h.toLowerCase())),
    dataDir: String(env.DATA_DIR || "/data"),
    port,
  };
  Object.defineProperty(config, "clientSecret", { value: clientSecret, enumerable: false });
  Object.defineProperty(config, "secretKey", { value: secretKey, enumerable: false });
  return config;
}
