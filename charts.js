const SVG_NS = 'http://www.w3.org/2000/svg';
const PLOTS = [
  { title: '计算利用率', unit: '%', series: [['cpu', '进程 CPU'], ['gpu', 'GPU']] },
  { title: '内存与显存', unit: 'GiB', series: [['rss', '进程 RSS'], ['vram', '设备显存']] },
  { title: '存储 I/O', unit: 'MiB/s', series: [['read', '读取'], ['write', '写入']] },
  { title: 'PCIe 吞吐量', unit: 'MiB/s', series: [['rx', '设备 RX'], ['tx', '设备 TX']] },
];
const COLORS = ['#2863da', '#078673'];
const STAGE_COLORS = ['#7b8cba', '#7883b9', '#0e927e', '#366dd6', '#aa7a25', '#4772c2', '#8e73bd', '#a574aa'];
const format = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const number = (value) => format.format(value);
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

function html(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

function svg(tag, attrs, text) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  if (text !== undefined) el.textContent = text;
  return el;
}

function firstAt(samples, time, afterEqual = false) {
  let lo = 0;
  let hi = samples.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const t = samples[mid].time;
    if (t < time || (afterEqual && t === time)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function tickSize(approx) {
  if (!(approx > 0)) return 1;
  const unit = 10 ** Math.floor(Math.log10(approx));
  const norm = approx / unit;
  return ([1, 2, 2.5, 5, 10].find(n => n >= norm) || 10) * unit;
}

function axisNumber(value, step) {
  if (value === 0) return '0';
  if (value >= 1e6) return Number((value / 1e6).toPrecision(3)) + 'M';
  if (value >= 1e3) return Number((value / 1e3).toPrecision(3)) + 'k';
  const decimals = Math.min(8, Math.max(0, Math.ceil(-Math.log10(step)) + 1));
  return String(Number(value.toFixed(decimals)));
}

function xGrid(root, layout, range, bottom) {
  const [start, end] = range;
  const { left, right, scaleX, top } = layout;
  const step = tickSize((end - start) / Math.max(2, Math.floor((right - left) / 83)));
  const first = Math.ceil(start / step - 1e-9) * step;
  for (let i = 0; i < 40; i++) {
    const value = first + i * step;
    if (value > end + step * 1e-8) break;
    const x = scaleX(value);
    root.append(svg('line', { x1: x, x2: x, y1: top, y2: bottom, class: 'lc-grid lc-grid-x' }));
    const anchor = x < left + 9 ? 'start' : x > right - 9 ? 'end' : 'middle';
    root.append(svg('text', { x, y: bottom + 16, 'text-anchor': anchor, class: 'lc-tick' }, axisNumber(value, step) + ' s'));
  }
}

// Preserve each pixel column's first, minimum, maximum and last value. A gap
// explicitly recorded as null always breaks the path even in a dense capture.
function seriesPath(samples, key, scaleX, scaleY) {
  let line = '', dots = '', bucket = null, previous = null, runLength = 0;
  function flush() {
    if (!bucket) return;
    const values = [...new Set([bucket.first, bucket.min, bucket.max, bucket.last])].sort((a, b) => a.time - b.time);
    for (const row of values) {
      const x = scaleX(row.time).toFixed(2), y = scaleY(row[key]).toFixed(2);
      line += (runLength ? 'L' : 'M') + x + ',' + y;
      previous = [x, y];
      runLength++;
    }
    bucket = null;
  }
  function finishRun() {
    flush();
    if (runLength === 1) dots += 'M' + previous.join(',') + 'l0.01,0';
    runLength = 0;
  }
  for (const row of samples) {
    if (!Number.isFinite(row[key])) {
      finishRun();
      continue;
    }
    const pixel = Math.floor(scaleX(row.time));
    if (!bucket || pixel !== bucket.pixel) {
      flush();
      bucket = { pixel, first: row, min: row, max: row, last: row };
    } else {
      if (row[key] < bucket.min[key]) bucket.min = row;
      if (row[key] > bucket.max[key]) bucket.max = row;
      bucket.last = row;
    }
  }
  finishRun();
  return { line, dots };
}

function section(title, unit) {
  const block = html('section', 'lc-panel');
  const head = html('div', 'lc-head');
  const titleGroup = html('div', 'lc-title-group');
  titleGroup.append(html('h3', 'lc-title', title), html('span', 'lc-unit', unit));
  head.append(titleGroup);
  block.append(head);
  return { block, head };
}

function cursorOverlay(root, layout, bottom) {
  const group = svg('g', { class: 'lc-cursor', visibility: 'hidden', 'aria-hidden': 'true' });
  const line = svg('line', { x1: 0, x2: 0, y1: layout.top - 2, y2: bottom + 1, class: 'lc-crosshair' });
  const label = svg('g', {});
  const text = svg('text', { x: 0, y: 13, 'text-anchor': 'middle' });
  const background = svg('rect', { x: -32, y: 0, width: 64, height: 18, rx: 4 });
  label.append(background, text);
  group.append(line, label);
  root.append(group);
  return (time) => {
    group.setAttribute('visibility', time === null ? 'hidden' : 'visible');
    if (time === null) return;
    const x = layout.scaleX(time);
    line.setAttribute('transform', 'translate(' + x + ' 0)');
    const value = time.toFixed(2) + ' s';
    const half = Math.min((layout.right - layout.left) / 2, Math.max(27, value.length * 3.7 + 6));
    background.setAttribute('x', -half);
    background.setAttribute('width', half * 2);
    label.setAttribute('transform', 'translate(' + clamp(x, layout.left + half, layout.right - half) + ' ' + (bottom + 3) + ')');
    text.textContent = value;
  };
}

function metricPanel(config, samples, range, layout) {
  const { block, head } = section(config.title, config.unit);
  const legend = html('div', 'lc-legend');
  const values = config.series.map(([, name], i) => {
    const item = html('span', 'lc-legend-item');
    const line = html('i', 'lc-line-key');
    line.style.backgroundColor = COLORS[i];
    const value = html('span', 'lc-legend-value');
    item.append(line, html('span', '', name), value);
    legend.append(item);
    return value;
  });
  head.append(legend);
  const bottom = 90;
  const root = svg('svg', { class: 'lc-plot', viewBox: '0 0 ' + layout.width + ' 113', width: '100%', height: 113,
    role: 'slider', tabindex: 0, 'aria-label': config.title + '时间游标', 'aria-valuemin': range[0], 'aria-valuemax': range[1], 'aria-valuenow': range[0] });
  const { left, right, top, scaleX } = layout;
  xGrid(root, layout, range, bottom);
  let maximum = 0, hasData = false;
  for (const row of samples) {
    for (const [key] of config.series) {
      if (Number.isFinite(row[key])) {
        hasData = true;
        maximum = Math.max(maximum, row[key]);
      }
    }
  }
  const step = config.unit === '%' ? 50 : tickSize((maximum || 1) / 3);
  const ceiling = config.unit === '%' ? 100 : Math.max(step, Math.ceil((maximum || 1) / step) * step);
  const scaleY = (value) => bottom - (bottom - top) * value / ceiling;
  for (let i = 0; i <= Math.round(ceiling / step); i++) {
    const value = i * step, y = scaleY(value);
    root.append(svg('line', { x1: left, x2: right, y1: y, y2: y, class: 'lc-grid' }));
    root.append(svg('text', { x: left - 8, y: y + 4, 'text-anchor': 'end', class: 'lc-tick' }, axisNumber(value, step)));
  }
  config.series.forEach(([key], i) => {
    const { line, dots } = seriesPath(samples, key, scaleX, scaleY);
    root.append(svg('path', { d: line, class: 'lc-series', stroke: COLORS[i] }));
    if (dots) root.append(svg('path', { d: dots, class: 'lc-dot-series', stroke: COLORS[i] }));
  });
  if (!hasData) root.append(svg('text', { x: (left + right) / 2, y: (top + bottom) / 2, 'text-anchor': 'middle', class: 'lc-empty' }, '当前范围无采样'));
  const overlay = cursorOverlay(root, layout, bottom);
  const marks = COLORS.map(color => {
    const mark = svg('circle', { r: 3.6, fill: color, stroke: '#fff', 'stroke-width': 1.5, visibility: 'hidden', 'pointer-events': 'none' });
    root.append(mark);
    return mark;
  });
  block.append(root);
  return { block, root, update(time, sample) {
    overlay(time);
    if (time !== null) root.setAttribute('aria-valuenow', time.toFixed(3));
    for (let i = 0; i < config.series.length; i++) {
      const key = config.series[i][0], v = sample?.[key];
      const show = time !== null && Number.isFinite(v);
      values[i].textContent = time !== null ? (show ? number(v) + ' ' + config.unit : '—') : '';
      marks[i].setAttribute('visibility', show ? 'visible' : 'hidden');
      if (show) {
        marks[i].setAttribute('cx', scaleX(sample.time));
        marks[i].setAttribute('cy', scaleY(v));
      }
    }
  }};
}

function stagePanel(stages, range, layout, onStage) {
  const { block, head } = section('阶段时间线', 's');
  head.append(html('span', 'lc-phase-hint', '点击阶段查看局部曲线'));
  const visible = stages.map((stage, index) => ({ stage, color: STAGE_COLORS[index % STAGE_COLORS.length] }))
    .filter(({ stage }) => stage.end > range[0] && stage.start < range[1]);
  const lane = 27, bottom = layout.top + Math.max(1, visible.length) * lane + 2;
  const root = svg('svg', { class: 'lc-plot lc-stage-plot', viewBox: '0 0 ' + layout.width + ' ' + (bottom + 24),
    width: '100%', height: bottom + 24, role: 'group', tabindex: 0, 'aria-label': '阶段时间线' });
  xGrid(root, layout, range, bottom);
  const { left, right, scaleX } = layout;
  const rows = visible.map(({ stage: s, color }, i) => {
    const y = layout.top + i * lane + 13;
    const x1 = scaleX(Math.max(range[0], s.start)), x2 = scaleX(Math.min(range[1], s.end));
    const group = svg('g', { class: 'lc-lane', role: 'button', tabindex: 0, 'aria-label': s.name + '，' + number(s.start) + ' 至 ' + number(s.end) + ' 秒，查看阶段' });
    const title = svg('title', {}, s.name + ' · ' + s.id + ' · ' + number(s.start) + '–' + number(s.end) + ' s');
    const hit = svg('rect', { x: left, y: y - lane / 2, width: right - left, height: lane, fill: 'transparent', class: 'lc-lane-hit', rx: 3 });
    const track = svg('line', { x1: left, x2: right, y1: y, y2: y, class: 'lc-track' });
    const bar = svg('rect', { x: x1, y: y - 6, width: Math.max(1, x2 - x1), height: 12, rx: 3, fill: color });
    let anchor = 'start', labelX = x2 + 6, room = right - labelX;
    if (x1 - left - 6 > room) { anchor = 'end'; labelX = x1 - 6; room = labelX - left; }
    let inside = false;
    if (x2 - x1 - 10 > room) { inside = true; anchor = 'start'; labelX = x1 + 5; room = x2 - x1 - 10; bar.setAttribute('height', 18); bar.setAttribute('y', y - 9); }
    const label = svg('text', { x: labelX, y: y + 4, 'text-anchor': anchor, class: 'lc-stage-name' + (inside ? ' lc-inside' : '') });
    const shortened = Math.floor(Math.max(0, room) / 12);
    label.textContent = s.name.length <= shortened ? s.name : s.name.slice(0, Math.max(0, shortened - 1)) + '…';
    group.append(title, hit, track, bar, label);
    group.addEventListener('click', () => onStage(s));
    group.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onStage(s);
      }
    });
    root.append(group);
    return { group, s };
  });
  if (!rows.length) root.append(svg('text', { x: (left + right) / 2, y: layout.top + 17, 'text-anchor': 'middle', class: 'lc-empty' }, '当前范围未标注阶段'));
  const overlay = cursorOverlay(root, layout, bottom);
  block.append(root);
  return { block, root, update(time) {
    overlay(time);
    for (const { group, s } of rows) group.classList.toggle('lc-active', time !== null && time >= s.start && time < s.end);
  }};
}

