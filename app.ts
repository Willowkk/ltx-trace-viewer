import { demoTrace, normalizeTrace, REFERENCE_STAGES } from './data.ts';
import { mountCharts, STAGE_COLORS } from './charts.ts';
import { getCounterOptions, chooseCounterMapping } from './mapping.js';
import { bindScrubber } from './scrubber.ts';
import { readCaptureFiles } from './import-files.js';
import { mountInspector } from './inspector.js';

import { lowerBound, METRICS } from './model.ts';
import type { MetricKey, Readings, Sample, Stage, TimeRange, Trace } from './model.ts';
import './styles.css';
import './inspector.css';
import './charts.css';
import './mapping.css';

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error('缺少页面元素 ' + id);
  return element as T;
}
const metricsFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
let dataset: Trace;
let focusedStage: Stage | null = null;
let sourceJson: unknown;
let failedFile: { json: unknown; name: string } | null = null;
let sourceFilename: string;
let ribbonMarker: HTMLSpanElement | undefined;
let displayedSample: Sample | null | undefined;
let readings: Readings;
let stageInterval: { start: number; end: number; active: Stage[]; label: string } | null = null;
const readingCache = new WeakMap<Sample, Readings>();
const cursorTime = byId('cursor-time');
const cursorStage = byId('cursor-stage');
const sampleTime = byId('sample-time');
const stageRibbon = byId('ribbon');
let range: TimeRange = [0, 1];
let importVersion = 0;
const valueCells = new Map<MetricKey, HTMLSpanElement>();
const stageButtons = new Map<Stage, HTMLButtonElement>();
const ribbonButtons = new Map<Stage, HTMLButtonElement>();
const charts = mountCharts(byId('charts'), {
  onCursor: updateCursor,
  onStage(stage) {
    selectStage(stage);
    byId('scope-title').scrollIntoView({ block: 'start' });
  },
});

for (const { key, name, unit } of METRICS) {
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
const setText = mountInspector(document.querySelector('.inspector'));

// Only readings inside the displayed interval can appear in a stage detail.
function nearestSample(time: number): Sample | null {
  const rows = dataset.samples;
  const pos = lowerBound(rows, time);
  const before = rows[pos - 1];
  const after = rows[pos];
  function inRange(row: Sample | undefined): row is Sample {
    return !!row && row.time >= range[0] && (focusedStage ? row.time < range[1] : row.time <= range[1]);
  }
  if (!inRange(before)) return inRange(after) ? after : null;
  if (!inRange(after)) return before;
  return time - before.time <= after.time - time ? before : after;
}

// Stage membership is constant between consecutive start/end boundaries.
// Keep the same list there so the labels and highlighted rows can skip work.
function stagesAt(time: number) {
  if (stageInterval && time >= stageInterval.start && time < stageInterval.end) return stageInterval;
  let start = -Infinity, end = Infinity;
  const active: Stage[] = [];
  for (const stage of dataset.stages) {
    if (stage.start > time) {
      end = Math.min(end, stage.start);
    } else if (stage.end <= time) {
      start = Math.max(start, stage.end);
    } else {
      start = Math.max(start, stage.start);
      end = Math.min(end, stage.end);
      active.push(stage);
    }
  }
  stageInterval = { start, end, active, label: active.map(stage => stage.name).join(' / ') || '未标注阶段' };
  return stageInterval;
}

function formatReadings(sample: Sample | null): Readings {
  const cached = sample && readingCache.get(sample);
  if (cached) return cached;
  const values = {} as Readings;
  for (const { key } of METRICS) {
    const value = sample?.[key];
    values[key] = typeof value === 'number' && Number.isFinite(value) ? metricsFormat.format(value) : '—';
  }
  if (sample) readingCache.set(sample, values);
  return values;
}

function updateCursor(time: number) {
  if (!dataset || !Number.isFinite(time)) return;
  const sample = nearestSample(time);
  const interval = stagesAt(time);
  setText(cursorTime, time.toFixed(2));
  const name = focusedStage && time === focusedStage.end
    ? focusedStage.name + ' · 阶段终点'
    : interval.label;
  if (cursorStage.textContent !== name) {
    setText(cursorStage, name);
    cursorStage.title = name;
  }
  if (displayedSample !== sample) {
    displayedSample = sample;
    readings = formatReadings(sample);
    setText(sampleTime, sample ? '最近采样 ' + sample.time.toFixed(3) + ' s' : '窗口内无采样');
    for (const [key, cell] of valueCells) {
      setText(cell, readings[key]);
    }
  }
  charts.setCursor(time, sample, readings, interval.active);
  ribbonFraction = dataset.duration > 0 ? time / dataset.duration : 0;
  positionRibbonMarker();
}

function selectStage(stage: Stage | null, initializeCursor = true) {
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
  if (initializeCursor) {
    const mid = (range[0] + range[1]) / 2;
    updateCursor(nearestSample(mid)?.time ?? mid);
  }
}

function hasCounters(json: unknown): boolean {
  return getCounterOptions(json).length > 0;
}

function showData(data: Trace, fileName: string, json: unknown = null) {
  ribbonInput.reset();
  dataset = data;
  stageInterval = null;
  displayedSample = undefined;
  sourceJson = json;
  sourceFilename = fileName;
  failedFile = null;
  const isDemo = json === null;
  const count = METRICS.filter(({ key }) => data.samples.some(row => Number.isFinite(row[key]))).length;
  const sourceType = isDemo ? '模拟示例' : '本地采集';
  byId('source-type').textContent = sourceType + ' · ' + count + '/8 项资源指标'
    + (data.timeBasis === 'trace' ? ' · 以 Trace 起点计时' : '');
  byId('source-name').textContent = isDemo ? fileName : data.title || fileName;
  byId('source-name').title = fileName;
  byId('reset-demo').hidden = isDemo;
  byId('apply-reference').hidden = isDemo || data.stages.length > 0;
  byId('edit-mapping').hidden = !hasCounters(json);
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
  byId<HTMLButtonElement>('phase-toggle').disabled = !data.stages.length;
  selectStage(null);
}

const shortNames: Record<string, string> = {
  'runtime.import_torch': 'Torch', 'runtime.import_pipeline': 'Pipeline',
  'prompt.encode': '文本编码', 'diffusion.1': '首次去噪', 'video.spatial_upsample': '上采样',
  'diffusion.2': '二次去噪', 'video.decode': '视频解码', 'audio.decode': '音频解码'
};

// Translate only the two-pixel marker. The ribbon width comes from layout
// notifications so scrubbing never has to measure it.
let ribbonWidth = 0, ribbonFraction = 0;
function positionRibbonMarker() {
  if (ribbonMarker) ribbonMarker.style.transform = 'translate3d(' + (ribbonWidth * ribbonFraction) + 'px,0,0)';
}
new ResizeObserver(([entry]) => {
  ribbonWidth = entry.contentRect.width;
  positionRibbonMarker();
}).observe(stageRibbon);

function buildRibbon(data: Trace) {
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
  const markerClip = document.createElement('span');
  markerClip.className = 'phase-marker-clip';
  markerClip.append(ribbonMarker);
  ribbon.append(markerClip);
  const axis = byId('ribbon-axis');
  axis.replaceChildren();
  for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
    const tick = document.createElement('span');
    tick.textContent = metricsFormat.format(data.duration * fraction) + ' s';
    axis.append(tick);
  }
}

