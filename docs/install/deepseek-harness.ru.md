# Подключение к DeepSeek Harness

Инструкция для официального [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness). Другие проекты с похожим названием не подразумеваются. DSH находится в developer preview; соблюдайте его требования к окружению. Поддержка включена в роутер **0.10.0** и новее.

## Установка и запуск

Из корня Git-репозитория вашего проекта:

```bash
npm install --save-dev --save-exact https://github.com/ukolov-dev/mcp-project-context-router/releases/download/v0.10.1/mcp-project-context-router-0.10.1.tgz
npx project-context init --client deepseek-harness --with-skills
npx project-context index
npx project-context doctor --json
dsh web --patch "$PWD/.dsh/project-context.cordis.yml"
```

DSH установите отдельно по официальной инструкции; для запуска без установки замените `dsh` на `npx @deepseek-ai/dsh`. Роутер не устанавливает клиент и не настраивает авторизацию модели. Запускайте из корня нужного проекта: overlay использует `cwd: .` и локальный пакет. Позднейший `cd` в терминале не меняет привязку MCP. Не используйте этот overlay одного процесса для разных рабочих пространств.

Файл `.dsh/project-context.cordis.yml` подключает `@deepseek-ai/dsh-mcp-client`, сервер `project_context` и профиль `core`. Инструменты называются `mcp__project_context__<tool>`. Overlay загружается явно через `--patch`: создание файла его не активирует. Стандартная сборка DSH уже содержит сервис ресурсов MCP; для собственной сборки проверьте документацию DSH.

## Skills и проверка подключения

`--with-skills` копирует `project-context-workflow` и `context-research` в `.agents/skills/`. Провайдер файловых skills DSH читает эту папку по умолчанию. В собственной сборке нужны registry/provider; одноимённые skills в `.dsh/skills` имеют приоритет. Для research смените `PROJECT_CONTEXT_TOOL_PROFILE` в MCP-строке на `planning`.

В новой сессии попросите вызвать `mcp__project_context__get_project_brief`, затем собрать пакет контекста. Проверьте имя проекта и реальные вызовы инструментов. Doctor подключение к DSH не подтверждает.

## Необязательные хуки

```bash
npx project-context init --client deepseek-harness --with-skills --with-hooks
dsh web --patch "$PWD/.dsh/project-context.cordis.yml"
```

При первой установке флаг создаёт `.dsh/project-context-hooks.json` и добавляет в overlay адаптер `@deepseek-ai/dsh-hooks-codex`. Он запускает существующие хуки запроса, инструментов и Stop; установленный Codex не требуется. Командам хуков сейчас нужны POSIX shell и Git: DSH игнорирует `commandWindows`.

Готовые настройки, skills, хуки и overlays не перезаписываются. Если overlay уже был (в том числе без хуков), вручную добавьте [строку адаптера](../../templates/client-configs/deepseek-harness-hooks.cordis.yml), сохранив свои patches. Не дублируйте ID плагинов и имя MCP-сервера. Просмотрите команды, перезапустите DSH и проверьте журнал хуков: при ошибке загрузки или запуска адаптер может продолжить работу без них.

Stop требует свежие evidence и последующую финализацию либо явные `partial`/`blocked` с причинами нерешённых проверок. Сам он тесты и независимую приёмку не выполняет. Адаптер урезает часть аргументов инструментов и всегда передаёт `stop_hook_active: false`; изменения Git по-прежнему видны по содержимому файлов. Ограничителя повторов Stop нет: исправьте evidence или честно сохраните частичный результат.

## Границы проверки и источники

Тесты покрывают установленный MCP-конфиг, данные проекта, доставку skills, реальные подпроцессы хуков и сохранение пользовательских файлов. Сессии с моделью DSH, его живой загрузчик плагинов и Windows не проверены. Обновления developer preview могут потребовать правки overlay.

Источники, проверено 16.10.2026: [MCP-клиент](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md), [overlays](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/mcp-memory.md), [skills](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/skill/skill-filesystem/README.md), [адаптер хуков](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/experimental/hooks-codex/README.md).
