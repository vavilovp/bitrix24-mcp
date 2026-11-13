# Bitrix24 MCP

MCP-сервер для Битрикс24 (коробка или облако). Два режима:

- локальный (stdio) через входящий вебхук, упаковывается в расширение `.mcpb` для Claude Desktop;
- удалённый (HTTPS, OAuth) для команды: `node server/http.js`, каждый сотрудник входит через портал Битрикс24 и работает от своего имени. Развёртывание на Synology NAS: [docs/deploy-synology.md](docs/deploy-synology.md).

## Структура

- `manifest.json` — манифест расширения: настройки (`user_config`), список инструментов.
- `server/index.js` — точка входа локального режима (stdio, расширение `.mcpb`, вебхук).
- `server/tools.js` — регистрация MCP-инструментов (общая для обоих режимов).
- `server/policy.js` — правила доступа: проверка сотрудника, режим только чтения, запрет методов уровня приложения, очистка токенов из ответов.
- `server/http.js` — точка входа удалённого режима (OAuth 2.1 + `/mcp`), `Dockerfile` и `docker-compose.yml` для его запуска. Модули только этого режима:
  - `server/config.js` — настройки из переменных окружения;
  - `server/oauth.js` — сервер авторизации OAuth 2.1 для клиентов MCP, вход через портал и страница согласия;
  - `server/pages.js` — HTML-страницы согласия и ошибок;
  - `server/grants.js` — клиент Битрикс24 на каждый доступ, обновление токенов портала;
  - `server/store.js` — SQLite-хранилище (клиенты, доступы, хеши токенов);
  - `server/crypto.js` — шифрование токенов портала, хеши и случайные токены.
- `server/bitrix.js` — REST-клиент Битрикс24: вебхук или OAuth-токены (повторы при лимитах, кэш имён пользователей).
- `server/office.js` — извлечение текста из docx / xlsx / pptx.
- `server/attach.js` — очистка BB-кодов, разворачивание вложений сообщений (`params.ATTACH`) и разбор сводок звонков BitrixGPT (`AI_OVERVIEW`).
- `test/` — тесты (`node:test`): разбор вложений и сквозные проверки сервера на локальной заглушке REST API.

## Команды

```bash
npm install
```

```bash
npm test
```

```bash
npm run pack
```

`npm run pack` проверяет синтаксис, прогоняет тесты, проверяет манифест и собирает `dist/bitrix24-box.mcpb`. Для запуска вручную:

```bash
BITRIX_WEBHOOK_URL=https://<portal>/rest/<user_id>/<secret>/ npm start
```

Переменные окружения: `BITRIX_WEBHOOK_URL` (обязательна), `BITRIX_READ_ONLY` (`true` — только чтение), `BITRIX_DOWNLOAD_DIR` (куда сохранять файлы с Диска).

При изменении набора инструментов обновляйте также список `tools` в `manifest.json` и версию в `manifest.json`, `package.json` и `VERSION` в `server/tools.js`.
