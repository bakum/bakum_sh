# Odoo Branch Manager — локальный odoo.sh

Десктопное приложение для Windows 10 и Docker Desktop. Ветки git-репозитория с модулями Odoo раскладываются по стадиям
Production (одна ветка) и Development (все остальные). На каждую ветку собирается изолированная сборка: контейнер Odoo, своя БД и свой код
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
| Postgres «Odoo в Docker» | `%LOCALAPPDATA%\Odoo Branch Manager\postgres\<id>\compose.yml`, контейнер `bm-<id>-db`, том `bm-<id>-pgdata` |
| Копии репозиториев | `%LOCALAPPDATA%\Odoo Branch Manager\repos\<имя>.git` (bare, в них не работают); Enterprise — `repos\<имя>-enterprise` |
| Worktree веток | `<repo.worktreesDir>\<project>\<slug>` (DEMZ: `E:\demz-odoo-19\worktrees\demz\...`), из копии приложения, detached |
| filestore сборок | `<runtime.filestore.hostDir>\<БД>` (DEMZ: `E:\demz-odoo-19\data\filestore\o19_br_*`) |

Папку логов открывает кнопка «Открыть папку логов» на странице Status.

## Как добавить проект

1. При первом запуске мастер показывает папки, порт Traefik и проверяет Git и Docker, затем предлагает добавить
   проект. Позже — селектор проекта в шапке, пункт «+ Добавить проект…».
2. Код проекта. Сборки берут код с GitHub: приложение делает свою копию репозитория
   (`%LOCALAPPDATA%\Odoo Branch Manager\repos\<имя>.git`) и в ней — папки веток. Ваши клоны приложение не трогает,
   в них можно свободно переключать ветки.
   - **По адресу** — вставьте https- или SSH-адрес репозитория и нажмите «Проверить доступ». Если репозиторий
     приватный, мастер предложит «Войти через браузер» (окно Git Credential Manager) или сохранить токен доступа
     (fine-grained, Contents — Read-only; для Fork, который создаёт ветки на GitHub, — Read and write). Учётные данные
     хранит Git в хранилище Windows, приложение их не сохраняет. Затем «Загрузить».
   - **Адрес из папки на диске** — ваш клон (например `E:\demz-odoo-19\repositories\demz-odoo`): мастер прочитает из
     него адрес, дальше — как по адресу. Папка нужна ещё для поиска вашего контейнера Odoo (Generic, DEMZ) и как
     подсказка для «своей папки» веток Development.
3. Мастер найдёт GitHub, корни модулей, файл списка модулей, версию Odoo по манифестам, а если Odoo уже запущен в
   Docker и монтирует вашу папку — образ, сеть, монтирования и Postgres. `.env` мастер не читает. Пресеты:
   - **Odoo в Docker** (рекомендуется, если своего Odoo в Docker нет) — приложение само поднимает официальный образ
     `odoo:<версия>` и свой Postgres (`bm-<проект>-db`, порт на `127.0.0.1`). Выберите версию Odoo (16.0–19.0) и,
     при необходимости, Odoo Enterprise: папка с репозиторием `odoo/enterprise` или клонирование по адресу (только
     ветка нужной версии). Enterprise монтируется только для чтения, в новые БД ставится `web_enterprise`.
   - **Generic Odoo** — существующий Odoo в Docker, найденный мастером: образ, монтирования и команда берутся из его
     контейнера.
   - **DEMZ** — проект DEMZ.

   Во всех пресетах у нового проекта свой Postgres приложения: контейнер `bm-<проект>-db` в сети `bm-<проект>`
   (`postgres.mode: managed`). Остановка или удаление вашего стенда ветки не ломает. Для Generic и DEMZ берутся образ
   найденного Postgres (сохраняются расширения, например pgvector), его пользователь, имя в сети (`db`) и пароль,
   поэтому ваш `odoo.conf` работает без правок. Чтобы работать с Postgres стенда, поставьте в YAML
   `postgres.mode: external`, порт стенда и его сеть в `runtime.network`. Перед созданием такого проекта мастер
   проверяет подключение.
4. Проверьте значения и YAML, нажмите «Создать проект». Первый fetch разложит ветки по правилам. Сразу готовится свой
   Postgres проекта, для «Odoo в Docker» — ещё и образ Odoo (первая загрузка — несколько минут).
