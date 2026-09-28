# ТЗ: DEMZ Branch Manager — локальный odoo.sh

## 1. Назначение

Десктопное приложение (Electron, Windows 10 + Docker Desktop), которое повторяет odoo.sh локально: проект
привязывается к git-репозиторию, ветки раскладываются по стадиям **Production / Staging / Development**, на каждую
ветку собирается изолированная сборка (контейнер Odoo + своя БД + свой код), открывается по ссылке
`http://<slug>.localhost`, имеет историю сборок, логи, почту, бэкапы и настройки.

Всё, что в DEMZ было «зашито» (пути, образ, сеть, имена БД, список модулей, SQL отвязки лицензии, правила веток),
задаётся в настройках проекта. DEMZ — один из проектов, его значения собраны в **пресет** (раздел 9.3).

Не входит в задачи: работа с настоящим продом и odoo.sh, деплой, push / удаление веток в GitHub без явного действия
пользователя, многопользовательский режим, доступ по сети, апгрейд версий Odoo (вкладка Upgrade odoo.sh).

### 1.1 Соответствие odoo.sh

| odoo.sh | Локально |
|---|---|
| Проект, подключённый к GitHub-репозиторию | Проект = локальный клон репозитория (+ `origin` на GitHub для ссылок, PR, fetch) |
| Push в GitHub запускает сборку | `git fetch` по таймеру / кнопке (стадии, следящие за `origin`) или новый локальный коммит (Development) |
| Production — боевая БД | **Зеркало прода**: БД восстановлена из бэкапа прода и нейтрализована. К настоящему проду приложение не подключается |
| Staging — копия продакшн-БД | Копия БД зеркала прода + `-u` изменённых модулей |
| Development — чистая БД с модулями и тестами | Чистая БД с «моими модулями» и тестами, или копия прода/стейджинга — по настройке |
| Перетаскивание ветки между стадиями | То же, в боковой панели |
| History / Connect / Rebuild | То же. Connect открывает сборку во внешнем браузере |
| Shell / Editor / SQL / SSH | Windows Terminal (`docker exec` bash, `odoo shell`, `psql`) / VS Code, Cursor |
| Mails | Mailpit: письма сборки перехватываются, наружу ничего не уходит |
| Backups | Снапшоты БД сборки; для Production — импорт бэкапов прода |
| Monitor / Logs | docker stats + access-лог Traefik / логи контейнера и сборки |
| Merge / Fork | PR через `gh` (или ссылка compare на GitHub) / новая ветка от текущей |
| Builds / Status / Audit Logs / Settings | Те же страницы верхнего меню |

## 2. Понятия

- **Проект** — git-репозиторий + рантайм Odoo (образ, монтирования, Postgres) + настройки стадий. Проектов несколько,
  переключение — селектором в шапке, как на odoo.sh.
- **Стадия** — Production (ровно одна ветка), Staging (несколько), Development (все остальные добавленные ветки).
  Стадия задаёт поведение по умолчанию: откуда БД, что делать с новым коммитом, запускать ли тесты, когда удалять сборку.
- **Ветка проекта** — ветка репозитория, добавленная в проект (вручную, перетаскиванием или автоматически по правилу).
- **Сборка (build)** — результат обработки конкретного коммита ветки: БД, filestore, контейнер, логи, итог тестов.
  Живая сборка у ветки одна (последняя успешная), предыдущие переходят в **DROPPED**: запись в истории, логи и итоги
  тестов остаются, БД и контейнер удаляются.
- **Зеркало прода** — живая сборка ветки стадии Production. Её БД — источник для копий в Staging и Development.

## 3. Архитектура

```
┌────────────── Electron-приложение (single-instance) ─────────────────────────────┐
│  Renderer: React SPA ── preload (contextBridge: window.bm, типизированный API)   │
│                │ MessagePort                                                     │
│  Main: окно, трей, уведомления, диалоги, запуск браузера / VS Code / терминала,  │
│        автозапуск, запрет сна при сборках, перезапуск Core                       │
│                │ MessagePort                                                     │
│  Core (utilityProcess, Node.js): проекты, очередь сборок, планировщик fetch,     │
│        git CLI, docker compose CLI + dockerode, node-postgres, SQLite            │
└──────────────────────────────────────────────────────────────────────────────────┘
 Docker:
   traefik (общий для всех проектов)  ── <host сборки> → odoo-контейнер сборки :8069
                                      ── mail-<host сборки> → mailpit сборки :8025
   на каждую живую сборку: compose-проект bm-<project>-<slug> (odoo [+ mailpit])
   Postgres: внешний контейнер проекта (DEMZ: odoo19-db) или управляемый приложением
```

- **Core** в `utilityProcess`: тяжёлая работа не подвешивает окно. Если Core упал, main перезапускает его, Core
  выполняет согласование состояния (8.12).
- **Renderer** изолирован (`contextIsolation`, `sandbox`, CSP), доступ только через `window.bm`.
- **Нет HTTP-сервера**: UI ↔ Core по IPC. Никакая страница в браузере не может дёрнуть destructive-операции.
- **Контейнеры — через `docker compose`**: `<dataDir>/projects/<project>/branches/<slug>/compose.yml`, проект
  `bm-<project>-<slug>`, всё видно в `docker compose ls`. Статус, логи, events, stats — dockerode
  (`//./pipe/docker_engine`). Принадлежность ресурсов — **docker-метки** `bm.project`, `bm.branch`, `bm.build`
  и реестр в SQLite, а не только префиксы имён.
- **Traefik** — один на все проекты, подключается к сети каждого проекта, docker provider,
  `exposedbydefault=false`, порт `proxyPort` (80, при занятости 8080). Разные хосты `*.localhost` нужны, чтобы cookie
  `session_id` сборок не затирали друг друга; браузеры резолвят `*.localhost` в 127.0.0.1 сами.
