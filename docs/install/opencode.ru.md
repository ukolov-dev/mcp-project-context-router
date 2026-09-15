# Использование Project Context Router в OpenCode

[English version](opencode.md)

Project Context Router подключается к OpenCode как локальный MCP-сервер через
`stdio`. Он хранит проверяемую память проекта в каталоге `.project-context/`,
собирает компактный контекст для задачи, помогает искать уже существующие
решения и фиксировать результаты проверки.

Подробная схема жизненного цикла задачи, создаваемых артефактов и контекста,
который получает агент перед реализацией, находится в
[`docs/workflow.ru.md`](../workflow.ru.md).

Конфигурацию рекомендуется хранить в корне проекта-потребителя. Тогда сервер
работает именно с контекстом этого проекта, а настройку можно проверять и
распространять вместе с кодом.

> OpenCode stable и OpenCode 2 beta используют разные схемы MCP. Если команда
> запуска называется `opencode`, используйте конфигурацию stable. Если отдельно
> установлена beta с командой `opencode2`, используйте раздел про OpenCode 2.

## Что потребуется

- Node.js 22.13 или новее;
- npm;
- проект с `package.json` и зафиксированным lock-файлом;
- OpenCode stable или отдельно установленный OpenCode 2 beta.

Проверить версии можно так:

```bash
node --version
npm --version
opencode --version
```

Для OpenCode 2 последняя команда выглядит так:

```bash
opencode2 --version
```

## 1. Установка в проект

Перейдите в корень проекта, которому нужна проектная память, и установите
роутер как точную dev-зависимость:

```bash
npm install --save-dev --save-exact github:ukolov-dev/mcp-project-context-router
```

Пакет пока не публикуется в npm registry, поэтому он устанавливается напрямую
из GitHub. Просмотрите и зафиксируйте изменившийся lock-файл: именно в нём npm
сохраняет разрешённый Git commit.

## 2. Инициализация контекста

Создайте структуру `.project-context/` и укажите реальные модули проекта:

```bash
npx project-context init --name "Название проекта" --module backend:src --module tests:test
npx project-context index
npx project-context doctor --json
```

Параметр `--module` имеет формат `<имя>:<путь>` и может повторяться. Например:

```bash
npx project-context init \
  --name "My Product" \
  --module frontend:frontend/src \
  --module backend:backend/src
```

Команда `init` не перезаписывает существующую конфигурацию. После выполнения
проверьте `.project-context/project.yaml`: замените примеры модулей, масок файлов,
playbook-файлов и команд проверки реальными значениями своего проекта.

Основные данные будут расположены так:

```text
.project-context/
├── project.yaml       # настройки проекта, модулей и проверок
├── active/            # подтверждённые записи проектной памяти
├── drafts/            # черновики на ревью, не коммитятся
├── indexes/           # пересоздаваемый индекс, не коммитится
└── templates/         # шаблоны контрактов и результатов проверки
```

## 3. Подключение к OpenCode stable

Создайте `opencode.json` в корне проекта или добавьте `project_context` в уже
существующий объект `mcp`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "project_context": {
      "type": "local",
      "command": [
        "node",
        "node_modules/mcp-project-context-router/bin/project-context-mcp"
      ],
      "cwd": ".",
      "enabled": true,
      "environment": {
        "PROJECT_CONTEXT_TOOL_PROFILE": "core"
      },
      "timeout": 20000
    }
  }
}
```

Готовый файл находится в
[`templates/client-configs/opencode.json`](../../templates/client-configs/opencode.json).

Если `opencode.json` уже содержит другие настройки, не заменяйте его целиком:
добавьте только ключ `project_context` внутрь существующего объекта `mcp`.

Перезапустите OpenCode в корне проекта и проверьте соединение:

```bash
opencode mcp list
```

Сервер `project_context` должен отображаться как подключённый. OpenCode добавляет
имя MCP-сервера к именам его инструментов, поэтому `get_project_brief`, например,
может отображаться как `project_context_get_project_brief`.

## 4. Подключение к OpenCode 2 beta

Этот раздел нужен только для отдельно установленной команды `opencode2`. В beta
локальные серверы вложены в `mcp.servers`, а сервер подключается автоматически,
если для него не указано `"disabled": true`.

Создайте или дополните `opencode.json` в корне проекта:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "timeout": {
      "startup": 20000,
      "catalog": 30000,
      "execution": 600000
    },
    "servers": {
      "project_context": {
        "type": "local",
        "command": [
          "node",
          "node_modules/mcp-project-context-router/bin/project-context-mcp"
        ],
        "cwd": ".",
        "environment": {
          "PROJECT_CONTEXT_TOOL_PROFILE": "core"
        }
      }
    }
  }
}
```

