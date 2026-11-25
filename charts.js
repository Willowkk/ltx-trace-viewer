import { bindScrubber } from './scrubber.js?v=525bef86689b';

const SVG_NS = 'http://www.w3.org/2000/svg';
const PLOTS = [
  { title: '计算利用率', unit: '%', series: [['cpu', '进程 CPU'], ['gpu', 'GPU']] },
  { title: '内存与显存', unit: 'GiB', series: [['rss', '进程 RSS'], ['vram', '设备显存']] },
  { title: '存储 I/O', unit: 'MiB/s', series: [['read', '读取'], ['write', '写入']] },
  { title: 'PCIe 吞吐量', unit: 'MiB/s', series: [['rx', '设备 RX'], ['tx', '设备 TX']] },
];
const COLORS = ['var(--lc-blue)', 'var(--lc-orange)'];
export const STAGE_COLORS = ['#78808c', '#657694', '#6e63bb', '#0071e3', '#3a898a', '#3e61ba', '#50836c', '#a96275'];
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
  const step = tickSize((end - start) / Math.max(2, Math.floor((right - left) / 87)));
  const first = Math.ceil(start / step - 1e-9) * step;
  for (let i = 0; i < 40; i++) {
    const value = first + i * step;
    if (value > end + step * 1e-8) break;
    const x = scaleX(value);
    root.append(svg('line', { x1: x, x2: x, y1: top, y2: bottom, class: 'lc-grid lc-grid-x' }));
    const label = axisNumber(value, step) + ' s';
    const halfWidth = label.length * 3.5;
    const anchor = x < left + halfWidth ? 'start' : x > right - halfWidth ? 'end' : 'middle';
    root.append(svg('text', { x, y: bottom + 17, 'text-anchor': anchor, class: 'lc-tick' }, label));
  }
}

