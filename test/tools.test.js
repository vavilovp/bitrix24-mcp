import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools, SERVER_INSTRUCTIONS, serverInstructions, VERSION } from "../server/tools.js";

async function connect(ctx) {
  const server = new McpServer({ name: "bitrix24", version: VERSION }, { instructions: SERVER_INSTRUCTIONS });
  registerTools(server, { client: () => ({ origin: "https://example.test" }), mode: "stdio", ...ctx });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

test("registerTools exposes the same tools in both modes", async () => {
  const stdio = await connect({ readOnly: false, mode: "stdio" });
  const http = await connect({ readOnly: false, mode: "http" });
  const s = (await stdio.listTools()).tools;
  const h = (await http.listTools()).tools;
  assert.equal(s.length, 35);
  assert.deepEqual(h.map((t) => t.name), s.map((t) => t.name));
  assert.equal(s.find((t) => t.name === "b24_call").annotations.readOnlyHint, false);
});

test("readOnly ctx disables write tools", async () => {
  const c = await connect({ readOnly: true });
  const r = await c.callTool({ name: "task_create", arguments: { title: "x", responsible_id: 1 } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /read-only/);
  const tools = (await c.listTools()).tools;
  assert.equal(tools.find((t) => t.name === "b24_call").annotations.readOnlyHint, true);
});

function stubCtx(handlers, extra = {}) {
  const calls = [];
  const client = () => ({
    origin: "https://example.test",
    call: async (m, p) => { calls.push(m); return handlers[m]?.(p) ?? { result: [] }; },
    result: async (m, p) => { calls.push(m); return (await (handlers[m]?.(p) ?? { result: [] })).result; },
  });
  return { ctx: { client, readOnly: false, mode: "http", ...extra }, calls };
}
async function connectStub(ctx) {
  const server = new McpServer({ name: "bitrix24", version: VERSION }, { instructions: SERVER_INSTRUCTIONS });
  registerTools(server, ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

test("http mode blocks app methods in b24_call", async () => {
  const { ctx, calls } = stubCtx({});
  const c = await connectStub(ctx);
  const r = await c.callTool({ name: "b24_call", arguments: { method: "Event.Bind", params: {} } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Event\.Bind/);
  assert.equal(calls.length, 0);
  const ok = await c.callTool({ name: "b24_call", arguments: { method: "crm.deal.userfield.list" } });
  assert.notEqual(ok.isError, true);
});

test("stdio mode does not block app methods", async () => {
  const { ctx, calls } = stubCtx({}, { mode: "stdio" });
  const c = await connectStub(ctx);
  const r = await c.callTool({ name: "b24_call", arguments: { method: "event.get" } });
  assert.notEqual(r.isError, true);
  assert.deepEqual(calls, ["event.get"]);
});

test("http mode scrubs tokens", async () => {
  const items = [{ ID: 1, NAME: "a.pdf", DETAIL_URL: "https://example.test/d/1?auth=SECRET&x=1", DOWNLOAD_URL: "https://example.test/dl?auth=SECRET" }];
  const { ctx } = stubCtx({ "disk.folder.getChildren": () => ({ result: items }) });
  const c = await connectStub(ctx);
  const r = await c.callTool({ name: "disk_list", arguments: { folder_id: 1 } });
  const t1 = r.content[0].text;
  assert.ok(!t1.includes("SECRET"), t1);
  assert.ok(t1.includes("x=1"));
  const r2 = await c.callTool({ name: "b24_call", arguments: { method: "disk.folder.getChildren", params: {} } });
  assert.ok(!r2.content[0].text.includes("SECRET"));
  assert.ok(!r2.content[0].text.includes("example.test/dl"));
  assert.match(r2.content[0].text, /\[removed\]/);
});

test("http disk_file does not write files", async () => {
  const { mkdtemp, readdir, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(os.tmpdir(), "dl-"));
  const f = { ID: 9, NAME: "r.pdf", SIZE: 100, DOWNLOAD_URL: "https://example.test/dl?auth=SECRET", DETAIL_URL: "https://example.test/d/9?auth=SECRET" };
  const { ctx } = stubCtx({ "disk.file.get": () => ({ result: f }) }, { downloadDir: dir });
  const c = await connectStub(ctx);
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => { fetched++; throw new Error("no fetch"); };
  try {
  const tools = (await c.listTools()).tools;
  assert.ok(!/undefined|local folder/.test(tools.find((t) => t.name === "disk_file").description));
  const r = await c.callTool({ name: "disk_file", arguments: { id: 9 } });
  const text = r.content[0].text;
  assert.match(text, /DETAIL_URL/);
  assert.ok(!text.includes("saved_to"));
  assert.ok(!text.includes("SECRET"));
  assert.deepEqual(await readdir(dir), []);
  assert.equal(fetched, 0);
  } finally { globalThis.fetch = realFetch; }
  await rm(dir, { recursive: true });
});

test("http mode inspects batch commands", async () => {
  const { ctx, calls } = stubCtx({});
  const c = await connectStub(ctx);
  let r = await c.callTool({ name: "b24_call", arguments: { method: "batch", params: { cmd: { a: "crm.deal.list", b: "event.bind?x=1" } } } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /event\.bind/);
  r = await c.callTool({ name: "b24_call", arguments: { method: "batch", params: { cmd: ["crm.deal.list", " APP.option.set.json?x=1"] } } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /APP\.option\.set/);
  assert.equal(calls.length, 0);
  r = await c.callTool({ name: "b24_call", arguments: { method: "event.bind.json" } });
  assert.equal(r.isError, true);
  assert.equal(calls.length, 0);
  r = await c.callTool({ name: "b24_call", arguments: { method: "batch", params: { cmd: { a: "crm.deal.list" } } } });
  assert.notEqual(r.isError, true);
  assert.deepEqual(calls, ["batch"]);
});

test("read-only b24_call: reads pass, write methods under recent/counters/history are refused", async () => {
  const { ctx, calls } = stubCtx({}, { readOnly: true });
  const c = await connectStub(ctx);
  for (const method of ["im.recent.get", "im.recent.list", "tasks.task.counters.get", "tasks.task.history.list", "crm.deal.list", "user.current", "tasks.task.get", "im.counters.get", "crm.lead.fields", "disk.folder.getchildren", "im.recent"]) {
    const r = await c.callTool({ name: "b24_call", arguments: { method } });
    assert.ok(!r.isError, `${method} should be allowed: ${r.content[0].text}`);
  }
  const allowed = calls.length;
  for (const method of ["im.recent.pin", "im.recent.hide", "im.recent.unread", "im.counters.reset", "tasks.task.history.clear", "crm.deal.update", "im.message.add"]) {
    const r = await c.callTool({ name: "b24_call", arguments: { method } });
    assert.equal(r.isError, true, `${method} must be refused`);
    assert.match(r.content[0].text, /Read-only mode/);
  }
  assert.equal(calls.length, allowed, "no refused method reached the portal");
});

test("server instructions are mode-aware", () => {
  assert.match(serverInstructions("stdio"), /webhook owner/);
  assert.equal(serverInstructions("stdio"), SERVER_INSTRUCTIONS);
  const h = serverInstructions("http");
  assert.match(h, /signed-in user/);
  assert.doesNotMatch(h, /webhook/i);
});

test("http mode b24_whoami description does not mention the webhook", async () => {
  const { ctx } = stubCtx({});
  const c = await connectStub(ctx);
  const w = (await c.listTools()).tools.find((x) => x.name === "b24_whoami");
  assert.doesNotMatch(w.description + (w.title || ""), /webhook/i);
});

test("http mode refuses malformed or nested batch in b24_call", async () => {
  const { ctx, calls } = stubCtx({});
  const c = await connectStub(ctx);
  for (const params of [
    { cmd: { a: "batch?cmd[b]=event.bind" } },
    { cmd: { a: 1 } },
    { cmd: "event.bind" },
    {},
    undefined,
    { cmd: { a: "/event.bind" } },
    { cmd: { a: "event%2Ebind" } },
  ]) {
    const r = await c.callTool({ name: "b24_call", arguments: { method: "batch", ...(params ? { params } : {}) } });
    assert.equal(r.isError, true, JSON.stringify(params));
    assert.match(r.content[0].text, /batch/i);
  }
  assert.equal(calls.length, 0);
  const r = await c.callTool({ name: "b24_call", arguments: { method: "batch", params: { cmd: { a: "crm.deal.list?filter[ID]=1", b: "user.get" } } } });
  assert.notEqual(r.isError, true);
  assert.deepEqual(calls, ["batch"]);
});

test("insufficient_scope hint is mode-specific", async () => {
  const { BitrixError } = await import("../server/bitrix.js");
  const scopeError = () => { throw new BitrixError("crm.deal.list", "insufficient_scope", "The request requires higher privileges"); };
  const http = await connectStub(stubCtx({ "crm.deal.list": scopeError }).ctx);
  const h = (await http.callTool({ name: "b24_call", arguments: { method: "crm.deal.list" } })).content[0].text;
  assert.match(h, /local application/);
  assert.match(h, /Разработчикам/);
  assert.doesNotMatch(h, /webhook/i);
  const stdio = await connectStub(stubCtx({ "crm.deal.list": scopeError }, { mode: "stdio" }).ctx);
  const s = (await stdio.callTool({ name: "b24_call", arguments: { method: "crm.deal.list" } })).content[0].text;
  assert.match(s, /\nThe webhook lacks the permission \(scope\) for this method\. Add it in the webhook settings on the portal\.$/);
});

// ---- tasks_list: limit and brief output ----
function fakeTasks(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: String(1000 + i), title: `Задача ${i}`, priority: i === 0 ? "2" : "1", status: "2", subStatus: "-1",
    deadline: "2026-12-01T17:00:00+03:00", createdDate: "2026-11-01T10:00:00+03:00", changedDate: "2026-11-10T10:00:00+03:00",
    responsibleId: "7", createdBy: "8", groupId: "5", parentId: "0", timeEstimate: "0", activityDate: "2026-11-10T10:00:00+03:00",
    ufTaskWebdavFiles: [], auditors: ["9"],
    group: { id: "5", name: "Проект", opened: true, membersCount: 3, image: "", additionalData: [] },
    creator: { id: "8", name: "Анна Смирнова", link: "/company/personal/user/8/", icon: "/i.png", workPosition: "" },
    responsible: { id: "7", name: "Иван Петров", link: "/company/personal/user/7/", icon: "/i.png", workPosition: "" },
    auditorsData: { 9: { id: "9", name: "Олег Сидоров", link: "/u/9/", icon: "/i.png" } },
    tags: { 1: { id: 1, title: "ERP" }, 2: { id: 2, title: "отчёты" } },
    description: "Длинное описание",
  }));
}

test("tasks_list: brief by default, limit 20, next continues after the slice", async () => {
  const seen = [];
  const { ctx } = stubCtx({ "tasks.task.list": (p) => { seen.push(p); return { result: { tasks: fakeTasks(50) }, next: 50, total: 106 }; } });
  const c = await connectStub(ctx);
  const r = await c.callTool({ name: "tasks_list", arguments: {} });
  const j = JSON.parse(r.content[0].text);
  assert.equal(j.items.length, 20);
  assert.equal(j.next, 20);
  assert.equal(j.total, 106);
  assert.deepEqual(j.items[0], {
    id: "1000", title: "Задача 0", status: "waiting", priority: "high", deadline: "2026-12-01T17:00:00+03:00",
    responsible: "Иван Петров", creator: "Анна Смирнова", group: "Проект", tags: ["ERP", "отчёты"], changed: "2026-11-10T10:00:00+03:00",
  });
  assert.equal(j.items[1].priority, undefined, "normal priority is omitted");
  assert.ok(r.content[0].text.length < 6000, `brief page of 20 stays small (${r.content[0].text.length} chars)`);
  assert.equal(seen[0].start, undefined);
});

test("tasks_list: explicit limit and start; last page keeps Bitrix next", async () => {
  const { ctx } = stubCtx({ "tasks.task.list": (p) => ({ result: { tasks: fakeTasks(6) }, total: 106, ...(p.start === 100 ? {} : { next: p.start + 50 }) }) });
  const c = await connectStub(ctx);
  const page = JSON.parse((await c.callTool({ name: "tasks_list", arguments: { limit: 5, start: 40 } })).content[0].text);
  assert.equal(page.items.length, 5);
  assert.equal(page.next, 45);
  const last = JSON.parse((await c.callTool({ name: "tasks_list", arguments: { limit: 10, start: 100 } })).content[0].text);
  assert.equal(last.items.length, 6);
  assert.equal(last.next, undefined);
});

test("tasks_list: detail full keeps the previous compact shape", async () => {
  const { ctx } = stubCtx({ "tasks.task.list": () => ({ result: { tasks: fakeTasks(3) } }) });
  const c = await connectStub(ctx);
  const j = JSON.parse((await c.callTool({ name: "tasks_list", arguments: { detail: "full" } })).content[0].text);
  assert.equal(j.items.length, 3);
  assert.deepEqual(j.items[0].responsible, { id: "7", name: "Иван Петров" });
  assert.equal(j.items[0].statusName, "waiting");
  assert.ok(j.items[0].auditorsData);
});

test("tasks_list: with_description adds the text in brief mode", async () => {
  const { ctx } = stubCtx({ "tasks.task.list": () => ({ result: { tasks: fakeTasks(1) } }) });
  const c = await connectStub(ctx);
  const j = JSON.parse((await c.callTool({ name: "tasks_list", arguments: { with_description: true } })).content[0].text);
  assert.equal(j.items[0].description, "Длинное описание");
});
