const test = require('node:test');
const assert = require('node:assert/strict');
const {Protocol, transformAction} = require('../src/protocol.cjs');
const {GameState, index, dora, prospects} = require('../src/state.cjs');
const schema = require('../liqi.json');

function encode(protocol, name, data) {
  const type = protocol.root.lookupType(name);
  return Buffer.from(type.encode(type.fromObject(data)).finish());
}
function frame(protocol, kind, id, name, type, data) {
  const wrapper = encode(protocol, 'lq.Wrapper', {name, data:encode(protocol,type,data)});
  const prefix = Buffer.alloc(kind===1?1:3);
  prefix[0]=kind;if(kind!==1)prefix.writeUInt16LE(id,1);
  return Buffer.concat([prefix,wrapper]);
}
function actionFrame(protocol, name, data, step) {
  return frame(protocol,1,0,'.lq.ActionPrototype','lq.ActionPrototype',{
    name,step,data:transformAction(encode(protocol,`lq.${name}`,data))
  });
}
const hand13 = ['1m','9m','1p','2p','3p','4p','5p','6p','7p','2s','3s','4s','7z'];
function action(state,name,data,step) {return state.apply({name:`lq.${name}`,data,step});}
function start(players=4, hand=hand13) {
  const state=new GameState();
  state.apply({name:'.lq.FastTest.authGame',request:{account_id:100},data:{seat_list:[100,101,102,103].slice(0,players)}});
  action(state,'ActionNewRound',{tiles:hand,scores:Array(players).fill(players===3?35000:25000),doras:['9s'],left_tile_count:players===3?55:70,chang:0,ju:0,ben:0},1);
  assert.equal(state.active,true,state.error);
  return state;
}
function player(extra={}) {return {score:35000,liqiposition:-1,qipais:[],mings:[],...extra};}

test('RPC indices are scoped to connections and retain the outgoing account ID',()=>{
  const p=new Protocol(schema);
  for(const [connection,account] of [['a',101],['b',202]]) {
    assert.deepEqual(p.frame(connection,'send',frame(p,2,513,'.lq.FastTest.authGame','lq.ReqAuthGame',{account_id:account})),[]);
  }
  const a=p.frame('a','receive',frame(p,3,513,'','lq.ResAuthGame',{seat_list:[101,5,6]}))[0];
  const b=p.frame('b','receive',frame(p,3,513,'','lq.ResAuthGame',{seat_list:[7,202,8,9]}))[0];
  assert.equal(a.request.account_id,101);assert.equal(b.request.account_id,202);
  assert.deepEqual(a.data.seat_list,[101,5,6]);assert.deepEqual(b.data.seat_list,[7,202,8,9]);
  const state=new GameState();state.apply(b);assert.equal(state.account,202);assert.equal(state.selfSeat,1);
  assert.deepEqual(p.frame('a','receive',frame(p,3,513,'','lq.ResAuthGame',{})),[]);
});

test('closing a connection drops pending requests and request-ID reuse is safe',()=>{
  const p=new Protocol(schema);
  p.frame('a','send',frame(p,2,65535,'.lq.FastTest.authGame','lq.ReqAuthGame',{account_id:10}));
  p.close('a');
  assert.deepEqual(p.frame('a','receive',frame(p,3,65535,'','lq.ResAuthGame',{})),[]);
  p.frame('a','send',frame(p,2,65535,'.lq.FastTest.authGame','lq.ReqAuthGame',{account_id:20}));
  const event=p.frame('a','receive',frame(p,3,65535,'','lq.ResAuthGame',{seat_list:[20,1,2]}))[0];
  assert.equal(event.request.account_id,20);
});

test('unrelated WebSocket data and server-side requests do not create game events',()=>{
  const p=new Protocol(schema);
  assert.deepEqual(p.frame('a','receive',Buffer.from('unrelated')),[]);
  assert.deepEqual(p.frame('a','receive',frame(p,2,7,'.lq.FastTest.authGame','lq.ReqAuthGame',{account_id:20})),[]);
  assert.deepEqual(p.frame('a','receive',frame(p,3,7,'','lq.ResAuthGame',{})),[]);
  assert.throws(()=>p.frame('a','receive',Buffer.from([3,0])),/Truncated/);
});

