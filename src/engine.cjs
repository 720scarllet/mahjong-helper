const {spawn} = require('node:child_process');
const readline = require('node:readline');
class Engine {
  constructor(executable,args=[],options={}) {
    this.id=0;this.pending=new Map();this.failure='';
    this.timeout=options.timeout||20000;
    this.process=spawn(executable, args, {windowsHide:true,stdio:['pipe','pipe','pipe'],cwd:options.cwd,env:options.env||process.env});
    this.process.on('error', e=>this.fail(e.message));
    this.process.on('exit', code=>this.fail(`分析引擎已退出（${code}）`));
    this.process.stdin.on('error',e=>this.fail(e.message));
    this.process.stderr.on('data',()=>{});
    readline.createInterface({input:this.process.stdout}).on('line',line=>{
      try {const data=JSON.parse(line),p=this.pending.get(data.id);if(p){clearTimeout(p.timer);this.pending.delete(data.id);data.error?p.reject(new Error(data.error)):p.resolve(data);}}catch{}
    });
  }
  fail(message){this.failure=message;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error(message));}this.pending.clear();}
  analyze(request) {
    if(this.failure)return Promise.reject(new Error(this.failure));
    const id=++this.id;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('分析超时'));},this.timeout);
      this.pending.set(id,{resolve,reject,timer});this.process.stdin.write(JSON.stringify({...request,id})+'\n');
    });
  }
  close(){this.process.kill();}
}
module.exports={Engine};