// Preserve each pixel column's first, minimum, maximum and last value. A gap
// explicitly recorded as null always breaks the path even in a dense capture.
function seriesPath(samples, key, scaleX, scaleY, baseline) {
  let line = '', area = '', dots = '', run = '', runLength = 0;
  let bucket = null, firstX, lastX, lastY;
  function flush() {
    if (!bucket) return;
    const values = [...new Set([bucket.first, bucket.min, bucket.max, bucket.last])].sort((a, b) => a.time - b.time);
    for (const row of values) {
      const x = scaleX(row.time).toFixed(2), y = scaleY(row[key]).toFixed(2);
      run += (runLength ? 'L' : 'M') + x + ',' + y;
      if (!runLength) firstX = x;
      lastX = x;
      lastY = y;
      runLength++;
    }
    bucket = null;
  }
  function finishRun() {
    flush();
    line += run;
    if (runLength === 1) dots += 'M' + lastX + ',' + lastY + 'l0.01,0';
    if (runLength > 1 && baseline !== undefined) area += run + 'V' + baseline + 'H' + firstX + 'Z';
    run = '';
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
  return { line, area, dots };
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

// Rasterize the time once at the display scale. The five axes can copy the
// same tiny glyph bitmap as they move without laying out five text labels.
function makeTimeStamp(width, ratio, fontFamily) {
  const source = html('canvas');
  source.width = Math.max(1, Math.ceil(width * ratio));
  source.height = Math.ceil(19 * ratio);
  const context = source.getContext('2d');
  if (context) {
    context.scale(ratio, ratio);
    context.font = '600 11px ' + fontFamily;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
  }
  let lastLabel, lastInk;
  return { source: context ? source : null, draw(label, ink) {
    if (!context || (lastLabel === label && lastInk === ink)) return;
    context.clearRect(0, 0, width + 1, 20);
    context.fillStyle = ink;
    context.fillText(label, width / 2, 10);
    lastLabel = label;
    lastInk = ink;
  }};
}

function cursorOverlay(root, layout, bottom) {
  const frame = html('div', 'lc-frame');
  const cursor = html('div', 'lc-cursor');
  cursor.setAttribute('aria-hidden', 'true');
  cursor.hidden = true;
  cursor.style.top = (layout.top - 2) + 'px';
  cursor.style.height = (bottom + 3 - layout.top) + 'px';
  let badge = html('canvas', 'lc-cursor-time');
  const source = layout.stamp.source;
  const drawing = source && badge.getContext('2d');
  if (drawing) {
    badge.width = source.width;
    badge.height = source.height;
  } else {
    badge = html('span', 'lc-cursor-time');
  }
  badge.style.width = (layout.badgeHalf * 2) + 'px';
  badge.style.left = -layout.badgeHalf + 'px';
  const text = document.createTextNode('');
  badge.append(text);
  cursor.append(badge);
  frame.append(root, cursor);
  let lastOffset, lastInk;
  return { frame, update(position) {
    if (!position) {
      if (!cursor.hidden) cursor.hidden = true;
      return;
    }
    if (cursor.hidden) cursor.hidden = false;
    cursor.style.transform = position.transform;
    if (text.data !== position.label || lastInk !== position.ink) {
      drawing?.clearRect(0, 0, source.width, source.height);
      drawing?.drawImage(source, 0, 0);
      text.data = position.label;
      lastInk = position.ink;
    }
    if (lastOffset !== position.badgeOffset) {
      lastOffset = position.badgeOffset;
      badge.style.transform = lastOffset;
    }
  }};
}

function legendReading(slot, unit, layout) {
  let value = html('canvas', 'lc-legend-value');
  const text = document.createTextNode('');
  const context = value.getContext('2d');
  // Phone charts already put the unit in the panel heading.
  const paintUnits = layout.width > 390;
  const reservation = paintUnits ? slot.dataset.reserve : slot.dataset.numberReserve;
  const height = 17;
  let width;
  if (context) {
    const font = '600 12px ' + layout.fontFamily;
    context.font = font;
    width = Math.max(1, Math.ceil(context.measureText(reservation).width));
    value.width = Math.ceil(width * layout.ratio);
    value.height = Math.ceil(height * layout.ratio);
    context.scale(layout.ratio, layout.ratio);
    context.font = font;
    context.textBaseline = 'middle';
  } else {
    value = html('span', 'lc-legend-value');
  }
  value.append(text);
  slot.append(value);
  let lastInk, lastValue;
  return function updateReading(reading, measured, ink) {
    const label = measured ? reading + ' ' + unit : reading;
    if (lastInk === ink && lastValue === label) return;
    const visibleLabel = paintUnits ? label : reading;
    text.data = context ? label : visibleLabel;
    if (context) {
      context.clearRect(0, 0, width + 1, height + 1);
      context.fillStyle = ink;
      context.fillText(visibleLabel, 0, height / 2 + .5);
    }
    lastValue = label;
    lastInk = ink;
  };
}

function metricPanel(config, samples, range, layout) {
  const { block, head } = section(config.title, config.unit);
  const maxima = config.series.map(() => null);
  for (const row of samples) {
    config.series.forEach(([key], i) => {
      if (Number.isFinite(row[key])) maxima[i] = Math.max(maxima[i] ?? 0, row[key]);
    });
  }
  const legend = html('div', 'lc-legend');
  const values = config.series.map(([, name], i) => {
    const item = html('span', 'lc-legend-item');
    const line = html('i', 'lc-line-key');
    line.style.backgroundColor = COLORS[i];
    // Reserve the widest possible reading once. The changing text stays
    // inside this slot, even when a thousands separator or a decimal appears.
    const slot = html('span', 'lc-legend-slot');
    slot.dataset.numberReserve = maxima[i] === null ? '—' : number(Math.ceil(maxima[i])) + '.88';
    slot.dataset.reserve = maxima[i] === null ? '—' : slot.dataset.numberReserve + ' ' + config.unit;
    const update = legendReading(slot, config.unit, layout);
    item.append(line, html('span', '', name), slot);
    legend.append(item);
    return update;
  });
  head.append(legend);
  const bottom = layout.width < 560 ? 93 : 106;
  const height = bottom + 25;
  const root = svg('svg', { class: 'lc-plot', viewBox: '0 0 ' + layout.width + ' ' + height, width: '100%', height,
    role: 'slider', tabindex: 0, 'aria-label': config.title + '时间游标', 'aria-valuemin': range[0], 'aria-valuemax': range[1], 'aria-valuenow': range[0] });
  const { left, right, top, scaleX } = layout;
  xGrid(root, layout, range, bottom);
  const maximum = Math.max(...maxima);
  const hasData = maxima.some(value => value !== null);
  const step = config.unit === '%' ? 50 : tickSize((maximum || 1) / 3);
  const ceiling = config.unit === '%' ? 100 : Math.max(step, Math.ceil((maximum || 1) / step) * step);
  const scaleY = (value) => bottom - (bottom - top) * value / ceiling;
  for (let i = 0; i <= Math.round(ceiling / step); i++) {
    const value = i * step, y = scaleY(value);
    root.append(svg('line', { x1: left, x2: right, y1: y, y2: y, class: i ? 'lc-grid' : 'lc-grid lc-baseline' }));
    root.append(svg('text', { x: left - 9, y: y + 4, 'text-anchor': 'end', class: 'lc-tick' }, axisNumber(value, step)));
  }
  config.series.forEach(([key], i) => {
    const { line, area, dots } = seriesPath(samples, key, scaleX, scaleY, i === 0 ? bottom : undefined);
    if (area) root.append(svg('path', { d: area, class: 'lc-area' }));
    root.append(svg('path', { d: line, class: 'lc-series', stroke: COLORS[i] }));
    if (dots) root.append(svg('path', { d: dots, class: 'lc-dot-series', stroke: COLORS[i] }));
  });
  if (!hasData) root.append(svg('text', { x: (left + right) / 2, y: (top + bottom) / 2, 'text-anchor': 'middle', class: 'lc-empty' }, '当前范围无采样'));
  const overlay = cursorOverlay(root, layout, bottom);
  const marks = COLORS.map(color => {
    const mark = html('i', 'lc-sample-dot');
    mark.setAttribute('aria-hidden', 'true');
    mark.hidden = true;
    mark.style.backgroundColor = color;
    overlay.frame.append(mark);
    return mark;
  });
  let lastSample, lastVisible, lastInk;
  let spokenReadings;
  block.append(overlay.frame);
  return { block, root, syncSlider(time) {
    const value = time.toFixed(3);
    const summary = time.toFixed(2) + ' 秒，' + config.series.map(([key, name]) => {
      const reading = spokenReadings?.[key];
      return name + (reading && reading !== '—' ? ' ' + reading + ' ' + config.unit : ' 无采样');
    }).join('，');
    if (root.getAttribute('aria-valuenow') !== value) root.setAttribute('aria-valuenow', value);
    if (root.getAttribute('aria-valuetext') !== summary) root.setAttribute('aria-valuetext', summary);
  }, update(position, sample, readings) {
    overlay.update(position);
    const visible = position !== null;
    const ink = position?.metricInk;
    if (lastSample === sample && visible === lastVisible && lastInk === ink) return;
    lastInk = ink;
    spokenReadings = sample ? readings : null;
    lastSample = sample;
    lastVisible = visible;
    for (let i = 0; i < config.series.length; i++) {
      const key = config.series[i][0];
      const measured = visible && Number.isFinite(sample?.[key]);
      const text = measured ? readings[key] : visible ? '—' : '';
      values[i](text, measured, ink);
      if (marks[i].hidden === measured) marks[i].hidden = !measured;
      if (measured) {
        marks[i].style.transform = 'translate3d(' + scaleX(sample.time) + 'px,' + scaleY(sample[key]) + 'px,0)';
      }
    }
  }};
}

function stagePanel(stages, range, layout, onStage) {
  const { block, head } = section('阶段时间线', 's');
  head.append(html('span', 'lc-phase-hint', '点击阶段查看局部曲线'));
  const visible = stages.map((stage, index) => ({ stage, color: STAGE_COLORS[index % STAGE_COLORS.length] }))
    .filter(({ stage }) => stage.end > range[0] && stage.start < range[1]);
  const lane = 26, bottom = layout.top + Math.max(1, visible.length) * lane + 2;
  const root = svg('svg', { class: 'lc-plot lc-stage-plot', viewBox: '0 0 ' + layout.width + ' ' + (bottom + 24),
    width: '100%', height: bottom + 24, role: 'group', tabindex: 0, 'aria-label': '阶段时间线' });
  xGrid(root, layout, range, bottom);
  const { left, right, scaleX } = layout;
  const overlay = cursorOverlay(root, layout, bottom);
  // Highlights sit behind a transparent, static SVG. Only as many strips as
  // there are simultaneous stages ever need a composited surface.
  function makeHighlight() {
    const stripe = html('div', 'lc-lane-light');
    stripe.setAttribute('aria-hidden', 'true');
    stripe.hidden = true;
    stripe.style.left = left + 'px';
    stripe.style.width = (right - left) + 'px';
    stripe.style.height = lane + 'px';
    overlay.frame.prepend(stripe);
    return stripe;
  }
  function placeHighlight(stripe, index) {
    stripe.style.transform = 'translate3d(0,' + (layout.top + index * lane) + 'px,0)';
    stripe.hidden = false;
  }
  const hover = makeHighlight();
  const stageRows = new Map();
  visible.forEach(({ stage: s, color }, i) => {
    stageRows.set(s, i);
    const y = layout.top + i * lane + 13;
    const x1 = scaleX(Math.max(range[0], s.start)), x2 = scaleX(Math.min(range[1], s.end));
    const group = svg('g', { class: 'lc-lane', role: 'button', tabindex: 0, 'aria-label': s.name + '，' + number(s.start) + ' 至 ' + number(s.end) + ' 秒，查看阶段' });
    const title = svg('title', {}, s.name + ' · ' + s.id + ' · ' + number(s.start) + '–' + number(s.end) + ' s');
    const hit = svg('rect', { x: left, y: y - lane / 2, width: right - left, height: lane, fill: 'transparent', class: 'lc-lane-hit', rx: 5 });
    const track = svg('line', { x1: left, x2: right, y1: y, y2: y, class: 'lc-track' });
    const bar = svg('rect', { x: x1, y: y - 5, width: Math.max(1.5, x2 - x1), height: 10, rx: 5, class: 'lc-stage-bar', fill: color });
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
    group.addEventListener('pointerenter', event => {
      if (event.pointerType !== 'touch') placeHighlight(hover, i);
    });
    group.addEventListener('pointerleave', () => { hover.hidden = true; });
    root.append(group);
  });
  if (!visible.length) root.append(svg('text', { x: (left + right) / 2, y: layout.top + 17, 'text-anchor': 'middle', class: 'lc-empty' }, '当前范围未标注阶段'));
  const highlights = [];
  let lastActive;
  block.append(overlay.frame);
  return { block, root, clearHover() { hover.hidden = true; }, update(position, sample, readings, activeStages) {
    overlay.update(position);
    if (activeStages === lastActive) return;
    lastActive = activeStages;
    let index = 0;
    for (const stage of activeStages) {
      const row = stageRows.get(stage);
      if (row === undefined) continue;
      if (!highlights[index]) highlights.push(makeHighlight());
      placeHighlight(highlights[index++], row);
    }
    for (; index < highlights.length; index++) highlights[index].hidden = true;
  }};
}

export function mountCharts(container, { onCursor, onStage }) {
  let data, view, overview;
  let range = [0, 1], includeEnd = true, width = 0, resizeFrame = 0;
  let currentTime = null, currentSample = null, currentReadings, currentStages = [];
  let ariaTimer = 0, lastMoveAt = 0;
  let resolution, ratio = window.devicePixelRatio || 1;
  const theme = getComputedStyle(container);
  let badgeInk, metricInk;
  function updateInk() {
    badgeInk = theme.getPropertyValue('--lc-chip-text').trim();
    metricInk = theme.getPropertyValue('--lc-ink').trim();
    if (view) paintCursor();
  }
  const appearance = new MutationObserver(updateInk);
  appearance.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const emptyStages = [];
  const input = bindScrubber(container, {
    // All five frames have the exact same horizontal bounds.
    surfaceFor: target => target.closest('.lc-plot') ? container : null,
    onPosition(fraction) {
      const { left, right } = view.layout;
      onCursor(range[0] + clamp((fraction * width - left) / (right - left), 0, 1) * (range[1] - range[0]));
    },
  });
  container.classList.add('lc-charts');
  updateInk();

  function syncSliders() {
    if (!view || currentTime === null) return;
    for (const panel of view.panels) panel.syncSlider?.(currentTime);
  }

  // The focused slider updates synchronously on keyboard input and focus.
  // Pointer feedback can update all accessibility values once movement settles.
  function syncAfterMovement() {
    const remaining = 140 - (performance.now() - lastMoveAt);
    if (remaining > 0) {
      ariaTimer = setTimeout(syncAfterMovement, remaining);
      return;
    }
    ariaTimer = 0;
    syncSliders();
  }

  function paintCursor() {
    const { layout, panels } = view;
    let position = null;
    if (currentTime !== null) {
      const x = layout.scaleX(currentTime);
      const badgeX = clamp(x, layout.left + layout.badgeHalf, layout.right - layout.badgeHalf);
      position = {
        transform: 'translate3d(' + x.toFixed(2) + 'px,0,0)',
        badgeOffset: 'translateX(' + (badgeX - x).toFixed(2) + 'px)',
        label: currentTime.toFixed(2) + ' s',
        ink: badgeInk, metricInk,
      };
      layout.stamp.draw(position.label, badgeInk);
    }
    for (const panel of panels) panel.update(position, currentSample, currentReadings, position ? currentStages : emptyStages);
  }

  function setCursor(time, sample, readings, activeStages) {
    currentTime = Number.isFinite(time) && time >= range[0] && time <= range[1] ? time : null;
    currentSample = sample && sample.time >= range[0] &&
      (sample.time < range[1] || (includeEnd && sample.time === range[1])) ? sample : null;
    currentReadings = readings;
    currentStages = activeStages;
    paintCursor();
    lastMoveAt = performance.now();
    if (!ariaTimer) ariaTimer = setTimeout(syncAfterMovement, 140);
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
    input.cancelFrame();
    onCursor(next);
    syncSliders();
  }

  function buildView() {
    const left = width < 520 ? 39 : 49;
    const right = Math.max(left + 1, width - (width < 520 ? 13 : 20));
    const [start, end] = range;
    const half = Math.max(27, (end.toFixed(2).length + 2) * 3.7 + 6);
    const layout = {
      left, right, width, ratio, top: 11, badgeHalf: Math.min((right - left) / 2, half),
      scaleX: t => left + (t - start) / (end - start || 1) * (right - left),
    };
    layout.fontFamily = theme.getPropertyValue('--lc-ui');
    layout.stamp = makeTimeStamp(layout.badgeHalf * 2, ratio, layout.fontFamily);
    const samples = data.samples.slice(firstAt(data.samples, start), firstAt(data.samples, end, includeEnd));
    const panels = PLOTS.map(config => metricPanel(config, samples, range, layout));
    panels.push(stagePanel(data.stages, range, layout, onStage));
    for (const { root } of panels) {
      root.addEventListener('keydown', moveKey);
      root.addEventListener('focus', () => {
        if (currentTime === null) onCursor(start);
        syncSliders();
      });
    }
    return { layout, panels };
  }

  function draw() {
    input.reset();
    const next = includeEnd && overview ? overview : buildView();
    if (includeEnd) overview = next;
    if (view !== next) {
      view?.panels.at(-1).clearHover();
      container.replaceChildren(...next.panels.map(panel => panel.block));
    }
    view = next;
  }

  function rebuild() {
    overview = null;
    if (data) {
      draw();
      paintCursor();
      syncSliders();
    }
  }
  function watchResolution() {
    resolution = window.matchMedia('(resolution: ' + ratio + 'dppx)');
    resolution.addEventListener('change', changeResolution, { once: true });
  }
  function changeResolution() {
    ratio = window.devicePixelRatio || 1;
    watchResolution();
    rebuild();
  }
  watchResolution();
  const observer = new ResizeObserver(([entry]) => {
    const measured = Math.max(1, entry.contentRect.width);
    cancelAnimationFrame(resizeFrame);
    if (measured === width) return;
    resizeFrame = requestAnimationFrame(() => {
      width = measured;
      rebuild();
    });
  });
  observer.observe(container);
  return {
    render(newData, newRange, { stage = null } = {}) {
      if (data !== newData) overview = null;
      data = newData;
      range = newRange;
      includeEnd = !stage;
      if (!width) width = Math.max(1, container.clientWidth);
      draw();
    },
    setCursor,
    destroy() {
      input.destroy();
      observer.disconnect();
      appearance.disconnect();
      resolution.removeEventListener('change', changeResolution);
      clearTimeout(ariaTimer);
      cancelAnimationFrame(resizeFrame);
      view = overview = data = null;
      container.replaceChildren();
      container.classList.remove('lc-charts');
    },
  };
}
