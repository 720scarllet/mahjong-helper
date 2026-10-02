const test=require('node:test');
const assert=require('node:assert/strict');
const {GameState}=require('../src/state.cjs');
const {MjaiHistory,toMjai,fromMjai,validateAdvice}=require('../src/mjai.cjs');
function setup(players=4){
  const state=new GameState(),history=new MjaiHistory();state.selfSeat=0;
  const data={tiles:['1m','9m','1p','2p','3p','4p','5p','6p','7p','2s','3s','4s','7z'],scores:Array(players).fill(35000),doras:['9s'],left_tile_count:50,chang:0,ju:1,ben:0};
  const event={name:'lq.ActionNewRound',data,step:0};state.apply(event);history.apply(event,state.snapshot());
  const send=(name,data)=>{const before=state.snapshot(),event={name:`lq.${name}`,data,step:state.step+1};state.apply(event);assert.equal(state.active,true,state.error);history.apply(event,state.snapshot(),before);};
  return {state,history,send};
}
test('mjai converters preserve red fives and honor identities',()=>{
  for(const t of ['0m','0p','0s','1z','2z','3z','4z','5z','6z','7z','9m','2s'])assert.equal(fromMjai(toMjai(t)),t);
});
test('sanma start events hide all opponent tiles and pad the native library shape',()=>{
  const {state,history}=setup(3);const start=history.events[1];
  assert.equal(start.tehais.length,4);assert.equal(start.scores.length,4);assert.equal(start.scores[3],0);
  assert.equal(start.tehais[1].every(t=>t==='?'),true);assert.equal(start.tehais[0].length,13);
  assert.deepEqual(history.events.at(-1),{type:'tsumo',actor:1,pai:'?'});assert.equal(history.request(state.snapshot()),null);
});
test('riichi declaration and acceptance have correct order before following draw',()=>{
  const {history,send}=setup();send('ActionDiscardTile',{seat:1,tile:'3z',is_liqi:true,moqie:true});
  assert.deepEqual(history.events.slice(-2),[{type:'reach',actor:1},{type:'dahai',actor:1,pai:'W',tsumogiri:true}]);
  send('ActionDealTile',{seat:2,tile:''});assert.deepEqual(history.events.slice(-2),[{type:'reach_accepted',actor:1},{type:'tsumo',actor:2,pai:'?'}]);
});
test('pon history uses actual called position and model requests are immutable',()=>{
  const {state,history,send}=setup();send('ActionDiscardTile',{seat:1,tile:'0p'});
  send('ActionChiPengGang',{seat:2,type:1,tiles:['5p','0p','5p'],froms:[2,1,2]});
  assert.deepEqual(history.events.at(-1),{type:'pon',actor:2,target:1,pai:'5pr',consumed:['5p','5p']});
  send('ActionDealTile',{seat:0,tile:'8s',operation:{seat:0,operation_list:[{type:1}]}});
  const req=history.request(state.snapshot());req.events[1].tehais[0].pop();assert.equal(history.events[1].tehais[0].length,13);
});
test('snapshot reconnect cannot invent the missing event order for Mortal',()=>{
  const {state,history}=setup();history.apply({name:'restore',data:{}},state.snapshot());
  assert.equal(history.request(state.snapshot()),null);assert.match(history.error,/重连/);
});
test('model decisions must match server operations, exact red tiles and target',()=>{
  const {state}=setup();state.hand=['3m','0m','5m',...state.hand.slice(3)];
  const snap=state.snapshot(),op={list:[{type:2,combination:['3m|0m']}],tile:'4m',fromSeat:3,expiresAt:Date.now()+50000};
  assert.deepEqual(validateAdvice({type:'chi',actor:0,target:3,pai:'4m',consumed:['3m','5mr']},snap,op).consumed,['3m','0m']);
  assert.throws(()=>validateAdvice({type:'chi',actor:0,target:3,pai:'4m',consumed:['3m','5m']},snap,op),/组合/);
  assert.throws(()=>validateAdvice({type:'chi',actor:0,target:1,pai:'4m',consumed:['3m','5mr']},snap,op),/目标/);
  assert.equal(validateAdvice({type:'none'},snap,op).type,'none');
});
test('expired operations and unavailable riichi discards never render as model advice',()=>{
  const {state}=setup();const snap=state.snapshot();
  const op={list:[{type:1},{type:7,combination:['1m']}],expiresAt:Date.now()+50000};
  assert.throws(()=>validateAdvice({type:'reach',actor:0,pai:'9m'},snap,op),/立直舍牌/);
  assert.throws(()=>validateAdvice({type:'dahai',actor:0,pai:'8p'},snap,op),/不在手牌/);
  assert.equal(validateAdvice({type:'dahai',actor:0,pai:'1m'},snap,{...op,expiresAt:0}),null);
});

