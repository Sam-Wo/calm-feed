// Minimal CDP helper: launch a Chromium browser with the extension, talk to targets.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch({ exe, ext, port = 9333, profile, extraArgs = [] }) {
  if (!process.env.KEEP_PROFILE) fs.rmSync(profile, { recursive: true, force: true });
  const args = [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    `--disable-extensions-except=${ext}`, `--load-extension=${ext}`,
    '--no-first-run', '--no-default-browser-check', '--window-size=1280,900', ...extraArgs, 'about:blank'
  ];
  const proc = spawn(exe, args, { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) break; } catch { /* not yet */ }
    await sleep(250);
  }
  return { proc, port };
}

async function targets(port) { return (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); }

async function extensionId(port) {
  for (let i = 0; i < 40; i++) {
    const t = (await targets(port)).find((x) => /^chrome-extension:\/\/[a-p]{32}\/src\/background\.js$/.test(x.url));
    if (t) return new URL(t.url).host;
    await sleep(250);
  }
  return null;
}

async function open(port, url) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
  return connect(t.webSocketDebuggerUrl);
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const waiting = new Map();
    const listeners = [];
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && waiting.has(msg.id)) { const { res, rej } = waiting.get(msg.id); waiting.delete(msg.id); msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result); }
      else if (msg.method) listeners.forEach((l) => l(msg));
    };
    ws.onerror = reject;
    ws.onopen = () => {
      const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; waiting.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
      const evaluate = async (expression) => {
        const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
        return r.result.value;
      };
      const shot = async (file, full = true) => {
        const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full });
        fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
      };
      resolve({ ws, send, evaluate, shot, on: (l) => listeners.push(l), close: () => ws.close() });
    };
  });
}

module.exports = { launch, targets, extensionId, open, connect, sleep };