Готовый файл находится в
[`templates/client-configs/opencode-v2.json`](../../templates/client-configs/opencode-v2.json).

Проверьте подключение:

```bash
opencode2 mcp list
```

Не добавляйте в beta поле `enabled`: оно относится к stable-схеме.

## 5. Первая проверка из чата OpenCode

Откройте OpenCode в корне проекта и отправьте:

```text
Используй MCP-сервер project_context. Получи краткое описание проекта и проверь
состояние Project Context Router. Ничего не изменяй; сообщи найденные проблемы.
```

Затем проверьте построение контекста:

```text
Используй project_context, чтобы собрать стандартный context pack для задачи
«Добавить экспорт данных в CSV». Покажи затронутые модули, важные файлы,
принятые решения, рекомендуемые проверки и предупреждения.
```

Если инструменты подключены, OpenCode вызовет `get_project_brief` или
`get_project_snapshot`, `context_doctor` и `build_context_pack` без необходимости
вручную вводить JSON-аргументы.

## 6. Рекомендуемый рабочий процесс

Для новой задачи используйте следующий порядок:

1. Проверить формулировку и создать черновик Task Contract.
2. Согласовать цель, границы, критерии приёмки, риски и проверки.
3. Подтвердить Task Contract.
4. Собрать context pack и найти уже существующие возможности для
   переиспользования.
5. Внести изменения в код.
6. Получить план проверки и выполнить подходящие команды.
7. Просмотреть diff на предмет локального или отложенного рефакторинга.
8. Записать результаты проверки и финализировать работу.

Готовый промпт для начала задачи:

```text
Используй инструменты MCP-сервера project_context для задачи «<текст задачи>».

1. Вызови validate_task в подходящем режиме.
2. Покажи мне Task Contract и все блокирующие вопросы. Пока не меняй код.
3. После моего явного подтверждения подтверди контракт.
4. Собери build_context_pack с подтверждённым taskId и workflow=standard.
5. До реализации вызови find_existing_capability, чтобы не дублировать уже
   существующий код.
6. Реализуй только подтверждённый scope.
7. Получи get_verification_plan, выполни проверки и зафиксируй доказательства.
8. Вызови review_diff_for_refactor, затем finalize_work с перечнем изменённых
   файлов, выполненных и пропущенных проверок.
```

Не объединяйте этап подтверждения контракта с реализацией в одном безусловном
запросе: OpenCode должен остановиться и дождаться вашего явного подтверждения.

### Короткий запрос для небольшой задачи

```text
Используй project_context: проверь задачу «<текст>», собери context pack в режиме
fast и найди подходящие существующие компоненты. Покажи план перед изменением
кода.
```

### Запрос только на анализ

```text
Используй project_context для анализа «<вопрос>». Получи brief и context pack,
сошлись на конкретные записи и файлы. Не изменяй код и проектную память.
```

### Завершение уже выполненной работы

```text
Используй project_context для текущего Task Contract. Получи план проверки,
сверь его с выполненными командами, проверь diff на рефакторинг и финализируй
работу. Явно перечисли пропущенные проверки и остаточные риски.
```

## 7. Профили инструментов

Профиль задаётся переменной `PROJECT_CONTEXT_TOOL_PROFILE` в `opencode.json`:

| Профиль | Для чего подходит |
| --- | --- |
| `core` | Контракты задач, context pack, поиск переиспользования, проверка, ревью diff и финализация |
| `developer` | `core` плюс приём назначенной работы и отчёты о реализации |
| `analyst` | `core` плюс требования, трассировка источников, аналитические context pack и публикация в Confluence |
| `admin` | `core` плюс управление backlog, продвижение черновиков, retention и решения |
| `full` | Все доступные инструменты; используйте только при реальной необходимости |

Для повседневной разработки оставьте `core`: большой каталог MCP-инструментов
занимает дополнительный контекст модели. После смены профиля перезапустите
OpenCode.

## 8. Использование CLI без MCP

Те же основные действия доступны напрямую из терминала:

```bash
npx project-context brief
npx project-context validate-task "Добавить экспорт CSV" --mode feature
npx project-context pack "Добавить экспорт CSV" --workflow standard --explain
npx project-context reuse-scan "Экспорт CSV"
npx project-context verify-task --query "Добавить экспорт CSV"
npx project-context refactor-review
npx project-context doctor --json
```

Полный список команд:

```bash
npx project-context --help
```

CLI полезен для диагностики: он запускается в том же рабочем каталоге и читает
ту же конфигурацию, что и MCP-сервер.

## 9. Обновление индекса

Перестройте индекс после заметного изменения активной проектной памяти,
конфигурации модулей или индексируемого исходного кода:

```bash
npx project-context index
```

Проверить свежесть без принудительной перестройки:

```bash
npx project-context index --check
```

Индекс в `.project-context/indexes/` является производным локальным файлом. Его
не нужно добавлять в Git; источником истины остаются Markdown/YAML-записи.

## 10. Диагностика

### Сервер не отображается в `mcp list`

Запустите в корне проекта:

```bash
node --version
test -f node_modules/mcp-project-context-router/bin/project-context-mcp
npx project-context doctor --json
```

Убедитесь, что OpenCode тоже запущен из корня этого проекта и что `cwd` в
конфигурации равен `.`.

### Ошибка про неизвестные `servers` или `disabled`

Вы используете stable-клиент с beta-конфигурацией. Поместите сервер напрямую в
`mcp.project_context` и используйте `"enabled": true`.

### Ошибка про неизвестный `enabled`

Вы используете OpenCode 2 beta со stable-конфигурацией. Поместите сервер в
`mcp.servers.project_context` и удалите `enabled`.

### MCP-процесс сразу завершается

Проверьте Node.js, наличие установленного пакета и скомпилированного каталога
`dist/`:

```bash
node --version
npm ls mcp-project-context-router
npx project-context doctor --json
```

Если пакет повреждён, переустановите зависимости из lock-файла:

```bash
npm ci
```

### Сервер читает не тот проект

Храните `opencode.json` в корне проекта-потребителя, запускайте OpenCode из этого
проекта и не заменяйте `cwd: "."` абсолютным путём к рабочей станции.

### В контекст модели попадает слишком много MCP-инструментов

Оставьте профиль `core` и отключите MCP-серверы, которые не нужны для текущей
работы. Переходите на `analyst`, `developer`, `admin` или `full` только для
соответствующего сценария.

## Безопасность и Git

- Не сохраняйте токены и пароли в `opencode.json` или `.project-context/`.
- Не коммитьте `.project-context/drafts/`, `.project-context/indexes/`, SQLite
  файлы, `node_modules` и локальные секреты.
- Коммитьте проверяемые записи из `.project-context/active/`, конфигурацию
  `.project-context/project.yaml`, `opencode.json`, `package.json` и lock-файл,
  если это соответствует правилам вашего репозитория.
- Не используйте абсолютные пути конкретной рабочей станции в общей
  конфигурации.

Актуальные схемы клиента описаны в официальной документации OpenCode:

- [MCP-серверы OpenCode stable](https://opencode.ai/docs/mcp-servers/)
- [Конфигурация OpenCode stable](https://opencode.ai/docs/config/)
- [MCP-серверы OpenCode 2 beta](https://opencode.ai/v2/docs/mcp-servers/)