- **Внешние вызовы в работающее приложение** (git-хуки, будущий CLI): повторный запуск exe с аргументами
  (`--hook <name> ...`); single-instance lock передаёт `argv` в работающий экземпляр. Если приложение не запущено,
  вызов с `--hook` завершается без открытия окна.

## 4. Стек

| Слой | Технологии |
|---|---|
| Десктоп | Electron (стабильная), `electron-vite`, `electron-builder` (NSIS per-user и portable; без подписи и автообновления) |
| UI | React 19, TypeScript, TanStack Query (queryFn → `window.bm`), React Router (`HashRouter`), Mantine, `@dnd-kit` (перетаскивание веток), xterm.js (просмотр логов), Monaco (YAML-редактор настроек) |
| Core | Node.js из Electron, TypeScript, `dockerode`, `execa` (git / docker compose / gh), `pg`, `better-sqlite3` + Drizzle, `zod` (конфиг и IPC), `pino`, `croner` (расписания), `chokidar` (папка бэкапов, HEAD worktree) |
| IPC | контракт в `packages/shared`: zod-схемы методов и событий |
| Реалтайм | события по MessagePort: статусы, прогресс сборок, логи (пачками раз в ~100 мс, пока открыт экран) |
| Структура | pnpm workspaces: `apps/desktop`, `packages/core` (без зависимости от Electron), `packages/shared`. `pnpm dev / build / start / package` |
| Тесты | Vitest для `packages/core` под `ELECTRON_RUN_AS_NODE=1` (одна сборка `better-sqlite3` под ABI Electron): slug, шаблоны имён, слияние уровней настроек, выбор стадии, парсинг логов Odoo, определение модулей. Интеграция на реальном Docker — ручной чек-лист (раздел 13) |

## 5. Модель данных (SQLite)

- **Project**: `id` (`[a-z0-9-]`, входит в имена ресурсов), `name`, `configPath`, `repoPath`, `enabled`, `createdAt`.
- **Branch**: `id`, `projectId`, `name`, `slug` (уникален в проекте), `stage` (`production | staging | development`),
  `assignedBy` (`user | rule`), `worktreePath`, `tracking` (`local | remote`), `overrides` (JSON, раздел 9),
  `protected` (bool), `lastSeenRemoteSha`, `lastActiveAt`, `createdAt`.
- **Build**: `id`, `branchId`, `number` (сквозной в ветке), `commitSha`, `commits[]` (sha, автор, сообщение — для History),
  `trigger` (`new_commit | rebuild | manual | import_backup | stage_change`), `kind` (`new | update`),
  `dbSource` (`backup:<file> | copy:<branch>#<build> | fresh`), `dbName`, `debugPort`, `status`
  (`queued | building | running | stopped | failed | dropped`), `tests` (`{passed, failed, errors, failures[]} | null`),
  `steps[]` (`name`, `status`, `startedAt`, `finishedAt`), `logPath`, `configHash`, `createdAt`, `finishedAt`,
  `droppedAt`, `errorMessage`.
- **Job**: очередь операций (`build | start | stop | restart | drop | delete_branch | snapshot | restore_snapshot | import_backup | fetch`),
  `status` (`queued | running | success | failed | cancelled | interrupted`), ссылки на `buildId?` / `branchId?`.
- **Snapshot**: `id`, `buildId`, `name`, `dbName`, `filestorePath`, `sizeBytes`, `createdAt`.
- **AuditLog**: `id`, `projectId?`, `at`, `action`, `target`, `params` (JSON), `result`, `diff` (для настроек).
- Настройки — YAML-файлы (раздел 9), в SQLite только кэш вычисленного `configHash`.

## 6. Интерфейс (как odoo.sh)

**Шапка**: логотип · Branches · Builds · Status · Audit Logs · Settings · справа селектор проекта, колокольчик
уведомлений, индикатор Docker.

**Боковая панель** (страница Branches): поиск «Filter branches…»; группы **Production** / **Staging** / **Development**
с кнопками «+». Строка ветки: имя, версия Odoo (из образа проекта или ветки), кружок статуса живой сборки:
зелёный — работает, тесты ок; оранжевый — предупреждения тестов; красный — сборка или тесты упали;
серый — сборка остановлена; пустой — сборки нет; спиннер — идёт сборка.
- Перетаскивание ветки в другую стадию меняет стадию (подтверждение; в Production — с предупреждением, что текущая
  продакшн-ветка уйдёт в Staging и что это пересоздаст зеркало прода).
- Перетаскивание ветки **на другую ветку** — диалог Merge (8.10).
- «+» у Staging / Development: добавить существующую ветку (список `origin/*` и локальных) или Fork.

**Страница ветки**: заголовок — имя ветки; справа кнопки **Clone** (копировать путь worktree / команду clone),
**Fork**, **Merge**, **Terminal**, **SQL**, **Delete**; вкладки **History · Shell · Editor · Monitor · Logs · Mails ·
Backups · Tools · Settings**; кнопки **Rebuild** и **GitHub**.

**Контекстное меню** ветки в панели (правый клик) дублирует основные действия: Connect, Rebuild, Start/Stop, VS Code,
Логи, Сменить стадию.

## 7. Трей, уведомления и прочее десктопное

- **Один экземпляр**: повторный запуск фокусирует окно.
- **Трей**: иконка отражает общее состояние (ок / идёт сборка / ошибка). Меню: проекты → ветки с живыми сборками
  (Connect, Start/Stop, VS Code, Логи), «Показать окно», «Остановить все сборки», «Выход».
- **Закрытие окна** (`closeToTray`, по умолчанию вкл.) прячет его в трей, сборки продолжаются. «Выход» при активных
  задачах спрашивает: дождаться / отменить / остаться. Контейнеры при выходе не останавливаются.
- **Уведомления Windows**: сборка готова, сборка / тесты упали, новый бэкап прода найден, мало места. Клик открывает
  нужную вкладку или Connect. Каждый тип отключается.
