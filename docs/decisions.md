# Решения по реализации

Формат: контекст → решение → альтернатива. Номера не меняются, новые решения дописываются в конец.

## D1. Версии стека

- **Контекст.** На сентябрь 2026 `electron-vite@5` поддерживает только `vite` ≤ 7, `@vitejs/plugin-react@6` требует `vite@8`.
  TypeScript 7 — новая нативная реализация, её поведение с `tsc -p` в монорепо не проверено. context7 в этой среде
  недоступен, поэтому API сверялся по `.d.ts` установленных пакетов.
- **Решение.** Electron 44.4.5 (Node 24), electron-vite 5, vite 7, plugin-react 5, TypeScript 5.9, zod 4, Mantine 8,
  Vitest 3, dockerode 4, execa 9, better-sqlite3 13 (готовый prebuild для Windows x64 подходит и для Electron).
- **Альтернатива.** Самые свежие мажорные версии (vite 8, TS 7, Mantine 9): electron-vite их пока не поддерживает.

## D2. `node-linker=hoisted`

- **Контекст.** electron-builder и `@electron/rebuild` плохо работают с символьными ссылками pnpm, а нативный
  `better-sqlite3` должен попасть в пакет.
- **Решение.** `.npmrc`: `node-linker=hoisted`. Зависимости времени выполнения Core перечислены в `apps/desktop`
  (`dependencies`), а `@bm/core` и `@bm/shared` собираются в бандл (devDependencies).
- **Альтернатива.** Изолированный `node_modules` pnpm с `electron-builder` `nodeLinker`: больше ручной настройки.

## D3. Профиль разработки `BM_PROFILE`

- **Контекст.** Ручные проверки при разработке не должны портить боевой реестр и настройки (правило 5 промпта).
- **Решение.** Переменная `BM_PROFILE=dev` добавляет суффикс ` (dev)` к каталогам `%APPDATA%\DEMZ Branch Manager` и
  `%LOCALAPPDATA%\DEMZ Branch Manager`, к AppUserModelId и к single-instance lock. Без переменной используются пути из ТЗ.
- **Альтернатива.** Отдельные переменные для каждого каталога: неудобно и легко ошибиться.

## D4. `ELECTRON_RUN_AS_NODE` в окружении

- **Контекст.** Терминалы и процессы, запущенные из VS Code, наследуют `ELECTRON_RUN_AS_NODE=1`, и тогда Electron
  стартует как обычный Node (`app` = undefined).
- **Решение.** `pnpm dev / build / start` запускаются через `apps/desktop/scripts/electron-vite.mjs`, который удаляет
  эту переменную. Тесты, наоборот, выставляют её явно (`packages/core/scripts/run-vitest.mjs`).

## D5. Порт Traefik

- **Контекст.** Порт 80 на машине занят `httpd.exe` (Apache, служба Windows).
- **Решение.** Как и в ТЗ: `proxyPort: 80`, при занятости — 8080. Выбранный порт сохраняется в `app.yaml` при первом
  запуске, адреса сборок — `http://<host>:8080`. Критерии, где написано `http://prod.localhost`, проверяются
  на `http://prod.localhost:8080`.
- **Альтернатива.** Останавливать Apache нельзя: это чужой сервис.
