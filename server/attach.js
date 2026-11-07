// BB-code cleanup and rendering of chat message attachments (params.ATTACH),
// including BitrixGPT / CoPilot call overviews (MESSAGE_TYPE "AI_OVERVIEW").

const BB_TAGS = /\[(\/?)(b|i|u|s|url[^\]]*|user[^\]]*|chat[^\]]*|call[^\]]*|send[^\]]*|put[^\]]*|quote|code|color[^\]]*|size[^\]]*|p|list|\*|left|right|center|justify)\]/gi;

/** Strip Bitrix BB-codes, keeping the visible text. [br] becomes a line break. */
export function stripBB(s) {
  if (typeof s !== "string") return s;
  return s
    .replace(/\[br\]/gi, "\n")
    .replace(BB_TAGS, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Attachments come as an array of attach objects; tolerate an object keyed by ID too. */
function attachList(attach) {
  if (!attach) return [];
  if (Array.isArray(attach)) return attach;
  if (typeof attach === "object") return attach.BLOCKS ? [attach] : Object.values(attach);
  return [];
}

const asArray = (x) => (Array.isArray(x) ? x : x ? [x] : []);

/** One attach block → lines of plain text. */
function blockLines(b) {
  const lines = [];
  if (b.MESSAGE) lines.push(stripBB(b.MESSAGE));
  for (const u of asArray(b.USER)) if (u?.NAME) lines.push(stripBB(u.NAME));
  for (const l of asArray(b.LINK)) {
    if (!l) continue;
    const name = stripBB(l.NAME || "");
    lines.push([name, l.LINK && l.LINK !== name ? `(${l.LINK})` : ""].filter(Boolean).join(" "));
    if (l.DESC) lines.push(stripBB(l.DESC));
  }
  for (const g of asArray(b.GRID)) {
    if (g && (g.NAME || g.VALUE)) lines.push([stripBB(g.NAME || ""), stripBB(String(g.VALUE ?? ""))].filter(Boolean).join(": "));
  }
  for (const f of asArray(b.FILE)) if (f?.NAME) lines.push(`[file: ${f.NAME}]`);
  for (const im of asArray(b.IMAGE)) if (im) lines.push(`[image${im.NAME ? `: ${im.NAME}` : ""}]`);
  return lines.filter((x) => x && x.trim());
}

/** Flatten any attachment into plain text. */
export function attachText(attach, maxChars = 3000) {
  const out = [];
  for (const a of attachList(attach)) {
    if (a?.DESCRIPTION) out.push(stripBB(a.DESCRIPTION));
    for (const b of asArray(a?.BLOCKS)) out.push(...blockLines(b));
  }
  const text = out.join("\n").trim();
  return text.length > maxChars ? text.slice(0, maxChars) + "…" : text;
}

/** MESSAGE_TYPE of a message: messages.get returns UPPER_CASE keys, messages.search camelCase. */
export function messageType(m) {
  const cp = m?.params?.COMPONENT_PARAMS;
  return cp ? cp.MESSAGE_TYPE ?? cp.messageType ?? undefined : undefined;
}

export function isAiOverview(m) {
  return messageType(m) === "AI_OVERVIEW";
}

// Section kinds are recognised by the header icon, which does not depend on the portal language:
// copilot-message-agenda.svg, copilot-message-areements.svg (sic), copilot-message-insights.svg.
function sectionKind(user) {
  const avatar = String(user?.AVATAR || "");
  if (/agenda/i.test(avatar)) return "agenda";
  if (/a?gree?ments|areements|outcome|result/i.test(avatar)) return "outcomes";
  if (/insight|analys|recommend/i.test(avatar)) return "analysis";
  return null;
}

const BOLD_ONLY = /^\s*\[b\]([^[]*)\[\/b\]\s*$/i;
const DECISIONS_RE = /решил|решени|договор|decid|decision|agree/i;
const TASKS_RE = /задач|поручен|task|action|to-?do/i;

/**
 * Parse a BitrixGPT call overview into sections.
 * detail "brief": title, participants, efficiency, decisions, tasks (the parts useful for finding decisions).
 * detail "full": also agenda, analysis and any other sections.
 */
export function parseOverview(m, { detail = "brief", origin = "" } = {}) {
  const cp = m?.params?.COMPONENT_PARAMS || {};
  const o = { call_id: cp.CALL_ID ?? cp.callId };
  const head = [];
  const sections = {}; // key -> lines
  const order = [];
  let section = null; // current section key (null = header)
  let sub = null; // current sub-section key inside "outcomes"

  const push = (key, line) => {
    if (!sections[key]) { sections[key] = []; order.push(key); }
    sections[key].push(line);
  };

  for (const a of attachList(m?.params?.ATTACH)) {
    for (const b of asArray(a?.BLOCKS)) {
      if (b.USER) {
        const u = asArray(b.USER)[0];
        section = sectionKind(u) || stripBB(u?.NAME || "") || "section";
        sub = null;
        continue;
      }
      if (!b.MESSAGE) {
        const lines = blockLines(b);
        for (const l of lines) section ? push(sub || section, l) : head.push(l);
        continue;
      }
      const raw = String(b.MESSAGE);
      const detailLink = raw.match(/\[url=([^\]]*\/call\/detail\/[^\]]*)\]/i);
      if (detailLink) {
        o.details_url = detailLink[1].startsWith("/") ? origin + detailLink[1] : detailLink[1];
        continue;
      }
      if (/helpdesk\.bitrix24|helpdesk\.bitrix/i.test(raw) && /\[i\]/i.test(raw)) continue; // "answers may be inaccurate" footer
      const text = stripBB(raw);
      if (!text) continue;
      if (section === null) { head.push({ raw, text }); continue; }
      const bold = raw.match(BOLD_ONLY);
      if (section === "outcomes" && bold) {
        const name = bold[1].trim();
        sub = DECISIONS_RE.test(name) ? "decisions" : TASKS_RE.test(name) ? "tasks" : name;
        continue;
      }
      push(section === "outcomes" ? sub || "outcomes" : section, text);
    }
  }

  // Header: bold title, participants line (contains [user=…]), "efficiency NN%" line.
  for (const h of head) {
    const { raw, text } = typeof h === "string" ? { raw: h, text: h } : h;
    if (!o.title && BOLD_ONLY.test(raw) && !/\d+\s*%/.test(text)) o.title = text;
    else if (!o.participants && /\[user=/i.test(raw)) o.participants = text.replace(/^[^:]{1,40}:\s*/, "");
    else if (!o.efficiency && /\d+\s*%/.test(text)) o.efficiency = text.match(/(\d+\s*%)/)[1].replace(/\s/g, "");
    else push("header_other", text);
  }

  const joined = (k) => (sections[k]?.length ? sections[k].join("\n") : undefined);
  const res = {
    type: "AI_OVERVIEW",
    call_id: o.call_id,
    title: o.title,
    participants: o.participants,
    efficiency: o.efficiency,
    decisions: joined("decisions"),
    tasks: joined("tasks"),
  };
  // Outcomes without the usual "decisions / tasks" sub-headers.
  if (joined("outcomes")) res.outcomes = joined("outcomes");
  if (detail === "full") {
    res.agenda = joined("agenda");
    res.analysis = joined("analysis");
    const other = {};
    for (const k of order) {
      if (!["decisions", "tasks", "outcomes", "agenda", "analysis"].includes(k)) other[k] = joined(k);
    }
    if (Object.keys(other).length) res.other_sections = other;
  }
  res.details_url = o.details_url;
  return Object.fromEntries(Object.entries(res).filter(([, v]) => v !== undefined && v !== ""));
}

/** Text used to match a search query against an overview (everything except the analysis section). */
export function overviewSearchText(m) {
  const o = parseOverview(m, { detail: "full" });
  return [o.title, o.participants, o.agenda, o.decisions, o.tasks, o.outcomes, ...Object.values(o.other_sections || {})]
    .filter(Boolean).join("\n");
}

const norm = (s) => String(s || "").toLowerCase().replace(/ё/g, "е");

/** All whitespace-separated query terms must occur (case-insensitive substring, ё = е). */
export function matchesQuery(text, query) {
  if (!query || !query.trim()) return true;
  const hay = norm(text);
  return norm(query).split(/\s+/).filter(Boolean).every((t) => hay.includes(t));
}