test('live actions use the official length-dependent XOR without changing the input',()=>{
  const p=new Protocol(schema),raw=encode(p,'lq.ActionDiscardTile',{seat:2,tile:'0p',is_liqi:true});
  const saved=Buffer.from(raw),cipher=transformAction(raw);
  assert.deepEqual(raw,saved);assert.notDeepEqual(cipher,raw);assert.deepEqual(transformAction(cipher),raw);
  const event=p.frame('a','receive',actionFrame(p,'ActionDiscardTile',{seat:2,tile:'0p',is_liqi:true},42))[0];
  assert.equal(event.name,'lq.ActionDiscardTile');assert.equal(event.step,42);
  assert.equal(event.data.tile,'0p');assert.equal(event.data.is_liqi,true);
});

test('sync replays decode plain protobuf and reset the reducer before replaying old steps',()=>{
  const p=new Protocol(schema),state=start(3);
  action(state,'ActionDiscardTile',{seat:1,tile:'6s'},2);
  action(state,'ActionDiscardTile',{seat:2,tile:'8s'},3);
  p.frame('a','send',frame(p,2,10,'.lq.FastTest.syncGame','lq.ReqSyncGame',{step:3}));
  const events=p.frame('a','receive',frame(p,3,10,'','lq.ResSyncGame',{
    step:2,game_restore:{actions:[
      {name:'ActionNewRound',step:1,data:encode(p,'lq.ActionNewRound',{tiles:hand13,scores:[35000,35000,35000],doras:['9s'],left_tile_count:55})},
      {name:'ActionDiscardTile',step:2,data:encode(p,'lq.ActionDiscardTile',{seat:2,tile:'0s'})}
    ]}
  }));
  assert.equal(events.length,3);assert.equal(events[0].name,'restoreStart');
  events.forEach(e=>state.apply(e));
  assert.equal(state.active,true,state.error);assert.equal(state.step,2);
  assert.deepEqual(state.seats[1].river,[]);assert.equal(state.seats[2].river[0].tile,'0s');
});

test('snapshot restores establish the step immediately preceding their replay tail',()=>{
  const p=new Protocol(schema);
  p.frame('a','send',frame(p,2,10,'.lq.FastTest.enterGame','lq.ReqCommon',{}));
  const events=p.frame('a','receive',frame(p,3,10,'','lq.ResEnterGame',{
    step:11,game_restore:{snapshot:{hands:hand13,players:[player(),player(),player()]},actions:[
      {name:'ActionDealTile',step:11,data:encode(p,'lq.ActionDealTile',{seat:0,tile:'8p',left_tile_count:40})}
    ]}
  }));
  assert.equal(events[0].name,'restore');assert.equal(events[0].step,10);
  const state=start(3);events.forEach(e=>state.apply(e));
  assert.equal(state.active,true,state.error);assert.equal(state.hand.length,14);assert.equal(state.step,11);
});

test('finished sync responses never resurrect the game through a restore payload',()=>{
  const p=new Protocol(schema),state=start(3);
  p.frame('a','send',frame(p,2,10,'.lq.FastTest.syncGame','lq.ReqSyncGame',{}));
  const events=p.frame('a','receive',frame(p,3,10,'','lq.ResSyncGame',{
    is_end:true,game_restore:{snapshot:{hands:hand13,players:[player(),player(),player()]}}
  }));
  assert.equal(events.length,1);assert.equal(events[0].name,'.lq.FastTest.syncGame');
  state.apply(events[0]);assert.equal(state.active,false);
});

test('login and game authentication find self seat even when lobby capture was missed',()=>{
  const state=new GameState();
  state.apply({name:'.lq.Lobby.oauth2Login',data:{account_id:800}});
  state.apply({name:'.lq.FastTest.authGame',data:{seat_list:[4,5,800]}});
  assert.equal(state.players,3);assert.equal(state.selfSeat,2);
  state.apply({name:'.lq.FastTest.authGame',request:{account_id:900},data:{seat_list:[900,1,2,3]}});
  assert.equal(state.account,900);assert.equal(state.selfSeat,0);assert.equal(state.players,4);
  state.clear();assert.equal(state.selfSeat,-1);
});

test('failed authentication does not reset a valid ongoing game',()=>{
  const state=start(3),revision=state.revision;
  state.apply({name:'.lq.FastTest.authGame',request:{account_id:20},data:{error:{code:1001},seat_list:[]}});
  assert.equal(state.account,100);assert.equal(state.selfSeat,0);assert.equal(state.revision,revision);
  assert.match(state.error,/1001/);
});

