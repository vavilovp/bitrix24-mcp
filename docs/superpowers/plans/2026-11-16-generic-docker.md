# Универсальное развёртывание в Docker: план

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Документация и комментарии описывают развёртывание на любом хосте с Docker; Synology остаётся отдельным вариантом.

**Architecture:** Изменения только в документации и комментариях. Общая инструкция `docs/deploy-docker.md` становится основной, `docs/deploy-synology.md` ссылается на неё и хранит только шаги DSM.

**Tech Stack:** Markdown, Docker Compose, nginx, Caddy, Traefik (только примеры настроек).

**Spec:** `docs/superpowers/specs/2026-11-16-generic-docker-design.md`

## Global Constraints

- Поведение сервера, образ и содержимое `docker-compose.yml` (кроме комментариев) не меняются.
- Версия остаётся 1.2.2.
- В публичных файлах нет реальных адресов портала и сервера: только `mcp.example.com`, `mcp.example.synology.me`, `your-portal.example.com`.
- Тексты для пользователей на русском; комментарии в коде и конфигурации на английском.

## Review Focus

- Прокси не передаёт `X-Forwarded-For`: ограничение частоты запросов считает всех одним клиентом. Инструкция должна требовать этот заголовок.
- Два прокси подряд (например, CDN и nginx): сервер доверяет одному. Инструкция должна это оговаривать.
- Прокси в другом контейнере не видит `127.0.0.1` хоста: пример Traefik должен подключать сервис через сеть Docker, а не через опубликованный порт.
- Таймаут прокси 60 секунд обрывает `call_summaries`: в каждом примере таймаут чтения 300 секунд.
- Якоря ссылок из `deploy-synology.md` в `deploy-docker.md` должны совпадать с заголовками.

---

### Task 1: Общая инструкция `docs/deploy-docker.md`

**Files:** Create `docs/deploy-docker.md`.

- [ ] Разделы по порядку: «Что понадобится», «1. Локальное приложение на портале Битрикс24», «2. Настройка и запуск», «3. HTTPS и обратный прокси» (требования; примеры nginx + certbot, Caddy, Traefik), «4. Подключение клиентов», «5. Режим только чтения», «6. Обновление», «7. Данные и резервная копия», «Прочие переменные». Общие тексты переносятся из `deploy-synology.md` без упоминаний DSM.
- [ ] Проверить пример nginx: `docker run --rm -v <файл>:/etc/nginx/conf.d/mcp.conf:ro nginx:alpine nginx -t` (с временным самоподписанным сертификатом). Ожидается `syntax is ok`.
- [ ] Проверить пример Caddy: `docker run --rm -v <файл>:/etc/caddy/Caddyfile:ro caddy:2 caddy validate --config /etc/caddy/Caddyfile`. Ожидается `Valid configuration`.
- [ ] Проверить фрагмент Traefik: `docker compose -f docker-compose.yml -f <override> config` принимает файл.

### Task 2: `docs/deploy-synology.md` только про DSM

**Files:** Modify `docs/deploy-synology.md`.

- [ ] Оставить: сертификат и обратный прокси DSM, проект в Container Manager, `HOST_PORT`, `sudo` по SSH, пересоздание контейнера и обновление через «Остановить» → «Собрать», замечание про «Реестр». Остальное заменить ссылками на разделы `deploy-docker.md`.
- [ ] Проверить, что каждый якорь ссылки существует среди заголовков `deploy-docker.md`.

### Task 3: README и комментарии

**Files:** Modify `README.md`, `docker-compose.yml`, `.env.example`, `server/http.js:70`.

- [ ] README: в описании удалённого режима ссылки на `docs/deploy-docker.md` (любой хост) и `docs/deploy-synology.md` (Synology NAS). Новый раздел «Подключение в Claude»: свой коннектор в claude.ai и приложениях, команда `claude mcp add --transport http`, проверка вопросом «Кто я в Битриксе?».
- [ ] Комментарии: «reverse proxy» и «host» вместо DSM, NAS, Synology, Container Manager.
- [ ] `grep -niE "synology|\bnas\b|dsm|container manager"` по `docker-compose.yml`, `.env.example`, `server/` ничего не находит.

### Task 4: Итоговая проверка

- [ ] `npm run check && npm test`: 122 теста проходят.
- [ ] `docker compose config` принимает `docker-compose.yml` (с временным `.env` из примера, если локального нет).
- [ ] `git diff main -- docker-compose.yml` показывает изменения только в строках комментариев.
