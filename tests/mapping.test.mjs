import test from 'node:test';
import assert from 'node:assert/strict';
import { getCounterOptions, applyCounterMapping } from '../mapping.js';

test('maps one device, converts cumulative bytes and leaves gaps at reset', () => {
  const events = [{ ph: 'X', name: 'diffusion.1', ts: 500000, dur: 1500000 }];
  for (const [i, bytes] of [0, 2097152, 2, 1048578].entries()) {
    for (const device of [1, 2]) {
      events.push({ ph: 'C', name: 'custom', pid: device, ts: i * 1000000, args: { io: { counter: bytes * device } } });
    }
  }
  const fields = getCounterOptions(events);
  assert.equal(fields.length, 2);
  const trace = applyCounterMapping(events, { read: { source: fields.find(x => x.pid === 1), unit: 'bytes-total' } });
  assert.deepEqual(trace.samples.map(row => row.read), [null, 2, null, 1]);
  assert.equal(trace.stages[0].start, 0.5);
  assert.equal(trace.stages[0].end, 2);
});