const ribbonInput = bindScrubber(stageRibbon, {
  hover: false,
  onDragStart() {
    if (focusedStage) selectStage(null, false);
  },
  onPosition(fraction) {
    updateCursor(Math.max(0, Math.min(1, fraction)) * dataset.duration);
  },
});

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
  ((focusedStage && stageButtons.get(focusedStage)) || buttons[0])?.focus();
});
document.addEventListener('pointerdown', event => {
  if (event.target instanceof Element && !event.target.closest('.picker-anchor') && !byId('stage-menu').hidden) closeMenu();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !byId('stage-menu').hidden) closeMenu(true);
});
const media = window.matchMedia('(prefers-color-scheme: dark)');
let theme: string | null = null;
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

async function importFiles(files: File[]) {
  if (!files?.length) return;
  const version = ++importVersion;
  failedFile = null;
  notify('正在读取文件…');
  let json: unknown;
  let name = '';
  try {
    const loaded = await readCaptureFiles(files);
    if (version !== importVersion) return;
    if (!loaded) { notify(); return; }
    ({ json, name } = loaded);
    showData(normalizeTrace(json), name, json);
    notify();
  } catch (error) {
    if (version !== importVersion) return;
    const canMap = hasCounters(json);
    if (canMap) failedFile = { json, name };
    notify('导入失败 · ' + (error instanceof Error ? error.message : String(error)), canMap);
  }
}

async function mapFile(json: unknown, fileName: string) {
  const version = ++importVersion;
  try {
    const mapped = await chooseCounterMapping(json);
    if (!mapped || version !== importVersion) return;
    showData(mapped, fileName, json);
    notify();
  } catch (error) {
    if (version !== importVersion) return;
    notify('匹配失败 · ' + (error instanceof Error ? error.message : String(error)), !!failedFile);
  }
}

byId('apply-reference').addEventListener('click', () => {
  const refEnd = REFERENCE_STAGES[REFERENCE_STAGES.length - 1].end;
  if (dataset.duration < refEnd) {
    notify('参考阶段延伸到 ' + refEnd.toFixed(2) + ' s，超出当前采集范围。请在 JSON 的 stages 中提供实际阶段。');
    return;
  }
  const name = sourceFilename;
  showData({ ...dataset, stages: [...REFERENCE_STAGES] }, name, sourceJson);
  notify('已按截图给出的起止时间标注八个阶段。');
});

byId('overview-button').addEventListener('click', () => selectStage(null));
byId('retry-mapping').addEventListener('click', () => { if (failedFile) mapFile(failedFile.json, failedFile.name); });
byId('edit-mapping').addEventListener('click', () => mapFile(sourceJson, sourceFilename));
const fileInput = byId<HTMLInputElement>('file');
byId('import-button').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const files = Array.from(fileInput.files ?? []);
  fileInput.value = '';
  importFiles(files);
});
byId('reset-demo').addEventListener('click', resetDemo);

let dragDepth = 0;
const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types || []).includes('Files');
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
  importFiles(Array.from(event.dataTransfer?.files ?? []));
});

byId('help-button').addEventListener('click', () => byId<HTMLDialogElement>('help').showModal());
byId('close-help').addEventListener('click', () => byId<HTMLDialogElement>('help').close());
byId('download-demo').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(demoTrace())], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'ltx-synthetic-example.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

const embedded = document.getElementById('embedded-capture');
if (embedded) {
  try {
    const json = JSON.parse(embedded.textContent);
    showData(normalizeTrace(json), json.title || '本地采集', json);
  } catch (error) {
    resetDemo();
    notify('内嵌数据读取失败 · ' + (error instanceof Error ? error.message : String(error)));
  }
} else {
  resetDemo();
}
