import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { PLOTS, lowerBound, type Trace, type Stage, type Sample, type Readings, type TimeRange } from './model.ts';
import { bindScrubber } from './scrubber.ts';

export const STAGE_COLORS = ['#78808c', '#657694', '#6e63bb', '#0071e3', '#3a898a', '#3e61ba', '#50836c', '#a96275'];
const format = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const number = (value: number) => format.format(value);
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

function html<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, text?: string) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  if (text !== undefined) el.textContent = text;
  return el;
}

function section(title: string, unit: string) {
  const block = html('section', 'lc-panel');
  const head = html('div', 'lc-head');
  const titleGroup = html('div', 'lc-title-group');
  titleGroup.append(html('h3', 'lc-title', title), html('span', 'lc-unit', unit));
  head.append(titleGroup);
  block.append(head);
  return { block, head };
}

type Position = { transform: string; badgeOffset: string; label: string };
type Layout = {
  width: number; top: number; left: number; right: number;
  font: string; ratio: number; ink: string; axis: string; grid: string; gridX: string; floor: string;
  colors: string[]; fill: string; badgeHalf: number; timeTicks: number[];
  stamp: ReturnType<typeof makeTimeStamp>;
  scaleX: (time: number) => number;
};
type Panel = {
  block: HTMLElement; root: HTMLElement | SVGSVGElement;
  update: (position: Position | null, sample: Sample | null, readings: Readings | null, activeStages: readonly Stage[]) => void;
  syncSlider?: (time: number) => void;
  clearHover?: () => void;
  destroy?: () => void;
};
type View = { layout: Layout; panels: Panel[] };

function makeTimeStamp(width: number, ratio: number, font: string, ink: string) {
  const source = html('canvas');
  source.width = Math.max(1, Math.ceil(width * ratio));
  source.height = Math.ceil(19 * ratio);
  const ctx = source.getContext('2d');
  if (ctx) {
    ctx.scale(ratio, ratio);
    ctx.font = '600 11px ' + font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = ink;
  }
  let previous = '';
  return { source, draw(label: string) {
    if (!ctx || label === previous) return;
    ctx.clearRect(0, 0, width, 19);
    ctx.fillText(label, width / 2, 10);
    previous = label;
  }};
}

// The line follows continuous time even between samples. A shared bitmap gives
// all five clocks identical glyphs without remeasuring text in each chart.
function cursorOverlay(root: HTMLElement | SVGSVGElement, layout: Layout, bottom: number) {
  const frame = html('div', 'lc-frame');
  const cursor = html('div', 'lc-cursor');
  cursor.setAttribute('aria-hidden', 'true');
  cursor.hidden = true;
  cursor.style.top = (layout.top - 2) + 'px';
  cursor.style.height = (bottom + 3 - layout.top) + 'px';
  const badge = html('canvas', 'lc-cursor-time');
  const stamp = layout.stamp.source;
  badge.width = stamp.width;
  badge.height = stamp.height;
  badge.style.width = (layout.badgeHalf * 2) + 'px';
  badge.style.left = -layout.badgeHalf + 'px';
  const ctx = badge.getContext('2d');
  const text = document.createTextNode('');
  badge.append(text);
  cursor.append(badge);
  frame.append(root, cursor);
  let previousOffset = '';
  return { frame, update(position: Position | null) {
    if (!position) {
      if (!cursor.hidden) cursor.hidden = true;
      return;
    }
    if (cursor.hidden) cursor.hidden = false;
    cursor.style.transform = position.transform;
    if (text.data !== position.label) {
      ctx?.clearRect(0, 0, stamp.width, stamp.height);
      ctx?.drawImage(stamp, 0, 0);
      text.data = position.label;
    }
    if (previousOffset !== position.badgeOffset) {
      previousOffset = position.badgeOffset;
      badge.style.transform = previousOffset;
    }
  }};
}

