// Tool registration shared by the stdio entry (server/index.js) and the HTTP mode.
// Must stay free of node:sqlite / express / HTTP-mode imports (the stdio bundle runs on Node >= 18).
import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { BitrixError } from "./bitrix.js";
import { extractOffice } from "./office.js";
import { isBlockedAppMethod, scrubOutput } from "./policy.js";
import { stripBB, attachText, messageType, isAiOverview, parseOverview, overviewSearchText, matchesQuery } from "./attach.js";

export const VERSION = "1.1.2";
const MAX_OUTPUT = 80000;

export const SERVER_INSTRUCTIONS =
  "Tools for a Bitrix24 portal (works with on-premise 'box' installs) via an incoming webhook. " +
  "All actions run as the webhook owner. Lists are paged by 50: pass `start` = previous `next`. " +
  "Dates: ISO 8601 (e.g. 2026-11-07 or 2026-11-07T15:00:00+04:00). " +
  "Task statuses (REAL_STATUS): 2 waiting, 3 in progress, 4 awaiting control, 5 completed, 6 deferred. " +
  "Chat DIALOG_ID: 'chat123' for group chats, a user ID for 1:1 chats, 'sg12' for a workgroup chat. " +
  "Before any write, delete or message-sending action, confirm with the user. " +
  "For anything not covered, use b24_call with the exact REST method name.";

// ---------- helpers ----------

function ok(data, note) {
  let text = typeof data === "string" ? data : JSON.stringify(data, null, 1);
  if (text.length > MAX_OUTPUT) {
    text = text.slice(0, MAX_OUTPUT) + `\n…[output truncated at ${MAX_OUTPUT} chars — narrow the query or use paging]`;
  }
  return { content: [{ type: "text", text: note ? `${note}\n${text}` : text }] };
}

function fail(e) {
  const msg = e instanceof BitrixError
    ? `Bitrix24 error ${e.message}` +
      (e.code === "insufficient_scope" || e.code === "INSUFFICIENT_SCOPE"
        ? "\nThe webhook lacks the permission (scope) for this method. Add it in the webhook settings on the portal."
        : "")
    : `Error: ${e.message}`;
  return { content: [{ type: "text", text: msg }], isError: true };
}

// `write` blocks the tool entirely in read-only mode. `readOnly` only sets the
// readOnlyHint annotation; override it for tools that gate writes themselves (b24_call).
function tool(server, ctx, name, { title, description, input = {}, write = false, readOnly = !write, destructive = false }, handler) {
  server.registerTool(
    name,
    {
      title,
      description: description + (write ? (ctx.readOnly ? " [DISABLED: server is in read-only mode]" : "") : ""),
      inputSchema: input,
      annotations: {
        title,
        readOnlyHint: readOnly,
        destructiveHint: destructive,
        openWorldHint: true,
      },
    },
    async (args) => {
      if (write && ctx.readOnly) {
        return fail(new Error("The server is in read-only mode (BITRIX_READ_ONLY). Write operations are disabled."));
      }
      let res;
      try {
        res = await handler(args ?? {});
      } catch (e) {
        res = fail(e);
      }
      return ctx.mode === "http" ? scrubResult(res) : res;
    }
  );
}

// HTTP mode: strip access tokens / download URLs from every text block (image blocks are left alone).
function scrubResult(res) {
  if (!res || !Array.isArray(res.content)) return res;
  return { ...res, content: res.content.map((b) => (b?.type === "text" && typeof b.text === "string" ? { ...b, text: scrubOutput(b.text) } : b)) };
}

const pick = (obj, keys) => {
  const o = {};
  for (const k of keys) if (obj?.[k] !== undefined && obj[k] !== null && obj[k] !== "") o[k] = obj[k];
  return o;
};
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ""));


const id = z.coerce.number().int().positive();
const anyObj = z.record(z.string(), z.any());
const paging = {
  start: z.number().int().min(0).optional().describe("Offset for paging (use the `next` value from the previous response)."),
};

/**
 * ctx = { client: () => Bitrix, readOnly: boolean, mode: "stdio" | "http", downloadDir?: string }
 */
