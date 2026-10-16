# Обновление и диагностика

Текущий стабильный релиз — **0.10.0**, с поддержкой ZCode и официального DeepSeek Harness. Опубликованные теги не меняются; при обновлении проверяйте lockfile.

## Обновление до 0.10.0

```bash
npm install --save-dev --save-exact https://github.com/ukolov-dev/mcp-project-context-router/releases/download/v0.10.0/mcp-project-context-router-0.10.0.tgz
npx project-context index
npx project-context doctor --json
```

Проверьте и сохраните новый lockfile, затем переподключите MCP-клиент. Для skills команда `init --with-skills` копирует только отсутствующие файлы. Перед ручным обновлением сравните свои копии с шаблонами в `node_modules/mcp-project-context-router/templates/skills/`.

## Сокращённая модель памяти

Из модели убраны `integration`, `api`, `data_entity`, `meeting_draft`, `acceptance_check`, `module`, `pattern`, `runbook`, `refactor` и `run-summary`. Новые предложения, продвижение и восстановление этих типов отключены. Старые Markdown-файлы сохраняются, доступны для чтения и архивирования; обычный пакет контекста их скрывает.

Удалены CLI `find-integrations` / `find-data-entities` и MCP `find_integrations` / `find_data_entities`. `trace_requirement` больше не возвращает `acceptanceChecks`. `finalize_work` возвращает `FINALIZED` и `taskPath` вместо `CREATED`/`UPDATED` и `draftPath`. Результат хранится в подтверждённой задаче. [Подробная миграция](https://github.com/ukolov-dev/mcp-project-context-router/blob/main/docs/record-model.md).

## Частые проблемы

| Симптом | Что проверить |
| --- | --- |
| Агент не видит инструмент | Профиль MCP, переподключение и фактический список инструментов |
| Сервер читает другой проект | Его `cwd`; shell-команда `cd` не перепривязывает нативный MCP |
| Не находятся символы исходников | Пути модулей и явные маски; пересоздайте индекс |
| Skill не отображается | `.agents/skills/<name>/SKILL.md` и правила обнаружения клиента |
| Установлен старый skill | Существующие файлы намеренно пропускаются; сравните и обновите вручную |
| Финализация complete отклонена | Нужен свежий запуск с независимой приёмкой; обходить проверку нельзя |
| Doctor возвращает WARN | Прочитайте диагностику: предупреждения не доказывают отказ или подключение к клиенту |
| Нет скомпилированного MCP-сервера | Переустановите Git-зависимость с lifecycle-скриптами: они собирают роутер |

## Границы проверок

Успешная сборка или тест на примере не доказывают деплой, права в живом сервисе или подключение текущего клиента. Явно фиксируйте команды и окружение. Индексы и кеши пересоздаются; источником истины остаётся Markdown.

Для ошибки укажите Git-коммит роутера, версию Node, точную команду, очищенный вывод и минимальное воспроизведение в [GitHub Issues](https://github.com/ukolov-dev/mcp-project-context-router/issues). Не прикладывайте учётные данные и личные материалы проекта.

## Релиз 0.9.0

[Изменения и миграция](https://github.com/ukolov-dev/mcp-project-context-router/blob/v0.9.0/docs/release-0.9.md). Добавьте хуки через `init --with-hooks`, просмотрите и разрешите их в Codex. Существующий конфиг хуков сохраняется.

## Релиз 0.10.0: ZCode и DeepSeek Harness

[Релиз и пакет](https://github.com/ukolov-dev/mcp-project-context-router/releases/tag/v0.10.0) · [Изменения](https://github.com/ukolov-dev/mcp-project-context-router/blob/v0.10.0/docs/release-0.10.md).

После обновления используйте `init --client zcode --with-skills` или `init --client deepseek-harness --with-skills --with-hooks`. См. [быстрый старт](quickstart.html#zcode-и-deepseek-harness). Существующие файлы сохраняются: пропущенные записи клиентов и адаптера DSH объедините вручную. DSH требует запуска с `--patch`; пользовательские хуки ZCode подключаются отдельно. Живые сессии клиентов и Windows не проверены.
