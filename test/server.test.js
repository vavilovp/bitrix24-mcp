// End-to-end: run the MCP server against a local fake Bitrix24 REST endpoint.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const overview = JSON.parse(readFileSync(new URL("./fixtures/ai-overview.json", import.meta.url), "utf8"));
const overviewUpper = structuredClone(overview);
overviewUpper.params.COMPONENT_PARAMS = { MESSAGE_TYPE: "AI_OVERVIEW", CALL_ID: 77 };
const aiStart = { id: 1000050, author_id: 0, date: "2026-11-02T11:28:17+03:00", text: "BitrixGPT анализирует звонок №77", params: { COMPONENT_PARAMS: { messageType: "AI_START", callId: 77 } } };

const calls = [];
const routes = {
  "im.recent.get": () => [
    { id: "chat555", chat_id: 555, type: "chat", title: "Отчёты", message: { date: "2026-11-02T12:04:43+03:00" } },
    { id: "chat556", chat_id: 556, type: "chat", title: "Старый чат", message: { date: "2020-01-01T10:00:00+03:00" } },
  ],
  "im.dialog.messages.search": (p) => ({ messages: p.CHAT_ID === 555 ? [overview, aiStart] : [] }),
  "im.dialog.messages.get": () => ({
    chat_id: 555,
    users: [{ id: 1, name: "Иван Петров" }],
    messages: [
      overviewUpper,
      { id: 1000200, author_id: 1, date: "2026-11-02T12:10:00+03:00", text: "Создана заявка", params: { ATTACH: [{ BLOCKS: [{ GRID: [{ NAME: "Статус", VALUE: "Новая" }] }] }] } },
      { id: 1000201, author_id: 1, date: "2026-11-02T12:11:00+03:00", text: "[b]Привет[/b]" },
    ],
  }),
};

let srv, client;

before(async () => {
  srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d)).on("end", () => {
      const method = req.url.match(/\/rest\/1\/secret\/(.+)\.json$/)?.[1];
      const params = body ? JSON.parse(body) : {};
      calls.push({ method, params });
      const route = routes[method];
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(route ? { result: route(params) } : { error: "ERROR_METHOD_NOT_FOUND", error_description: method }));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../server/index.js", import.meta.url))],
    env: { ...process.env, BITRIX_WEBHOOK_URL: `http://127.0.0.1:${srv.address().port}/rest/1/secret/` },
    stderr: "ignore",
  });
  client = new Client({ name: "test", version: "1" });
  await client.connect(transport);
});

after(async () => {
  await client?.close();
  srv?.close();
});

const callTool = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  assert.ok(!r.isError, r.content?.[0]?.text);
  return JSON.parse(r.content[0].text);
};

test("call_summaries finds overviews by query in recent chats", async () => {
  calls.length = 0;
  const r = await callTool("call_summaries", { query: "отход партий", date_from: "2026-10-01" });
  assert.equal(r.total_found, 1);
  assert.equal(r.chats_scanned, 1, "chat with last message before date_from is skipped");
  const [o] = r.items;
  assert.equal(o.chat_id, 555);
  assert.equal(o.chat_title, "Отчёты");
  assert.equal(o.dialog_id, "chat555");
  assert.equal(o.message_id, 1000123);
  assert.equal(o.title, "Планирование отчёта по отходам производства");
  assert.match(o.decisions, /по данным партий/);
  assert.match(o.tasks, /подготовить ТЗ/);
  assert.match(o.details_url, /^http:\/\/127\.0\.0\.1:\d+\/call\/detail\/77$/);
  assert.equal(o.analysis, undefined);
  const search = calls.filter((c) => c.method === "im.dialog.messages.search");
  assert.deepEqual(search.map((c) => c.params.CHAT_ID), [555]);
  assert.equal(search[0].params.SEARCH_MESSAGE, "BitrixGPT");
  assert.equal(search[0].params.DATE_FROM, "2026-10-01");
});

test("call_summaries: non-matching query and explicit chat_ids", async () => {
  const none = await callTool("call_summaries", { query: "бухгалтерия", chat_ids: ["chat555"], date_from: "2026-10-01" });
  assert.equal(none.total_found, 0);
  const full = await callTool("call_summaries", { chat_ids: [555], date_from: "2026-10-01", detail: "full" });
  assert.equal(full.total_found, 1);
  assert.match(full.items[0].analysis, /ламинатор/);
});

test("chat_messages expands overviews and attachments", async () => {
  const r = await callTool("chat_messages", { dialog_id: "chat555" });
  const [ov, card, plain] = r.messages;
  assert.equal(ov.overview.type, "AI_OVERVIEW");
  assert.equal(ov.overview.call_id, 77);
  assert.match(ov.overview.decisions, /Сдать первую версию/);
  assert.equal(ov.attach, undefined);
  assert.equal(card.attach, "Статус: Новая");
  assert.equal(card.author, "Иван Петров");
  assert.equal(plain.text, "Привет");
  assert.equal(plain.attach, undefined);
});

test("chat_search passes overview_detail through", async () => {
  const r = await callTool("chat_search", { chat_id: 555, query: "BitrixGPT", overview_detail: "full" });
  assert.match(r.messages[0].overview.agenda, /структуру отчёта/);
  assert.equal(r.messages[1].type, "AI_START");
});
