# Изменения

Формат — [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/), версии — [SemVer](https://semver.org/lang/ru/).
Правила нумерации — в README, раздел «Версии».

## [Unreleased]

### Изменено
- Приложение переименовано в **Odoo Branch Manager**. Папки `%APPDATA%\DEMZ Branch Manager` и
  `%LOCALAPPDATA%\DEMZ Branch Manager` при первом запуске переносятся под новое имя вместе с проектами, реестром и
  логами. Если старую версию ещё не закрыли, приложение продолжает работать со старыми папками.
- AppUserModelId и appId установщика: `ua.bakum.odoo-branch-manager`. Уведомления Windows приходят от нового имени.

### Добавлено
- Система версий: единая версия во всех `package.json`, `pnpm release <patch|minor|major>`, проверка
  `pnpm version:check`. В сборку встраиваются версия, коммит и дата сборки. Они видны в нижней строке окна, на
  странице Status и в `main.log`.
- Строка внизу окна: версия и «© Bakum Viacheslav». Копирайт записан и в свойства установщика.

## [0.1.0] — 2026-09-28

Этап 1 (MVP) по ТЗ `branch-manager-spec.md`. Проверка критериев приёмки — в `docs/acceptance.md`.

### Добавлено
- Electron-оболочка: main, Core в `utilityProcess`, renderer в sandbox. Связь только через MessagePort, без
  HTTP-порта. Один экземпляр, трей, уведомления Windows, запрет сна во время сборок, баннер Docker Desktop.
- Мастер первого запуска и мастер добавления проекта с автоопределением. Пресеты DEMZ и Generic Odoo.
- Настройки по уровням (приложение → проект → стадия → правило → ветка): формы и YAML-редактор со схемой,
  уровень-источник у каждого поля.
- Стадии Production / Staging / Development, правила веток, автодобавление, перетаскивание, Fork (без push).
- Сборки: очередь и лимиты, шаги 8.3, зеркало прода из `.zip` с нейтрализацией и `postRestore`, копии БД через
  `TEMPLATE`, `fresh`, `update` на новый коммит (fetch и локальный HEAD), «Повторить с шага», «Отбросить», DROPPED.
- Traefik на `*.localhost`, compose-проект на ветку, метки `bm.*`, согласование с реестром при старте, сироты.
- Вкладки ветки: History, Shell, Editor, Logs, Backups, Tools (Debug, `launch.json`), Settings. Страницы Builds, Status,
  Audit Logs.