export function registerTools(server, ctx) {
const client = () => ctx.client();

// ===== General =====

tool(server, ctx, "b24_whoami", {
  title: "Webhook owner and permissions",
  description: "Show which user the webhook acts as, the portal address and the granted scopes. Use to diagnose permission errors.",
}, async () => {
  const c = client();
  const [profile, scope] = await Promise.all([c.result("profile"), c.result("scope").catch(() => null)]);
  return ok({ portal: c.origin, user: profile, scopes: scope, read_only_mode: ctx.readOnly, ...(ctx.mode === "stdio" ? { download_dir: ctx.downloadDir } : {}) });
});

const DESTRUCTIVE_RE = /(^|\.)(delete|remove|unbind|unregister|purge|erase|markdeleted|deletefrom\w*|trash|fire|ban)$/i;
const SAFE_READ_RE = /(^|\.)(get|list|getlist|search|fields|getfields|getchildren|getbyid|getnearest|current|count|counters|info|types|scope|profile|methods|recent|accessibility|history)(\.|$)/i;

tool(server, ctx, "b24_call", {
  title: "Call any REST method",
  description:
    "Call any Bitrix24 REST method by exact name (e.g. 'crm.activity.list', 'tasks.task.counters.get', 'im.message.add') with JSON params. " +
    "Use when no dedicated tool fits. Destructive methods (delete/remove/unbind...) require allow_destructive=true and explicit user confirmation." +
    (ctx.readOnly ? " [Read-only mode: only read methods (get/list/search/...) are allowed.]" : " Can create, change and delete data — confirm write calls with the user."),
  input: {
    method: z.string().regex(/^[a-z0-9_.]+$/i).describe("REST method name, without .json"),
    params: anyObj.optional().describe("Method parameters as a JSON object"),
    allow_destructive: z.boolean().optional().describe("Must be true for delete/remove-type methods. Set only after the user confirmed."),
  },
  // Not blocked in read-only mode: the handler itself allows only read methods there.
  // Outside read-only mode it can call any method, so it must not advertise itself as read-only.
  write: false,
  readOnly: ctx.readOnly,
  destructive: !ctx.readOnly,
}, async ({ method, params, allow_destructive }) => {
  if (ctx.mode === "http" && isBlockedAppMethod(method)) {
    return fail(new Error(`'${method}' is an application-level method and is not available in HTTP mode (it would affect all users of the shared application).`));
  }
  const destructive = DESTRUCTIVE_RE.test(method);
  if (destructive && !allow_destructive) {
    return fail(new Error(`'${method}' looks destructive. Confirm with the user, then call again with allow_destructive=true.`));
  }
  if (ctx.readOnly && !SAFE_READ_RE.test(method)) {
    return fail(new Error(`Read-only mode: '${method}' does not look like a read method.`));
  }
  const data = await client().call(method, params || {});
  return ok(clean({ result: data.result, next: data.next, total: data.total }));
});

// ===== Users =====

const USER_FIELDS = ["ID", "ACTIVE", "NAME", "LAST_NAME", "SECOND_NAME", "EMAIL", "WORK_POSITION", "UF_DEPARTMENT", "PERSONAL_MOBILE", "WORK_PHONE", "LAST_ACTIVITY_DATE", "IS_ONLINE"];

tool(server, ctx, "users_find", {
  title: "Find employees",
  description: "Search portal users by name/email/position text, or list by department. Returns IDs needed for tasks, calendar and chats.",
  input: {
    query: z.string().optional().describe("Free text: name, surname, email or position"),
    department_id: id.optional(),
    include_inactive: z.boolean().optional(),
    ...paging,
  },
}, async ({ query, department_id, include_inactive, start }) => {
  const FILTER = clean({ ACTIVE: include_inactive ? undefined : true, UF_DEPARTMENT: department_id });
  const data = query
    ? await client().call("user.search", { FILTER: { ...FILTER, FIND: query }, start })
    : await client().call("user.get", { FILTER, start });
  return ok(clean({ items: (data.result || []).map((u) => pick(u, USER_FIELDS)), next: data.next, total: data.total }));
});

tool(server, ctx, "departments_list", {
  title: "Company structure",
  description: "List departments (ID, name, parent, head).",
  input: { ...paging },
}, async ({ start }) => {
  const data = await client().call("department.get", { start });
  return ok(clean({ items: data.result, next: data.next, total: data.total }));
});

// ===== Tasks =====

const TASK_SELECT = [
  "ID", "TITLE", "STATUS", "REAL_STATUS", "PRIORITY", "DEADLINE", "CREATED_DATE", "CHANGED_DATE", "CLOSED_DATE",
  "START_DATE_PLAN", "END_DATE_PLAN", "RESPONSIBLE_ID", "CREATED_BY", "ACCOMPLICES", "AUDITORS", "GROUP_ID",
  "PARENT_ID", "TAGS", "TIME_ESTIMATE", "TIME_SPENT_IN_LOGS", "UF_CRM_TASK", "ACTIVITY_DATE",
];
const STATUS_NAMES = { 1: "new", 2: "waiting", 3: "in_progress", 4: "awaiting_control", 5: "completed", 6: "deferred", 7: "declined" };

function compactTask(t) {
  const o = {};
  for (const [k, v] of Object.entries(t)) {
    if (v === null || v === "" || (Array.isArray(v) && !v.length)) continue;
    if (["action", "favorite", "subStatus", "group"].includes(k) && typeof v === "object" && !Array.isArray(v)) {
      if (k === "group" && v?.name) o.group = { id: v.id, name: v.name };
      continue;
    }
    if (["responsible", "creator"].includes(k) && v?.name) { o[k] = { id: v.id, name: v.name }; continue; }
    if (["accomplicesData", "auditorsData"].includes(k)) {
      o[k] = Object.values(v || {}).map((p) => ({ id: p.id, name: p.name }));
      continue;
    }
    o[k] = v;
  }
  const st = t.status ?? t.realStatus ?? t.REAL_STATUS;
  if (st && STATUS_NAMES[st]) o.statusName = STATUS_NAMES[st];
  return o;
}

tool(server, ctx, "tasks_list", {
  title: "List / search tasks",
  description:
    "List tasks with filters. Shortcuts: search (title contains), responsible_id, created_by, group_id (project), status, deadline range, only_open. " +
    "`filter` accepts any raw tasks.task.list filter (e.g. {\"::SUBFILTER-PARAMS\":{\"FAVORITE\":\"Y\"}}, {\"<DEADLINE\":\"2026-11-10\"}, {\"STATUS\":-1} for overdue).",
  input: {
    search: z.string().optional().describe("Substring of task title"),
    responsible_id: id.optional(),
    created_by: id.optional(),
    member_id: id.optional().describe("Tasks where this user participates in any role"),
    group_id: id.optional().describe("Workgroup / project ID"),
    status: z.enum(["waiting", "in_progress", "awaiting_control", "completed", "deferred", "overdue"]).optional(),
    only_open: z.boolean().optional().describe("Exclude completed and deferred"),
    deadline_from: z.string().optional(),
    deadline_to: z.string().optional(),
    filter: anyObj.optional(),
    order: anyObj.optional().describe("e.g. {\"DEADLINE\":\"asc\"}. Default: ID desc"),
    with_description: z.boolean().optional(),
    ...paging,
  },
}, async (a) => {
  const statusMap = { waiting: 2, in_progress: 3, awaiting_control: 4, completed: 5, deferred: 6 };
  const filter = clean({
    "%TITLE": a.search,
    RESPONSIBLE_ID: a.responsible_id,
    CREATED_BY: a.created_by,
    MEMBER: a.member_id,
    GROUP_ID: a.group_id,
    REAL_STATUS: a.status && a.status !== "overdue" ? statusMap[a.status] : undefined,
    STATUS: a.status === "overdue" ? -1 : undefined,
    "!REAL_STATUS": a.only_open ? [5, 6] : undefined,
    ">=DEADLINE": a.deadline_from,
    "<=DEADLINE": a.deadline_to,
    ...(a.filter || {}),
  });
  const select = a.with_description ? [...TASK_SELECT, "DESCRIPTION"] : TASK_SELECT;
  const data = await client().call("tasks.task.list", { filter, select, order: a.order || { ID: "desc" }, start: a.start });
  const tasks = data.result?.tasks || [];
  return ok(clean({ items: tasks.map(compactTask), next: data.next, total: data.total }));
});

async function taskChatId(taskId) {
  try {
    const r = await client().result("tasks.task.get", { taskId, select: ["ID", "CHAT_ID"] });
    const t = r?.task || {};
    const cid = Number(t.chatId ?? t.CHAT_ID ?? 0);
    return cid > 0 ? cid : null;
  } catch {
    return null;
  }
}

async function readTaskComments(taskId, limit = 30) {
  const chatId = await taskChatId(taskId);
  if (chatId) {
    try {
      const r = await client().result("im.dialog.messages.get", { DIALOG_ID: `chat${chatId}`, LIMIT: Math.min(limit, 50) });
      return { source: "task_chat", chat_id: chatId, ...compactMessages(r) };
    } catch (e) {
      // fall through to legacy comments
      if (!(e instanceof BitrixError)) throw e;
    }
  }
  const r = await client().result("task.commentitem.getlist", { TASKID: taskId, ORDER: { POST_DATE: "desc" } });
  const items = (r || []).slice(0, limit).map((c) => ({
    id: c.ID, author: c.AUTHOR_NAME, author_id: c.AUTHOR_ID, date: c.POST_DATE, text: stripBB(c.POST_MESSAGE),
    files: c.ATTACHED_OBJECTS ? Object.values(c.ATTACHED_OBJECTS).map((f) => ({ name: f.NAME, size: f.SIZE, file_id: f.FILE_ID })) : undefined,
  }));
  return { source: "legacy_comments", messages: items };
}

tool(server, ctx, "task_get", {
  title: "Task details",
  description: "Full task card: fields, description, checklist, latest comments (works with both the old card and the new task-chat card).",
  input: {
    id,
    comments: z.number().int().min(0).max(50).optional().describe("How many latest comments to include (default 15, 0 = none)"),
  },
}, async ({ id: taskId, comments = 15 }) => {
  const c = client();
  const r = await c.result("tasks.task.get", {
    taskId,
    select: [...TASK_SELECT, "DESCRIPTION", "CHAT_ID", "UF_TASK_WEBDAV_FILES"],
  });
  const task = compactTask(r?.task || {});
  if (task.description) task.description = stripBB(task.description);
  const [checklist, commentData] = await Promise.all([
    c.result("task.checklistitem.getlist", { TASKID: taskId, ORDER: { SORT_INDEX: "asc" } })
      .then((items) => (items || []).map((i) => clean({ id: i.ID, parent_id: i.PARENT_ID !== "0" ? i.PARENT_ID : undefined, title: i.TITLE, done: i.IS_COMPLETE === "Y" })))
      .catch(() => undefined),
    comments > 0 ? readTaskComments(taskId, comments).catch((e) => ({ error: e.message })) : undefined,
  ]);
  return ok(clean({ task, checklist, comments: commentData, url: `${c.origin}/company/personal/user/0/tasks/task/view/${taskId}/` }));
});

tool(server, ctx, "task_comments", {
  title: "Task comments",
  description: "Read task comments / task chat messages (newest first). Use before_id to page back.",
  input: {
    id,
    limit: z.number().int().min(1).max(50).optional(),
    before_id: id.optional().describe("Load messages older than this message ID (task chat only)"),
  },
}, async ({ id: taskId, limit = 30, before_id }) => {
  if (before_id) {
    const chatId = await taskChatId(taskId);
    if (!chatId) return fail(new Error("This task has no chat (old card) — paging by before_id is not available."));
    const r = await client().result("im.dialog.messages.get", { DIALOG_ID: `chat${chatId}`, LAST_ID: before_id, LIMIT: limit });
    return ok({ source: "task_chat", chat_id: chatId, ...compactMessages(r) });
  }
  return ok(await readTaskComments(taskId, limit));
});

tool(server, ctx, "task_create", {
  title: "Create task",
  description: "Create a task. Confirm details with the user first. Returns the new task ID and link.",
  write: true,
  input: {
    title: z.string(),
    responsible_id: id.describe("Assignee user ID (use users_find)"),
    description: z.string().optional(),
    deadline: z.string().optional().describe("ISO datetime"),
    group_id: id.optional().describe("Project / workgroup ID"),
    accomplices: z.array(id).optional(),
    auditors: z.array(id).optional(),
    priority: z.enum(["low", "normal", "high"]).optional(),
    parent_id: id.optional(),
    tags: z.array(z.string()).optional(),
    crm: z.array(z.string()).optional().describe("CRM bindings, e.g. ['D_123','C_45','CO_7','L_9']"),
    checklist: z.array(z.string()).optional().describe("Checklist item titles"),
    start_plan: z.string().optional(),
    end_plan: z.string().optional(),
    extra_fields: anyObj.optional().describe("Any other tasks.task.add fields"),
  },
}, async (a) => {
  const c = client();
  const fields = clean({
    TITLE: a.title,
    RESPONSIBLE_ID: a.responsible_id,
    DESCRIPTION: a.description,
    DEADLINE: a.deadline,
    GROUP_ID: a.group_id,
    ACCOMPLICES: a.accomplices,
    AUDITORS: a.auditors,
    PRIORITY: a.priority ? { low: 0, normal: 1, high: 2 }[a.priority] : undefined,
    PARENT_ID: a.parent_id,
    TAGS: a.tags,
    UF_CRM_TASK: a.crm,
    START_DATE_PLAN: a.start_plan,
    END_DATE_PLAN: a.end_plan,
    ...(a.extra_fields || {}),
  });
  const r = await c.result("tasks.task.add", { fields });
  const newId = Number(r?.task?.id);
  const added = [];
  for (const title of a.checklist || []) {
    try {
      await c.result("task.checklistitem.add", { TASKID: newId, FIELDS: { TITLE: title } });
      added.push(title);
    } catch (e) {
      added.push(`FAILED: ${title} (${e.message})`);
    }
  }
  return ok(clean({ id: newId, title: r?.task?.title, checklist: added.length ? added : undefined, url: `${c.origin}/company/personal/user/0/tasks/task/view/${newId}/` }), "Task created.");
});

tool(server, ctx, "task_update", {
  title: "Update task fields",
  description: "Change task fields: e.g. {\"DEADLINE\":\"2026-11-20T18:00:00\",\"RESPONSIBLE_ID\":5,\"TITLE\":\"...\",\"AUDITORS\":[1,2]}. Confirm with the user first.",
  write: true,
  input: { id, fields: anyObj },
}, async ({ id: taskId, fields }) => {
  await client().result("tasks.task.update", { taskId, fields });
  return ok({ id: taskId, updated: Object.keys(fields) }, "Task updated.");
});

tool(server, ctx, "task_set_status", {
  title: "Change task status",
  description: "Start, complete, defer, renew (reopen), pause, approve or disapprove (for tasks awaiting control).",
  write: true,
  input: { id, action: z.enum(["start", "complete", "defer", "renew", "pause", "approve", "disapprove"]) },
}, async ({ id: taskId, action }) => {
  await client().result(`tasks.task.${action}`, { taskId });
  return ok({ id: taskId, action }, "Done.");
});

tool(server, ctx, "task_add_comment", {
  title: "Comment on task",
  description: "Post a comment to a task (into the task chat on the new card, or as a classic comment). Confirm the text with the user first.",
  write: true,
  input: { id, text: z.string() },
}, async ({ id: taskId, text }) => {
  const c = client();
  const chatId = await taskChatId(taskId);
  if (chatId) {
    try {
      const r = await c.result("tasks.task.chat.message.send", { fields: { taskId, text } });
      return ok({ id: taskId, via: "task_chat", result: r }, "Comment posted.");
    } catch (e) {
      if (!(e instanceof BitrixError)) throw e;
    }
  }
  const r = await c.result("task.commentitem.add", { TASKID: taskId, FIELDS: { POST_MESSAGE: text } });
  return ok({ id: taskId, via: "comment", comment_id: r }, "Comment posted.");
});

tool(server, ctx, "task_checklist", {
  title: "Edit task checklist",
  description: "Add a checklist item, or mark an item done / not done.",
  write: true,
  input: {
    id,
    action: z.enum(["add", "complete", "renew"]),
    title: z.string().optional().describe("For add"),
    item_id: id.optional().describe("For complete / renew"),
    parent_id: id.optional().describe("For add: parent item (sub-item)"),
  },
}, async ({ id: taskId, action, title, item_id, parent_id }) => {
  const c = client();
  if (action === "add") {
    if (!title) throw new Error("title is required for add");
    const r = await c.result("task.checklistitem.add", { TASKID: taskId, FIELDS: clean({ TITLE: title, PARENT_ID: parent_id }) });
    return ok({ task_id: taskId, item_id: r }, "Checklist item added.");
  }
  if (!item_id) throw new Error("item_id is required");
  await c.result(`task.checklistitem.${action}`, { TASKID: taskId, ITEMID: item_id });
  return ok({ task_id: taskId, item_id, action }, "Done.");
});

tool(server, ctx, "task_time_list", {
  title: "Task time records",
  description: "List time-tracking records of a task.",
  input: { id },
}, async ({ id: taskId }) => ok(await client().result("task.elapseditem.getlist", { TASKID: taskId })));

tool(server, ctx, "task_time_add", {
  title: "Add time to task",
  description: "Add a time-tracking record (seconds + comment) to a task.",
  write: true,
  input: { id, seconds: z.number().int().positive(), comment: z.string().optional() },
}, async ({ id: taskId, seconds, comment }) => {
  const r = await client().result("task.elapseditem.add", { TASKID: taskId, ARFIELDS: clean({ SECONDS: seconds, COMMENT_TEXT: comment }) });
  return ok({ task_id: taskId, record_id: r }, "Time added.");
});

tool(server, ctx, "task_history", {
  title: "Task change history",
  description: "Who changed what in a task and when.",
  input: { id },
}, async ({ id: taskId }) => ok(await client().result("tasks.task.history.list", { taskId })));

// ===== Projects / workgroups =====

const GROUP_FIELDS = ["ID", "NAME", "DESCRIPTION", "PROJECT", "PROJECT_DATE_START", "PROJECT_DATE_FINISH", "CLOSED", "VISIBLE", "OPENED", "OWNER_ID", "NUMBER_OF_MEMBERS", "DATE_CREATE", "DATE_ACTIVITY", "SUBJECT_NAME", "IS_EXTRANET"];

tool(server, ctx, "groups_list", {
  title: "Projects and workgroups",
  description: "List workgroups / projects visible to the webhook user. Filter by name, projects only, open/closed.",
  input: {
    search: z.string().optional().describe("Name contains"),
    only_projects: z.boolean().optional(),
    include_closed: z.boolean().optional(),
    filter: anyObj.optional(),
    ...paging,
  },
}, async ({ search, only_projects, include_closed, filter, start }) => {
  const FILTER = clean({
    "%NAME": search,
    PROJECT: only_projects ? "Y" : undefined,
    CLOSED: include_closed ? undefined : "N",
    ...(filter || {}),
  });
  const data = await client().call("sonet_group.get", { ORDER: { NAME: "ASC" }, FILTER, start });
  return ok(clean({ items: (data.result || []).map((g) => pick(g, GROUP_FIELDS)), next: data.next, total: data.total }));
});

tool(server, ctx, "group_get", {
  title: "Project / workgroup details",
  description: "Workgroup or project card with members and their roles (A owner, E moderator, K member).",
  input: { id },
}, async ({ id: gid }) => {
  const c = client();
  const [groups, members] = await Promise.all([
    c.result("sonet_group.get", { FILTER: { ID: gid } }),
    c.result("sonet_group.user.get", { ID: gid }).catch((e) => ({ error: e.message })),
  ]);
  let mem = members;
  if (Array.isArray(members)) {
    const names = await c.userNames(members.map((m) => m.USER_ID));
    mem = members.map((m) => ({ user_id: m.USER_ID, name: names[m.USER_ID] || [m.USER_NAME, m.USER_LAST_NAME].filter(Boolean).join(" ") || undefined, role: m.ROLE }));
  }
  return ok({ group: groups?.[0] || null, members: mem, url: `${c.origin}/workgroups/group/${gid}/` });
});

// ===== Chats (read) =====

// Messages can carry content outside `text`: rich attachments (params.ATTACH) and
// BitrixGPT call overviews (an ATTACH with COMPONENT_PARAMS.MESSAGE_TYPE = AI_OVERVIEW).
// overview_detail: "brief" = title, participants, decisions, tasks; "full" adds agenda and analysis.
function compactMessages(r, { overviewDetail = "brief" } = {}) {
  const users = {};
  for (const u of r?.users || []) users[u.id] = u.name;
  const files = {};
  for (const f of r?.files || []) files[f.id] = { name: f.name, size: f.size, disk_id: f.id };
  const origin = client().origin || "";
  const messages = (r?.messages || []).map((m) => {
    const aid = m.author_id ?? m.authorId;
    const overview = isAiOverview(m) ? parseOverview(m, { detail: overviewDetail, origin }) : undefined;
    const type = messageType(m);
    return clean({
      id: m.id,
      date: m.date,
      author_id: aid || undefined,
      author: aid ? users[aid] || `#${aid}` : "system",
      type: type && type !== "AI_OVERVIEW" ? type : undefined,
      text: stripBB(m.text),
      overview,
      attach: !overview && m.params?.ATTACH ? attachText(m.params.ATTACH) || undefined : undefined,
      files: m.params?.FILE_ID?.length ? m.params.FILE_ID.map((fid) => files[fid] || { disk_id: fid }) : undefined,
    });
  });
  return clean({ chat_id: r?.chat_id ?? r?.chatId, messages });
}

const overviewDetailParam = z.enum(["brief", "full"]).optional()
  .describe("How much of BitrixGPT call overviews to include: brief (default) = title, participants, decisions, tasks; full = also agenda and analysis/recommendations");

tool(server, ctx, "chats_recent", {
  title: "Recent chats",
  description: "List the webhook user's recent dialogs and group chats with last message and unread counter. Returns DIALOG_IDs for chat_messages.",
  input: {
    kind: z.enum(["all", "dialogs", "chats"]).optional().describe("dialogs = 1:1, chats = group chats"),
    include_openlines: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  },
}, async ({ kind = "all", include_openlines = false, limit = 50 }) => {
  const r = await client().result("im.recent.get", clean({
    SKIP_CHAT: kind === "dialogs" ? "Y" : undefined,
    SKIP_DIALOG: kind === "chats" ? "Y" : undefined,
    SKIP_OPENLINES: include_openlines ? "N" : "Y",
  }));
  const items = (r || []).slice(0, limit).map((x) => clean({
    dialog_id: x.id,
    chat_id: x.chat_id || undefined,
    type: x.type,
    title: x.title,
    unread: x.counter || undefined,
    pinned: x.pinned || undefined,
    last_message: x.message ? clean({ id: x.message.id, date: x.message.date, author_id: x.message.author_id, text: stripBB(x.message.text)?.slice(0, 300) }) : undefined,
  }));
  return ok({ items });
});

tool(server, ctx, "chat_messages", {
  title: "Read chat messages",
  description:
    "Read messages from a chat or dialog (newest 20–50). Page back with before_id, forward with after_id. " +
    "Attachments are expanded into `attach`; BitrixGPT call overviews into `overview` (decisions, tasks).",
  input: {
    dialog_id: z.string().describe("'chat123', 'sg12' or a user ID for a 1:1 dialog"),
    limit: z.number().int().min(1).max(50).optional(),
    before_id: id.optional(),
    after_id: id.optional(),
    overview_detail: overviewDetailParam,
  },
}, async ({ dialog_id, limit = 30, before_id, after_id, overview_detail }) => {
  const r = await client().result("im.dialog.messages.get", clean({ DIALOG_ID: dialog_id, LIMIT: limit, LAST_ID: before_id, FIRST_ID: after_id }));
  return ok(compactMessages(r, { overviewDetail: overview_detail }));
});

tool(server, ctx, "chat_search", {
  title: "Search in a chat",
  description:
    "Search messages in one chat by text and/or date range. Needs the numeric CHAT_ID (from chats_recent chat_id, or 'chat123' → 123; for a 1:1 dialog use chat_info first). " +
    "Bitrix searches message text only, not attachments — to search inside BitrixGPT call overviews use call_summaries.",
  input: {
    chat_id: id,
    query: z.string().optional(),
    date_from: z.string().optional(),
    date_to: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional(),
    overview_detail: overviewDetailParam,
  },
}, async ({ chat_id, query, date_from, date_to, limit = 50, overview_detail }) => {
  const r = await client().result("im.dialog.messages.search", clean({ CHAT_ID: chat_id, SEARCH_MESSAGE: query, DATE_FROM: date_from, DATE_TO: date_to, LIMIT: limit }));
  return ok(compactMessages(r, { overviewDetail: overview_detail }));
});

// BitrixGPT posts its call overview as a system message whose text starts with "BitrixGPT …"
// (e.g. "BitrixGPT проанализировал звонок №1440") and whose content is in the attachment.
// Bitrix full-text search covers the text only, so we find these messages by that word and
// match the query against the expanded attachment ourselves.
const OVERVIEW_MARKER = "BitrixGPT";

async function resolveChatId(c, ref) {
  const s = String(ref).trim();
  const m = s.match(/^(?:chat)?(\d+)$/i);
  // 'chat123' and bare numbers are chat IDs; anything else ('sg12') is a DIALOG_ID to resolve.
  const info = await c.result("im.dialog.get", { DIALOG_ID: m ? `chat${m[1]}` : s }).catch((e) => {
    if (m) return null; // the title is optional when we already know the chat ID
    throw e;
  });
  return { chat_id: m ? Number(m[1]) : Number(info?.id), title: info?.name || undefined };
}

async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

/**
 * Chats (group and 1:1, no open lines) with activity since fromTime, newest first.
 * Pages through im.recent.list until the list goes older than fromTime or maxChats is reached.
 */
async function recentChatsSince(c, fromTime, maxChats, counter) {
  const chats = [];
  let offset = 0;
  let truncated = false;
  let oldest;
  for (let page = 0; page < 20; page++) {
    counter.calls++;
    const r = await c.result("im.recent.list", { SKIP_OPENLINES: "Y", LIMIT: 200, OFFSET: offset });
    const items = r?.items || [];
    let reachedOld = false;
    for (const x of items) {
      // Entries with chat_id 0 are colleagues without a dialog yet ("default_user_record"); the list
      // mixes them in with their own dates, so they must not decide where the recent chats end.
      if (!x.chat_id) continue;
      const t = Date.parse(x.message?.date || x.date_update || "");
      if (!isNaN(t) && !isNaN(fromTime) && t < fromTime) {
        if (!x.pinned) reachedOld = true; // pinned chats are listed first regardless of date
        continue;
      }
      if (chats.length >= maxChats) { truncated = true; break; }
      chats.push({ ref: x.id, chat_id: Number(x.chat_id), title: x.title || x.chat?.name });
      if (!isNaN(t)) oldest = x.message?.date || x.date_update;
    }
    if (truncated || reachedOld || !(r?.hasMore ?? r?.hasMorePages) || !items.length) break;
    offset += items.length;
  }
  return { chats, truncated, oldest };
}

tool(server, ctx, "call_summaries", {
  title: "BitrixGPT call summaries",
  description:
    "Find BitrixGPT call overviews (AI_OVERVIEW messages) and search inside them: decisions, tasks, title, participants, agenda. " +
    "Without chat_ids scans every chat (group and 1:1) active since date_from, up to max_chats; the response says if that limit cut the scan short. " +
    "Use this to answer 'what did we decide about X' — chat_search cannot see overview content.",
  input: {
    query: z.string().optional().describe("Words that must all occur in the overview (case-insensitive substring, so 'отход' matches 'отходам'). Analysis/recommendations are not searched."),
    chat_ids: z.array(z.union([z.string(), z.number()])).optional()
      .describe("Chats to scan: numeric chat_id (from chats_recent), 'chat123' or 'sg12'. For 1:1 dialogs pass their chat_id. Default: all chats active since date_from"),
    date_from: z.string().optional().describe("ISO date; default 30 days ago"),
    date_to: z.string().optional(),
    detail: overviewDetailParam,
    max_chats: z.number().int().min(1).max(2000).optional().describe("Upper bound on chats scanned when chat_ids is not given (default 500)"),
    limit: z.number().int().min(1).max(100).optional().describe("Max overviews to return (default 20, newest first)"),
  },
}, async ({ query, chat_ids, date_from, date_to, detail = "brief", max_chats = 500, limit = 20 }) => {
  const c = client();
  const from = date_from || new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const fromTime = Date.parse(from);
  const counter = { calls: 0 };
  const notes = [];
  const errors = [];

  let chats;
  let oldest;
  if (chat_ids?.length) {
    chats = await mapLimit(chat_ids, 4, async (ref) => {
      try { counter.calls++; return { ref, ...(await resolveChatId(c, ref)) }; } catch (e) { return { ref, error: e.message }; }
    });
    chats = chats.filter((ch) => {
      if (ch.error || !ch.chat_id) { errors.push({ chat: ch.ref, error: ch.error || "chat not found" }); return false; }
      return true;
    });
  } else {
    const r = await recentChatsSince(c, fromTime, max_chats, counter);
    chats = r.chats;
    oldest = r.oldest;
    if (r.truncated) {
      notes.push(`Stopped at max_chats=${max_chats}: chats active between ${from} and ${oldest} were not scanned. ` +
        "Raise max_chats, narrow date_from, or pass chat_ids.");
    }
  }

  // One im.dialog.messages.search per chat, sent 50 at a time through `batch`.
  const found = [];
  const full = [];
  const chunks = [];
  for (let i = 0; i < chats.length; i += 50) chunks.push(chats.slice(i, i + 50));
  await mapLimit(chunks, 2, async (chunk) => {
    const cmds = {};
    chunk.forEach((ch, i) => {
      cmds[`c${i}`] = ["im.dialog.messages.search", { CHAT_ID: ch.chat_id, SEARCH_MESSAGE: OVERVIEW_MARKER, DATE_FROM: from, DATE_TO: date_to, LIMIT: 100 }];
    });
    counter.calls++;
    let res;
    try {
      res = await c.batch(cmds);
    } catch (e) {
      for (const ch of chunk) errors.push({ chat: ch.ref, chat_id: ch.chat_id, error: e.message });
      return;
    }
    chunk.forEach((ch, i) => {
      const key = `c${i}`;
      if (res.errors[key]) { errors.push({ chat: ch.ref, chat_id: ch.chat_id, error: res.errors[key] }); return; }
      const msgs = res.results[key]?.messages || [];
      if (msgs.length >= 100) full.push(ch.title || ch.chat_id);
      for (const m of msgs) {
        if (!isAiOverview(m) || !matchesQuery(overviewSearchText(m), query)) continue;
        found.push(clean({
          chat_id: ch.chat_id,
          chat_title: ch.title,
          dialog_id: `chat${ch.chat_id}`,
          message_id: m.id,
          date: m.date,
          ...parseOverview(m, { detail, origin: c.origin }),
        }));
      }
    });
  });
  if (full.length) notes.push(`These chats returned 100 BitrixGPT messages, older ones may be missing — narrow date_from/date_to: ${full.join(", ")}`);
  // Access errors are expected for chats the webhook user left; summarise them instead of listing each.
  const accessErrors = errors.filter((e) => /ACCESS_ERROR/.test(e.error));
  const otherErrors = errors.filter((e) => !/ACCESS_ERROR/.test(e.error));
  if (accessErrors.length) notes.push(`${accessErrors.length} chat(s) skipped: no access.`);

  found.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return ok(clean({
    items: found.slice(0, limit),
    total_found: found.length,
    chats_scanned: chats.length,
    date_from: from,
    oldest_chat_activity: oldest,
    api_calls: counter.calls,
    notes: notes.length ? notes : undefined,
    errors: otherErrors.length ? otherErrors : undefined,
  }));
});

tool(server, ctx, "chat_info", {
  title: "Chat info",
  description: "Chat title, type, owner, numeric chat_id and participants for a DIALOG_ID.",
  input: { dialog_id: z.string() },
}, async ({ dialog_id }) => {
  const c = client();
  const info = await c.result("im.dialog.get", { DIALOG_ID: dialog_id });
  const users = await c.result("im.dialog.users.list", { DIALOG_ID: dialog_id }).catch(() => undefined);
  return ok(clean({
    chat: info ? pick(info, ["id", "dialog_id", "name", "type", "owner", "entity_type", "entity_id", "date_create", "description"]) : undefined,
    members: Array.isArray(users) ? users.map((u) => ({ id: u.id, name: u.name, position: u.work_position })) : undefined,
  }));
});

// ===== Drive =====

const DISK_FIELDS = ["ID", "NAME", "TYPE", "SIZE", "STORAGE_ID", "PARENT_ID", "CREATE_TIME", "UPDATE_TIME", "CREATED_BY", "UPDATED_BY", "DETAIL_URL"];
const compactDisk = (x) => pick(x, DISK_FIELDS);

tool(server, ctx, "disk_storages", {
  title: "Drive storages",
  description: "List Drive storages: user drives, company drive (common), workgroup drives. Returns storage IDs and ROOT_OBJECT_ID.",
  input: { type: z.enum(["user", "common", "group"]).optional(), ...paging },
}, async ({ type, start }) => {
  const data = await client().call("disk.storage.getList", { filter: clean({ ENTITY_TYPE: type }), start });
  return ok(clean({ items: (data.result || []).map((s) => pick(s, ["ID", "NAME", "CODE", "MODULE_ID", "ENTITY_TYPE", "ENTITY_ID", "ROOT_OBJECT_ID"])), next: data.next, total: data.total }));
});

tool(server, ctx, "disk_list", {
  title: "List folder",
  description: "List files and folders in a Drive folder (folder_id) or a storage root (storage_id).",
  input: {
    folder_id: id.optional(),
    storage_id: id.optional(),
    name_contains: z.string().optional(),
    ...paging,
  },
}, async ({ folder_id, storage_id, name_contains, start }) => {
  if (!folder_id && !storage_id) throw new Error("Pass folder_id or storage_id");
  const method = folder_id ? "disk.folder.getChildren" : "disk.storage.getChildren";
  const data = await client().call(method, { id: folder_id || storage_id, start });
  let items = (data.result || []).map(compactDisk);
  if (name_contains) items = items.filter((x) => x.NAME?.toLowerCase().includes(name_contains.toLowerCase()));
  return ok(clean({ items, next: data.next, total: data.total }));
});

tool(server, ctx, "disk_find", {
  title: "Find files on Drive",
  description: "Find files/folders by name inside a folder or storage, walking subfolders (breadth-first, limited depth). Slow on big trees — narrow the start folder.",
  input: {
    name_contains: z.string(),
    folder_id: id.optional(),
    storage_id: id.optional(),
    max_depth: z.number().int().min(0).max(6).optional().describe("Default 3"),
    max_results: z.number().int().min(1).max(200).optional(),
  },
}, async ({ name_contains, folder_id, storage_id, max_depth = 3, max_results = 50 }) => {
  if (!folder_id && !storage_id) throw new Error("Pass folder_id or storage_id (see disk_storages)");
  const c = client();
  const needle = name_contains.toLowerCase();
  const found = [];
  let queue = [{ id: folder_id || storage_id, storage: !folder_id, depth: 0, path: "" }];
  let calls = 0;
  while (queue.length && found.length < max_results && calls < 150) {
    const next = [];
    for (const node of queue) {
      let start = 0;
      do {
        calls++;
        const data = await c.call(node.storage ? "disk.storage.getChildren" : "disk.folder.getChildren", { id: node.id, start });
        for (const x of data.result || []) {
          const p = `${node.path}/${x.NAME}`;
          if (x.NAME?.toLowerCase().includes(needle)) found.push({ ...compactDisk(x), PATH: p });
          if (x.TYPE === "folder" && node.depth < max_depth) next.push({ id: x.ID, storage: false, depth: node.depth + 1, path: p });
        }
        start = data.next;
      } while (start && calls < 150);
      if (found.length >= max_results || calls >= 150) break;
    }
    queue = next;
  }
  return ok({ items: found.slice(0, max_results), api_calls: calls, stopped_early: calls >= 150 || undefined });
});

const TEXT_EXT = new Set(["txt", "md", "csv", "tsv", "json", "xml", "html", "htm", "log", "ini", "yaml", "yml", "sql", "js", "ts", "py", "php", "css", "bsl", "1c"]);
const IMG = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

tool(server, ctx, "disk_file", {
  title: "Read / download Drive file",
  description:
    "Get a Drive file: metadata and content. Text files (txt, csv, md, json, xml…) and Office files (docx, xlsx, pptx — extracted text) are returned as text, images as images. " +
    (ctx.mode === "http"
      ? "Other formats (pdf, zip…) or save=true return metadata with DETAIL_URL (open it on the portal); nothing is written to disk."
      : `Other formats (pdf, zip…) or save=true are saved to the local folder (${ctx.downloadDir}) and the path is returned.`),
  input: {
    id,
    save: z.boolean().optional().describe(ctx.mode === "http" ? "Skip inlining; return metadata and DETAIL_URL only" : "Always save to the local download folder"),
    max_text_chars: z.number().int().min(1000).max(200000).optional(),
  },
}, async ({ id: fileId, save = false, max_text_chars = 60000 }) => {
  const c = client();
  const f = await c.result("disk.file.get", { id: fileId });
  const meta = compactDisk(f);
  const ext = (f.NAME?.split(".").pop() || "").toLowerCase();
  const size = Number(f.SIZE || 0);
  if (!f.DOWNLOAD_URL) return ok({ file: meta }, "No download URL returned for this file.");
  const wantText = TEXT_EXT.has(ext) && size <= 5_000_000 && !save;
  if (!wantText && !IMG[ext] && !["docx", "xlsx", "pptx"].includes(ext)) save = true;
  const wantImage = IMG[ext] && size <= 4_000_000 && !save;
  if (!wantText && !wantImage && size > 300_000_000) {
    return ok({ file: meta }, "File is larger than 300 MB — download it from the portal instead.");
  }
  const inlineOffice = ["docx", "xlsx", "pptx"].includes(ext) && !save && size <= 30_000_000;
  if (ctx.mode === "http" && !wantText && !wantImage && !inlineOffice) {
    return ok({ file: meta }, "This file cannot be shown inline; open it on the portal via DETAIL_URL.");
  }
  const res = await fetch(f.DOWNLOAD_URL);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (wantText) {
    let text = buf.toString("utf8");
    if (text.includes("�") && !text.slice(0, 2000).match(/[а-яё]/i)) {
      try { text = new TextDecoder("windows-1251").decode(buf); } catch {}
    }
    const truncated = text.length > max_text_chars;
    return ok(`${JSON.stringify(meta)}\n----- content${truncated ? ` (first ${max_text_chars} chars)` : ""} -----\n${text.slice(0, max_text_chars)}`);
  }
  const OFFICE = ["docx", "xlsx", "pptx"];
  if (OFFICE.includes(ext) && !save && size <= 30_000_000) {
    const text = extractOffice(ext, new Uint8Array(buf));
    if (text) {
      const truncated = text.length > max_text_chars;
      return ok(`${JSON.stringify(meta)}\n----- extracted text${truncated ? ` (first ${max_text_chars} chars)` : ""} -----\n${text.slice(0, max_text_chars)}`);
    }
  }
  if (wantImage) {
    return { content: [{ type: "text", text: JSON.stringify(meta) }, { type: "image", data: buf.toString("base64"), mimeType: IMG[ext] }] };
  }
  if (ctx.mode === "http") {
    return ok({ file: meta }, "No text could be extracted; open the file on the portal via DETAIL_URL.");
  }
  await mkdir(ctx.downloadDir, { recursive: true });
  const safe = f.NAME.replace(/[\/\\:*?"<>|]/g, "_");
  const dest = path.join(ctx.downloadDir, `${fileId}_${safe}`);
  await writeFile(dest, buf);
  return ok({ file: meta, saved_to: dest, bytes: buf.length }, "File saved locally.");
});

// ===== Calendar =====

const EVENT_FIELDS = ["ID", "PARENT_ID", "NAME", "DATE_FROM", "DATE_TO", "TZ_FROM", "TZ_TO", "DT_SKIP_TIME", "LOCATION", "DESCRIPTION", "IS_MEETING", "MEETING_STATUS", "MEETING_HOST", "ATTENDEE_LIST", "ACCESSIBILITY", "IMPORTANCE", "PRIVATE_EVENT", "RRULE", "SECT_ID", "CAL_TYPE", "OWNER_ID", "CREATED_BY", "REMIND", "UF_CRM_CAL_EVENT"];
function compactEvent(e) {
  const o = pick(e, EVENT_FIELDS);
  if (o.DESCRIPTION) o.DESCRIPTION = stripBB(o.DESCRIPTION);
  if (o.ATTENDEE_LIST) o.ATTENDEE_LIST = o.ATTENDEE_LIST.map((a) => ({ id: a.id, status: a.status }));
  return o;
}

async function me() {
  const p = await client().result("profile");
  return Number(p.ID);
}

tool(server, ctx, "calendar_events", {
  title: "Calendar events",
  description: "List events in a period. Default: the webhook user's personal calendar, today … +7 days. type: user | group | company_calendar (owner_id 0).",
  input: {
    from: z.string().optional(),
    to: z.string().optional(),
    type: z.enum(["user", "group", "company_calendar"]).optional(),
    owner_id: id.optional().describe("User ID or group ID. Default: webhook user; 0 for company calendar"),
    section_ids: z.array(id).optional(),
  },
}, async ({ from, to, type = "user", owner_id, section_ids }) => {
  const now = new Date();
  const ownerId = owner_id ?? (type === "company_calendar" ? 0 : await me());
  const r = await client().result("calendar.event.get", clean({
    type, ownerId,
    from: from || now.toISOString().slice(0, 10),
    to: to || new Date(now.getTime() + 7 * 864e5).toISOString().slice(0, 10),
    section: section_ids,
  }));
  const key = (d) => { const m = String(d || "").match(/^(\d{2})\.(\d{2})\.(\d{4})(?: (\d{2}:\d{2}))?/); return m ? `${m[3]}-${m[2]}-${m[1]} ${m[4] || ""}` : String(d || ""); };
  const items = (r || []).map(compactEvent).sort((a, b) => key(a.DATE_FROM).localeCompare(key(b.DATE_FROM)));
  return ok({ type, owner_id: ownerId, items });
});

tool(server, ctx, "calendar_event_get", {
  title: "Calendar event details",
  description: "Get one event by ID.",
  input: { id },
}, async ({ id: eid }) => ok(compactEvent(await client().result("calendar.event.getbyid", { id: eid }))));

tool(server, ctx, "calendar_sections", {
  title: "Calendars list",
  description: "List calendars (sections) of a user, group or the company.",
  input: { type: z.enum(["user", "group", "company_calendar"]).optional(), owner_id: id.optional() },
}, async ({ type = "user", owner_id }) => {
  const ownerId = owner_id ?? (type === "company_calendar" ? 0 : await me());
  const r = await client().result("calendar.section.get", { type, ownerId });
  return ok((r || []).map((s) => pick(s, ["ID", "NAME", "COLOR", "CAL_TYPE", "OWNER_ID", "DESCRIPTION"])));
});

tool(server, ctx, "calendar_free_busy", {
  title: "Free / busy",
  description: "Busy intervals of several users in a period — use to find a meeting slot.",
  input: { user_ids: z.array(id).min(1), from: z.string(), to: z.string() },
}, async ({ user_ids, from, to }) => ok(await client().result("calendar.accessibility.get", { users: user_ids, from, to })));

tool(server, ctx, "calendar_event_create", {
  title: "Create calendar event",
  description: "Create an event or meeting. With attendees it becomes a meeting and invitations are sent — confirm with the user first.",
  write: true,
  input: {
    name: z.string(),
    from: z.string().describe("ISO datetime, or date if all_day"),
    to: z.string(),
    all_day: z.boolean().optional(),
    description: z.string().optional(),
    location: z.string().optional(),
    attendees: z.array(id).optional().describe("User IDs; the webhook user is added automatically"),
    type: z.enum(["user", "group", "company_calendar"]).optional(),
    owner_id: id.optional(),
    section_id: id.optional().describe("Calendar ID; default: auto-detect"),
    timezone: z.string().optional().describe("e.g. Asia/Tbilisi; default: user's timezone"),
    remind_minutes: z.array(z.number().int().min(0)).optional(),
    importance: z.enum(["high", "normal", "low"]).optional(),
    accessibility: z.enum(["busy", "absent", "quest", "free"]).optional(),
    private: z.boolean().optional(),
    crm: z.array(z.string()).optional().describe("CRM bindings like D_123, C_45"),
    extra_fields: anyObj.optional(),
  },
}, async (a) => {
  const type = a.type || "user";
  const ownerId = a.owner_id ?? (type === "company_calendar" ? 0 : await me());
  const params = clean({
    type, ownerId,
    name: a.name, from: a.from, to: a.to,
    skip_time: a.all_day ? "Y" : undefined,
    description: a.description, location: a.location,
    section: a.section_id,
    auto_detect_section: a.section_id ? undefined : "Y",
    timezone_from: a.timezone, timezone_to: a.timezone,
    importance: a.importance, accessibility: a.accessibility,
    private_event: a.private ? "Y" : undefined,
    is_meeting: a.attendees?.length ? "Y" : undefined,
    attendees: a.attendees?.length ? [...new Set([ownerId, ...a.attendees])] : undefined,
    meeting: a.attendees?.length ? { notify: true, reinvite: false, allow_invite: false, hide_guests: false } : undefined,
    remind: a.remind_minutes?.map((m) => ({ type: "min", count: m })),
    crm_fields: a.crm,
    ...(a.extra_fields || {}),
  });
  const r = await client().result("calendar.event.add", params);
  return ok({ id: r }, "Event created.");
});

tool(server, ctx, "calendar_event_update", {
  title: "Update calendar event",
  description: "Change an event: pass fields in calendar.event.update format (name, from, to, description, location, attendees, …). Confirm first.",
  write: true,
  input: {
    id,
    fields: anyObj,
    type: z.enum(["user", "group", "company_calendar"]).optional(),
    owner_id: id.optional(),
  },
}, async ({ id: eid, fields, type = "user", owner_id }) => {
  const ownerId = owner_id ?? (type === "company_calendar" ? 0 : await me());
  const r = await client().result("calendar.event.update", { id: eid, type, ownerId, ...fields });
  return ok({ id: r ?? eid, updated: Object.keys(fields) }, "Event updated.");
});

// ===== CRM =====

const CRM_ENTITIES = ["deal", "contact", "company", "lead"];

tool(server, ctx, "crm_list", {
  title: "CRM: list / search",
  description:
    "List deals, contacts, companies or leads with a raw filter, e.g. {\"STAGE_ID\":\"NEW\",\">OPPORTUNITY\":100000,\"%TITLE\":\"ООО\"} or {\"PHONE\":\"+7999…\"}. " +
    "Default select is a compact field set; pass select=[\"*\",\"UF_*\"] for everything.",
  input: {
    entity: z.enum(CRM_ENTITIES),
    filter: anyObj.optional(),
    select: z.array(z.string()).optional(),
    order: anyObj.optional(),
    ...paging,
  },
}, async ({ entity, filter, select, order, start }) => {
  const defaults = {
    deal: ["ID", "TITLE", "STAGE_ID", "CATEGORY_ID", "OPPORTUNITY", "CURRENCY_ID", "ASSIGNED_BY_ID", "CONTACT_ID", "COMPANY_ID", "DATE_CREATE", "DATE_MODIFY", "CLOSEDATE", "CLOSED"],
    contact: ["ID", "NAME", "LAST_NAME", "POST", "COMPANY_ID", "PHONE", "EMAIL", "ASSIGNED_BY_ID", "DATE_CREATE"],
    company: ["ID", "TITLE", "COMPANY_TYPE", "INDUSTRY", "PHONE", "EMAIL", "ASSIGNED_BY_ID", "DATE_CREATE"],
    lead: ["ID", "TITLE", "NAME", "LAST_NAME", "STATUS_ID", "SOURCE_ID", "OPPORTUNITY", "PHONE", "EMAIL", "ASSIGNED_BY_ID", "DATE_CREATE"],
  };
  const data = await client().call(`crm.${entity}.list`, { filter: filter || {}, select: select || defaults[entity], order: order || { ID: "DESC" }, start });
  return ok(clean({ items: data.result, next: data.next, total: data.total }));
});

tool(server, ctx, "crm_get", {
  title: "CRM: get record",
  description: "Get one deal / contact / company / lead with all fields; optionally its latest activities.",
  input: { entity: z.enum(CRM_ENTITIES), id, with_activities: z.boolean().optional() },
}, async ({ entity, id: rid, with_activities }) => {
  const c = client();
  const rec = await c.result(`crm.${entity}.get`, { id: rid });
  let activities;
  if (with_activities) {
    const typeId = { lead: 1, deal: 2, contact: 3, company: 4 }[entity];
    activities = await c.result("crm.activity.list", {
      filter: { OWNER_TYPE_ID: typeId, OWNER_ID: rid },
      select: ["ID", "TYPE_ID", "PROVIDER_ID", "SUBJECT", "DESCRIPTION", "COMPLETED", "DEADLINE", "START_TIME", "RESPONSIBLE_ID", "CREATED"],
      order: { ID: "DESC" },
    }).catch((e) => ({ error: e.message }));
  }
  return ok(clean({ record: rec, activities }));
});

tool(server, ctx, "crm_save", {
  title: "CRM: create / update",
  description: "Create (no id) or update (with id) a deal / contact / company / lead. Confirm with the user first.",
  write: true,
  input: { entity: z.enum(CRM_ENTITIES), id: id.optional(), fields: anyObj },
}, async ({ entity, id: rid, fields }) => {
  const c = client();
  if (rid) {
    await c.result(`crm.${entity}.update`, { id: rid, fields });
    return ok({ entity, id: rid, updated: Object.keys(fields) }, "Updated.");
  }
  const newId = await c.result(`crm.${entity}.add`, { fields });
  return ok({ entity, id: newId }, "Created.");
});
}
