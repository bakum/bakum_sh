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

const PRODUCT = 'DEMZ Branch Manager';
/** BM_PROFILE=dev keeps development runs away from the real configuration and registry. */
const profile = process.env.BM_PROFILE?.replace(/[^a-z0-9-]/gi, '') || '';
const dirName = profile ? `${PRODUCT} (${profile})` : PRODUCT;
const configDir = path.join(process.env.APPDATA ?? app.getPath('appData'), dirName);
const localDir = path.join(process.env.LOCALAPPDATA ?? app.getPath('appData'), dirName);

app.setName(dirName);
app.setAppUserModelId(profile ? `ua.demz.branch-manager.${profile}` : 'ua.demz.branch-manager');
app.setPath('userData', path.join(localDir, 'electron'));

const isHook = process.argv.includes('--hook');

fs.mkdirSync(path.join(localDir, 'logs'), { recursive: true });
const log = pino(
  { level: 'info', base: { proc: 'main' } },
  pino.destination({ dest: path.join(localDir, 'logs', 'main.log'), sync: true, mkdir: true }),
);

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let core: CoreHost | null = null;
let quitting = false;
let activeJobs = 0;
let trayState: TrayState = 'idle';
let trayProjects: TrayProject[] = [];
let blockerId: number | null = null;
let appConfig: AppConfig | null = null;

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
  app.exit(0);
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
    version: app.getVersion(),
    profile,
    corePid: core?.pid ?? null,
    sleepBlocked: blockerId !== null && powerSaveBlocker.isStarted(blockerId),
    windowVisible: win?.isVisible() ?? false,
    configDir,
    localDir,
  }));
  ipcMain.handle('bm:quit', () => requestQuit());
}

// ---------- boot ----------
async function boot(): Promise<void> {
  const t0 = Date.now();
  registerIpc();
  core = new CoreHost({
    configDir,
    // A dev profile never touches the dataDir configured in app.yaml.
    dataDirOverride: process.env.BM_DATA_DIR ?? (profile ? localDir : null),
    appVersion: app.getVersion(),
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
