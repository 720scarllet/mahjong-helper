const $ = id => document.getElementById(id);
const api = window.mahjong;
const panel = new URLSearchParams(location.search).get('panel') === 'right' ? 'right' : 'left';
document.body.dataset.panel = panel;
$('panel-title').textContent = panel === 'left' ? '记牌' : '策略建议';
document.title = `雀魂助手 · ${$('panel-title').textContent}`;
$('tracker-panel').hidden = panel !== 'left';
$('strategy-panel').hidden = panel !== 'right';
document.querySelector('.hand-section').hidden = panel !== 'left';
const fallbackRegions = [
  {id:'cn',label:'国服 / 中文',url:'https://game.maj-soul.com/1/'},
  {id:'zh1',label:'国际中文服 1',url:'https://game.maj-soul.com/1/'},
  {id:'zh2',label:'国际中文服 2',url:'https://game.maj-soul.net/1/'},
  {id:'jp',label:'日服',url:'https://game.mahjongsoul.com/'},
  {id:'en',label:'国际英文服',url:'https://mahjongsoul.game.yo-star.com/'}
];
let current=null,compact=false,pinned=true;
let regions=fallbackRegions,regionSignature='',lastRegion='';
const escapeHTML = s => String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const index=t=>'mpsz'.indexOf(t[1])*9+Number(t[0]==='0'?'5':t[0])-1;
const tileName=i=>`${i%9+1}${'mpsz'[Math.floor(i/9)]}`;
const names=['东','南','西','北','白','发','中'];
const tileLabel=t=>t[1]==='z'?names[Number(t[0])-1]:`${t[0]==='0'?'赤5':t[0]}${{m:'万',p:'筒',s:'索'}[t[1]]}`;
const face=t=>t[1]==='z'?['Ton','Nan','Shaa','Pei','Haku','Hatsu','Chun'][Number(t[0])-1]:`${{m:'Man',p:'Pin',s:'Sou'}[t[1]]}${t[0]==='0'?'5-Dora':t[0]}`;
function tile(t,classes='',badge='') {
  if(!/^(?:[0-9][mps]|[1-7]z)$/.test(t))return '';
  return `<span class="tile ${t[0]==='0'?'red':''} ${classes}" title="${tileLabel(t)}" aria-label="${tileLabel(t)}"><img src="tiles/${face(t)}.svg" alt="${tileLabel(t)}">${badge?`<span class="badge">${escapeHTML(badge)}</span>`:''}</span>`;
}
function shanten(n){return n<0?'已和牌':n===0?'听牌':`${n} 向听`;}
function renderModel(s){
  const model=s.analysis?.revision===s.revision?s.analysis.model:null;
  $('model-label').textContent=s.active?`Mortal · ${s.players===3?'三麻':'四麻'}`:'Mortal';
  const a=model?.advice;
  if(!a){$('model-advice').className='model-status muted';$('model-advice').textContent=!s.active?'等待对局':s.analyzing&&!model?'模型分析中…':model?.error||'等待本人回合';return;}
  const labels={dahai:'切',reach:'立直，切',chi:'吃',pon:'碰',ankan:'暗杠',daiminkan:'明杠',kakan:'加杠',nukidora:'拔北',kita:'拔北',hora:a.target===s.selfSeat?'自摸':'荣和',ryukyoku:'九种九牌流局',none:'跳过'};
  $('model-advice').className='model-result';
  $('model-advice').innerHTML=`<div class="model-choice">${labels[a.type]||escapeHTML(a.type)} ${a.pai?tile(a.pai):''}${a.consumed?.length?`<div class="model-consumed">${a.consumed.map(t=>tile(t)).join('')}</div>`:''}</div><div class="model-meta">本地模型 · ${model.elapsedMs||0} ms</div>`;
}
function renderCalls(s){
  const pending=s.pendingCall,calls=s.analysis?.revision===s.revision?s.analysis.calls:null;
  const visible=s.active&&pending&&pending.expiresAt>Date.now();
  $('call-section').hidden=!visible;
  if(!visible)return;
  $('call-time').textContent=`${Math.max(0,Math.ceil((pending.expiresAt-Date.now())/1000))} 秒`;
  const label={pass:'跳过',chi:'吃',pon:'碰'};
  if(!calls){$('call-advice').innerHTML='<div class="empty">正在比较吃碰与跳过…</div>';return;}
  const model=s.analysis?.revision===s.revision?s.analysis.model?.advice:null;
  $('call-advice').innerHTML=`${model?'':`<div class="call-summary">牌效倾向：${label[calls.action]} ${tile(calls.tile)}</div>`}<div class="call-options">${calls.options.map(o=>`<div class="call-option ${!model&&o.recommended?'selected':''}"><div class="call-choice"><strong>${label[o.action]}</strong>${o.consumed.map(t=>tile(t)).join('')}${o.result?.discard?`<span>后切</span>${tile(o.result.discard)}`:''}</div><div class="call-metrics">${o.result?`${shanten(o.result.shanten)} · ${o.result.ukeire} 枚进张${o.result.point?` · 估计 ${o.result.point} 点`:''}`:'无合法舍牌'}</div><div class="call-reason">${o.reasons.map(escapeHTML).join('；')}</div></div>`).join('')}</div>${calls.warning?`<p class="call-warning">${escapeHTML(calls.warning)}</p>`:''}<div class="call-source">${escapeHTML(calls.source)}</div>`;
}
function renderRegions(s) {
  regions=Array.isArray(s.regions)&&s.regions.length?s.regions:fallbackRegions;
  const signature=JSON.stringify(regions);
  const region=(typeof s.region==='string'?s.region:s.region?.id)||s.currentRegion||'cn';
  const selected=$('server').value;
  if(signature!==regionSignature){
    $('server').replaceChildren(...regions.map(r=>new Option(r.label,r.id)));
    $('server').value=regions.some(r=>r.id===selected)?selected:region;
    regionSignature=signature;
  }
  if(region!==lastRegion&&regions.some(r=>r.id===region))$('server').value=region;
  lastRegion=region;
}
function render(s) {
  current=s;
  renderModel(s);
  renderCalls(s);
  renderRegions(s);
  const error=s.error||s.status.error;
  $('message').hidden=!error;$('message').textContent=error||'';
  const connected=s.active&&!error;
  $('connection-status').className=`connection ${connected?'connected':''}`;
  $('connection-status').innerHTML=`<span class="dot"></span>${connected?'对局已连接':s.status.frames?'已收到数据':'等待连接'}`;
  $('round-info').textContent=s.hand.length?`${s.players===3?'三麻':'四麻'} · ${names[s.round]}${s.dealer+1}局 · ${s.ben}本场`:'尚未进入对局';
  const self=s.seats[s.selfSeat];
  $('hand-info').textContent=self?`自风 ${names[(s.selfSeat-s.dealer+s.players)%s.players]}${self.riichi?' · 已立直':''}`:'—';
  $('wall-info').innerHTML=`牌山 <strong>${s.hand.length?s.wall:'—'}</strong>`;
  const advice=s.analysis?.revision===s.revision?s.analysis.model?.advice:null;
  const best=s.analysis?.revision===s.revision&&s.active?(['dahai','reach'].includes(advice?.type)?advice.pai:s.analysis.results[0]?.discard):'';
  const sorted=[...s.hand].sort((a,b)=>index(a)-index(b)||(a[0]==='0'?-1:1));
  $('hand').innerHTML=sorted.length?sorted.map(t=>tile(t,best&&t===best?'highlight':'')).join(''):'<span class="empty">等待手牌</span>';
  $('self-melds').innerHTML=self?self.melds.map(m=>`<div class="tile-group">${m.tiles.map(t=>tile(t)).join('')}<small>${['吃','碰','暗杠','明杠','加杠'][m.type]}</small></div>`).join('')+(self.nuki?`<div class="tile-group">${tile('4z')}<small>拔北 × ${self.nuki}</small></div>`:''):'';
  $('river-count').textContent=`${s.seats.reduce((n,p)=>n+p.river.length,0)} 张弃牌`;
  const positions=s.players===3?['自己','下家','上家']:['自己','下家','对家','上家'];
  $('rivers').innerHTML=s.selfSeat>=0?s.seats.map((_p,i)=>{
    const seat=(s.selfSeat+i)%s.players,p=s.seats[seat],wind=names[(seat-s.dealer+s.players)%s.players];
    return `<div class="river-player"><div class="river-heading"><span class="seat-name">${positions[i]} · ${wind}</span>${p.riichi?'<span class="riichi">立直</span>':''}${p.nuki?`<span class="nuki">拔北 ${p.nuki}</span>`:''}<span class="score">${p.score.toLocaleString()}</span></div><div class="river">${p.river.length?p.river.map(e=>tile(e.tile,`${e.tsumogiri?'tsumogiri':''} ${e.called?'called':''}`,e.called?'鸣':'')).join(''):'<span class="empty">—</span>'}</div>${p.melds.length?`<div class="river-melds">${p.melds.map(m=>`<div class="tile-group">${m.tiles.map(t=>tile(t)).join('')}</div>`).join('')}</div>`:''}</div>`;
  }).join(''):'<div class="empty-state"><i data-lucide="rows-3"></i><p>等待对局开始</p></div>';
  $('unseen-count').textContent=s.hand.length&&s.left.length?`${s.left.reduce((a,b)=>a+b,0)} 枚未见`:'—';
  if(s.hand.length&&s.left.length===34){
    const relevant=new Set(s.hand.map(index));
    $('unseen').innerHTML=[0,9,18,27].map(start=>`<div class="unseen-suit">${Array.from({length:start===27?7:9},(_,n)=>{
      const i=start+n,absent=s.players===3&&i>=1&&i<=7,shown=!compact||relevant.has(i);
      return `<div class="unseen-cell ${s.left[i]===0?'dead':''} ${absent||!shown?'absent':''} ${relevant.has(i)?'relevant':''}">${tile(tileName(i))}<span class="count">${s.left[i]}</span></div>`;
    }).join('')}</div>`).join('');
  }else $('unseen').innerHTML='<span class="empty">等待可见牌统计</span>';
  $('shanten').textContent=s.analysis&&s.analysis.shanten!=null&&s.analysis.revision===s.revision?shanten(s.analysis.shanten):s.analyzing?'分析中…':'—';
  let results=s.analysis?.revision===s.revision&&s.active?s.analysis.results:[];
  if(self?.riichi){
    $('recommendations').innerHTML='<div class="self-reached">已立直</div><div class="empty">等待摸牌与和牌机会</div>';
  }else if(results.length){
    const threats=s.seats.filter((p,i)=>i!==s.selfSeat&&p.riichi);
    $('recommendations').innerHTML=results.map((r,i)=>{
      const safe=r.discard&&threats.length&&threats.every(p=>p.river.some(e=>index(e.tile)===index(r.discard)));
      const risk=threats.length&&r.discard?`<span class="${safe?'':'warning'}">${safe?'对立直者均为现物':'未确认对所有立直者安全'}</span>`:'';
      const details=[r.backward?'向听倒退候选':'',r.yaku?escapeHTML(r.yaku):'',r.point?`估计打点 ${Math.round(r.point).toLocaleString()}`:'',r.furiten?'<span class="warning">存在振听可能</span>':'',risk].filter(Boolean).join(' · ');
      return `<div class="recommendation ${i===0?'best':''}"><div class="recommend-top"><span class="rank">${i+1}</span><div class="choice">${r.discard?'切 '+tile(r.discard):'有效进张'}</div><div class="metrics"><span>${shanten(r.shanten)}</span><span><strong>${r.ukeire}</strong> 枚</span></div></div>${details?`<div class="result-detail">${details}</div>`:''}<div class="waits">${Object.entries(r.waits).sort((a,b)=>index(a[0])-index(b[0])).map(([t,n])=>`<span class="wait">${tile(t)}<span>×${n}</span></span>`).join('')}</div></div>`;
    }).join('');
  }else $('recommendations').innerHTML=`<div class="empty-state"><i data-lucide="${s.analyzing?'hourglass':'scan-line'}"></i><p>${s.analyzing?'正在分析手牌':s.hand.length&&!s.active?'当前对局已结束或等待恢复':'等待有效手牌'}</p></div>`;
  $('routes').innerHTML=s.active&&s.routes.length?s.routes.map(r=>`<div class="route"><div class="route-name">${escapeHTML(r.name)}</div><div class="route-detail">${escapeHTML(r.detail).replace(/\b[1-7]z\b/g,t=>tileLabel(t))}</div></div>`).join(''):'<span class="empty">—</span>';
  $('frames').textContent=`${s.status.frames} 条消息 · ${s.status.decoded} 已解析`;
  $('account').textContent=s.account?`账号 ${s.account}`:s.selfSeat>=0?'座位已识别':'账号未识别';
  $('source').value=s.source;$('schema-version').textContent=s.status.schema;
  $('proxy').querySelector('span').textContent=s.proxy?'关闭客户端接入':'开启客户端接入';
  $('diagnostics').innerHTML=`<div>接入：${{web:'Microsoft Edge',extension:'浏览器扩展',client:'客户端'}[s.source]}</div><div>最近事件：${escapeHTML(s.status.lastMessage||'暂无')}</div><div>消息：${s.status.frames} / 已解析 ${s.status.decoded}</div>${s.log.map(e=>`<div>${escapeHTML(e.time)}　${escapeHTML(e.message)}</div>`).join('')}`;
  settingsSource();icons();
}
function icons(){window.lucide?.createIcons();}
function settingsSource(){const source=$('source').value;for(const name of ['web','extension','client'])$(name+'-settings').hidden=name!==source;}
async function command(cmd,arg,button) {
  if(!api){$('action-result').textContent='请从桌面程序打开';return;}
  if(button)button.disabled=true;
  try{const result=await api.command(cmd,arg);if(result?.error){$('action-result').textContent=result.error;$('action-result').dataset.error='true';}return result;}
  catch(e){$('action-result').textContent=e.message||'操作失败';$('action-result').dataset.error='true';return {ok:false,error:e.message};}
  finally{if(button)button.disabled=false;}
}
$('settings').onclick=()=>{$('action-result').textContent='';$('action-result').dataset.error='false';$('settings-dialog').showModal();};
$('connect').onclick=$('launcher').onclick=()=>command('launcher');
$('dismiss').onclick=()=>$('settings-dialog').close();
$('settings-form').onsubmit=e=>e.preventDefault();
$('source').onchange=async()=>{await command('source',$('source').value);settingsSource();};
$('open-game').onclick=async()=>{const url=regions.find(r=>r.id===$('server').value)?.url;const r=await command('open-game',url,$('open-game'));if(r?.ok)$('settings-dialog').close();};
$('proxy').onclick=()=>command('proxy',{mode:$('proxy-mode').value,process:$('process').value},$('proxy'));
$('refresh-schema').onclick=async()=>{const url=regions.find(r=>r.id===$('server').value)?.url;const r=await command('schema',url,$('refresh-schema'));if(r?.ok)$('action-result').textContent='协议已更新';};
$('copy-token').onclick=async()=>{const r=await command('copy-token');if(r)$('action-result').textContent='配对码已复制';};
$('extension-folder').onclick=()=>command('extension-folder');
$('opacity').oninput=e=>{$('opacity-value').textContent=`${e.target.value}%`;command('opacity',Number(e.target.value)/100);};
$('pin').onclick=()=>{pinned=!pinned;$('pin').classList.toggle('active',pinned);$('pin').setAttribute('aria-pressed',pinned);command('pin',pinned);};
$('through').onclick=()=>command('click-through',true);
$('minimize').onclick=()=>command('minimize');$('close').onclick=()=>command('close');
$('show-panels').onclick=()=>command('show-panels');$('hide-panels').onclick=()=>command('hide-panels');$('exit').onclick=()=>command('quit');
$('fit').onclick=()=>command('fit');
$('compact').onclick=()=>{compact=!compact;$('compact').classList.toggle('active',compact);$('compact').setAttribute('aria-pressed',compact);if(current)render(current);};
icons();
setInterval(()=>{if(current?.pendingCall)renderCalls(current);},500);
if(api){api.subscribe(render);api.command('state').then(render).catch(e=>{$('message').hidden=false;$('message').textContent=e.message;});}
