import type { Entry } from '@bm/shared';

/** Repository access and cloning (RepoClone). */
export default {
  'repo.url': { uk: 'Адреса репозиторію', ru: 'Адрес репозитория', en: 'Repository address' },
  'repo.urlPlaceholder': {
    uk: 'https://github.com/owner/repo.git або git@github.com:owner/repo.git',
    ru: 'https://github.com/owner/repo.git или git@github.com:owner/repo.git',
    en: 'https://github.com/owner/repo.git or git@github.com:owner/repo.git',
  },
  'repo.check': { uk: 'Перевірити доступ', ru: 'Проверить доступ', en: 'Check access' },
  'repo.ok': { uk: 'Доступ є: гілок {n}', ru: 'Доступ есть: веток {n}', en: 'Access granted: {n} branches' },
  'repo.default': { uk: ', основна — {branch}', ru: ', основная — {branch}', en: ', default {branch}' },
  'repo.noBranch': {
    uk: 'Гілки {branch} у репозиторії немає — клонувати нічого.',
    ru: 'Ветки {branch} в репозитории нет — клонировать нечего.',
    en: 'The repository has no branch {branch} — nothing to clone.',
  },
  'repo.noAccess': { uk: 'Немає доступу', ru: 'Нет доступа', en: 'No access' },
  'repo.browserLogin': { uk: 'Увійти через браузер', ru: 'Войти через браузер', en: 'Sign in with the browser' },
  'repo.gcmMac': {
    uk: 'Відкриється вікно Git Credential Manager; облікові дані збереже Зв’язка ключів.',
    ru: 'Откроется окно Git Credential Manager; учётные данные сохранит Связка ключей.',
    en: 'The Git Credential Manager window opens; Keychain stores the credentials.',
  },
  'repo.gcmWin': {
    uk: 'Відкриється вікно Git Credential Manager; облікові дані збереже Windows.',
    ru: 'Откроется окно Git Credential Manager; учётные данные сохранит Windows.',
    en: 'The Git Credential Manager window opens; Windows stores the credentials.',
  },
  'repo.orToken': { uk: 'Або токен доступу', ru: 'Или токен доступа', en: 'Or an access token' },
  'repo.tokenHow': {
    uk: 'GitHub → Settings → Developer settings → Personal access tokens: fine-grained, доступ до цього репозиторію, Contents — Read-only (для Fork, який створює гілки на GitHub, — Read and write).',
    ru: 'GitHub → Settings → Developer settings → Personal access tokens: fine-grained, доступ к этому репозиторию, Contents — Read-only (для Fork, который создаёт ветки на GitHub, — Read and write).',
    en: 'GitHub → Settings → Developer settings → Personal access tokens: fine-grained, access to this repository, Contents — Read-only (Read and write for Fork, which creates branches on GitHub).',
  },
  'repo.createToken': { uk: 'Створити токен', ru: 'Создать токен', en: 'Create a token' },
  'repo.tokenStoreMac': {
    uk: '. Токен передається в Git (Зв’язка ключів macOS), застосунок його не зберігає.',
    ru: '. Токен передаётся в Git (Связка ключей macOS), приложение его не сохраняет.',
    en: '. The token goes to Git (macOS Keychain); the app does not store it.',
  },
  'repo.tokenStoreWin': {
    uk: '. Токен передається в Git (сховище облікових даних Windows), застосунок його не зберігає.',
    ru: '. Токен передаётся в Git (хранилище учётных данных Windows), приложение его не сохраняет.',
    en: '. The token goes to Git (the Windows credential store); the app does not store it.',
  },
  'repo.token': { uk: 'Токен', ru: 'Токен', en: 'Token' },
  'repo.user': { uk: 'Користувач', ru: 'Пользователь', en: 'User' },
  'repo.saveToken': { uk: 'Зберегти токен', ru: 'Сохранить токен', en: 'Save token' },
  'repo.sshHint': {
    uk: 'Для SSH-адреси потрібні ключ в ssh-agent і ключ хоста в known_hosts. Простіше — https-адреса зі входом через браузер.',
    ru: 'Для SSH-адреса нужны ключ в ssh-agent и ключ хоста в known_hosts. Проще — https-адрес со входом через браузер.',
    en: 'An SSH address needs a key in ssh-agent and the host key in known_hosts. Simpler: an https address with browser sign-in.',
  },
  'repo.mirrorHint': {
    uk: 'Застосунок зробить свою копію репозиторію у своїй папці й братиме з неї код збірок. Ваші клони він не чіпає.',
    ru: 'Приложение сделает свою копию репозитория в своей папке и будет брать из неё код сборок. Ваши клоны оно не трогает.',
    en: 'The app makes its own copy of the repository in its folder and takes build code from it. It does not touch your clones.',
  },
  'repo.load': { uk: 'Завантажити', ru: 'Загрузить', en: 'Load' },
  'repo.cloneTo': { uk: 'Куди клонувати', ru: 'Куда клонировать', en: 'Clone into' },
  'repo.cloneParent': { uk: 'Папка, у яку покласти клон', ru: 'Папка, в которую положить клон', en: 'Folder to put the clone in' },
  'repo.choose': { uk: 'Вибрати…', ru: 'Выбрать…', en: 'Choose…' },
  'repo.clone': { uk: 'Клонувати', ru: 'Клонировать', en: 'Clone' },
  'repo.loadedTo': { uk: 'Завантажено в <code>{dir}</code>', ru: 'Загружено в <code>{dir}</code>', en: 'Loaded into <code>{dir}</code>' },
  'repo.clonedTo': { uk: 'Клоновано в <code>{dir}</code>', ru: 'Клонировано в <code>{dir}</code>', en: 'Cloned into <code>{dir}</code>' },
} satisfies Record<string, Entry>;
