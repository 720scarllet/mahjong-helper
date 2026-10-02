const fs=require('node:fs/promises');
const path=require('node:path');
const {spawn}=require('node:child_process');
const CDP=require('chrome-remote-interface');

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function bounded(promise,ms,message){
  let timer;
  return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(message)),ms);})]).finally(()=>clearTimeout(timer));
}
class EdgeBrowser {
  constructor({profileDir,onFrame=()=>{},onClose=()=>{},onStatus=()=>{},edgePath,headless=false,startupTimeout=18000,proxyMode='system'}={}) {
    if(!profileDir||!path.isAbsolute(profileDir))throw new Error('Edge profileDir must be an absolute path');
    this.profileDir=profileDir;this.onFrame=onFrame;this.onClose=onClose;this.onStatus=onStatus;
    this.edgePath=edgePath;this.headless=headless;this.startupTimeout=startupTimeout;
    this.proxyMode=proxyMode;
    this.client=null;this.child=null;this.ownsBrowser=false;this.closing=false;
    this.sessions=new Map();this.targets=new Map();this.connections=new Map();this.targetId=null;
    this.starting=null;this.opening=Promise.resolve();
  }
  async executable() {
    const candidates=[this.edgePath,
      path.join(process.env['PROGRAMFILES(X86)']||'C:\\Program Files (x86)','Microsoft','Edge','Application','msedge.exe'),
      path.join(process.env.PROGRAMFILES||'C:\\Program Files','Microsoft','Edge','Application','msedge.exe'),
      process.env.LOCALAPPDATA&&path.join(process.env.LOCALAPPDATA,'Microsoft','Edge','Application','msedge.exe')].filter(Boolean);
    for(const candidate of candidates){try{await fs.access(candidate);return candidate;}catch{}}
    throw new Error('没有找到 Microsoft Edge，请先安装 Edge');
  }
  async endpoint() {
    try {
      const data=await fs.readFile(path.join(this.profileDir,'DevToolsActivePort'),'utf8');
      const [portLine,browserPath]=data.trim().split(/\r?\n/),port=Number(portLine);
      if(!Number.isInteger(port)||port<1||port>65535||!/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(browserPath))return null;
      const response=await fetch(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(600)});
      if(!response.ok)return null;
      const info=await response.json(),url=new URL(info.webSocketDebuggerUrl);
      if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||Number(url.port)!==port||url.pathname!==browserPath)return null;
      return `ws://127.0.0.1:${port}${browserPath}`;
    }catch{return null;}
  }
  async start() {
    if(this.client)return;
    if(this.starting)return this.starting;
    this.starting=this.startInner().finally(()=>{this.starting=null;});
    return this.starting;
  }
  async startInner() {
    this.closing=false;await fs.mkdir(this.profileDir,{recursive:true});
    let endpoint=await this.endpoint();
    if(!endpoint) {
      const executable=await this.executable();
      const args=[`--user-data-dir=${this.profileDir}`,'--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--no-first-run','--no-default-browser-check','--disable-features=msEdgeFirstRunExperience','--new-window'];
      if(this.proxyMode==='direct')args.push('--no-proxy-server');
      if(this.headless)args.push('--headless=new','--disable-gpu');
      args.push('about:blank');
      this.child=spawn(executable,args,{windowsHide:true,stdio:'ignore'});this.ownsBrowser=true;
      let startupError;
      this.child.once('error',e=>{startupError=e;});
      const deadline=Date.now()+this.startupTimeout;
      while(!endpoint&&Date.now()<deadline&&!this.closing) {
        if(startupError)throw new Error(`Edge 启动失败：${startupError.message}`);
        endpoint=await this.endpoint();if(!endpoint)await pause(100);
      }
      if(this.closing)throw new Error('Edge 接入已取消');
      if(!endpoint)throw new Error('Edge 接入超时，请关闭工具专用的 Edge 窗口后重试');
    }
    this.client=await bounded(CDP({target:endpoint,local:true}),6000,'Edge 调试连接超时');
    this.client.on('event',event=>this.handleEvent(event));
    this.client.on('disconnect',()=>{
      this.dropConnections();this.client=null;this.sessions.clear();this.targets.clear();this.targetId=null;
      if(!this.closing)this.onStatus('Edge 游戏窗口已关闭，等待重新打开');
    });
    await this.client.Target.setAutoAttach({autoAttach:true,waitForDebuggerOnStart:true,flatten:true});
    this.onStatus('Edge 数据接入已连接');
  }
  handleEvent({method,params,sessionId}) {
    if(method==='Target.attachedToTarget') {
      const id=params.sessionId,info=params.targetInfo;
      this.sessions.set(id,info.targetId);
      const ready=this.enableSession(id,info.type);
      this.targets.set(info.targetId,{sessionId:id,ready});
      ready.catch(()=>{if(!this.closing)this.onStatus('Edge 页面接入失败，请重新打开游戏窗口');});
      return;
    }
    if(method==='Target.detachedFromTarget') {
      const id=params.sessionId,target=this.sessions.get(id);
      this.dropConnections(id);this.sessions.delete(id);
      if(this.targets.get(target)?.sessionId===id)this.targets.delete(target);
      if(target===this.targetId)this.targetId=null;
      return;
    }
    if(!sessionId||!this.sessions.has(sessionId))return;
    if(method==='Network.webSocketClosed') {
      const connection=`edge:${sessionId}:${params.requestId}`;
      if(this.connections.delete(connection))this.onClose(connection);
    }else if(method==='Network.webSocketFrameSent'||method==='Network.webSocketFrameReceived') {
      if(params.response.opcode!==2)return;
      const connection=`edge:${sessionId}:${params.requestId}`;
      this.connections.set(connection,sessionId);
      this.onFrame(connection,method.endsWith('Sent')?'send':'receive',Buffer.from(params.response.payloadData,'base64'));
    }
  }
  async enableSession(sessionId,type) {
    const client=this.client;
    try {
      if(['page','iframe','worker','shared_worker','service_worker'].includes(type)) {
        await client.send('Network.enable',{},sessionId);
        await client.send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:true,flatten:true},sessionId).catch(()=>{});
      }
    }finally {
      await client.send('Runtime.runIfWaitingForDebugger',{},sessionId).catch(()=>{});
    }
  }
  async pageSession(targetId) {
    const deadline=Date.now()+6000;
    while(Date.now()<deadline&&!this.closing) {
      const target=this.targets.get(targetId);
      if(target){await target.ready;return target.sessionId;}
      await pause(25);
    }
    throw new Error('Edge 页面接入超时');
  }
  async open(url) {
    const action=this.opening.catch(()=>{}).then(async()=>{
      try {
        await this.start();
        if(!this.targetId) {
          const {targetInfos}=await this.client.Target.getTargets();
          const existing=targetInfos.find(t=>t.type==='page'&&t.url===url&&this.targets.has(t.targetId));
          const blank=targetInfos.find(t=>t.type==='page'&&t.url==='about:blank'&&this.targets.has(t.targetId));
          this.targetId=existing?.targetId||blank?.targetId||(await this.client.Target.createTarget({url:'about:blank'})).targetId;
        }
        const session=await this.pageSession(this.targetId);
        const result=await bounded(this.client.send('Page.navigate',{url},session),45000,'游戏网站响应超时，请检查网络后重试');
        if(result.errorText)throw new Error(`Edge 页面加载失败：${result.errorText}`);
        await this.client.Target.activateTarget({targetId:this.targetId});
        return {targetId:this.targetId};
      }catch(e) {
        await this.close();throw e;
      }
    });
    this.opening=action;return action;
  }
  dropConnections(sessionId) {
    for(const [connection,session] of this.connections) {
      if(sessionId&&session!==sessionId)continue;
      this.connections.delete(connection);this.onClose(connection);
    }
  }
  async fit(bounds) {
    if(!this.client||!this.targetId)return;
    const {windowId}=await this.client.Browser.getWindowForTarget({targetId:this.targetId});
    await this.client.Browser.setWindowBounds({windowId,bounds:{windowState:'normal'}});
    await this.client.Browser.setWindowBounds({windowId,bounds});
  }
  async close() {
    this.closing=true;
    const client=this.client;this.client=null;
    if(client) {
      if(this.ownsBrowser)await bounded(client.Browser.close(),2500,'Edge shutdown timeout').catch(()=>{});
      else await bounded(client.Target.setAutoAttach({autoAttach:false,waitForDebuggerOnStart:false,flatten:true}),2000,'Edge detach timeout').catch(()=>{});
      await bounded(client.close(),1500,'Edge disconnect timeout').catch(()=>{});
    }else if(this.ownsBrowser&&this.child&&this.child.exitCode===null)this.child.kill();
    this.dropConnections();this.sessions.clear();this.targets.clear();this.targetId=null;
    this.child=null;this.ownsBrowser=false;
  }
}
module.exports={EdgeBrowser};
