# Исследования: от идеи до backlog

Research — отдельная сущность для идей, которые ещё обсуждаются. Здесь сохраняются
постановка вопроса, варианты, аргументы, находки, решения и открытые вопросы.
Task Contract появляется позже, когда уже выбрана задача для реализации.

```text
.project-context/active/
├── research/     # исследования и история обсуждений
├── backlog/      # согласованные задачи
└── tasks/        # контракты на реализацию
```

Каждое исследование — один Markdown-файл `RESEARCH-....md` с метаданными и
хронологическим журналом. MCP дописывает этапы, не заменяя предыдущие записи.
В файле есть текущие статус, список вопросов, вывод и версия `revision`.
История включает прежние выводы, изменения статуса и ссылки на созданный backlog.
Файлы можно хранить в Git; SQLite служит пересоздаваемым поисковым индексом.
Новый каталог создаётся при `init` или первом `create_research`, миграция не нужна.

Записи в `active/research` означают сохраняемые исследования, а не утверждённые
требования. Они доступны поиску и context pack как тип `research`. Закрытые
исследования скрыты из обычного context pack; для истории используйте
`includeHistory` или `get_research`.

## Подключение

Для работы преимущественно с исследованиями и backlog задайте в существующей
конфигурации MCP-сервера:

```toml
env = { PROJECT_CONTEXT_TOOL_PROFILE = "planning" }
```

Сохраните другие переменные `env`, если они уже есть, и перезапустите MCP-соединение.
`planning` включает core-инструменты, весь backlog и research. Research также
доступен в `analyst`, `admin` и `full`; стандартный `core` не расширяется.

Переносимый Codex skill находится в
[`templates/skills/context-research/SKILL.md`](../templates/skills/context-research/SKILL.md).
Скопируйте каталог `context-research` в каталог skills вашей установки Codex.
Skill помогает вести обсуждение и сохранять его итоги через MCP; он не получает
автоматически историю всех чатов и не устанавливается в личную конфигурацию при
обновлении npm-пакета.

## Статусы

| Статус | Значение | Следующий шаг |
| --- | --- | --- |
| `idea` | Сформулирован вопрос | `exploring`, `paused`, `closed` |
| `exploring` | Обсуждение и проверка вариантов | `ready`, `paused`, `closed` |
| `paused` | Работа отложена | `exploring`, `closed` |
| `ready` | Есть вывод, открытые вопросы разрешены | Передача в backlog, `exploring`, `paused`, `closed` |
| `handed_off` | Созданы связанные черновики backlog | Ещё один backlog, `exploring`, `closed` |
| `closed` | Исследование закрыто, история сохранена | `exploring` |

Переходы требуют объяснения. `ready` требует непустого вывода и пустого текущего
списка вопросов. Принятые ограничения следует явно описать в выводе.
При возвращении в `exploring` текущий вывод очищается; старые выводы и связи
с backlog остаются в журнале. `handed_off` не означает завершение реализации:
`get_research` возвращает актуальные статусы связанных backlog-записей.

## MCP-сценарий

1. `list_research({query: "кэш"})` — найти прошлые обсуждения.
2. `create_research({title: "Выбор кэша", question: "Как обеспечить свежесть данных?", openQuestions: ["Допустимая задержка?"], sourceRefs: []})` — начать новое.
3. `get_research({researchId: "RESEARCH-..."})` — прочитать полную историю и `revision`.
4. `transition_research({researchId, expectedRevision: 1, requestKey: "start", status: "exploring", reason: "Сравниваем варианты"})`.
5. `append_research_entry({researchId, expectedRevision: 2, requestKey: "comparison-1", kind: "finding", content: "Вариант B укладывается в согласованную задержку; A отвергнут из-за стоимости.", openQuestions: [], sourceRefs: []})`.
6. `transition_research({researchId, expectedRevision: 3, requestKey: "conclusion-1", status: "ready", reason: "Сравнение завершено", conclusion: "Выбран B; допустимая задержка согласована."})`.
7. `research_to_backlog` — сначала просмотреть черновик, затем создать его.

Пример передачи результата:

```json
{
  "researchId": "RESEARCH-20260928-120000-001",
  "expectedRevision": 4,
  "requestKey": "cache-task-1",
  "dryRun": false,
  "item": {
    "title": "Реализовать выбранный кэш",
    "description": "Реализовать вариант B в согласованных границах.",
    "priority": "P2",
    "acceptanceCriteria": ["Свежесть данных соответствует согласованному лимиту"],
    "checks": ["npm test"]
  }
}
```

По умолчанию `dryRun: true`: исследование и backlog не изменяются. При создании
получается черновик в `.project-context/drafts/backlog/`, который затем проходит
обычный `confirm_backlog_item`. Ссылки на исследование и его вывод добавляются
в backlog. Одно исследование может породить несколько задач с разными `requestKey`.
Если уже есть похожая задача, ответ `DUPLICATE_OR_RELATED` не создаёт связи и не
меняет статус исследования.

`requestKey` идентифицирует одну операцию: при повторе используйте прежний ключ
и те же данные. Другие данные с тем же ключом отклоняются. `expectedRevision`
защищает от перезаписи чужих изменений. При конфликте перечитайте исследование.
Если процесс остановился между созданием backlog и обновлением исследования,
повтор запроса восстанавливает связь без нового черновика.

`append_research_entry` поддерживает `discussion`, `finding`, `decision`.
Поле `content` хранит Markdown, включая предоставленные пользователем цитаты.
`openQuestions` заменяет текущий список целиком; отсутствие поля сохраняет его,
`[]` очищает. История прежних вопросов остаётся. Полный текст чатов автоматически
не собирается: сохраняются переданные агентом итоги и ссылки на источники.

## CLI

- `project-context research --query "кэш" --status exploring,ready --json`
- `project-context get-research RESEARCH-... --json`
- `project-context create-research --input payload.json --json`
- `project-context append-research-entry --input payload.json --json`
- `project-context transition-research --input payload.json --json`
- `project-context research-to-backlog --input payload.json --json`

JSON-файл должен находиться внутри текущего репозитория. Для временных payload
удобна игнорируемая `.project-context/drafts/`. CLI принимает те же поля, что MCP.
Список ограничен 50 результатами по умолчанию, максимум 200; `total` показывает
полное число совпадений. Для закрытых исследований используйте `--include-closed`
или явный `--status closed`.

Исследования получают `retention: keep`: закрытие не удаляет историю. Запись
изменений сериализована локальным `.research.lock`; после аварийного завершения
процесса перед удалением оставшегося lock-файла убедитесь, что активного автора нет.
Гарантия сохранения истории относится к API; ручное редактирование Markdown
по-прежнему возможно и должно проверяться через Git diff.
