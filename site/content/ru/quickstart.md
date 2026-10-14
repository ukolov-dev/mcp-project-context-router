# Быстрый старт

Установите роутер в репозиторий, которому должна принадлежать память проекта.

## Установка и инициализация

Нужны Node.js **22.13 или новее** и npm. Если в репозитории нет `package.json`, сначала выполните `npm init -y`.

```bash
npm install --save-dev --save-exact github:ukolov-dev/mcp-project-context-router
npx project-context init --name "My project" --module app:src --with-skills
npx project-context index
npx project-context doctor --json
```

Замените имя проекта и путь к исходникам. Проверьте `.project-context/project.yaml`: маски файлов, плейбуки и команды проверки должны соответствовать репозиторию. Сохраните манифест и lockfile в Git: установка из GitHub закрепляет точный коммит.

`--with-skills` устанавливает `project-context-workflow` и `context-research` в `.agents/skills/`. Подходит и для уже настроенного проекта; пользовательские файлы не перезаписываются. Без флага skills не устанавливаются. Обновление npm-пакета не заменяет установленные копии skills.

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

## Проверка подключения

Попросите агента: «Используй project_context: получи описание проекта и собери пакет контекста для этой задачи». Doctor проверяет конфигурацию и локальные данные, но не подключение к текущему чату. Убедитесь, что реальный вызов инструмента работает.

CLI работает и без MCP-клиента:

```bash
npx project-context pack "Update customer service" --modules app
npx project-context reuse-scan "CustomerService" --modules app
```

Далее настройте [проект](configuration.html): пути к исходникам и команды проверки.