- **Запрет сна** (`powerSaveBlocker`) на время сборок.
- **Docker Desktop не запущен** → баннер с кнопкой «Запустить», ожидание движка, согласование.
- **Автозапуск с Windows** (`autostart`, `startMinimized`).
- **Окно** запоминает размер, положение, последний проект и ветку; минимум 1100×700.
- **Горячие клавиши**: `Ctrl+K` — поиск ветки, `Ctrl+R` — fetch, `F5` — обновить экран.
- **Мастер первого запуска** и **мастер добавления проекта** (8.1).

## 8. Функциональные требования

### 8.1 Проекты

- **Добавить проект**: выбрать папку репозитория (нативный диалог) → автоопределение:
  - `origin` и GitHub-репозиторий (`owner/name`) для ссылок и PR;
  - корни модулей (каталоги с `__manifest__.py` на глубине до 3) и файл списка модулей;
  - `docker-compose.yml` / `Dockerfile` / `odoo.conf` выше по дереву → образ, сеть, монтирования, путь репозитория в контейнере;
  - запущенный Postgres в этой сети;
  - кандидат на Production (`master`, `main` или ветка вида `<версия>`, например `19.0`).
  Пользователь подтверждает или правит значения, выбирает пресет (Generic Odoo / DEMZ / из файла).
- Несколько проектов одновременно; имена всех ресурсов содержат `{project}` или проверяются на уникальность между проектами.
- Экспорт / импорт настроек проекта (YAML без паролей и локальных путей по выбору), «Клонировать проект».
- Отключение проекта (`enabled: false`): останавливает fetch и триггеры, сборки не трогает.
- Удаление проекта: список всех ресурсов (сборки, БД, filestore, worktree) с подтверждением; git-репозиторий не трогается.

### 8.2 Стадии и ветки

- Production — ровно одна ветка. Staging и Development — сколько угодно (с учётом лимитов).
- Появление ветки в проекте:
  - вручную: «+» или перетаскивание из списка «Не добавлены»;
  - **правилами** проекта `branchRules` (сверху вниз, первое совпадение): `match` (glob / regex / список), `stage`
    (`staging | development | ignore`), `overrides`. Пример (DEMZ): `19.0-demz-crm`, `19.0-demz-prerelease` → Staging,
    `backup/*` → ignore, остальные → Development.
  - `autoAddBranches`: `none` | `rules` (только совпавшие с правилами) | `all` (все новые `origin/*`: стадия по правилам,
    без совпадения — Development, как на odoo.sh). `ignore` действует в любом режиме.
- Ручное перемещение фиксирует стадию (`assignedBy=user`), правила её больше не меняют. «Сбросить к правилу» — в Settings ветки.
- Смена стадии не пересоздаёт сборку сама: показывается «настройки стадии изменились — Rebuild».
- **Код ветки**:
  - `tracking: remote` (по умолчанию для Production и Staging): worktree `--detach` на `origin/<branch>`, при каждой сборке
    `git checkout --detach <sha>`. Не нужна локальная ветка, нет конфликта с основным чекаутом. Если в worktree есть
    незакоммиченные правки, авто-сборки ветки приостанавливаются с бейджем, ничего не затирается.
  - `tracking: local` (по умолчанию для Development): worktree с локальной веткой (существующая — как есть; удалённая —
    `--track -b <b> origin/<b>`; новая — `-b <b> <base>`). Код редактируется прямо в worktree, Restart подхватывает
    Python-правки без коммита. Одна ветка — один worktree (ограничение git): если ветка в основном чекауте — понятная ошибка
    с предложением переключиться на `tracking: remote`.
- `slug`: из имени ветки по шаблону `naming.slug`, затем удаляется префикс `naming.slugStrip` (regex, необязательно),
  нижний регистр, любые символы вне `[a-z0-9]` (`/`, `_`, `.`) → `-`, повторные `-` схлопываются, до 40 символов,
  коллизия → суффикс `-2`. Примеры (DEMZ): `19.0-demz-crm` → `crm`, `19.0-eusign_cp` → `19-0-eusign-cp`,
  `demz-roman` → `demz-roman`. У Production slug задаётся явно (`production.slug`, DEMZ — `prod`).

### 8.3 Сборки

**Триггеры**:
- **новый коммит**: для `tracking: remote` — сдвиг `origin/<branch>` после fetch (`fetchIntervalMin`, кнопка «Обновить»,
  хук `--hook fetch`); для `tracking: local` — изменение HEAD worktree (`chokidar` на `.git/worktrees/<name>/HEAD` и refs,
  плюс опрос раз в 30 с);
- **Rebuild** — кнопка;
- **import_backup** — только Production (8.4);
- **stage_change** — по кнопке после смены стадии.

**Поведение на новый коммит** (`onNewCommit`, по стадиям, переопределяется в ветке):

| Значение | Что делает |
|---|---|
| `none` | бейдж «есть несобранные коммиты» и кнопка |
| `update` | обновить живую сборку: stop → `-u` модулей по `updateModules` → start. БД сохраняется |
| `new` | новая сборка: новая БД из источника стадии, после успешного healthcheck предыдущая сборка → DROPPED |

При force-push в ветку с `tracking: remote` (`onForcePush`): `pause` (по умолчанию — бейдж и ожидание решения) | `new`.

**Шаги сборки** (каждый — запись в `Build.steps`, прогресс и лог в UI; до и после каждого шага можно повесить хуки, 8.14):
1. **code** — подготовить worktree и зафиксировать `commitSha`, собрать список коммитов с предыдущей сборки (для History).
2. **port** — `debugPort`: первый свободный из общего `debugPortRange` (на все проекты), проверка занятости на хосте.
3. **database** — по `database` стадии/ветки:
   - `backup` (только Production, 8.4);
   - `copy:production` / `copy:<branch>` — копия БД живой сборки ветки. Метод `cloneMethod`:
     `template` — `pg_terminate_backend` + `CREATE DATABASE "<db>" TEMPLATE "<src>" OWNER <user>`, исходный контейнер
     останавливается на время копирования (по умолчанию); `dump` — `pg_dump | pg_restore` без остановки источника (медленнее);
   - `fresh` — пустая БД, модули ставятся на шаге 6 по `install`: `my` (модули из `modulesToInstall`, по умолчанию),
     `roots` (все модули из `moduleRoots`), `list: [...]`, `full`; `withDemo: true|false`.
