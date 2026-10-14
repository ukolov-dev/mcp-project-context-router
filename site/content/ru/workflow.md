# Работа с агентом

Роутер помогает сохранить согласованные границы задачи от запроса до проверенного результата.

## Согласуйте задачу

Для новой реализации используйте `validate_task` и `confirm_task_contract`. Сохраните цель, границы, критерии приёмки, риски и ожидаемые проверки. При продолжении той же задачи используйте существующий подтверждённый контракт. Уточняйте сведения по доступному контексту; спрашивайте о реальных блокерах.

Обсуждение идеи не даёт разрешения на реализацию. Используйте `context-research` для выводов, вариантов и результатов исследования; согласованную работу передавайте в связанный черновик backlog.

## Соберите контекст

Вызовите `build_context_pack` с задачей и конкретными модулями/файлами. Прочитайте выбранные источники и плейбуки. Перед добавлением переиспользуемого кода вызовите `find_existing_capability`.

```bash
npx project-context pack "Update customer service" --modules app --file src/customer.ts
npx project-context reuse-scan "CustomerService" --modules app
```

Нативный MCP остаётся привязан к настроенному репозиторию после shell-команды `cd`. Если сервер смотрит в другой проект, используйте настроенный CLI из нужного корня. Статус и дата записи описывают знание, но не доказывают работоспособность реализации.

## Реализация и проверки

Получите план через `get_verification_plan`. Выполните проверки, прочитайте diff и используйте `review_diff_for_refactor` для его эвристики по выбранным файлам. Эвристика не заменяет содержательное ревью и не разрешает посторонний рефакторинг.

Сохраните реальные команды, результаты, причины пропуска и границы окружения через `record_verification_evidence`. Тест с локальным примером не доказывает работу боевого стенда или интеграции.

## Сохранение результата

`finalize_work` сохраняет `last_result` в подтверждённой задаче. Возвращает `FINALIZED`, `taskPath`, `completion` и `taskStatus`; отдельный черновик отчёта не создаётся.

Явный `partial` сохраняет работу в процессе, `blocked` фиксирует блокер. Без явного completion статус задачи сохраняется. Для `complete` нужен свежий запуск `ready_to_merge` с независимой приёмкой. Одних успешных тестов недостаточно. Инструменты выполнения/приёмки доступны в `developer`, `admin` и `full`; остаются CLI-эквиваленты.

```bash
npx project-context verify-task TASK-ID
npx project-context refactor-review --task TASK-ID
npx project-context finalize-work TASK-ID --input .project-context/drafts/result.json
```

Замените `TASK-ID` на реальный ID. Минимальный файл результата:

```json
{
  "summary": "Implemented the agreed change",
  "changedFiles": ["src/customer.ts"],
  "completion": "partial",
  "tests": [{ "command": "npm test", "status": "passed" }]
}
```

Подробности запусков — в [инструкции execution](https://github.com/ukolov-dev/mcp-project-context-router/blob/main/docs/execution.md).

## Skills из пакета

```bash
npx project-context init --with-skills
```

`project-context-workflow` ведёт по этому процессу; `context-research` помогает исследовать идеи. Существующие копии сохраняются, обновление — вручную. Skill направляет агента, а MCP обеспечивает свои проверки. Публикация, деплой и внешние сообщения требуют разрешения на эти действия.
