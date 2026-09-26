const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, globalShortcut, nativeImage, Notification, clipboard, session, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const { fork, exec } = require('child_process');
const { startPublicHost } = require('./tunnel');

let mainWindow = null;
let overlayWindow = null;
let tray = null;
let serverProcess = null;
let stopTunnel = () => {};
let refreshTray = () => {};
let publicUrl = '';
const DEFAULT_PORT = 3000;

function configPath() { return path.join(app.getPath('userData'), 'cbopka-config.json'); }
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { return {}; }
}
function saveConfig(c) {
  try { fs.mkdirSync(app.getPath('userData'), { recursive: true }); fs.writeFileSync(configPath(), JSON.stringify(c, null, 2)); } catch {}
}

function getServerEntry() {
  const candidates = [
    path.join(process.resourcesPath || '', 'server-bundle.cjs'),
    path.join(__dirname, 'server-bundle.cjs'),
    path.join(process.resourcesPath || '', 'server', 'index.js'),
    path.join(__dirname, '../server/index.js'),
    path.join(process.cwd(), 'server/index.js')
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return candidates[1];
}

function getClientDist() {
  const candidates = [
    path.join(process.resourcesPath || '', 'client-dist'),
    path.join(process.resourcesPath || '', 'app', 'client', 'dist'),
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'client', 'dist'),
    path.join(__dirname, '../client/dist'),
    path.join(process.cwd(), 'client/dist')
  ];
  for (const p of candidates) {
    if (fs.existsSync(path.join(p, 'index.html'))) {
      console.log('Found client dist:', p);
      return p;
    }
  }
  console.log('Client dist not found, checked 5 candidates:', candidates);
  return candidates[0];
}

function bootHtml() {
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8"><title>Cbopka</title></head>
  <body style="margin:0;height:100vh;display:grid;place-items:center;background:#0c0d11;color:#f6f1e8;font-family:Segoe UI,sans-serif">
  <div style="text-align:center"><div style="width:64px;height:64px;border-radius:18px;margin:0 auto 14px;background:linear-gradient(135deg,#ff6a45,#6ee0c2)"></div>
  <h1 style="font-weight:560;letter-spacing:-.03em;margin:0">Cbopka</h1>
  <p style="color:#a39c92">запускаем локальный сервер…</p></div></body></html>`)}`;
}

function errorHtml(message) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8"><title>Cbopka</title></head>
  <body style="margin:0;height:100vh;display:grid;place-items:center;background:#0c0d11;color:#f6f1e8;font-family:Segoe UI,sans-serif;padding:24px">
  <div style="max-width:520px"><h1>Сервер не поднялся</h1><p style="color:#a39c92">${String(message).replace(/[<>]/g, '')}</p>
  <p>Это не чёрный экран: окно живо. Проверьте, что порт 3000 свободен, и откройте приложение ещё раз.</p></div></body></html>`)}`;
}

function startLocalServer() {
  const serverEntry = getServerEntry();
  const clientDist = getClientDist();
  const userData = app.getPath('userData');
  console.log('Server entry:', serverEntry, 'exists:', fs.existsSync(serverEntry));
  console.log('Client dist:', clientDist);
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(DEFAULT_PORT),
      CLIENT_DIST_PATH: clientDist,
      DATA_DIR: userData,
      UPLOAD_DIR: path.join(userData, 'uploads'),
      NODE_ENV: 'production',
      DISABLE_SQLITE: '1',
      DISABLE_MULTER: '1',
      CBOPKA_AUTOSTART: '1',
      CBOPKA_OPEN_BROWSER: '0'
    };
    try {
      serverProcess = fork(serverEntry, [], { env, stdio: 'pipe', execArgv: [] });
    } catch (e) {
      reject(e);
      return;
    }
    let started = false;
    let output = '';
    const done = () => { if (!started) { started = true; resolve(); } };
    const timeout = setTimeout(() => { console.log('Server start timeout', output.slice(-500)); done(); }, 8000);
    const onData = (buf) => {
      const msg = buf.toString();
      output += msg;
      console.log('[server]', msg.trim());
      if (msg.includes('Server running') && !started) { clearTimeout(timeout); done(); }
    };
    serverProcess.stdout?.on('data', onData);
    serverProcess.stderr?.on('data', (buf) => { output += buf.toString(); console.error('[server err]', buf.toString().trim()); });
    serverProcess.on('error', (err) => { if (!started) { clearTimeout(timeout); reject(err); } });
    serverProcess.on('exit', (code) => {
      console.log('Server exited', code, output.slice(-800));
      if (!started && code) { clearTimeout(timeout); reject(new Error('Server exited ' + code + '\n' + output.slice(-800))); }
    });
  });
}

