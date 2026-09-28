# Приёмка этапа 1 (раздел 13 ТЗ)

Проверка 28.09.2026 на рабочей машине: Windows 10, Docker Desktop 28.2.2, Traefik на `127.0.0.1:8080`, потому что порт 80
занят Apache (D5). Сначала всё прогонялось в песочнице (профиль `BM_PROFILE=dev`, проект `bmdev`, собственный клон
`demz-odoo` с локальным bare-origin, БД `o19_bmdev_*`, хосты `*.dev.localhost`). Финальная проверка — на реальном
профиле и реальном пресете DEMZ (проект `demz`, БД `o19_br_*`, хосты `*.localhost:8080`).

Сценарии проверки — это скрипты в `apps/desktop/scripts/`. Они управляют настоящим приложением через Playwright
(Electron) и вызывают те же методы `window.bm`, что и UI, ничего не подменяя. Вывод скриптов приведён ниже,
скриншоты лежат в `tmp/shots/` (папка в `.gitignore`, в репозиторий не попадает). Логи приложения:
`%LOCALAPPDATA%\DEMZ Branch Manager\logs\` (`main.log`, `core.log`, `builds\demz\*.log`, `jobs\*.log`).

| # | Критерий | Статус |
|---|---|---|
| 1 | Установка, запуск, мастер, автоопределение, single-instance | **пройден** |
| 2 | Зеркало прода из `.zip` | **пройден** |
| 3 | Раскладка веток после первого fetch | **пройден** |
| 4 | Staging `19.0-demz-crm` из копии зеркала прода | **не пройден на реальной ветке** (ошибка в коде ветки); механизм пройден в песочнице |
| 5 | Новый коммит в `origin/19.0-demz-crm` → update | **частично**: пройден в песочнице; на реальном репозитории нужен push в GitHub |
| 6 | Fork → Development → update модуля; стадии | **пройден** |
| 7 | Две сборки в одном браузере | **пройден** |
| 8 | Attach VS Code по `launch.json`, Editor | **пройден** (DAP-клиент вместо GUI VS Code) |
| 9 | Уровни настроек, «конфигурация изменилась» → «Применить» | **пройден** |
| 10 | Второй проект на другом репозитории одновременно с DEMZ | **пройден** |
| 11 | Принудительное завершение во время сборки | **пройден** |
| 12 | Ветка в основном чекауте + `tracking: local` | **пройден** |
| 13 | Закрытие окна во время сборки, уведомление, запрет сна | **пройден** |
| 14 | Остановленный Docker Desktop → баннер, продолжение работы | **частично**: проверено на имитации, настоящая остановка требует разрешения |
| 15 | Нет слушающих TCP-портов у процессов приложения | **пройден** |
| 16 | Чужое не изменено | **пройден** |

---

## 1. Установка, мастер, автоопределение, повторный запуск — пройден

- `pnpm install` (Done in 4.9s), `pnpm build` (main, preload, renderer собраны), `pnpm start`. `main.log`:
  `"window ready","ms":442`. Окно открывается за 0,4–0,6 с, при каждом запуске меньше 2 с.
- Мастер (`scripts/accept-a.mjs`, реальный профиль): «Далее: добавить проект» → папка
  `E:/demz-odoo-19/repositories/demz-odoo` → «Определить». Результат на экране (`A1-detect.png`):
  ```
  found   DEMZ-UA/demz-odoo
  found   demzua, exchange, oca, printer, todoltd
  found   demz-odoo-19-odoo
  found   demz-odoo-19_default
  found   odoo19-db → localhost:5433
  found   DEMZ (рекомендуется)
  ```
  Кроме того, мастер нашёл `demzua/modules_to_install.txt`, `repoMount = /mnt/repositories/demz-odoo`, пять монтирований и
  кандидата в Production `19.0`. Пароль Postgres взят из `docker inspect odoo19`, `.env` не читался.
- Повторный запуск во время работы: второй процесс завершился с кодом 0 за 170 мс, в `main.log` появилось
  `"second instance started: focusing the window"`.

## 2. Production = 19.0, импорт бэкапа — пройден

`scripts/accept-b.mjs`, реальный проект `demz`, файл `db-backup-o19-demz-prod-2026-sep-21.gW6p.zip` (778 МБ), 12 минут:

```
build 1 running http://prod.localhost:8080 o19_br_prod_1  12 min
  database success восстановлена из db-backup-o19-demz-prod-2026-sep-21.gW6p.zip, нейтрализована, postRestore выполнен
  filestore skipped восстановлен вместе с БД (odoo db load)
  local-tweaks success web.base.url=http://prod.localhost:8080, пароль admin
  modules success -u ata_exchange_v4,demz_ai_anthropic,…,td_warehouse_access   (48 модулей td_* / ata_* / demz_*)
  up success http://prod.localhost:8080
