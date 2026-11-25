import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindScrubber } from '../scrubber.ts';

function setup(t, callbacks = {}) {
  const frames = new Map();
  let counter = 0, reads = 0, pageLeft = 20;
  const saved = {};
  for (const name of ['window', 'requestAnimationFrame', 'cancelAnimationFrame']) saved[name] = globalThis[name];
  Object.assign(globalThis, {
    window: Object.assign(new EventTarget(), { scrollX: 0, document: {} }),
    requestAnimationFrame(fn) { frames.set(++counter, fn); return counter; },
    cancelAnimationFrame(id) { frames.delete(id); },
  });
  const host = new EventTarget();
  const surface = {
    isConnected: true,
    getBoundingClientRect() { reads++; return { left: pageLeft - window.scrollX, width: 100 }; },
  };
  const positions = [];
  const input = bindScrubber(host, { surface, onPosition: x => positions.push(x), ...callbacks });
  t.after(() => {
    input.destroy();
    for (const [name, previous] of Object.entries(saved)) {
      if (previous === undefined) delete globalThis[name];
      else globalThis[name] = previous;
    }
  });
  function pointer(type, clientX) {
    const properties = { isPrimary: true, button: 0, pointerId: 1, pointerType: 'mouse', clientX, pageX: clientX + window.scrollX };
    host.dispatchEvent(Object.assign(new Event(type), properties));
  }
  function paint() {
    assert.equal(frames.size, 1);
    const [id, fn] = frames.entries().next().value;
    frames.delete(id);
    fn();
  }
  function scroll(scroller) {
    // A captured, non-bubbling scroll event keeps its original target.
    const event = new Event('scroll');
    Object.defineProperty(event, 'target', { value: scroller });
    window.dispatchEvent(event);
  }
  return { pointer, scroll, paint, frames, surface, input, positions, reads: () => reads, setLeft(value) { pageLeft = value; } };
}

test('coalesces pointer bursts, keeps page geometry across document and unrelated scroll, and cancels old ranges', t => {
  const { pointer, scroll, paint, frames, surface, input, positions, reads, setLeft } = setup(t);
  pointer('pointermove', 30); pointer('pointermove', 45); pointer('pointermove', 50);
  assert.equal(reads(), 0);
  paint();
  pointer('pointermove', 60);
  paint();
  assert.deepEqual(positions, [0.3, 0.4]);
  assert.equal(reads(), 1);

  scroll(window.document);
  scroll({ contains: () => false });
  pointer('pointermove', 65);
  paint();
  window.scrollX = 25;
  scroll(window.document);
  pointer('pointermove', 45);
  paint();
  assert.deepEqual(positions.slice(-2), [0.45, 0.5]);
  assert.equal(reads(), 1);

  setLeft(40);
  scroll({ contains: element => element === surface });
  pointer('pointermove', 25);
  paint();
  assert.equal(reads(), 2);
  assert.equal(positions.at(-1), 0.1);
  pointer('pointermove', 70);
  input.reset();
  assert.equal(frames.size, 0);
});

test('a ribbon drag starts at its latest position after measurement, even if released before paint', t => {
  const actions = [];
  const { pointer, paint, frames, reads } = setup(t, {
    hover: false,
    onDragStart: x => actions.push(['start', x, reads()]),
    onPosition: x => actions.push(['position', x]),
  });
  pointer('pointerdown', 30);
  pointer('pointermove', 32);
  assert.equal(frames.size, 0);
  pointer('pointermove', 36);
  pointer('pointermove', 41);
  pointer('pointerup', 44);
  assert.deepEqual(actions, []);
  paint();
  assert.deepEqual(actions, [['start', 0.24, 1], ['position', 0.24]]);

  pointer('pointerdown', 45);
  pointer('pointermove', 55);
  pointer('pointercancel', 55);
  assert.equal(frames.size, 0);
  pointer('pointerdown', 46);
  pointer('pointerup', 46);
  assert.equal(frames.size, 0);
});
