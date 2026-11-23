/** Offline protocol, lifecycle and HTTP boundary checks; never calls a paid API. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createQwenVoice } from '../qwen-voice.js';

const KEY = 'sk-offline-test-credential';
const TEXT = '主人，我在。';
const VOICE = 'qwen-audio-3.0-realtime-plus-fairya-offline';

function fixture(t, mode = 'success', config = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'fairy-qwen-test-'));
  const path = join(folder, 'config.json');
  writeFileSync(path, JSON.stringify({ apiKey: KEY, voice: VOICE, ...config }));
  t.after(() => { rmSync(path + '.selection', { force: true }); unlinkSync(path); rmdirSync(folder); });
  const sockets = [];
  class FakeSocket extends EventEmitter {
    constructor() { super(); this.sent = []; this.closed = false; }
    receive(data) { if (!this.closed) this.emit('message', Buffer.from(JSON.stringify(data)), false); }
    send(raw) {
      const data = JSON.parse(raw);
      this.sent.push(data);
      if (data.type === 'session.update') queueMicrotask(() => this.receive({ type: 'session.updated' }));
      if (data.type !== 'response.create' || mode === 'hold') return;
      queueMicrotask(() => {
        if (mode === 'close') { this.emit('close'); return; }
        if (mode === 'error') { this.receive({ type: 'error', error: { message: KEY } }); return; }
        const pcm = Buffer.alloc(9600, 1);
        this.receive({ type: 'response.audio.delta', delta: mode === 'invalid-audio' ? '!broken!' : pcm.toString('base64') });
        this.receive({ type: 'response.audio_transcript.delta', delta: mode === 'mismatch' ? '其他内容' : TEXT });
        this.receive({ type: 'response.done', response: { status: mode === 'incomplete' ? 'failed' : 'completed' } });
      });
    }
    terminate() { this.closed = true; }
  }
  const voice = createQwenVoice({ configPath: path, timeoutMs: mode === 'timeout' ? 10 : 1000,
    connect(url, options) {
      assert.equal(new URL(url).searchParams.get('model'), 'qwen-audio-3.0-realtime-plus');
      assert.equal(options.headers.Authorization, 'Bearer ' + KEY);
      const socket = new FakeSocket(); sockets.push(socket);
      queueMicrotask(() => { if (mode !== 'timeout') socket.receive({ type: 'session.created' }); });
      return socket;
    } });
  t.after(() => voice.stop());
  return { voice, sockets, path };
}

test('configuration is server-only; success uses the first session update and valid WAV', async (t) => {
  const { voice, sockets } = fixture(t);
  assert.equal(voice.snapshot().state, 'stopped');
  await assert.rejects(voice.synthesize(TEXT), { status: 409 });
  voice.start();
  assert.ok(!JSON.stringify(voice.snapshot()).includes(KEY));
  const audio = await voice.synthesize(TEXT);
  assert.equal(audio.toString('ascii', 0, 4), 'RIFF');
  assert.equal(audio.readUInt32LE(24), 24000);
  assert.equal(audio.readUInt32LE(40), audio.length - 44);
  assert.equal(sockets[0].sent[0].session.voice, VOICE);
  assert.equal(sockets[0].closed, true);
});

for (const mode of ['error', 'close', 'mismatch', 'incomplete', 'invalid-audio', 'timeout']) {
  test('fails safely: ' + mode, async (t) => {
    const { voice } = fixture(t, mode);
    voice.start();
    await assert.rejects(voice.synthesize(TEXT), (error) => {
      assert.ok([502, 504].includes(error.status));
      assert.ok(!error.message.includes(KEY));
      return true;
    });
  });
}

test('three-request limit; stop cancels every active socket and prevents new calls', async (t) => {
  const { voice, sockets } = fixture(t, 'hold');
  voice.start();
  const pending = Array.from({ length: 3 }, () => voice.synthesize(TEXT));
  const settled = Promise.allSettled(pending);
  await assert.rejects(voice.synthesize(TEXT), { status: 429 });
  voice.stop();
  for (const result of await settled) assert.equal(result.reason.status, 499);
  assert.ok(sockets.every((socket) => socket.closed));
  await assert.rejects(voice.synthesize(TEXT), { status: 409 });
});

test('caller disconnect/abort releases its request slot', async (t) => {
  const { voice } = fixture(t, 'hold');
  voice.start();
  const controller = new AbortController();
  const pending = voice.synthesize(TEXT, { signal: controller.signal });
  const rejected = assert.rejects(pending, { status: 499 });
  controller.abort();
  await rejected;
});

test('invalid local config stays unconfigured; missing config preserves local backend', async (t) => {
  const { voice, path } = fixture(t, 'success', { endpoint: 'wss://untrusted.example/realtime' });
  assert.equal(voice.start().state, 'unconfigured');
  await assert.rejects(voice.synthesize(TEXT), { status: 503 });
  assert.equal(createQwenVoice({ configPath: path + '.missing' }), null);
});

test('HTTP routes require same-origin POST; GET never synthesizes; response contains no key', async (t) => {
  const alternate = { id: 'alt', label: '测试音色', voice: 'qwen-alternate-private' };
  const { voice, sockets, path } = fixture(t, 'success', { voices: [alternate] });
  const server = createServer((req, res) => req.url.startsWith('/hdd-engine')
    ? voice.handleEngine(req, res) : voice.handleSpeak(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const headers = { 'content-type': 'application/json', 'X-Fairy-Request': '1' };
  assert.equal((await fetch(base + '/hdd-speak?text=hello')).status, 405);
  assert.equal((await fetch(base + '/hdd-engine?action=start', { method: 'POST' })).status, 415);
  assert.equal((await fetch(base + '/hdd-engine?action=start', {
    method: 'POST', headers: { ...headers, origin: 'https://untrusted.example' }, body: '{}' })).status, 403);
  assert.equal(sockets.length, 0);
  const started = await fetch(base + '/hdd-engine?action=start', { method: 'POST', headers, body: '{}' });
  assert.equal((await started.json()).state, 'ready');
  const response = await fetch(base + '/hdd-speak', { method: 'POST', headers, body: JSON.stringify({ text: TEXT }) });
  assert.equal(response.status, 200);
  assert.equal(Buffer.from(await response.arrayBuffer()).toString('ascii', 0, 4), 'RIFF');
  assert.equal((await fetch(base + '/hdd-speak', { method: 'POST', headers, body: '{' })).status, 400);
  const status = await (await fetch(base + '/hdd-engine')).text();
  assert.ok(!status.includes(KEY));
  assert.ok(!status.includes(alternate.voice));
  const select = (id) => fetch(base + '/hdd-engine?action=select', {
    method: 'POST', headers, body: JSON.stringify({ id }) });
  assert.equal((await select('unknown')).status, 400);
  const changed = await (await select('alt')).json();
  assert.equal(changed.selectedVoice, 'alt');
  assert.equal(changed.state, 'ready');
  assert.equal(createQwenVoice({ configPath: path }).snapshot().selectedVoice, 'alt');
  const next = await fetch(base + '/hdd-speak', { method: 'POST', headers, body: JSON.stringify({ text: TEXT }) });
  assert.equal(next.status, 200);
  assert.equal(sockets[1].sent[0].session.voice, alternate.voice);
  await fetch(base + '/hdd-engine?action=stop', { method: 'POST', headers, body: '{}' });
  assert.equal(voice.snapshot().state, 'stopped');
});
