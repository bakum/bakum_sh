# Odoo Branch Manager — локальный odoo.sh

Десктопное приложение для Windows 10 и Docker Desktop. Ветки git-репозитория с модулями Odoo раскладываются по стадиям
Production / Staging / Development. На каждую ветку собирается изолированная сборка: контейнер Odoo, своя БД и свой код
(worktree). Сборка открывается во внешнем браузере по адресу `http://<ветка>.localhost` (при занятом 80-м порту —
`http://<ветка>.localhost:8080`).

- ТЗ: [branch-manager-spec.md](branch-manager-spec.md) (этап 1 — MVP).
- Решения, принятые при реализации, и отступления от ТЗ: [docs/decisions.md](docs/decisions.md).
- Проверка критериев приёмки: [docs/acceptance.md](docs/acceptance.md).

## Требования

- Windows 10/11 x64, Docker Desktop (WSL2), Git for Windows.
- Node.js 22 LTS и pnpm 10 — только для сборки из исходников.
- Необязательно: Windows Terminal (`wt`) для вкладки Shell (без него открывается `cmd`), VS Code или Cursor для Editor,
  `gh` (понадобится на этапе 2).
- Права администратора не нужны. Приложение не открывает сетевых портов. Сборки доступны через общий Traefik
  (контейнер `bm-traefik`, порт `127.0.0.1:80` или `127.0.0.1:8080`), debugpy — на `127.0.0.1:57xx`.

## Команды

```powershell
pnpm install     # зависимости; better-sqlite3 подготавливается под Electron (postinstall)
pnpm dev         # режим разработки (electron-vite, HMR)
pnpm build       # сборка main / preload / renderer в apps/desktop/out
pnpm start       # запуск собранного приложения
pnpm package     # установщик NSIS и portable в apps/desktop/dist (без подписи)
pnpm typecheck   # TypeScript strict во всех пакетах
pnpm test        # unit-тесты Core (Vitest под ELECTRON_RUN_AS_NODE=1)
```

Если терминал запущен из VS Code, в окружении может оказаться `ELECTRON_RUN_AS_NODE=1`: скрипты `dev / build / start`
убирают эту переменную сами.

Для ручных проверок без риска для рабочих настроек есть профиль: `set BM_PROFILE=dev` (в PowerShell —
`$env:BM_PROFILE='dev'`). Тогда настройки, реестр и логи пишутся в папки с суффиксом ` (dev)`.

## Где что лежит

