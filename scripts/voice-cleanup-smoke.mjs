/** Execute the actual client playback functions with deterministic audio events. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const resources = source.slice(source.indexOf('    const voiceUrls ='), source.indexOf('    function mountBootSplash'));
const playback = source.slice(source.indexOf('    /* Reads the reply from the host feed'),
  source.indexOf('    /* The reply comes from the host half'));
const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup({ deferred = false, rejectPlay = false } = {}) {
  const urls = new Set(), audio = [], pending = [], timers = new Map();
  let next = 0;
  class Audio {
    constructor(src) { this.src = src; this.events = new Map(); audio.push(this); }
    addEventListener(name, fn) { this.events.set(name, fn); }
    emit(name) { const fn = this.events.get(name); this.events.delete(name); fn?.(); }
    play() { return rejectPlay ? Promise.reject(new Error('Playback refused')) : Promise.resolve(); }
    pause() { this.paused = true; }
    removeAttribute() { this.src = ''; }
    load() { this.released = true; }
  }
  const sandbox = { Blob, Audio, console,
    URL: { createObjectURL() { const url = 'blob:voice-' + ++next; urls.add(url); return url; }, revokeObjectURL(url) { urls.delete(url); } },
    window: { setTimeout(fn) { const id = ++next; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); } },
    fetchPart() {
      const response = { ok: true, blob: async () => new Blob(['audio']), arrayBuffer: async () => new ArrayBuffer(10) };
      return deferred ? new Promise((resolve) => pending.push(() => resolve(response))) : Promise.resolve(response);
    },
    voiceRequests: new Set(), streamer: { nodes: [], scheduled: 0 },
    streamStop() {}, streamContext() { return null; },
    hddVisualState: { enabled: true }, voiceEnabled: () => true,
    engineState: { value: { state: 'ready' } }, ensureEngine() {},
    spoken: new Set(), speakableText: (text) => text, chunkSpeech: (text) => text.split('|'),
    setVoiceSpeaking() {}, setVoiceDiag() {}, composeGreeting: () => '主人，我在。', VOICE_STREAMING: false,
  };
  vm.createContext(sandbox);
  vm.runInContext(resources + '\n' + playback + '\n globalThis.api = { speakNow, stopVoice, prepareGreeting, playGreeting, greeting, retainVoiceUrl, voiceRunCleanups, get current() { return voiceAudio; } };', sandbox);
  return { api: sandbox.api, urls, audio, pending, timers };
}

test('normal completion releases each WAV URL, player source and per-run queue', async () => {
  const { api, urls, audio } = setup();
  api.speakNow('第一段|第二段|第三段', 'reply');
  await flush();
  assert.equal(urls.size, 3);
  for (let index = 0; index < 3; index++) {
    audio[index].emit('ended'); await flush();
    assert.equal(audio[index].released, true);
  }
  assert.equal(urls.size, 0);
  assert.equal(api.current, null);
  assert.equal(api.voiceRunCleanups.size, 0);
});

test('stop releases currently playing and unused prefetched audio', async () => {
  const { api, urls, audio } = setup();
  api.speakNow('第一段|第二段|第三段', 'reply'); await flush();
  assert.equal(urls.size, 3);
  api.stopVoice();
  assert.equal(urls.size, 0);
  assert.equal(audio[0].src, '');
  assert.equal(api.current, null);
  assert.equal(api.voiceRunCleanups.size, 0);
});

test('late responses after cancellation cannot recreate audio URLs', async () => {
  const { api, urls, pending } = setup({ deferred: true });
  api.speakNow('第一段|第二段', 'reply');
  api.stopVoice(); pending.forEach((resolve) => resolve()); await flush();
  assert.equal(urls.size, 0);
  assert.equal(api.current, null);
});

test('playback rejection releases the player and canceled retry', async () => {
  const { api, urls, audio, timers } = setup({ rejectPlay: true });
  api.speakNow('第一段', 'reply'); await flush();
  assert.equal(urls.size, 0);
  assert.equal(audio[0].released, true);
  api.stopVoice();
  assert.equal(timers.size, 0);
});

test('greeting completion clears its WAV URL and decoded audio reference', async () => {
  const { api, urls, audio } = setup();
  await api.prepareGreeting(); await flush();
  assert.equal(urls.size, 1);
  api.playGreeting(); audio[0].emit('ended');
  assert.equal(urls.size, 0);
  assert.equal(api.greeting.buffer, null);
  assert.equal(api.greeting.url, null);
  assert.equal(api.current, null);
});

test('greeting downloaded after stop cannot populate the cache', async () => {
  const { api, urls, pending } = setup({ deferred: true });
  api.prepareGreeting(); api.stopVoice(); pending.forEach((resolve) => resolve()); await flush();
  assert.equal(urls.size, 0);
  assert.equal(api.greeting.ready, false);
});
