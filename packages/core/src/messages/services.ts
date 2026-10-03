import type { Entry } from '@bm/shared';

/** Projects, settings, Postgres, repositories, worktrees, reconcile. */
export default {
  'projectDelete.managedPg': {
    uk: 'контейнер {container}, том {volume} і мережа {network}',
    ru: 'контейнер {container}, том {volume} и сеть {network}',
    en: 'container {container}, volume {volume} and network {network}',
  },
  'projectDelete.confirm': { uk: 'Для видалення введіть id проєкту: {id}', ru: 'Для удаления введите id проекта: {id}', en: 'To delete, type the project id: {id}' },
  'projectDelete.dbError': { uk: 'БД {db}: {error}', ru: 'БД {db}: {error}', en: 'database {db}: {error}' },
  'projectDelete.ownRepo': {
    uk: '«{dir}» — ваш репозиторій, застосунок його не видаляє',
    ru: '«{dir}» — ваш репозиторий, его приложение не удаляет',
    en: '«{dir}» is your repository, the app does not delete it',
  },
  'projectDelete.notEmpty': {
    uk: 'У {dir} залишилися папки: {rest}. Видаліть їх вручну, якщо вони не потрібні.',
    ru: 'В {dir} остались папки: {rest}. Удалите их вручную, если они не нужны.',
    en: '{dir} still has folders: {rest}. Delete them by hand if you do not need them.',
  },
  'projectDelete.outside': { uk: '«{dir}» поза папками застосунку', ru: '«{dir}» вне папок приложения', en: '«{dir}» is outside the app’s folders' },
  'projectDelete.folderError': { uk: 'папка: {error}', ru: 'папка: {error}', en: 'folder: {error}' },
  'projectDelete.jobLogs': { uk: 'журнали завдань: {n}', ru: 'логи задач: {n}', en: 'job logs: {n}' },

  'config.noProject': { uk: 'Не вказано проєкт', ru: 'Не указан проект', en: 'No project given' },
  'config.noBranch': { uk: 'Гілку не знайдено', ru: 'Ветка не найдена', en: 'Branch not found' },
  'config.yamlSyntax': { uk: 'Помилка синтаксису YAML: {error}', ru: 'Ошибка синтаксиса YAML: {error}', en: 'YAML syntax error: {error}' },
  'config.readOnly': {
    uk: 'Цей рівень редагується в YAML проєкту (Settings → YAML)',
    ru: 'Этот уровень редактируется в YAML проекта (Settings → YAML)',
    en: 'This level is edited in the project YAML (Settings → YAML)',
  },

  'connectAs.readUsers': {
    uk: 'Не вдалося прочитати користувачів з бази {db}: {error}',
    ru: 'Не удалось прочитать пользователей из базы {db}: {error}',
    en: 'Could not read users from database {db}: {error}',
  },
  'connectAs.notRunning': { uk: 'Збірку не запущено: натисніть Start і повторіть', ru: 'Сборка не запущена: нажмите Start и повторите', en: 'The build is not running: press Start and try again' },
  'connectAs.noTraefik': { uk: 'Traefik не запущено: перевірте сторінку Status', ru: 'Traefik не запущен: проверьте страницу Status', en: 'Traefik is not running: check the Status page' },
  'connectAs.badHost': { uk: 'Неприпустима адреса збірки {host}', ru: 'Недопустимый адрес сборки {host}', en: 'Invalid build address {host}' },
  'connectAs.noContainer': {
    uk: 'Контейнер збірки не знайдено: запустіть збірку (Start)',
    ru: 'Контейнер сборки не найден: запустите сборку (Start)',
    en: 'Build container not found: start the build (Start)',
  },
  'connectAs.noUser': { uk: 'У базі {db} немає користувача з логіном «{login}»', ru: 'В базе {db} нет пользователя с логином «{login}»', en: 'Database {db} has no user with login «{login}»' },
  'connectAs.inactive': {
    uk: 'Користувача «{login}» у базі {db} архівовано: увійти під ним не можна',
    ru: 'Пользователь «{login}» в базе {db} архивирован: войти под ним нельзя',
    en: 'User «{login}» in database {db} is archived: you cannot log in as them',
  },
  'connectAs.noSession': {
    uk: 'Odoo не створив сесію (odoo shell, код {code}).\n{tail}',
    ru: 'Odoo не создал сессию (odoo shell, код {code}).\n{tail}',
    en: 'Odoo did not create a session (odoo shell, code {code}).\n{tail}',
  },
  'connectAs.routeTimeout': {
    uk: 'Traefik не підхопив маршрут входу за 20 с: перезапустіть застосунок (він оновить Traefik) і повторіть',
    ru: 'Traefik не подхватил маршрут входа за 20 с: перезапустите приложение (оно обновит Traefik) и повторите',
    en: 'Traefik did not pick up the login route within 20 s: restart the app (it updates Traefik) and try again',
  },

  'pg.notLocal': {
    uk: 'postgres.host = «{host}»: застосунок працює лише з локальним Postgres (localhost). Виправте налаштування проєкту.',
    ru: 'postgres.host = «{host}»: приложение работает только с локальным Postgres (localhost). Исправьте настройки проекта.',
    en: 'postgres.host = «{host}»: the app works only with a local Postgres (localhost). Fix the project settings.',
  },
  'pg.noPassword': {
    uk: 'Пароль Postgres не задано (postgres.password у налаштуваннях проєкту). Вкажіть його в Settings → Postgres.',
    ru: 'Пароль Postgres не задан (postgres.password в настройках проекта). Укажите его в Settings → Postgres.',
    en: 'The Postgres password is not set (postgres.password in the project settings). Set it in Settings → Postgres.',
  },
  'pg.connect': {
    uk: 'Немає підключення до Postgres {host}:{port} ({error}). Перевірте, що контейнер Postgres проєкту запущено і порт опубліковано.',
    ru: 'Нет подключения к Postgres {host}:{port} ({error}). Проверьте, что контейнер Postgres проекта запущен и порт опубликован.',
    en: 'Cannot connect to Postgres {host}:{port} ({error}). Check that the project’s Postgres container is running and its port is published.',
  },
  'pg.clone': { uk: 'Не вдалося скопіювати БД {src} → {db}: {error}', ru: 'Не удалось скопировать БД {src} → {db}: {error}', en: 'Could not copy database {src} → {db}: {error}' },
  'pg.protected': { uk: 'БД «{db}» захищена (postgres.protectedDbs)', ru: 'БД «{db}» защищена (postgres.protectedDbs)', en: 'Database «{db}» is protected (postgres.protectedDbs)' },
  'pg.rename': { uk: 'Не вдалося перейменувати БД {from} → {to}: {error}', ru: 'Не удалось переименовать БД {from} → {to}: {error}', en: 'Could not rename database {from} → {to}: {error}' },
  'pg.sql': { uk: 'Помилка SQL у БД {db}: {error}', ru: 'Ошибка SQL в БД {db}: {error}', en: 'SQL error in database {db}: {error}' },

  'request.active': {
    uk: 'У гілки «{branch}» уже йде збірка #{number}. Дочекайтеся її або скасуйте.',
    ru: 'У ветки «{branch}» уже идёт сборка #{number}. Дождитесь её или отмените.',
    en: 'Branch «{branch}» already has build #{number} running. Wait for it or cancel it.',
  },
  'request.limit': {
    uk: 'Живих збірок уже {running} при ліміті {limit} (maxRunningBuilds).',
    ru: 'Живых сборок уже {running} при лимите {limit} (maxRunningBuilds).',
    en: 'There are already {running} live builds with a limit of {limit} (maxRunningBuilds).',
  },
  'request.limitEnforced': {
    uk: '{text} Зупиніть або відкиньте непотрібні збірки.',
    ru: '{text} Остановите или отбросьте ненужные сборки.',
    en: '{text} Stop or drop the builds you do not need.',
  },
  'request.limitTitle': { uk: 'Ліміт живих збірок', ru: 'Лимит живых сборок', en: 'Live builds limit' },
  'request.badCompose': { uk: 'Неприпустиме ім’я compose-проєкту «{name}»', ru: 'Недопустимое имя compose-проекта «{name}»', en: 'Invalid compose project name «{name}»' },
  'request.prodCopy': {
    uk: 'Production не може копіювати БД іншої гілки: вкажіть database: backup або fresh',
    ru: 'Production не может копировать БД другой ветки: укажите database: backup или fresh',
    en: 'Production cannot copy another branch’s database: set database: backup or fresh',
  },
  'request.backupProdOnly': {
    uk: 'database: backup допустимо лише для Production',
    ru: 'database: backup допустима только для Production',
    en: 'database: backup is allowed only for Production',
  },
  'request.noBackup': {
    uk: 'Не знайдено бекап прода: папка {dir}, шаблон {pattern}. Покладіть файл .zip у папку або виберіть його у вкладці Backups.',
    ru: 'Не найден бэкап прода: папка {dir}, шаблон {pattern}. Положите файл .zip в папку или выберите его во вкладке Backups.',
    en: 'No production backup found: folder {dir}, pattern {pattern}. Put a .zip file into the folder or choose it on the Backups tab.',
  },
  'request.dirNotSet': { uk: '(не задано)', ru: '(не задана)', en: '(not set)' },
  'request.badBackup': {
    uk: 'Файл {file} не підходить: потрібен бекап Odoo (.zip) або дамп pg_dump -Fc з розширенням .dump.',
    ru: 'Файл {file} не подходит: нужен бэкап Odoo (.zip) или дамп pg_dump -Fc с расширением .dump.',
    en: 'File {file} does not fit: an Odoo backup (.zip) or a pg_dump -Fc dump with the .dump extension is needed.',
  },
  'request.backupMissing': { uk: 'Файл бекапу не знайдено: {file}', ru: 'Файл бэкапа не найден: {file}', en: 'Backup file not found: {file}' },

  'reconcile.stepInterrupted': { uk: 'перервано', ru: 'прервано', en: 'interrupted' },
  'reconcile.buildInterrupted': {
    uk: 'Збірку перервано: застосунок закрили або Core перезапущено. Натисніть «Повторити з кроку» або «Відкинути», щоб видалити створені нею ресурси.',
    ru: 'Сборка прервана: приложение было закрыто или Core перезапущен. Нажмите «Повторить с шага» или «Отбросить», чтобы удалить созданные ею ресурсы.',
    en: 'The build was interrupted: the app was closed or Core restarted. Press «Retry from step» or «Drop» to remove the resources it created.',
  },
  'reconcile.noContainer': {
    uk: 'Жива збірка {project} #{number}: контейнер не знайдено в Docker (видалено вручну?). Натисніть Rebuild або «Відкинути».',
    ru: 'Живая сборка {project} #{number}: контейнер не найден в Docker (удалён вручную?). Нажмите Rebuild или «Отбросить».',
    en: 'Live build {project} #{number}: the container is not in Docker (removed by hand?). Press Rebuild or «Drop».',
  },
  'reconcile.dbMissing': {
    uk: 'БД {db} живої збірки #{number} відсутня в Postgres.',
    ru: 'БД {db} живой сборки #{number} отсутствует в Postgres.',
    en: 'Database {db} of live build #{number} is missing from Postgres.',
  },
  'reconcile.worktreeMissing': {
    uk: 'Worktree гілки {branch} не знайдено ({path}); його буде створено заново під час збірки.',
    ru: 'Worktree ветки {branch} не найден ({path}); будет создан заново при сборке.',
    en: 'The worktree of branch {branch} is missing ({path}); it will be created again on the next build.',
  },
  'reconcile.notOrphan': { uk: '«{name}» не в списку сиріт — оновіть Status', ru: '«{name}» не в списке сирот — обновите Status', en: '«{name}» is not in the orphan list — refresh Status' },
  'reconcile.dbProtected': { uk: 'БД {db} захищена', ru: 'БД {db} защищена', en: 'Database {db} is protected' },
  'reconcile.outsideFilestore': { uk: 'Каталог поза filestore проєкту', ru: 'Каталог вне filestore проекта', en: 'The folder is outside the project filestore' },
  'reconcile.notDbTemplate': { uk: 'Каталог не відповідає шаблону БД', ru: 'Каталог не соответствует шаблону БД', en: 'The folder does not match the database template' },
  'reconcile.noLabel': { uk: 'У контейнера немає мітки bm.project', ru: 'У контейнера нет метки bm.project', en: 'The container has no bm.project label' },
  'reconcile.containerProtected': { uk: 'Контейнер захищено', ru: 'Контейнер защищён', en: 'The container is protected' },
  'reconcile.worktreeOutside': { uk: 'worktree поза папкою проєкту', ru: 'worktree вне папки проекта', en: 'the worktree is outside the project folder' },

  'repo.noHelper': {
    uk: 'У Git не налаштовано сховище облікових даних (credential.helper), тому увійти в приватний репозиторій не можна. ',
    ru: 'В Git не настроено хранилище учётных данных (credential.helper), поэтому войти в приватный репозиторий нельзя. ',
    en: 'Git has no credential store (credential.helper), so it cannot sign in to a private repository. ',
  },
  'repo.noHelperMac': {
    uk: 'Виконайте `git config --global credential.helper osxkeychain` (Зв’язка ключів macOS) або встановіть Git Credential Manager.',
    ru: 'Выполните `git config --global credential.helper osxkeychain` (Связка ключей macOS) или установите Git Credential Manager.',
    en: 'Run `git config --global credential.helper osxkeychain` (macOS Keychain) or install Git Credential Manager.',
  },
  'repo.noHelperWin': {
    uk: 'Встановіть Git for Windows з Git Credential Manager або виконайте `git config --global credential.helper manager`.',
    ru: 'Установите Git for Windows с Git Credential Manager или выполните `git config --global credential.helper manager`.',
    en: 'Install Git for Windows with Git Credential Manager or run `git config --global credential.helper manager`.',
  },
  'repo.tokenHttpsOnly': {
    uk: 'Токен підходить лише для https-адреси. Для SSH потрібен ключ.',
    ru: 'Токен подходит только для https-адреса. Для SSH нужен ключ.',
    en: 'A token works only with an https address. SSH needs a key.',
  },
  'repo.tokenRejected': { uk: 'Токен не підійшов: {error}', ru: 'Токен не подошёл: {error}', en: 'The token did not work: {error}' },
  'repo.noRemote': { uk: 'У репозиторію немає remote «{remote}»', ru: 'У репозитория нет remote «{remote}»', en: 'The repository has no remote «{remote}»' },
  'repo.fullPath': { uk: 'Вкажіть повний шлях до папки', ru: 'Укажите полный путь к папке', en: 'Give the full path to the folder' },
  'repo.dirExists': {
    uk: 'Папка {dir} уже існує і не порожня. Виберіть іншу.',
    ru: 'Папка {dir} уже существует и не пуста. Выберите другую.',
    en: 'Folder {dir} already exists and is not empty. Choose another one.',
  },
  'repo.dirNotEmpty': { uk: 'Папка {dir} не порожня', ru: 'Папка {dir} не пуста', en: 'Folder {dir} is not empty' },
  'repo.mirrorInit': {
    uk: 'копія репозиторію застосунку: git init --bare {dir} + git fetch {url}',
    ru: 'копия репозитория приложения: git init --bare {dir} + git fetch {url}',
    en: 'the app’s copy of the repository: git init --bare {dir} + git fetch {url}',
  },
  'repo.done': { uk: 'готово', ru: 'готово', en: 'done' },

  'store.idMismatch': { uk: 'id «{id}» не збігається з іменем файлу {file}.yaml', ru: 'id «{id}» не совпадает с именем файла {file}.yaml', en: 'id «{id}» does not match the file name {file}.yaml' },
  'store.invalid': {
    uk: 'Налаштування проєкту «{id}» містять помилку: {error}. Виправте {path}.',
    ru: 'Настройки проекта «{id}» содержат ошибку: {error}. Исправьте {path}.',
    en: 'The settings of project «{id}» have an error: {error}. Fix {path}.',
  },
  'store.idChange': {
    uk: 'Не можна змінювати id проєкту ({from} → {to}). Створіть новий проєкт.',
    ru: 'Нельзя менять id проекта ({from} → {to}). Создайте новый проект.',
    en: 'The project id cannot be changed ({from} → {to}). Create a new project.',
  },
  'store.exists': { uk: 'Проєкт з id «{id}» уже є. Виберіть інший id.', ru: 'Проект с id «{id}» уже есть. Выберите другой id.', en: 'A project with id «{id}» already exists. Choose another id.' },
  'store.badDb': {
    uk: 'naming.db дає неприпустиме ім’я БД «{db}»: лише a-z, 0-9, «_»',
    ru: 'naming.db даёт недопустимое имя БД «{db}»: только a-z, 0-9, «_»',
    en: 'naming.db gives an invalid database name «{db}»: only a-z, 0-9, «_»',
  },
  'store.dbNoBuild': {
    uk: 'naming.db має містити {build}: у кожної збірки своя БД',
    ru: 'naming.db должен содержать {build}: у каждой сборки своя БД',
    en: 'naming.db must contain {build}: every build has its own database',
  },
  'store.dbPrefix': {
    uk: 'naming.db має починатися з постійного префікса не коротше 3 символів (наприклад o19_br_): за ним застосунок упізнає свої БД',
    ru: 'naming.db должен начинаться с постоянного префикса не короче 3 символов (например o19_br_): по нему приложение узнаёт свои БД',
    en: 'naming.db must start with a fixed prefix of at least 3 characters (for example o19_br_): the app recognises its databases by it',
  },
  'store.dbProtected': { uk: 'naming.db може збігтися із захищеною БД «{db}»', ru: 'naming.db может совпасть с защищённой БД «{db}»', en: 'naming.db may match the protected database «{db}»' },
  'store.badRegex': { uk: '{field}: неправильний регулярний вираз ({error})', ru: '{field}: неверное регулярное выражение ({error})', en: '{field}: invalid regular expression ({error})' },
  'store.dbConflict': {
    uk: 'Шаблон naming.db («{tpl}») перетинається з проєктом «{other}» («{otherTpl}»). Задайте інший префікс.',
    ru: 'Шаблон naming.db («{tpl}») пересекается с проектом «{other}» («{otherTpl}»). Задайте другой префикс.',
    en: 'The naming.db template («{tpl}») overlaps with project «{other}» («{otherTpl}»). Set another prefix.',
  },
  'store.conflict': {
    uk: '{field} («{tpl}») може збігтися з проєктом «{other}» («{otherTpl}»). Додайте {project} або інший суфікс.',
    ru: '{field} («{tpl}») может совпасть с проектом «{other}» («{otherTpl}»). Добавьте {project} или другой суффикс.',
    en: '{field} («{tpl}») may match project «{other}» («{otherTpl}»). Add {project} or another suffix.',
  },

  'detect.noMirror': {
    uk: 'Копію репозиторію «{dir}» не знайдено: завантажте репозиторій заново.',
    ru: 'Копия репозитория «{dir}» не найдена: загрузите репозиторий заново.',
    en: 'The repository copy «{dir}» was not found: load the repository again.',
  },
  'detect.noBranches': { uk: 'У репозиторії немає жодної гілки.', ru: 'В репозитории нет ни одной ветки.', en: 'The repository has no branches.' },
  'detect.noModules': {
    uk: 'У репозиторії не знайдено жодного модуля Odoo (__manifest__.py на глибині до 4).',
    ru: 'В репозитории не найдено ни одного модуля Odoo (__manifest__.py на глубине до 4).',
    en: 'No Odoo modules found in the repository (__manifest__.py up to depth 4).',
  },
  'detect.noDocker': {
    uk: 'Docker недоступний: {error}. Образ, мережу і Postgres треба вказати вручну.',
    ru: 'Docker недоступен: {error}. Образ, сеть и Postgres нужно указать вручную.',
    en: 'Docker is unavailable: {error}. Set the image, network and Postgres by hand.',
  },
  'detect.pgNoPort': {
    uk: 'Postgres «{name}» не публікує порт на хост: застосунку потрібен доступ до нього з localhost.',
    ru: 'Postgres «{name}» не публикует порт на хост: приложению нужен доступ к нему с localhost.',
    en: 'Postgres «{name}» does not publish a port to the host: the app needs to reach it from localhost.',
  },
  'detect.pgStopped': { uk: 'Контейнер Postgres «{name}» не запущено.', ru: 'Контейнер Postgres «{name}» не запущен.', en: 'Postgres container «{name}» is not running.' },
  'detect.noPg': { uk: 'У мережі {network} не знайдено контейнер Postgres.', ru: 'В сети {network} не найден контейнер Postgres.', en: 'No Postgres container found in network {network}.' },
  'detect.noOdooForRepo': {
    uk: 'Не знайдено контейнер Odoo, який монтує цей репозиторій. Пресет «Odoo в Docker» підніме Odoo і Postgres сам; для Generic образ, мережу і Postgres треба вказати вручну.',
    ru: 'Не найден контейнер Odoo, монтирующий этот репозиторий. Пресет «Odoo в Docker» поднимет Odoo и Postgres сам; для Generic образ, сеть и Postgres нужно указать вручную.',
    en: 'No Odoo container mounts this repository. The «Odoo in Docker» preset starts Odoo and Postgres itself; for Generic set the image, network and Postgres by hand.',
  },
  'detect.noOdoo': {
    uk: 'Пресет «Odoo в Docker» підніме Odoo і Postgres сам. Для Generic вкажіть папку свого клону, змонтованого у ваш контейнер Odoo, або впишіть образ, мережу і Postgres вручну.',
    ru: 'Пресет «Odoo в Docker» поднимет Odoo и Postgres сам. Для Generic укажите папку своего клона, который смонтирован в ваш контейнер Odoo, или впишите образ, сеть и Postgres вручную.',
    en: 'The «Odoo in Docker» preset starts Odoo and Postgres itself. For Generic give the folder of your clone mounted into your Odoo container, or enter the image, network and Postgres by hand.',
  },
  'detect.seriesUnsupported': {
    uk: 'Модулі репозиторію розраховані на Odoo {series}; пресет «Odoo в Docker» підтримує {versions}.',
    ru: 'Модули репозитория рассчитаны на Odoo {series}; пресет «Odoo в Docker» поддерживает {versions}.',
    en: 'The repository modules target Odoo {series}; the «Odoo in Docker» preset supports {versions}.',
  },
  'detect.seriesMismatch': {
    uk: 'Модулі репозиторію розраховані на Odoo {series}, а вибрано Odoo {version}.',
    ru: 'Модули репозитория рассчитаны на Odoo {series}, а выбрана Odoo {version}.',
    en: 'The repository modules target Odoo {series}, but Odoo {version} is selected.',
  },
  'detect.noWebEnterprise': {
    uk: 'У папці Enterprise {dir} немає модуля web_enterprise: вкажіть корінь репозиторію odoo/enterprise потрібної версії.',
    ru: 'В папке Enterprise {dir} нет модуля web_enterprise: укажите корень репозитория odoo/enterprise нужной версии.',
    en: 'The Enterprise folder {dir} has no web_enterprise module: give the root of the odoo/enterprise repository of the right version.',
  },
  'detect.enterpriseMismatch': {
    uk: 'Enterprise у {dir} — версії {series}, а вибрано Odoo {version}.',
    ru: 'Enterprise в {dir} — версии {series}, а выбрана Odoo {version}.',
    en: 'Enterprise in {dir} is version {series}, but Odoo {version} is selected.',
  },

  'wt.noRemoteBranch': {
    uk: 'Гілки «{name}» немає в {remote}: її видалили або перейменували на GitHub. Якщо гілку щойно створено, натисніть «Оновити» (fetch); інакше видаліть її в застосунку.',
    ru: 'Ветки «{name}» нет в {remote}: её удалили или переименовали на GitHub. Если ветка только что создана, нажмите «Обновить» (fetch); иначе удалите её в приложении.',
    en: 'Branch «{name}» is not in {remote}: it was deleted or renamed on GitHub. If the branch was just created, press «Refresh» (fetch); otherwise delete it in the app.',
  },
  'wt.noMirrorDir': { uk: 'У проєкту «{id}» не задано repo.mirrorDir', ru: 'У проекта «{id}» не задан repo.mirrorDir', en: 'Project «{id}» has no repo.mirrorDir' },
  'wt.noDir': { uk: 'Папку «{dir}» не знайдено.', ru: 'Папка «{dir}» не найдена.', en: 'Folder «{dir}» not found.' },
  'wt.notRepo': { uk: 'Папка «{dir}» не є git-репозиторієм.', ru: 'Папка «{dir}» не является git-репозиторием.', en: 'Folder «{dir}» is not a git repository.' },
  'wt.notRoot': { uk: 'Вкажіть корінь репозиторію: {top}', ru: 'Укажите корень репозитория: {top}', en: 'Give the repository root: {top}' },
  'wt.wrongBranch': {
    uk: 'У папці {folder} відкрито гілку {open}, а збірка — гілки {branch}. Збірку заблоковано, з нею нічого не відбувається. Відкрийте в папці {branch} (git checkout {branch}) або виберіть джерело коду «З GitHub» (вкладка Editor). Працює лише Stop.',
    ru: 'В папке {folder} открыта ветка {open}, а сборка — ветки {branch}. Сборка заблокирована, с ней ничего не происходит. Откройте в папке {branch} (git checkout {branch}) или выберите источник кода «С GitHub» (вкладка Editor). Работает только Stop.',
    en: 'Folder {folder} has branch {open} checked out, but the build is of branch {branch}. The build is blocked, nothing happens to it. Check out {branch} in the folder (git checkout {branch}) or choose the «From GitHub» code source (Editor tab). Only Stop works.',
  },
  'wt.noBuildCommit': {
    uk: 'Коміту збірки {sha} немає в копії репозиторію ({remote}): збірка йшла з вашої папки, а коміт не відправлено. Відправте його (git push) і натисніть «Оновити» або натисніть Rebuild — збірка візьме код гілки з GitHub.',
    ru: 'Коммита сборки {sha} нет в копии репозитория ({remote}): сборка шла из вашей папки, а коммит не отправлен. Отправьте его (git push) и нажмите «Обновить» или нажмите Rebuild — сборка возьмёт код ветки с GitHub.',
    en: 'Build commit {sha} is not in the repository copy ({remote}): the build used your folder and the commit was not pushed. Push it (git push) and press «Refresh», or press Rebuild — the build will take the branch code from GitHub.',
  },
  'wt.dirty': {
    uk: 'У worktree {wt} є незакомічені зміни, а він має стояти на коміті збірки {sha}. Нічого не затирається: перенесіть або скасуйте зміни (правте код у своїй папці, див. Editor → «Код з моєї папки»).\n{files}',
    ru: 'В worktree {wt} есть незакоммиченные изменения, а он должен стоять на коммите сборки {sha}. Ничего не затирается: перенесите или отмените изменения (правьте код в своей папке, см. Editor → «Код из моей папки»).\n{files}',
    en: 'Worktree {wt} has uncommitted changes, but it must be at build commit {sha}. Nothing is overwritten: move or discard the changes (edit code in your own folder, see Editor → «Code from my folder»).\n{files}',
  },
  'wt.checkout': {
    uk: 'worktree на {head}, а збірка — на {sha}: git checkout --detach {sha}',
    ru: 'worktree на {head}, а сборка — на {sha}: git checkout --detach {sha}',
    en: 'worktree is at {head}, the build at {sha}: git checkout --detach {sha}',
  },

  'presets.exportHeader': {
    uk: 'Експорт проєкту {id} з Odoo Branch Manager, {at}.\nПрибрано: {removed}.\nСтворити проєкт із файла: «Додати проєкт» → крок «Пресет» → «З файла…».',
    ru: 'Экспорт проекта {id} из Odoo Branch Manager, {at}.\nУбрано: {removed}.\nСоздать проект из файла: «Добавить проект» → шаг «Пресет» → «Из файла…».',
    en: 'Project {id} exported from Odoo Branch Manager, {at}.\nRemoved: {removed}.\nTo create a project from the file: «Add project» → «Preset» step → «From file…».',
  },
  'presets.presetHeader': {
    uk: 'Пресет Odoo Branch Manager «{name}»: налаштування без паролів, шляхів цього комп’ютера та назв проєкту.\nМайстер «Додати проєкт» кладе config поверх того, що знайшов у вибраному репозиторії.',
    ru: 'Пресет Odoo Branch Manager «{name}»: настройки без паролей, путей этого компьютера и имён проекта.\nМастер «Добавить проект» кладёт config поверх того, что нашёл в выбранном репозитории.',
    en: 'Odoo Branch Manager preset «{name}»: settings without passwords, paths of this computer and project names.\nThe «Add project» wizard lays config over what it detected in the chosen repository.',
  },
  'presets.relative': {
    uk: 'Потрібен повний шлях до файла, а не «{path}».',
    ru: 'Нужен полный путь к файлу, а не «{path}».',
    en: 'A full path to the file is needed, not «{path}».',
  },
  'presets.notYaml': {
    uk: 'Файл {file} — не YAML: {error}',
    ru: 'Файл {file} — не YAML: {error}',
    en: 'File {file} is not YAML: {error}',
  },
  'presets.notConfig': {
    uk: 'Файл {file} не схожий на пресет чи експорт проєкту Odoo Branch Manager. Виберіть файл, збережений кнопкою «Зберегти як пресет» або «Експорт».',
    ru: 'Файл {file} не похож на пресет или экспорт проекта Odoo Branch Manager. Выберите файл, сохранённый кнопкой «Сохранить как пресет» или «Экспорт».',
    en: 'File {file} does not look like an Odoo Branch Manager preset or project export. Pick a file saved with «Save as preset» or «Export».',
  },
  'presets.missing': {
    uk: 'Файл {file} не знайдено. Виберіть інший пресет або файл.',
    ru: 'Файл {file} не найден. Выберите другой пресет или файл.',
    en: 'File {file} not found. Pick another preset or file.',
  },
  'presets.tooBig': {
    uk: 'Файл {file} завеликий для налаштувань (понад 1 МБ). Виберіть файл пресета чи експорту.',
    ru: 'Файл {file} слишком большой для настроек (больше 1 МБ). Выберите файл пресета или экспорта.',
    en: 'File {file} is too big for settings (over 1 MB). Pick a preset or export file.',
  },
  'presets.badName': {
    uk: 'Недопустима назва файла пресета: {file}',
    ru: 'Недопустимое имя файла пресета: {file}',
    en: 'Invalid preset file name: {file}',
  },
} satisfies Record<string, Entry>;
