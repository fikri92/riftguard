import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const CHROME='/root/.hermes/tools/chromium-1208/chrome-linux64/chrome';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const servePort=8200+Math.floor(Math.random()*300);
const server=spawn(process.execPath,['serve.js','.',String(servePort)],{stdio:['ignore','pipe','pipe']});
await sleep(1200);
const profile=mkdtempSync(join(tmpdir(),'diag2-'));
const port=9600+Math.floor(Math.random()*200);
const chrome=spawn(CHROME,['--headless=new','--no-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--window-size=1280,720',`--user-data-dir=${profile}`,`--remote-debugging-port=${port}`,'about:blank'],{stdio:['ignore','pipe','pipe']});
async function target(){for(let i=0;i<200;i++){try{const r=await fetch(`http://127.0.0.1:${port}/json/list`);const j=await r.json();const p=j.find(t=>t.type==='page');if(p)return p;}catch{}await sleep(150);}throw new Error('no page');}
const page=await target(); const ws=new WebSocket(page.webSocketDebuggerUrl);
let seq=0; const pending=new Map();
ws.addEventListener('message',ev=>{const m=JSON.parse(ev.data); if(m.id!==undefined&&pending.has(m.id)){const{resolve,reject}=pending.get(m.id);pending.delete(m.id);m.error?reject(new Error(JSON.stringify(m.error))):resolve(m.result);}});
const send=(method,params={})=>{seq+=1;const id=seq;return new Promise((res,rej)=>{pending.set(id,{resolve:res,reject:rej});ws.send(JSON.stringify({id,method,params}));setTimeout(()=>{if(pending.has(id)){pending.delete(id);rej(new Error('timeout '+method));}},60000);});};
const evalJs=async e=>{const r=await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description??'threw');return r.result?.value;};
await new Promise(r=>ws.addEventListener('open',r));
await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate',{url:`http://127.0.0.1:${servePort}/game/index.html?shot=play&seed=2`});
for(let i=0;i<300;i++){if(await evalJs("document.documentElement.dataset.shotReady==='play'").catch(()=>false))break;await sleep(120);}
const out = await evalJs(`(() => {
  const g=window.__RIFTGUARD, sim=g.sim, cam=g.camera;
  const DT=1/60;
  const input={state:{keys:new Set(['KeyW']),firing:true,rightHeld:false,firedThisPress:false,pressReload:false,pressBuy:false,pressUse:false,pressSwitch:false,pressGrenade:false},takeLook(){return {x:0,y:0};},requestLock(){},release(){},dispose(){}};
  let steps=0, fired=0;
  while(steps<60*30){ sim.step(DT,input); for(const e of sim.drainEvents()) if(e.type==='shot') fired++; steps++; if(sim.match.phase==='live'&&fired>5) break; }
  g.syncBodies(0.016); g.syncBomb(); g.updateHud(0.016);
  const rows=[];
  for(const [actor,view] of g.bodies){ rows.push({name:actor.name, alive:actor.alive, vis:view.group.visible, gp:[+view.group.position.x.toFixed(1),+view.group.position.y.toFixed(1),+view.group.z!==undefined?0:0], body:[+actor.body.position.x.toFixed(1),+actor.body.position.z.toFixed(1)], parent:view.group.parent?.type||null}); }
  // place camera and project
  const alive=sim.actors.filter(a=>a.alive);
  const focus=alive.reduce((m,a)=>({x:m.x+a.body.position.x/alive.length,z:m.z+a.body.position.z/alive.length}),{x:0,z:0});
  cam.fov=60;cam.updateProjectionMatrix();
  cam.position.set(focus.x+7,3.4,focus.z+7);cam.rotation.set(0,0,0);cam.lookAt(focus.x,1.2,focus.z);
  cam.updateMatrixWorld(true);
  const proj=alive.map(a=>{const v=new g.THREE.Vector3(a.body.position.x,a.body.position.y+1.0,a.body.position.z);v.project(cam);return {n:a.name,ndc:[+v.x.toFixed(2),+v.y.toFixed(2),+v.z.toFixed(2)]};});
  return {steps,fired,phase:sim.match.phase,alive:alive.length,bodies:rows,proj,sceneChildren:g.scene.children.length};
})()`);
console.log(JSON.stringify(out,null,1));
ws.close();chrome.kill('SIGKILL');server.kill('SIGKILL');process.exit(0);
