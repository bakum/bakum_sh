import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  Notification,
  powerSaveBlocker,
  screen,
  shell,
  Tray,
  type MenuItemConstructorOptions,
} from 'electron';
import pino from 'pino';
import type { AppConfig, CoreToMain, TrayProject } from '@bm/shared';
import { CoreHost } from './core-host';
import { drawIcon, trayImage, type TrayState } from './icons';
import { isAllowedExternal } from './security';
import { resolveDirs } from './migrate-dirs';
import { Updater } from './updater';

const PRODUCT = 'Odoo Branch Manager';
/** BM_PROFILE=dev keeps development runs away from the real configuration and registry. */
const profile = process.env.BM_PROFILE?.replace(/[^a-z0-9-]/gi, '') || '';
const suffix = profile ? ` (${profile})` : '';
const dirName = `${PRODUCT}${suffix}`;
const dirs = resolveDirs(process.env.APPDATA ?? app.getPath('appData'), process.env.LOCALAPPDATA ?? app.getPath('appData'), PRODUCT, suffix);
const configDir = dirs.configDir;
const localDir = dirs.localDir;

app.setName(dirName);
app.setAppUserModelId(profile ? `ua.bakum.odoo-branch-manager.${profile}` : 'ua.bakum.odoo-branch-manager');
app.setPath('userData', path.join(localDir, 'electron'));

const isHook = process.argv.includes('--hook');

fs.mkdirSync(path.join(localDir, 'logs'), { recursive: true });
const log = pino(
  { level: 'info', base: { proc: 'main' } },
  pino.destination({ dest: path.join(localDir, 'logs', 'main.log'), sync: true, mkdir: true }),
);

for (const n of dirs.notes) log.info({ migration: n }, 'renamed from DEMZ Branch Manager');

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let core: CoreHost | null = null;
let quitting = false;
let activeJobs = 0;
let trayState: TrayState = 'idle';
let trayProjects: TrayProject[] = [];
let blockerId: number | null = null;
let appConfig: AppConfig | null = null;
let updater: Updater | null = null;
let pendingInstaller: string | null = null;
let startupCheckDone = false;

// ---------- single instance ----------
if (!app.requestSingleInstanceLock({ hook: isHook })) {
  // A running instance receives argv via 'second-instance'.
  app.exit(0);
} else if (isHook) {
  // Spec 3: --hook without a running app exits silently, no window.
  app.exit(0);
} else {
  app.on('second-instance', (_e, argv) => {
    if (argv.includes('--hook')) {
      core?.sendHook(argv.slice(argv.indexOf('--hook') + 1));
      return;
    }
    log.info('second instance started: focusing the window');
    showWindow();
  });
  app.whenReady().then(boot).catch((err) => {
    log.error({ err }, 'boot failed');
    dialog.showErrorBox(PRODUCT, `Не удалось запустить приложение: ${String(err)}`);
    app.exit(1);
  });
}

// ---------- window state ----------
interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}
const stateFile = path.join(app.getPath('userData'), 'window-state.json');

function loadWindowState(): WindowState {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as WindowState;
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return s.x !== undefined && s.y !== undefined && s.x < a.x + a.width - 100 && s.y < a.y + a.height - 100 && s.x + s.width > a.x + 100 && s.y >= a.y - 20;
    });
    if (!visible) return { width: Math.max(1100, s.width), height: Math.max(700, s.height), maximized: s.maximized };
    return s;
  } catch {
    return { width: 1400, height: 900, maximized: false };
  }
}

function saveWindowState(): void {
  if (!win) return;
  const b = win.getNormalBounds();
  const s: WindowState = { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() };
  try {
    fs.writeFileSync(stateFile, JSON.stringify(s));
  } catch (err) {
    log.warn({ err }, 'window state not saved');
  }
}

