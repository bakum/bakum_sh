import type { Entry } from '@bm/shared';

/** Branches page, branch header, stage move and add dialogs. */
export default {
  'branch.openFailed': { uk: 'Не вдалося відкрити', ru: 'Не удалось открыть', en: 'Could not open' },
  'branch.mirrorTip': {
    uk: 'Локальна копія, відновлена з бекапу прода. З бойовим сервером застосунок не з’єднується.',
    ru: 'Локальная копия, восстановленная из бэкапа прода. С боевым сервером приложение не соединяется.',
    en: 'A local copy restored from a production backup. The app never connects to the live server.',
  },
  'branch.mirror': { uk: 'Дзеркало прода (локально)', ru: 'Зеркало прода (локально)', en: 'Production mirror (local)' },
  'branch.pinnedTip': { uk: 'Стадію зафіксовано вручну', ru: 'Стадия зафиксирована вручную', en: 'The stage was set by hand' },
  'branch.pinned': { uk: 'вручну', ru: 'вручную', en: 'manual' },
  'branch.codeFolder': { uk: 'код з вашої папки {folder}', ru: 'код из вашей папки {folder}', en: 'code from your folder {folder}' },
  'branch.codeGithub': { uk: 'код з GitHub · {path}', ru: 'код с GitHub · {path}', en: 'code from GitHub · {path}' },
  'branch.noWorktree': { uk: 'worktree ще не створено', ru: 'worktree ещё не создан', en: 'no worktree yet' },
  'branch.copyPath': { uk: 'Скопіювати шлях до коду', ru: 'Скопировать путь к коду', en: 'Copy the code path' },
  'branch.copyClone': { uk: 'Скопіювати команду git clone', ru: 'Скопировать команду git clone', en: 'Copy the git clone command' },
  'branch.apply': { uk: 'Застосувати', ru: 'Применить', en: 'Apply' },
  'branch.mailpit': {
    uk: 'Mailpit у збірках відкладено. Листи зі збірок назовні не йдуть: у копіях прода поштові сервери вимкнено нейтралізацією, у чистих БД їх немає. Не вмикайте поштовий сервер вручну в збірці з копією прода — листи підуть справжнім адресатам.',
    ru: 'Mailpit в сборках отложен. Письма из сборок наружу не уходят: в копиях прода почтовые серверы выключены нейтрализацией, в чистых БД их нет. Не включайте почтовый сервер вручную в сборке с копией прода — письма уйдут настоящим адресатам.',
    en: 'Mailpit in builds is postponed. Mail from builds does not go out: in production copies the mail servers are switched off by neutralization, clean databases have none. Do not switch a mail server on by hand in a build with a production copy — mail would go to real recipients.',
  },

  'branches.fetchStarted': { uk: 'Fetch запущено', ru: 'Fetch запущен', en: 'Fetch started' },
  'branches.legacy': {
    uk: 'Проєкт створено за старою схемою: застосунок працював усередині вашого репозиторію, збірки й fetch для нього вимкнено. Видаліть проєкт (Settings → «Видалити проєкт…») і додайте наново — код збірок братиметься з GitHub.',
    ru: 'Проект создан по старой схеме: приложение работало внутри вашего репозитория, сборки и fetch для него отключены. Удалите проект (Settings → «Удалить проект…») и добавьте заново — код сборок будет браться с GitHub.',
    en: 'The project was created the old way: the app worked inside your repository; builds and fetch are off for it. Delete the project (Settings → «Delete project…») and add it again — build code will come from GitHub.',
  },
  'branches.fetchFailed': { uk: 'Останній fetch завершився помилкою: {error}', ru: 'Последний fetch завершился ошибкой: {error}', en: 'The last fetch failed: {error}' },
  'branches.accessOk': { uk: 'Доступ є, fetch запущено', ru: 'Доступ есть, fetch запущен', en: 'Access granted, fetch started' },
  'branches.noAccess': { uk: 'Немає доступу', ru: 'Нет доступа', en: 'No access' },
  'branches.login': { uk: 'Увійти', ru: 'Войти', en: 'Sign in' },
  'branches.select': { uk: 'Виберіть гілку', ru: 'Выберите ветку', en: 'Choose a branch' },
  'branches.dragHint': {
    uk: 'Перетягніть гілку в іншу стадію, щоб змінити її; на іншу гілку — щоб відкрити Merge.',
    ru: 'Перетащите ветку в другую стадию, чтобы сменить её; на другую ветку — чтобы открыть Merge.',
    en: 'Drag a branch into another stage to change its stage; onto another branch to open Merge.',
  },

  'move.rebuildQueued': { uk: 'Rebuild поставлено в чергу', ru: 'Rebuild поставлен в очередь', en: 'Rebuild queued' },
  'move.title': { uk: 'Змінити стадію: {branch}', ru: 'Сменить стадию: {branch}', en: 'Change stage: {branch}' },
  'move.prodTitle': { uk: 'Зміна продакшн-гілки', ru: 'Смена продакшн-ветки', en: 'Changing the production branch' },
  'move.prodText': {
    uk: 'Поточна продакшн-гілка {current} піде в Development. Дзеркало прода для нової гілки треба перестворити імпортом бекапу (Backups → Імпортувати).',
    ru: 'Текущая продакшн-ветка {current} уйдёт в Development. Зеркало прода для новой ветки нужно пересоздать импортом бэкапа (Backups → Импортировать).',
    en: 'The current production branch {current} goes to Development. The production mirror for the new branch must be recreated by importing a backup (Backups → Import).',
  },
  'move.noRebuild': {
    uk: 'Збірка сама не перестворюється: у гілки з’явиться позначка «налаштування стадії змінилися — Rebuild».',
    ru: 'Сборка сама не пересоздаётся: у ветки появится отметка «настройки стадии изменились — Rebuild».',
    en: 'The build is not recreated by itself: the branch gets the «stage settings changed — Rebuild» mark.',
  },
  'move.confirm': { uk: 'Змінити стадію', ru: 'Сменить стадию', en: 'Change stage' },
  'move.done': {
    uk: 'Стадію змінено. Перезібрати гілку за правилами нової стадії зараз?',
    ru: 'Стадия изменена. Пересобрать ветку по правилам новой стадии сейчас?',
    en: 'The stage was changed. Rebuild the branch with the new stage’s rules now?',
  },
  'move.later': { uk: 'Пізніше', ru: 'Позже', en: 'Later' },

  'add.autoAll': {
    uk: 'Нові гілки з GitHub застосунок додає сам під час fetch. Тут бувають лише гілки, які ви видалили із застосунку.',
    ru: 'Новые ветки с GitHub приложение добавляет само при fetch. Здесь бывают только ветки, которые вы удалили из приложения.',
    en: 'The app adds new branches from GitHub by itself on fetch. Only branches you deleted from the app show up here.',
  },
  'add.autoRules': {
    uk: 'Нові гілки з GitHub, що підходять під правила стадій, застосунок додає сам під час fetch. Тут — решта й ті, що ви видалили із застосунку.',
    ru: 'Новые ветки с GitHub, подходящие под правила стадий, приложение добавляет само при fetch. Здесь — остальные и те, что вы удалили из приложения.',
    en: 'The app adds new branches from GitHub that match the stage rules by itself on fetch. Here are the others and those you deleted from the app.',
  },
  'add.autoNone': {
    uk: 'Гілку, щойно створену на GitHub, тут видно після fetch.',
    ru: 'Ветку, только что созданную на GitHub, здесь видно после fetch.',
    en: 'A branch just created on GitHub shows up here after fetch.',
  },
  'add.title': { uk: 'Додати гілку в {stage}', ru: 'Добавить ветку в {stage}', en: 'Add a branch to {stage}' },
  'add.about': {
    uk: 'Підключає до застосунку гілку, яка вже є в репозиторії на GitHub. Нову гілку тут створити не можна.',
    ru: 'Подключает к приложению ветку, которая уже есть в репозитории на GitHub. Новую ветку здесь создать нельзя.',
    en: 'Connects a branch that already exists in the GitHub repository to the app. A new branch cannot be created here.',
  },
  'add.select': {
    uk: 'Гілка з репозиторію, ще не додана в застосунок',
    ru: 'Ветка из репозитория, ещё не добавленная в приложение',
    en: 'A repository branch not yet added to the app',
  },
  'add.nothing': { uk: 'Такої гілки немає — виконайте fetch', ru: 'Такой ветки нет — выполните fetch', en: 'No such branch — run fetch' },
  'add.allAdded': { uk: 'Усі гілки репозиторію вже додано в застосунок.', ru: 'Все ветки репозитория уже добавлены в приложение.', en: 'All repository branches are already in the app.' },
  'add.appears': { uk: 'Гілка з’явиться в {stage}; на GitHub нічого не змінюється.', ru: 'Ветка появится в {stage}; на GitHub ничего не меняется.', en: 'The branch appears in {stage}; nothing changes on GitHub.' },
  'add.buildNow': { uk: 'Одразу почнеться збірка', ru: 'Сразу начнётся сборка', en: 'A build starts at once' },
  'add.noBuild': {
    uk: 'Збірка сама не почнеться (вимкнено «Збирати під час додавання») — запустіть її кнопкою Rebuild на сторінці гілки',
    ru: 'Сборка сама не начнётся (выключено «Собирать при добавлении») — запустите её кнопкой Rebuild на странице ветки',
    en: 'No build starts by itself («Build when added» is off) — start it with Rebuild on the branch page',
  },
  'add.code': { uk: ': код з <b>{name}</b>, база — ', ru: ': код из <b>{name}</b>, база — ', en: ': code from <b>{name}</b>, database — ' },
  'add.copyOf': { uk: 'копія бази <b>{name}</b>', ru: 'копия базы <b>{name}</b>', en: 'a copy of the <b>{name}</b> database' },
  'add.clean': { uk: 'чиста', ru: 'чистая', en: 'clean' },
  'add.cleanDemo': { uk: 'чиста з демо-даними', ru: 'чистая с демо-данными', en: 'clean with demo data' },
  'add.forkHint': {
    uk: 'Нову гілку від наявної створює Fork на сторінці гілки-джерела.',
    ru: 'Новую ветку от существующей создаёт Fork на странице ветки-источника.',
    en: 'Fork on the source branch page creates a new branch from an existing one.',
  },
  'add.add': { uk: 'Додати', ru: 'Добавить', en: 'Add' },
} satisfies Record<string, Entry>;