export function mountCharts(container, { onCursor, onStage }) {
  let data = null, range = [0, 1], panels = [], width = 0, currentTime = null, currentSample = null;
  let resizeFrame = 0, includeEnd = true;
  container.classList.add('lc-charts');
  function contentWidth() {
    const style = getComputedStyle(container);
    return Math.max(1, container.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
  }

  function setCursor(time, sample) {
    currentTime = Number.isFinite(time) && time >= range[0] && time <= range[1] ? time : null;
    currentSample = sample && sample.time >= range[0] &&
      (sample.time < range[1] || (includeEnd && sample.time === range[1])) ? sample : null;
    for (const panel of panels) panel.update(currentTime, currentSample);
  }

  function moveKey(event) {
    const [start, end] = range;
    const time = currentTime ?? start;
    const samples = data.samples;
    let next;
    if (event.key === 'Home') next = start;
    else if (event.key === 'End') next = end;
    else if (event.key === 'ArrowRight') {
      const idx = firstAt(samples, time, true);
      next = Math.min(end, samples[idx]?.time ?? end);
    } else if (event.key === 'ArrowLeft') {
      const idx = firstAt(samples, time) - 1;
      next = Math.max(start, samples[idx]?.time ?? start);
    } else return;
    event.preventDefault();
    onCursor(next);
  }

  function draw() {
    if (!data) return;
    width = contentWidth();
    const left = width < 520 ? 36 : 48, right = Math.max(left + 1, width - 16);
    const [start, end] = range, span = end - start;
    const layout = { left, right, width, top: 9, scaleX: t => left + (t - start) / (span || 1) * (right - left) };
    const samples = data.samples.slice(firstAt(data.samples, start), firstAt(data.samples, end, includeEnd));
    panels = PLOTS.map(config => metricPanel(config, samples, range, layout));
    panels.push(stagePanel(data.stages, range, layout, onStage));
    container.replaceChildren(...panels.map(panel => panel.block));
    for (const { root } of panels) {
      function point(event) {
        const rect = root.getBoundingClientRect();
        const x = (event.clientX - rect.left) / rect.width * width;
        onCursor(start + clamp((x - left) / (right - left), 0, 1) * span);
      }
      root.addEventListener('pointermove', point);
      root.addEventListener('pointerdown', point);
      root.addEventListener('pointerleave', event => { if (event.pointerType !== 'touch') onCursor(null); });
      root.addEventListener('keydown', moveKey);
      root.addEventListener('focus', () => { if (currentTime === null) onCursor(start); });
    }
    setCursor(currentTime, currentSample);
  }

  const observer = new ResizeObserver(() => {
    if (contentWidth() === width) return;
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(draw);
  });
  observer.observe(container);
  return {
    render(newData, newRange, { stage = null } = {}) {
      data = newData;
      range = newRange;
      includeEnd = !stage;
      draw();
    },
    setCursor,
    destroy() {
      observer.disconnect();
      cancelAnimationFrame(resizeFrame);
      panels = [];
      data = null;
      container.replaceChildren();
      container.classList.remove('lc-charts');
    },
  };
}
