# Инструменты и записи

Project Context Router — локальный stdio MCP-сервер и CLI. Markdown хранит долговечную память; SQLite-индекс можно пересоздать.

## Навигация Tree docs

Пройдите по карте проекта к документу, просмотрите оглавление и прочитайте нужный раздел. Эти инструменты доступны во всех профилях, не изменяют файлы и не требуют индекса или настройки модулей.

| MCP | CLI | Результат |
| --- | --- | --- |
| `get_document_tree` | `docs tree [path]` | Каталоги и пути Markdown |
| `get_document_outline` | `docs outline <path>` | ID разделов и строки источника |
| `read_document_section` | `docs read <path> --section <id>` | Раздел вместе с подразделами |

Используйте ID из оглавления. При `truncated: true` повторите запрос с `offset: nextOffset`. Без section чтение начинается с начала документа. Размер ответа ограничен, обнаруженные секреты скрываются. Поддерживаются относительные пути к UTF-8 Markdown; скрытые, генерируемые и Git-игнорируемые пути и symlink исключаются. Поддержаны ATX и однострочные Setext вне fenced code и frontmatter. См. [полное руководство](https://github.com/ukolov-dev/mcp-project-context-router/blob/main/docs/tree-docs.md).

## Файлы проекта

| Путь | Назначение |
| --- | --- |
| `.project-context/project.yaml` | Модули, маски файлов, плейбуки и команды проверки |
| `.project-context/active/` | Долговечные записи проекта |
| `.project-context/drafts/` | Локальные предложения для ревью |
| `.project-context/archive/` | Исторические записи |
| `.project-context/indexes/` | Пересоздаваемый SQLite-индекс и кеш контекста |
| `.agents/skills/` | Установленные skills проекта, если выбрана эта опция |

Не публикуйте индексы, черновики, корзину, учётные данные и личные инструкции в памяти проекта. Проверяйте долговечные записи перед коммитом.

## Инструменты обычной задачи

| MCP-инструмент | Действие |
| --- | --- |
| `get_project_brief` | Описание и конфигурация репозитория |
| `validate_task`, `confirm_task_contract` | Черновик и подтверждение границ задачи |
| `build_context_pack` | Локальные записи, исходники, инструкции и команды для задачи |
| `find_existing_capability` | Поиск существующей реализации |
| `get_verification_plan` | Проверки и прежние evidence |
| `record_verification_evidence` | Реальные результаты и границы окружения |
| `review_diff_for_refactor` | Эвристика по файлам и модулям выбранного diff |
| `finalize_work` | Сохранение последнего результата задачи |
| `context_doctor` | Диагностика локальных данных и конфигурации |

Синтаксис CLI смотрите в `npx project-context --help` и справке конкретной команды. Доступные инструменты определяет [профиль](configuration.html).

## Как выбрать инструмент

| Нужно | Инструмент | Когда достаточно результата |
| --- | --- | --- |
| Подготовиться к изменению кода | `build_context_pack` | Область проверена, предупреждения разобраны, источники и инструкции прочитаны. [Схема и примеры](context-pack.html). |
| Найти конкретную запись памяти | `search_project_context` | Найдена нужная запись; прочитаны её источник, статус и связи. Это не поиск всех файлов кода. |
| Найти готовую реализацию | `find_existing_capability` | Кандидаты просмотрены в исходниках; совпадение имени само по себе не доказывает пригодность. |
| Получить контекст портала вместе с локальным | `retrieve_project_context` | Портал настроен, проверены доступ, происхождение, ревизии и ограничения возвращённых материалов. |
| Узнать, что проверять | `get_verification_plan` | План прочитан; затем агент отдельно выполняет проверки и сохраняет evidence. |

Обычной локальной задаче не требуется подключение к порталу. MCP возвращает материалы агенту; их применимость и результат работы проверяются в [рабочем процессе](workflow.html).

## 13 типов записей

| Группа | Типы |
| --- | --- |
| Работа и планирование | `task`, `bug`, `backlog`, `research` |
| Знания проекта | `project`, `decision`, `requirement`, `open_question` |
| Источники | `source`, `source_chunk` |
| Проверки и выполнение | `verification-evidence`, `agent-run`, `acceptance-review` |

Не у каждого типа есть отдельный CRUD-инструмент. Общий поиск читает записи; `propose_context_update` предлагает шесть типов знаний: project, decision, requirement, open_question, source и source_chunk. Продвижение требует ревью. Критерии приёмки задачи находятся в Task Contract.

Связи требований используют точные ID или явные `task_key` / `task_keys`. Упоминание в тексте и совпадение префикса не создают связь. Для заданий портала сохраняются необязательные ссылки на исходный документ, ревизию и код задачи.

## Поиск и история

```bash
npx project-context search "CustomerService"
npx project-context pack "Update customer service" --modules app
npx project-context pack "Historical decision" --include-history --include-archive
```

Обычный пакет скрывает завершённую историю workflow и удалённые из модели типы. `--include-history` разрешает историю; `--include-archive` подключает архивное хранилище.

Режим `--search-engine fts5` экспериментальный. Нужна SQLite с FTS5; проверено на Node 22.23.2. Node 22.13.0 поддерживает обычный поиск и возвращается к нему с предупреждением, если FTS5 недоступен. [Оценка поиска](https://github.com/ukolov-dev/mcp-project-context-router/blob/main/docs/search-evaluation.md).

## Необязательные подключения

Context Hub/портал и Confluence требуют явной конфигурации проекта и учётные данные. Они отделены от локальной памяти разработки. Финализация локальной задачи не обновляет приёмку в портале автоматически. Используйте нужный профиль и собственный процесс интеграции: plan/apply либо назначение/отчёт.

Credentials храните в переменных окружения или поддерживаемом системном хранилище, а не в экспортируемых записях. Справка: `npx project-context portal --help` и `npx project-context confluence --help`.

## Связи символов: explain, affected, path

В 0.12.0 эти операции CLI и MCP используют существующий SQLite-индекс:

```bash
npx project-context explain redactSecrets --json
npx project-context affected redactSecrets --depth 2 --json
npx project-context path buildContextPack ensureFreshIndex --json
```

Вместо примеров укажите символы своего проекта. Результаты содержат файлы и строки объявлений, вызовов и импортов. Для одноимённых символов используйте ID кандидата или `file#name`. Анализ ограничен статически разрешимыми TS/JS-связями; отсутствие ребра не доказывает отсутствие зависимости. [Подробности](https://github.com/ukolov-dev/mcp-project-context-router/blob/main/docs/symbol-graph.md).

## Долгие операции MCP

Инструменты выполняются в одном последовательном worker. Пересборка индекса не блокирует brief, Tree docs и получение статуса. Если вызов длится больше пяти секунд, ответ содержит `RUNNING`, `operationId` и `fullResultUri`. Вызывайте `get_operation_result` с этим ID, пока статус не станет `COMPLETED` или `FAILED`. Данные завершённой операции находятся в `result`.

Не повторяйте исходный вызов, особенно запись: он уже принят. Отмена ожидания не отменяет выполнение. Автоматических повторов при сбое worker нет. Очередь ограничена восемью незавершёнными операциями; старые результаты вытесняются, перезапуск удаляет снимки. `NOT_FOUND` означает, что ID недоступен в этом сеансе.

## Краткая и полная диагностика

Doctor по умолчанию возвращает статус, счётчики и несколько примеров. Полный снимок доступен по `fullResultUri` или через `get_operation_result` с `detail: "full"`. `context_doctor` с `detail: "full"` запускает новую полную проверку. Текст MCP не дублирует весь диагностический JSON.

```bash
npx project-context doctor --full --json
npx project-context lint --full --json
```

CLI без `--full` выдаёт сводку, но код возврата учитывает все ошибки. Полная CLI-проверка запускается заново. [Контракт операций](https://github.com/ukolov-dev/mcp-project-context-router/blob/main/docs/mcp-operations.md).