enterprise keys left: 0 | web.base.url: http://prod.localhost:8080 | mail servers active/total: {"active":"0","total":"1"}
filestore dir exists: true            (E:\demz-odoo-19\data\filestore\o19_br_prod_1)
HTTP http://prod.localhost:8080/web/login 200
```

На странице ветки есть метка «Зеркало прода (локально)» (`B2-prod-mirror.png`, `data-testid="mirror-label"`). Адрес —
`http://prod.localhost:8080`, а не `:80`: порт 80 занят Apache (D5).

## 3. Раскладка веток после первого fetch — пройден

`scripts/accept-a.mjs`, сразу после создания проекта:

```
production : 19.0
staging    : 19.0-demz-crm, 19.0-demz-prerelease
development: 19.0-demz-perevertum, 19.0-demz-test1, 19.0-eusign_cp, demz-roman
not added  : — | hidden by rules: 2          (backup/19.0-demz-prerelease-before-demzua-sync-*)
```

При проверке нашлась и исправлена ошибка: первый fetch запускался только при старте Core, поэтому в только что
созданном проекте ветки висели в «Не добавлены» до срабатывания таймера. Коммит «Fetch right after a project is created».

## 4. Staging 19.0-demz-crm из копии зеркала прода — не пройден на реальной ветке, механизм пройден

**Реальный DEMZ** (`scripts/accept-c.mjs 4`). Шаги `code → port → database (копия o19_br_prod_1) → filestore (1557 файлов,
хардлинки, 1 с) → local-tweaks` прошли, а шаг `modules` упал на коде самой ветки:

```
odoo.tools.convert.ParseError: while parsing …/todoltd/product/td_demz_product/views/product_template_views.xml:3
Поле "td_hs_code_id" не існує в моделі "product.template"
19.0-demz-crm vs 19.0: ahead 3, behind 26
```

`19.0-demz-crm` отстаёт от `19.0` на 26 коммитов. Код ветки старше кода, на котором уже работает БД прода, и
обновление модулей падает. Так и должен работать staging-контроль: сборка `failed`, зеркало прода не тронуто, в
History есть текст ошибки и лог. В песочнице на более старом состоянии той же ветки нашлись ещё две такие проблемы:
`demz_crm_res_partner` использует `td_full_partner_name`, но не зависит от `td_demz_exchange_base`, а
`td_demz_stock` ссылается на `action_demz_print_internal_transfer_note`. **Что нужно:** влить `19.0` в
`19.0-demz-crm` (решение за вами, приложение не пушит) и нажать Rebuild.

**Механизм — в песочнице** (`scripts/check-m4-stage.mjs`), после того как в песочном origin ветка догнала `19.0`:

```
#3 running new o19_bmdev_crm_3 256s
   database success копия o19_bmdev_prod_1 (сборка #1)
   filestore success 1541 файлов, хардлинки, 1 с
   modules success -u demz_nbu_currency_rate
partners (prod data): 1582 | web.base.url: http://crm.dev.localhost:8080
product image file in build filestore: …/o19_bmdev_crm_3/b3/b345d609… true
login Administrator → 303
GET product image → 200 image/png 2286 bytes
selector DBs: [ 'o19_bmdev_crm_3' ]
```

## 5. Новый коммит в origin/19.0-demz-crm → update — частично

Приложение никогда не пушит (правило 3), поэтому «новый коммит в `origin`» на реальном репозитории может сделать только
пользователь. **В песочнице** origin — локальный bare-репозиторий: скрипт пушит туда коммит, а приложение делает
обычный fetch (`scripts/check-m4-stage.mjs`):