test('three- and four-player games count only tiles present in that ruleset',()=>{
  for(const players of [3,4]) {
    const state=start(players),left=state.unseen();
    assert.equal(state.seats.length,players);assert.equal(left[index('1m')],3);
    assert.equal(left[index('9m')],3);assert.equal(left[index('0p')],3);
    assert.equal(left[index('9s')],3);
    assert.equal(left.reduce((a,b)=>a+b,0),(players===3?108:136)-14);
    for(let i=1;i<8;i++)assert.equal(left[i],players===3?0:4);
  }
});

test('draws and red-five discards preserve exact tile identity and unseen totals',()=>{
  const state=start(3);
  const before=state.unseen().reduce((a,b)=>a+b,0);
  action(state,'ActionDealTile',{seat:0,tile:'0p',left_tile_count:54},2);
  assert.equal(state.hand.length,14);assert.equal(state.unseen()[index('5p')],2);
  action(state,'ActionDiscardTile',{seat:0,tile:'0p',moqie:true,is_liqi:true},3);
  assert.equal(state.hand.length,13);assert.equal(state.hand.includes('5p'),true);
  assert.equal(state.seats[0].river[0].tile,'0p');assert.equal(state.seats[0].riichi,true);
  assert.equal(state.unseen().reduce((a,b)=>a+b,0),before-1);
  const hand=[...state.hand];action(state,'ActionDiscardTile',{seat:0,tile:'0p'},4);
  assert.equal(state.active,false);assert.deepEqual(state.hand,hand);
  assert.match(state.error,/手牌不同步/);
});

test('pon excludes its called river tile from unseen counts and added kan keeps red identity',()=>{
  const state=start(3,['0p','5p',...hand13.filter(t=>t!=='5p').slice(0,11)]);
  action(state,'ActionDiscardTile',{seat:1,tile:'5p'},2);
  action(state,'ActionChiPengGang',{seat:0,type:1,tiles:['0p','5p','5p'],froms:[0,0,1]},3);
  assert.equal(state.active,true,state.error);assert.equal(state.seats[1].river[0].called,true);
  assert.equal(state.unseen()[index('5p')],1);assert.equal(state.hand.length,11);
  action(state,'ActionDiscardTile',{seat:0,tile:'1m'},4);
  action(state,'ActionDealTile',{seat:0,tile:'5p',left_tile_count:53},5);
  action(state,'ActionAnGangAddGang',{seat:0,type:2,tiles:'5p'},6);
  assert.equal(state.active,true,state.error);assert.equal(state.seats[0].melds[0].type,4);
  assert.deepEqual(state.seats[0].melds[0].tiles,['0p','5p','5p','5p']);
  assert.equal(state.unseen()[index('5p')],0);assert.equal(state.hand.length,10);
});

test('open and concealed kan each account for four visible tiles',()=>{
  const extras=hand13.filter(t=>t!=='5p').slice(0,10);
  const open=start(4,['0p','5p','5p',...extras]);
  action(open,'ActionDiscardTile',{seat:3,tile:'5p'},2);
  action(open,'ActionChiPengGang',{seat:0,type:2,tiles:['0p','5p','5p','5p'],froms:[0,0,0,3]},3);
  assert.equal(open.active,true,open.error);assert.equal(open.seats[0].melds[0].type,3);
  assert.equal(open.unseen()[index('5p')],0);assert.equal(open.hand.length,10);
  const closed=start(3,['0p','5p','5p','5p',...extras.slice(0,9)]);
  action(closed,'ActionDealTile',{seat:0,tile:'2z',left_tile_count:54},2);
  action(closed,'ActionAnGangAddGang',{seat:0,type:3,tiles:'5p'},3);
  assert.equal(closed.active,true,closed.error);assert.equal(closed.seats[0].melds[0].type,2);
  assert.equal(closed.unseen()[index('5p')],0);
  assert.equal(closed.seats[0].melds[0].tiles.filter(t=>t==='0p').length,1);
  assert.equal(closed.hand.length,10);assert.equal(prospects(closed)[0].name,'立直路线');
});