function axisNumber(value: number) {
  if (value >= 1e6) return Number((value / 1e6).toPrecision(3)) + 'M';
  if (value >= 1e3) return Number((value / 1e3).toPrecision(3)) + 'k';
  return String(Number(value.toPrecision(8)));
}

// Paint into an isolated fixed-size slot. Updating eight visible text nodes at
// sample boundaries can repeatedly lay out and paint the flex headers.
function legendReading(slot: HTMLElement, unit: string, layout: Layout) {
  const canvas = html('canvas', 'lc-legend-value');
  const ctx = canvas.getContext('2d');
  const withUnit = layout.width > 390;
  const reservation = withUnit ? slot.dataset.reserve! : slot.dataset.numberReserve!;
  const height = 17;
  let width = 0;
  if (ctx) {
    const font = '600 12px ' + layout.font;
    ctx.font = font;
    width = Math.max(1, Math.ceil(ctx.measureText(reservation).width));
    canvas.width = Math.ceil(width * layout.ratio);
    canvas.height = Math.ceil(height * layout.ratio);
    ctx.scale(layout.ratio, layout.ratio);
    ctx.font = font;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = layout.ink;
  }
  const value = ctx ? canvas : html('span', 'lc-legend-value');
  const text = document.createTextNode('');
  value.append(text);
  slot.append(value);
  let previous: string | undefined;
  return (reading: string, measured: boolean) => {
    const label = measured ? reading + ' ' + unit : reading;
    if (label === previous) return;
    previous = label;
    const visible = withUnit ? label : reading;
    text.data = ctx ? label : visible;
    if (ctx) {
      ctx.clearRect(0, 0, width + 1, height + 1);
      ctx.fillText(visible, 0, height / 2 + .5);
    }
  };
}

