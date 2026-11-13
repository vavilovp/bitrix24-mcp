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

export function isBlockedAppMethod(method) {
  const m = String(method).toLowerCase();
  return BLOCKED_PREFIXES.some((p) => m.startsWith(p));
}

export function scrubOutput(text) {
  return String(text)
    .replace(/([?&;]|\\u0026)(auth|access_token)=[^&"'\s\\<>]*/gi, (m, sep) => (sep === "?" ? "?" : ""))
    .replace(/"DOWNLOAD_URL"(\s*:\s*)"(?:[^"\\]|\\.)*"/g, '"DOWNLOAD_URL"$1"[removed]"')
    .replace(/\?(&|(?=["'\s\\<>]|$))/g, (m, a) => (a === "&" ? "?" : ""));
}
