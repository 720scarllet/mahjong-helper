const {index, callForbiddenDiscards} = require('./state.cjs');

function simulateCall(request, pending, option) {
  const hand=[...request.hand];
  for(const t of option.consumed){
    const at=hand.indexOf(t);
    if(at<0)throw new Error('鸣牌手牌已变化');
    hand.splice(at,1);
  }
  const type=option.type===2?0:1;
  return {...request,hand,melds:[...request.melds,{type,tiles:[...option.consumed,pending.tile]}],forbiddenDiscards:callForbiddenDiscards(type,pending.tile,option.consumed),pendingCall:null};
}
function openRoute(request, row) {
  const value=new Set([31,32,33,request.roundWind,request.selfWind]);
  if(request.melds.some(m=>m.type!==0&&value.has(index(m.tiles[0]))))return '已形成役牌刻子';
  if(row.shanten===0)return row.damaUkeire>0&&row.point>0?'有役听牌':'';
  if(row.yaku&&!/无役/.test(row.yaku))return '原引擎估计存在副露役种';
  const remaining=[...request.hand];
  if(row.discard)remaining.splice(remaining.indexOf(row.discard),1);
  const ts=[...remaining,...request.melds.flatMap(m=>m.tiles)];
  if(ts.every(t=>index(t)<27&&index(t)%9>0&&index(t)%9<8))return '全手牌符合断幺九方向';
  return '';
}
async function analyzeCalls(engine, request, baseline, snap) {
  const pending=request.pendingCall;
  if(!pending||pending.expiresAt<=Date.now())return null;
  const pass=baseline.results[0];
  if(!pass)return null;
  const closed=request.melds.every(m=>m.type===2);
  const options=[{action:'pass',consumed:[],result:pass,eligible:true,reasons:[closed?'保留门清、立直和门清役机会':'保持当前手牌']}];
  for(const option of pending.options){
    if(pending.expiresAt<=Date.now())return null;
    const simulated=simulateCall(request,pending,option);
    const output=await engine.analyze(simulated);
    // Keep upstream discard ordering; require at least one legal winning wait at tenpai.
    const minShanten=Math.min(...output.results.map(r=>r.shanten));
    const row=output.results.find(r=>r.shanten===minShanten&&(r.shanten!==0||r.damaUkeire>0&&r.point>0))||output.results[0];
    const action=option.type===2?'chi':'pon',reasons=[];
    let eligible=false;
    if(!row)reasons.push('食替限制后没有可用的舍牌方案');
    else {
      const route=openRoute(simulated,row);
      const advances=row.shanten<pass.shanten;
      eligible=!!route&&(advances||!closed&&row.shanten===pass.shanten&&row.ukeire>pass.ukeire)&&row.ukeire>0&&!row.furiten;
      if(advances)reasons.push(`向听 ${pass.shanten} → ${row.shanten}`);
      else if(row.shanten===pass.shanten)reasons.push(`向听不变，进张 ${pass.ukeire} → ${row.ukeire}`);
      else reasons.push('鸣牌后向听倒退');
      reasons.push(route||'尚未确认可成立的副露役，建议保留手牌');
      if(row.shanten===0&&row.damaUkeire>0&&row.damaUkeire<row.ukeire)reasons.push(`片听：仅 ${row.damaUkeire} 枚估计有役`);
      if(closed)reasons.push('副露后失去立直与门清役机会');
      if(row.furiten)reasons.push('存在振听可能');
    }
    options.push({action,consumed:option.consumed,result:row||null,eligible,reasons});
  }
  const candidates=options.slice(1).filter(o=>o.eligible).sort((a,b)=>a.result.shanten-b.result.shanten||b.result.ukeire-a.result.ukeire||b.result.point-a.result.point);
  const chosen=candidates[0]||options[0];
  chosen.recommended=true;
  const threats=snap.seats.some((s,i)=>i!==snap.selfSeat&&s.riichi);
  return {tile:pending.tile,expiresAt:pending.expiresAt,action:chosen.action,options,warning:threats?'有他家立直；此处为进攻比较，未计算副露后的完整放铳风险':'',source:'牌效率＋副露规则'};
}
module.exports={simulateCall,analyzeCalls};