test('yonma chi consumes only the caller\'s tiles and marks the exact called red five',()=>{
  const state=start(4,['4p','6p',...hand13.filter(t=>!['4p','5p','6p'].includes(t)).slice(0,10),'6z']);
  action(state,'ActionDiscardTile',{seat:3,tile:'0p'},2);
  action(state,'ActionChiPengGang',{seat:0,type:0,tiles:['4p','0p','6p'],froms:[0,3,0]},3);
  assert.equal(state.active,true,state.error);assert.equal(state.seats[3].river[0].called,true);
  assert.equal(state.hand.includes('4p'),false);assert.equal(state.hand.includes('6p'),false);
  assert.equal(state.unseen()[index('5p')],3);assert.equal(state.seats[0].melds[0].type,0);
  assert.equal(prospects(state).some(r=>r.name==='立直路线'),false);
});

test('sanma nuki counts north once and replacement draws update hand and wall',()=>{
  const state=start(3,[...hand13.slice(0,12),'4z']);
  action(state,'ActionDealTile',{seat:0,tile:'8p',left_tile_count:54},2);
  action(state,'ActionBaBei',{seat:0},3);
  assert.equal(state.seats[0].nuki,1);assert.equal(state.hand.includes('4z'),false);
  assert.equal(state.unseen()[index('4z')],3);
  action(state,'ActionDealTile',{seat:0,tile:'4z',left_tile_count:53},4);
  action(state,'ActionBaBei',{seat:0},5);
  action(state,'ActionBaBei',{seat:1},6);
  assert.equal(state.unseen()[index('4z')],1);assert.equal(state.seats[0].nuki,2);
  assert.equal(state.analysisRequest().nuki,2);assert.equal(state.wall,53);
});

test('duplicate and stale actions do not change the reducer; missing frames suspend analysis',()=>{
  const state=start(3);
  action(state,'ActionDiscardTile',{seat:1,tile:'8p'},2);
  const revision=state.revision,hand=[...state.hand];
  assert.equal(action(state,'ActionDiscardTile',{seat:1,tile:'8p'},2),false);
  assert.equal(action(state,'ActionNewRound',{tiles:hand13,scores:[35000,35000,35000]},1),false);
  assert.equal(state.revision,revision);assert.equal(state.seats[1].river.length,1);
  action(state,'ActionDealTile',{seat:0,tile:'6z'},4);
  assert.equal(state.active,false);assert.deepEqual(state.hand,hand);assert.match(state.error,/消息缺失/);
});

test('a completed round accepts a new round whose official action step restarts at one',()=>{
  const state=start(3);
  action(state,'ActionHule',{},2);
  action(state,'ActionNewRound',{tiles:hand13,scores:[36000,34000,35000],chang:0,ju:1,ben:0,doras:['9s']},1);
  assert.equal(state.active,true,state.error);assert.equal(state.dealer,1);assert.equal(state.step,1);
  assert.equal(state.analysisRequest().selfWind,index('3z'));
});

test('reconnect rebuilds open hands and calls from later-numbered seats in two passes',()=>{
  const state=start(3);
  state.apply({name:'restore',step:20,data:{hands:hand13.filter(t=>t!=='5p').slice(0,10),doras:['9s'],chang:0,ju:2,ben:1,left_tile_count:30,players:[
    player({mings:[{type:1,tile:['0p','5p','5p'],from:[0,0,2]}]}),
    player({mings:[{type:1,tile:['6s','6s','6s'],from:[2,1,1]},{type:5,tile:['4z'],from:[1]}]}),
    player({qipais:['5p*','6s!'],liqiposition:1})
  ]}});
  assert.equal(state.active,true,state.error);assert.equal(state.hand.length,10);
  assert.equal(state.seats[2].river.every(t=>t.called),true);assert.equal(state.seats[1].nuki,1);
  assert.equal(state.unseen()[index('5p')],1);assert.equal(state.unseen()[index('6s')],1);
  assert.equal(state.seats[2].riichi,true);assert.equal(state.analysisRequest().selfWind,index('2z'));
  action(state,'ActionDealTile',{seat:0,tile:'6z',left_tile_count:29},21);
  assert.equal(state.active,true,state.error);assert.equal(state.hand.length,11);
});

test('snapshot turn index never overwrites the authenticated self seat',()=>{
  const state=start(3);
  state.apply({name:'restore',step:10,data:{hands:hand13,index_player:2,players:[player(),player(),player()]}});
  assert.equal(state.active,true,state.error);assert.equal(state.selfSeat,0);
});

