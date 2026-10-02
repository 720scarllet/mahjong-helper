const test=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const readline=require('node:readline');
const path=require('node:path');
const {performance}=require('node:perf_hooks');
const {index}=require('../src/state.cjs');
const engine=spawn(path.join(__dirname,'..','bin','overlay-engine.exe'),[],{windowsHide:true,stdio:['pipe','pipe','pipe']});
const pending=new Map();let id=0;
readline.createInterface({input:engine.stdout}).on('line',line=>{
  const result=JSON.parse(line),job=pending.get(result.id);
  if(job){clearTimeout(job.timer);pending.delete(result.id);job.resolve({...result,elapsed:performance.now()-job.start});}
});
engine.on('error',e=>{for(const job of pending.values()){clearTimeout(job.timer);job.reject(e);}pending.clear();});
test.after(()=>engine.kill());
function analyze(request){
  const requestID=++id;
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(requestID);reject(new Error('Engine response timed out after 10 seconds'));},10000);
    pending.set(requestID,{resolve,reject,timer,start:performance.now()});
    engine.stdin.write(JSON.stringify({...request,id:requestID})+'\n');
  });
}
function req(hand,players=4,melds=[],extra={}){
  const left=Array(34).fill(4);if(players===3)left.fill(0,1,8);
  for(const tile of [...hand,...melds.flatMap(m=>m.tiles),...(extra.discards||[])])left[index(tile)]--;
  if(extra.nuki)left[index('4z')]-=extra.nuki;
  return {hand,players,melds,left,roundWind:27,selfWind:28,wall:50,nuki:0,...extra};
}
function validate(output,input){
  assert.equal(output.error,undefined,output.error);
  assert.ok(output.results.length<=8);
  for(const row of output.results){
    assert.equal(typeof row.shanten,'number');assert.ok(Number.isFinite(row.point));
    assert.equal(row.ukeire,Object.values(row.waits).reduce((a,b)=>a+b,0));
    if(row.discard)assert.ok(input.hand.includes(row.discard),`Discard ${row.discard} is absent from hand`);
    for(const [tile,count] of Object.entries(row.waits)){
      assert.ok(count>0&&count<=4);assert.equal(count,input.left[index(tile)]);
      if(input.players===3)assert.ok(!/^[2-8]m$/.test(tile));
    }
  }
}
const yonma=['2m','3m','4m','6m','7m','3p','4p','5p','5p','6s','7s','8s','7z','7z'];
const sanma=['1m','9m','2p','3p','4p','5p','5p','6p','3s','4s','5s','7z','7z','4z'];
const terminals=['1m','9m','1p','9p','1s','9s','1z','2z','3z','4z','5z','6z','7z'];

test('real yonma executable returns the known tenpai discard and weighted waits',async()=>{
  const input=req(yonma),output=await analyze(input);validate(output,input);
  assert.equal(output.shanten,0);assert.equal(output.results[0].discard,'5p');
  assert.deepEqual(output.results[0].waits,{'5m':4,'8m':4});assert.equal(output.results[0].ukeire,8);
  assert.ok(output.elapsed<10000);
});

test('real sanma executable analyzes 14 and 13 tiles without suggesting absent manzu',async()=>{
  for(const hand of [sanma,sanma.slice(0,13)]){
    const input=req(hand,3),output=await analyze(input);validate(output,input);
    assert.equal(output.shanten,2);assert.ok(output.results.length>0);
    if(hand.length===13)assert.equal(output.results[0].discard,'');
  }
});

test('13 tile tenpai lists waits without inventing a discard',async()=>{
  const hand=[...yonma];hand.splice(hand.indexOf('5p'),1);
  const input=req(hand),output=await analyze(input);validate(output,input);
  assert.equal(output.shanten,0);assert.equal(output.results.length,1);assert.equal(output.results[0].discard,'');
  assert.deepEqual(output.results[0].waits,{'5m':4,'8m':4});
});

test('open pon and all kan types produce valid advice with a reduced concealed hand',async()=>{
  const hand=['2p','3p','4p','2s','3s','4s','6s','7s','7z','7z','9m'];
  for(const type of [1,2,3,4]){
    const input=req(hand,3,[{type,tiles:Array(type===1?3:4).fill('5z')}]);
    const output=await analyze(input);validate(output,input);
    assert.equal(output.shanten,0);assert.equal(output.results[0].discard,'9m');
    assert.deepEqual(output.results[0].waits,{'5s':4,'8s':4});
    if(type!==2)assert.ok(!output.results[0].yaku.includes('立直'));
  }
});

test('chi tiles may arrive in called-tile order rather than numeric order',async()=>{
  const hand=['2p','3p','4p','2s','3s','4s','6s','7s','7z','7z','9m'];
  const input=req(hand,4,[{type:0,tiles:['3m','1m','2m']}]);
  const output=await analyze(input);validate(output,input);assert.equal(output.results[0].discard,'9m');
});