4. **filestore** — `cp -al filestore/<src> filestore/<db>` одноразовым контейнером образа (хардлинки: вложения Odoo
   неизменяемы); если не поддерживаются — `cp -a` (`filestoreCopy: hardlink | copy`). Для `fresh` — пустой каталог.
5. **local-tweaks** — `web.base.url` = адрес сборки; `ir_mail_server` → Mailpit сборки (если `mails.enabled`); пароль
   `admin` = `connect.adminPassword` (если задан); `extraSql` из настроек. Каждый пункт отключается.
6. **modules** — `docker compose run --rm odoo odoo -d <db> [-i <новые>] [-u <изменённые>] --stop-after-init`
   (8.7). Для `fresh` — `-i` по `install`. Если `tests.mode` требует, тесты идут здесь же (`--test-enable`, 8.8).
7. **tests** — для копий БД: на временной копии `<db>_test` (8.8).
8. **up** — `docker compose up -d`, healthcheck (`healthcheck.path`, по умолчанию `/web/login` → 200, `healthcheck.timeoutSec` 180).
9. **finalize** — статус `running`, предыдущая сборка → DROPPED (при `kind=new`), `lastDeployedCommit`, уведомление.

Ошибка на шаге: сборка `failed`, лог и текст сохраняются; предыдущая живая сборка **не трогается** (продолжает работать).
Кнопки «Повторить с шага» и «Отбросить сборку». Частично созданные ресурсы удаляются только через «Отбросить».

**Жизненный цикл**: `idleStopHours` — остановка без HTTP-активности (по access-логу Traefik); `dropAfterDays` —
отбросить живую сборку ветки без новых коммитов и активности (как «This staging build will be deleted on…» на odoo.sh,
дата показывается в History); `0` — никогда. Worktree при этом не удаляется.

**Очередь**: одна активная задача на ветку, остальные ждут. `maxParallelBuilds` (по умолчанию 2) — глобально на все проекты,
`maxRunningBuilds` (по умолчанию 4) — предупреждение, а при `enforce: true` — отказ в запуске.

### 8.4 Production — зеркало прода

- Ветка Production собирается из **бэкапа прода**: `backups.dir` + `backups.pattern`, файл выбирается `backups.pick`
  (`latest` по дате / вручную), либо «Выбрать файл…» / перетаскивание в окно (файл монтируется в одноразовый контейнер
  только для чтения, не копируется).
- Восстановление: `.zip` — `odoo db load -f -n <db> /backups/<file>`; `.dump` — `CREATE DATABASE` + `pg_restore --no-owner`
  + `odoo neutralize -d <db>`. Особенность Odoo 19 CLI: перед подкомандами (`db`, `neutralize`) не передавать `-c`,
  конфиг берётся из `/etc/odoo/odoo.conf`.
- **Нейтрализация обязательна**, в UI не отключается. Затем `postRestore.sql` (DEMZ: отвязка лицензии) и
  `postRestore.verifySql` (должен вернуть 0 строк / 0) — при несоответствии сборка `failed`.
- Затем шаг `modules`: `-u` по `production.updateModules` (DEMZ: установленные `td_*`, `ata_*`, `demz_*`) кодом ветки.
- `onNewCommit` по умолчанию `update` (проверка «как ляжет деплой на прод»). Новый бэкап — только `import_backup`:
  вручную (вкладка Backups) или автоматически при появлении файла в `backups.dir` (`backups.autoImport`, по умолчанию выкл.,
  уведомление «найден новый бэкап» есть всегда).
- Импорт бэкапа не трогает Staging и Development. У их сборок показывается «зеркало прода новее вашей БД» с кнопкой Rebuild.
- Метка в UI: **«Зеркало прода (локально)»**, чтобы не путать с боевым сервером.

### 8.5 Staging

- БД по умолчанию `copy:production`, `onNewCommit: update`, `tracking: remote`, тесты `changed`, `idleStopHours: 0`,
  `dropAfterDays: 30`.
- **Rebuild** = новая сборка из свежей копии зеркала прода (как на odoo.sh).
- Ветки стадии защищены (`protected: true`): Delete требует снять защиту в Settings ветки.

### 8.6 Development

- По умолчанию (как на odoo.sh): `database: fresh`, `install: my`, `withDemo: true`, тесты `changed` на этапе установки,
  `onNewCommit: new`, `tracking: local`, `idleStopHours: 8`, `dropAfterDays: 14`.
- Любой параметр меняется на уровне стадии или ветки: например, `database: copy:production` или `copy:<staging-ветка>`,
  `onNewCommit: update`.

### 8.7 Модули для `-u` / `-i`

- Изменённые файлы: `git diff --name-only <from> <to>`. Для `update` — от коммита живой сборки; для копии БД — от коммита
  сборки-источника (`copy:<branch>`) до коммита новой сборки.
- Модуль файла — ближайший родительский каталог с `__manifest__.py` в пределах `moduleRoots` (пусто — весь репозиторий).
- `updateModules`: `changed` (по умолчанию) | `version-bumped` (изменился `version` в манифесте, как на odoo.sh) | `all` | `list: [...]`.
- Установленные в БД (`ir_module_module.state = 'installed'`) → `-u`; не установленные и есть в `modulesToInstall` → `-i`;
  остальные — «не установлен», без действия. Удалённые модули — предупреждение, автоматически не удаляются.
- Проверка результата: в `ir_module_module` нет модулей в `to upgrade` / `to install`.

### 8.8 Тесты

- `tests.mode`: `none` | `changed` (модули из 8.7) | `my` | `list: [...]`; `tests.tags` — шаблон `--test-tags`
  (по умолчанию `/{module}`), `tests.extraArgs`.