function createWindow(show: boolean): void {
  const st = loadWindowState();
  win = new BrowserWindow({
    x: st.x,
    y: st.y,
    width: st.width,
    height: st.height,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    title: PRODUCT,
    icon: drawIcon(64, 'idle'),
    backgroundColor: '#1a1b1e',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  Menu.setApplicationMenu(null);
  if (st.maximized) win.maximize();

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  // Spec 11: no navigation, no window.open; allowed externals go to the OS browser.
  win.webContents.on('will-navigate', (e, url) => {
    if (devUrl && url.startsWith(devUrl)) return;
    e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternal(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('did-finish-load', () => sendCorePort());
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12' && !app.isPackaged) win?.webContents.toggleDevTools();
  });

  win.once('ready-to-show', () => {
    if (show) win?.show();
  });
  win.on('close', (e) => {
    saveWindowState();
    if (!quitting && (appConfig?.desktop.closeToTray ?? true)) {
      e.preventDefault();
      win?.hide();
    }
  });
  win.on('closed', () => {
    win = null;
  });

  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'));
}

function showWindow(route?: string): void {
  if (!win) createWindow(true);
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (route) win.webContents.send('bm:navigate', route);
}

function sendCorePort(): void {
  if (!win || !core) return;
  const port = core.createClientPort();
  if (port) win.webContents.postMessage('bm:port', null, [port]);
}

// ---------- tray ----------
function rebuildTrayMenu(): void {
  if (!tray) return;
  const projectItems: MenuItemConstructorOptions[] = trayProjects.map((p) => ({
    label: p.name,
    submenu: p.builds.length
      ? p.builds.map((b) => ({
          label: `${b.branch} — ${statusLabel(b.status)}`,
          submenu: [
            { label: 'Connect', enabled: !!b.url && b.status === 'running', click: () => b.url && void shell.openExternal(b.url) },
            b.status === 'running'
              ? { label: 'Stop', click: () => void core?.call('builds.action', { buildId: b.buildId, action: 'stop' }) }
              : { label: 'Start', click: () => void core?.call('builds.action', { buildId: b.buildId, action: 'start' }) },
            { label: 'VS Code', click: () => void core?.call('shell.open', { buildId: b.buildId, target: 'editor' }) },
            { label: 'Логи', click: () => showWindow(`/projects/${p.id}/branches/${b.branchId}/logs`) },
          ],
        }))
      : [{ label: 'Нет живых сборок', enabled: false }],
  }));
  const menu = Menu.buildFromTemplate([
    ...projectItems,
    ...(projectItems.length ? [{ type: 'separator' as const }] : []),
    { label: 'Показать окно', click: () => showWindow() },
    { label: 'Остановить все сборки', click: () => void core?.call('builds.stopAll', {}) },
    { type: 'separator' },
    updater && (updater.state.status === 'available' || updater.state.status === 'ready')
      ? { label: `Установить обновление ${updater.state.latest}…`, click: () => void installUpdate() }
      : { label: 'Проверить обновления', enabled: updater?.state.status !== 'checking', click: () => void checkUpdates(true) },
    { type: 'separator' },
    { label: 'Выход', click: () => void requestQuit() },
  ]);
  tray.setContextMenu(menu);
  const tip = { ok: 'всё работает', building: 'идёт сборка', error: 'есть ошибки', idle: 'нет живых сборок' }[trayState];
  tray.setToolTip(`${PRODUCT} — ${tip}`);
  tray.setImage(trayImage(trayState));
}

function statusLabel(s: string): string {
  return ({ running: 'работает', stopped: 'остановлена', building: 'сборка', failed: 'ошибка', queued: 'в очереди' } as Record<string, string>)[s] ?? s;
}

// ---------- quit ----------
async function requestQuit(): Promise<void> {
  if (activeJobs > 0) {
    const { response } = await dialog.showMessageBox({
      type: 'question',
      title: PRODUCT,
      message: `Выполняется задач: ${activeJobs}. Что сделать?`,
      detail: 'Контейнеры сборок при выходе не останавливаются.',
      buttons: ['Дождаться и выйти', 'Отменить задачи и выйти', 'Остаться'],
      defaultId: 0,
      cancelId: 2,
    });
    if (response === 2) return;
    if (response === 0) {
      new Notification({ title: PRODUCT, body: 'Выход после завершения текущих задач.' }).show();
      await new Promise<void>((resolve) => {
        const t = setInterval(() => {
          if (activeJobs === 0) {
            clearInterval(t);
            resolve();
          }
        }, 1000);
      });
      await doQuit(false);
      return;
    }
    await doQuit(true);
    return;
  }
  await doQuit(false);
}

async function doQuit(cancelJobs: boolean): Promise<void> {
  quitting = true;
  saveWindowState();
  await core?.stop(cancelJobs);
  tray?.destroy();
  if (pendingInstaller) launchInstaller(pendingInstaller);
  app.exit(0);
}

// ---------- updates (docs/decisions.md D29) ----------
/** Test-only: with BM_UPDATE_DRY_RUN=1 an unpackaged build goes through the whole flow but does not start the installer. */
const updateDryRun = !app.isPackaged && process.env.BM_UPDATE_DRY_RUN === '1';

function launchInstaller(file: string): void {
  if (updateDryRun) {
    log.info({ file }, 'update: dry run, installer not started');
    return;
  }
  // The app is already shut down (Core stopped, tray gone); main exits right after this call.
  spawn(file, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
  log.info({ file }, 'update: installer started, exiting');
}

/**
 * «Обновить»: confirm → download and verify the installer → close the app completely (same job handling as «Выход»)
 * → start the installer. Portable builds open the release page instead.
 */
async function installUpdate(): Promise<{ ok: boolean; message?: string }> {
  if (!updater) return { ok: false, message: 'Проверка обновлений не готова' };
  const s = updater.state;
  if (s.status !== 'available' && s.status !== 'ready') return { ok: false, message: 'Нет доступного обновления: сначала проверьте обновления' };
  if (s.mode === 'portable') {
    if (s.url && isAllowedExternal(s.url)) void shell.openExternal(s.url);
    return { ok: true, message: 'Portable-версия: скачайте новую версию со страницы релиза' };
  }
  if (s.mode === 'dev') return { ok: false, message: 'В режиме разработки (pnpm dev / start) установка обновлений недоступна' };
  if (!s.asset) return { ok: false, message: 'В релизе нет установщика' };
  const jobs = activeJobs;
  const buttons = jobs > 0 ? ['Дождаться задач и установить', 'Прервать задачи и установить', 'Отмена'] : ['Установить', 'Отмена'];
  const { response } = await dialog.showMessageBox(win && win.isVisible() ? win : undefined!, {
    type: 'question',
    title: PRODUCT,
    message: `Установить Odoo Branch Manager ${s.latest}?`,
    detail:
      `Текущая версия ${s.current}. Установщик будет скачан (${Math.round(s.asset.size / 1e6)} МБ) и проверен, затем приложение ` +
      'полностью закроется и запустится установщик. Контейнеры сборок, базы и настройки не затрагиваются.' +
      (jobs > 0 ? `\n\nСейчас выполняется задач: ${jobs}. Прерванные сборки получат статус failed, их можно повторить после обновления.` : ''),
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
  });
  if (response === buttons.length - 1) return { ok: false, message: 'Отменено' };
  let file: string;
  try {
    file = await updater.download();
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
  if (jobs > 0 && response === 0) {
    new Notification({ title: PRODUCT, body: 'Обновление будет установлено после завершения текущих задач.' }).show();
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (activeJobs === 0) {
          clearInterval(t);
          resolve();
        }
      }, 1000);
    });
  }
  updater.markInstalling();
  pendingInstaller = file;
  log.info({ from: s.current, to: s.latest, file }, 'update: closing the app to install');
  await doQuit(jobs > 0 && response === 1);
  return { ok: true };
}

function updateSettings(): { repository: string; includePrerelease: boolean } {
  return { repository: appConfig?.updates.repository ?? 'bakum/bakum_sh', includePrerelease: appConfig?.updates.includePrerelease ?? false };
}

async function checkUpdates(manual: boolean): Promise<void> {
  if (!updater) return;
  const s = await updater.check(manual);
  const fromTray = manual === true && !win?.isVisible();
  if (s.status === 'available' && (manual || !s.skipped) && Notification.isSupported()) {
    const n = new Notification({ title: `Доступна версия ${s.latest}`, body: `Установлена ${s.current}. Откройте окно, чтобы посмотреть изменения и обновить.` });
    n.on('click', () => showWindow());
    n.show();
  } else if (fromTray && Notification.isSupported()) {
    new Notification({ title: PRODUCT, body: s.status === 'none' ? `Установлена последняя версия ${s.current}` : (s.error ?? 'Проверка не удалась') }).show();
  }
}

// ---------- messages from Core ----------
function onCoreMessage(msg: CoreToMain): void {
  switch (msg.kind) {
    case 'notify': {
      log.info({ type: msg.notifType, title: msg.title, body: msg.body }, 'notification');
      if (!Notification.isSupported()) return;
      const n = new Notification({ title: msg.title, body: msg.body, icon: drawIcon(64, 'idle') });
      n.on('click', () => {
        if (msg.url && isAllowedExternal(msg.url)) void shell.openExternal(msg.url);
        else showWindow(msg.route);
      });
      n.show();
      break;
    }
    case 'openExternal':
      if (isAllowedExternal(msg.url)) void shell.openExternal(msg.url);
      else log.warn({ url: msg.url }, 'blocked external url');
      break;
    case 'openPath':
      void shell.openPath(msg.path);
      break;
    case 'busy':
      activeJobs = msg.activeJobs;
      if (activeJobs > 0 && blockerId === null) {
        blockerId = powerSaveBlocker.start('prevent-app-suspension');
        log.info({ activeJobs, blockerId }, 'sleep blocked (powerSaveBlocker)');
      }
      if (activeJobs === 0 && blockerId !== null) {
        powerSaveBlocker.stop(blockerId);
        log.info({ blockerId }, 'sleep allowed again');
        blockerId = null;
      }
      break;
    case 'tray':
      trayState = msg.state;
      trayProjects = msg.menu;
      rebuildTrayMenu();
      break;
    case 'appConfig':
      appConfig = msg.config;
      applyAutostart();
      if (!startupCheckDone && appConfig.updates.checkOnStart) {
        startupCheckDone = true;
        // A little after start: the window and Core come first.
        setTimeout(() => void checkUpdates(false), 8000);
      }
      break;
    case 'log':
      log[msg.level]({ src: 'core' }, msg.msg);
      break;
    case 'ready':
      break;
  }
}

function applyAutostart(): void {
  if (!appConfig || !app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: appConfig.desktop.autostart, args: ['--minimized'] });
}

