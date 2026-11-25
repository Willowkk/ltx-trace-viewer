import test from 'node:test';
import assert from 'node:assert/strict';
import { counterField, demoTrace, normalizeCaptureTables, normalizeTrace, REFERENCE_STAGES } from '../data.ts';

test('canonical input orders samples, aligns split rows, preserves gaps and recorded custom stages', () => {
  const data = normalizeTrace({
    samples: [{ time: 4, gpu: 35 }, { time: 1, cpu: 12 }, { time: 4, rx: 47 }, { time: 2, gpu: null }],
    stages: [{ id: 'decode2', name: '解码', start: 2, duration: 3 }],
  });
  assert.deepEqual(data.samples.map(s => s.time), [1, 2, 4]);
  assert.equal(data.samples[2].rx, 47);
  assert.equal(data.samples[2].gpu, 35);
  assert.equal(data.samples[1].gpu, null);
  assert.equal(data.stages[0].end, 5);
  assert.equal(data.duration, 5);
});

test('reference timings are opt-in for imported samples', () => {
  const input = { samples: [{ time: 0.5, gpu: 0 }] };
  assert.deepEqual(normalizeTrace(input).stages, []);
  assert.deepEqual(normalizeTrace({ ...input, stagePreset: 'ltx-reference' }).stages, REFERENCE_STAGES);
  assert.deepEqual(normalizeTrace(demoTrace()).stages, REFERENCE_STAGES);
});

test('Chrome X and C share microsecond origin; aggregated fields convert binary and SI units', () => {
  const trace = [
    { ph: 'X', name: 'diffusion.1', ts: 2500000, dur: 1250000 },
    { ph: 'X', name: 'diffusion.1', ts: 4500000, dur: 500000 },
    { ph: 'C', name: 'CPU / GPU utilization', ts: 2000000, args: { cpu_pct: 46, gpu_util_pct: 81 } },
    { ph: 'C', name: 'memory (MiB)', ts: 2000000, args: { rss: 2048, device_memory_used: 3072 } },
    { ph: 'C', name: 'Storage', ts: 2000000, args: { read_MiB_s: 300, write_bytes_per_second: 1048576 } },
    { ph: 'C', name: 'PCIe RX (KiB/s)', ts: 2000000, args: { value: 2048 } },
    { ph: 'C', name: 'PCIe TX (MB/s)', ts: 2000000, args: { value: 1 } },
  ];
  const data = normalizeTrace({ traceEvents: trace, displayTimeUnit: 'ns' });
  assert.deepEqual(data.samples, [{ time: 2, cpu: 46, gpu: 81, rss: 2, vram: 3, read: 300, write: 1, rx: 2, tx: 1e6 / 2 ** 20 }]);
  assert.equal(data.stages[0].start, 2.5);
  assert.equal(data.stages[0].end, 3.75);
  assert.equal(data.stages[1].id, 'diffusion.1#2');
});

test('relative, explicit, and wall-clock origins align Chrome counters and stages', () => {
  const epoch = 1730000000000000;
  const traceEvents = [
    { ph: 'M', name: 'process_name', ts: 0 },
    { ph: 'X', name: 'video.decode', ts: epoch + 1000000, dur: 130000 },
    { ph: 'C', name: 'resources', ts: epoch + 300000, args: { gpu: 13 } },
  ];
  const relative = normalizeTrace({ traceEvents, timeOriginUs: epoch });
  assert.equal(relative.samples[0].time, 0.3);
  assert.equal(relative.stages[0].start, 1);
  assert.equal(normalizeTrace(traceEvents).stages[0].start, 0.7);
  assert.throws(() => normalizeTrace({ traceEvents, timeOriginUs: epoch + 900000 }), /timeOriginUs/);
});