- `fresh`: тесты во время `-i` на шаге 6. Копии БД: `run --rm odoo odoo -d <db>_test --test-enable --stop-after-init -u <modules>
  --test-tags ...` на временной копии `<db>_test`, которая удаляется после прогона.
- Парсинг лога: итоговая строка Odoo `... tests ... failed, ... error(s) of ... tests`, записи `FAIL:` / `ERROR:` с traceback,
  `WARNING` → оранжевый статус. Результат — в `Build.tests`, бейдж «Test: Success / Failed» в History, цвет кружка в панели.
- `tests.failBuild`: `false` (по умолчанию — сборка поднимается, статус красный) | `true` (сборка не поднимается, живой остаётся предыдущая).

### 8.9 Вкладки страницы ветки

| Вкладка | Содержимое |
|---|---|
| **History** | лента сборок по датам: автор, время, коммиты (сообщение + sha, «N commits more»), тип и источник БД, «Test: Success/Failed», длительность; у живой — **CONNECT** (▾: открыть, открыть в режиме отладки `?debug=1`, скопировать логин/пароль admin, скопировать URL), у старых — DROPPED; дата авто-удаления; пагинация |
| **Shell** | Windows Terminal: `docker exec -it <container> bash`, `odoo shell -d <db>` (▾) |
| **Editor** | открыть worktree в VS Code / Cursor (CLI), в Проводнике |
| **Monitor** | CPU / RAM контейнера (docker stats), число запросов и время ответа (access-лог Traefik), размер БД и filestore; за последний час |
| **Logs** | `odoo.log` (живой `docker logs -f`), `build.log` (шаги сборки), `tests.log`; фильтр по уровню, поиск, подсветка traceback, «Сохранить как…», «В отдельном окне» |
| **Mails** | встроенный UI Mailpit сборки (или открыть `mail-<host>` в браузере); счётчик новых писем в заголовке вкладки |
| **Backups** | снапшоты живой сборки: создать (`CREATE DATABASE <db>_snap_<n> TEMPLATE <db>` + `cp -al` filestore), откатить, удалить, выгрузить в Odoo-формат `.zip` (`odoo db dump`); для Production — список бэкапов прода и «Импортировать» |
| **Tools** | `psql` в терминале, строка подключения к БД (без пароля на экране — копирование), сбросить пароль admin, установить / обновить модули вручную, Debug: `debugPort`, «Скопировать launch.json» и «Добавить в `.vscode/launch.json` worktree» (attach, `pathMappings` из настроек проекта; существующий файл дополняется через `jsonc-parser`, комментарии сохраняются; предупреждение, если `.vscode/` не в `.gitignore`) |
| **Settings** | настройки ветки: стадия (и «Сбросить к правилу»), `onNewCommit`, `database`, `install`, `updateModules`, тесты, образ Odoo, переменные окружения, `idleStopHours`, `dropAfterDays`, защита. Каждое поле показывает действующее значение и уровень, откуда оно взято (9.1) |

Кнопки: **Rebuild** (новая сборка по правилам стадии), **GitHub** (ветка / её PR на GitHub), Start / Stop / Restart
(в ▾ у Connect и в контекстном меню).

### 8.10 Merge, Fork, Delete

- **Fork**: имя новой ветки (по `naming.branch`, 9.3) → `git branch <new> <sha живой сборки или HEAD>` → ветка в Development
  → сборка по настройкам. «Push -u origin» — отдельной кнопкой или чекбоксом в диалоге.
- **Merge** (кнопка или перетаскивание ветки на ветку): создать PR `head=<source>` → `base=<target>` через `gh pr create`
  (заголовок и тело по шаблону, `Closes #{issue}` если номер задачи найден в имени). Кнопка Merge без перетаскивания
  предлагает цели из `naming.pr.targets` (DEMZ: `19.0-demz-crm`, затем `19.0`) и отмечает, в какие из них ветка уже
  влита. Без `gh` — открыть
  `https://github.com/<owner>/<repo>/compare/<target>...<source>`. **Локальный merge и push в ветки из `protectedBranches`
  не выполняются.**
- **Delete** (подтверждение вводом slug): отбросить все живые сборки и снапшоты, `git worktree remove` (если есть
  незакоммиченные изменения — показать `git status --porcelain` и требовать отдельного подтверждения); чекбоксы
  «удалить локальную ветку» (`git branch -d`, без `-D`) и «удалить ветку в origin» (выкл. по умолчанию, недоступно для
  `protectedBranches`, Production и Staging). История сборок остаётся в Audit Logs.

### 8.11 Страницы верхнего меню

- **Builds** — все сборки проекта: ветка, стадия, коммит, триггер, статус, тесты, длительность, начало; фильтры.
- **Status** — Docker, Postgres, Traefik, `gh auth status`, свободное место, живые сборки / лимит, последние fetch по проектам,
  ошибки согласования.
- **Audit Logs** — все действия приложения и пользователя: сборки, смены стадий, merge / fork / delete, изменения
  настроек (diff YAML), импорты бэкапов.
- **Settings** — настройки проекта (9), вкладки: Репозиторий, Стадии и правила, Рантайм, Postgres, Данные (Production),
  Модули и тесты, Сборки и ресурсы, Почта, Хуки, Интеграции, YAML.

### 8.12 Ресурсы и обслуживание

- Сводка на Status: общий размер БД и filestore сборок, число контейнеров, RAM.
- Предупреждения: живых сборок больше `maxRunningBuilds`, свободного места меньше `minFreeDiskGb` (20).
- **Очистка сирот**: БД по шаблонам имён проектов без записи в реестре, каталоги filestore, compose-проекты и контейнеры
  с метками `bm.*`, worktree в `worktreesDir` без записи — список и удаление по подтверждению.