test('invalid call data is atomic and incomplete snapshots disable analysis',()=>{
  const state=start(3,['0p','5p',...hand13.filter(t=>t!=='5p').slice(0,11)]),before=[...state.hand];
  action(state,'ActionChiPengGang',{seat:0,type:1,tiles:['0p','5p','5p'],froms:[0,0,2]},2);
  assert.equal(state.active,false);assert.deepEqual(state.hand,before);assert.deepEqual(state.seats[0].melds,[]);
  state.apply({name:'restore',step:3,data:{hands:['1p'],players:[player(),player(),player()]}});
  assert.equal(state.active,false);assert.match(state.error,/不完整/);
});

test('consecutive self draws and malformed meld content suspend analysis before mutating state',()=>{
  const state=start(3);
  action(state,'ActionDealTile',{seat:0,tile:'6z',left_tile_count:54},2);
  const hand=[...state.hand];
  action(state,'ActionDealTile',{seat:0,tile:'5z',left_tile_count:53},3);
  assert.equal(state.active,false);assert.deepEqual(state.hand,hand);assert.equal(state.wall,54);
  assert.match(state.error,/手牌张数/);
  const pon=start(4),before=[...pon.hand];
  action(pon,'ActionChiPengGang',{seat:0,type:1,tiles:['1p','2p','3p'],froms:[0,0,1]},2);
  assert.equal(pon.active,false);assert.deepEqual(pon.hand,before);assert.match(pon.error,/副露消息/);
});

test('the reducer detects impossible visible counts, invalid sanma manzu, and yonma nuki',()=>{
  const state=start(3);
  action(state,'ActionAnGangAddGang',{seat:1,type:3,tiles:'5p'},2);
  assert.equal(state.active,false);assert.match(state.error,/统计不同步/);
  const invalid=start(3);action(invalid,'ActionDiscardTile',{seat:1,tile:'2m'},2);
  assert.equal(invalid.active,false);assert.match(invalid.error,/统计不同步/);
  const yonma=start(4);action(yonma,'ActionBaBei',{seat:1},2);
  assert.equal(yonma.active,false);assert.match(yonma.error,/拔北/);
});

test('dora cycles and seat winds respect sanma and honor wraps',()=>{
  assert.equal(dora('1m',3),'9m');assert.equal(dora('9m',3),'1m');assert.equal(dora('1m',4),'2m');
  assert.equal(dora('0p',3),'6p');assert.equal(dora('9s',4),'1s');
  assert.equal(dora('4z',3),'1z');assert.equal(dora('7z',4),'5z');
  const state=start(3);state.dealer=2;state.round=1;
  assert.equal(state.analysisRequest().selfWind,index('2z'));assert.equal(state.analysisRequest().roundWind,index('2z'));
});

test('revisions remain monotonic across reset so old analysis cannot match new state',()=>{
  const state=start(3),revision=state.revision;state.clear();assert.ok(state.revision>revision);
  assert.equal(state.active,false);assert.equal(state.selfSeat,-1);
});

test('game termination notifications stop analysis immediately',()=>{
  for(const name of ['.lq.NotifyGameTerminate','.lq.NotifyGameEndResult','.lq.FastTest.syncGame']) {
    const state=start(3);state.apply({name,data:{is_end:true}});assert.equal(state.active,false,name);
  }
});

test('ordinary rounds accept empty per-seat open-tile placeholders but reject actual open hands',()=>{
  for(const players of [3,4]){
    const state=start(players),scores=Array(players).fill(players===3?35000:25000);
    state.loadRound({tiles:hand13,scores,opens:Array.from({length:players},(_,seat)=>({seat,tiles:[],count:[]}))});
    assert.equal(state.active,true,state.error);
    state.loadRound({tiles:hand13,scores,opens:[{seat:1,tiles:['1m'],count:[1]}]});
    assert.equal(state.active,false);
    assert.match(state.error,/特殊开局/);
  }
});

function offered(state,{seat=1,tile='5p',type=3,combination=['0p|5p'],operationSeat=state.selfSeat,time_fixed=5,time_add=10,step=2,replay=false}={}) {
  return state.apply({name:'lq.ActionDiscardTile',step,replay,data:{seat,tile,operation:{seat:operationSeat,time_fixed,time_add,operation_list:[{type,combination}]}}});
}
const callHand=['0p','5p',...hand13.filter(t=>t!=='5p').slice(0,11)];

