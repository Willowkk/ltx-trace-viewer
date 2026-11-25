import { demoTrace, normalizeTrace, REFERENCE_STAGES } from './data.js';
import { mountCharts } from './charts.js';
import { getCounterOptions, chooseCounterMapping } from './mapping.js';

const byId = (id) => document.getElementById(id);
const metrics = [
  ['cpu', 'CPU', '%'], ['gpu', 'GPU', '%'],
  ['rss', 'RSS', 'GiB'], ['vram', '显存', 'GiB'],
  ['read', '读取', 'MiB/s'], ['write', '写入', 'MiB/s'],
  ['rx', 'PCIe RX', 'MiB/s'], ['tx', 'PCIe TX', 'MiB/s'],
];
const metricsFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
let dataset, focusedStage, sourceJson, failedFile;
let range = [0, 1], importVersion = 0;
const valueCells = new Map();
const stageButtons = new Map();
const charts = mountCharts(byId('charts'), { onCursor: updateCursor, onStage: stage => { selectStage(stage); byId('scope-title').scrollIntoView({ block: 'start' }); } });

for (const [key, name, unit] of metrics) {
  const cell = document.createElement('div');
  const label = document.createElement('span');
  label.className = 'metric-name';
  label.textContent = name;
  const value = document.createElement('span');
  value.className = 'metric-val';
  const number = document.createElement('span');
  number.textContent = '—';
  const units = document.createElement('small');
  units.className = 'metric-unit';
  units.textContent = unit;
  value.append(number, units);
  cell.append(label, value);
  byId('values').append(cell);
  valueCells.set(key, number);
}

// Only readings inside the displayed interval can appear in a stage detail.
function lowerBound(samples, time) {
  let low = 0, high = samples.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (samples[mid].time < time) low = mid + 1;
    else high = mid;
  }
  return low;
}

function nearestSample(time) {
  const rows = dataset.samples;
  const pos = lowerBound(rows, time);
  const nearby = [rows[pos - 1], rows[pos]].filter(row =>
    row && row.time >= range[0] && (focusedStage ? row.time < range[1] : row.time <= range[1]));
  return nearby.sort((a, b) => Math.abs(a.time - time) - Math.abs(b.time - time))[0] ?? null;
}

function updateCursor(time) {
  if (!dataset) return;
  const active = Number.isFinite(time);
  const sample = active ? nearestSample(time) : null;
  const stages = active ? dataset.stages.filter(stage => time >= stage.start && time < stage.end) : [];
  byId('cursor-time').textContent = active ? time.toFixed(2) + ' s' : '—';
  byId('cursor-stage').textContent = active
    ? stages.map(stage => stage.name).join(' / ') || '未标注阶段'
    : '移入图表查看';
  byId('sample-time').textContent = sample ? '最近采样 ' + sample.time.toFixed(3) + ' s' : active ? '窗口内无采样' : '';
  for (const [key, cell] of valueCells) {
    cell.textContent = Number.isFinite(sample?.[key]) ? metricsFormat.format(sample[key]) : '—';
  }
  charts.setCursor(active ? time : null, sample);
}

function selectStage(stage) {
  focusedStage = stage;
  range = stage ? [stage.start, stage.end] : [0, dataset.duration];
  byId('overview-button').setAttribute('aria-current', String(!stage));
  for (const [item, button] of stageButtons) button.setAttribute('aria-current', String(item === stage));
  byId('scope-title').textContent = stage ? stage.name : '全程总览';
  byId('scope-caption').textContent = stage
    ? stage.id + ' · 阶段时长 ' + (stage.end - stage.start).toFixed(2) + ' s'
    : '在任一图上移动游标，同步查看当前阶段与八项资源读数。';
  byId('scope-range').textContent = range[0].toFixed(2) + ' – ' + range[1].toFixed(2) + ' s';
  charts.render(dataset, range, { stage });
  updateCursor(null);
}

function showData(data, fileName, json = null) {
  dataset = data;
  sourceJson = json;
  failedFile = null;
  const isDemo = json === null;
  byId('source-type').textContent = isDemo ? '模拟示例' : '本地文件';
  byId('source-name').textContent = fileName;
  byId('reset-demo').hidden = isDemo;
  byId('apply-reference').hidden = isDemo || data.stages.length > 0;
  byId('edit-mapping').hidden = !json || !(Array.isArray(json) || Array.isArray(json.traceEvents)) || !getCounterOptions(json).length;
  byId('duration').textContent = data.duration.toFixed(2);
  byId('sample-count').textContent = data.samples.length.toLocaleString('zh-CN');
  byId('stage-count').textContent = String(data.stages.length);
  byId('stages').replaceChildren();
  stageButtons.clear();
  for (const stage of data.stages) {
    const button = document.createElement('button');
    button.className = 'stage-button';
    button.title = stage.name + ' · ' + stage.id;
    const top = document.createElement('span');
    top.className = 'stage-top';
    const name = document.createElement('span');
    name.className = 'stage-name';
    name.textContent = stage.name.replace(/（含其模型构建）$/, '');
    const duration = document.createElement('span');
    duration.className = 'stage-duration';
    duration.textContent = (stage.end - stage.start).toFixed(2);
    const id = document.createElement('span');
    id.className = 'stage-id';
    id.textContent = stage.id;
    top.append(name, duration);
    button.append(top, id);
    button.addEventListener('click', () => selectStage(stage));
    stageButtons.set(stage, button);
    byId('stages').append(button);
  }
  selectStage(null);
}