```
pushed 018a5b2 touching demz_nbu_currency_rate
#4 running update o19_bmdev_crm_3 114s
   code success 018a5b2, коммитов: 1
   database skipped БД живой сборки сохраняется
   modules success -u demz_nbu_currency_rate
   finalize success сборка работает, #3 обновлена
module demz_nbu_currency_rate write_date after: 2026-09-28T06:44:59Z | same DB: true | marker kept: kept | partners 1582 → 1582
history: #4 update running 018a5b2, #3 new dropped 24c2aa3, …
```

Метка `bm.marker`, записанная в БД перед коммитом, сохранилась, значит БД не пересоздавалась. Скриншот:
`c5-crm-update.png`. **Чтобы закрыть критерий на реальном DEMZ:** после того как `19.0-demz-crm` соберётся (п. 4),
запушьте любой коммит в `origin/19.0-demz-crm` и нажмите fetch или подождите 5 минут.

## 6. Fork → Development → update — пройден

`scripts/accept-c.mjs 6`, реальный DEMZ:

```
fork: 19.0-demz-test999 development test999
19.0-demz-test999 #1 running new o19_br_test999_1 226s  (копия o19_br_prod_1)
notification: {"type":"buildReady","title":"Сборка готова: 19.0-demz-test999","body":"#1 работает — http://test999.localhost:8080"}
committed cc06be6 in E:/demz-odoo-19/worktrees/demz/test999 (module demzua/accounting/demz_nbu_currency_rate)
19.0-demz-test999 #2 running update o19_br_test999_1 117s
   modules success -u demz_nbu_currency_rate
same DB true; demz_nbu_currency_rate: 07:24:44 → 07:36:09; demz_crm_calendar_event_report unchanged true
/bm/ping test999: 200 bm-ping-ok
/bm/ping prod   : 404
/bm/ping crm    : no live build        (в песочнице: 404)
/bm/ping :8019  : 404
moved → staging (user); badges: stage-changed        (диалог предложил Rebuild: C6-rebuild-offer-Staging.png)
moved → development (user); badges: stage-changed
```

Коммит в worktree приложение заметило само (chokidar и опрос HEAD) и запустило `update` только изменённого модуля.
Стадия менялась через контекстное меню ветки (правый клик → «→ Staging»), перетаскивание вызывает тот же диалог.

## 7. Две сборки в одном браузере — пройден

`scripts/accept-c.mjs 7`: вход в зеркало прода и в test999, затем запросы к ним поочерёдно:

```
19.0 http://prod.localhost:8080: login 303; cookie attrs: Expires=…; Max-Age=604800; HttpOnly; Path=/
19.0-demz-test999 http://test999.localhost:8080: login 303; cookie attrs: …; HttpOnly; Path=/
round 1 19.0: uid=2 db=o19_br_prod_1
round 1 19.0-demz-test999: uid=2 db=o19_br_test999_1
round 2 19.0: uid=2 db=o19_br_prod_1
round 2 19.0-demz-test999: uid=2 db=o19_br_test999_1
```

У cookie `session_id` нет атрибута `Domain`, поэтому браузер держит отдельную сессию на каждый хост. Логины не
сбрасываются.

## 8. Отладка по launch.json, Editor — пройден

`scripts/accept-c.mjs 8`. Сгенерированный `launch.json` содержит `debugpy attach 127.0.0.1:5701` и `pathMappings`:
worktree → `/mnt/repositories/demz-odoo`, enterprise → `/mnt/enterprise`. Скрипт работает как VS Code: те же DAP-запросы,
`clientOS: windows` (его добавляет расширение Python), пути Windows:

```
breakpoint: {"verified":true,"source":{"path":"E:\\demz-odoo-19\\worktrees\\demz\\test999\\demzua\\accounting\\demz_nbu_currency_rate\\bm_ping.py"},"line":7}
STOPPED (breakpoint) at E:\demz-odoo-19\worktrees\demz\test999\demzua\accounting\demz_nbu_currency_rate\bm_ping.py:7 in bm_ping
HTTP after continue: 200 bm-ping-ok
Editor: {"ok":true} → E:/demz-odoo-19/worktrees/demz/test999
core.log: {"exe":"code","target":"E:\\demz-odoo-19\\worktrees\\demz\\test999","exitCode":0,"msg":"editor opened"}
```