test('self-seat server pon options preserve red identity and use fixed plus added seconds',()=>{
  const state=start(3,callHand),before=Date.now();offered(state);
  const pending=state.pendingCall;
  assert.equal(state.active,true,state.error);assert.equal(pending.tile,'5p');assert.equal(pending.fromSeat,1);
  assert.deepEqual(pending.options,[{type:3,consumed:['0p','5p']}]);
  assert.ok(pending.expiresAt>=before+15000&&pending.expiresAt<=Date.now()+15000);
  assert.equal(pending.revision,state.revision);assert.equal(state.hand.length,13);
});

test('chi is restricted to the upstream player in yonma and is forbidden in sanma',()=>{
  const hand=['4p','6p',...hand13.filter(t=>!['4p','5p','6p'].includes(t)), '6z'];
  assert.equal(hand.length,13);
  const yonma=start(4,hand);offered(yonma,{seat:3,type:2,combination:['4p|6p']});
  assert.deepEqual(yonma.pendingCall.options,[{type:2,consumed:['4p','6p']}]);
  for(const [players,seat] of [[3,2],[4,1],[4,2]]) {
    const state=start(players,hand);offered(state,{seat,type:2,combination:['4p|6p']});
    assert.equal(state.pendingCall,null);assert.equal(state.active,true,state.error);
  }
  const shifted=start(4,hand);shifted.selfSeat=2;
  offered(shifted,{seat:1,type:2,combination:['4p|6p']});assert.equal(shifted.pendingCall.fromSeat,1);
});

test('call parser ignores other-seat, riichi, unsupported, and malformed options',()=>{
  const invalid=[{operationSeat:2},{type:5},{combination:['5p|5p']},{combination:['0p|0p']},
    {combination:['0p|5p|5p']},{combination:['0p,5p']},{combination:['0p|6p']},
    {combination:['0p|?p']},{combination:[null]},{combination:'0p|5p'}];
  for(const options of invalid){const state=start(3,callHand);offered(state,options);assert.equal(state.pendingCall,null,JSON.stringify(options));assert.equal(state.active,true,state.error);}
  const riichi=start(3,callHand);riichi.seats[0].riichi=true;offered(riichi);assert.equal(riichi.pendingCall,null);
  const unknown=start(3,callHand);offered(unknown,{operationSeat:0});
  assert.ok(unknown.pendingCall); // Seat zero is valid, not a missing-seat sentinel.
  const broken=start(3,callHand);
  action(broken,'ActionDiscardTile',{seat:1,tile:'5p',operation:{seat:0,operation_list:[null,{type:3,combination:['0p|5p']}] }},2);
  assert.equal(broken.active,true,broken.error);assert.equal(broken.pendingCall.options.length,1);
});

test('exact-own-tile combinations are deduplicated without losing multiple red-five choices',()=>{
  const state=start(4,['0p','5p','5p',...hand13.filter(t=>t!=='5p').slice(0,10)]);
  offered(state,{combination:['0p|5p','5p|0p','5p|5p','5p|5p']});
  assert.deepEqual(state.pendingCall.options,[{type:3,consumed:['0p','5p']},{type:3,consumed:['5p','5p']}]);
});

test('duplicate actions retain pending calls while the next accepted action clears them',()=>{
  const state=start(3,callHand);offered(state);const pending=structuredClone(state.pendingCall),revision=state.revision;
  offered(state);assert.equal(state.revision,revision);assert.deepEqual(state.pendingCall,pending);
  action(state,'ActionDealTile',{seat:2,tile:'',left_tile_count:54},3);
  assert.equal(state.active,true,state.error);assert.equal(state.pendingCall,null);
});

