import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindScrubber } from '../scrubber.js';

test('a burst uses the latest pointer position per frame; geometry follows scroll and queued old ranges are discarded', t => {
  const frames = new Map();
  let counter = 0, reads = 0, left = 20;
  const saved = {};
  for (const name of ['window', 'requestAnimationFrame', 'cancelAnimationFrame']) saved[name] = globalThis[name];
  Object.assign(globalThis, {
    window: new EventTarget(),
    requestAnimationFrame(fn) { frames.set(++counter, fn); return counter; },
    cancelAnimationFrame(id) { frames.delete(id); },
  });
  const host = new EventTarget();
  const surface = { isConnected: true, getBoundingClientRect() { reads++; return { left, width: 100 }; } };
  const positions = [];
  const input = bindScrubber(host, { surfaceFor: () => surface, onPosition: x => positions.push(x) });
  t.after(() => {
    input.destroy();
    for (const [name, previous] of Object.entries(saved)) {
      if (previous === undefined) delete globalThis[name];
      else globalThis[name] = previous;
    }
  });
  function move(clientX) {
    const event = Object.assign(new Event('pointermove'), { pointerType: 'mouse', clientX });
    host.dispatchEvent(event);
  }
  function paint() {
    assert.equal(frames.size, 1);
    const [id, fn] = frames.entries().next().value;
    frames.delete(id);
    fn();
  }
  move(30); move(45); move(50);
  assert.equal(reads, 0);
  paint();
  move(60);
  paint();
  assert.deepEqual(positions, [0.3, 0.4]);
  assert.equal(reads, 1);
  left = 40;
  window.dispatchEvent(new Event('scroll'));
  move(50);
  paint();
  assert.equal(reads, 2);
  assert.equal(positions.at(-1), 0.1);
  move(70);
  input.reset();
  assert.equal(frames.size, 0);
});
