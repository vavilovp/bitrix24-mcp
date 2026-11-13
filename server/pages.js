// HTML pages of the HTTP-mode login flow. Plain HTML, inline CSS only, no scripts or external resources.
// Every interpolated value goes through esc(). Do not import from the stdio entry points.

const MAX_CLIENT_NAME = 80;

const ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" };

export function esc(value) {
  return String(value ?? "").replace(/[&<>"'`]/g, (c) => ENTITIES[c]);
}

export function truncate(value, max = MAX_CLIENT_NAME) {
  // Control characters become spaces; format characters (bidi overrides, zero-width) are dropped.
  const chars = [...String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\p{Cf}/gu, "").trim()];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
}

const STYLE = `
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;background:#f4f5f7;color:#1f2328;margin:0}
main{max-width:480px;margin:48px auto;background:#fff;border-radius:10px;padding:28px 32px;box-shadow:0 1px 4px rgba(0,0,0,.12)}
h1{font-size:20px;margin:0 0 16px}
p{line-height:1.45}
.host{font-family:ui-monospace,Menlo,Consolas,monospace;background:#eef1f4;padding:1px 6px;border-radius:4px}
.warn{background:#fff4e5;border:1px solid #f0b46a;border-radius:6px;padding:10px 12px;margin:14px 0}
label{display:block;margin:12px 0}
.note{color:#59636e;font-size:13px}
.actions{display:flex;gap:12px;margin-top:20px}
button{font-size:15px;padding:8px 18px;border-radius:6px;border:1px solid #c4c9cf;background:#fff;cursor:pointer}
button.primary{background:#2066d1;border-color:#2066d1;color:#fff}
`;

function layout(title, body) {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
}

/**
 * user: { name }, client: { name }, redirectHost: "claude.ai" (host[:port]), known: boolean,
 * forcedReadOnly: boolean, consentId / csrf: hidden form values.
 */
export function consentPage({ user, client, redirectHost, known, forcedReadOnly, consentId, csrf }) {
  const clientName = truncate(client?.name) || "Без названия";
  const warn = known
    ? ""
    : `<div class="warn"><strong>Незнакомый адрес.</strong> Приложение вернёт доступ на <span class="host">${esc(redirectHost)}</span>,
этого адреса нет в списке известных клиентов. Продолжайте, только если вы сами подключаете это приложение.
<label><input type="checkbox" name="unknown_ok" value="1" required> Я понимаю, что доступ получит <span class="host">${esc(redirectHost)}</span></label></div>`;
  const ro = forcedReadOnly
    ? `<label><input type="checkbox" name="read_only" value="1" checked disabled> Только чтение</label>
<p class="note">Для вашей учётной записи администратор разрешил только чтение.</p>`
    : `<label><input type="checkbox" name="read_only" value="1"> Только чтение (без создания и изменения данных)</label>`;
  return layout("Доступ к Битрикс24", `<h1>Доступ к Битрикс24</h1>
<p>Вы вошли как <strong>${esc(user?.name)}</strong>.</p>
<p>Приложение <strong>${esc(clientName)}</strong> запрашивает доступ к Битрикс24 от вашего имени.
Ответ будет отправлен на <span class="host">${esc(redirectHost)}</span>.</p>
<form method="post" action="/consent">
<input type="hidden" name="consent_id" value="${esc(consentId)}">
<input type="hidden" name="csrf" value="${esc(csrf)}">
${warn}
${ro}
<div class="actions">
<button class="primary" type="submit" name="action" value="allow">Разрешить</button>
<button type="submit" name="action" value="deny" formnovalidate>Отказать</button>
</div>
</form>`);
}

export function refusalPage(reason) {
  return layout("Доступ запрещён", `<h1>Доступ запрещён</h1>
<p>${esc(reason)}</p>`);
}

export function errorPage(message) {
  return layout("Ошибка входа", `<h1>Ошибка входа</h1>
<p>${esc(message)}</p>
<p class="note">Вернитесь в приложение и подключитесь заново.</p>`);
}