function metricPanel(config: typeof PLOTS[number], samples: Sample[], times: number[], range: TimeRange, layout: Layout): Panel {
  const { block, head } = section(config.title, config.unit);
  const legend = html('div', 'lc-legend');
  head.append(legend);

  const data: uPlot.AlignedData = [times];
  const series: uPlot.Series[] = [{}];
  const values: ReturnType<typeof legendReading>[] = [];
  let hasData = false;
  for (const [i, [key, label]] of config.series.entries()) {
    const column = samples.map(sample => sample[key]);
    data.push(column);
    let maximum: number | null = null;
    const isolated: number[] = [];
    column.forEach((value, index) => {
      if (value === null) return;
      maximum = Math.max(maximum ?? 0, value);
      if (column[index - 1] == null && column[index + 1] == null) isolated.push(index);
    });
    if (maximum !== null) hasData = true;
    const color = layout.colors[i];
    series.push({
      label, stroke: color, width: 1.65, fill: i === 0 ? layout.fill : undefined,
      spanGaps: false, points: { show: false, filter: isolated.length ? isolated : null, size: 4, width: 0, fill: color },
    });
    const item = html('span', 'lc-legend-item');
    const dot = html('i', 'lc-line-key');
    dot.style.backgroundColor = color;
    const slot = html('span', 'lc-legend-slot');
    slot.dataset.numberReserve = maximum === null ? '—' : number(Math.ceil(maximum)) + '.88';
    slot.dataset.reserve = maximum === null ? '—' : slot.dataset.numberReserve + ' ' + config.unit;
    values.push(legendReading(slot, config.unit, layout));
    item.append(dot, html('span', '', label), slot);
    legend.append(item);
  }

  const bottom = layout.width < 560 ? 93 : 106;
  const axis = { stroke: layout.axis, font: '11px ' + layout.font, ticks: { show: false } };
  const xRange: TimeRange = [range[0], range[1] > range[0] ? range[1] : range[0] + 1];
  const plot = new uPlot({
    width: layout.width, height: bottom + 25, class: 'lc-plot',
    padding: [layout.top, layout.width - layout.right, 0, 0],
    legend: { show: false }, cursor: { show: false }, select: { show: false, left: 0, top: 0, width: 0, height: 0 },
    scales: {
      x: { time: false, range: xRange },
      y: { range: config.unit === '%' ? [0, 100] : (_, _min, max) => {
        const upper = Number.isFinite(max) && max > 0 ? max : 1;
        return [0, uPlot.rangeNum(0, upper, 0.06, false)[1]];
      } },
    },
    axes: [
      { ...axis, size: 25, space: 85, gap: 6, grid: { stroke: layout.gridX, dash: [2, 4] },
        ...(range[0] === range[1] ? { splits: [range[0]] } : {}),
        border: { show: true, stroke: layout.floor },
        values: (_, splits) => {
          layout.timeTicks = splits;
          return splits.map(value => axisNumber(value) + ' s');
        } },
      { ...axis, size: layout.left, space: 27, gap: 8, grid: { stroke: layout.grid },
        values: (_, splits) => splits.map(axisNumber) },
    ],
    series,
  }, data);
  // Resolve both scales before mounting cursor marks or building the stage ruler.
  plot.batch(() => plot.setScale('x', { min: xRange[0], max: xRange[1] }));

  const root = plot.root;
  root.setAttribute('role', 'slider');
  root.tabIndex = 0;
  root.setAttribute('aria-label', config.title + '时间游标');
  root.setAttribute('aria-valuemin', String(range[0]));
  root.setAttribute('aria-valuemax', String(range[1]));
  root.setAttribute('aria-valuenow', String(range[0]));
  const overlay = cursorOverlay(root, layout, bottom);
  if (!hasData) overlay.frame.append(html('span', 'lc-empty lc-empty-metric', '当前范围无采样'));
  const marks = layout.colors.map(color => {
    const mark = html('i', 'lc-sample-dot');
    mark.setAttribute('aria-hidden', 'true');
    mark.hidden = true;
    mark.style.backgroundColor = color;
    overlay.frame.append(mark);
    return mark;
  });
  let lastSample: Sample | null | undefined;
  let lastVisible = false;
  let spokenReadings: Readings | null = null;
  block.append(overlay.frame);
  return { block, root, destroy() { plot.destroy(); }, syncSlider(time) {
    const value = time.toFixed(3);
    const summary = time.toFixed(2) + ' 秒，' + config.series.map(([key, label]) => {
      const reading = spokenReadings?.[key];
      return label + (reading && reading !== '—' ? ' ' + reading + ' ' + config.unit : ' 无采样');
    }).join('，');
    if (root.getAttribute('aria-valuenow') !== value) root.setAttribute('aria-valuenow', value);
    if (root.getAttribute('aria-valuetext') !== summary) root.setAttribute('aria-valuetext', summary);
  }, update(position, sample, readings) {
    overlay.update(position);
    const visible = position !== null;
    if (sample === lastSample && visible === lastVisible) return;
    lastSample = sample;
    lastVisible = visible;
    spokenReadings = sample ? readings : null;
    for (let i = 0; i < config.series.length; i++) {
      const key = config.series[i][0];
      const measured = visible ? sample?.[key] : null;
      const reading = measured != null && readings ? readings[key] : visible ? '—' : '';
      values[i](reading, measured != null);
      if (marks[i].hidden !== (measured == null)) marks[i].hidden = measured == null;
      if (sample && measured != null) {
        const x = layout.left + plot.valToPos(sample.time, 'x');
        const y = layout.top + plot.valToPos(measured, 'y');
        marks[i].style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
      }
    }
  }};
}

