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
import { setLangSource, type AppConfig, type CoreToMain, type TrayProject } from '@bm/shared';
import { CoreHost } from './core-host';
import { drawIcon, trayImage, type TrayState } from './icons';
import { isAllowedExternal } from './security';
import { resolveDirs } from './migrate-dirs';
import { dirRoots } from './platform-dirs';
import { Updater } from './updater';
import { cliPipeName, installCliLaunchers } from './cli-install';
import { t } from './i18n';

const PRODUCT = 'Odoo Branch Manager';
/** BM_PROFILE=dev keeps development runs away from the real configuration and registry. */
const profile = process.env.BM_PROFILE?.replace(/[^a-z0-9-]/gi, '') || '';
const suffix = profile ? ` (${profile})` : '';
const dirName = `${PRODUCT}${suffix}`;
const isMac = process.platform === 'darwin';
const roots = dirRoots(app.getPath('appData'));
const dirs = resolveDirs(roots.configRoot, roots.localRoot, PRODUCT, suffix);
const configDir = dirs.configDir;
const localDir = dirs.localDir;

app.setName(dirName);
if (process.platform === 'win32') app.setAppUserModelId(profile ? `ua.bakum.odoo-branch-manager.${profile}` : 'ua.bakum.odoo-branch-manager');
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
/** macOS: started at login and still waiting for app.yaml to learn `startMinimized` (D71). */
let openedAtLogin = false;
let updater: Updater | null = null;
let pendingInstaller: string | null = null;
let startupCheckDone = false;
let cliBin: string | null = null;
// Texts follow app.yaml `language` (D69); until Core sends it, the default language.
setLangSource(() => appConfig?.language);

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
    dialog.showErrorBox(PRODUCT, t('boot.failed', { error: String(err) }));
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
  // macOS needs the app / Edit menus: without them Cmd+Q and Cmd+C/V/X/A/Z (inputs, Monaco) do nothing (D67).
  Menu.setApplicationMenu(isMac ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null);
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
            { label: t('tray.logs'), click: () => showWindow(`/projects/${p.id}/branches/${b.branchId}/logs`) },
          ],
        }))
      : [{ label: t('tray.noLive'), enabled: false }],
  }));
  const menu = Menu.buildFromTemplate([
    ...projectItems,
    ...(projectItems.length ? [{ type: 'separator' as const }] : []),
    { label: t('tray.show'), click: () => showWindow() },
    { label: t('tray.stopAll'), click: () => void core?.call('builds.stopAll', {}) },
    { type: 'separator' },
    updater && (updater.state.status === 'available' || updater.state.status === 'ready')
      ? { label: t('tray.install', { version: updater.state.latest }), click: () => void installUpdate() }
      : { label: t('tray.check'), enabled: updater?.state.status !== 'checking', click: () => void checkUpdates(true) },
    { type: 'separator' },
    { label: t('tray.quit'), click: () => void requestQuit() },
  ]);
  tray.setContextMenu(menu);
  const tip = t(`tray.tip.${trayState}`);
  tray.setToolTip(`${PRODUCT} — ${tip}`);
  tray.setImage(trayImage(trayState));
}

function statusLabel(s: string): string {
  return ['running', 'stopped', 'building', 'failed', 'queued'].includes(s) ? t(`status.${s as 'running'}`) : s;
}

