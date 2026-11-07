# Bitrix24 MCP (webhook)

MCP-сервер для Битрикс24 (коробка или облако) через входящий вебхук. Упаковывается в расширение `.mcpb` для Claude Desktop.

## Структура

- `manifest.json` — манифест расширения: настройки (`user_config`), список инструментов.
- `server/index.js` — регистрация MCP-инструментов.
- `server/bitrix.js` — REST-клиент для вебхука (повторы при лимитах, кэш имён пользователей).
- `server/office.js` — извлечение текста из docx / xlsx / pptx.

## Команды

```bash
npm install
```

```bash
npm run check
```

```bash
npm run pack
```

`npm run pack` проверяет синтаксис и манифест и собирает `dist/bitrix24-box.mcpb`. Для запуска вручную:

```bash
BITRIX_WEBHOOK_URL=https://<portal>/rest/<user_id>/<secret>/ npm start
```

Переменные окружения: `BITRIX_WEBHOOK_URL` (обязательна), `BITRIX_READ_ONLY` (`true` — только чтение), `BITRIX_DOWNLOAD_DIR` (куда сохранять файлы с Диска).

При изменении набора инструментов обновляйте также список `tools` в `manifest.json` и версию в `manifest.json`, `package.json` и `VERSION` в `server/index.js`.
