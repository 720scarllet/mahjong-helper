const {app,BrowserWindow,ipcMain,dialog,clipboard,globalShortcut,screen}=require('electron');
const fs=require('node:fs');const path=require('node:path');const http=require('node:http');const crypto=require('node:crypto');
const {Protocol}=require('./protocol.cjs');const {GameState,prospects}=require('./state.cjs');const {Engine}=require('./engine.cjs');
const {startProxy}=require('./capture.cjs');const {WindowsProxy}=require('./windows-proxy.cjs');
const {startInjector}=require('./injector.cjs');
const {EdgeBrowser}=require('./edge-browser.cjs');
const {analyzeCalls}=require('./calls.cjs');
const {MjaiHistory,validateAdvice}=require('./mjai.cjs');
const primaryInstance=app.requestSingleInstanceLock();
if(!primaryInstance)app.quit();
let launcher,edge,engine,bridge,proxy,winProxy,injector,gameConnection;let quitting=false,closing=false,source='web',analysis=null,analyzing=false,lastAnalyzed=-1;
const panels=new Map();
const gameURLs=['https://game.maj-soul.com/1/','https://game.maj-soul.net/1/','https://game.mahjongsoul.com/','https://mahjongsoul.game.yo-star.com/'];
const regions=gameURLs.map((url,i)=>({id:['cn','cn2','jp','en'][i],label:['国服 / 中文','中文备用入口','日本服','英文服'][i],url}));
let proxyBusy=false;
let currentRegion='cn';
let currentNetwork='direct';
let status={frames:0,decoded:0,lastMessage:'',lastAt:0,error:'',schema:'0.11.243.w'};
const token=crypto.randomBytes(24).toString('hex');const state=new GameState();
const schemaPath=path.join(__dirname,'..','liqi.json');const protocol=new Protocol(JSON.parse(fs.readFileSync(schemaPath,'utf8')));
const log=[];
const history=new MjaiHistory(),modelEngines=new Map();
const modelRoot=app.isPackaged?path.join(process.resourcesPath,'mortal'):path.join(__dirname,'..','vendor','mortal');
function modelEngine(players){
  if(modelEngines.has(players))return modelEngines.get(players);
  const python=path.join(modelRoot,'runtime','python.exe'),dir=path.join(modelRoot,`${players}p`);
  if(!fs.existsSync(python)||!fs.existsSync(path.join(dir,'mortal.pth')))throw new Error('本地模型未配置，请运行一键配置');
  const worker=app.isPackaged?path.join(process.resourcesPath,'mortal-worker.py'):path.join(__dirname,'..','scripts','mortal-worker.py');
  const modelProcess=new Engine(python,['-B','-u',worker,'--model-dir',dir],{timeout:60000,cwd:dir});
  modelEngines.set(players,modelProcess);return modelProcess;
}
function diagnostic(message){log.unshift({time:new Date().toLocaleTimeString('zh-CN'),message});log.splice(40);publish();}
function snapshot(){return {...state.snapshot(),routes:prospects(state),analysis,analyzing,status:{...status},source,proxy:!!proxy,regions,currentRegion,currentNetwork,token,log};}
function ownedWindows(){return [launcher,...panels.values()].filter(w=>w&&!w.isDestroyed());}
function publish(){const value=snapshot();for(const win of ownedWindows())win.webContents.send('state',value);}
function showLauncher(){if(launcher&&!launcher.isDestroyed()){launcher.restore();launcher.show();launcher.focus();}}
function showPanels(){for(const win of panels.values()){win.setIgnoreMouseEvents(false);win.restore();win.showInactive();}publish();}
function layout(area=screen.getPrimaryDisplay().workArea){
  const left=Math.min(240,Math.max(210,Math.floor(area.width*.16))),right=Math.min(260,Math.max(230,Math.floor(area.width*.18)));
  return {left:{x:area.x+8,y:area.y+12,width:left,height:area.height-24},right:{x:area.x+area.width-right-8,y:area.y+12,width:right,height:area.height-24},game:{left:area.x+left+16,top:area.y,width:area.width-left-right-32,height:area.height}};
}
async function fitLayout(){const bounds=layout();for(const [side,win] of panels)win.setBounds(bounds[side]);await edge?.fit(bounds.game);}
function closeConnection(connection) {
  protocol.close(connection);
  if(connection===gameConnection){gameConnection=null;state.active=false;state.pendingCall=null;state.revision++;history.reset();analysis=null;status.error='游戏连接已断开，等待重连';publish();}
}
async function analyze() {
  if(analyzing)return;
  const snap=state.snapshot();
  if(!snap.active || snap.revision===lastAnalyzed)return;
  const revision=snap.revision;lastAnalyzed=revision;analyzing=true;analysis=null;publish();
  const request=state.analysisRequest();
  const modelRequest=history.request(snap),operation=structuredClone(history.operation);
  // Run policy first so a slow efficiency search does not hold up a reaction.
  const policy=modelRequest?Promise.resolve().then(()=>modelEngine(snap.players).analyze(modelRequest)).then(out=>({advice:validateAdvice(out.advice,snap,operation),elapsedMs:out.elapsedMs})).catch(e=>({error:e.message})):Promise.resolve({error:history.error||'等待本人可操作的回合'});
  try{
    const modelResult=await policy;
    if(revision===state.revision){analysis={results:[],shanten:null,revision,model:modelResult};publish();}
    const result=await engine.analyze(request);
    if(revision===state.revision){analysis={...result,revision,model:modelResult};publish();}
    const calls=revision===state.revision?await analyzeCalls(engine,request,result,snap):null;
    if(revision===state.revision&&analysis)analysis.calls=calls;
  }
  catch(e){if(revision===state.revision)status.error=`分析失败：${e.message}`;}
  finally{analyzing=false;publish();if(state.revision!==revision)analyze();}
}
function frame(connection,direction,bytes,origin) {
  if(source!==origin)return;
  status.frames++;status.lastAt=Date.now();
  try {
    let changed=false;
    for(const event of protocol.frame(connection,direction,bytes)) {
      status.decoded++;status.lastMessage=event.name.split('.').at(-1);
      if(/authGame$/.test(event.name)&&!event.data.error?.code)gameConnection=connection;
      if((event.name.includes('Action')||event.name.startsWith('restore')||event.name==='operationSent')&&gameConnection&&connection!==gameConnection)continue;
      if(event.name==='operationSent'&&history.operation){history.operation=null;state.revision++;analysis=null;changed=true;}
      const before=state.snapshot();
      if(state.apply(event)){history.apply(event,state.snapshot(),before);changed=true;analysis=null;status.error='';if(event.name.endsWith('ActionNewRound')&&!gameConnection)gameConnection=connection;}
    }
    if(changed){publish();analyze();}
  }catch(e){status.error=`协议解析失败：${e.message}`;state.active=false;state.revision++;analysis=null;diagnostic(status.error);}
  publish();
}
function createEdge(){return new EdgeBrowser({profileDir:path.join(app.getPath('userData'),`edge-profile-${currentNetwork}`),proxyMode:currentNetwork,onFrame:(c,d,b)=>frame(c,d,b,'web'),onClose:closeConnection,onStatus:diagnostic});}
async function openGame(options=gameURLs[0]) {
  const url=typeof options==='string'?options:options?.url;
  const network=typeof options==='object'?options.network:currentNetwork;
  if(!gameURLs.includes(url))throw new Error('未知的游戏地址');
  if(!['direct','system'].includes(network))throw new Error('未知网络方式');
  if(proxy)throw new Error('请先关闭客户端接入');
  if(network!==currentNetwork){await edge.close();currentNetwork=network;edge=createEdge();}
  currentRegion=regions.find(r=>r.url===url).id;
  resetSource('web');
  await edge.open(url);
  await fitLayout();
  showPanels();launcher?.hide();
  diagnostic('Edge 已打开；等待登录与对局消息');
}
async function startBridge() {
  bridge=http.createServer((req,res)=>{
    const origin=req.headers.origin||'';
    if(origin.startsWith('chrome-extension://')||origin.startsWith('moz-extension://'))res.setHeader('Access-Control-Allow-Origin',origin);
    res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
    if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
    if(req.method!=='POST'||req.url!=='/frame'||req.headers.authorization!==`Bearer ${token}`){res.writeHead(403);res.end();return;}
    let body='',size=0;
    req.on('data',b=>{size+=b.length;if(size>2*1024*1024){req.destroy();return;}body+=b;});
    req.on('end',()=>{
      try{
        const p=JSON.parse(body);
        if(typeof p.connection!=='string'||!['send','receive','close'].includes(p.direction))throw new Error('Invalid frame');
        const id=`ext:${p.connection}`;
        if(p.direction==='close')closeConnection(id);
        else if(typeof p.data==='string')frame(id,p.direction,Buffer.from(p.data,'base64'),'extension');
        res.writeHead(204);res.end();
      }catch{res.writeHead(400);res.end();}
    });
  });
  await new Promise((resolve,reject)=>{bridge.once('error',reject);bridge.listen(19221,'127.0.0.1',resolve);});
}
function resetSource(next) {
  if(!['web','extension','client'].includes(next))throw new Error('未知数据来源');
  if(proxy&&next!=='client')throw new Error('请先关闭客户端代理');
  source=next;state.clear();history.reset();gameConnection=null;protocol.connections.clear();analysis=null;lastAnalyzed=-1;
  status={...status,frames:0,decoded:0,error:'',lastMessage:'',lastAt:0};publish();
}
async function toggleProxy(options={}) {
  if(proxyBusy)throw new Error('客户端接入正在切换');
  proxyBusy=true;
  try {
  if(proxy){await winProxy.restore();await injector?.close();injector=null;proxy.close();proxy=null;state.active=false;state.revision++;analysis=null;diagnostic('客户端代理已关闭，请关闭并重新打开游戏客户端');return;}
  const mode=options.mode==='inject'?'inject':'system';
  const choice=await dialog.showMessageBox(BrowserWindow.getFocusedWindow()||launcher,{type:'question',buttons:['取消','开启客户端代理'],defaultId:0,cancelId:0,title:'客户端数据接入',message:'开启本地游戏代理？',detail:mode==='inject'?`将为 ${options.process||'jantama_mahjongsoul'} 进程加载 Proxinject 代理模块，并导入本工具证书。不会修改系统代理。关闭工具后请退出游戏客户端以结束进程内代理。仅解码雀魂域名的连接，兼容性需要实际对局确认。`:'将保存并修改当前用户的 Windows 代理设置，导入本工具生成的证书。仅解码雀魂域名的连接；关闭代理或退出程序时恢复设置并移除新增证书。请重启游戏客户端。未采用 Windows 代理或使用证书固定的客户端可能无法接入。'});
  if(choice.response!==1)return;
  resetSource('client');
  const caDir=path.join(app.getPath('userData'),'certificates');
  const started=await startProxy(caDir,(c,d,b)=>frame(c,d,b,'client'),diagnostic,closeConnection);
  try{
    await winProxy.enable(path.join(caDir,'certs','ca.pem'),mode);
    if(mode==='inject')injector=await startInjector(app.isPackaged?path.join(process.resourcesPath,'proxinject','proxinjector-cli.exe'):path.join(__dirname,'..','vendor','proxinject','proxinjector-cli.exe'),options.process||'jantama_mahjongsoul',diagnostic);
    proxy=started;diagnostic(mode==='inject'?'游戏进程代理已启动，等待游戏连接':'客户端代理已开启：127.0.0.1:19222，请重启游戏客户端');
  }catch(e){started.close();await winProxy.restore();throw e;}
  }finally{proxyBusy=false;}
}
async function refreshSchema(base) {
  if(!gameURLs.includes(base))throw new Error('未知服务器');
  const get=async url=>{const r=await fetch(url,{signal:AbortSignal.timeout(25000)});if(!r.ok)throw new Error(`资源请求失败 ${r.status}`);return r.json();};
  const v=await get(base+'version.json');const resources=await get(base+`resversion${v.version}.json`);
  const prefix=resources.res['res/proto/liqi.json'].prefix;
  const schema=await get(base+prefix+'/res/proto/liqi.json');
  new Protocol(schema);
  fs.writeFileSync(path.join(app.getPath('userData'),'liqi-current.json'),JSON.stringify(schema));
  protocol.setSchema(schema);status.schema=prefix;diagnostic(`协议已更新至 ${prefix}`);
}
function createWindow(options,file,query) {
  const win=new BrowserWindow({...options,backgroundColor:'#121619',show:false,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  win.removeMenu();win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',e=>e.preventDefault());
  win.webContents.on('did-finish-load',publish);
  win.loadFile(path.join(__dirname,'..','ui',file),{query});
  return win;
}
app.on('second-instance',showLauncher);
app.whenReady().then(async()=>{
  if(!primaryInstance)return;
  winProxy=new WindowsProxy(path.join(app.getPath('userData'),'proxy-recovery.json'));
  try{await winProxy.restore();}catch(e){status.error=`上次代理设置恢复失败：${e.message}`;}
  const cached=path.join(app.getPath('userData'),'liqi-current.json');
  if(fs.existsSync(cached)){try{protocol.setSchema(JSON.parse(fs.readFileSync(cached,'utf8')));status.schema='本地更新缓存';}catch{}}
  engine=new Engine(app.isPackaged?path.join(process.resourcesPath,'bin','overlay-engine.exe'):path.join(__dirname,'..','bin','overlay-engine.exe'));
  edge=createEdge();
  // Loading one policy at a time limits contention during the first cold start.
  (async()=>{for(const players of [3,4]){
    try{await modelEngine(players).analyze({probe:true});}
    catch(e){diagnostic(`本地${players}麻模型：${e.message}`);}
  }})();
  const callExpiry=setInterval(()=>{
    let expired=state.expireCall();
    if(history.operation&&history.operation.expiresAt<=Date.now()){history.operation=null;state.revision++;expired=true;}
    if(expired){analysis=null;publish();analyze();}
  },250);
  callExpiry.unref();
  const area=screen.getPrimaryDisplay().workArea;
  launcher=createWindow({width:460,height:Math.min(540,area.height-24),minWidth:400,minHeight:400,frame:false,title:'雀魂助手 · 启动'},'launcher.html');
  launcher.once('ready-to-show',()=>launcher.show());
  launcher.on('close',e=>{if(!quitting){e.preventDefault();app.quit();}});
  const bounds=layout(area);
  for(const side of ['left','right']){
    const win=createWindow({...bounds[side],minWidth:200,minHeight:450,frame:false,alwaysOnTop:true,title:`雀魂助手 · ${side==='left'?'记牌':'建议'}`},'index.html',{panel:side});
    win.setAlwaysOnTop(true,'floating');panels.set(side,win);
    win.on('close',e=>{if(!quitting){e.preventDefault();win.hide();if([...panels.values()].every(p=>!p.isVisible()))showLauncher();}});
  }
  ipcMain.handle('command',async(event,cmd,arg)=>{
    const caller=ownedWindows().find(w=>w.webContents===event.sender);
    if(!caller)throw new Error('Invalid caller');
    try{
      switch(cmd){
        case 'state':return snapshot();
        case 'open-game':await openGame(arg);break;
        case 'show-panels':showPanels();break;
        case 'fit':await fitLayout();showPanels();break;
        case 'hide-panels':for(const win of panels.values())win.hide();showLauncher();break;
        case 'launcher':showLauncher();break;
        case 'source':resetSource(arg);break;
        case 'proxy':await toggleProxy(arg);break;
        case 'schema':await refreshSchema(arg);break;
        case 'copy-token':clipboard.writeText(token);return true;
        case 'opacity':caller.setOpacity(Math.min(1,Math.max(.45,Number(arg)||1)));break;
        case 'pin':caller.setAlwaysOnTop(!!arg,'floating');break;
        case 'click-through':caller.setIgnoreMouseEvents(!!arg,{forward:true});break;
        case 'minimize':caller.minimize();break;
        case 'close':caller.close();break;
        case 'quit':app.quit();break;
        case 'extension-folder':await require('electron').shell.openPath(app.isPackaged?path.join(process.resourcesPath,'extension'):path.join(__dirname,'..','extension'));break;
        default:throw new Error('未知操作');
      }
      publish();return {ok:true};
    }catch(e){diagnostic(e.message);return {ok:false,error:e.message};}
  });
  globalShortcut.register('Control+Alt+M',showPanels);
  if(process.argv.includes('--open-game'))launcher.webContents.once('did-finish-load',()=>openGame().catch(e=>diagnostic(e.message)));
  try{await startBridge();}catch(e){status.error=`浏览器接入端口不可用：${e.message}`;}
}).catch(e=>{dialog.showErrorBox('启动失败',e.message);app.quit();});
app.on('before-quit',event=>{
  if(quitting)return;event.preventDefault();if(closing)return;closing=true;
  (async()=>{try{await winProxy?.restore();}catch(e){dialog.showErrorBox('代理设置尚未恢复',e.message+'\n请在 Windows 设置中关闭 127.0.0.1:19222 代理，或重新打开此程序恢复。');}
    quitting=true;await injector?.close();await edge?.close();proxy?.close();bridge?.close();engine?.close();for(const model of modelEngines.values())model.close();globalShortcut.unregisterAll();app.quit();})();
});
app.on('window-all-closed',()=>app.quit());
