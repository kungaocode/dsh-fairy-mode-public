/** Explicit paid integration probe through index.js and its real HTTP routes. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { apply } from '../index.js';

if (!process.argv.includes('--live')) {
  console.log('No API called. Run with --live to use your local Qwen config.');
  process.exit(0);
}
const routes = new Map(), dispose = [];
const ctx = {
  effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') dispose.push(cleanup); return cleanup; },
  on() {}, emit() {}, inject() {}, get() {},
  logger: { info() {}, warn() {} },
  systemPrompt: { section: () => () => {}, getSectionOrder: () => 0 },
  webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); } },
};
apply(ctx);
const server = createServer((req, res) => {
  const handler = routes.get(new URL(req.url, 'http://localhost').pathname);
  if (!handler) { res.writeHead(404); res.end(); return; }
  Promise.resolve(handler(req, res)).catch(() => { res.writeHead(500); res.end('Integration route failed'); });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
const headers = { 'content-type': 'application/json', 'X-Fairy-Request': '1' };
let started = false;
try {
  const status = await (await fetch(base + '/hdd-engine')).json();
  assert.equal(status.provider, 'qwen-realtime', 'Configure Qwen before running this probe');
  const start = await fetch(base + '/hdd-engine?action=start', { method: 'POST', headers, body: '{}' });
  assert.equal((await start.json()).state, 'ready');
  started = true;
  const begin = Date.now();
  const response = await fetch(base + '/hdd-speak', { method: 'POST', headers,
    body: JSON.stringify({ text: '主人，我在。查询目标已确认，我会为您整理线索，并保留每一条情报的来源。' }) });
  assert.equal(response.status, 200, 'Speech route returned ' + await (response.ok ? Promise.resolve('audio') : response.text()));
  const audio = Buffer.from(await response.arrayBuffer());
  assert.equal(audio.toString('ascii', 0, 4), 'RIFF');
  assert.equal(audio.readUInt32LE(24), 24000);
  assert.ok(audio.length > 4800);
  // Normal integration checks never retain speech on disk. Export only on request.
  const destination = process.argv.includes('--save-audio')
    ? new URL('../local-artifacts/fairy-voice/harness-qwen-A.wav', import.meta.url) : null;
  if (destination) {
    await mkdir(new URL('.', destination), { recursive: true });
    await writeFile(destination, audio);
  }
  console.log(JSON.stringify({ ok: true, routes: ['/hdd-engine', '/hdd-speak'],
    model: 'qwen-audio-3.0-realtime-plus', durationSeconds: (audio.length - 44) / 48000,
    elapsedMs: Date.now() - begin, savedAudio: destination?.pathname || null }));
} finally {
  if (started) await fetch(base + '/hdd-engine?action=stop', { method: 'POST', headers, body: '{}' });
  dispose.reverse().forEach((fn) => fn());
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
