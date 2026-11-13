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
