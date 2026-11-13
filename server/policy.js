// Pure access-policy helpers for HTTP mode. Must stay free of node:sqlite / express /
// HTTP-mode imports: server/tools.js imports it and the stdio bundle runs on Node >= 18.

export function isEligible(user) {
  if (!user || user.ACTIVE !== true && user.ACTIVE !== "Y" && user.ACTIVE !== "true") return false;
  if (user.USER_TYPE) return user.USER_TYPE === "employee";
  return Array.isArray(user.UF_DEPARTMENT) && user.UF_DEPARTMENT.length > 0;
}

export function departmentAncestors(deptIds, tree) {
  const out = new Set();
  for (const start of deptIds || []) {
    let cur = Number(start);
    while (Number.isFinite(cur) && !out.has(cur)) {
      out.add(cur);
      const p = tree.get(cur);
      if (p === null || p === undefined) break;
      cur = p;
    }
  }
  return out;
}

export async function loadDepartmentTree(client) {
  const tree = new Map();
  let start = 0;
  for (let page = 0; page < 200; page++) {
    const data = await client.call("department.get", start ? { start } : {});
    for (const d of data.result || []) {
      const parent = Number(d.PARENT);
      tree.set(Number(d.ID), d.PARENT && parent ? parent : null);
    }
    if (data.next === undefined || data.next === null) break;
    start = data.next;
  }
  return tree;
}

export function effectiveReadOnly({ global, choice, userId, departments, roUsers, roDepts, tree }) {
  let forced = !!global || roUsers.has(Number(userId));
  if (!forced) {
    for (const d of departmentAncestors(departments, tree)) {
      if (roDepts.has(d)) { forced = true; break; }
    }
  }
  return { readOnly: forced || !!choice, forced };
}

const BLOCKED_PREFIXES = [
  "event.", "placement.", "app.", "imbot.", "imconnector.", "userfieldtype.",
  "bizproc.activity.", "bizproc.robot.", "user.option.", "entity.", "feature.",
  "messageservice.", "pay_system.", "sale.paysystem.handler.",
];

export function normalizeMethod(method) {
  return String(method).split("?")[0].trim().replace(/\.json$/i, "").trim();
}

/** Blocked method found in a `batch` params.cmd (object or array of "method?query" strings), or null. */
export function blockedInBatch(params) {
  const cmd = params?.cmd;
  if (!cmd || typeof cmd !== "object") return null;
  for (const c of Array.isArray(cmd) ? cmd : Object.values(cmd)) {
    if (typeof c !== "string") continue;
    const m = normalizeMethod(c);
    if (isBlockedAppMethod(m)) return m;
  }
  return null;
}

export function isBlockedAppMethod(method) {
  const m = normalizeMethod(method).toLowerCase();
  return BLOCKED_PREFIXES.some((p) => m.startsWith(p));
}

// Tokens never reach tool output. URL parameters (plain or URL-encoded) are dropped together with
// the separator that belonged to them: `?auth=S` -> `` (no dangling `?`), `?auth=S&a=1` -> `?a=1`,
// `x&auth=S` -> `x`. JSON string values under token keys become "[removed]". Other text is untouched.
const VAL = String.raw`(?:(?!%26)[^&"'\s\\<>])*`;
const NAME = String.raw`(?:auth|access_token|refresh_token)(?:=|%3D)`;
// "?"-led parameter also swallows the following "&" (which then becomes the "?"); "&"-led one does not.
const TOKEN_PARAM = new RegExp(String.raw`(\?|%3F)${NAME}${VAL}(&|%26|\\u0026)?|(&|;|%26|\\u0026)${NAME}${VAL}`, "gi");
const TOKEN_KEY = /(\\?")(access_token|refresh_token|auth)\1(\s*:\s*)\\?"(?:[^"\\]|\\.)*?\\?"/gi;

export function scrubOutput(text) {
  let out = String(text);
  for (let prev = null; prev !== out;) { // repeat: "?auth=A&access_token=B&x=1" needs two passes
    prev = out;
    out = out.replace(TOKEN_PARAM, (m, q, next) => (q && next ? q : ""));
  }
  return out
    .replace(TOKEN_KEY, (m, q, key, colon) => `${q}${key}${q}${colon}${q}[removed]${q}`)
    .replace(/"DOWNLOAD_URL"(\s*:\s*)"(?:[^"\\]|\\.)*"/g, '"DOWNLOAD_URL"$1"[removed]"');
}