- **Согласование при старте и после перезапуска Core**: реестр SQLite сверяется с `docker compose ls`, метками контейнеров,
  `git worktree list`, списком БД. Расхождения показываются, не удаляются молча. Незавершённые задачи → `interrupted`,
  их сборки → `failed`.

### 8.13 Почта сборок

- `mails.enabled` (по умолчанию вкл. для Staging и Development, выкл. для Production): в compose сборки добавляется
  контейнер `axllent/mailpit`, на шаге local-tweaks создаётся активный `ir_mail_server` → `mailpit:1025`.
  Нейтрализованные почтовые серверы прода остаются выключенными.
- UI Mailpit доступен через Traefik (`mail-<host>`) и во вкладке Mails.

### 8.14 Хуки

- Точки: `before:<step>` / `after:<step>` для каждого шага сборки, `afterImportBackup`, `beforeDrop`.
- Виды действий: `sql` (файл или текст, в БД сборки), `odoo-shell` (python-файл в `odoo shell -d <db>`),
  `container` (команда в одноразовом контейнере образа с монтированиями сборки), `host` (команда на хосте — массив
  аргументов, без shell-строки, рабочая папка — worktree).
- Параметры: `timeoutSec`, `onError: fail | warn`, `stages` / `branches` (фильтр). Переменные подставляются (9.2).

## 9. Настройки

### 9.1 Уровни

`приложение` → `проект` → `стадия` → `правило ветки` → `ветка`. Нижний уровень переопределяет верхний (объекты сливаются
по ключам, списки заменяются). В UI у каждого поля видно действующее значение и уровень-источник, есть «Сбросить».

Файлы:
- `%APPDATA%\DEMZ Branch Manager\app.yaml` — уровень приложения (десктоп, лимиты, Traefik, пути программ);
- `%APPDATA%\DEMZ Branch Manager\projects\<project>.yaml` — проект, стадии, правила;
- переопределения ветки — в SQLite (`Branch.overrides`), видны и редактируются в Settings ветки и во вкладке YAML.

Правка через формы или YAML-редактор (Monaco со схемой, автодополнением и проверкой zod). Правка файла руками
подхватывается автоматически. Если меняются параметры, влияющие на живые сборки (образ, монтирования, команда,
переменные), у сборок появляется «конфигурация изменилась» (сравнение `configHash`) с кнопкой «Применить»
(пересоздать контейнер без пересборки БД) или Rebuild.

### 9.2 Переменные в шаблонах

`{project}`, `{branch}`, `{slug}`, `{slug_}` (slug с `_`), `{stage}`, `{build}` (номер сборки), `{issue}` и `{type}`
(из имени ветки по `naming.parse`), `{db}`, `{host}`, `{debugPort}`, `{worktree}`, `{repoMount}`, `{sha}`, `{shortSha}`.

### 9.3 Пример: проект DEMZ (пресет)

```yaml
# %APPDATA%\DEMZ Branch Manager\projects\demz.yaml
id: demz
name: DEMZ Odoo 19

repo:
  path: E:/demz-odoo-19/repositories/demz-odoo
  remote: origin
  github: DEMZ-UA/demz-odoo              # для ссылок и PR; gh CLI — если установлен и авторизован
  fetchIntervalMin: 5
  worktreesDir: E:/demz-odoo-19/worktrees
  protectedBranches: ['19.0', '19.0-demz-prerelease', '19.0-demz-crm']
  moduleRoots: [demzua, todoltd, exchange, oca, printer]
  modulesToInstall: demzua/modules_to_install.txt
  issueUrl: https://github.com/DEMZ-UA/demz-odoo/issues/{issue}

naming:
  slug: '{branch}'
  slugStrip: '^19\.0-demz-'              # 19.0-demz-crm → crm (http://crm.localhost)
  db: 'o19_br_{slug_}_{build}'
  host: '{slug}.localhost'               # для второго проекта: '{slug}.{project}.localhost'
  composeProject: 'bm-{project}-{slug}'
  parse: null                            # в именах веток DEMZ нет номера задачи; пример: '^(?<type>feature|fix)/(?<issue>\d+)-'
  branch:                                # диалоги Fork / «Новая ветка»
    pattern: '19.0-demz-{name}'
    base: '19.0'                         # или types: { <тип>: <базовая ветка> } вместе с '{type}' в pattern
    nameRegex: '^[a-z0-9-]+$'
  pr:
    title: '{branch}'
    body: ''                             # 'Closes #{issue}' — если parse находит номер задачи
    targets: ['19.0-demz-crm', '19.0']   # цели в диалоге Merge по порядку: сначала staging, потом production

runtime:
  image: demz-odoo-19-odoo               # или build: { context: E:/demz-odoo-19, dockerfile: Dockerfile }
  odooVersion: '19.0'
  network: demz-odoo-19_default
  repoMount: /mnt/repositories/demz-odoo # сюда монтируется worktree ветки (вложенный bind mount)
  mounts:
    - { host: E:/demz-odoo-19/repositories,       container: /mnt/repositories }
    - { host: E:/demz-odoo-19/enterprise,         container: /mnt/enterprise, readOnly: true }
    - { host: E:/demz-odoo-19/custom_addons,      container: /mnt/extra-addons }
    - { host: E:/demz-odoo-19/data/filestore,     container: /var/lib/odoo }
    - { host: E:/demz-odoo-19/data/backups,       container: /backups, readOnly: true }
    - { host: E:/demz-odoo-19/config/odoo.conf,   container: /etc/odoo/odoo.conf, readOnly: true }
  filestore: { hostDir: E:/demz-odoo-19/data/filestore, containerDir: /var/lib/odoo/filestore, copy: hardlink }
  env: { HOST: db }                      # USER / PASSWORD — из postgres
  command: [python3, -Xfrozen_modules=off, -m, debugpy, --listen, '0.0.0.0:5678',
            /usr/bin/odoo, -c, /etc/odoo/odoo.conf, -d, '{db}', '--db-filter=^{db}$', --proxy-mode]
  debug:
    containerPort: 5678
    pathMappings:
      - { local: '{worktree}', remote: /mnt/repositories/demz-odoo }
      - { local: E:/demz-odoo-19/enterprise, remote: /mnt/enterprise }
  healthcheck: { path: /web/login, timeoutSec: 180 }
  composeTemplate: null                  # свой шаблон compose (метки и сети приложение добавит само)

postgres:
  mode: external                         # external | managed (приложение поднимает свой контейнер)
  host: localhost
  port: 5433
  internalHost: db
  user: odoo
  password: odoo
  protectedDbs: [postgres, o19_test]
  protectedContainers: [odoo19, odoo19-db]

production:
  branch: '19.0'
  slug: prod                             # http://prod.localhost
  backups:
    dir: E:/demz-odoo-19/data/backups
    pattern: 'db-backup-o19-demz-prod-*.zip'
    pick: latest
    autoImport: false
  postRestore:
    sql: [E:/demz-odoo-19/scripts/sql/detach_production_license.sql]
    verifySql: >-
      SELECT count(*) FROM ir_config_parameter
      WHERE key IN ('database.enterprise_code', 'database.expiration_date', 'database.expiration_reason',
                    'database.already_linked_subscription_url', 'database.already_linked_email',
                    'database.already_linked_send_mail_url')   # список — из restore_production_backup.ps1
  updateModules: { installedMatching: ['td_*', 'ata_*', 'demz_*'] }

stages:
  production:
    onNewCommit: update
    tracking: remote
    tests: { mode: none }
    mails: { enabled: false }
    idleStopHours: 0
    dropAfterDays: 0
  staging:
    database: copy:production
    cloneMethod: template
    onNewCommit: update
    onForcePush: pause
    updateModules: changed
    tracking: remote
    tests: { mode: changed, failBuild: false }
    mails: { enabled: true }
    idleStopHours: 0
    dropAfterDays: 30
    protected: true
  development:
    database: copy:production            # на odoo.sh — fresh; DEMZ работает на данных прода
    install: my
    withDemo: false
    onNewCommit: update
    updateModules: changed
    tracking: local
    tests: { mode: changed }
    mails: { enabled: true }
    idleStopHours: 8
    dropAfterDays: 14

branchRules:                             # стадии как на odoo.sh проекта demz-ua-demz-odoo
  - { match: ['19.0-demz-crm', '19.0-demz-prerelease'], stage: staging }
  - { match: 'backup/*', stage: ignore }
  - { match: '*', stage: development }   # 19.0-demz-test1, 19.0-eusign_cp, demz-roman, 19.0-demz-perevertum, …
autoAddBranches: all

connect: { adminPassword: admin }        # только в копиях БД; пусто — не менять
extraSql: []
hooks: []
```

