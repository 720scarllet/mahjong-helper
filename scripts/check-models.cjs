const path=require('node:path');
const assert=require('node:assert/strict');
const {Engine}=require('../src/engine.cjs');
const {toMjai}=require('../src/mjai.cjs');
async function check(players,root=path.join(__dirname,'..','vendor','mortal')){
  root=path.resolve(root);
  const dir=path.join(root,`${players}p`);
  const worker=path.join(__dirname,'mortal-worker.py');
  const engine=new Engine(path.join(root,'runtime','python.exe'),['-B','-u',worker,'--model-dir',dir],{timeout:60000,cwd:dir});
  const hand=players===3?['1m','9m','2p','3p','4p','5p','5p','6p','3s','4s','5s','7z','7z']:['2m','3m','4m','6m','7m','3p','4p','5p','5p','6s','7s','8s','7z'];
  try{
    const tehais=Array.from({length:4},()=>Array(13).fill('?'));tehais[0]=hand.map(toMjai);
    const events=[{type:'start_game',id:0},{type:'start_kyoku',bakaze:'E',dora_marker:'3p',honba:0,kyoku:1,kyotaku:0,oya:0,scores:[35000,35000,35000,players===3?0:35000],tehais},{type:'tsumo',actor:0,pai:'C'}];
    const first=await engine.analyze({players,seat:0,events});
    assert.ok(['dahai','reach','nukidora','hora'].includes(first.advice.type),JSON.stringify(first));
    const second=await engine.analyze({players,seat:0,events});
    assert.equal(second.advice.type,first.advice.type);assert.equal(second.advice.pai,first.advice.pai);
    assert.ok(second.elapsedMs<5000,'Warm CPU inference exceeds five seconds');
    return {players,action:first.advice.type,tile:first.advice.pai,firstMs:first.elapsedMs,warmMs:second.elapsedMs};
  }finally{engine.close();}
}
if(require.main===module)(async()=>{for(const players of [3,4])console.log(JSON.stringify(await check(players,process.argv[2])));})().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={check};