function createWindow() {
  const cfg = loadConfig();
  const targetUrl = cfg.serverUrl || `http://127.0.0.1:${DEFAULT_PORT}`;
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 940,
    minHeight: 640,
    backgroundColor: '#0c0d11',
    title: 'Cbopka',
    icon: path.join(__dirname, 'icon.png'),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false,
      backgroundThrottling: false
    }
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('Failed to load', url, code, desc);
    const indexPath = path.join(getClientDist(), 'index.html');
    if (fs.existsSync(indexPath) && !String(url).startsWith('data:')) {
      mainWindow.loadFile(indexPath).catch(() => mainWindow.loadURL(errorHtml(desc)));
    } else if (!String(url).startsWith('data:')) {
      mainWindow.loadURL(errorHtml(`${desc} (${code})`));
    }
    if (!mainWindow.isVisible()) mainWindow.show();
  });
  mainWindow.loadURL(bootHtml());
  mainWindow.webContents.once('did-finish-load', () => {
    if (!mainWindow.isVisible()) mainWindow.show();
    setTimeout(() => {
      mainWindow.loadURL(targetUrl).catch((err) => mainWindow.loadURL(errorHtml(err.message)));
    }, 200);
  });
  setTimeout(() => { if (mainWindow && !mainWindow.isVisible()) mainWindow.show(); }, 1500);
  mainWindow.on('close', (e) => {
    const cfg = loadConfig();
    if (!cfg.quit && tray) { e.preventDefault(); mainWindow.hide(); }
  });
}

function writeHostState(status, url) {
  const dir = app.getPath('userData');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'public-url-status.txt'), status || '');
    if (url) fs.writeFileSync(path.join(dir, 'public-url.txt'), url);
  } catch (e) { console.log('host file', e.message); }
}

function openPublicHost() {
  if (process.env.CBOPKA_NO_TUNNEL === '1') return;
  writeHostState('Открываем адрес для друга…');
  startPublicHost({
    port: DEFAULT_PORT,
    cacheDir: app.getPath('userData'),
    onStatus: (s) => writeHostState(s)
  }).then((handle) => {
    stopTunnel = () => { try { handle.kill(); } catch {} };
    publicUrl = handle.url;
    writeHostState('Ссылка для друга готова. Отправь её и звони.', handle.url);
    try { clipboard.writeText(handle.url); } catch {}
    try { new Notification({ title: 'Cbopka', body: 'Ссылка для друга скопирована. Отправь её и звони из программы.' }).show(); } catch {}
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle('Cbopka — ' + handle.url);
    if (tray) tray.setToolTip('Cbopka · ' + handle.url);
    try { refreshTray(); } catch {}
    console.log('Public host', handle.url);
  }).catch((e) => {
    console.error('Public host failed', e);
    writeHostState('Хост не открылся: ' + (e.message || e) + '. Друг не зайдёт, пока не перезапустишь программу с интернетом.');
  });
}

function allowMedia() {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(true));
  try {
    session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      callback({ video: sources[0] });
    }, { useSystemPicker: true });
  } catch (e) { console.log('display media', e.message); }
}

function createTray() {
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, 'tray.png'));
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
    const refresh = () => {
      const cfg = loadConfig();
      tray.setToolTip(publicUrl ? 'Cbopka · ' + publicUrl : 'Cbopka');
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Открыть Cbopka', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
        { label: 'Скопировать ссылку для друга', enabled: !!publicUrl, click: () => { if (publicUrl) clipboard.writeText(publicUrl); } },
        { label: 'Оверлей', click: () => toggleOverlay() },
        { type: 'separator' },
        { label: 'Автозапуск', type: 'checkbox', checked: !!cfg.autostart, click: (item) => setAutostart(item.checked) },
        { type: 'separator' },
        { label: 'Выйти', click: () => { const c = loadConfig(); c.quit = true; saveConfig(c); app.quit(); } }
      ]));
    };
    tray.on('click', () => { mainWindow?.show(); mainWindow?.focus(); });
    refreshTray = refresh;
    refresh();
  } catch (e) {
    console.log('tray unavailable', e.message);
  }
}

