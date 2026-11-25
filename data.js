// Canonical units: seconds, percent of allocated CPU, percent GPU, GiB, MiB/s.
const METRICS = ['cpu', 'gpu', 'rss', 'vram', 'read', 'write', 'rx', 'tx'];
const REFERENCE = [
  ['runtime.import_torch', 'Torch 导入', 0.78, 5.18],
  ['runtime.import_pipeline', 'Pipeline 导入', 6.39, 27.73],
  ['prompt.encode', '文本编码与相关模型准备', 34.78, 96.95],
  ['diffusion.1', '第一阶段去噪（含其模型构建）', 131.74, 38.13],
  ['video.spatial_upsample', '空间上采样', 169.87, 1.65],
  ['diffusion.2', '第二阶段去噪（含其模型构建）', 171.52, 31.76],
  ['video.decode', '视频解码', 205.90, 1.02],
  ['audio.decode', '音频解码', 206.92, 4.65],
];

export const REFERENCE_STAGES = Object.freeze(REFERENCE.map(([id, name, start, duration]) =>
  Object.freeze({ id, name, start, end: Number((start + duration).toFixed(2)) })
));
const STAGE_NAMES = new Map(REFERENCE.map(([id, name]) => [id, name]));

function number(value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(path + ' 应为非负有限数字。');
  }
  return value;
}

function emptySample(time) {
  return { time, cpu: null, gpu: null, rss: null, vram: null, read: null, write: null, rx: null, tx: null };
}

function setMetric(row, key, value, path) {
  if (value === null || value === undefined) return;
  const n = number(value, path);
  if ((key === 'cpu' || key === 'gpu') && n > 100) {
    throw new Error(path + ' 应为 0–100 之间的利用率（CPU 按已分配核心归一化）。');
  }
  if (row[key] !== null && row[key] !== n) {
    throw new Error('同一时间出现重复且不同的 ' + key + ' 读数，请选择单次执行的数据。');
  }
  row[key] = n;
}

function stageList(stages) {
  if (!Array.isArray(stages)) throw new Error('stages 应为数组。');
  const ids = new Set();
  return stages.map((s, index) => {
    const path = 'stages[' + index + ']';
    if (!s || typeof s !== 'object' || typeof s.id !== 'string' || !s.id.trim()) {
      throw new Error(path + ' 需要字符串 id。');
    }
    if (ids.has(s.id)) throw new Error('阶段 id 重复：' + s.id);
    ids.add(s.id);
    const start = number(s.start, path + '.start');
    const end = s.end === undefined && s.duration !== undefined
      ? start + number(s.duration, path + '.duration')
      : number(s.end, path + '.end');
    if (!Number.isFinite(end) || end <= start) throw new Error(path + ' 的结束时间须大于开始时间。');
    return { id: s.id, name: typeof s.name === 'string' && s.name.trim() ? s.name : STAGE_NAMES.get(s.id) || s.id, start, end };
  }).sort((a, b) => a.start - b.start || b.end - a.end);
}

function finish(byTime, stages, document) {
  const samples = Array.from(byTime.values()).sort((a, b) => a.time - b.time);
  if (!samples.some(sample => METRICS.some(key => sample[key] !== null))) {
    throw new Error('没有可显示的资源采样。请提供 samples 或包含支持的资源计数器的 Chrome Trace。');
  }
  const lastStage = stages.reduce((max, s) => Math.max(max, s.end), 0);
  const lastTime = Math.max(samples[samples.length - 1].time, lastStage);
  const duration = document.duration === undefined ? lastTime : number(document.duration, 'duration');
  if (duration + 1e-8 < lastTime) throw new Error('duration 小于最后一个采样或阶段的结束时间。');
  return { title: typeof document.title === 'string' ? document.title : '', duration: Math.max(duration, lastTime), stages, samples };
}

function canonical(document) {
  if (!Array.isArray(document.samples)) throw new Error('samples 应为数组。');
  const byTime = new Map();
  for (const [i, sample] of document.samples.entries()) {
    const path = 'samples[' + i + ']';
    if (!sample || typeof sample !== 'object') throw new Error(path + ' 应为对象。');
    const time = number(sample.time, path + '.time');
    const row = byTime.get(time) || emptySample(time);
    for (const key of METRICS) setMetric(row, key, sample[key], path + '.' + key);
    byTime.set(time, row);
  }
  const stages = document.stages ?? (document.stagePreset === 'ltx-reference' ? REFERENCE_STAGES : []);
  return finish(byTime, stageList(stages), document);
}

