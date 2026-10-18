'use strict';
const { app, BrowserWindow, WebContentsView, session, Tray, Menu, ipcMain, shell, utilityProcess, nativeImage, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const os = require('os');
const { Services, validateMainPort } = require('./services.cjs');
const { changedConfig } = require('./admin-key.cjs');
const { NeteaseLogin, verifyQQLogin, QQLoginKeeper } = require('./netease-login.cjs');
const vm = require('vm');
app.setName('JukeboxDesktop');
app.commandLine.appendSwitch('lang', 'zh-CN');
app.setPath('userData', path.join(app.getPath('appData'), 'JukeboxDesktop'));
const stateFile = path.join(__dirname, 'ui', 'index.html');
const stateURL = pathToFileURL(stateFile).href;
let statusWindow, musicView, tray, manager, activePage = 'home', exiting = false, allowExit = false, closeNotice = false;
let loginView, loginCapture, loginMessage = '点击登录后，在网易云官方页面完成登录。';
let updates;
let updateWindow;
let qqKeeper, qqRefreshWindow;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => showStatus());
  app.whenReady().then(initialize);
}
function showStatus() { if (statusWindow) { statusWindow.show(); statusWindow.focus(); } }
function controlled(window, allowed) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (!allowed(url)) event.preventDefault(); });
  window.on('close', event => { if (!exiting) { event.preventDefault(); window.hide(); if (!closeNotice) { closeNotice = true; tray.displayBalloon({ title: '局域网点歌机', content: '服务继续在后台运行；请从托盘菜单退出。' }); } } });
}
function addresses() {
  const lan = Object.entries(os.networkInterfaces())
    .filter(([name]) => !/vethernet|vmware|virtualbox|vpn|tun|tap|loopback/i.test(name))
    .flatMap(([, items]) => items || [])
    .find(item => item.family === 'IPv4' && !item.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address));
  return lan ? ['http://' + lan.address + ':' + manager.ports.main] : [];
}
function snapshot() { return { ...manager.snapshot(), page: activePage, loginMessage, update: updates?.snapshot() || { version: app.getVersion?.() || '开发版', status: 'idle', message: '在线更新仅在安装版中可用。' }, needsSetup: !fs.existsSync(path.join(manager.dataDir, 'server', 'config.local.js')), addresses: addresses() }; }
function broadcast() {
  if (manager.state !== 'running') { activePage = 'home'; musicView?.setVisible(false); loginView?.setVisible(false); loginCapture?.stop(); }
  statusWindow?.webContents.send('desktop:state', snapshot());
}
function resizeMusicView() {
  if (!musicView && !loginView) return;
  const [width, height] = statusWindow.getContentSize();
  for (const view of [musicView, loginView]) view?.setBounds({ x: 0, y: 104, width, height: Math.max(0, height - 104) });
}
function authorized(event) { return event.sender === statusWindow?.webContents && event.senderFrame === statusWindow.webContents.mainFrame && event.senderFrame.url === stateURL; }
function handler(name, operation) { ipcMain.handle('desktop:' + name, async (event, ...args) => { if (!authorized(event)) throw new Error('未经授权的页面'); return operation(...args); }); }
async function initialize() {
  Menu.setApplicationMenu(null);
  const dataDir = app.getPath('userData');
  const settingsPath = path.join(dataDir, 'desktop-settings.json');
  const mainPort = fs.existsSync(settingsPath) ? validateMainPort(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).mainPort) : 8080;
  for (const name of ['server', 'qq/record', 'netease', 'logs']) fs.mkdirSync(path.join(dataDir, name), { recursive: true });
  const runtimeDir = app.isPackaged ? path.join(process.resourcesPath, 'runtime') : path.join(__dirname, 'staging', 'runtime');
  const mpvPath = app.isPackaged ? path.join(process.resourcesPath, 'mpv', 'mpv.exe') : path.join(__dirname, 'vendor', 'mpv', 'mpv.exe');
  manager = new Services({ utilityProcess, runtimeDir, dataDir, mpvPath, ports: { main: mainPort, qq: 3400, netease: 4000 } });
  if (app.isPackaged) {
    const qqSession = session.fromPartition('persist:qq-login');
    qqKeeper = new QQLoginKeeper({session:qqSession,
      enabled:()=>!exiting && manager.state==='running' && !loginCapture?.active,
      readStatus:async()=>{
        const response=await fetch('http://127.0.0.1:'+manager.ports.qq+'/user/loginStatus',{signal:AbortSignal.timeout(10000)});
        if(!response.ok)throw new Error('QQ服务未就绪');return response.json();
      },
      save:(cookie,expectedFingerprint)=>manager.enqueue(async()=>{
        if(exiting || manager.state!=='running' || loginCapture?.active)return false;
        const response=await fetch('http://127.0.0.1:'+manager.ports.qq+'/user/setCookie',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({data:cookie,expectedFingerprint}),signal:AbortSignal.timeout(8000)});
        const result=await response.json();if(result.result===409)return false;
        if(!response.ok || result.result!==100)throw new Error('保存失败');return true;
      }),
      refreshSession:async()=>{
        if(qqRefreshWindow || exiting || loginCapture?.active)return;
        const window=new BrowserWindow({show:false,webPreferences:{session:qqSession,sandbox:true,contextIsolation:true,nodeIntegration:false}});
        qqRefreshWindow=window;
        const allowed=url=>{try{const parsed=new URL(url);return parsed.protocol==='https:' && /(^|\.)qq\.com$/.test(parsed.hostname)}catch{return false}};
        for(const event of ['will-navigate','will-redirect'])window.webContents.on(event,(event,url)=>{if(!allowed(url))event.preventDefault()});
        window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
        const deadline=setTimeout(()=>window.destroy(),12000);
        try{
          await window.loadURL('https://y.qq.com/');
          if(!window.isDestroyed())await new Promise(resolve=>{
            const done=()=>{clearTimeout(settle);window.removeListener('closed',done);resolve()};
            const settle=setTimeout(done,4000);window.once('closed',done);
          });
        }finally{clearTimeout(deadline);if(!window.isDestroyed())window.destroy();if(qqRefreshWindow===window)qqRefreshWindow=undefined;}
      },
      report:message=>{loginMessage=message;musicView?.webContents.send('music:login-result',message);broadcast();}
    });
    qqKeeper.start();
  }
  manager.on('state', state => {
    // Protocol state only: upstream stdout, requests, cookies and signed URLs are excluded.
    const entry = JSON.stringify({ time: new Date().toISOString(), state: state.state, services: state.services });
    const log = path.join(dataDir, 'logs', 'desktop.log');
    try { if (fs.existsSync(log) && fs.statSync(log).size > 1024 * 1024) fs.renameSync(log, log + '.previous'); fs.appendFileSync(log, entry + '\n'); } catch {}
    broadcast();
  });
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'));
  tray = new Tray(icon); tray.setToolTip('局域网点歌机'); tray.on('double-click', showStatus);
  tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开窗口', click: showStatus }, { label: '重启全部服务', click: () => run(() => manager.restart()) }, { type: 'separator' }, { label: '退出', click: quit }]));
  statusWindow = new BrowserWindow({ width: 1100, height: 800, minWidth: 800, minHeight: 600, title: '局域网点歌机', icon, titleBarStyle: 'hidden', titleBarOverlay: { color: '#14251f', symbolColor: '#e8f1ee', height: 40 }, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  statusWindow.on('resize', resizeMusicView);
  controlled(statusWindow, url => url === stateURL);
  statusWindow.loadFile(stateFile);
  handler('state', snapshot);
  handler('quit', quit);
  handler('login-check', () => loginCapture?.capture());
  ipcMain.handle('music:login', async (event, platform, key) => {
    if (event.sender !== musicView?.webContents || event.senderFrame !== musicView.webContents.mainFrame || event.senderFrame.url !== 'http://127.0.0.1:' + manager.ports.main + '/admin.html') throw new Error('请从管理台登录');
    if (!['netease', 'qq'].includes(platform)) throw new Error('不支持的平台');
    const configModule = { exports: {} }; vm.runInNewContext(fs.readFileSync(path.join(dataDir, 'server', 'config.local.js'), 'utf8'), { module: configModule }, { timeout: 100 });
    if (!key || key !== configModule.exports.adminKey) throw new Error('管理口令无效，请重新登录管理台');
    if (manager.state !== 'running') throw new Error('请先启动主服务');
    loginCapture?.stop();
    loginView?.webContents.close();
    if (loginView) statusWindow.contentView.removeChildView(loginView);
    {
      const name = platform === 'qq' ? 'QQ音乐' : '网易云';
      const loginSession = session.fromPartition('persist:' + platform + '-login');
      loginView = new WebContentsView({ webPreferences: { session: loginSession, sandbox: true, contextIsolation: true, nodeIntegration: false } });
      const allowed = url => { try { const target = new URL(url); const domain = platform === 'qq' ? 'qq.com' : '163.com'; return target.protocol === 'https:' && (target.hostname === domain || target.hostname.endsWith('.' + domain)); } catch { return false; } };
      loginView.webContents.on('will-navigate', (event, url) => { if (!allowed(url)) event.preventDefault(); });
      loginView.webContents.on('will-redirect', (event, url) => { if (!allowed(url)) event.preventDefault(); });
      loginView.webContents.setWindowOpenHandler(({ url }) => { if (allowed(url)) loginView.webContents.loadURL(url).catch(() => {}); return { action: 'deny' }; });
      statusWindow.contentView.addChildView(loginView);
      const capture = new NeteaseLogin({ session: loginSession, platform,
        verify: async cookie => {
          if (platform === 'qq') return verifyQQLogin(cookie);
          const response = await fetch('http://127.0.0.1:' + manager.ports[platform] + (platform === 'qq' ? '/user/refresh' : '/login/status'), { headers: { Cookie: cookie }, signal: AbortSignal.timeout(8000) });
          if (!response.ok) throw new Error('验证失败');
          const result = await response.json();
          return !!result.data?.profile?.userId;
        },
        save: cookie => manager.enqueue(async () => {
          if (manager.state !== 'running' || !capture.active) throw new Error('服务已停止');
          const module = { exports: {} }; vm.runInNewContext(fs.readFileSync(path.join(dataDir, 'server', 'config.local.js'), 'utf8'), { module }, { timeout: 100 });
          if (module.exports.adminKey !== key) throw new Error('管理口令已修改');
          const response = await fetch('http://127.0.0.1:' + manager.ports.main + '/api/admin/cookie', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-key': key }, body: JSON.stringify({ platform, cookie }), signal: AbortSignal.timeout(8000) });
          if (!response.ok) throw new Error('保存失败');
        }),
        report: (message, complete) => {
          loginMessage = name + '：' + message;
          if (complete) { activePage = 'admin'; loginView.setVisible(false); musicView.setVisible(true); }
          musicView.webContents.send('music:login-result', loginMessage); broadcast();
        }
      });
      loginCapture = capture;
    }
    musicView?.setVisible(false); loginMessage = '请在官方页面完成登录，完成后会自动验证并保存。';
    activePage = platform + '-login'; resizeMusicView(); loginView.setVisible(true); broadcast();
    loginCapture.start();
    try { await loginView.webContents.loadURL(platform === 'qq' ? 'https://y.qq.com/' : 'https://music.163.com/'); }
    catch { if (activePage === platform + '-login') { loginMessage = '官方页面加载失败，请检查网络后重新打开。'; activePage = 'admin'; loginView.setVisible(false); musicView.setVisible(true); loginCapture.stop(); musicView.webContents.send('music:login-result', loginMessage); broadcast(); } }
    return snapshot();
  });
  handler('password', (oldKey, newKey) => manager.enqueue(async () => {
    const configPath = path.join(dataDir, 'server', 'config.local.js');
    const config = changedConfig(fs.readFileSync(configPath, 'utf8'), oldKey, newKey);
    const wasRunning = manager.state === 'running';
    if (wasRunning) { await manager.stopChild('main'); manager.changed('main-stopped'); }
    try {
      fs.writeFileSync(configPath + '.tmp', config, { mode: 0o600 });
      fs.renameSync(configPath + '.tmp', configPath);
    } finally {
      fs.rmSync(configPath + '.tmp', { force: true });
      if (wasRunning) await manager.startInternal(true);
    }
    return snapshot();
  }));
  handler('port', async port => {
    await manager.configureMainPort(port, mainPort => fs.writeFileSync(settingsPath, JSON.stringify({ mainPort }), { mode: 0o600 }), !snapshot().needsSetup);
    return snapshot();
  });
  handler('setup', async key => {
    if (typeof key !== 'string') throw new Error('口令需为 8–128 个字符');
    key = key.trim();
    if (key.length < 8 || key.length > 128) throw new Error('口令需为 8–128 个字符');
    const template = fs.readFileSync(path.join(runtimeDir, 'server', 'config.local.example.js'), 'utf8');
    if (!/adminKey:\s*''/.test(template)) throw new Error('干净配置模板缺少口令字段');
    const config = template.replace(/adminKey:\s*''/, () => 'adminKey: ' + JSON.stringify(key));
    fs.writeFileSync(path.join(dataDir, 'server', 'config.local.js'), config, { flag: 'wx', mode: 0o600 });
    await run(() => manager.start()); return snapshot();
  });
  handler('restart', () => run(() => manager.restart()));
  handler('update-check', () => updates?.check());
  handler('update-download', () => updates?.download());
  handler('update-release', () => shell.openExternal('https://github.com/sangui0312/jukebox-/releases/latest'));
  handler('resume', () => run(() => manager.resumeMain()));
  handler('open', async page => {
    const returningToAdmin = page === 'admin' && activePage.endsWith('-login');
    loginCapture?.stop(); loginView?.setVisible(false);
    if (returningToAdmin && manager.state === 'running') { activePage = 'admin'; musicView.setVisible(true); broadcast(); return snapshot(); }
    if (page === 'home') { activePage = 'home'; musicView?.setVisible(false); broadcast(); return snapshot(); }
    if (manager.state !== 'running' || !['song', 'admin'].includes(page)) throw new Error('服务尚未就绪');
    const base = 'http://127.0.0.1:' + manager.ports.main;
    if (!musicView) {
      musicView = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'music-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
      musicView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      musicView.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== 'http://127.0.0.1:' + manager.ports.main) event.preventDefault(); });
      statusWindow.contentView.addChildView(musicView);
    }
    activePage = 'home'; broadcast();
    musicView.setVisible(false);
    await musicView.webContents.loadURL(base + (page === 'admin' ? '/admin.html' : '/'));
    if (manager.state !== 'running') return snapshot();
    activePage = page; resizeMusicView(); musicView.setVisible(true); broadcast(); return snapshot();
  });
  handler('copy', () => { const address = addresses()[0]; if (!address) throw new Error('未发现局域网地址，请连接网络。'); require('electron').clipboard.writeText(address); });
  handler('folder', kind => { if (!['data', 'logs'].includes(kind)) throw new Error('非法目录'); return shell.openPath(kind === 'data' ? dataDir : path.join(dataDir, 'logs')); });
  if (!snapshot().needsSetup) await run(() => manager.start());
  if (app.isPackaged) {
    updateWindow = require('./update-window.cjs').createUpdateWindow(dataDir, path.join(process.resourcesPath, 'update-window.ps1'), app.getVersion());
    updates = require('./updates.cjs').createUpdates(require('electron-updater').autoUpdater, app.getVersion(), () => {
      updateWindow.publish(updates.snapshot()); broadcast();
    }, { open: () => updateWindow.open(updates.snapshot()), ready: quit });
    updates.check();
  }
}
async function run(operation) {
  try {
    if (!fs.existsSync(manager.mpvPath) || !fs.existsSync(path.join(manager.runtimeDir, 'web', 'dist', 'admin.html'))) throw new Error('程序资源不完整，请重新安装。');
    await operation();
  } catch (error) { if (manager.state !== 'failed') { manager.error = error.message; manager.changed('failed'); } }
  return snapshot();
}
async function quit() {
  if (exiting) return;
  exiting = true;
  try { loginCapture?.stop(); qqKeeper?.stop(); qqRefreshWindow?.destroy(); await manager?.stop(); musicView?.webContents.close(); loginView?.webContents.close(); tray?.destroy(); allowExit = true; updates?.installOnExit(); app.quit(); }
  catch (error) { exiting = false; allowExit = false; if (['ready', 'installing'].includes(updates?.snapshot().status)) updates.fail(); manager.error = error.message; manager.changed('failed'); showStatus(); }
}
app.on('before-quit', event => { if (!allowExit) { event.preventDefault(); quit(); } });
app.on('window-all-closed', () => {});
