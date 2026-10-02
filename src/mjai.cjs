const {index,normalize}=require('./state.cjs');
const honors=['E','S','W','N','P','F','C'];
const toMjai=t=>t[1]==='z'?honors[Number(t[0])-1]:t[0]==='0'?`5${t[1]}r`:t||'?';
const fromMjai=t=>honors.includes(t)?`${honors.indexOf(t)+1}z`:/^5[mps]r$/.test(t)?`0${t[1]}`:t;
const validTile=t=>typeof t==='string'&&/^(?:[0-9][mps]|[1-7]z)$/.test(t);
const tileKey=tiles=>[...tiles].sort().join('|');
class MjaiHistory {
  constructor(){this.reset();}
  reset(reason='等待下一局开始'){this.events=[];this.operation=null;this.pendingReach=null;this.indicators=[];this.error=reason;}
  apply(event,snap,before){
    const {name,data:d}=event;
    if(name==='operationSent'){this.operation=null;return;}
    if(name.startsWith('restore')||/authGame$|login$/i.test(name)){this.reset('重连后等待下一局，牌效率仍可用');return;}
    if(name.endsWith('ActionNewRound')){
      this.reset('');
      if(!snap.active)return;
      const hand=[...d.tiles].sort((a,b)=>index(a)-index(b)||(a[0]==='0'?-1:1));
      const draw=hand.length===14?hand.pop():null;
      const tehais=Array.from({length:4},()=>Array(13).fill('?'));tehais[snap.selfSeat]=hand.map(toMjai);
      const scores=[...d.scores];if(scores.length===3)scores.push(0);
      this.indicators=d.doras?.length?[...d.doras]:[d.dora];
      this.events=[{type:'start_game',id:snap.selfSeat},{type:'start_kyoku',bakaze:honors[d.chang||0],dora_marker:toMjai(this.indicators[0]),honba:d.ben||0,kyoku:(d.ju||0)+1,kyotaku:d.liqibang||0,oya:d.ju||0,scores,tehais},{type:'tsumo',actor:d.ju||0,pai:draw?toMjai(draw):'?'}];
    }else if(name.includes('Action')&&this.events.length){
      if(!snap.active){this.operation=null;return;}
      if(this.pendingReach!=null&&!name.endsWith('ActionHule')){this.events.push({type:'reach_accepted',actor:this.pendingReach});this.pendingReach=null;}
      if(d.doras?.length>this.indicators.length){
        for(const t of d.doras.slice(this.indicators.length))this.events.push({type:'dora',dora_marker:toMjai(t)});
        this.indicators=[...d.doras];
      }
      const actor=d.seat;
      if(name.endsWith('ActionDealTile'))this.events.push({type:'tsumo',actor,pai:d.tile?toMjai(d.tile):'?'});
      else if(name.endsWith('ActionDiscardTile')){
        if(d.is_liqi||d.is_wliqi){this.events.push({type:'reach',actor});this.pendingReach=actor;}
        this.events.push({type:'dahai',actor,pai:toMjai(d.tile),tsumogiri:!!d.moqie});
      }else if(name.endsWith('ActionChiPengGang')){
        const called=d.froms.findIndex(s=>s!==actor);
        this.events.push({type:['chi','pon','daiminkan'][d.type],actor,target:d.froms[called],pai:toMjai(d.tiles[called]),consumed:d.tiles.filter((_,i)=>i!==called).map(toMjai)});
      }else if(name.endsWith('ActionAnGangAddGang')){
        if(d.type===3){
          let tiles=actor===snap.selfSeat?before.hand.filter(t=>normalize(t)===normalize(d.tiles)):Array(4).fill(normalize(d.tiles));
          if(actor!==snap.selfSeat&&d.tiles[1]!=='z'&&normalize(d.tiles)[0]==='5')tiles[0]=`0${d.tiles[1]}`;
          this.events.push({type:'ankan',actor,consumed:tiles.map(toMjai)});
        }else{
          const meld=before.seats[actor].melds.find(m=>m.type===1&&normalize(m.tiles[0])===normalize(d.tiles));
          if(!meld){this.reset('加杠事件不完整');return;}
          this.events.push({type:'kakan',actor,pai:toMjai(d.tiles),consumed:meld.tiles.map(toMjai)});
        }
      }else if(/ActionBa[bB]ei$/.test(name))this.events.push({type:'nukidora',actor,pai:'N'});
      else if(!/Action(Liqi|MJStart)$/.test(name)){this.reset('模型暂不支持此事件');return;}
    }else return;
    if(this.events.length>500){this.reset('局内事件数量异常');return;}
    const op=d.operation;
    const seconds=(op?.time_add||0)+(op?.time_fixed||0);
    const start=name.endsWith('ActionNewRound');
    const tile=start?fromMjai(this.events.at(-1)?.pai||''):d.tile||(typeof d.tiles==='string'?d.tiles:undefined);
    this.operation=!event.replay&&op?.seat===snap.selfSeat&&op.operation_list?.length?{list:structuredClone(op.operation_list),tile,fromSeat:start?snap.dealer:d.seat,expiresAt:Date.now()+(seconds>0?Math.min(120,seconds):15)*1000}:null;
  }
  request(snap){return this.events.length&&!this.error&&this.operation&&this.operation.expiresAt>Date.now()?{players:snap.players,seat:snap.selfSeat,events:structuredClone(this.events)}:null;}
}
function validateAdvice(advice,snap,operation){
  if(!operation||operation.expiresAt<=Date.now()||!advice||!snap.active)return null;
  if(!Array.isArray(operation.list)||!Array.isArray(advice.consumed||[]))throw new Error('模型动作格式不合法');
  const list=operation.list.filter(o=>o&&Number.isInteger(o.type)),types=new Set(list.map(o=>o.type));
  const a={...advice,pai:fromMjai(advice.pai||''),consumed:(advice.consumed||[]).map(fromMjai)};
  if(a.actor!=null&&a.actor!==snap.selfSeat)throw new Error('模型返回其他座位动作');
  const response=Number.isInteger(operation.fromSeat)&&operation.fromSeat>=0&&operation.fromSeat<snap.players&&operation.fromSeat!==snap.selfSeat;
  if(a.type==='none'){if(!response||types.has(1)||![2,3,5,9].some(t=>types.has(t)))throw new Error('当前不能跳过');return a;}
  if(a.actor!==snap.selfSeat)throw new Error('模型动作缺少本人座位');
  const code={dahai:1,chi:2,pon:3,ankan:4,daiminkan:5,kakan:6,reach:7,nukidora:11,kita:11,ryukyoku:10}[a.type]||(a.type==='hora'?(a.target===snap.selfSeat?8:9):0);
  if(!code||!types.has(code))throw new Error('模型动作不在游戏允许的选项中');
  const matchesCombination=tiles=>list.filter(o=>o.type===code).some(o=>Array.isArray(o.combination)&&o.combination.some(c=>typeof c==='string'&&tileKey(c.split('|'))===tileKey(tiles)));
  const hasTiles=tiles=>{const remaining=[...snap.hand];for(const t of tiles){const at=remaining.indexOf(t);if(at<0)return false;remaining.splice(at,1);}return true;};
  const self=snap.seats[snap.selfSeat];
  if(a.type==='dahai'||a.type==='reach'){
    if(!snap.hand.includes(a.pai))throw new Error('模型建议的牌不在手牌中');
    const forbidden=[...(snap.forbiddenDiscards||[]),...list.filter(o=>o.type===1).flatMap(o=>Array.isArray(o.combination)?o.combination.flatMap(c=>typeof c==='string'?c.split('|'):[]):[])];
    if(forbidden.some(t=>validTile(t)&&normalize(t)===normalize(a.pai)))throw new Error('模型建议的舍牌违反食替限制');
    if((a.tsumogiri||self.riichi)&&(a.pai!==operation.tile||self.riichi&&a.tsumogiri!==true))throw new Error('模型摸切建议与当前摸牌不同步');
    if(a.type==='reach'){
      if(!list.filter(o=>o.type===7).some(o=>o.combination?.some(c=>typeof c==='string'&&c.split('|').includes(a.pai))))throw new Error('模型立直舍牌不合法');
    }
  }
  if(['chi','pon','daiminkan'].includes(a.type)){
    if(!response||a.pai!==operation.tile||a.target!==operation.fromSeat)throw new Error('模型鸣牌目标不同步');
    if(a.type==='chi'&&(snap.players!==4||a.target!==(snap.selfSeat+3)%4))throw new Error('模型吃牌座位不合法');
    if(a.consumed.length!==(a.type==='daiminkan'?3:2)||!a.consumed.every(validTile)||!matchesCombination(a.consumed))throw new Error('模型鸣牌组合不合法');
    if(!hasTiles(a.consumed))throw new Error('模型鸣牌消耗牌不在手牌中');
  }
  if(a.type==='ankan'){
    if(a.consumed.length!==4||!a.consumed.every(validTile)||!a.consumed.every(t=>normalize(t)===normalize(a.consumed[0]))||!matchesCombination(a.consumed))throw new Error('模型暗杠组合不合法');
    if(!hasTiles(a.consumed))throw new Error('模型暗杠消耗牌不在手牌中');
  }
  if(a.type==='kakan'){
    if(!validTile(a.pai)||a.consumed.length!==3||!a.consumed.every(t=>validTile(t)&&normalize(t)===normalize(a.pai))||!matchesCombination(a.consumed))throw new Error('模型加杠组合不合法');
    if(!self.melds.some(m=>m.type===1&&tileKey(m.tiles)===tileKey(a.consumed)))throw new Error('模型加杠对应的碰牌缺失');
    if(!snap.hand.includes(a.pai))throw new Error('模型加杠牌不在手牌中');
  }
  if(a.type==='hora'){
    if(a.target===snap.selfSeat){
      if(operation.fromSeat!==snap.selfSeat||!snap.hand.includes(operation.tile))throw new Error('模型自摸目标不同步');
    }else if(!response||a.target!==operation.fromSeat)throw new Error('模型荣和目标不同步');
    if(!validTile(operation.tile)||a.pai&&a.pai!==operation.tile)throw new Error('模型和牌牌张不同步');
    a.pai=operation.tile;
  }
  if(a.type==='nukidora'||a.type==='kita'){
    if(snap.players!==3||a.pai&&a.pai!=='4z'||!snap.hand.includes('4z'))throw new Error('模型拔北牌不合法');
    a.pai='4z';
  }
  return a;
}
module.exports={MjaiHistory,toMjai,fromMjai,validateAdvice};