test('outgoing operation submissions clear calls and still retain RPC response correlation',()=>{
  const p=new Protocol(schema);
  for(const [method,type,data] of [
    ['inputChiPengGang','ReqChiPengGang',{type:3,index:1}],
    ['inputOperation','ReqSelfOperation',{cancel_operation:true}]
  ]) {
    const state=start(3,callHand);offered(state);
    const events=p.frame('game','send',frame(p,2,11,`.lq.FastTest.${method}`,`lq.${type}`,data));
    assert.equal(events.length,1);assert.equal(events[0].name,'operationSent');
    state.apply(events[0]);assert.equal(state.pendingCall,null);
    const response=p.frame('game','receive',frame(p,3,11,'','lq.ResCommon',{}))[0];
    assert.equal(response.name,`.lq.FastTest.${method}`);
    assert.equal(response.request.type,data.type||0);assert.equal(response.request.cancel_operation,data.cancel_operation||false);
  }
  assert.deepEqual(p.frame('game','send',frame(p,2,12,'.lq.FastTest.authGame','lq.ReqAuthGame',{account_id:10})),[]);
});

test('reconnect action replays never resurrect historical call timers',()=>{
  const p=new Protocol(schema),state=start(3,callHand);offered(state);
  p.frame('game','send',frame(p,2,12,'.lq.FastTest.syncGame','lq.ReqSyncGame',{}));
  const events=p.frame('game','receive',frame(p,3,12,'','lq.ResSyncGame',{step:2,game_restore:{actions:[
    {name:'ActionNewRound',step:1,data:encode(p,'lq.ActionNewRound',{tiles:callHand,scores:[35000,35000,35000],doras:['9s']})},
    {name:'ActionDiscardTile',step:2,data:encode(p,'lq.ActionDiscardTile',{seat:1,tile:'5p',operation:{seat:0,time_fixed:30,operation_list:[{type:3,combination:['0p|5p']}]}})}
  ]}}));
  assert.equal(events[2].replay,true);events.forEach(event=>state.apply(event));
  assert.equal(state.active,true,state.error);assert.equal(state.pendingCall,null);
});

test('call expiration returns a state change only after the deadline and increments revision',()=>{
  const state=start(3,callHand);offered(state,{time_fixed:0,time_add:0});
  const deadline=state.pendingCall.expiresAt,revision=state.revision;
  assert.equal(state.expireCall(deadline-1),false);assert.equal(state.revision,revision);
  assert.equal(state.expireCall(deadline),true);assert.equal(state.pendingCall,null);assert.equal(state.revision,revision+1);
  assert.equal(state.expireCall(deadline+1),false);
});

test('reset, new round, restore, game end, and dropped actions clear call state',()=>{
  const changes=[
    state=>state.clear(),
    state=>action(state,'ActionNewRound',{tiles:callHand,scores:[35000,35000,35000],ju:1},3),
    state=>state.apply({name:'restoreStart',data:{}}),
    state=>state.apply({name:'restore',step:2,data:{hands:callHand,players:[player(),player(),player()]}}),
    state=>action(state,'ActionHule',{},3),
    state=>state.apply({name:'.lq.NotifyGameTerminate',data:{}}),
    state=>action(state,'ActionDealTile',{seat:0,tile:'2z'},4)
  ];
  for(const change of changes){const state=start(3,callHand);offered(state);assert.ok(state.pendingCall);change(state);assert.equal(state.pendingCall,null);}
});

test('snapshots and analysis requests cannot mutate the live hand, melds, or pending call',()=>{
  const state=start(3,callHand);offered(state);
  for(const copy of [state.snapshot(),state.analysisRequest()]) {
    copy.hand.splice(0,1);copy.pendingCall.options[0].consumed[0]='9s';
    assert.equal(state.hand.length,13);assert.equal(state.pendingCall.options[0].consumed[0],'0p');
  }
  const open=start(3,['0p','5p',...hand13.filter(t=>t!=='5p').slice(0,11)]);
  action(open,'ActionDiscardTile',{seat:1,tile:'5p'},2);
  action(open,'ActionChiPengGang',{seat:0,type:1,tiles:['0p','5p','5p'],froms:[0,0,1]},3);
  const request=open.analysisRequest();request.melds[0].tiles[0]='9s';request.melds.push({type:1,tiles:['7z','7z','7z']});
  assert.equal(open.seats[0].melds.length,1);assert.equal(open.seats[0].melds[0].tiles[0],'0p');
});