function notify(message = '', canMap = false) {
  byId('notice').hidden = !message;
  byId('notice-text').textContent = message;
  byId('retry-mapping').hidden = !canMap;
}

function resetDemo() {
  ++importVersion;
  showData(demoTrace(), 'LTX-2.5');
  notify();
}

async function readJson(file) {
  const prefix = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  let content;
  if (prefix[0] === 0x1f && prefix[1] === 0x8b) {
    if (!window.DecompressionStream) throw new Error('此浏览器无法解压 gzip。请先解压为 .json 再导入。');
    const stream = file.stream().pipeThrough(new DecompressionStream('gzip'));
    content = await new Response(stream).text();
  } else {
    content = await file.text();
  }
  try { return JSON.parse(content.replace(/^\uFEFF/, '')); }
  catch { throw new Error('文件不是有效的 JSON，请检查文件内容或从 gzip 包解压后再试。'); }
}

async function importFile(file) {
  if (!file) return;
  const version = ++importVersion;
  failedFile = null;
  notify('正在读取 ' + file.name + '…');
  let json;
  try {
    json = await readJson(file);
    if (version !== importVersion) return;
    const data = normalizeTrace(json);
    showData(data, file.name, json);
    notify();
  } catch (error) {
    if (version !== importVersion) return;
    const canMap = !!json && (Array.isArray(json) || Array.isArray(json.traceEvents)) && getCounterOptions(json).length > 0;
    if (canMap) failedFile = { json, name: file.name };
    notify('导入失败 · ' + error.message, canMap);
  }
}

async function mapFile(json, fileName) {
  const version = ++importVersion;
  try {
    const mapped = await chooseCounterMapping(json);
    if (!mapped || version !== importVersion) return;
    showData(mapped, fileName, json);
    notify();
  } catch (error) {
    notify('匹配失败 · ' + error.message, !!failedFile);
  }
}

byId('apply-reference').addEventListener('click', () => {
  const refEnd = REFERENCE_STAGES[REFERENCE_STAGES.length - 1].end;
  if (dataset.duration < refEnd) {
    notify('参考阶段延伸到 ' + refEnd.toFixed(2) + ' s，超出当前采集范围。请在 JSON 的 stages 中提供实际阶段。');
    return;
  }
  const name = byId('source-name').textContent;
  showData({ ...dataset, stages: REFERENCE_STAGES }, name, sourceJson);
  notify('已按截图给出的起止时间标注八个阶段。');
});

byId('overview-button').addEventListener('click', () => selectStage(null));
byId('retry-mapping').addEventListener('click', () => { if (failedFile) mapFile(failedFile.json, failedFile.name); });
byId('edit-mapping').addEventListener('click', () => mapFile(sourceJson, byId('source-name').textContent));
byId('import-button').addEventListener('click', () => byId('file').click());
byId('file').addEventListener('change', event => {
  const [file] = event.target.files;
  event.target.value = '';
  importFile(file);
});
byId('reset-demo').addEventListener('click', resetDemo);

let dragDepth = 0;
const hasFiles = event => Array.from(event.dataTransfer?.types || []).includes('Files');
window.addEventListener('dragenter', event => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth++;
  byId('drop-layer').hidden = false;
});
window.addEventListener('dragover', event => { if (hasFiles(event)) event.preventDefault(); });
window.addEventListener('dragleave', event => {
  if (!dragDepth) return;
  if (--dragDepth === 0) byId('drop-layer').hidden = true;
});
window.addEventListener('drop', event => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  byId('drop-layer').hidden = true;
  if (event.dataTransfer.files.length !== 1) return notify('请一次导入一个时间轴文件。');
  importFile(event.dataTransfer.files[0]);
});

byId('help-button').addEventListener('click', () => byId('help').showModal());
byId('close-help').addEventListener('click', () => byId('help').close());
byId('download-demo').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(demoTrace())], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'ltx-synthetic-example.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

resetDemo();
