import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  stripBB, attachText, messageType, isAiOverview, parseOverview, overviewSearchText, matchesQuery,
} from "../server/attach.js";

const overview = JSON.parse(readFileSync(new URL("./fixtures/ai-overview.json", import.meta.url), "utf8"));

// messages.get returns COMPONENT_PARAMS with UPPER_CASE keys instead of camelCase.
const overviewUpper = structuredClone(overview);
overviewUpper.params.COMPONENT_PARAMS = { MESSAGE_TYPE: "AI_OVERVIEW", CALL_ID: 77, OUTCOME_ID: 5 };

test("stripBB keeps visible text and turns [br] into line breaks", () => {
  assert.equal(stripBB("[b]Итог[/b][br]Ответ: [user=2]Анна[/user] [URL=/x]ссылка[/URL]"), "Итог\nОтвет: Анна ссылка");
  assert.equal(stripBB(undefined), undefined);
});

test("message type is read from both key styles", () => {
  assert.equal(messageType(overview), "AI_OVERVIEW");
  assert.equal(messageType(overviewUpper), "AI_OVERVIEW");
  assert.equal(isAiOverview({ params: { COMPONENT_PARAMS: { messageType: "AI_START" } } }), false);
  assert.equal(messageType({ text: "hi" }), undefined);
});

test("brief overview has title, participants, decisions and tasks but no analysis", () => {
  for (const m of [overview, overviewUpper]) {
    const o = parseOverview(m, { origin: "https://portal.example.ru" });
    assert.equal(o.type, "AI_OVERVIEW");
    assert.equal(o.call_id, 77);
    assert.equal(o.title, "Планирование отчёта по отходам производства");
    assert.equal(o.participants, "Иван Петров, Анна Смирнова");
    assert.equal(o.efficiency, "67%");
    assert.equal(o.decisions, "1. Отчёт по отходам строить по данным партий, а не по регистрам.\n2. Сдать первую версию до пятницы.");
    assert.equal(o.tasks, "1. Анна Смирнова: подготовить ТЗ и отправить Иван Петров.");
    assert.equal(o.details_url, "https://portal.example.ru/call/detail/77");
    assert.equal(o.agenda, undefined);
    assert.equal(o.analysis, undefined);
    assert.ok(!JSON.stringify(o).includes("неточны"), "disclaimer footer is dropped");
  }
});

test("full overview adds agenda and analysis", () => {
  const o = parseOverview(overview, { detail: "full" });
  assert.equal(o.agenda, "Обсудить структуру отчёта по отходам и сроки.");
  assert.match(o.analysis, /Секретное слово: ламинатор\.$/);
  assert.equal(o.other_sections, undefined);
});

test("outcomes without sub-headers are kept as `outcomes`", () => {
  const m = structuredClone(overview);
  m.params.ATTACH[0].BLOCKS = m.params.ATTACH[0].BLOCKS.filter((b) => !/^\[b\](Что решили|Задачи)\[\/b\]$/.test(b.MESSAGE || ""));
  const o = parseOverview(m);
  assert.equal(o.decisions, undefined);
  assert.match(o.outcomes, /^1\. Отчёт по отходам/);
});

test("query matching: all terms, substring, case and ё-insensitive, analysis excluded", () => {
  const text = overviewSearchText(overview);
  assert.ok(matchesQuery(text, "отход"));
  assert.ok(matchesQuery(text, "ОТЧЕТ партий"));
  assert.ok(matchesQuery(text, "смирнова тз"));
  assert.ok(!matchesQuery(text, "отход бухгалтерия"));
  assert.ok(!matchesQuery(text, "ламинатор"), "analysis section is not searched");
  assert.ok(matchesQuery(text, ""));
});

test("generic attachments are flattened", () => {
  const attach = [{
    DESCRIPTION: "Карточка",
    BLOCKS: [
      { MESSAGE: "[b]Заявка[/b] создана" },
      { LINK: [{ NAME: "Открыть", LINK: "https://portal.example.ru/x", DESC: "описание" }] },
      { GRID: [{ NAME: "Статус", VALUE: "Новая", DISPLAY: "LINE" }, { NAME: "Срок", VALUE: "завтра" }] },
      { DELIMITER: { SIZE: 200 } },
      { FILE: [{ NAME: "ТЗ.docx", LINK: "https://portal.example.ru/f" }] },
      { IMAGE: [{ NAME: "скрин.png", LINK: "https://portal.example.ru/i" }] },
    ],
  }];
  assert.equal(attachText(attach), "Карточка\nЗаявка создана\nОткрыть (https://portal.example.ru/x)\nописание\nСтатус: Новая\nСрок: завтра\n[file: ТЗ.docx]\n[image: скрин.png]");
  assert.equal(attachText(attach, 11), "Карточка\nЗа…");
  assert.equal(attachText(undefined), "");
});