function stagePanel(stages: Stage[], range: TimeRange, layout: Layout, onStage: (stage: Stage) => void): Panel {
  const { block, head } = section('阶段时间线', 's');
  head.append(html('span', 'lc-phase-hint', '点击阶段查看局部曲线'));
  const visible = stages.map((stage, index) => ({ stage, color: STAGE_COLORS[index % STAGE_COLORS.length] }))
    .filter(({ stage }) => stage.end > range[0] && stage.start < range[1]);
  const lane = 26, bottom = layout.top + Math.max(1, visible.length) * lane + 2;
  const root = svg('svg', { class: 'lc-plot lc-stage-plot', viewBox: '0 0 ' + layout.width + ' ' + (bottom + 24),
    width: '100%', height: bottom + 24, role: 'group', tabindex: 0, 'aria-label': '阶段时间线' });
  for (const time of layout.timeTicks) {
    const x = layout.scaleX(time);
    root.append(svg('line', { x1: x, x2: x, y1: layout.top, y2: bottom, class: 'lc-grid lc-grid-x' }));
    root.append(svg('text', { x, y: bottom + 17, 'text-anchor': 'middle', class: 'lc-tick' }, axisNumber(time) + ' s'));
  }
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
  function placeHighlight(stripe: HTMLElement, index: number) {
    stripe.style.transform = 'translate3d(0,' + (layout.top + index * lane) + 'px,0)';
    stripe.hidden = false;
  }
  const hover = makeHighlight();
  const stageRows = new Map<Stage, number>();
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
    if (x2 - x1 - 10 > room) { inside = true; anchor = 'start'; labelX = x1 + 5; room = x2 - x1 - 10; bar.setAttribute('height', '18'); bar.setAttribute('y', String(y - 9)); }
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
  const highlights: HTMLElement[] = [];
  let lastActive: readonly Stage[] | undefined;
  block.append(overlay.frame);
  return { block, root, clearHover() { hover.hidden = true; }, update(position, _sample, _readings, activeStages) {
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

export function mountCharts(container: HTMLElement, { onCursor, onStage }: {
  onCursor: (time: number) => void; onStage: (stage: Stage) => void;
}) {
  let data: Trace | null = null, view: View | null = null, overview: View | null = null;
  let range: TimeRange = [0, 1], includeEnd = true, width = 0, resizeFrame = 0;
  let currentTime: number | null = null, currentSample: Sample | null = null;
  let currentReadings: Readings | null = null, currentStages: readonly Stage[] = [];
  let ariaTimer = 0, lastMoveAt = 0;

  container.classList.add('lc-charts');
  const input = bindScrubber(container.closest<HTMLElement>('.plot-area') || container, {
    surface: container,
    onPosition(fraction: number) {
      if (!view) return;
      const { left, right } = view.layout;
      onCursor(range[0] + clamp((fraction * width - left) / (right - left), 0, 1) * (range[1] - range[0]));
    },
  });

  function syncSliders() {
    if (!view || currentTime === null) return;
    for (const panel of view.panels) panel.syncSlider?.(currentTime);
  }
  function syncAfterMovement() {
    const remaining = 140 - (performance.now() - lastMoveAt);
    if (remaining > 0) {
      ariaTimer = window.setTimeout(syncAfterMovement, remaining);
      return;
    }
    ariaTimer = 0;
    syncSliders();
  }

  const emptyStages: readonly Stage[] = [];
  function paintCursor() {
    if (!view) return;
    const { layout, panels } = view;
    let position: Position | null = null;
    if (currentTime !== null) {
      const x = layout.scaleX(currentTime);
      const badgeX = clamp(x, layout.left + layout.badgeHalf, layout.right - layout.badgeHalf);
      position = {
        transform: 'translate3d(' + x.toFixed(2) + 'px,0,0)',
        badgeOffset: 'translateX(' + (badgeX - x).toFixed(2) + 'px)',
        label: currentTime.toFixed(2) + ' s',
      };
      layout.stamp.draw(position.label);
    }
    for (const panel of panels) panel.update(position, currentSample, currentReadings, position ? currentStages : emptyStages);
  }

  function setCursor(time: number, sample: Sample | null, readings: Readings, activeStages: readonly Stage[]) {
    currentTime = Number.isFinite(time) && time >= range[0] && time <= range[1] ? time : null;
    currentSample = sample && sample.time >= range[0] &&
      (sample.time < range[1] || (includeEnd && sample.time === range[1])) ? sample : null;
    currentReadings = readings;
    currentStages = activeStages;
    paintCursor();
    lastMoveAt = performance.now();
    if (!ariaTimer) ariaTimer = window.setTimeout(syncAfterMovement, 140);
  }

  function moveKey(event: Event) {
    if (!(event instanceof KeyboardEvent) || !data) return;
    const [start, end] = range;
    const time = currentTime ?? start;
    const samples = data.samples;
    let next: number;
    if (event.key === 'Home') next = start;
    else if (event.key === 'End') next = end;
    else if (event.key === 'ArrowRight') {
      next = Math.min(end, samples[lowerBound(samples, time, true)]?.time ?? end);
    } else if (event.key === 'ArrowLeft') {
      next = Math.max(start, samples[lowerBound(samples, time) - 1]?.time ?? start);
    } else return;
    event.preventDefault();
    input.cancelFrame();
    onCursor(next);
    syncSliders();
  }

  function buildView(trace: Trace): View {
    const left = width < 520 ? 39 : 49;
    const right = Math.max(left + 1, width - (width < 520 ? 13 : 20));
    const [start, end] = range;
    const half = Math.max(27, (end.toFixed(2).length + 2) * 3.7 + 6);
    const badgeHalf = Math.min((right - left) / 2, half);
    const theme = getComputedStyle(container);
    const style = (token: string) => theme.getPropertyValue('--lc-' + token).trim();
    const font = style('ui');
    const ratio = window.devicePixelRatio || 1;
    const layout: Layout = {
      left, right, width, top: 11, badgeHalf, font, ratio, ink: style('ink'), timeTicks: [],
      axis: style('axis'), grid: style('grid'), gridX: style('grid-x'), floor: style('floor'),
      colors: [style('blue'), style('orange')], fill: style('fill'),
      stamp: makeTimeStamp(badgeHalf * 2, ratio, font, style('chip-text')),
      scaleX: t => left + (t - start) / (end - start || 1) * (right - left),
    };
    const samples = trace.samples.slice(lowerBound(trace.samples, start), lowerBound(trace.samples, end, includeEnd));
    const times = samples.map(sample => sample.time);
    const panels = PLOTS.map(config => metricPanel(config, samples, times, range, layout));
    panels.push(stagePanel(trace.stages, range, layout, onStage));
    for (const { root } of panels) {
      root.addEventListener('keydown', moveKey);
      root.addEventListener('focus', () => {
        if (currentTime === null) onCursor(start);
        syncSliders();
      });
    }
    return { layout, panels };
  }

  function dispose(oldView: View | null) {
    for (const panel of oldView?.panels ?? []) panel.destroy?.();
  }
  function resetViews() {
    if (overview !== view) dispose(overview);
    dispose(view);
    view = overview = null;
  }
  function draw() {
    if (!data) return;
    input.reset();
    const next = includeEnd && overview ? overview : buildView(data);
    if (view !== next) {
      view?.panels.at(-1)?.clearHover?.();
      if (view !== overview) dispose(view);
      container.replaceChildren(...next.panels.map(panel => panel.block));
    }
    view = next;
    if (includeEnd) overview = next;
  }
  function rebuild() {
    resetViews();
    draw();
    paintCursor();
    syncSliders();
  }

  const appearance = new MutationObserver(rebuild);
  appearance.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  let resolution: MediaQueryList;
  function watchResolution() {
    resolution = window.matchMedia('(resolution: ' + (window.devicePixelRatio || 1) + 'dppx)');
    resolution.addEventListener('change', changeResolution, { once: true });
  }
  function changeResolution() {
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
    render(newData: Trace, newRange: TimeRange, { stage = null }: { stage?: Stage | null } = {}) {
      if (data !== newData) resetViews();
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
      resetViews();
      data = null;
      container.replaceChildren();
      container.classList.remove('lc-charts');
    },
  };
}
