import { demoTrace, normalizeTrace, REFERENCE_STAGES } from './data.js';
import { mountCharts, STAGE_COLORS } from './charts.js';
import { getCounterOptions, chooseCounterMapping } from './mapping.js';

import { readCaptureFiles } from './import-files.js';

const byId = (id) => document.getElementById(id);
const metrics = [
  ['cpu', 'CPU', '%'], ['gpu', 'GPU', '%'],
  ['rss', 'RSS', 'GiB'], ['vram', '显存', 'GiB'],
  ['read', '读取', 'MiB/s'], ['write', '写入', 'MiB/s'],
  ['rx', 'PCIe RX', 'MiB/s'], ['tx', 'PCIe TX', 'MiB/s'],
];
const metricsFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
let dataset, focusedStage, sourceJson, failedFile, sourceFilename;
let ribbonMarker;
let range = [0, 1], importVersion = 0;
const valueCells = new Map();
const stageButtons = new Map();
const ribbonButtons = new Map();
const charts = mountCharts(byId('charts'), { onCursor: updateCursor, onStage: stage => { selectStage(stage); byId('scope-title').scrollIntoView({ block: 'start' }); } });

for (const [key, name, unit] of metrics) {
  const cell = document.createElement('div');
  cell.className = 'metric';
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
  if (!dataset || !Number.isFinite(time)) return;
  const sample = nearestSample(time);
  const stages = dataset.stages.filter(stage => time >= stage.start && time < stage.end);
  byId('cursor-time').textContent = time.toFixed(2);
  byId('cursor-stage').textContent = focusedStage && time === focusedStage.end
    ? focusedStage.name + ' · 阶段终点'
    : stages.map(stage => stage.name).join(' / ') || '未标注阶段';
  byId('sample-time').textContent = sample ? '最近采样 ' + sample.time.toFixed(3) + ' s' : '窗口内无采样';
  for (const [key, cell] of valueCells) {
    cell.textContent = Number.isFinite(sample?.[key]) ? metricsFormat.format(sample[key]) : '—';
  }
  charts.setCursor(time, sample);
  if (ribbonMarker) ribbonMarker.style.left = (dataset.duration > 0 ? 100 * time / dataset.duration : 0) + '%';
}

function selectStage(stage) {
  focusedStage = stage;
  const wasMenuOpen = !byId('stage-menu').hidden;
  closeMenu(wasMenuOpen);
  range = stage ? [stage.start, stage.end] : [0, dataset.duration];
  byId('overview-button').setAttribute('aria-current', String(!stage));
  for (const [item, button] of stageButtons) button.setAttribute('aria-current', String(item === stage));
  byId('phase-toggle').setAttribute('aria-current', String(Boolean(stage)));
  for (const [item, button] of ribbonButtons) button.setAttribute('aria-pressed', String(item === stage));
  byId('scope-title').textContent = stage ? stage.name.replace(/（含其模型构建）$/, '') : '资源曲线';
  const interval = range[0].toFixed(2) + ' – ' + range[1].toFixed(2) + ' s';
  byId('scope-caption').textContent = stage ? interval + ' · ' + stage.id : interval;
  charts.render(dataset, range, { stage });
  const mid = (range[0] + range[1]) / 2;
  updateCursor(nearestSample(mid)?.time ?? mid);

}

function showData(data, fileName, json = null) {
  dataset = data;
  sourceJson = json;
  sourceFilename = fileName;
  failedFile = null;
  const isDemo = json === null;
  const count = metrics.filter(([key]) => data.samples.some(row => Number.isFinite(row[key]))).length;
  const sourceType = isDemo ? '模拟示例' : '本地采集';
  byId('source-type').textContent = sourceType + ' · ' + count + '/8 项资源指标'
    + (data.timeBasis === 'trace' ? ' · 以 Trace 起点计时' : '');
  byId('source-name').textContent = isDemo ? fileName : data.title || fileName;
  byId('source-name').title = fileName;
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
  buildRibbon(data);
  byId('phase-toggle').disabled = !data.stages.length;
  selectStage(null);
}

const shortNames = {
  'runtime.import_torch': 'Torch', 'runtime.import_pipeline': 'Pipeline',
  'prompt.encode': '文本编码', 'diffusion.1': '首次去噪', 'video.spatial_upsample': '上采样',
  'diffusion.2': '二次去噪', 'video.decode': '视频解码', 'audio.decode': '音频解码'
};