`app.yaml` (уровень приложения):

```yaml
dataDir: '%LOCALAPPDATA%/DEMZ Branch Manager'
proxyPort: 80
debugPortRange: [5700, 5799]
limits: { maxParallelBuilds: 2, maxRunningBuilds: 4, enforce: false, minFreeDiskGb: 20 }
desktop:
  autostart: false
  startMinimized: true
  closeToTray: true
  theme: system
  notifications: { buildReady: true, buildFailed: true, testsFailed: true, newBackup: true, lowDisk: true }
  browser: default                       # default | { exe: ..., args: [...] }
  editor: code                           # code | cursor | путь к CLI
  terminal: wt                           # wt | git-bash | cmd
  dockerDesktopExe: auto
  gh: auto
```

### 9.4 Пресеты

- **Generic Odoo**: `database: fresh`, `install: my`, `withDemo: true`, `onNewCommit: new` для Development — поведение odoo.sh
  по умолчанию; `postgres.mode: managed`.
- **DEMZ**: пример 9.3.
- Свой пресет — «Сохранить как пресет» из любого проекта (без паролей и локальных путей по выбору).

## 10. IPC-контракт (черновик)

Методы (`window.bm.<name>(params)` → Promise):

```
projects.list | get | detect {path} | create | update | delete | export | import | clone
config.get {projectId, level, branchId?} | config.put | config.effective {projectId, branchId}
branches.list {projectId}                  ветки по стадиям + неприсоединённые
branches.add {projectId, name, stage?} | branches.setStage {branchId, stage} | branches.resetToRule
branches.fork {branchId, name, push} | branches.merge {sourceId, targetId} | branches.delete {branchId, deleteLocal, deleteRemote}
branches.preview {projectId, branch}       какое правило и стадия совпадут
builds.list {projectId?, branchId?} | builds.get | builds.rebuild {branchId} | builds.retry {buildId, fromStep} | builds.drop
builds.action {buildId, action: start|stop|restart|apply-config}
builds.changedModules {branchId} | builds.writeLaunchJson {buildId}
backups.list {projectId} | backups.import {projectId, path}
snapshots.list | create | restore | delete | export
git.fetch {projectId?}
jobs.list | jobs.get | jobs.cancel
system.status | audit.list
shell.open {buildId, target: browser|browser-debug|explorer|editor|terminal|bash|odoo-shell|psql|mails|github}
```

Подписки (`window.bm.subscribe(topic, params, handler)` → отписка): `events` (статусы веток, сборок, задач),
`build.log {buildId}`, `container.log {buildId}`, `stats {buildId}`.

Мутирующие методы возвращают `jobId`. Ошибки — `{code, message, details}`. Все входящие сообщения валидируются zod в Core.

## 11. Нефункциональные требования

- **Безопасность**: приложение не открывает сетевых портов, кроме Traefik `proxyPort` и debug-портов сборок
  (публикуются Docker на `127.0.0.1`). Renderer изолирован, навигация окна и `window.open` запрещены; внешние ссылки —
  через `shell.openExternal` только для `http(s)://*.localhost`, `https://github.com/...`, `vscode://`, `cursor://`.
  Destructive-операции — с подтверждением. К настоящему проду приложение не подключается, работает только с локальным Docker.
  Пароль Postgres — только в конфиге и Core, в renderer не передаётся. Имена БД — только SQL-идентификаторы из шаблонов
  с проверкой `^[a-z0-9_]+$`; git / docker / gh — `execa` с массивом аргументов, без shell-строк.