Кнопка «Добавить в .vscode/launch.json worktree» дописывает конфигурацию через jsonc-parser и предупреждает, что
`.vscode/` нет в `.gitignore`. Проверено в песочнице. Графический VS Code не запускался: вместо него работал
DAP-клиент `scripts/dap.mjs`, протокол тот же.

## 9. Уровни настроек, «конфигурация изменилась» — пройден

`scripts/accept-d.mjs 9`, реальный `demz.yaml`, правка файла вручную (не через UI):

```
YAML edited by hand: {"path":"idleStopHours","value":6,"level":"stage"}
branch override   : {"path":"idleStopHours","value":3,"level":"branch"}
env changed → test999 configChanged true | prod configChanged true
«Применить»: container 5ced6211f4c9 → cd97f369c4ce, build #2 (same true), DB o19_br_test999_1, configChanged false, /bm/ping 200
settings restored and applied
```

В Settings ветки видны значение и уровень («из стадии», «из ветки»): `D9-levels.png`. Баннер «Конфигурация изменилась»
с кнопкой «Применить»: `D9-config-changed.png`. После проверки настройки вернули, изменения применили ко всем живым
сборкам.

## 10. Второй проект одновременно с DEMZ — пройден

`scripts/accept-d.mjs 10`. Второй проект — отдельный git-репозиторий `tmp/second-repo` с модулем `bm_hello`, пресет
Generic, образ `odoo:19`. Он собирался, пока работали сборки DEMZ:

```
during second build — DEMZ prod: 200
#1 running new bm_second_repo_feature_x_1 debugPort 5702 http://feature-x.second-repo.localhost:8080
/bm/hello second: 200 hello from the second project
demz/19.0:              db o19_br_prod_1,              compose bm-demz-prod-odoo-1,       debug 5700, HTTP 200
demz/19.0-demz-test999: db o19_br_test999_1,           compose bm-demz-test999-odoo-1,    debug 5701, HTTP 200
second/feature-x:       db bm_second_repo_feature_x_1, compose bm-second-feature-x-odoo-1, debug 5702, HTTP 200
```

Имена БД, контейнеров, хостов и debug-портов не пересекаются. Пересечение шаблонов между проектами проверяется
ещё при сохранении настроек (D13, `test/store.test.ts`).

## 11. Принудительное завершение во время сборки — пройден

`scripts/accept-d.mjs 11`, реальный DEMZ: Rebuild test999, `taskkill /F /T` всего приложения на шаге `filestore`,
затем повторный запуск:

```
live before: #2 running
taskkill during #3, step filestore
jobs: …, build#19:interrupted, …
build #3: failed — Сборка прервана: приложение было закрыто или Core перезапущен. Нажмите «Повторить с шага» или «Отбросить»…
live: #2 running container running HTTP 200
failed build resources: DB true | filestore true
after «Отбросить»: dropped; DB false; filestore false; containers «»
```

## 12. Ветка в основном чекауте, tracking: local — пройден

`scripts/accept-c.mjs 12`. Основной чекаут `demz-odoo` на момент проверки стоял на `19.0` (см. п. 16), поэтому проверялась
эта ветка с `tracking: local`:

```
error: Ветка «19.0» сейчас открыта в основном чекауте репозитория (E:/demz-odoo-19/repositories/demz-odoo). Git разрешает
ветке только один worktree, поэтому режим tracking: local для неё невозможен. Переключите ветку на tracking: remote (сборка
будет брать код из origin) или переключите основной чекаут на другую ветку.
builds before/after: 1 1 | new DBs: []
```

Ничего не создано: ни записи сборки, ни БД, ни worktree. В UI Rebuild открывает диалог с кнопкой «Переключить на
tracking: remote». В песочнице то же проверено на `19.0-demz-perevertum` (`check-m4-stage.mjs`).

## 13. Закрытие окна во время сборки — пройден

`scripts/accept-d.mjs 13`:

```
building: {"sleepBlocked":true,"windowVisible":true}
window closed: {"sleepBlocked":true,"windowVisible":false} process alive: true
#2 running new bm_second_repo_feature_x_2 …
after: {"sleepBlocked":false,"windowVisible":false}
main.log: "sleep blocked (powerSaveBlocker)" → "notification … Сборка готова: feature-x" → "sleep allowed again"
```