test('rejects conflicting values/tracks and unsupported cumulative counters', () => {
  assert.throws(() => normalizeTrace({ samples: [{ time: 2, cpu: 1 }, { time: 2, cpu: 2 }] }), /重复/);
  const counter = { ph: 'C', name: 'GPU', ts: 100, args: { value: 10 } };
  assert.throws(() => normalizeTrace([counter, { ...counter, pid: 2, ts: 120 }]), /多条/);
  assert.throws(() => normalizeTrace([{ ph: 'C', name: 'Disk bytes', ts: 120, args: { read: 1, write: 5 } }]), /没有可显示/);
  assert.throws(() => normalizeTrace([{ ph: 'C', name: 'Network', ts: 120, args: { rx_mib_s: 20 } }]), /没有可显示/);
});

test('invalid rows and bounds produce a helpful import error', () => {
  assert.throws(() => normalizeTrace({ samples: [null] }), /samples/);
  assert.throws(() => normalizeTrace({ samples: [{ time: 1, gpu: 'busy' }] }), /gpu/);
  assert.throws(() => normalizeTrace({ samples: [{ time: 1, gpu: 10 }], duration: 0.9 }), /duration/);
  assert.throws(() => normalizeTrace({ samples: [{ time: 1, gpu: 10 }], stages: [{ id: 'bad', start: 1, end: 0 }] }), /结束时间/);
});

test('ignores ambiguous fractions and operation counts', () => {
  assert.equal(counterField('utilization ratios', 'gpu', true), null);
  assert.equal(counterField('read', 'total_bytes', true), null);
  assert.equal(counterField('read', 'count', true), null);
  assert.deepEqual(counterField('gpu (%)', 'value', true), { key: 'gpu', factor: 1 });
});

test('capture tables align all eight series with the measured stage windows', () => {
  const resources = [
    '\uFEFFelapsed_s,cpu_cores,rss_gib,gpu_util_pct,gpu_memory_gib,logical_read_mib_s,process_read_mib_s,process_write_mib_s,pcie_rx_mib_s,pcie_tx_mib_s',
    '1,2,6.5,90,3,999,26,0,400,150',
    '2,0,,,0,123,23,1,19,0',
  ].join('\r\n');
  const phases = 'name,start_s,duration_s,other\nprompt.encode,0.8,1,"a,b"\nhelper,0,0.1,"c""d"\n';
  const trace = normalizeCaptureTables(resources, phases, { allocatedCores: 4, duration: 3 });
  assert.deepEqual(trace.samples[0], {time: 1, cpu: 50, gpu: 90, rss: 6.5, vram: 3, read: 26, write: 0, rx: 400, tx: 150});
  assert.equal(trace.samples[1].gpu, null);
  assert.equal(trace.stages.length, 1);
  assert.equal(trace.stages[0].start, 0.8);
  assert.equal(trace.stages[0].end, 1.8);
  assert.equal(trace.duration, 3);
  assert.throws(() => normalizeCaptureTables(resources, phases), /CPU 核数/);
});

test('a compact export preserves byte units, absent counters, and the earliest timestamped activity', () => {
  const clock = 1700000000000000;
  const trace = {traceEvents: [
    { ph: 'X', name: 'parent', ts: clock, dur: 500000 },
    { ph: 'X', name: 'diffusion.1', ts: clock + 100000, dur: 300000 },
    { ph: 'C', name: 'GPU utilization', ts: clock + 200000, args: { percent: 42 } },
    { ph: 'C', name: 'Process RSS', ts: clock + 200000, args: { bytes: 3 * 2 ** 30 } },
    { ph: 'C', name: 'GPU memory', ts: clock + 200000, args: { bytes: 2 ** 29 } },
  ]};
  const data = normalizeTrace(trace);
  assert.equal(data.timeBasis, 'trace');
  assert.equal(data.stages[0].start, 0.1);
  assert.deepEqual(data.samples[0], {time: 0.2, cpu: null, gpu: 42, rss: 3, vram: 0.5, read: null, write: null, rx: null, tx: null});
});
