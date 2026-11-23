/** Check header visibility transitions against the actual client switch code. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const section = source.slice(source.indexOf('    const HDD_MODE_KEY'), source.indexOf('    /* ---- boot splash ----'));

test('switch survives blank sessions and hidden headers; avoids duplicating a visible header', () => {
  let state, effect, cleanup, observer, header = [], frames = [], disconnected = false;
  const sandbox = {
    h: (type, props, ...children) => ({ type, props, children }),
    React: { useState(initial) { state ??= initial; return [state, (next) => { state = next; }]; },
      useLayoutEffect(fn) { effect ||= fn; }, useEffect() {} },
    window: { localStorage: { getItem: () => 'off', setItem() {} },
      requestAnimationFrame(fn) { frames.push(fn); return frames.length; }, cancelAnimationFrame() {},
      getComputedStyle: (element) => element.style, addEventListener() {}, removeEventListener() {} },
    document: { body: {}, querySelectorAll: () => header, addEventListener() {}, removeEventListener() {} },
    MutationObserver: class { constructor(fn) { observer = fn; } observe() {} disconnect() { disconnected = true; } },
  };
  vm.createContext(sandbox);
  vm.runInContext(section + '\n globalThis.render = HddPersistentSwitch;', sandbox);
  const render = () => sandbox.render();
  const update = () => { observer(); frames.splice(0).forEach((fn) => fn()); return render(); };
  const visibleHeader = { closest: () => null, getBoundingClientRect: () => ({ width: 80, height: 28 }),
    style: { display: 'inline-flex', visibility: 'visible' } };
  render(); cleanup = effect();
  assert.ok(render(), 'blank session must have a fallback even with decoration off');
  header = [visibleHeader];
  assert.equal(update(), null, 'visible original header must hide fallback');
  header = [{ ...visibleHeader, getBoundingClientRect: () => ({ width: 0, height: 0 }) }];
  assert.ok(update(), 'collapsed header must show fallback');
  header = [{ ...visibleHeader, closest: () => ({ hidden: true }) }];
  assert.ok(update(), 'retained but hidden session must not hide fallback');
  header = [];
  assert.ok(update(), 'navigating away from the session must keep the switch reachable');
  cleanup(); assert.equal(disconnected, true);
});
