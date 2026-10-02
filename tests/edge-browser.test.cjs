const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const {WebSocketServer}=require('ws');
const {EdgeBrowser}=require('../src/edge-browser.cjs');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,timeout=12000){
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){if(await predicate())return;await pause(25);}
  throw new Error('Timed out waiting for browser fixture');
}

test('actual Edge captures page and worker binary WebSocket sends, replies, and closes',{timeout:45000},async t=>{
  const edge='C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  try{await fs.access(edge);}catch{t.skip('Microsoft Edge is not installed');return;}
  const profile=await fs.mkdtemp(path.join(os.tmpdir(),'mahjong-edge-test-'));
  const received=[],closed=[],statuses=[];
  const server=http.createServer((req,res)=>{
    res.setHeader('Content-Type',req.url==='/worker.js'?'text/javascript':'text/html');
    const script="const socket=new WebSocket('ws://'+location.host+'/binary');socket.binaryType='arraybuffer';socket.onopen=()=>{socket.send(new Uint8Array([2,9,0,18,1,7]));socket.send('ignore this text');};socket.onmessage=event=>{if(event.data instanceof ArrayBuffer)socket.close();};";
    res.end(req.url==='/worker.js'?script:`<!doctype html><title>Edge capture fixture</title><script>${script}new Worker('/worker.js');</script>`);
  });
  const wss=new WebSocketServer({server});let requests=0;
  wss.on('connection',socket=>socket.on('message',(data,binary)=>{if(binary){requests++;socket.send(Buffer.from([3,9,0,18,1,8]));}}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=new EdgeBrowser({profileDir:profile,edgePath:edge,headless:true,onFrame:(connection,direction,buffer)=>received.push({connection,direction,bytes:[...buffer]}),onClose:connection=>closed.push(connection),onStatus:message=>statuses.push(message)});
  t.after(async()=>{
    await browser.close();for(const socket of wss.clients)socket.terminate();
    await new Promise(resolve=>wss.close(resolve));await new Promise(resolve=>server.close(resolve));
    await fs.rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:200});
  });
  await browser.open(`http://127.0.0.1:${server.address().port}/`);
  await until(()=>requests===2&&received.filter(f=>f.direction==='send').length===2&&received.filter(f=>f.direction==='receive').length===2&&closed.length===2);
  assert.equal(new Set(received.map(f=>f.connection)).size,2);
  assert.equal(new Set(closed).size,2);
  for(const frame of received)assert.deepEqual(frame.bytes,frame.direction==='send'?[2,9,0,18,1,7]:[3,9,0,18,1,8]);
  assert.equal(received.length,4,'text frames must be ignored');
  assert.equal(statuses.some(s=>s.includes('失败')),false,statuses.join('\n'));
  assert.equal(browser.ownsBrowser,true);
  const reused=new EdgeBrowser({profileDir:profile,edgePath:edge,headless:true});
  await reused.start();assert.equal(reused.ownsBrowser,false);
  await reused.close();assert.ok(await browser.endpoint(),'Detaching a reused browser must leave it running');
  const originalTarget=browser.targetId;
  await browser.open(`http://127.0.0.1:${server.address().port}/`);
  await until(()=>requests===4&&received.length===8&&closed.length===4);
  assert.equal(browser.targetId,originalTarget,'Repeated open should navigate the existing game tab');
  await browser.close();assert.equal(browser.client,null);
  await until(async()=>!(await browser.endpoint()));
});
