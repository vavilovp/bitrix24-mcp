import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools, SERVER_INSTRUCTIONS, VERSION } from "../server/tools.js";

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
