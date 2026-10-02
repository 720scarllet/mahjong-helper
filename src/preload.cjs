const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('mahjong',{
  command:(cmd,arg)=>ipcRenderer.invoke('command',cmd,arg),
  subscribe:callback=>{const listener=(_e,state)=>callback(state);ipcRenderer.on('state',listener);return()=>ipcRenderer.removeListener('state',listener);}
});