function setAutostart(on) {
  const cfg = loadConfig();
  cfg.autostart = !!on;
  saveConfig(cfg);
  try { app.setLoginItemSettings({ openAtLogin: !!on }); } catch (e) { console.log('autostart', e.message); }
  return !!on;
}

function toggleOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed()) { overlayWindow.close(); overlayWindow = null; return; }
  overlayWindow = new BrowserWindow({
    width: 360,
    height: 520,
    alwaysOnTop: true,
    frame: false,
    transparent: true,
    skipTaskbar: true,
    resizable: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false
    }
  });
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.loadURL(`http://127.0.0.1:${DEFAULT_PORT}/?overlay=1`);
}

const GAMES = [
  [/valorant/i, 'Valorant'],
  [/cs2|csgo/i, 'Counter-Strike'],
  [/dota2/i, 'Dota 2'],
  [/league of legends|leagueclient/i, 'League of Legends'],
  [/minecraft/i, 'Minecraft'],
  [/steam\.exe/i, 'Steam'],
  [/overwatch/i, 'Overwatch']
];

function watchGames() {
  if (process.platform !== 'win32') return;
  const tick = () => {
    exec('tasklist /FO CSV /NH', { timeout: 4000 }, (err, stdout) => {
      if (err || !stdout) return;
      const hit = GAMES.find(([re]) => re.test(stdout));
      mainWindow?.webContents.send('game', hit ? hit[1] : '');
    });
  };
  setInterval(tick, 20000).unref?.();
}

function setupUpdater() {
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = false;
    if (process.env.CBOPKA_UPDATE_URL) autoUpdater.setFeedURL({ provider: 'generic', url: process.env.CBOPKA_UPDATE_URL });
    autoUpdater.on('error', (e) => console.log('updater', e.message));
    if (app.isPackaged && process.env.CBOPKA_UPDATE_URL) autoUpdater.checkForUpdates().catch(() => {});
  } catch (e) {
    console.log('electron-updater skipped', e.message);
  }
}

app.whenReady().then(async () => {
  ipcMain.handle('get-server-url', () => loadConfig().serverUrl || '');
  ipcMain.handle('set-server-url', (_e, url) => { const c = loadConfig(); if (url) c.serverUrl = url; else delete c.serverUrl; saveConfig(c); return c.serverUrl || ''; });
  ipcMain.handle('get-version', () => app.getVersion());
  ipcMain.handle('get-autostart', () => !!loadConfig().autostart);
  ipcMain.handle('set-autostart', (_e, on) => setAutostart(on));
  ipcMain.handle('set-content-protection', (_e, on) => { try { mainWindow?.setContentProtection(!!on); overlayWindow?.setContentProtection(!!on); } catch {} return true; });
  ipcMain.handle('toggle-overlay', () => { toggleOverlay(); return true; });
  ipcMain.handle('notify', (_e, payload) => {
    try { new Notification({ title: payload?.title || 'Cbopka', body: payload?.body || '' }).show(); } catch {}
    return true;
  });

  allowMedia();
  const cfg = loadConfig();
  if (cfg.autostart) setAutostart(true);
  try {
    await startLocalServer();
    console.log('Server started OK');
  } catch (e) {
    console.error('Failed local server', e);
    dialog.showErrorBox('Cbopka', 'Локальный сервер не запустился:\n' + e.message);
  }
  if (!cfg.serverUrl) openPublicHost();
  createWindow();
  createTray();
  setupUpdater();
  watchGames();
  try {
    globalShortcut.register('CommandOrControl+Shift+M', () => mainWindow?.webContents.send('hotkey', 'mute'));
    globalShortcut.register('CommandOrControl+Shift+K', () => { mainWindow?.show(); mainWindow?.focus(); mainWindow?.webContents.send('hotkey', 'palette'); });
    globalShortcut.register('CommandOrControl+Shift+D', () => toggleOverlay());
  } catch (e) { console.log('shortcuts', e.message); }

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); else mainWindow?.show(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') { /* keep tray */ } });
app.on('before-quit', () => { globalShortcut.unregisterAll(); try { stopTunnel(); } catch {} if (serverProcess) { try { serverProcess.kill(); } catch {} } });
app.on('will-quit', () => { try { stopTunnel(); } catch {} if (serverProcess) { try { serverProcess.kill(); } catch {} } });
