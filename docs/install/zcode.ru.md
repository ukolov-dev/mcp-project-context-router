# Подключение к ZCode (Z.ai)

Инструкция для встроенного агента ZCode. Поддержка добавлена в Git `main` после 0.9.0: до следующего релиза устанавливайте из Git. Роутеру нужен Node.js 22.13+; требования самого ZCode проверяйте отдельно.

## Установка и подключение

Из корня Git-репозитория вашего проекта:

```bash
npm install --save-dev --save-exact github:ukolov-dev/mcp-project-context-router#main
npx project-context init --client zcode --with-skills --name "My project" --module app:src
npx project-context index
npx project-context doctor --json
```

Команда создаёт `.zcode/config.json` с `mcp.servers.project_context` и два skills в `.zcode/skills/`. Пакет должен оставаться установленным локально. Проверьте модули и команды проверки в `.project-context/project.yaml`, сохраните lockfile и общий конфиг в Git, откройте корень проекта в ZCode.

Существующие файлы сохраняются и попадают в `skipped`. Если конфиг уже есть, вручную добавьте сервер `project_context` из [шаблона](../../templates/client-configs/zcode.json) в его `mcp.servers`. Остальные настройки и пользовательские skills не заменяйте.

В Settings → MCP Servers сервер должен быть включён и подключён. В CLI тот же сервер добавляется в `mcp.servers` основного конфига; пользовательский файл — `~/.zcode/cli/config.json`. Запускайте клиент из корня проекта: `cwd: "."` привязывает MCP к этой папке. После изменения настроек начните новую сессию.

## Skills и проверка

В Settings → Skills нажмите Refresh и проверьте `project-context-workflow` / `context-research`. Вызовите `$project-context-workflow`, попросите получить описание проекта и собрать пакет контекста. В ответе должно быть имя вашего проекта. Инструменты называются `mcp__project_context__<tool>`. Само наличие файлов подключения не доказывает. Для research смените `PROJECT_CONTEXT_TOOL_PROFILE` на `planning` в `env` сервера и переподключитесь.

## Необязательные пользовательские хуки

ZCode игнорирует хуки проекта. Поэтому `init --client zcode --with-hooks` сразу объясняет ограничение и ничего не записывает. MCP и skills работают без хуков.

Если хуки нужны, просмотрите [zcode-user-hooks.json](../../templates/client-configs/zcode-user-hooks.json), замените `REPLACE_WITH_ABSOLUTE_PACKAGE_DIR` на путь к установленному пакету и вручную объедините группы `hooks.events` с существующими хуками в `~/.zcode/cli/config.json`. Установщик не меняет домашнюю папку и не включает глобальные хуки. В пользовательском конфиге задайте `hooks.enabled: true`, проверьте область действия во всех рабочих пространствах и начните новую сессию. Пакет должен оставаться по указанному пути.

Адаптер Stop сохраняет `decision: block` для desktop и добавляет сигнал продолжения для CLI. Проверки свежести evidence общие с Codex; тесты и независимую приёмку хук не запускает. ZCode desktop ограничивает последовательные продолжения Stop тремя: гарантировать бесконечное блокирование нельзя. Убедитесь в реальной сессии, что события срабатывают.

## Границы проверки и источники

Автотесты проверяют запуск MCP по конфигу, данные нужного проекта, установку skills, сохранение файлов и преобразование Stop. Живые сессии ZCode и Windows не проверены. Doctor не подтверждает подключение к открытому чату.

Официальные источники, проверено 16.10.2026: [MCP](https://zcode.z.ai/en/docs/mcp-services), [пути skills](https://zcode.z.ai/en/docs/qa), [хуки](https://zcode.z.ai/en/docs/hooks), [CLI](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/README.md).
