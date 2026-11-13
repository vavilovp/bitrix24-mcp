# Bitrix24 MCP

MCP-сервер для Битрикс24 (коробка или облако). Два режима:

- локальный (stdio) через входящий вебхук, упаковывается в расширение `.mcpb` для Claude Desktop;
- удалённый (HTTPS, OAuth) для команды: `node server/http.js`, каждый сотрудник входит через портал Битрикс24 и работает от своего имени. Развёртывание на Synology NAS: [docs/deploy-synology.md](docs/deploy-synology.md).

## Структура

- `manifest.json` — манифест расширения: настройки (`user_config`), список инструментов.
- `server/http.js` — удалённый режим (OAuth 2.1 + `/mcp`), `Dockerfile` и `docker-compose.yml` для его запуска.
- `server/index.js` — регистрация MCP-инструментов.
- `server/bitrix.js` — REST-клиент для вебхука (повторы при лимитах, кэш имён пользователей).
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
