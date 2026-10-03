import { translator, type Entry } from '@bm/shared';

/** Main process texts (D69): tray, quit and update dialogs, notifications, system file dialogs. */
export const mainMessages = {
  'boot.failed': { uk: 'Не вдалося запустити застосунок: {error}', ru: 'Не удалось запустить приложение: {error}', en: 'Could not start the app: {error}' },

  'tray.logs': { uk: 'Журнали', ru: 'Логи', en: 'Logs' },
  'tray.noLive': { uk: 'Немає живих збірок', ru: 'Нет живых сборок', en: 'No live builds' },
  'tray.show': { uk: 'Показати вікно', ru: 'Показать окно', en: 'Show window' },
  'tray.stopAll': { uk: 'Зупинити всі збірки', ru: 'Остановить все сборки', en: 'Stop all builds' },
  'tray.install': { uk: 'Встановити оновлення {version}…', ru: 'Установить обновление {version}…', en: 'Install update {version}…' },
  'tray.check': { uk: 'Перевірити оновлення', ru: 'Проверить обновления', en: 'Check for updates' },
  'tray.quit': { uk: 'Вихід', ru: 'Выход', en: 'Quit' },
  'tray.tip.ok': { uk: 'усе працює', ru: 'всё работает', en: 'all running' },
  'tray.tip.building': { uk: 'іде збірка', ru: 'идёт сборка', en: 'building' },
  'tray.tip.error': { uk: 'є помилки', ru: 'есть ошибки', en: 'there are errors' },
  'tray.tip.idle': { uk: 'немає живих збірок', ru: 'нет живых сборок', en: 'no live builds' },
  'status.running': { uk: 'працює', ru: 'работает', en: 'running' },
  'status.stopped': { uk: 'зупинена', ru: 'остановлена', en: 'stopped' },
  'status.building': { uk: 'збірка', ru: 'сборка', en: 'building' },
  'status.failed': { uk: 'помилка', ru: 'ошибка', en: 'failed' },
  'status.queued': { uk: 'у черзі', ru: 'в очереди', en: 'queued' },

  'quit.message': { uk: 'Виконується завдань: {n}. Що зробити?', ru: 'Выполняется задач: {n}. Что сделать?', en: 'Jobs running: {n}. What should be done?' },
  'quit.detail': {
    uk: 'Контейнери збірок під час виходу не зупиняються.',
    ru: 'Контейнеры сборок при выходе не останавливаются.',
    en: 'Build containers are not stopped on quit.',
  },
  'quit.wait': { uk: 'Дочекатися й вийти', ru: 'Дождаться и выйти', en: 'Wait and quit' },
  'quit.cancelJobs': { uk: 'Скасувати завдання й вийти', ru: 'Отменить задачи и выйти', en: 'Cancel jobs and quit' },
  'quit.stay': { uk: 'Залишитися', ru: 'Остаться', en: 'Stay' },
  'quit.afterJobs': { uk: 'Вихід після завершення поточних завдань.', ru: 'Выход после завершения текущих задач.', en: 'Quitting once the current jobs finish.' },

  'update.notReady': { uk: 'Перевірка оновлень не готова', ru: 'Проверка обновлений не готова', en: 'The update check is not ready' },
  'update.none': {
    uk: 'Немає доступного оновлення: спочатку перевірте оновлення',
    ru: 'Нет доступного обновления: сначала проверьте обновления',
    en: 'No update available: check for updates first',
  },
  'update.portable': {
    uk: 'Portable-версія: завантажте нову версію зі сторінки релізу',
    ru: 'Portable-версия: скачайте новую версию со страницы релиза',
    en: 'Portable version: download the new version from the release page',
  },
  'update.dev': {
    uk: 'У режимі розробки (pnpm dev / start) встановлення оновлень недоступне',
    ru: 'В режиме разработки (pnpm dev / start) установка обновлений недоступна',
    en: 'Installing updates is not available in development mode (pnpm dev / start)',
  },
  'update.noAsset': { uk: 'У релізі немає інсталятора', ru: 'В релизе нет установщика', en: 'The release has no installer' },
  'update.waitJobs': { uk: 'Дочекатися завдань і встановити', ru: 'Дождаться задач и установить', en: 'Wait for jobs and install' },
  'update.abortJobs': { uk: 'Перервати завдання й встановити', ru: 'Прервать задачи и установить', en: 'Abort jobs and install' },
  'update.install': { uk: 'Встановити', ru: 'Установить', en: 'Install' },
  'common.cancel': { uk: 'Скасувати', ru: 'Отмена', en: 'Cancel' },
  'update.question': { uk: 'Встановити Odoo Branch Manager {version}?', ru: 'Установить Odoo Branch Manager {version}?', en: 'Install Odoo Branch Manager {version}?' },
  'update.detailMac': {
    uk: 'Поточна версія {current}. Образ диска буде завантажено ({mb} МБ) і перевірено, потім застосунок повністю закриється й відкриється образ: перетягніть Odoo Branch Manager у «Програми» із заміною і запустіть його знову. ',
    ru: 'Текущая версия {current}. Образ диска будет скачан ({mb} МБ) и проверен, затем приложение полностью закроется и откроется образ: перетащите Odoo Branch Manager в «Программы» с заменой и запустите его снова. ',
    en: 'Current version {current}. The disk image ({mb} MB) will be downloaded and verified, then the app closes completely and the image opens: drag Odoo Branch Manager into Applications, replacing the old one, and start it again. ',
  },
  'update.detailWin': {
    uk: 'Поточна версія {current}. Інсталятор буде завантажено ({mb} МБ) і перевірено, потім застосунок повністю закриється й запуститься інсталятор. ',
    ru: 'Текущая версия {current}. Установщик будет скачан ({mb} МБ) и проверен, затем приложение полностью закроется и запустится установщик. ',
    en: 'Current version {current}. The installer ({mb} MB) will be downloaded and verified, then the app closes completely and the installer starts. ',
  },
  'update.untouched': {
    uk: 'Контейнери збірок, бази й налаштування не зачіпаються.',
    ru: 'Контейнеры сборок, базы и настройки не затрагиваются.',
    en: 'Build containers, databases and settings are not affected.',
  },
  'update.jobsRunning': {
    uk: '\n\nЗараз виконується завдань: {n}. Перервані збірки отримають статус failed, їх можна повторити після оновлення.',
    ru: '\n\nСейчас выполняется задач: {n}. Прерванные сборки получат статус failed, их можно повторить после обновления.',
    en: '\n\nJobs running now: {n}. Interrupted builds get the failed status; they can be retried after the update.',
  },
  'update.cancelled': { uk: 'Скасовано', ru: 'Отменено', en: 'Cancelled' },
  'update.afterJobs': {
    uk: 'Оновлення буде встановлено після завершення поточних завдань.',
    ru: 'Обновление будет установлено после завершения текущих задач.',
    en: 'The update will be installed once the current jobs finish.',
  },
  'update.availableTitle': { uk: 'Доступна версія {version}', ru: 'Доступна версия {version}', en: 'Version {version} is available' },
  'update.availableBody': {
    uk: 'Встановлено {current}. Відкрийте вікно, щоб переглянути зміни й оновити.',
    ru: 'Установлена {current}. Откройте окно, чтобы посмотреть изменения и обновить.',
    en: '{current} is installed. Open the window to see the changes and update.',
  },
  'update.upToDate': { uk: 'Встановлено останню версію {current}', ru: 'Установлена последняя версия {current}', en: 'The latest version {current} is installed' },
  'update.checkFailed': { uk: 'Перевірка не вдалася', ru: 'Проверка не удалась', en: 'The check failed' },
  'update.githubStatus': { uk: 'GitHub відповів {status}', ru: 'GitHub ответил {status}', en: 'GitHub answered {status}' },
  'update.timeout': { uk: 'немає відповіді від GitHub за 15 с', ru: 'нет ответа от GitHub за 15 с', en: 'no answer from GitHub within 15 s' },
  'update.checkError': {
    uk: 'Не вдалося перевірити оновлення: {error}. Перевірте підключення до інтернету.',
    ru: 'Не удалось проверить обновления: {error}. Проверьте подключение к интернету.',
    en: 'Could not check for updates: {error}. Check the internet connection.',
  },
  'update.noDmg': { uk: 'У релізі немає образу для macOS (…-mac-arm64.dmg)', ru: 'В релизе нет образа для macOS (…-mac-arm64.dmg)', en: 'The release has no macOS image (…-mac-arm64.dmg)' },
  'update.noExe': { uk: 'У релізі немає інсталятора (…Setup….exe)', ru: 'В релизе нет установщика (…Setup….exe)', en: 'The release has no installer (…Setup….exe)' },
  'update.downloadStatus': { uk: 'завантаження: {status}', ru: 'загрузка: {status}', en: 'download: {status}' },
  'update.sizeMismatch': { uk: 'розмір {done} байт замість {size}', ru: 'размер {done} байт вместо {size}', en: 'size {done} bytes instead of {size}' },
  'update.shaMismatch': {
    uk: 'контрольна сума SHA-256 не збігається із зазначеною в релізі',
    ru: 'контрольная сумма SHA-256 не совпадает с указанной в релизе',
    en: 'the SHA-256 checksum does not match the one in the release',
  },
  'update.downloadError': { uk: 'Не вдалося завантажити оновлення: {error}', ru: 'Не удалось скачать обновление: {error}', en: 'Could not download the update: {error}' },

  'dialog.selectDir': { uk: 'Виберіть папку', ru: 'Выберите папку', en: 'Choose a folder' },
  'dialog.selectFile': { uk: 'Виберіть файл', ru: 'Выберите файл', en: 'Choose a file' },
  'dialog.files': { uk: 'Файли', ru: 'Файлы', en: 'Files' },

  'core.restarting': { uk: 'Core перезапускається, повторіть дію', ru: 'Core перезапускается, повторите действие', en: 'Core is restarting, try again' },
  'core.notRunning': { uk: 'Core не запущено', ru: 'Core не запущен', en: 'Core is not running' },
} satisfies Record<string, Entry>;

export const t = translator(mainMessages);
