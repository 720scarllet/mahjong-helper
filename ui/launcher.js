'use strict';
const $=id=>document.getElementById(id);
const api=window.mahjong;
const fallbackRegions=[
  {id:'cn',label:'国服 / 中文',url:'https://game.maj-soul.com/1/'},
  {id:'zh1',label:'国际中文服 1',url:'https://game.maj-soul.com/1/'},
  {id:'zh2',label:'国际中文服 2',url:'https://game.maj-soul.net/1/'},
  {id:'jp',label:'日服',url:'https://game.mahjongsoul.com/'},
  {id:'en',label:'国际英文服',url:'https://mahjongsoul.game.yo-star.com/'}
];
let regions=fallbackRegions,signature='',lastRegion='',lastSource='',lastNetwork='';

function sourceSelection(){
  const client=$('start-source').value==='client';
  $('region-field').hidden=client;
  $('network-field').hidden=client;
  $('launch').querySelector('span').textContent=client?'显示悬浮窗':'打开游戏';
  $('source-help').textContent=client?'显示双窗后，点齿轮开启客户端接入。':'打开专用 Edge 窗口，登录后进入对局。';
}
function render(s){
  regions=Array.isArray(s.regions)&&s.regions.length?s.regions:fallbackRegions;
  const nextSignature=JSON.stringify(regions);
  const region=(typeof s.region==='string'?s.region:s.region?.id)||s.currentRegion||'cn';
  if(signature!==nextSignature){
    const chosen=$('region').value;
    $('region').replaceChildren(...regions.map(r=>new Option(r.label,r.id)));
    $('region').value=regions.some(r=>r.id===chosen)?chosen:region;
    signature=nextSignature;
  }
  if(lastRegion!==region&&regions.some(r=>r.id===region))$('region').value=region;
  lastRegion=region;
  if(s.currentNetwork&&lastNetwork!==s.currentNetwork){$('network').value=s.currentNetwork;lastNetwork=s.currentNetwork;}
  if(lastSource!==s.source){$('start-source').value=s.source==='client'?'client':'web';lastSource=s.source;sourceSelection();}
  const error=s.error||s.status?.error;
  $('status').dataset.state=error?'error':s.active?'connected':'idle';
  $('status-text').textContent=error?'连接异常':s.active?`${s.players===3?'三麻':'四麻'}对局已连接`:s.status?.frames?'已收到游戏数据':'等待连接';
  if(error)showResult(error);
}
function showResult(message){$('result').hidden=!message;$('result').textContent=message||'';}
async function command(name,arg){
  if(!api){showResult('请从桌面程序打开');return {ok:false};}
  try{const result=await api.command(name,arg);if(result?.error)showResult(result.error);return result;}
  catch(error){showResult(error.message||'操作失败');return {ok:false};}
}
$('start-source').onchange=sourceSelection;
$('launch-form').onsubmit=async event=>{
  event.preventDefault();
  $('launch').disabled=true;
  showResult('');
  try{
    const source=$('start-source').value;
    const changed=await command('source',source);
    if(changed?.ok===false)return;
    if(source==='client')await command('show-panels');
    else{
      const url=regions.find(r=>r.id===$('region').value)?.url;
      const opened=await command('open-game',{url,network:$('network').value});
      if(opened?.ok!==false)await command('show-panels');
    }
  }finally{$('launch').disabled=false;}
};
$('show-panels').onclick=()=>command('show-panels');
$('hide-panels').onclick=()=>command('hide-panels');
$('minimize').onclick=()=>command('minimize');
$('close').onclick=()=>command('close');
$('quit').onclick=()=>command('quit');
window.lucide?.createIcons();
sourceSelection();
if(api){api.subscribe(render);api.command('state').then(render).catch(error=>showResult(error.message));}
