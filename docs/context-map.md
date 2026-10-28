# Карта контекста Router

Карта реализует [Tree docs — основной подход Router](tree-docs.md):
обзор → документ → раздел → реализация и проверки.

Это точка входа для работы с исходным репозиторием Router. Выбери строку по
задаче, затем открой нужный документ или исходник. Читать все ссылки подряд
не требуется. Конфигурация конкретного проекта хранится в
`.project-context/project.yaml`; карта не заменяет её и не является спецификацией.

## Куда идти по задаче

| Задача | Объяснение и правила | Код и проверки |
| --- | --- | --- |
| Обход документов, оглавление и чтение раздела | [Tree docs: CLI и MCP](tree-docs.md#cli-и-mcp) | [Общий модуль](../src/tree-docs/tree-docs.ts), [тесты CLI/MCP и границ](../test/tree-docs.test.ts) |
| Установка и настройка проекта | [README](../README.md#quick-start), [Codex](install/codex.md), [OpenCode](install/opencode.md) | [Инициализация](../src/scaffold/init.ts), [конфигурация](../src/storage/config.ts), [тесты](../test/scaffold.test.ts) |
| Состав, размер и кэш context pack | [Этап построения пакета](workflow.ru.md#этап-3-построение-context-pack) | [buildContextPack](../src/context-pack/pack.ts), [тесты сценариев](../test/high-priority-workflows.test.ts) |
| Выбор модулей и инструкций | [Правила репозитория](../AGENTS.md), [проверки](../playbooks/testing.md) | [Вывод модулей](../src/storage/inference.ts), [selectPlaybooks](../src/context-pack/playbooks.ts), [тесты конфигурации](../test/project-config.test.ts) |
| Поиск, языки и свежесть индекса | [SQLite и FTS5](sqlite-index.md), [оценка поиска](search-evaluation.md) | [Индекс](../src/indexer/sqlite.ts), [capabilities](../src/indexer/capabilities.ts), [тесты свежести](../test/index-freshness.test.ts) |
| Контракт задачи и финализация | [Жизненный цикл задачи](workflow.ru.md), [зарегистрированное выполнение](execution.md) | [Контракты](../src/task-validation/task.ts), [execution](../src/execution/runs.ts), [тесты](../test/task-validation.test.ts) |
| Проверки и evidence | [Правила тестирования](../playbooks/testing.md), [workflow](workflow.ru.md#этап-6-план-проверки) | [Verification](../src/verification/verification.ts), [doctor](../src/doctor/doctor.ts), [тесты границ](../test/repository-boundary.test.ts) |
| Research и backlog | [Research workflow](research.ru.md) | [Research](../src/research/research.ts), [backlog](../src/backlog/backlog.ts), [тесты](../test/research.test.ts) |
| Portal и объединённый контекст | [README](../README.md), [границы доверия](workflow.ru.md#границы-доверия) | [Bridge](../src/portal/bridge.ts), [unified pack](../src/context-pack/unified.ts), [тесты](../test/unified-context-pack.test.ts) |
| CLI, MCP и доступные операции | [README](../README.md#connect-your-coding-agent) | [CLI](../src/cli.ts), [MCP](../src/mcp/server.ts), [профили инструментов](../src/mcp/tool-profiles.ts), [тесты](../test/tool-profiles.test.ts) |
| Перенос процесса в другой проект | [Bootstrap](../templates/portable-workflow/BOOTSTRAP.md), [источники истины](../templates/portable-workflow/SOURCE_OF_TRUTH.md) | [Шаблоны](../templates/portable-workflow/), [тесты переносимости](../test/portability.test.ts) |

## Как раскрывать детали

1. Прочитай [AGENTS.md](../AGENTS.md), выбери маршрут в таблице и согласуй
   границы задачи по действующему workflow.
2. Собери пакет под конкретный вопрос. В [практическом примере](workflow.ru.md#проба-progressive-disclosure-в-этом-репозитории)
   показаны `pack`, поиск реализации и переход к первоисточникам.
3. Проверь `routing`, причины выбора файлов и предупреждения. Открой нужные
   разделы документов, реализацию, её вызовы и связанные тесты. Применимые
   обязательные инструкции прочитай целиком.
4. Если не хватает контекста, уточни запрос, добавь конкретные файлы или
   соседние модули и повтори сборку. После изменения выполни проверки из
   контракта и [AGENTS.md](../AGENTS.md#verification).

При изменении маршрута обновляй соответствующую строку карты. Существование
ссылки не доказывает актуальность описанного поведения: сверяй его с кодом и
результатами проверок.
