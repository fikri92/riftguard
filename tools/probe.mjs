// A CDP probe: open a page, wait for readiness, then evaluate an arbitrary expression and print the
// JSON it returns. Used to inspect the live scene instead of guessing from pixels.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/root/.hermes/tools/chromium-1208/chrome-linux64/chrome';
const url = process.argv[2];
const expr = process.argv[3] ?? '1';
const timeoutMs = Number(process.argv[4] ?? 90000);

const profile = mkdtempSync(join(tmpdir(), 'cdp-'));
const port = 9700 + Math.floor(Math.random() * 300);
const args = [
  '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu-sandbox',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--window-size=1280,720', '--hide-scrollbars', `--user-data-dir=${profile}`,
  `--remote-debugging-port=${port}`, 'about:blank',
];
const chrome = spawn(CHROME, args, { stdio: ['ignore', 'pipe', 'pipe'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  for (let i = 0; i < 120; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      const j = await r.json();
      if (j.length > 0) return j;
    } catch { /* not up yet */ }
    await sleep(120);
  }
  throw new Error('chrome did not expose a target');
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
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    logs.push('[exception] ' + (d.exception?.description ?? d.text));
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
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });

const deadline = Date.now() + timeoutMs;
while (Date.now() < deadline) {
  const r = await send('Runtime.evaluate', { expression: 'window.__RIFTGUARD_READY__ === true', returnByValue: true });
  if (r.result?.value === true) break;
  await sleep(200);
}

const out = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
console.log(JSON.stringify(out.result?.value ?? out, null, 2));
for (const l of logs) console.log(l);
ws.close();
chrome.kill('SIGKILL');
process.exit(0);