// ---------- renderer → main (desktop-only capabilities) ----------
function registerIpc(): void {
  ipcMain.handle('bm:selectDirectory', async (_e, title?: string) => {
    const r = await dialog.showOpenDialog(win ?? undefined!, { title: title ?? 'Выберите папку', properties: ['openDirectory'] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  ipcMain.handle('bm:selectFile', async (_e, opts?: { title?: string; extensions?: string[] }) => {
    const r = await dialog.showOpenDialog(win ?? undefined!, {
      title: opts?.title ?? 'Выберите файл',
      properties: ['openFile'],
      filters: opts?.extensions ? [{ name: 'Файлы', extensions: opts.extensions }] : [],
    });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  // Only the path: Core writes the file (e.g. a database export).
  ipcMain.handle('bm:selectSavePath', async (_e, opts: { title?: string; defaultPath: string; extensions?: string[] }) => {
    const r = await dialog.showSaveDialog(win ?? undefined!, {
      title: opts.title,
      defaultPath: opts.defaultPath,
      filters: opts.extensions ? [{ name: 'Файлы', extensions: opts.extensions }] : [],
    });
    return r.canceled || !r.filePath ? null : r.filePath;
  });
  ipcMain.handle('bm:saveFile', async (_e, opts: { defaultPath: string; content: string }) => {
    const r = await dialog.showSaveDialog(win ?? undefined!, { defaultPath: opts.defaultPath });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, opts.content, 'utf8');
    return r.filePath;
  });
  ipcMain.handle('bm:copy', (_e, text: string) => {
    clipboard.writeText(String(text));
    return true;
  });
  ipcMain.handle('bm:openExternal', (_e, url: string) => {
    if (!isAllowedExternal(url)) return false;
    void shell.openExternal(url);
    return true;
  });
  ipcMain.handle('bm:confirm', async (_e, opts: { message: string; detail?: string; buttons?: string[] }) => {
    const r = await dialog.showMessageBox(win ?? undefined!, {
      type: 'question',
      message: opts.message,
      detail: opts.detail,
      buttons: opts.buttons ?? ['OK', 'Отмена'],
      cancelId: (opts.buttons?.length ?? 2) - 1,
    });
    return r.response;
  });
  ipcMain.handle('bm:info', () => ({
    version: __BM_VERSION__,
    commit: __BM_COMMIT__,
    buildDate: __BM_BUILD_DATE__,
    profile,
    corePid: core?.pid ?? null,
    sleepBlocked: blockerId !== null && powerSaveBlocker.isStarted(blockerId),
    windowVisible: win?.isVisible() ?? false,
    configDir,
    localDir,
  }));
  ipcMain.handle('bm:quit', () => requestQuit());
  ipcMain.handle('bm:update:get', () => updater?.state ?? null);
  ipcMain.handle('bm:update:check', async () => {
    await checkUpdates(true);
    return updater?.state ?? null;
  });
  ipcMain.handle('bm:update:install', () => installUpdate());
  ipcMain.handle('bm:update:skip', () => {
    updater?.skip();
    return updater?.state ?? null;
  });
}

// ---------- boot ----------
async function boot(): Promise<void> {
  const t0 = Date.now();
  log.info({ version: __BM_VERSION__, commit: __BM_COMMIT__, buildDate: __BM_BUILD_DATE__, profile }, 'Odoo Branch Manager starting');
  registerIpc();
  updater = new Updater({
    current: __BM_VERSION__,
    log,
    userDataDir: app.getPath('userData'),
    mode: app.isPackaged ? (process.env.PORTABLE_EXECUTABLE_DIR ? 'portable' : 'installer') : updateDryRun ? 'installer' : 'dev',
    settings: updateSettings,
    testEndpoint: app.isPackaged ? null : (process.env.BM_UPDATE_URL ?? null),
    onChange: (s) => {
      win?.webContents.send('bm:update-state', s);
      rebuildTrayMenu();
    },
  });
  core = new CoreHost({
    configDir,
    // A dev profile never touches the dataDir configured in app.yaml.
    dataDirOverride: process.env.BM_DATA_DIR ?? (profile ? localDir : null),
    // SemVer build metadata: 0.1.1+abc1234 (docs/decisions.md D27).
    appVersion: `${__BM_VERSION__}+${__BM_COMMIT__}`,
    resourcesPath: process.resourcesPath,
    log,
  });
  core.on('message', onCoreMessage);
  core.on('restarted', () => {
    log.warn('core restarted');
    sendCorePort();
    win?.webContents.send('bm:core-status', { state: 'restarted', at: new Date().toISOString() });
  });
  core.start();

  tray = new Tray(trayImage('idle'));
  tray.on('click', () => showWindow());
  rebuildTrayMenu();

  const minimized = process.argv.includes('--minimized');
  createWindow(!minimized);
  win?.once('ready-to-show', () => log.info({ ms: Date.now() - t0 }, 'window ready'));
}

app.on('window-all-closed', () => {
  // Stays in the tray.
});
app.on('before-quit', () => {
  quitting = true;
});
