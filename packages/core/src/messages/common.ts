import type { Entry } from '@bm/shared';

/** Small services, RPC, utilities. */
export default {
  'rpc.notImplemented': { uk: 'Метод {method} не реалізовано', ru: 'Метод {method} не реализован', en: 'Method {method} is not implemented' },
  'rpc.unknownMethod': { uk: 'Невідомий метод {method}', ru: 'Неизвестный метод {method}', en: 'Unknown method {method}' },
  'rpc.noTopic': { uk: 'Немає підписки {topic}', ru: 'Нет подписки {topic}', en: 'No subscription {topic}' },

  'lifecycle.expiredTitle': { uk: 'Збірку можна відкинути: {branch}', ru: 'Сборку можно отбросить: {branch}', en: 'The build can be dropped: {branch}' },
  'lifecycle.expiredBody': {
    uk: '#{number}: {days} дн. без нових комітів і відвідувань. Відкинути — History → CONNECT ▾ → «Відкинути збірку…».',
    ru: '#{number}: {days} дн. без новых коммитов и заходов. Отбросить — History → CONNECT ▾ → «Отбросить сборку…».',
    en: '#{number}: {days} days without new commits or visits. To drop it: History → CONNECT ▾ → «Drop build…».',
  },

  'setup.ready': { uk: 'проєкт {id} готовий до збірок', ru: 'проект {id} готов к сборкам', en: 'project {id} is ready for builds' },
  'setup.noBuild': {
    uk: 'У налаштуваннях проєкту не задано runtime.build (збирання образу з Dockerfile)',
    ru: 'В настройках проекта не задан runtime.build (сборка образа из Dockerfile)',
    en: 'runtime.build (building the image from a Dockerfile) is not set in the project settings',
  },

  'zip.encrypted': { uk: '{name}: запис зашифровано', ru: '{name}: запись зашифрована', en: '{name}: the entry is encrypted' },
  'zip.crc': {
    uk: '{name}: не збігається контрольна сума (CRC-32), архів пошкоджено',
    ru: '{name}: не совпадает контрольная сумма (CRC-32), архив повреждён',
    en: '{name}: checksum mismatch (CRC-32), the archive is damaged',
  },
  'zip.outside': { uk: '{name}: шлях веде за межі {root}', ru: '{name}: путь ведёт за пределы {root}', en: '{name}: the path leads outside {root}' },

  'backup.foundTitle': { uk: 'Знайдено новий бекап прода: {project}', ru: 'Найден новый бэкап прода: {project}', en: 'New production backup found: {project}' },
  'backup.importStarted': { uk: '{name} — імпорт запущено', ru: '{name} — импорт запущен', en: '{name} — import started' },
  'backup.importInTab': { uk: '{name} — імпорт у вкладці Backups', ru: '{name} — импорт во вкладке Backups', en: '{name} — import it on the Backups tab' },
  'backup.autoImportFailed': {
    uk: 'Автоімпорт бекапу не запущено: {project}',
    ru: 'Автоимпорт бэкапа не запущен: {project}',
    en: 'Backup auto-import did not start: {project}',
  },

  'tpl.unknownVar': {
    uk: 'Шаблон «{tpl}»: невідома змінна {name}. Допустимі: {vars}',
    ru: 'Шаблон «{tpl}»: неизвестная переменная {name}. Допустимые: {vars}',
    en: 'Template «{tpl}»: unknown variable {name}. Allowed: {vars}',
  },
  'tpl.missingVar': {
    uk: 'Шаблон «{tpl}»: змінну {name} тут не визначено',
    ru: 'Шаблон «{tpl}»: переменная {name} здесь не определена',
    en: 'Template «{tpl}»: variable {name} is not defined here',
  },
  'tpl.what.db': { uk: 'ім’я БД', ru: 'имя БД', en: 'database name' },
  'tpl.what.srcDb': { uk: 'ім’я БД-джерела', ru: 'имя БД-источника', en: 'source database name' },
  'tpl.what.dbUser': { uk: 'користувач БД', ru: 'пользователь БД', en: 'database user' },
  'tpl.badIdent': {
    uk: 'Неприпустиме значення ({what}) «{name}»: дозволено лише a-z, 0-9, «_», до 63 символів. Перевірте шаблон naming.db.',
    ru: 'Недопустимое {what} «{name}»: разрешены только a-z, 0-9, «_», до 63 символов. Проверьте шаблон naming.db.',
    en: 'Invalid {what} «{name}»: only a-z, 0-9 and «_» are allowed, up to 63 characters. Check the naming.db template.',
  },
  'tpl.badHost': {
    uk: 'Неприпустиме ім’я хоста «{host}». Перевірте шаблон naming.host.',
    ru: 'Недопустимое имя хоста «{host}». Проверьте шаблон naming.host.',
    en: 'Invalid host name «{host}». Check the naming.host template.',
  },

  'traefik.execFailed': { uk: 'docker exec {container}: код {code}', ru: 'docker exec {container}: код {code}', en: 'docker exec {container}: exit code {code}' },
  'traefik.portBusy': {
    uk: 'порт {port} зайнятий іншим процесом. Вкажіть вільний порт у Settings → Застосунок → Порт Traefik (наприклад 8080).',
    ru: 'порт {port} занят другим процессом. Укажите свободный порт в Settings → Приложение → Порт Traefik (например 8080).',
    en: 'port {port} is used by another process. Set a free port in Settings → Application → Traefik port (for example 8080).',
  },
  'traefik.pullFailed': { uk: 'не вдалося завантажити образ {image}: {error}', ru: 'не удалось скачать образ {image}: {error}', en: 'could not pull image {image}: {error}' },
  'traefik.notRunning': { uk: 'Traefik не запущено: {error}', ru: 'Traefik не запущен: {error}', en: 'Traefik is not running: {error}' },

  'branchDelete.confirm': { uk: 'Для видалення введіть slug гілки: {slug}', ru: 'Для удаления введите slug ветки: {slug}', en: 'To delete, type the branch slug: {slug}' },
  'branchDelete.remotePostponed': {
    uk: 'Видалення гілки в origin відкладено (docs/decisions.md D44): видаліть її на GitHub.',
    ru: 'Удаление ветки в origin отложено (docs/decisions.md D44): удалите её на GitHub.',
    en: 'Deleting the branch in origin is postponed (docs/decisions.md D44): delete it on GitHub.',
  },
  'branchDelete.protected': {
    uk: 'Гілку захищено: зніміть захист (protected) у Settings гілки. Production видалити не можна.',
    ru: 'Ветка защищена: снимите защиту (protected) в Settings ветки. Production удалить нельзя.',
    en: 'The branch is protected: turn off protection (protected) in the branch Settings. Production cannot be deleted.',
  },
  'branchDelete.dirty': {
    uk: 'У worktree є незакомічені зміни:\n{dirty}\nПідтвердьте їх втрату окремо.',
    ru: 'В worktree есть незакоммиченные изменения:\n{dirty}\nПодтвердите их потерю отдельно.',
    en: 'The worktree has uncommitted changes:\n{dirty}\nConfirm losing them separately.',
  },
  'branchDelete.removedTitle': { uk: 'Гілку {branch} видалено', ru: 'Ветка {branch} удалена', en: 'Branch {branch} deleted' },
  'branchDelete.removedBody': {
    uk: 'Її видалили на GitHub; відкинуто збірок: {n}.',
    ru: 'Её удалили на GitHub; сборок отброшено: {n}.',
    en: 'It was deleted on GitHub; builds dropped: {n}.',
  },

  'system.appYamlComment': {
    uk: ' Налаштування рівня застосунку Odoo Branch Manager (розділ 9 ТЗ). Зміни файлу підхоплюються автоматично.',
    ru: ' Настройки уровня приложения Odoo Branch Manager (раздел 9 ТЗ). Правка файла подхватывается автоматически.',
    en: ' Application-level settings of Odoo Branch Manager (spec section 9). Edits to this file are picked up automatically.',
  },
  'system.ghMissing': {
    uk: 'gh не знайдено: Merge відкриватиме сторінку compare на GitHub',
    ru: 'gh не найден: Merge будет открывать страницу compare на GitHub',
    en: 'gh not found: Merge will open the compare page on GitHub',
  },
  'system.dockerDown': { uk: 'Docker недоступний: {error}', ru: 'Docker недоступен: {error}', en: 'Docker is unavailable: {error}' },
  'system.noAnswer': { uk: 'немає відповіді', ru: 'нет ответа', en: 'no response' },
  'system.traefikRunning': { uk: 'працює, порт {port}', ru: 'работает, порт {port}', en: 'running, port {port}' },
  'system.traefikStopped': { uk: 'не запущено', ru: 'не запущен', en: 'not running' },
  'system.noDockerDesktop': {
    uk: 'Docker Desktop не знайдено ({exe}). Вкажіть шлях в app.yaml → desktop.dockerDesktopExe.',
    ru: 'Docker Desktop не найден ({exe}). Укажите путь в app.yaml → desktop.dockerDesktopExe.',
    en: 'Docker Desktop not found ({exe}). Set the path in app.yaml → desktop.dockerDesktopExe.',
  },

  'queue.noJob': { uk: 'Завдання не знайдено', ru: 'Задача не найдена', en: 'Job not found' },
  'queue.cancelledByUser': { uk: 'Скасовано користувачем', ru: 'Отменена пользователем', en: 'Cancelled by the user' },
  'queue.cancelledOnExit': { uk: 'Скасовано під час виходу', ru: 'Отменена при выходе', en: 'Cancelled on exit' },
  'queue.noExecutor': { uk: 'Немає виконавця для завдання {type}', ru: 'Нет исполнителя для задачи {type}', en: 'No executor for job {type}' },
  'queue.interrupted': {
    uk: 'Перервано: застосунок або Core зупинили під час виконання',
    ru: 'Прервана: приложение или Core было остановлено во время выполнения',
    en: 'Interrupted: the app or Core stopped while it was running',
  },

  'logs.noBuildLog': { uk: '(журнал збірки не знайдено)', ru: '(лог сборки не найден)', en: '(build log not found)' },
  'logs.noTests': { uk: '(тести в цій збірці не запускалися)', ru: '(тесты в этой сборке не запускались)', en: '(no tests were run in this build)' },
  'logs.noContainer': {
    uk: '(контейнер збірки не знайдено: збірку зупинено, відкинуто або ще не піднято)',
    ru: '(контейнер сборки не найден: сборка остановлена, отброшена или ещё не поднята)',
    en: '(build container not found: the build is stopped, dropped or not up yet)',
  },
  'logs.streamEnded': {
    uk: '(потік журналу завершено: контейнер зупинено)',
    ru: '(поток логов завершён: контейнер остановлен)',
    en: '(log stream ended: the container stopped)',
  },
  'logs.readError': { uk: '(помилка читання журналу: {error})', ru: '(ошибка чтения логов: {error})', en: '(error reading logs: {error})' },
  'common.noBuild': { uk: 'Збірку не знайдено', ru: 'Сборка не найдена', en: 'Build not found' },

  'projects.notFound': { uk: 'Проєкт «{id}» не знайдено', ru: 'Проект «{id}» не найден', en: 'Project «{id}» not found' },
  'projects.notFoundOrBroken': {
    uk: 'Проєкт «{id}» не знайдено або його налаштування з помилкою',
    ru: 'Проект «{id}» не найден или его настройки с ошибкой',
    en: 'Project «{id}» not found or its settings have an error',
  },
  'projects.checkFailed': { uk: 'Налаштування не пройшли перевірку: {error}', ru: 'Настройки не прошли проверку: {error}', en: 'The settings did not pass validation: {error}' },
  'projects.managedPg': { uk: 'Postgres підніме застосунок', ru: 'Postgres поднимет приложение', en: 'The app will start Postgres' },
  'projects.yamlHeader': {
    uk: '# Налаштування проєкту Odoo Branch Manager. Зміни файлу підхоплюються автоматично.',
    ru: '# Настройки проекта Odoo Branch Manager. Правка файла подхватывается автоматически.',
    en: '# Odoo Branch Manager project settings. Edits to this file are picked up automatically.',
  },

  'image.notOwned': {
    uk: 'Образ {tag} уже є і зібраний не застосунком для проєкту {id}{owner}: застосунок його не перезапише. Вкажіть у runtime.image своє ім’я, наприклад bm-{id}-odoo:latest.',
    ru: 'Образ {tag} уже есть и собран не приложением для проекта {id}{owner}: приложение его не перезапишет. Укажите в runtime.image своё имя, например bm-{id}-odoo:latest.',
    en: 'Image {tag} already exists and was not built by the app for project {id}{owner}: the app will not overwrite it. Set your own name in runtime.image, for example bm-{id}-odoo:latest.',
  },
  'image.noBuild': { uk: 'У налаштуваннях проєкту не задано runtime.build', ru: 'В настройках проекта не задан runtime.build', en: 'runtime.build is not set in the project settings' },
  'image.noContext': {
    uk: 'Папку збирання образу не знайдено: {dir} (runtime.build.context)',
    ru: 'Папка сборки образа не найдена: {dir} (runtime.build.context)',
    en: 'Image build folder not found: {dir} (runtime.build.context)',
  },
  'image.noDockerfile': { uk: 'Dockerfile не знайдено: {file} (runtime.build.dockerfile)', ru: 'Dockerfile не найден: {file} (runtime.build.dockerfile)', en: 'Dockerfile not found: {file} (runtime.build.dockerfile)' },
  'image.buildFailed': { uk: 'Збирання образу {tag} не вдалося: {error}', ru: 'Сборка образа {tag} не удалась: {error}', en: 'Building image {tag} failed: {error}' },
  'image.removeFailed': { uk: 'образ: {error}', ru: 'образ: {error}', en: 'image: {error}' },

  'ctpl.relative': {
    uk: 'runtime.composeTemplate має бути повним шляхом до файла, а зараз «{file}». Вкажіть шлях на кшталт E:/stack/bm-compose.yml.',
    ru: 'runtime.composeTemplate должен быть полным путём к файлу, а сейчас «{file}». Укажите путь вида E:/stack/bm-compose.yml.',
    en: 'runtime.composeTemplate must be a full path to a file, but it is «{file}». Use a path like E:/stack/bm-compose.yml.',
  },
  'ctpl.missing': {
    uk: 'Шаблон compose не знайдено: {file} (runtime.composeTemplate). Поверніть файл або очистіть поле в налаштуваннях проєкту.',
    ru: 'Шаблон compose не найден: {file} (runtime.composeTemplate). Верните файл или очистите поле в настройках проекта.',
    en: 'Compose template not found: {file} (runtime.composeTemplate). Restore the file or clear the field in the project settings.',
  },
  'ctpl.yaml': {
    uk: 'Шаблон compose {file} — не YAML: {error}',
    ru: 'Шаблон compose {file} — не YAML: {error}',
    en: 'Compose template {file} is not YAML: {error}',
  },
  'ctpl.notMap': {
    uk: 'Шаблон compose {file}: services, volumes і networks мають бути словниками (ключ: значення).',
    ru: 'Шаблон compose {file}: services, volumes и networks должны быть словарями (ключ: значение).',
    en: 'Compose template {file}: services, volumes and networks must be mappings (key: value).',
  },
  'ctpl.topKey': {
    uk: 'Шаблон compose {file}: ключ «{key}» не підтримується. Можна services, volumes, networks і x-*; name задає застосунок.',
    ru: 'Шаблон compose {file}: ключ «{key}» не поддерживается. Можно services, volumes, networks и x-*; name задаёт приложение.',
    en: 'Compose template {file}: key «{key}» is not supported. Use services, volumes, networks and x-*; the app sets name.',
  },
  'ctpl.serviceName': {
    uk: 'Шаблон compose {file}: недопустима назва сервісу «{name}» (малі латинські літери, цифри, - і _).',
    ru: 'Шаблон compose {file}: недопустимое имя сервиса «{name}» (строчные латинские буквы, цифры, - и _).',
    en: 'Compose template {file}: invalid service name «{name}» (lowercase latin letters, digits, - and _).',
  },
  'ctpl.serviceMap': {
    uk: 'Шаблон compose {file}: сервіс «{name}» має бути словником налаштувань.',
    ru: 'Шаблон compose {file}: сервис «{name}» должен быть словарём настроек.',
    en: 'Compose template {file}: service «{name}» must be a mapping of settings.',
  },
  'ctpl.forbidden': {
    uk: 'Шаблон compose {file}: у сервісу «{name}» не можна задавати {key} — у кожної збірки свої контейнери. Приберіть цей рядок.',
    ru: 'Шаблон compose {file}: у сервиса «{name}» нельзя задавать {key} — у каждой сборки свои контейнеры. Уберите эту строку.',
    en: 'Compose template {file}: service «{name}» cannot set {key}: every build has its own containers. Remove that line.',
  },

  'remoteGone.production': { uk: 'це Production', ru: 'это Production', en: 'it is Production' },
  'remoteGone.protected': { uk: 'гілку захищено (protected)', ru: 'ветка защищена (protected)', en: 'the branch is protected' },
  'remoteGone.folder': { uk: 'код збірки береться з вашої папки', ru: 'код сборки берётся из вашей папки', en: 'the build code comes from your folder' },
  'remoteGone.setting': {
    uk: 'вимкнено «Видаляти, якщо гілку видалили на GitHub»',
    ru: 'выключено «Удалять, если ветку удалили на GitHub»',
    en: '«Delete if the branch was deleted on GitHub» is off',
  },
  'remoteGone.dirty': { uk: 'у worktree є незакомічені зміни', ru: 'в worktree есть незакоммиченные изменения', en: 'the worktree has uncommitted changes' },
  'remoteGone.title': { uk: 'Гілки {branch} немає на GitHub', ru: 'Ветки {branch} нет на GitHub', en: 'Branch {branch} is gone from GitHub' },
  'remoteGone.body': {
    uk: 'Гілку та її збірки залишено: {reason}. Якщо вона більше не потрібна, видаліть її в застосунку.',
    ru: 'Ветка и её сборки оставлены: {reason}. Если она больше не нужна, удалите её в приложении.',
    en: 'The branch and its builds were kept: {reason}. If you no longer need it, delete it in the app.',
  },

  'legacy.text': {
    uk: 'Проєкт створено за старою схемою: застосунок працював усередині вашого репозиторію. Видаліть проєкт (Settings → «Видалити проєкт…») і додайте наново — код збірок братиметься з GitHub, а ваш репозиторій застосунок не чіпатиме.',
    ru: 'Проект создан по старой схеме: приложение работало внутри вашего репозитория. Удалите проект (Settings → «Удалить проект…») и добавьте заново — код сборок будет браться с GitHub, а ваш репозиторий приложение трогать не будет.',
    en: 'The project was created the old way: the app worked inside your repository. Delete the project (Settings → «Delete project…») and add it again — build code will come from GitHub and the app will not touch your repository.',
  },
  'volumes.inUse': { uk: 'том {name} підключено до {users} — не видаляється', ru: 'том {name} подключён к {users} — не удаляется', en: 'volume {name} is attached to {users} — not removed' },
  'volumes.removeFailed': { uk: 'том {name} не видалено: {error}', ru: 'том {name} не удалён: {error}', en: 'volume {name} not removed: {error}' },

  'agents.badDir': {
    uk: 'Папку «{dir}» не знайдено. Виберіть наявну папку, в якій відкриваєте проєкт у Claude Code або Cursor.',
    ru: 'Папка «{dir}» не найдена. Выберите существующую папку, в которой открываете проект в Claude Code или Cursor.',
    en: 'Folder «{dir}» not found. Choose an existing folder where you open the project in Claude Code or Cursor.',
  },
  'agents.modified': {
    uk: '{file} змінено вручну. Перезапишіть його, якщо правки не потрібні, або перенесіть їх в інший skill.',
    ru: '{file} изменён вручную. Перезапишите его, если правки не нужны, или перенесите их в другой skill.',
    en: '{file} was edited by hand. Overwrite it if you do not need the edits, or move them to another skill.',
  },

  'merge.differentProjects': { uk: 'Гілки з різних проєктів', ru: 'Ветки из разных проектов', en: 'The branches are from different projects' },
  'merge.noGithub': {
    uk: 'У проєкту не вказано GitHub-репозиторій (repo.github): відкрити порівняння ніде.',
    ru: 'У проекта не указан GitHub-репозиторий (repo.github): открыть сравнение негде.',
    en: 'The project has no GitHub repository (repo.github): there is nowhere to open the comparison.',
  },

  'drop.dbShared': {
    uk: 'БД {db} використовується збірками {builds} — не видаляється',
    ru: 'БД {db} используется сборками {builds} — не удаляется',
    en: 'database {db} is used by builds {builds} — not dropped',
  },
  'drop.snapshotDb': { uk: 'DROP DATABASE {db} (знімок «{name}»)', ru: 'DROP DATABASE {db} (снапшот «{name}»)', en: 'DROP DATABASE {db} (snapshot «{name}»)' },

  'odooCli.noModules': {
    uk: 'У коді {dir} немає модулів Odoo (__manifest__.py) у папках repo.moduleRoots ({roots}), тому {addonsPath} порожній. Перевірте moduleRoots у налаштуваннях проєкту або приберіть {addonsPath} з runtime.command.',
    ru: 'В коде {dir} нет модулей Odoo (__manifest__.py) в папках repo.moduleRoots ({roots}), поэтому {addonsPath} пуст. Проверьте moduleRoots в настройках проекта или уберите {addonsPath} из runtime.command.',
    en: 'The code in {dir} has no Odoo modules (__manifest__.py) in the repo.moduleRoots folders ({roots}), so {addonsPath} is empty. Check moduleRoots in the project settings or remove {addonsPath} from runtime.command.',
  },
  'odooCli.wholeRepo': { uk: 'весь репозиторій', ru: 'весь репозиторий', en: 'the whole repository' },
  'odooCli.failed': {
    uk: '{what}: Odoo завершився з помилкою (код {code}).\n{detail}\nПовний вивід — у build.log (вкладка Logs).',
    ru: '{what}: Odoo завершился с ошибкой (код {code}).\n{detail}\nПолный вывод — в build.log (вкладка Logs).',
    en: '{what}: Odoo exited with an error (code {code}).\n{detail}\nThe full output is in build.log (Logs tab).',
  },

  'edition.enterprise': {
    uk: 'аддони Enterprise у {dir}; у нові чисті БД ставиться web_enterprise',
    ru: 'аддоны Enterprise в {dir}; в новые чистые БД ставится web_enterprise',
    en: 'Enterprise addons in {dir}; web_enterprise is installed into new clean databases',
  },
  'edition.mounted': {
    uk: 'аддони Enterprise змонтовано в {dir}. БД з бекапу прода — Enterprise, як на проді; у нові чисті БД web_enterprise сам не ставиться (runtime.enterprise не задано)',
    ru: 'аддоны Enterprise смонтированы в {dir}. БД из бэкапа прода — Enterprise, как на проде; в новые чистые БД web_enterprise сам не ставится (runtime.enterprise не задан)',
    en: 'Enterprise addons are mounted at {dir}. A database from the production backup is Enterprise, as in production; web_enterprise is not installed into new clean databases by itself (runtime.enterprise is not set)',
  },
  'edition.community': {
    uk: 'у монтуваннях немає аддонів Enterprise (web_enterprise)',
    ru: 'в монтированиях нет аддонов Enterprise (web_enterprise)',
    en: 'the mounts have no Enterprise addons (web_enterprise)',
  },

  'cli.badRequest': { uk: 'Неправильний запит CLI', ru: 'Неверный запрос CLI', en: 'Invalid CLI request' },
  'docker.cancelled': { uk: 'Операцію скасовано', ru: 'Операция отменена', en: 'Operation cancelled' },
  'audit.bigDiff': { uk: '({from} → {to} рядків)', ru: '({from} → {to} строк)', en: '({from} → {to} lines)' },
  'fsTree.noHardlinks': {
    uk: 'хардлінки не підтримуються ({error}) — копіювання',
    ru: 'хардлинки не поддерживаются ({error}) — копирование',
    en: 'hard links are not supported ({error}) — copying',
  },
  'paths.noEnv': {
    uk: 'Змінну середовища %{name}% не задано (шлях «{path}»)',
    ru: 'Переменная окружения %{name}% не задана (путь «{path}»)',
    en: 'Environment variable %{name}% is not set (path «{path}»)',
  },
} satisfies Record<string, Entry>;