| Что | Где |
|---|---|
| Настройки приложения | `%APPDATA%\Odoo Branch Manager\app.yaml` |
| Настройки проектов | `%APPDATA%\Odoo Branch Manager\projects\<id>.yaml` — правка вручную подхватывается сразу |
| Реестр (SQLite) | `%LOCALAPPDATA%\Odoo Branch Manager\registry.sqlite` |
| compose-файлы сборок | `%LOCALAPPDATA%\Odoo Branch Manager\projects\<id>\branches\<slug>\compose.yml` |
| Логи | `%LOCALAPPDATA%\Odoo Branch Manager\logs\` — `main.log`, `core.log`, `builds\<project>\<slug>-<n>.log`, `jobs\<id>-<type>.log` |
| Traefik | `%LOCALAPPDATA%\Odoo Branch Manager\traefik\compose.yml`, контейнер `bm-traefik` |
| Worktree веток | `<repo.worktreesDir>\<project>\<slug>` (DEMZ: `E:\demz-odoo-19\worktrees\demz\...`) |
| filestore сборок | `<runtime.filestore.hostDir>\<БД>` (DEMZ: `E:\demz-odoo-19\data\filestore\o19_br_*`) |

Папку логов открывает кнопка «Открыть папку логов» на странице Status.

## Как добавить проект

1. При первом запуске мастер показывает папки и порт Traefik, затем предлагает добавить проект. Позже — селектор
   проекта в шапке, пункт «+ Добавить проект…».
2. Выберите папку локального клона репозитория (например `E:\demz-odoo-19\repositories\demz-odoo`) и нажмите
   «Определить». Мастер найдёт remote и GitHub, корни модулей, файл списка модулей, образ, сеть, монтирования,
   Postgres и предложит пресет (DEMZ или Generic Odoo). `.env` мастер не читает: учётка Postgres берётся из
   `docker inspect` контейнера Odoo или из `odoo.conf`.
3. Проверьте значения и YAML, нажмите «Создать проект». Первый fetch разложит ветки по правилам `branchRules`.
4. Для DEMZ: ветка Production (`19.0`) → вкладка Backups → «Импортировать» бэкап прода (`.zip`). Получится
   «Зеркало прода (локально)», из копий которого собираются Staging и Development.

## Как всё удалить

1. В приложении у каждой ветки нажмите Delete (или «Отбросить» у сборок). Так удаляются контейнеры, БД, filestore
   и worktree, созданные приложением. Остатки после сбоев показываются на Status в «Сиротах», там их можно удалить
   после подтверждения.
2. Остановите и удалите Traefik: `docker compose -p bm-traefik down`.
3. Закройте приложение (трей → Выход) и удалите папки `%APPDATA%\Odoo Branch Manager` и
   `%LOCALAPPDATA%\Odoo Branch Manager`. Установленную версию удалите через «Приложения» Windows.
4. Git-репозиторий, его ветки и контейнеры проекта (например `odoo19`, `odoo19-db`) приложение не трогает. Пустую
   папку `worktrees` проекта можно удалить вручную.

## Версии

Версия одна на всё приложение и записана в `package.json` в корне. Во всех пакетах (`apps/desktop`, `packages/*`) стоит
та же версия, это проверяет `pnpm version:check` (он же запускается первым шагом `pnpm typecheck`). Нумерация — SemVer:

| Часть | Когда растёт |
|---|---|
| MAJOR | Несовместимые изменения: формат YAML-настроек или реестра, которые не мигрируют автоматически и требуют ручных шагов. |
| MINOR | Новые возможности. До 1.0.0 MINOR совпадает с этапом ТЗ: этап 1 — `0.1.x`, этап 2 — `0.2.x`, этап 3 — `0.3.x`, после этапа 3 — `1.0.0`. |
| PATCH | Исправления и мелкие улучшения без изменения настроек. |

Выпуск версии:

```powershell
# 1. Опишите изменения в CHANGELOG.md, раздел «## [Unreleased]», и закоммитьте их.
pnpm release patch     # или minor / major / 0.2.0
# Версия меняется во всех package.json, [Unreleased] становится «[X.Y.Z] — дата»,
# создаются коммит «Release vX.Y.Z» и тег vX.Y.Z. Скрипт ничего не пушит.
pnpm package           # установщик apps/desktop/dist/Odoo-Branch-Manager-Setup-X.Y.Z.exe
```

При сборке в приложение встраиваются версия, короткий хеш коммита (с `-dirty`, если были незакоммиченные правки) и
дата сборки. Они видны в нижней строке окна (клик копирует их для баг-репорта), на странице Status и в `main.log`.
При смене версии Core пишет в Audit Logs запись `app.upgraded`. Эта запись — точка для будущих миграций данных. Схема
SQLite мигрирует сама (`PRAGMA user_version`). История изменений — [CHANGELOG.md](CHANGELOG.md).

## Устройство

- `apps/desktop` — Electron: main (окно, трей, уведомления, запрет сна, перезапуск Core), preload (`window.bm`),
  renderer (React, Mantine, TanStack Query, dnd-kit, Monaco, xterm.js).
- `packages/core` — Core в `utilityProcess`: проекты и настройки, очередь задач, git, Docker (compose CLI и dockerode),
  Postgres, SQLite (Drizzle), согласование состояния. Не зависит от Electron.
- `packages/shared` — zod-схемы настроек (раздел 9) и IPC-контракта (раздел 10).

UI и Core общаются через MessagePort. Если Core падает, main перезапускает его, а UI показывает баннер.

---

© 2026 Bakum Viacheslav