// The demo is generated locally. The stage schedule illustrates the reference
// pipeline; none of the resource values are measurements from a capture.
export function demoTrace() {
  const duration = 224;
  const stages = REFERENCE_STAGES.map(s => ({ ...s }));
  const samples = [];
  let seed = 38281;
  function random() {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  }
  for (let i = 0; i <= duration * 3; i++) {
    const time = i / 3;
    const stage = stages.find(s => time >= s.start && time < s.end);
    const p = stage ? (time - stage.start) / (stage.end - stage.start) : 0;
    const oscillation = (1 + Math.sin(time * 3.5)) / 2;
    const row = { time, cpu: 2 + random() * 4, gpu: 0, rss: 1.2, vram: 0.8, read: 0, write: 4 * random(), rx: 0, tx: 0 };

    if (stage?.id.startsWith('runtime.')) {
      row.cpu = 7 + oscillation * 10 + random() * 4;
      row.rss += p * 0.7;
      row.read = 18 + oscillation * 42;
    } else if (stage?.id === 'prompt.encode' || stage?.id.startsWith('diffusion.')) {
      const encoding = stage.id === 'prompt.encode';
      const split = encoding ? 0.80 : 0.52;
      const peakRss = encoding ? 19 : 16;
      if (p < split) {
        const q = p / split;
        row.cpu = encoding ? 5 + oscillation * 5 : 17 + q * 24 + random() * 12;
        row.rss += peakRss * q;
        row.read = encoding ? 190 + random() * 75 : (0.25 + 0.75 * oscillation) * (880 + random() * 570);
      } else {
        const pulse = encoding ? (0.25 + oscillation * 0.75) : (0.76 + random() * 0.24);
        row.gpu = pulse * (encoding ? 83 : 99);
        row.cpu = 10 + oscillation * 7;
        row.rss += peakRss * (encoding ? 0.7 : 0.96);
        row.vram += encoding ? 4.4 + oscillation : 2.8 + oscillation * 0.25;
        row.rx = pulse * (encoding ? 8000 : 11300) * (0.58 + random() * 0.42);
        row.tx = row.rx * (0.04 + random() * 0.05);
        row.read = 5 + random() * 12;
      }
    } else if (stage) {
      row.cpu = 11 + random() * 12;
      row.gpu = 22 + oscillation * 55;
      row.rss = 4.5;
      row.vram = 1.6;
      row.rx = 270 + oscillation * 950;
      row.tx = 60 + random() * 130;
    } else if (time > stages[stages.length - 1].end) {
      row.rss = 3.2;
      row.write = 10 + oscillation * 33;
    }
    for (const key of METRICS) row[key] = Math.round(row[key] * 100) / 100;
    samples.push(row);
  }
  return { title: 'LTX-2.5 模拟示例', duration, stages, samples };
}

function token(label) {
  return String(label ?? '').toLowerCase().replace(/%/g, 'pct').replace(/[^a-z0-9]/g, '');
}

// Unit-aware aliases are intentionally limited to gauges and transfer rates.
// A cumulative byte counter must first be differentiated over elapsed time.
const COUNTERS = new Map();
function register(key, aliases, units) {
  for (const alias of aliases.split(' ')) {
    for (const [unit, factor] of units) {
      COUNTERS.set(alias + unit, { key, factor });
    }
  }
}
const percent = [['', 1], ['pct', 1], ['percent', 1], ['percentage', 1]];
const memory = [['', 1], ['gib', 1], ['mib', 1 / 1024], ['kib', 1 / 1024 ** 2],
  ['bytes', 1 / 1024 ** 3], ['gb', 1e9 / 1024 ** 3], ['mb', 1e6 / 1024 ** 3]];
const rates = [['', 1]];
for (const [unit, factor] of [['mib', 1], ['kib', 1 / 1024], ['gib', 1024],
  ['mb', 1e6 / 1024 ** 2], ['kb', 1e3 / 1024 ** 2], ['gb', 1e9 / 1024 ** 2],
  ['bytes', 1 / 1024 ** 2], ['b', 1 / 1024 ** 2]]) {
  for (const suffix of ['s', 'ps', 'sec', 'persec', 'persecond', 'pers']) {
    rates.push([unit + suffix, factor]);
  }
}
register('cpu', 'cpu cpuutil cpuusage cpuutilization processcpu processcpuutil processcpuusage processcpuutilization normalizedcpu cpunormalized cpupctnormalized cpupctnorm cpunorm processcpunormalized processcpu8allocatedcores', percent);
register('gpu', 'gpu gpuutil gpuusage gpuutilization devicegpu devicegpuutil devicegpuutilization utilizationgpu', percent);
register('rss', 'rss hostrss cpurss procrss processrss memoryrss rssmemory residentmemory', memory);
register('vram', 'vram gpuvram gpumem gpumemory gpumemoryused gpumemused gpuram devicememoryused devicememory devicememused', memory);
register('read', 'read diskread procread storageprocessread storageread processread ioread processioread', rates);
register('write', 'write diskwrite procwrite storageprocesswrite storagewrite processwrite iowrite processiowrite', rates);
register('rx', 'rx pcierx devicepcierx gpupcierx pcierxthroughput', rates);
register('tx', 'tx pcietx devicepcietx gpupcietx pcietxthroughput', rates);

