#!/usr/bin/env node
// Bitrix24 MCP server (on-premise or cloud) over an incoming webhook, stdio transport.
// Covers: tasks, projects/workgroups, chats (read), Drive, calendar, users, CRM,
// plus a generic REST call for everything else.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { homedir } from "node:os";
import path from "node:path";
import { Bitrix } from "./bitrix.js";
import { registerTools, SERVER_INSTRUCTIONS, VERSION } from "./tools.js";

// Unfilled placeholders from the extension manifest arrive as literal "${...}" — treat them as empty.
const env = (k) => { const v = (process.env[k] || "").trim(); return v.startsWith("${") ? "" : v; };
const READ_ONLY = /^(1|true|yes|y)$/i.test(env("BITRIX_READ_ONLY"));
const DOWNLOAD_DIR = env("BITRIX_DOWNLOAD_DIR") || path.join(homedir(), "Downloads", "Bitrix24");

let b24;
function client() {
  if (!b24) b24 = new Bitrix(env("BITRIX_WEBHOOK_URL"));
  return b24;
}

const server = new McpServer({ name: "bitrix24", version: VERSION }, { instructions: SERVER_INSTRUCTIONS });
registerTools(server, { client, readOnly: READ_ONLY, mode: "stdio", downloadDir: DOWNLOAD_DIR });

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`bitrix24-mcp ${VERSION} started${READ_ONLY ? " (read-only)" : ""}\n`);