- **Защита чужого**: не трогать `protectedContainers`, `protectedDbs`, БД живой сборки Production — только через
  import_backup; основной чекаут репозитория — только `git fetch`, `git worktree add/remove`, `git branch`, установка хуков
  по кнопке. Удаляются только ресурсы из реестра приложения (с метками `bm.*`) и каталоги внутри `worktreesDir`.
  Проверка при сохранении настроек: шаблоны `naming.db` разных проектов не могут пересекаться.
- **Идемпотентность**: повтор шага после сбоя не ломает сборку (`IF EXISTS`, проверки существования).
- **Производительность**: окно < 2 с после запуска; боковая панель и History < 1 с при 50 ветках и 500 сборках;
  UI не подвисает во время сборок.
- **Платформа**: Windows 10 x64, Docker Desktop (WSL2), Git for Windows; `gh` — опционально. Установка без прав
  администратора. PowerShell и WSL для работы приложения не нужны.
- **UI**: русский язык, тема по системной с переключателем, адаптив не нужен.
- **Логи**: `pino` в `<dataDir>/logs/` (main, Core), лог каждой сборки и задачи — отдельный файл; «Открыть папку логов».

## 12. Этапы

| Этап | Состав |
|---|---|
| **1 — MVP** | Electron-оболочка, мастер первого запуска и добавления проекта (автоопределение), несколько проектов, настройки по уровням (формы для основного + YAML-редактор), стадии и перетаскивание, правила веток, Production из `.zip` с нейтрализацией и `postRestore`, Staging (`copy:production`, `update`), Development (`fresh` / `copy`), триггеры по fetch и по локальным коммитам, шаги сборки, History / Logs / Editor / Shell / Tools (Debug) / Settings, Connect, Rebuild, Start/Stop/Restart, Delete, очередь, согласование, Status, трей и уведомления, проверка Docker Desktop |
| **2** | тесты и бейджи, Mails (Mailpit), Monitor, Backups (снапшоты, экспорт), Merge (PR через `gh`), Fork с push, Builds и Audit Logs, `version-bumped`, `idleStopHours` / `dropAfterDays`, `.dump`, `autoImport` бэкапов, `cloneMethod: dump`, хуки, `postgres.mode: managed`, `runtime.build` |
| **3** | пресеты (сохранить / импорт), экспорт / импорт проектов, свой `composeTemplate`, графики ресурсов за период, инсталлятор и автозапуск, горячие клавиши |

## 13. Критерии приёмки (этап 1)

1. `pnpm install && pnpm build && pnpm start` → окно, мастер первого запуска; «Добавить проект» с папкой
   `E:\demz-odoo-19\repositories\demz-odoo` находит remote, корни модулей, образ, сеть, Postgres и предлагает пресет DEMZ.
   Повторный запуск приложения фокусирует окно.
2. Production = `19.0`, «Импортировать» `db-backup-o19-demz-prod-*.zip` → зеркало прода работает на `http://prod.localhost`,
   в `ir_config_parameter` нет enterprise-ключей прода, `web.base.url` = адрес сборки, в UI метка «Зеркало прода (локально)».
3. После первого fetch боковая панель совпадает с odoo.sh: Staging — `19.0-demz-crm`, `19.0-demz-prerelease`;
   Development — остальные ветки; `backup/*` скрыты.
4. Сборка `19.0-demz-crm` из копии зеркала прода, Connect открывает `http://crm.localhost` с данными прода, картинки товаров
   на месте; `/web/database/selector` показывает только БД этой сборки.
5. Новый коммит в `origin/19.0-demz-crm` → после fetch в History появляется запись с этим коммитом, изменённый модуль обновлён
   (`update`), БД стейджинга сохранилась.
6. Fork `19.0-demz-test999` от `19.0` → ветка в Development, сборка из копии зеркала прода готова, уведомление Windows;
   правка модуля `demzua/...` в worktree + коммит → живая сборка обновила именно этот модуль (`update`, БД сохранилась);
   изменение не видно на `localhost:8019`, в зеркале прода и в стейджингах. Перетаскивание ветки в Staging меняет стадию
   и предлагает Rebuild; обратно — так же.
7. Две сборки открыты одновременно в одном браузере — логины не сбрасываются.
8. Attach VS Code по скопированному `launch.json` на `debugPort` → брейкпоинт в файле worktree срабатывает; Editor открывает именно worktree.
9. Изменение `stages.development.idleStopHours` в YAML видно в Settings ветки как «из стадии»; переопределение в ветке — «из ветки»;
   изменение `runtime.env` помечает живые сборки «конфигурация изменилась», «Применить» пересоздаёт контейнер без пересборки БД.
10. Второй проект на другом репозитории работает одновременно с DEMZ без конфликтов имён БД, контейнеров, хостов и debug-портов.
11. Принудительное завершение приложения во время сборки → после перезапуска задача `interrupted`, сборка `failed`,
    предыдущая живая сборка ветки работает; «Отбросить» чисто удаляет БД, filestore и контейнер неудавшейся сборки.
12. Ветка, которая сейчас в основном чекауте, с `tracking: local` → понятная ошибка и предложение `tracking: remote`,
    без частично созданных ресурсов.
13. Закрытие окна во время сборки → приложение в трее, сборка завершается, уведомление; компьютер не засыпает.
14. Остановленный Docker Desktop → баннер «Запустить»; после старта работа продолжается без перезапуска приложения.
15. `netstat -ano` для процессов приложения не показывает слушающих TCP-портов.
16. После всех сценариев не изменены: `o19_test`, контейнеры `odoo19` / `odoo19-db`, файлы `E:\demz-odoo-19`
    (кроме `worktrees/` и `data/filestore/o19_br_*`).