function operation(list,extra={}){return {list,expiresAt:Date.now()+50000,...extra};}
test('ankan requires an exact legal four-tile group present in hand',()=>{
  const snap=setup().state.snapshot();snap.hand=['0p','5p','5p','5p',...snap.hand.slice(4)];
  const op=operation([{type:4,combination:['0p|5p|5p|5p']}],{tile:'5p',fromSeat:0});
  const advice={type:'ankan',actor:0,consumed:['5p','5pr','5p','5p']};
  assert.deepEqual(validateAdvice(advice,snap,op).consumed,['5p','0p','5p','5p']);
  assert.throws(()=>validateAdvice({...advice,consumed:['5p','5p','5p','5p']},snap,op),/暗杠组合/);
  assert.throws(()=>validateAdvice(advice,{...snap,hand:snap.hand.slice(1)},op),/不在手牌/);
  assert.throws(()=>validateAdvice({...advice,consumed:['5p','5pr','5p']},snap,op),/暗杠组合/);
});
test('kakan requires the exact pon meld and actual added tile',()=>{
  const snap=setup().state.snapshot();snap.hand=['0p',...snap.hand.filter(t=>t!=='5p')];
  snap.seats[0].melds=[{type:1,tiles:['5p','5p','5p']}];
  const op=operation([{type:6,combination:['5p|5p|5p']}],{tile:'0p',fromSeat:0});
  const advice={type:'kakan',actor:0,pai:'5pr',consumed:['5p','5p','5p']};
  assert.equal(validateAdvice(advice,snap,op).pai,'0p');
  assert.throws(()=>validateAdvice({...advice,pai:'5p'},snap,op),/不在手牌/);
  assert.throws(()=>validateAdvice(advice,{...snap,seats:snap.seats.map(s=>({...s,melds:[]}))},op),/碰牌缺失/);
  const wrongRed={...advice,consumed:['5pr','5p','5p']};
  assert.throws(()=>validateAdvice(wrongRed,snap,operation([{type:6,combination:['0p|5p|5p']}],{fromSeat:0})),/碰牌缺失/);
});
test('hora validates tsumo and ron targets and derives tiles omitted by native policy',()=>{
  const snap=setup().state.snapshot();
  const tsumo=operation([{type:8}],{tile:'7z',fromSeat:0});
  assert.equal(validateAdvice({type:'hora',actor:0,target:0},snap,tsumo).pai,'7z');
  assert.throws(()=>validateAdvice({type:'hora',actor:0,target:0,pai:'E'},snap,tsumo),/牌张/);
  assert.throws(()=>validateAdvice({type:'hora',actor:0,target:0},snap,{...tsumo,fromSeat:1}),/自摸目标/);
  const ron=operation([{type:9}],{tile:'0p',fromSeat:2});
  assert.equal(validateAdvice({type:'hora',actor:0,target:2},snap,ron).pai,'0p');
  assert.throws(()=>validateAdvice({type:'hora',actor:0,target:1},snap,ron),/荣和目标/);
  assert.throws(()=>validateAdvice({type:'hora',actor:0,target:2,pai:'5p'},snap,ron),/牌张/);
});
test('nukidora requires sanma, a north in hand and no other tile',()=>{
  const snap=setup(3).state.snapshot();snap.hand[0]='4z';
  const op=operation([{type:11}],{fromSeat:0});
  assert.equal(validateAdvice({type:'nukidora',actor:0},snap,op).pai,'4z');
  assert.equal(validateAdvice({type:'kita',actor:0,pai:'N'},snap,op).pai,'4z');
  assert.throws(()=>validateAdvice({type:'nukidora',actor:0,pai:'E'},snap,op),/拔北/);
  assert.throws(()=>validateAdvice({type:'nukidora',actor:0},{...snap,players:4},op),/拔北/);
  assert.throws(()=>validateAdvice({type:'nukidora',actor:0},{...snap,hand:snap.hand.slice(1)},op),/拔北/);
});
test('none is only accepted for an optional response to another player',()=>{
  const snap=setup().state.snapshot();
  assert.equal(validateAdvice({type:'none'},snap,operation([{type:9}],{fromSeat:2})).type,'none');
  for(const op of [operation([{type:9}],{fromSeat:0}),operation([{type:9}],{fromSeat:4}),operation([{type:1},{type:3}],{fromSeat:2}),operation([{type:4}],{fromSeat:0})])assert.throws(()=>validateAdvice({type:'none'},snap,op),/不能跳过/);
  assert.throws(()=>validateAdvice({type:'dahai',pai:'1m'},snap,operation([{type:1}])),/本人座位/);
});
test('discard advice respects server kuikae and exact current riichi draw',()=>{
  const snap=setup().state.snapshot();snap.hand=['0p','5p','1m',...snap.hand.slice(3)];
  const blocked=operation([{type:1,combination:['5p']}],{tile:'1m',fromSeat:0});
  for(const pai of ['5p','5pr'])assert.throws(()=>validateAdvice({type:'dahai',actor:0,pai},snap,blocked),/食替/);
  assert.equal(validateAdvice({type:'dahai',actor:0,pai:'1m'},snap,blocked).pai,'1m');
  assert.throws(()=>validateAdvice({type:'dahai',actor:0,pai:'1m'}, {...snap,forbiddenDiscards:['1m']},operation([{type:1}])),/食替/);
  snap.seats[0].riichi=true;
  const op=operation([{type:1}],{tile:'0p',fromSeat:0});
  assert.equal(validateAdvice({type:'dahai',actor:0,pai:'5pr',tsumogiri:true},snap,op).pai,'0p');
  assert.throws(()=>validateAdvice({type:'dahai',actor:0,pai:'5p',tsumogiri:true},snap,op),/摸切/);
  assert.throws(()=>validateAdvice({type:'dahai',actor:0,pai:'5pr',tsumogiri:false},snap,op),/摸切/);
});
test('history records initial dealer draw and chankan tile for win validation',()=>{
  const {state,history}=setup();
  const data={tiles:[...state.hand,'7z'],scores:[25000,25000,25000,25000],doras:['9s'],ju:0,operation:{seat:0,operation_list:[{type:1},{type:8}]}};
  const event={name:'lq.ActionNewRound',data};state.apply(event);history.apply(event,state.snapshot());
  assert.equal(history.operation.fromSeat,0);assert.equal(history.operation.tile,'7z');
  assert.equal(validateAdvice({type:'hora',actor:0,target:0},state.snapshot(),history.operation).pai,'7z');
  const before=state.snapshot();before.seats[2].melds=[{type:1,tiles:['5p','5p','5p']}];
  history.apply({name:'lq.ActionAnGangAddGang',data:{seat:2,type:2,tiles:'0p',operation:{seat:0,operation_list:[{type:9}]}}},state.snapshot(),before);
  assert.equal(history.operation.tile,'0p');assert.equal(history.operation.fromSeat,2);
  assert.equal(validateAdvice({type:'hora',actor:0,target:2},state.snapshot(),history.operation).pai,'0p');
});