// ---------- quit ----------
async function requestQuit(): Promise<void> {
  if (activeJobs > 0) {
    const { response } = await dialog.showMessageBox({
      type: 'question',
      title: PRODUCT,
      message: t('quit.message', { n: activeJobs }),
      detail: t('quit.detail'),
      buttons: [t('quit.wait'), t('quit.cancelJobs'), t('quit.stay')],
      defaultId: 0,
      cancelId: 2,
    });
    if (response === 2) return;
    if (response === 0) {
      new Notification({ title: PRODUCT, body: t('quit.afterJobs') }).show();
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          if (activeJobs === 0) {
            clearInterval(timer);
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
  // macOS (D67): an unsigned app cannot replace itself reliably — Finder mounts the disk image and the user drags the
  // app over the old one in Applications (the dialog said so).
  if (isMac) spawn('open', [file], { detached: true, stdio: 'ignore' }).unref();
  else spawn(file, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
  log.info({ file }, 'update: installer started, exiting');
}

/**
 * «Обновить»: confirm → download and verify the installer → close the app completely (same job handling as «Выход»)
 * → start the installer. Portable builds open the release page instead.
 */
async function installUpdate(): Promise<{ ok: boolean; message?: string }> {
  if (!updater) return { ok: false, message: t('update.notReady') };
  const s = updater.state;
  if (s.status !== 'available' && s.status !== 'ready') return { ok: false, message: t('update.none') };
  if (s.mode === 'portable') {
    if (s.url && isAllowedExternal(s.url)) void shell.openExternal(s.url);
    return { ok: true, message: t('update.portable') };
  }
  if (s.mode === 'dev') return { ok: false, message: t('update.dev') };
  if (!s.asset) return { ok: false, message: t('update.noAsset') };
  const jobs = activeJobs;
  const buttons = jobs > 0 ? [t('update.waitJobs'), t('update.abortJobs'), t('common.cancel')] : [t('update.install'), t('common.cancel')];
  const { response } = await dialog.showMessageBox(win && win.isVisible() ? win : undefined!, {
    type: 'question',
    title: PRODUCT,
    message: t('update.question', { version: s.latest }),
    detail:
      t(isMac ? 'update.detailMac' : 'update.detailWin', { current: s.current, mb: Math.round(s.asset.size / 1e6) }) +
      t('update.untouched') +
      (jobs > 0 ? t('update.jobsRunning', { n: jobs }) : ''),
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
  });
  if (response === buttons.length - 1) return { ok: false, message: t('update.cancelled') };
  let file: string;
  try {
    file = await updater.download();
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
  if (jobs > 0 && response === 0) {
    new Notification({ title: PRODUCT, body: t('update.afterJobs') }).show();
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (activeJobs === 0) {
          clearInterval(timer);
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
    const n = new Notification({ title: t('update.availableTitle', { version: s.latest }), body: t('update.availableBody', { current: s.current }) });
    n.on('click', () => showWindow());
    n.show();
  } else if (fromTray && Notification.isSupported()) {
    new Notification({ title: PRODUCT, body: s.status === 'none' ? t('update.upToDate', { current: s.current }) : (s.error ?? t('update.checkFailed')) }).show();
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
    case 'appConfig': {
      const langChanged = appConfig?.language !== msg.config.language;
      appConfig = msg.config;
      applyAutostart();
      // macOS starts hidden at login before the settings are known; `startMinimized: false` shows the window now.
      if (openedAtLogin) {
        openedAtLogin = false;
        if (!appConfig.desktop.startMinimized) showWindow();
      }
      if (langChanged) {
        rebuildTrayMenu();
        writeCliLang();
      }
      if (!startupCheckDone && appConfig.updates.checkOnStart) {
        startupCheckDone = true;
        // A little after start: the window and Core come first.
        setTimeout(() => void checkUpdates(false), 8000);
      }
      break;
    }
    case 'log':
      log[msg.level]({ src: 'core' }, msg.msg);
      break;
    case 'ready':
      break;
  }
}

/** The bm client (plain Node, no shared code) takes the language of its own few messages from this file (D69). */
function writeCliLang(): void {
  if (!cliBin || !appConfig) return;
  try {
    fs.writeFileSync(path.join(cliBin, 'lang'), appConfig.language);
  } catch (err) {
    log.warn({ err }, 'cli language not written');
  }
}

function applyAutostart(): void {
  if (!appConfig || !app.isPackaged) return;
  const { autostart, startMinimized } = appConfig.desktop;
  // `path` / `args` are Windows-only: the portable exe unpacks itself into a temp folder on every start, so the login
  // item points at the portable file. On macOS the start at login is recognised by wasOpenedAtLogin (see boot).
  app.setLoginItemSettings({
    openAtLogin: autostart,
    ...(process.env.PORTABLE_EXECUTABLE_FILE ? { path: process.env.PORTABLE_EXECUTABLE_FILE } : {}),
    args: startMinimized ? ['--minimized'] : [],
  });
}

// ---------- renderer → main (desktop-only capabilities) ----------
function registerIpc(): void {
  ipcMain.handle('bm:selectDirectory', async (_e, title?: string) => {
    const r = await dialog.showOpenDialog(win ?? undefined!, { title: title ?? t('dialog.selectDir'), properties: ['openDirectory'] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  ipcMain.handle('bm:selectFile', async (_e, opts?: { title?: string; extensions?: string[] }) => {
    const r = await dialog.showOpenDialog(win ?? undefined!, {
      title: opts?.title ?? t('dialog.selectFile'),
      properties: ['openFile'],
      filters: opts?.extensions ? [{ name: t('dialog.files'), extensions: opts.extensions }] : [],
    });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  // Only the path: Core writes the file (e.g. a database export).
  ipcMain.handle('bm:selectSavePath', async (_e, opts: { title?: string; defaultPath: string; extensions?: string[] }) => {
    const r = await dialog.showSaveDialog(win ?? undefined!, {
      title: opts.title,
      defaultPath: opts.defaultPath,
      filters: opts.extensions ? [{ name: t('dialog.files'), extensions: opts.extensions }] : [],
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
      buttons: opts.buttons ?? ['OK', t('common.cancel')],
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
  // Command line bm (D53): launchers in <localDir>/bin point at this exe; Core serves the pipe.
  const cliPipe = cliPipeName(profile);
  cliBin = path.join(localDir, 'bin');
  let cli: { pipe: string; binDir: string } | null = null;
  try {
    installCliLaunchers({ binDir: cliBin, pipe: cliPipe, exe: process.execPath, cliJs: path.join(__dirname, 'cli.js') });
    cli = { pipe: cliPipe, binDir: cliBin };
  } catch (err) {
    log.error({ err }, 'cli launchers not written');
  }
  core = new CoreHost({
    configDir,
    cli,
    // A dev profile never touches the dataDir configured in app.yaml.
    dataDirOverride: process.env.BM_DATA_DIR ?? (profile ? localDir : null),
    // SemVer build metadata: 0.1.1+abc1234 (docs/decisions.md D27).
    appVersion: `${__BM_VERSION__}+${__BM_COMMIT__}`,
    resourcesPath: process.resourcesPath,
    // %APPDATA% / %LOCALAPPDATA% in app.yaml resolve to the same roots on macOS (D67).
    env: isMac ? { APPDATA: roots.configRoot, LOCALAPPDATA: roots.localRoot } : {},
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

  openedAtLogin = isMac && app.isPackaged && app.getLoginItemSettings().wasOpenedAtLogin;
  createWindow(!process.argv.includes('--minimized') && !openedAtLogin);
  // macOS: a click on the Dock icon brings back the window hidden to the menu bar.
  app.on('activate', () => showWindow());
  win?.once('ready-to-show', () => log.info({ ms: Date.now() - t0 }, 'window ready'));
}

app.on('window-all-closed', () => {
  // Stays in the tray.
});
app.on('before-quit', (e) => {
  // macOS: Cmd+Q, the Dock and logout call app.quit() — take the same path as «Выход» (active jobs dialog, Core stop).
  if (isMac && !quitting) {
    e.preventDefault();
    void requestQuit();
    return;
  }
  quitting = true;
});