Запрет сна включается через `powerSaveBlocker('prevent-app-suspension')`, пока есть активные задачи.

## 14. Остановленный Docker Desktop — частично

Остановка Docker Desktop остановит и `odoo19` / `odoo19-db`, а правило 2 это запрещает. Поэтому проверялась имитация
(`scripts/check-c14-sim.mjs`, D25): Core обращается к Docker через именованный канал, которого сначала нет, а потом он
появляется как прокси к настоящему `docker_engine`.

```
engine down → banner shown; status.docker: {"ok":false,"text":"Docker недоступен: connect ENOENT //./pipe/bm_sim_docker"}
engine up → banner gone after 2 s, no app restart
status.docker: {"ok":true,"version":"28.2.2"} | traefik: {"ok":true,"port":8080} | discrepancies: 0
```

Баннер «Docker Desktop не запущен… — Запустить» виден на `c14-docker-down.png`. Кнопка запускает
`Docker Desktop.exe` (путь определяется автоматически или берётся из `desktop.dockerDesktopExe`). **Чтобы закрыть
критерий полностью:** остановите Docker Desktop сами, когда простой `odoo19` не помешает. Контейнеры с
`restart: unless-stopped` поднимутся вместе с Docker.

## 15. Нет слушающих портов — пройден

`scripts/accept-d.mjs 15`, обычный запуск без Playwright (у Playwright свой CDP-порт):

```
electron PIDs: 12832, 20228, 6440, 6860, 16144 | listening: none
ports of Docker: bm-demz-test999 127.0.0.1:5701 | bm-second-feature-x 127.0.0.1:5703 | bm-demz-prod 127.0.0.1:5700 | bm-traefik 127.0.0.1:8080
```

Порты слушает Docker, и только на 127.0.0.1: Traefik и debugpy, как допускает ТЗ (раздел 11). Свободные порты
приложение ищет по выводу `netstat`, не открывая сокетов (D12).

## 16. Чужое не изменено — пройден

`scripts/snapshot-demz.mjs`: снимок `E:\demz-odoo-19` (путь, размер, mtime, 43 тыс. файлов) до финальной проверки и
после неё.

- Контейнеры до и после совпадают: `odoo19` 3cdc373c… StartedAt 05:34:32, RestartCount 0, running; `odoo19-db`
  2d8af444… StartedAt 04:29:11, RestartCount 0, running.
- Изменились 14 файлов в `repositories/demz-odoo`, и их список **в точности совпадает** с
  `git diff --name-only 19.0 19.0-demz-perevertum`. Это переключение основного чекаута с `19.0-demz-perevertum` на `19.0`,
  в reflog: `HEAD@{2026-09-28 13:15:37 +0300}: checkout: moving from 19.0-demz-perevertum to 19.0`. Сделало его не
  приложение: в коде есть только `git checkout --detach <sha>` внутри собственных worktree (`git/index.ts:144`), а
  переключения веток в основном чекауте нет. `git status` чистый.
- Исключены по условию критерия и по устройству: `worktrees/`, `data/filestore/o19_br_*`, `data/db` (кластер
  Postgres, в котором приложение создаёт свои БД `o19_br_*`), `.git` репозитория (fetch и worktree разрешены
  правилом 3).
- БД `o19_test` и `postgres` защищены `protectedDbs` и `assertOwned` (`test/safety.test.ts`). Приложение к ним не
  подключается и не удаляет.
- Изменения в `.git` репозитория `demz-odoo` — только разрешённые операции: fetch, `worktree add/remove` и новая локальная
  ветка `19.0-demz-test999` (Fork из п. 6) с одним коммитом из п. 6. Её можно удалить: `git branch -D 19.0-demz-test999`,
  предварительно удалив ветку в приложении.

## Что осталось после проверки

- Реальный профиль: проект `demz` с живыми сборками `19.0` (зеркало прода), `19.0-demz-test999` и упавшей
  `19.0-demz-crm #1` (её можно «Отбросить»). Проект `second` на `tmp/second-repo` удаляется в Settings → «Удалить
  проект…».
- Песочница удалена через «Удалить проект» (БД, контейнеры, worktree и filestore удалены — `cleanup-sandbox.mjs`).