5. Production: если папка бэкапов (`production.backups.dir`) не задана, Rebuild создаёт чистую БД с вашими модулями.
   Для зеркала прода: ветка Production → вкладка Backups → «Импортировать» бэкап (`.zip`). Из копии Production
   собираются ветки Development, если у них `database: copy:production` (так у DEMZ).

## Как разрабатывать

- Обычный путь, как на odoo.sh: правка в своём клоне → коммит → push. Приложение подхватит коммит при fetch (раз в
  `repo.fetchIntervalMin` минут или кнопкой «Обновить») и соберёт ветку по правилам стадии.
- Быстрый путь для ветки Development: вкладка Editor → «Из моей папки» → папка вашего клона → «Сохранить» и
  «Применить» (или Rebuild). Сборка монтирует вашу папку как есть: Restart показывает правки Python без коммита, новый
  коммит в папке запускает обновление сборки. Собирается та ветка, что открыта в папке. Приложение только читает папку.
- Fork создаёт новую ветку на GitHub и собирает её в Development.

Проекты, добавленные до этой версии, работали внутри вашего репозитория. Для них сборки и fetch отключены: удалите
проект (Settings → «Удалить проект…») и добавьте заново.

## Как всё удалить

1. Settings → «Удалить проект…» у каждого проекта. Проект удаляется полностью: контейнеры, БД, filestore, папки
   веток, копия репозитория, compose-файлы, логи, файл настроек и записи в реестре (в Audit Logs остаётся одна запись
   об удалении). Ваш репозиторий и ветки на GitHub не трогаются. Остатки после сбоев показываются на Status в
   «Сиротах», там их можно удалить после подтверждения.
2. Остановите и удалите Traefik: `docker compose -p bm-traefik down`. Postgres проектов «Odoo в Docker» удаляется
   вместе с проектом (Settings → «Удалить проект…»), вручную — `docker compose -p bm-<проект>-db down -v`.
3. Закройте приложение (трей → Выход) и удалите папки `%APPDATA%\Odoo Branch Manager` и
   `%LOCALAPPDATA%\Odoo Branch Manager`. Установленную версию удалите через «Приложения» Windows.
4. Ваш git-репозиторий, его ветки и контейнеры проекта (например `odoo19`, `odoo19-db`) приложение не трогает.

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

## Обновления

Приложение сверяется с релизами GitHub-репозитория `bakum/bakum_sh` (настройка `updates.repository` в `app.yaml`).

- Автоматически: через несколько секунд после запуска (`updates.checkOnStart`, по умолчанию включено). Если есть
  новая версия, появятся баннер и уведомление Windows. Кнопка «Пропустить версию» отключает напоминания об этой
  версии при запуске.
- Вручную: Settings → Приложение → «Проверить обновления», ссылка в нижней строке окна или пункт меню трея.
- «Обновить» скачивает установщик и проверяет его по размеру и SHA-256 из релиза. Затем приложение полностью
  закрывается (если идут задачи — спросит, дождаться их или прервать) и запускает установщик. Контейнеры сборок, базы
  и настройки не затрагиваются.
- Portable-версия открывает страницу релиза, новую версию нужно скачать вручную.
- Предварительные версии (pre-release) предлагаются, только если включено `updates.includePrerelease`.

Чтобы выпустить версию, которую получат установленные копии: `pnpm release …`, `pnpm package`, затем релиз на GitHub
с тегом `vX.Y.Z` и файлом `Odoo-Branch-Manager-Setup-X.Y.Z.exe`.

## Устройство

- `apps/desktop` — Electron: main (окно, трей, уведомления, запрет сна, перезапуск Core), preload (`window.bm`),
  renderer (React, Mantine, TanStack Query, dnd-kit, Monaco, xterm.js).
- `packages/core` — Core в `utilityProcess`: проекты и настройки, очередь задач, git, Docker (compose CLI и dockerode),
  Postgres, SQLite (Drizzle), согласование состояния. Не зависит от Electron.
- `packages/shared` — zod-схемы настроек (раздел 9) и IPC-контракта (раздел 10).

UI и Core общаются через MessagePort. Если Core падает, main перезапускает его, а UI показывает баннер.

---

© 2026 Bakum Viacheslav
