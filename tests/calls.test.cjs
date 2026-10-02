const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {Engine}=require('../src/engine.cjs');
const {index}=require('../src/state.cjs');
const {simulateCall,analyzeCalls}=require('../src/calls.cjs');
const engine=new Engine(path.join(__dirname,'..','bin','overlay-engine.exe'));
test.after(()=>engine.close());
function request(hand,tile,options,players=4,melds=[]){
  const left=Array(34).fill(4);if(players===3)left.fill(0,1,8);
  for(const t of [...hand,tile,...melds.flatMap(m=>m.tiles)])left[index(t)]--;
  return {hand,melds,left,discards:[],dora:[],players,roundWind:27,selfWind:28,wall:40,nuki:0,pendingCall:{tile,options,expiresAt:Date.now()+60000}};
}
const snap={selfSeat:0,seats:Array.from({length:4},()=>({riichi:false}))};
test('yakuhai pon advances the hand with legal, real-engine post-call discard',async()=>{
  const req=request(['2p','3p','4p','2s','3s','4s','6s','7s','7z','7z','5z','5z','9m'],'5z',[{type:3,consumed:['5z','5z']}],3);
  const baseline=await engine.analyze(req),calls=await analyzeCalls(engine,req,baseline,snap);
  assert.equal(calls.action,'pon');assert.equal(calls.options[1].result.discard,'9m');
  assert.equal(calls.options[1].result.shanten,0);assert.ok(calls.options[1].result.damaUkeire>0);
  assert.match(calls.options[1].reasons.join(' '),/役牌/);
  assert.deepEqual(req.hand.slice(-3),['5z','5z','9m']);
});
test('chi making no-yaku tenpai recommends pass even when it is faster',async()=>{
  const req=request(['1m','2m','2p','3p','4p','2s','3s','4s','6s','7s','7z','7z','9m'],'3m',[{type:2,consumed:['1m','2m']}]);
  const calls=await analyzeCalls(engine,req,await engine.analyze(req),snap);
  assert.equal(calls.action,'pass');assert.equal(calls.options[1].result.shanten,0);
  assert.equal(calls.options[1].result.damaUkeire,0);
});
test('call simulation preserves exact red consumption and visible tile counts',()=>{
  const req=request(['3m','0m','5m','6m','7m','8m','2p','3p','4p','5s','6s','7s','5z'],'4m',[{type:2,consumed:['3m','0m']}]);
  const before=structuredClone(req),sim=simulateCall(req,req.pendingCall,req.pendingCall.options[0]);
  assert.equal(sim.hand.includes('0m'),false);assert.equal(sim.hand.includes('5m'),true);
  assert.deepEqual(sim.melds[0].tiles,['3m','0m','4m']);assert.deepEqual(sim.left,req.left);assert.deepEqual(req,before);
});
test('kuikae filters normalized red fives and suji before engine result limits',async()=>{
  const req=request(['3m','4m','0m','5m','7m','8m','2p','3p','4p','5s','6s','7s','5z'],'5m',[{type:2,consumed:['3m','4m']}]);
  const sim=simulateCall(req,req.pendingCall,req.pendingCall.options[0]);
  assert.deepEqual(sim.forbiddenDiscards,['5m','2m']);
  const output=await engine.analyze(sim);
  assert.ok(output.results.length>0);assert.equal(output.results.some(r=>['5m','0m','2m'].includes(r.discard)),false);
});
test('expired reaction produces no call suggestion',async()=>{
  const req=request(['2p','3p','4p','2s','3s','4s','6s','7s','7z','7z','5z','5z','9m'],'5z',[{type:3,consumed:['5z','5z']}],3);
  req.pendingCall.expiresAt=Date.now()-1;
  assert.equal(await analyzeCalls(engine,req,{},snap),null);
});
