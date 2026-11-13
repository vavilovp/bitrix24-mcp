import { test } from "node:test";
import assert from "node:assert/strict";
import { isEligible, departmentAncestors, effectiveReadOnly, isBlockedAppMethod, scrubOutput, loadDepartmentTree } from "../server/policy.js";

test("eligible employee / inactive / extranet", () => {
  assert.equal(isEligible({ ACTIVE: true, USER_TYPE: "employee" }), true);
  assert.equal(isEligible({ ACTIVE: true, UF_DEPARTMENT: [3] }), true);
  assert.equal(isEligible({ ACTIVE: false, USER_TYPE: "employee" }), false);
  assert.equal(isEligible({ ACTIVE: true, USER_TYPE: "extranet" }), false);
  assert.equal(isEligible({ ACTIVE: true, UF_DEPARTMENT: [] }), false);
  assert.equal(isEligible({ ACTIVE: true }), false);
});

const tree = new Map([[1, null], [7, 1], [12, 7], [20, 1]]);

test("departmentAncestors includes parents", () => {
  assert.deepEqual([...departmentAncestors([12], tree)].sort((a, b) => a - b), [1, 7, 12]);
});

test("sub-department is forced read-only", () => {
  const r = effectiveReadOnly({ global: false, choice: false, userId: 5, departments: [12], roUsers: new Set(), roDepts: new Set([7]), tree });
  assert.deepEqual(r, { readOnly: true, forced: true });
});

test("choice alone is not forced", () => {
  const base = { global: false, userId: 5, departments: [20], roUsers: new Set(), roDepts: new Set([7]), tree };
  assert.deepEqual(effectiveReadOnly({ ...base, choice: true }), { readOnly: true, forced: false });
  assert.deepEqual(effectiveReadOnly({ ...base, choice: false }), { readOnly: false, forced: false });
  assert.deepEqual(effectiveReadOnly({ ...base, global: true }), { readOnly: true, forced: true });
  assert.deepEqual(effectiveReadOnly({ ...base, roUsers: new Set([5]) }), { readOnly: true, forced: true });
});

test("blocked methods", () => {
  for (const m of ["event.bind", "PLACEMENT.bind", "app.option.set", "imbot.register", "bizproc.robot.add", "sale.paysystem.handler.add"]) assert.equal(isBlockedAppMethod(m), true, m);
  for (const m of ["crm.deal.list", "crm.deal.userfield.list", "user.current", "events.x"]) assert.equal(isBlockedAppMethod(m), false, m);
});

test("scrubOutput", () => {
  const s = scrubOutput("see https://p/x?auth=SECRET&a=1 and https://p/y?a=1&access_token=TOK2");
  assert.ok(!s.includes("SECRET") && !s.includes("TOK2"));
  assert.ok(s.includes("a=1"));
  const j = scrubOutput('{"DOWNLOAD_URL":"https://p/d?auth=Z","NAME":"f"}');
  assert.equal(j.includes("Z"), false);
  assert.ok(j.includes('"DOWNLOAD_URL":"[removed]"'));
  assert.ok(scrubOutput('"DOWNLOAD_URL": "https://p/d"').includes("[removed]"));
});

test("loadDepartmentTree pages", async () => {
  const pages = [{ result: [{ ID: "1" }, { ID: "7", PARENT: "1" }], next: 50 }, { result: [{ ID: "12", PARENT: "7" }] }];
  let i = 0;
  const t = await loadDepartmentTree({ call: async () => pages[i++] });
  assert.deepEqual([...t], [[1, null], [7, 1], [12, 7]]);
});

test("scrubOutput leaves unrelated text byte-identical", () => {
  for (const t of ["Is this ok? yes. Why?", "a=1&b=2 and x?y=1&z=2", "authority", '{"author":"X","authors":"Y"}', "https://p/x?author=1&a=2"]) {
    assert.equal(scrubOutput(t), t);
  }
});

test("scrubOutput tidies separators only where a parameter was removed", () => {
  assert.equal(scrubOutput("https://p/x?auth=S"), "https://p/x");
  assert.equal(scrubOutput("https://p/x?auth=S&a=1"), "https://p/x?a=1");
  assert.equal(scrubOutput("https://p/x?a=1&auth=S"), "https://p/x?a=1");
  assert.equal(scrubOutput("https://p/x?a=1&auth=S&b=2"), "https://p/x?a=1&b=2");
  assert.equal(scrubOutput("https://p/x?a=1&access_token=S&auth=T"), "https://p/x?a=1");
});

test("scrubOutput removes JSON token keys and encoded params", () => {
  assert.equal(scrubOutput('{"access_token":"AAA","n":1}'), '{"access_token":"[removed]","n":1}');
  assert.equal(scrubOutput('{"refresh_token": "BBB"}'), '{"refresh_token": "[removed]"}');
  assert.equal(scrubOutput('{"auth":"CCC","author":"X"}'), '{"auth":"[removed]","author":"X"}');
  assert.equal(scrubOutput("https://p/x%3Fauth%3DSEC%26a%3D1"), "https://p/x%3Fa%3D1");
  assert.equal(scrubOutput("https://p/x%3Fa%3D1%26auth%3DSEC"), "https://p/x%3Fa%3D1");
  assert.equal(scrubOutput("https://p/x%3Fauth%3DSEC"), "https://p/x");
  assert.ok(!scrubOutput('{"u":"https://p/?x=1\\u0026auth=SEC"}').includes("SEC"));
});

test("batch inspection helpers", async () => {
  const { blockedInBatch, isBlockedAppMethod: b } = await import("../server/policy.js");
  assert.equal(blockedInBatch({ cmd: { a: "crm.deal.list", b: "event.bind?x=1" } }), "event.bind");
  assert.equal(blockedInBatch({ cmd: [" APP.option.set.json?x=1"] }), "APP.option.set");
  assert.equal(blockedInBatch({ cmd: { a: "crm.deal.list" } }), null);
  assert.equal(b("event.bind.json"), true);
});

test("batch inspection fails closed", async () => {
  const { blockedInBatch } = await import("../server/policy.js");
  const refused = [
    { cmd: { a: "crm.deal.list", b: "batch?cmd[b]=event.bind" } }, // nested batch
    { cmd: { a: "BATCH.json?halt=0" } },
    { cmd: { a: 42 } }, // non-string command
    { cmd: { a: { method: "event.bind" } } },
    { cmd: ["crm.deal.list", null] },
    { cmd: "event.bind" }, // cmd as a string
    {}, // cmd missing
    undefined,
    { cmd: null },
    { cmd: { a: "/event.bind" } }, // leading slash
    { cmd: { a: "/rest/event.bind.json" } },
    { cmd: { a: "event%2Ebind" } }, // percent-encoding
    { cmd: { a: "crm.deal%2elist" } },
    { cmd: { a: "" } },
    { cmd: { a: "event .bind" } },
    { cmd: { a: "../event.bind" } },
  ];
  for (const params of refused) assert.notEqual(blockedInBatch(params), null, JSON.stringify(params));
  assert.equal(blockedInBatch({ cmd: { a: "crm.deal.list", b: "tasks.task.get?taskId=1&select[]=ID" } }), null);
  assert.equal(blockedInBatch({ cmd: ["user.get?ID=1", " crm.deal.get.json?id=2"] }), null);
  assert.equal(blockedInBatch({ cmd: { a: "crm.deal.list" }, halt: 0 }), null);
});