const UNIT_SUFFIX = /(pct|percent|percentage|(?:bytes|gib|mib|kib|gb|mb|kb|b)(?:persecond|persec|pers|sec|ps|s)?)$/;

export function counterField(group, field, onlyValue) {
  const name = token(group);
  const arg = token(field);
  const suffix = name.match(UNIT_SUFFIX)?.[0] || '';
  const base = suffix ? name.slice(0, -suffix.length) : name;
  const candidates = [name + arg, arg + name, base + arg + suffix, arg + suffix];
  // Respect explicit units, including cumulative bytes that cannot be drawn as
  // rates. A field with its own unit can override the enclosing group.
  if (!suffix || UNIT_SUFFIX.test(arg)) candidates.push(arg);
  if (onlyValue && (arg === 'value' || arg === 'v' || (arg === 'count' && suffix))) candidates.push(name);
  for (const candidate of candidates) {
    const match = COUNTERS.get(candidate);
    if (!match) continue;
    if ((match.key === 'cpu' || match.key === 'gpu') && /ratio|fraction/.test(name) && !/pct|percent/.test(arg)) continue;
    if ((match.key === 'rx' || match.key === 'tx') && /network|ethernet|infiniband|nvlink/.test(name)) continue;
    return match;
  }
  return null;
}

// Both capture tables use seconds since the capture process started. Parsing
// the CSV fields by name also keeps logical reads distinct from storage reads.
function csvRows(text, requiredColumns, fileName) {
  if (typeof text !== 'string') throw new Error(fileName + ' 应为 CSV 文本。');
  const input = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], value = '', quoted = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '"') {
      if (quoted && input[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      row.push(value.trim());
      value = '';
    } else if ((ch === '\r' || ch === '\n') && !quoted) {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      row.push(value.trim());
      if (row.some(field => field !== '')) rows.push(row);
      row = [];
      value = '';
    } else {
      value += ch;
    }
  }
  if (quoted) throw new Error(fileName + ' 中的引号未闭合。');
  row.push(value.trim());
  if (row.some(field => field !== '')) rows.push(row);
  const headers = rows.shift() || [];
  if (new Set(headers).size !== headers.length || requiredColumns.some(key => !headers.includes(key))) {
    throw new Error(fileName + ' 需要无重复的表头，必需列为 ' + requiredColumns.join(', ') + '。');
  }
  return rows.map((fields, i) => {
    if (fields.length !== headers.length) throw new Error(fileName + ' 第 ' + (i + 2) + ' 行列数与表头不符。');
    return Object.fromEntries(headers.map((key, j) => [key, fields[j]]));
  });
}

function intervalsToStages(intervals) {
  const counts = new Map();
  return intervals.sort((a, b) => a.start - b.start).map(({ id, start, duration }) => {
    const count = (counts.get(id) || 0) + 1;
    counts.set(id, count);
    return { id: count === 1 ? id : id + '#' + count, name: STAGE_NAMES.get(id), start, end: start + duration };
  });
}

const RESOURCE_COLUMNS = {
  gpu: 'gpu_util_pct', rss: 'rss_gib', vram: 'gpu_memory_gib', read: 'process_read_mib_s',
  write: 'process_write_mib_s', rx: 'pcie_rx_mib_s', tx: 'pcie_tx_mib_s',
};

