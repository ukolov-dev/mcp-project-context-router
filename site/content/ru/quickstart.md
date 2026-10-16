# Быстрый старт

Установите роутер в репозиторий, которому должна принадлежать память проекта.

## Установка и инициализация

Нужны Node.js **22.13 или новее** и npm. Если в репозитории нет `package.json`, сначала выполните `npm init -y`.

```bash
npm install --save-dev --save-exact https://github.com/ukolov-dev/mcp-project-context-router/releases/download/v0.10.1/mcp-project-context-router-0.10.1.tgz
npx project-context init --name "My project" --module app:src --with-skills
npx project-context index
npx project-context doctor --json
```

Замените имя проекта и путь к исходникам. Проверьте `.project-context/project.yaml`: маски файлов, плейбуки и команды проверки должны соответствовать репозиторию. Сохраните манифест и lockfile в Git. URL закрепляет готовый релиз 0.10.1; публикация в npm registry не требуется.

`--with-skills` устанавливает `project-context-workflow` и `context-research` в `.agents/skills/`. Подходит и для уже настроенного проекта; пользовательские файлы не перезаписываются. Без флага skills не устанавливаются. Обновление npm-пакета не заменяет установленные копии skills.

## Необязательные хуки Codex

```bash
npx project-context init --with-hooks --with-skills
```

`--with-hooks` создаёт `.codex/hooks.json` с событиями `UserPromptSubmit`, `PostToolUse` и `Stop`. Обычный `init` хуки не устанавливает. Существующие файлы хуков и настройки проекта сохраняются и попадают в `skipped`. Если хуки уже настроены, вручную объедините их с [шаблоном](https://github.com/ukolov-dev/mcp-project-context-router/blob/main/templates/client-configs/codex-hooks.json). Пакет должен быть установлен локально, проект — находиться в Git. Команды находят корень репозитория при работе из вложенной папки; standalone-экспорт использует собственную папку `hooks/`.

Просмотрите команды, разрешите доверие к проекту и подтвердите конкретные определения хуков в Codex (`/hooks` в CLI). При необходимости перезапустите клиент. Установка не выдаёт доверие автоматически и не доказывает, что хуки активны. См. [официальную инструкцию Codex](https://learn.chatgpt.com/docs/hooks).

Хук перед запросом подсказывает рабочий процесс. Хук после инструмента отслеживает содержимое изменённых, staged, новых и удалённых файлов. Перед ответом Stop проверяет все подтверждённые задачи, чьи `files` пересекаются с изменениями: сначала сохраните свежие `record_verification_evidence`, затем `finalize_work`. Обязательные проверки должны пройти; для каждой нерешённой проверки нужны явный результат `partial`/`blocked` и причина в `checks[].reason` либо `skippedChecks: [{command, reason}]`. Одной даты финализации недостаточно. Новая правка исходников требует новой проверки; чтение контекста, записи задач и результатов, индексы её не сбрасывают. Повторный Stop продолжает требовать недостающие данные.

Хуки проверяют записанные результаты: они не запускают тесты, не выполняют независимую приёмку и не закрывают задачи. Не все операции клиента вызывают хуки. Для `completion: "complete"` по-прежнему нужен независимо принятый execution run. Честно описанный частичный результат позволяет ответить пользователю без заявления о полной готовности. Git pre-commit устанавливается отдельно: `npx project-context hooks install`.

Временное состояние хранится в игнорируемой папке `.project-context/indexes/hook-state/`; файлы неактивных сессий удаляются через семь дней. При ошибке хранения или настроек исправьте указанный путь и повторите проверку. После обновления пакета сравните свой конфиг с новым шаблоном: пользовательские файлы автоматически не заменяются.

## Подключение агента

Для Codex создайте `.codex/config.toml` в репозитории вашего проекта:

```toml
[mcp_servers.project_context]
command = "node"
args = ["node_modules/mcp-project-context-router/bin/project-context-mcp"]
cwd = ".."
startup_timeout_sec = 20
tool_timeout_sec = 60
env = { PROJECT_CONTEXT_TOOL_PROFILE = "core" }
```

Разрешите доверие к проекту и переподключите клиент после изменения конфигурации. Относительный `cwd` отсчитывается от `.codex/`; сервер должен читать репозиторий вашего проекта.

Для OpenCode используйте [шаблон стабильной версии](https://github.com/ukolov-dev/mcp-project-context-router/blob/main/templates/client-configs/opencode.json). У [шаблона V2](https://github.com/ukolov-dev/mcp-project-context-router/blob/main/templates/client-configs/opencode-v2.json) другая схема. [Полная инструкция OpenCode](https://github.com/ukolov-dev/mcp-project-context-router/blob/main/docs/install/opencode.ru.md).

## ZCode и DeepSeek Harness

Оба клиента поддерживаются в релизе **0.10.0**. Установите пакет командой выше и выберите свой клиент:

```bash
npx project-context init --client zcode --with-skills
npx project-context init --client deepseek-harness --with-skills --with-hooks
```

Выберите команду для своего клиента. ZCode получает `.zcode/config.json` и `.zcode/skills`. Проектные хуки клиент игнорирует; ручная настройка пользовательских описана отдельно. DSH получает `.dsh/project-context.cordis.yml` и `.agents/skills`. Запуск из корня проекта: `dsh web --patch "$PWD/.dsh/project-context.cordis.yml"`; флаг хуков подключает Codex-адаптер DSH. Пользовательские файлы сохраняются — пропущенный конфиг объедините с шаблоном вручную.

[Инструкция ZCode](https://github.com/ukolov-dev/mcp-project-context-router/blob/main/docs/install/zcode.ru.md) · [Инструкция DeepSeek Harness](https://github.com/ukolov-dev/mcp-project-context-router/blob/main/docs/install/deepseek-harness.ru.md). Проверка MCP и подпроцессов хуков не доказывает подключение к живой сессии клиента.

## Проверка подключения

Попросите агента: «Используй project_context: получи описание проекта и собери пакет контекста для этой задачи». Doctor проверяет конфигурацию и локальные данные, но не подключение к текущему чату. Убедитесь, что реальный вызов инструмента работает.

CLI работает и без MCP-клиента:

```bash
npx project-context pack "Update customer service" --modules app
npx project-context reuse-scan "CustomerService" --modules app
```

## Первый полезный запрос

После настройки [модулей и команд](configuration.html) отправьте агенту:

> Используй project_context. Получи описание проекта, затем собери build_context_pack для задачи «Update CustomerService» с модулем app и файлом src/customer.ts. Покажи, какие материалы выбраны и почему, какие есть предупреждения и что нужно проверить. Пока только прочитай и объясни, без изменения кода.

Замените пример своими модулем, путём и задачей. Убедитесь, что агент действительно вызвал инструмент: в ответе есть `routing`, `records`, `files`, `playbooks`, `commands` и `budget`. Сверьте выбранную область и прочитайте источники.

Дальше — [схема сборки и разбор пакета](context-pack.html), затем [реализация и сохранение результата](workflow.html).