test('ordinary and kokushi agari return no discard advice',async()=>{
  const hands=[['1m','1m','1m','2p','3p','4p','5s','6s','7s','7p','8p','9p','5z','5z'],[...terminals,'1m'],['1p','1p','2p','2p','3p','3p','4p','4p','5p','5p','6p','6p','7p','7p']];
  for(const hand of hands){const output=await analyze(req(hand,3));assert.equal(output.error,undefined);assert.equal(output.shanten,-1);assert.deepEqual(output.results,[]);}
});

test('kokushi 13-sided tenpai has 39 available tiles and observes exhausted waits and furiten',async()=>{
  const input=req(terminals,3),output=await analyze(input);validate(output,input);
  assert.equal(output.shanten,0);assert.equal(output.results[0].ukeire,39);
  assert.equal(Object.keys(output.results[0].waits).length,13);assert.match(output.results[0].yaku,/国士无双/);
  const furiten=req(terminals,3,[],{discards:['9m']});furiten.left[index('9m')]=0;
  const blocked=await analyze(furiten);validate(blocked,furiten);
  assert.equal(blocked.results[0].furiten,true);assert.equal(blocked.results[0].waits['9m'],undefined);
});

test('kokushi fourteen-tile hand removes only its non-terminal spare tile',async()=>{
  const input=req([...terminals,'6p'],3),output=await analyze(input);validate(output,input);
  assert.equal(output.shanten,0);assert.equal(output.results.length,1);assert.equal(output.results[0].discard,'6p');
  assert.equal(output.results[0].ukeire,39);
});

test('red-only five discards preserve the actual 0p identity',async()=>{
  const hand=['2m','3m','4m','6m','7m','2s','3s','4s','6s','7s','8s','7z','7z','0p'];
  const input=req(hand),output=await analyze(input);validate(output,input);
  assert.equal(output.shanten,0);assert.equal(output.results[0].discard,'0p');
});

test('discarding a normal five does not remove a red five already in a meld',async()=>{
  const hand=['2s','3s','4s','6s','7s','7z','7z','5p'];
  const input=req(hand,3,[{type:1,tiles:['0p','5p','5p']},{type:1,tiles:['5z','5z','5z']}]);
  const output=await analyze(input);validate(output,input);
  assert.equal(output.results[0].discard,'5p');assert.match(output.results[0].yaku,/宝牌1/);
  assert.ok(output.results[0].point>0);
});

test('kokushi with one missing terminal and an existing pair has a single four-tile wait',async()=>{
  const hand=terminals.map(t=>t==='7z'?'1m':t);
  const input=req(hand,3),output=await analyze(input);validate(output,input);
  assert.equal(output.shanten,0);assert.deepEqual(output.results[0].waits,{'7z':4});
  assert.equal(output.results[0].ukeire,4);
});

test('equally distant normal and kokushi routes combine distinct improving tiles',async()=>{
  const hand=['1m','1m','1m','1m','9m','9m','9m','1p','9p','1s','9s','1z','2z'];
  const input=req(hand,3),output=await analyze(input);validate(output,input);
  assert.equal(output.shanten,4);assert.match(output.results[0].yaku,/国士无双/);
  assert.equal(output.results[0].waits['3z'],4);assert.equal(output.results[0].waits['2p'],4);
});

test('one-shanten improvement tiles are not labeled as present-tense furiten',async()=>{
  const input=req(yonma),output=await analyze(input);validate(output,input);
  assert.ok(output.results.some(r=>r.shanten===1&&r.backward));
  assert.equal(output.results.filter(r=>r.shanten>0).some(r=>r.furiten),false);
});

test('invalid tiles, hand sizes, and unseen counts are rejected without killing the process',async()=>{
  const bad=[];
  for(const tile of ['0z','8z','10p','?s'])bad.push({...req(yonma),hand:[tile,...yonma.slice(1)]});
  bad.push({...req(sanma,3),hand:['2m',...sanma.slice(1)]});
  bad.push({...req(yonma),hand:yonma.slice(0,12)});
  for(const count of [-1,5]){const input=req(yonma);input.left[0]=count;bad.push(input);}
  const visible=req(yonma);visible.left[index('7z')]=4;bad.push(visible);
  const forbidden=req(sanma,3);forbidden.left[index('2m')]=1;bad.push(forbidden);
  bad.push({...req(yonma),nuki:1});
  const nuki=req(sanma,3,[],{nuki:4});nuki.left[index('4z')]=0;bad.push(nuki);
  for(const input of bad){const output=await analyze(input);assert.ok(output.error);assert.deepEqual(output.results,[]);}
  const valid=req(yonma),output=await analyze(valid);validate(output,valid);
});

test('sanma extracted norths contribute dora and are checked against visible north counts',async()=>{
  const hand=['2p','3p','4p','5p','6p','7p','2s','3s','4s','6s','7s','7z','7z'];
  const input=req(hand,3,[],{nuki:2}),output=await analyze(input);validate(output,input);
  assert.equal(output.shanten,0);assert.match(output.results[0].yaku,/宝牌2/);
});

test('empty wall and exhausted unseen tiles still return finite JSON numbers',async()=>{
  const input=req(yonma,4,[],{wall:0,left:Array(34).fill(0)}),output=await analyze(input);validate(output,input);
  assert.equal(output.shanten,0);assert.equal(output.results[0].ukeire,0);
});