function buildRibbon(data) {
  const ribbon = byId('ribbon');
  ribbon.replaceChildren();
  ribbonButtons.clear();
  data.stages.forEach((stage, i) => {
    const button = document.createElement('button');
    button.className = 'phase-slot';
    const width = 100 * (stage.end - stage.start) / data.duration;
    button.style.left = (100 * stage.start / data.duration) + '%';
    button.style.width = width + '%';
    button.style.setProperty('--phase', STAGE_COLORS[i % STAGE_COLORS.length]);
    button.title = stage.name + ' · ' + stage.start.toFixed(2) + ' – ' + stage.end.toFixed(2) + ' s';
    button.setAttribute('aria-label', button.title);
    if (width >= 8) {
      const text = document.createElement('span');
      text.textContent = shortNames[stage.id] || stage.name;
      button.append(text);
    }
    button.addEventListener('click', () => selectStage(stage));
    ribbon.append(button);
    ribbonButtons.set(stage, button);
  });
  ribbonMarker = document.createElement('span');
  ribbonMarker.className = 'phase-marker';
  ribbon.append(ribbonMarker);
  const axis = byId('ribbon-axis');
  axis.replaceChildren();
  for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
    const tick = document.createElement('span');
    tick.textContent = metricsFormat.format(data.duration * fraction) + ' s';
    axis.append(tick);
  }
}

function closeMenu(returnFocus = false) {
  byId('stage-menu').hidden = true;
  byId('phase-toggle').setAttribute('aria-expanded', 'false');
  if (returnFocus) byId('phase-toggle').focus();
}

byId('phase-toggle').addEventListener('click', () => {
  if (!byId('stage-menu').hidden) return closeMenu();
  byId('stage-menu').hidden = false;
  byId('phase-toggle').setAttribute('aria-expanded', 'true');
  const buttons = Array.from(stageButtons.values());
  (stageButtons.get(focusedStage) || buttons[0])?.focus();
});
document.addEventListener('pointerdown', event => {
  if (!event.target.closest('.picker-anchor') && !byId('stage-menu').hidden) closeMenu();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !byId('stage-menu').hidden) closeMenu(true);
});
const media = window.matchMedia('(prefers-color-scheme: dark)');
let theme;
try { theme = localStorage.getItem('ltx-appearance'); } catch { /* storage is optional */ }
function updateTheme() {
  const dark = theme ? theme === 'dark' : media.matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const label = dark ? '切换到浅色外观' : '切换到深色外观';
  byId('theme-button').title = label;
  byId('theme-button').setAttribute('aria-label', label);
}
byId('theme-button').addEventListener('click', () => {
  theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('ltx-appearance', theme); } catch { /* storage is optional */ }
  updateTheme();
});
media.addEventListener('change', updateTheme);
updateTheme();

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

async function importFiles(files) {
  if (!files?.length) return;
  const version = ++importVersion;
  failedFile = null;
  notify('正在读取文件…');
  let json, name;
  try {
    const loaded = await readCaptureFiles(files);
    if (version !== importVersion) return;
    if (!loaded) { notify(); return; }
    ({ json, name } = loaded);
    showData(normalizeTrace(json), name, json);
    notify();
  } catch (error) {
    if (version !== importVersion) return;
    const canMap = !!json && (Array.isArray(json) || Array.isArray(json.traceEvents)) && getCounterOptions(json).length > 0;
    if (canMap) failedFile = { json, name };
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
  const name = sourceFilename;
  showData({ ...dataset, stages: REFERENCE_STAGES }, name, sourceJson);
  notify('已按截图给出的起止时间标注八个阶段。');
});

byId('overview-button').addEventListener('click', () => selectStage(null));
byId('retry-mapping').addEventListener('click', () => { if (failedFile) mapFile(failedFile.json, failedFile.name); });
byId('edit-mapping').addEventListener('click', () => mapFile(sourceJson, sourceFilename));
byId('import-button').addEventListener('click', () => byId('file').click());
byId('file').addEventListener('change', event => {
  const files = Array.from(event.target.files);
  event.target.value = '';
  importFiles(files);
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
  importFiles(Array.from(event.dataTransfer.files));
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

const embedded = byId('embedded-capture');
if (embedded) {
  try {
    const json = JSON.parse(embedded.textContent);
    showData(normalizeTrace(json), json.title || '本地采集', json);
  } catch (error) {
    resetDemo();
    notify('内嵌数据读取失败 · ' + error.message);
  }
} else {
  resetDemo();
}