test('live chi applies both same-tile and suji kuikae until the first self discard',()=>{
  const state=start(4,['3p','4p','2p','0p','1m','9m','1p','6p','7p','2s','3s','4s','7z']);
  action(state,'ActionDiscardTile',{seat:3,tile:'5p'},2);
  action(state,'ActionChiPengGang',{seat:0,type:0,tiles:['3p','4p','5p'],froms:[0,0,3]},3);
  assert.equal(state.active,true,state.error);
  assert.deepEqual(state.analysisRequest().forbiddenDiscards,['5p','2p']);
  for(const copy of [state.snapshot(),state.analysisRequest()]) {
    copy.forbiddenDiscards.splice(0,2);
    assert.deepEqual(state.forbiddenDiscards,['5p','2p']);
  }
  state.apply({name:'operationSent',data:{}});
  assert.deepEqual(state.forbiddenDiscards,['5p','2p']);
  action(state,'ActionDiscardTile',{seat:0,tile:'1m'},4);
  assert.deepEqual(state.analysisRequest().forbiddenDiscards,[]);
  action(state,'ActionDealTile',{seat:0,tile:'5p'},5);
  assert.deepEqual(state.analysisRequest().forbiddenDiscards,[]);
});

test('live chi restricts middle and edge calls without extending into another suit',()=>{
  for(const [called,consumed,forbidden] of [
    ['3p',['4p','5p'],['3p','6p']],
    ['4p',['3p','5p'],['4p']],
    ['1p',['2p','3p'],['1p','4p']],
    ['9p',['7p','8p'],['9p','6p']]
  ]) {
    const state=start(4,[...consumed,...[...hand13,'1s','5s'].filter(t=>!consumed.includes(t)&&t!==called).slice(0,11)]);
    action(state,'ActionDiscardTile',{seat:3,tile:called},2);
    action(state,'ActionChiPengGang',{seat:0,type:0,tiles:[...consumed,called],froms:[0,0,3]},3);
    assert.equal(state.active,true,state.error);
    assert.deepEqual(state.analysisRequest().forbiddenDiscards,forbidden);
  }
});

test('live pon normalizes red-five kuikae and new rounds clear the restriction',()=>{
  const hand=['0p','5p','5p',...hand13.filter(t=>t!=='5p').slice(0,10)],state=start(3,hand);
  action(state,'ActionDiscardTile',{seat:1,tile:'5p'},2);
  action(state,'ActionChiPengGang',{seat:0,type:1,tiles:['0p','5p','5p'],froms:[0,0,1]},3);
  assert.equal(state.hand.includes('5p'),true);
  assert.deepEqual(state.analysisRequest().forbiddenDiscards,['5p']);
  action(state,'ActionNewRound',{tiles:hand13,scores:[35000,35000,35000],ju:1},4);
  assert.deepEqual(state.analysisRequest().forbiddenDiscards,[]);
});

test('accepted riichi uses the protocol score on draws and calls and does not deduct twice',()=>{
  const p=new Protocol(schema),state=start(3),receive=(name,data,step)=>{
    const event=p.frame('game','receive',actionFrame(p,name,data,step))[0];
    state.apply(event);assert.equal(state.active,true,state.error);return event;
  };
  receive('ActionDiscardTile',{seat:1,tile:'7z',is_liqi:true},2);
  assert.equal(state.seats[1].score,35000);
  const accepted={seat:1,score:34000,liqibang:1};
  const event=receive('ActionDealTile',{seat:2,liqi:accepted},3);
  assert.equal(event.data.liqi.score,34000);assert.equal(state.seats[1].score,34000);
  assert.equal(state.apply(event),false);assert.equal(state.seats[1].score,34000);
  const callState=start(3,callHand);
  action(callState,'ActionDiscardTile',{seat:1,tile:'5p',is_liqi:true},2);
  const call=p.frame('game','receive',actionFrame(p,'ActionChiPengGang',{seat:0,type:1,tiles:['0p','5p','5p'],froms:[0,0,1],liqi:accepted},3))[0];
  callState.apply(call);assert.equal(callState.active,true,callState.error);
  assert.equal(callState.seats[0].score,35000);assert.equal(callState.seats[1].score,34000);
});

test('failed riichi leaves points intact while current full scores replace the stored scores',()=>{
  const state=start(4);
  action(state,'ActionDealTile',{seat:1,liqi:{seat:0,score:24000,failed:true}},2);
  assert.equal(state.seats[0].score,25000);
  action(state,'ActionDiscardTile',{seat:1,tile:'6s',scores:[26000,24000,25000,25000]},3);
  assert.deepEqual(state.snapshot().seats.map(p=>p.score),[26000,24000,25000,25000]);
});
