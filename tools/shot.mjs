// A tiny CDP driver: launch Chrome, open a page, collect console + page errors, wait for a condition,
// screenshot. Uses Node's built-in WebSocket so no dependency is needed.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/root/.hermes/tools/chromium-1208/chrome-linux64/chrome';
const url = process.argv[2];
const outPng = process.argv[3];
const waitExpr = process.argv[4] ?? 'window.__RIFTGUARD_READY__ === true';
const timeoutMs = Number(process.argv[5] ?? 60000);

const profile = mkdtempSync(join(tmpdir(), 'cdp-'));
const port = 9300 + Math.floor(Math.random() * 400);
const args = [
  '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu-sandbox',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--window-size=1280,720', '--hide-scrollbars', `--user-data-dir=${profile}`,
  `--remote-debugging-port=${port}`, 'about:blank',
];
const chrome = spawn(CHROME, args, { stdio: ['ignore', 'pipe', 'pipe'] });
let chromeErr = '';
chrome.stderr.on('data', (d) => { chromeErr += d.toString(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      const j = await r.json();
      if (j.length > 0) return j;
    } catch { /* not up yet */ }
    await sleep(120);
  }
  throw new Error('chrome did not expose a target: ' + chromeErr.slice(-600));
}

const list = await targets();
const page = list.find((t) => t.type === 'page') ?? list[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const logs = [];

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    logs.push(`[${msg.params.type}] ` + msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    logs.push('[exception] ' + (d.exception?.description ?? d.text));
  }
  if (msg.method === 'Log.entryAdded') {
    logs.push(`[log:${msg.params.entry.level}] ${msg.params.entry.text}`);
  }
});

function send(method, params = {}) {
  id += 1;
  const myId = id;
  return new Promise((resolve, reject) => {
    pending.set(myId, { resolve, reject });
    ws.send(JSON.stringify({ id: myId, method, params }));
    setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); reject(new Error('timeout ' + method)); } }, 120000);
  });
}

await new Promise((resolve) => ws.addEventListener('open', resolve));
await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });

await send('Page.navigate', { url });

const deadline = Date.now() + timeoutMs;
let ok = false;
while (Date.now() < deadline) {
  const r = await send('Runtime.evaluate', { expression: waitExpr, returnByValue: true, awaitPromise: true });
  if (r.result?.value === true) { ok = true; break; }
  await sleep(200);
}

const info = await send('Runtime.evaluate', {
  expression: `(() => {
    const c = document.querySelector('#game canvas');
    const gl = c && (c.getContext('webgl2') || c.getContext('webgl'));
    return JSON.stringify({
      ready: !!window.__RIFTGUARD_READY__,
      shot: document.documentElement.dataset.shotReady ?? null,
      canvas: c ? [c.width, c.height] : null,
      gl: gl ? gl.getParameter(gl.VERSION) : null,
    });
  })()`,
  returnByValue: true,
});
console.log('STATE ' + info.result.value);

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
writeFileSync(outPng, Buffer.from(shot.data, 'base64'));
console.log('SHOT ' + outPng + ' bytes=' + Buffer.from(shot.data, 'base64').length);
console.log('WAIT_OK ' + ok);
console.log('--- console ---');
for (const l of logs) console.log(l);
ws.close();
chrome.kill('SIGKILL');
process.exit(ok ? 0 : 3);