export function normalizeCaptureTables(resourcesCSV, phasesCSV, options = {}) {
  const rows = csvRows(resourcesCSV, ['elapsed_s'], 'resources.csv');
  const needsCores = rows.some(row => row.cpu_cores !== undefined && row.cpu_cores !== '');
  if (needsCores && !(Number.isFinite(options.allocatedCores) && options.allocatedCores > 0)) {
    throw new Error('请指定本次采集分配的 CPU 核数，以换算 CPU 利用率。');
  }
  const samples = rows.map((row, i) => {
    if (row.elapsed_s === '') throw new Error('resources.csv 第 ' + (i + 2) + ' 行缺少 elapsed_s。');
    const sample = { time: Number(row.elapsed_s) };
    if (row.cpu_cores !== undefined && row.cpu_cores !== '') {
      sample.cpu = Number(row.cpu_cores) * 100 / options.allocatedCores;
    }
    for (const [key, column] of Object.entries(RESOURCE_COLUMNS)) {
      if (row[column] !== undefined && row[column] !== '') sample[key] = Number(row[column]);
    }
    return sample;
  });
  const phases = phasesCSV == null ? [] : csvRows(phasesCSV, ['name', 'start_s', 'duration_s'], 'phases.csv');
  const intervals = phases.filter(row => STAGE_NAMES.has(row.name)).map(row => {
    if (!row.start_s || !row.duration_s) throw new Error('phases.csv 中的阶段缺少起点或时长。');
    return { id: row.name, start: Number(row.start_s), duration: Number(row.duration_s) };
  });
  return canonical({ samples, stages: intervalsToStages(intervals), duration: options.duration, title: options.title });
}

function chromeTrace(document, events) {
  if (!Array.isArray(events)) throw new Error('traceEvents 应为数组。');
  const byTime = new Map();
  const tracks = new Map();
  const phases = [];
  const resolveCache = new Map();
  let firstTime = Infinity;
  let firstAbsoluteActivity = Infinity;

  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    if (event.ph !== 'M' && Number.isFinite(event.ts) && event.ts >= 1e12) {
      firstAbsoluteActivity = Math.min(firstAbsoluteActivity, event.ts);
    }
    if (event.ph === 'X' && STAGE_NAMES.has(event.name)) {
      const start = number(event.ts, event.name + '.ts');
      const duration = number(event.dur, event.name + '.dur');
      if (duration > 0) {
        phases.push({ id: event.name, start, duration });
        firstTime = Math.min(firstTime, start);
      }
      continue;
    }
    if (event.ph !== 'C' || !event.args || typeof event.args !== 'object') continue;
    const args = event.args.data && typeof event.args.data === 'object' ? event.args.data : event.args;
    const fields = Object.keys(args);
    for (const field of fields) {
      const cacheKey = JSON.stringify([event.name, field, fields.length === 1]);
      if (!resolveCache.has(cacheKey)) {
        resolveCache.set(cacheKey, counterField(event.name, field, fields.length === 1));
      }
      const spec = resolveCache.get(cacheKey);
      if (!spec) continue;
      const track = JSON.stringify([event.pid, event.tid, event.cat, event.name, event.scope, event.id, event.id2]);
      const priorTrack = tracks.get(spec.key);
      if (priorTrack !== undefined && priorTrack !== track) {
        throw new Error('发现多条 ' + spec.key + ' 计数器轨道，请选择一个进程 / 设备的指标后导入。');
      }
      tracks.set(spec.key, track);
      const ts = number(event.ts, 'Chrome Trace 的 ts');
      const row = byTime.get(ts) || emptySample(ts);
      const raw = args[field];
      if (raw !== null) setMetric(row, spec.key, number(raw, String(event.name) + '.' + field) * spec.factor, field);
      byTime.set(ts, row);
      firstTime = Math.min(firstTime, ts);
    }
  }
  // Relative capture times retain the lead-in before the first sample. For
  // epoch-sized clocks use the earliest activity, including surrounding spans.
  const origin = document.timeOriginUs !== undefined
    ? number(document.timeOriginUs, 'timeOriginUs')
    : (Number.isFinite(firstTime) && firstTime >= 1e12 ? firstAbsoluteActivity : 0);
  if (firstTime < origin) throw new Error('timeOriginUs 晚于资源采样或阶段的起点。');
  for (const row of byTime.values()) row.time = (row.time - origin) / 1e6;
  const stages = intervalsToStages(phases.map(phase => ({
    id: phase.id, start: (phase.start - origin) / 1e6, duration: phase.duration / 1e6,
  })));
  const fallback = document.stages ?? (document.stagePreset === 'ltx-reference' ? REFERENCE_STAGES : []);
  const result = finish(byTime, stageList(stages.length ? stages : fallback), { title: document.title, duration: document.duration });
  if (document.timeOriginUs === undefined && origin > 0) result.timeBasis = 'trace';
  return result;
}

export function normalizeTrace(json) {
  if (Array.isArray(json)) return chromeTrace({}, json);
  if (!json || typeof json !== 'object') throw new Error('JSON 顶层应为对象或 Chrome Trace 事件数组。');
  if (Object.hasOwn(json, 'samples')) return canonical(json);
  if (Object.hasOwn(json, 'traceEvents')) return chromeTrace(json, json.traceEvents);
  throw new Error('JSON 中未找到 samples 或 traceEvents。');
}
