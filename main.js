const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const https = require('https');
const http = require('http');
// The publisher sets this in game-config.json; never ask end users to paste a URL.
function loadGameConfig() {
  const candidates = [
    path.join(process.resourcesPath || __dirname, 'game-config.json'),
    path.join(__dirname, 'game-config.json')
  ];
  for (const file of candidates) {
    try {
      const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (cfg && typeof cfg.downloadUrl === 'string') return cfg;
    } catch {}
  }
  return { downloadUrl: '' };
}
const GAME_CONFIG = loadGameConfig();
const GAME_DOWNLOAD_URL = GAME_CONFIG.downloadUrl;
const GAME_UPDATE_MANIFEST_URL = GAME_CONFIG.updateManifestUrl || '';
const LAUNCHER_VERSION = require('./package.json').version;
function bundledGameArchive(){
  const candidates = [
    path.join(process.resourcesPath || __dirname, 'game', 'LignumVitae-Game.zip'),
    path.join(__dirname, 'game', 'LignumVitae-Game.zip')
  ];
  return candidates.find(p => { try { return fs.statSync(p).isFile() && fs.statSync(p).size > 10000; } catch { return false; } }) || '';
}

let launcherWindow, tray = null;
// Allow several independent game windows (for testing or running multiple sessions).
const gameWindows = new Set();
let allowQuit = false;
function showLauncher() {
  if (!launcherWindow || launcherWindow.isDestroyed()) createLauncher();
  if (launcherWindow.isMinimized()) launcherWindow.restore();
  launcherWindow.show();
  launcherWindow.focus();
}
function createTray() {
  if (tray) return;
  const iconPath = path.join(__dirname, 'build', 'icon.png');
  let icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.ico'));
  tray = new Tray(icon);
  tray.setToolTip('Nexora — arka planda çalışıyor');
  const menu = Menu.buildFromTemplate([
    { label: "Nexora'yı Aç", click: showLauncher },
    { label: 'Oyunu Aç', click: () => { showLauncher(); playGame().catch(e => dialog.showErrorBox('Lignum Vitae', e.message)); } },
    { type: 'separator' },
    { label: 'Tamamen Çıkış Yap', click: () => { allowQuit = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu);
  tray.on('double-click', showLauncher);
  tray.on('click', showLauncher);
}
const userDir = () => app.getPath('userData');
const gameDir = () => path.join(userDir(), 'games', 'Lignum Vitae');
const installedGame = () => path.join(gameDir(), 'index.html');
const installManifest = () => path.join(gameDir(), '.lignum-vitae-installed.json');
let downloadInProgress = false;
async function status(){
  const target = installedGame();
  let installed = false, size = 0;
  try {
    const manifest = JSON.parse(await fsp.readFile(installManifest(), 'utf8'));
    const st = await fsp.stat(target);
    installed = manifest && manifest.complete === true && st.isFile() && st.size > 10000;
    if (installed) {
      const walk = async dir => {
        let total = 0;
        for (const ent of await fsp.readdir(dir, {withFileTypes:true})) {
          const p = path.join(dir, ent.name);
          if (ent.isDirectory()) total += await walk(p);
          else if (ent.isFile()) total += (await fsp.stat(p)).size;
        }
        return total;
      };
      size = await walk(gameDir());
    }
  } catch {}
  return { installed, path: installed ? target : '', size,
    hasDownloadUrl: Boolean(bundledGameArchive()) || /^https:\/\//i.test(GAME_DOWNLOAD_URL),
    downloading: downloadInProgress };
}
function downloadToFile(urlString, target, redirects=0){
  return new Promise((resolve,reject)=>{
    let url;
    try { url = new URL(urlString); } catch { reject(new Error('İndirme bağlantısı geçerli bir URL değil.')); return; }
    if (url.protocol !== 'https:') { reject(new Error('Güvenlik için indirme bağlantısı https:// ile başlamalı.')); return; }
    if (redirects > 5) { reject(new Error('Çok fazla yönlendirme yapıldı.')); return; }
    const req = https.get(url, res=>{
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location){
        res.resume(); const next = new URL(res.headers.location, url).toString(); downloadToFile(next,target,redirects+1).then(resolve,reject); return;
      }
      if (res.statusCode !== 200){ res.resume(); reject(new Error(`Sunucu indirmeyi reddetti (HTTP ${res.statusCode}).`)); return; }
      const total = Number(res.headers['content-length'] || 0); let received = 0;
      const temp = target + '.download'; const out = fs.createWriteStream(temp);
      res.on('data', chunk=>{
        received += chunk.length;
        if (launcherWindow && !launcherWindow.isDestroyed()) launcherWindow.webContents.send('lv:download-progress',{received,total,percent:total?Math.min(100,Math.round(received/total*100)):null});
      });
      res.pipe(out);
      out.on('finish',()=>out.close(async()=>{
        try {
          const fd = await fsp.open(temp,'r'); const sig=Buffer.alloc(4); await fd.read(sig,0,4,0); await fd.close();
          const st = await fsp.stat(temp);
          if(st.size < 10000 || sig[0]!==0x50 || sig[1]!==0x4b) { await fsp.unlink(temp).catch(()=>{}); reject(new Error('İndirilen dosya geçerli bir oyun ZIP paketi değil. ZIP paketinin doğrudan HTTPS indirme bağlantısını kullan.')); return; }
          await fsp.rename(temp,target); resolve({size:st.size});
        } catch(e){ reject(e); }
      }));
      out.on('error', async e=>{await fsp.unlink(temp).catch(()=>{}); reject(e);});
      res.on('error', async e=>{out.destroy(); await fsp.unlink(temp).catch(()=>{}); reject(e);});
    });
    req.setTimeout(30000,()=>req.destroy(new Error('İndirme zaman aşımına uğradı.')));
    req.on('error',reject);
  });
}
async function installGame(downloadUrlOverride = ''){
  if (downloadInProgress) throw new Error('İndirme veya güncelleme zaten devam ediyor.');
  const bundled = downloadUrlOverride ? '' : bundledGameArchive();
  const selectedUrl = downloadUrlOverride || GAME_DOWNLOAD_URL;
  if(!bundled && (!selectedUrl || !/^https:\/\//i.test(selectedUrl))) throw new Error('Oyun paketi bulunamadı. Kurulum arşivi eksik.');
  downloadInProgress = true;
  const root = path.join(userDir(),'games');
  const targetDir = gameDir();
  const archive = path.join(root,'LignumVitae-download.zip');
  const staging = path.join(root,'LignumVitae-installing');
  await fsp.mkdir(root,{recursive:true});
  await fsp.rm(staging,{recursive:true,force:true});
  let result;
  try {
    if (bundled) {
      const total = (await fsp.stat(bundled)).size;
      await fsp.copyFile(bundled, archive);
      if (launcherWindow && !launcherWindow.isDestroyed()) launcherWindow.webContents.send('lv:download-progress',{received:total,total,percent:100});
      result = {size:total};
    } else result = await downloadToFile(selectedUrl,archive);
  } catch(e) { downloadInProgress = false; throw e; }
  try {
    const extract = require('extract-zip');
    await extract(archive,{dir:staging});
    // Accept either index.html at ZIP root or one top-level folder containing it.
    let sourceDir=staging;
    try { await fsp.access(path.join(sourceDir,'index.html')); }
    catch {
      const entries=await fsp.readdir(staging,{withFileTypes:true});
      const dirs=entries.filter(e=>e.isDirectory());
      if(dirs.length===1) sourceDir=path.join(staging,dirs[0].name);
      await fsp.access(path.join(sourceDir,'index.html'));
    }
    const newDir=path.join(root,'LignumVitae-new');
    await fsp.rm(newDir,{recursive:true,force:true});
    await fsp.rename(sourceDir,newDir);
    await fsp.rm(targetDir,{recursive:true,force:true});
    await fsp.rename(newDir,targetDir);
    await fsp.rm(staging,{recursive:true,force:true});
    await fsp.unlink(archive).catch(()=>{});
    await fsp.writeFile(installManifest(), JSON.stringify({complete:true, installedAt:new Date().toISOString(), packageBytes:result.size, gameVersion: GAME_CONFIG.gameVersion || '1.0.0'}, null, 2), 'utf8');
    downloadInProgress = false;
    return {message:`Lignum Vitae tam paket olarak indirildi ve kuruldu (${(result.size/1024/1024).toFixed(2)} MB). Artık OYNA düğmesine basabilirsin.`,path:installedGame(),size:result.size};
  } catch(e) {
    await fsp.rm(staging,{recursive:true,force:true}).catch(()=>{});
    downloadInProgress = false;
    throw new Error(`Oyun ZIP paketi açılamadı veya içinde index.html bulunamadı. ${e.message}`);
  } finally { await fsp.unlink(archive).catch(()=>{}); }
}
function getJsonHttps(urlString, redirects=0){
  return new Promise((resolve,reject)=>{
    let url; try { url = new URL(urlString); } catch { reject(new Error('Güncelleme adresi geçersiz.')); return; }
    if(url.protocol !== 'https:'){ reject(new Error('Güncelleme manifesti güvenlik için HTTPS kullanmalı.')); return; }
    if(redirects > 5){ reject(new Error('Güncelleme adresinde çok fazla yönlendirme var.')); return; }
    const req=https.get(url,res=>{
      if([301,302,303,307,308].includes(res.statusCode) && res.headers.location){res.resume();getJsonHttps(new URL(res.headers.location,url).toString(),redirects+1).then(resolve,reject);return;}
      if(res.statusCode!==200){res.resume();reject(new Error(`Güncelleme sunucusu HTTP ${res.statusCode} döndürdü.`));return;}
      let data=''; res.setEncoding('utf8'); res.on('data',c=>{data+=c;if(data.length>1024*1024)req.destroy(new Error('Güncelleme bilgisi beklenenden büyük.'));});
      res.on('end',()=>{try{resolve(JSON.parse(data));}catch{reject(new Error('Güncelleme bilgisi geçerli JSON değil.'));}});
    });
    req.setTimeout(15000,()=>req.destroy(new Error('Güncelleme kontrolü zaman aşımına uğradı.'))); req.on('error',reject);
  });
}
async function updateGame(){
  if(!GAME_UPDATE_MANIFEST_URL || !/^https:\/\//i.test(GAME_UPDATE_MANIFEST_URL))
    throw new Error('Otomatik güncelleme sunucusu henüz tanımlanmamış. game-config.json dosyasına yayınlanan sürümün HTTPS manifest adresi eklenmeli.');
  const current=await status();
  if(!current.installed) throw new Error('Önce oyunu kurmalısın.');
  const manifest=await getJsonHttps(GAME_UPDATE_MANIFEST_URL);
  if(!manifest || typeof manifest.version!=='string' || typeof manifest.downloadUrl!=='string' || !/^https:\/\//i.test(manifest.downloadUrl))
    throw new Error('Güncelleme manifestinde version ve HTTPS downloadUrl alanları olmalı.');
  let installedVersion='0.0.0';
  try{const local=JSON.parse(await fsp.readFile(installManifest(),'utf8'));installedVersion=local.gameVersion||GAME_CONFIG.gameVersion||'1.0.0';}catch{}
  const cmp=(a,b)=>{const aa=a.split(/[.+-]/).slice(0,3).map(x=>parseInt(x,10)||0),bb=b.split(/[.+-]/).slice(0,3).map(x=>parseInt(x,10)||0);for(let i=0;i<3;i++){if((aa[i]||0)!==(bb[i]||0))return (aa[i]||0)>(bb[i]||0)?1:-1;}return 0;};
  if(cmp(manifest.version,installedVersion)<=0) return {updated:false,message:`Oyun güncel. Kurulu sürüm: ${installedVersion}.`};
  const result=await installGame(manifest.downloadUrl);
  // Store the server-published version after the package has installed successfully.
  try{const local=JSON.parse(await fsp.readFile(installManifest(),'utf8'));local.gameVersion=manifest.version;await fsp.writeFile(installManifest(),JSON.stringify(local,null,2),'utf8');}catch{}
  return {updated:true,message:`Oyun ${manifest.version} sürümüne güncellendi.`,path:result.path,size:result.size,version:manifest.version};
}
function openGameWindow(file){
  // Each press of OYNA opens a new independent game window instead of focusing
  // the already-running session. Every window uses the installed game files.
  const win = new BrowserWindow({width:1500,height:940,minWidth:960,minHeight:650,title:'Lignum Vitae',backgroundColor:'#10130f',autoHideMenuBar:true,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});
  gameWindows.add(win);
  win.loadFile(file);
  win.webContents.on('did-fail-load',(_e,code,desc)=>dialog.showErrorBox('Lignum Vitae',`Oyun yüklenemedi (${code}): ${desc}`));
  win.on('closed',()=>{gameWindows.delete(win);});
  return win;
}
async function playGame(){
  let s=await status();
  if(!s.installed) throw new Error('Oyun kurulu değil. Oyunu indirmeden başlatamazsın; önce İNDİR işlemi tamamlanmalı.');
  openGameWindow(installedGame()); return {message:'Lignum Vitae açılıyor…'};
}
function createLauncher(){
  launcherWindow=new BrowserWindow({width:1440,height:920,minWidth:980,minHeight:680,title:'Nexora',backgroundColor:'#101214',autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  launcherWindow.loadFile(path.join(__dirname,'index.html'));
  launcherWindow.on('close', (event) => {
    if (!allowQuit) { event.preventDefault(); launcherWindow.hide(); }
  });
}
ipcMain.handle('lv:status',()=>status());
ipcMain.handle('lv:install',()=>installGame());
ipcMain.handle('lv:update',()=>updateGame());
ipcMain.handle('lv:play',()=>playGame());
app.whenReady().then(()=>{createTray(); createLauncher();app.on('activate',showLauncher);});
app.on('before-quit',()=>{allowQuit=true;});
app.on('window-all-closed',()=>{ /* Steam-style: keep the launcher alive in the system tray. */ });
process.on('uncaughtException',err=>{try{fs.appendFileSync(path.join(userDir(),'nexora-error.log'),`${new Date().toISOString()} ${err.stack||err}\n`);}catch{}; if(app.isReady())dialog.showErrorBox('Nexora',String(err.stack||err));});
