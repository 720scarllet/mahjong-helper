const normalize = t => t.replace(/^0/, '5');
const index = t => 'mpsz'.indexOf(t[1]) * 9 + Number(normalize(t)[0]) - 1;
const validTile = t => typeof t === 'string' && /^(?:[0-9][mps]|[1-7]z)$/.test(t);
const tileName = i => `${i % 9 + 1}${'mpsz'[Math.floor(i / 9)]}`;
function dora(t, players) {
  const n = index(t);
  if (players === 3 && n === 0) return '9m';
  if (players === 3 && n === 8) return '1m';
  return tileName(n < 27 ? Math.floor(n / 9) * 9 + (n + 1) % 9 : n < 31 ? 27 + (n - 26) % 4 : 31 + (n - 30) % 3);
}
function newPlayer() { return {river: [], melds: [], riichi: false, nuki: 0, score: 0}; }
function validMeld(type, tiles) {
  if (!Array.isArray(tiles) || !tiles.every(validTile) || tiles.length !== (type<=1?3:4)) return false;
  const ns=tiles.map(index).sort((a,b)=>a-b);
  return type===0 ? ns[0]<27 && Math.floor(ns[0]/9)===Math.floor(ns[2]/9) && ns[1]===ns[0]+1 && ns[2]===ns[0]+2 : ns.every(n=>n===ns[0]);
}
function callForbiddenDiscards(type, calledTile, consumedTiles) {
  const called=index(calledTile),consumed=consumedTiles.map(index),forbidden=[called];
  if(type===0) {
    if(consumed.every(t=>t<called)&&called%9>=3)forbidden.push(called-3);
    if(consumed.every(t=>t>called)&&called%9<=5)forbidden.push(called+3);
  }
  return forbidden.map(tileName);
}
class GameState {
  constructor() { this.account = 0; this.selfSeat = -1; this.clear(); }
  clear() {
    this.players = 4; this.hand = []; this.seats = Array.from({length: 4}, newPlayer);
    this.indicators = []; this.wall = 0; this.round = 0; this.dealer = 0; this.ben = 0;
    this.selfSeat = -1; this.active = false; this.step = -1; this.error = ''; this.revision = (this.revision ?? -1) + 1;
    this.roundStarted = false;this.pendingCall=null;this.forbiddenDiscards=[];
  }
  remove(tile) {
    let at = this.hand.indexOf(tile);
    if (at < 0) throw new Error(`手牌不同步：找不到 ${tile}，请重新进入对局`);
    this.hand.splice(at, 1);
  }
  callOptions(d,event) {
    const operation=d.operation,self=this.seats[this.selfSeat];
    if(event.replay || !self || self.riichi || d.seat===this.selfSeat || operation?.seat!==this.selfSeat || !Array.isArray(operation.operation_list) || self.melds.length>=4 || this.hand.length+self.melds.length*3!==13)return null;
    const options=[],seen=new Set();
    for(const op of operation.operation_list) {
      if(!op||![2,3].includes(op.type)||!Array.isArray(op.combination))continue;
      if(op.type===2&&(this.players!==4||d.seat!==(this.selfSeat+3)%4))continue;
      for(const combination of op.combination) {
        if(typeof combination!=='string')continue;
        const consumed=combination.split('|');
        if(consumed.length!==2 || !consumed.every(validTile) || !validMeld(op.type===2?0:1,[...consumed,d.tile]))continue;
        const remaining=[...this.hand];let valid=true;
        for(const tile of consumed){const at=remaining.indexOf(tile);if(at<0){valid=false;break;}remaining.splice(at,1);}
        if(!valid)continue;
        const key=`${op.type}:${[...consumed].sort().join('|')}`;
        if(seen.has(key))continue;seen.add(key);options.push({type:op.type,consumed});
      }
    }
    if(!options.length)return null;
    const fixed=operation.time_fixed??0,add=operation.time_add??0,total=fixed+add;
    const seconds=Number.isInteger(fixed)&&Number.isInteger(add)&&fixed>=0&&add>=0&&total>0&&total<=120?total:15;
    return {tile:d.tile,fromSeat:d.seat,options,expiresAt:Date.now()+seconds*1000,revision:this.revision+1};
  }
  expireCall(now=Date.now()) {
    if(!this.pendingCall || now<this.pendingCall.expiresAt)return false;
    this.pendingCall=null;this.revision++;return true;
  }
  apply(event) {
    const {name, data: d} = event;
    if (d?.error?.code) { this.error = `游戏返回错误 ${d.error.code}`; return false; }
    if(name==='operationSent') {
      if(!this.pendingCall)return false;
      this.pendingCall=null;this.revision++;return true;
    }
    if (/login$/i.test(name) && d.account_id) {this.account = d.account_id; this.clear(); this.selfSeat = -1; return true;}
    if (/authGame$/.test(name)) {
      this.clear(); this.account = event.request?.account_id || this.account;
      const seatList = d.seat_list || [];
      this.selfSeat = this.account ? seatList.indexOf(this.account) : -1;
      this.players = seatList.length === 3 ? 3 : 4;
      if (this.selfSeat < 0) this.error = '尚未识别自己的座位，请从登录开始接入';
      return true;
    }
    if (name === 'restoreStart') {
      this.hand=[];this.seats=Array.from({length:this.players},newPlayer);this.indicators=[];
      this.active=false;this.step=-1;this.error='';this.roundStarted=false;this.pendingCall=null;this.forbiddenDiscards=[];this.revision++;return true;
    }
    if (name === 'restore') {
      this.pendingCall=null;
      try {
        if (!d?.hands?.length || ![3,4].includes(d.players?.length)) throw new Error('重连数据缺少手牌或玩家，请重新进入对局');
        this.loadRound({...d, tiles: d.hands, scores: d.players.map(p => p.score)}, true);
        // All rivers must exist before calls from higher-numbered seats are matched.
        d.players.forEach((p, i) => {
          this.seats[i].river = (p.qipais || []).map(t => ({tile: t.replace(/[!*]/g, ''), tsumogiri: false, called: false}));
          this.seats[i].riichi = p.liqiposition != null && p.liqiposition >= 0;
        });
        d.players.forEach((p, i) => {
          for (const m of p.mings || []) {
            if (m.tile.length === 1 && normalize(m.tile[0]) === '4z') {this.seats[i].nuki++;continue;}
            if (![0,1,2,3,4].includes(m.type) || !validMeld(m.type,m.tile) || this.players===3&&m.type===0) throw new Error('无效的重连副露');
            this.seats[i].melds.push({type:m.type,tiles:[...m.tile]});
            const called = (m.from || []).findIndex(s => s !== i);
            if (called >= 0) {
              const river = this.seats[m.from[called]]?.river;
              const tile = m.tile[called];
              const entry = river?.findLast(t => !t.called && t.tile === tile);
              if (!entry) throw new Error('重连副露对应的牌河记录缺失');
              entry.called = true;
            }
          }
        });
        const total = this.hand.length + this.seats[this.selfSeat]?.melds.length * 3;
        this.active = this.selfSeat >= 0 && [13,14].includes(total);
        if (!this.active) throw new Error('重连手牌或座位不完整，请重新进入对局');
        this.unseen();this.error='';
      } catch(e) {this.active=false;this.error=e.message;}
      this.step = event.step ?? -1; this.revision++; return true;
    }
    if (/NotifyGame(Terminate|EndResult)$/.test(name) || /(?:syncGame|enterGame)$/.test(name) && d.is_end) {
      this.active=false;this.pendingCall=null;this.forbiddenDiscards=[];this.revision++;return true;
    }
    if (!name.includes('Action')) return false;
    if (name.endsWith('ActionNewRound')) {
      const sameRound = this.roundStarted && this.round === (d.chang || 0) && this.dealer === (d.ju || 0) && this.ben === (d.ben || 0);
      if (sameRound && event.step != null && event.step <= this.step) return false;
      if (this.active && event.step != null && event.step <= this.step) return false;
      this.loadRound(d);this.step=event.step??-1;return true;
    }
    if (event.step != null && event.step <= this.step) return false;
    if (event.step != null && this.step >= 0 && event.step !== this.step + 1) {
      this.error = '对局消息缺失，等待重连恢复'; this.active=false;this.pendingCall=null; this.revision++; return true;
    }
    if (event.step != null) this.step = event.step;
    this.pendingCall=null;
    if (!this.active) return false;
    const previous = {hand:[...this.hand],seats:structuredClone(this.seats),indicators:[...this.indicators],wall:this.wall,forbiddenDiscards:[...this.forbiddenDiscards]};
    try {
      if (Array.isArray(d.doras) && d.doras.length) this.indicators = d.doras;
      if (d.left_tile_count != null) this.wall = d.left_tile_count;
      if (d.liqi && !d.liqi.failed) {
        if (!Number.isInteger(d.liqi.seat) || !this.seats[d.liqi.seat] || !Number.isInteger(d.liqi.score)) throw new Error('无效的立直分数消息');
        this.seats[d.liqi.seat].score=d.liqi.score;
      }
      if (Array.isArray(d.scores) && d.scores.length) {
        if (d.scores.length!==this.players || !d.scores.every(Number.isInteger)) throw new Error('无效的分数消息');
        d.scores.forEach((score,i)=>{this.seats[i].score=score;});
      }
      const p = this.seats[d.seat];
      if (name.endsWith('ActionDealTile')) {
        if (!p || d.seat === this.selfSeat && !validTile(d.tile)) throw new Error('无效的摸牌消息');
        if (d.seat === this.selfSeat) {this.hand.push(d.tile);this.forbiddenDiscards=[];}
      } else if (name.endsWith('ActionDiscardTile')) {
        if (!p || !validTile(d.tile)) throw new Error('无效的弃牌消息');
        if (d.seat === this.selfSeat) {this.remove(d.tile);this.forbiddenDiscards=[];}
        p.river.push({tile: d.tile, tsumogiri: !!d.moqie, called: false});
        p.riichi ||= d.is_liqi || d.is_wliqi;
        this.pendingCall=this.callOptions(d,event);
      } else if (name.endsWith('ActionChiPengGang')) {
        if (!p || ![0,1,2].includes(d.type) || !validMeld(d.type===2?3:d.type,d.tiles) || !Array.isArray(d.froms) || d.froms.length !== d.tiles.length || d.froms.filter(s=>s!==d.seat).length!==1 || this.players===3&&d.type===0) throw new Error('无效的副露消息');
        d.tiles.forEach((t, i) => {
          if (d.froms[i] === d.seat) {if (d.seat === this.selfSeat) this.remove(t);}
          else {
            const source = this.seats[d.froms[i]]?.river;
            const last = source?.findLast(e => !e.called && e.tile === t);
            if (!last) throw new Error('副露对应的牌河记录缺失');
            last.called = true;
          }
        });
        p.melds.push({type: d.type === 2 ? 3 : d.type, tiles: [...d.tiles]});
        if (d.seat === this.selfSeat) {
          const called=d.froms.findIndex(s=>s!==d.seat);
          this.forbiddenDiscards=d.type===2?[]:callForbiddenDiscards(d.type,d.tiles[called],d.tiles.filter((_,i)=>i!==called));
        }
      } else if (name.endsWith('ActionAnGangAddGang')) {
        if (!p || !validTile(d.tiles) || ![2,3].includes(d.type)) throw new Error('无效的杠牌消息');
        if (d.type === 2) {
          const meld = p.melds.find(m => m.type === 1 && normalize(m.tiles[0]) === normalize(d.tiles));
          if (!meld) throw new Error('加杠对应的碰牌缺失');
          if (d.seat === this.selfSeat) this.remove(d.tiles);
          meld.type=4;meld.tiles.push(d.tiles);
        } else if (d.type === 3) {
          const ts = Array(4).fill(d.tiles);
          if (d.seat === this.selfSeat) {
            const own = this.hand.filter(t => normalize(t) === normalize(d.tiles));
            if (own.length !== 4) throw new Error('暗杠手牌缺失');
            ts.splice(0,4,...own); own.forEach(t => this.remove(t));
          }
          p.melds.push({type: 2, tiles: ts});
        }
      } else if (/ActionBa[bB]ei$/.test(name)) {
        if (!p || this.players !== 3) throw new Error('无效的拔北消息');
        p.nuki++;if (d.seat === this.selfSeat) this.remove('4z');
      } else if (/Action(Hule|NoTile|LiuJu)$/.test(name)) {this.active=false;this.forbiddenDiscards=[];}
      else if (!/Action(Liqi|MJStart)$/.test(name)) {
        this.active=false;this.error=`暂不支持此玩法事件：${name.split('.').at(-1)}`;
      }
      if (this.active && ![13,14].includes(this.hand.length+this.seats[this.selfSeat].melds.length*3)) throw new Error('手牌张数不同步，请重新进入对局');
      this.unseen();
      this.revision++; return true;
    } catch (e) {Object.assign(this,previous);this.pendingCall=null;this.error=e.message;this.active=false;this.revision++;return true;}
  }
  loadRound(d, restoring = false) {
    this.error='';this.pendingCall=null;this.forbiddenDiscards=[];if ([3,4].includes(d.scores?.length)) this.players=d.scores.length;
    if (d.operation?.seat != null && this.selfSeat < 0) this.selfSeat = d.operation.seat;
    this.seats = Array.from({length: this.players}, (_,i) => ({...newPlayer(),score: d.scores?.[i]||0}));
    this.hand = [...(d.tiles || [])];this.indicators = d.doras?.length ? [...d.doras] : d.dora ? [d.dora] : [];
    this.wall=d.left_tile_count||0;this.round=d.chang||0;this.dealer=d.ju||0;this.ben=d.ben||0;
    this.roundStarted=true;
    this.active = this.selfSeat>=0 && this.selfSeat<this.players && (restoring || [13,14].includes(this.hand.length));
    if (!this.active) this.error='尚未识别手牌或座位，请重新登录并开始一局';
    if (d.opens?.some(o=>o.tiles?.length||o.count?.some(n=>n>0))) {this.active=false;this.error='暂不支持特殊开局玩法';}
    if (!restoring) {try {this.unseen();}catch(e){this.active=false;this.error=e.message;}}
    this.revision++;
  }
  unseen() {
    const left = Array(34).fill(4);
    if (this.players===3) left.fill(0,1,8);
    const subtract = t => {if (!validTile(t)) throw new Error(`无法解析牌 ${t}`);if (--left[index(t)]<0) throw new Error('可见牌统计不同步，请重新进入对局');};
    this.hand.forEach(subtract);this.indicators.forEach(subtract);
    this.seats.forEach(p => {
      p.river.filter(e => !e.called).forEach(e => subtract(e.tile));
      p.melds.forEach(m => m.tiles.forEach(subtract));
      for(let i=0;i<p.nuki;i++) subtract('4z');
    });
    return left;
  }
  snapshot() {
    let left=[];try {left=this.unseen();}catch(e){this.error=e.message;this.active=false;}
    return {account:this.account,selfSeat:this.selfSeat,players:this.players,hand:[...this.hand],seats:structuredClone(this.seats),indicators:[...this.indicators],wall:this.wall,round:this.round,dealer:this.dealer,ben:this.ben,active:this.active,error:this.error,left,revision:this.revision,pendingCall:structuredClone(this.pendingCall),forbiddenDiscards:[...this.forbiddenDiscards]};
  }
  analysisRequest() {
    const self=this.seats[this.selfSeat];
    return {hand:[...this.hand],melds:structuredClone(self.melds),left:this.unseen(),discards:self.river.map(e=>e.tile),dora:this.indicators.map(t=>dora(t,this.players)),players:this.players,roundWind:27+this.round,selfWind:27+(this.selfSeat-this.dealer+this.players)%this.players,wall:this.wall,nuki:self.nuki,pendingCall:structuredClone(this.pendingCall),forbiddenDiscards:[...this.forbiddenDiscards]};
  }
}
function prospects(state) {
  if (!state.hand.length || state.selfSeat<0 || !state.seats[state.selfSeat]) return [];
  const self=state.seats[state.selfSeat];const ts=[...state.hand,...self.melds.flatMap(m=>m.tiles)];
  const counts=Array(34).fill(0);state.hand.forEach(t=>counts[index(t)]++);
  const closed=self.melds.every(m=>m.type===2);const routes=[];
  if(state.players===3&&counts[30]) routes.push({name:'拔北候选',detail:'若游戏提供拔北，可换取补牌与拔北宝牌；国士路线应保留所需北牌。舍牌排序未计入拔北选择。'});
  if(closed) routes.push({name:'立直路线',detail:'保持门清，以向听数和有效进张推进'});
  const value=[31,32,33,27+state.round,27+(state.selfSeat-state.dealer+state.players)%state.players];
  const honors=[...new Set(value)].filter(t=>counts[t]>=2 || self.melds.some(m=>index(m.tiles[0])===t));
  if(honors.length) routes.push({name:'役牌路线',detail:`保留 ${honors.map(tileName).join('、')} 对子或刻子`});
  const terminals=ts.filter(t=>{const i=index(t);return i>=27||i%9===0||i%9===8}).length;
  if(terminals<=3 && self.melds.every(m=>m.tiles.every(t=>{const i=index(t);return i<27&&i%9>0&&i%9<8}))) routes.push({name:'断幺九候选',detail:`仍需处理 ${terminals} 张幺九／字牌`});
  if(closed && !self.melds.length) {
    const pairs=counts.filter(n=>n>=2).length,unique=counts.filter(n=>n>0).length;
    if(pairs>=3) routes.push({name:'七对子候选',detail:`${6-pairs+Math.max(0,7-unique)} 向听 · ${pairs} 组对子`});
    const yaochu=[0,8,9,17,18,26,27,28,29,30,31,32,33];
    const kinds=yaochu.filter(i=>counts[i]).length;
    if(kinds>=8) routes.push({name:'国士无双候选',detail:`${13-kinds-(yaochu.some(i=>counts[i]>=2)?1:0)} 向听 · ${kinds} 种幺九`});
  }
  for(const suit of 'mps') {
    const foreign=ts.filter(t=>t[1]!==suit&&t[1]!=='z').length;
    if(foreign<=3 && self.melds.every(m=>m.tiles.every(t=>t[1]===suit||t[1]==='z'))) routes.push({name:`混一色候选（${{m:'万',p:'筒',s:'索'}[suit]}）`,detail:`需处理 ${foreign} 张其他花色牌`});
  }
  return routes.slice(0,5);
}
module.exports={GameState,index,normalize,tileName,dora,prospects,callForbiddenDiscards};
