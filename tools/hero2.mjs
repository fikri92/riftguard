// Hero still: load the game's own hero shot mode (?shot=hero&seed=N), which steps to a live firefight
// and frames it, then keep the seed whose frame is the strongest.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
const CHROME='/root/.hermes/tools/chromium-1208/chrome-linux64/chrome';
const args=process.argv.slice(2);
const argOf=(n,d)=>{const i=args.indexOf(n);return i>=0?args[i+1]:d;};
const outPath=argOf('--out','screenshots/2-firefight.jpg');
const seeds=argOf('--seeds','1,2,3,4,5,6').split(',').map(Number);
const W=1280,H=720,MAX=262144;
mkdirSync(dirname(outPath),{recursive:true});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const servePort=8200+Math.floor(Math.random()*400);
const server=spawn(process.execPath,['serve.js','.',String(servePort)],{stdio:['ignore','pipe','pipe']});
await sleep(1200);
const profile=mkdtempSync(join(tmpdir(),'hero2-'));
const port=9600+Math.floor(Math.random()*300);
const chrome=spawn(CHROME,['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader',`--window-size=${W},${H}`,'--hide-scrollbars',`--user-data-dir=${profile}`,`--remote-debugging-port=${port}`,'about:blank'],{stdio:['ignore','pipe','pipe']});
async function target(){for(let i=0;i<200;i++){try{const r=await fetch(`http://127.0.0.1:${port}/json/list`);const j=await r.json();const p=j.find(t=>t.type==='page');if(p)return p;}catch{}await sleep(150);}throw new Error('no page');}
const page=await target();const ws=new WebSocket(page.webSocketDebuggerUrl);
let seq=0;const pending=new Map();const errors=[];
ws.addEventListener('message',ev=>{const m=JSON.parse(ev.data);if(m.id!==undefined&&pending.has(m.id)){const{resolve,reject}=pending.get(m.id);pending.delete(m.id);m.error?reject(new Error(JSON.stringify(m.error))):resolve(m.result);return;}if(m.method==='Runtime.exceptionThrown')errors.push('[exception] '+(m.params.exceptionDetails.exception?.description??m.params.exceptionDetails.text));});
const send=(method,params={})=>{seq+=1;const id=seq;return new Promise((res,rej)=>{pending.set(id,{resolve:res,reject:rej});ws.send(JSON.stringify({id,method,params}));setTimeout(()=>{if(pending.has(id)){pending.delete(id);rej(new Error('timeout '+method));}},90000);});};
const evalJs=async e=>{const r=await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description??'threw');return r.result?.value;};
await new Promise(r=>ws.addEventListener('open',r));
await send('Runtime.enable');await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride',{width:W,height:H,deviceScaleFactor:1,mobile:false});
const base=`http://127.0.0.1:${servePort}/game/index.html`;
const cands=[];
for(const seed of seeds){
  await send('Page.navigate',{url:`${base}?shot=hero&seed=${seed}`});
  let ok=false;
  for(let i=0;i<400;i++){ok=await evalJs(`document.documentElement.dataset.shotReady === 'hero'`).catch(()=>false);if(ok)break;await sleep(120);}
  if(!ok){cands.push({seed,ok:false});continue;}
  await sleep(900);
  const info=await evalJs('window.__HERO_INFO || null').catch(()=>null);
  const s=await send('Page.captureScreenshot',{format:'jpeg',quality:94,captureBeyondViewport:false});
  const bytes=Buffer.from(s.data,'base64');
  cands.push({seed,ok:true,bytes:bytes.length,info,data:bytes.toString('base64')});
}
ws.close();chrome.kill('SIGKILL');server.kill('SIGKILL');
const good=cands.filter(c=>c.ok);
if(!good.length){console.log(JSON.stringify({ok:false,cands},null,1));process.exit(1);}
const score=c=>{const f=c.info||{};const pd=f.pairDist??99;return Math.max(0,50-Math.abs(pd-7)*4)+(f.fired??0)*0.3+((f.pair)?15:0);};
good.sort((a,b)=>score(b)-score(a));
const best=good[0];
writeFileSync(outPath,Buffer.from(best.data,'base64'));
console.log(JSON.stringify({ok:true,out:outPath,bytes:best.bytes,seed:best.seed,score:+score(best).toFixed(1),picked:best.info,all:cands.map(c=>({seed:c.seed,ok:c.ok,bytes:c.bytes,pairDist:c.info?.pairDist,fired:c.info?.fired,pair:c.info?.pair})),errors:errors.slice(0,5)},null,1));
process.exit(best.bytes<=MAX?0:1);
