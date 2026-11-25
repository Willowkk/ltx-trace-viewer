import { counterField, normalizeTrace } from './data.ts';
import { METRICS } from './model.ts';

const units = {
  percent: [
    ['%', '%', 1], ['ratio', '比例 0–1', 100],
  ],
  size: [
    ['GiB', 'GiB', 1], ['MiB', 'MiB', 1 / 1024], ['KiB', 'KiB', 1 / 1024 ** 2],
    ['bytes', '字节', 1 / 1024 ** 3], ['GB', 'GB', 1e9 / 1024 ** 3], ['MB', 'MB', 1e6 / 1024 ** 3],
  ],
  rate: [
    ['MiB/s', 'MiB/s', 1], ['GiB/s', 'GiB/s', 1024], ['KiB/s', 'KiB/s', 1 / 1024],
    ['bytes/s', '字节/s', 1 / 1024 ** 2], ['MB/s', 'MB/s', 1e6 / 1024 ** 2],
    ['GB/s', 'GB/s', 1e9 / 1024 ** 2], ['KB/s', 'KB/s', 1e3 / 1024 ** 2],
    ['bytes-total', '累计字节（按时间差求速率）', 1 / 1024 ** 2, true],
  ],
};

function traceEvents(json) {
  if (Array.isArray(json)) return json;
  return Array.isArray(json?.traceEvents) ? json.traceEvents : [];
}

// Chrome counter names may repeat on different devices or tracks.
function counterTrack(event) {
  return JSON.stringify([event.cat ?? '', event.name ?? '', event.pid ?? '', event.tid ?? '', event.scope ?? '', event.id ?? null, event.id2 ?? null]);
}

function numericArgs(args, visit, parents = []) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return;
  for (const [key, value] of Object.entries(args)) {
    const path = [...parents, key];
    if (Number.isFinite(value)) visit(path, value);
    else if (parents.length < 6) numericArgs(value, visit, path);
  }
}

export function getCounterOptions(json) {
  const found = new Map();
  for (const event of traceEvents(json)) {
    if (event?.ph !== 'C' || !Number.isFinite(event.ts)) continue;
    const track = counterTrack(event);
    const originalArgs = event.args?.data && typeof event.args.data === 'object' ? event.args.data : event.args;
    const onlyValue = originalArgs && Object.keys(originalArgs).length === 1;
    numericArgs(event.args, (path, value) => {
      const id = JSON.stringify([track, path]);
      let field = found.get(id);
      if (!field) {
        const name = String(event.name ?? '');
        const arg = path.join('.');
        const identity = [event.cat, event.scope, event.pid == null ? '' : 'pid ' + event.pid, event.tid == null ? '' : 'tid ' + event.tid,
          event.id == null && event.id2 == null ? '' : 'id ' + JSON.stringify(event.id ?? event.id2)].filter(x => x !== '' && x != null);
        const label = (name ? name + ' › ' : '') + arg + (identity.length ? ' · ' + identity.join(' / ') : '');
        const autoPath = (path.length === 1 && originalArgs === event.args) || (path.length === 2 && path[0] === 'data');
        const recognized = autoPath ? counterField(name, path[path.length - 1], onlyValue) : null;
        field = { id, name, arg, label, path, track, pid: event.pid, tid: event.tid, min: value, max: value, count: 0, recognized };
        found.set(id, field);
      }
      field.count++;
      field.min = Math.min(field.min, value);
      field.max = Math.max(field.max, value);
    });
  }
  return Array.from(found.values()).sort((a, b) => a.label.localeCompare(b.label));
}

// Explicitly mapped counters are rewritten on one logical track. Passing through
// the original phase events and time origin keeps the Chrome timestamps aligned.
export function applyCounterMapping(json, bindings) {
  const byTrack = new Map();
  const selected = new Set();
  for (const { key, kind: group } of METRICS) {
    const binding = bindings[key];
    if (!binding?.source) continue;
    const { source, unit } = binding;
    if (selected.has(source.id)) throw new Error('同一来源字段只能分配给一个指标。');
    selected.add(source.id);
    const spec = units[group].find(u => u[0] === unit);
    if (!spec) throw new Error('请为已选择的指标指定来源单位。');
    if (!byTrack.has(source.track)) byTrack.set(source.track, []);
    byTrack.get(source.track).push({ key, path: source.path, factor: spec[2], cumulative: Boolean(spec[3]), values: [] });
  }
  if (!selected.size) throw new Error('请至少选择一个来源字段。');

  const events = [];
  for (const event of traceEvents(json)) {
    if (event?.ph !== 'C') {
      events.push(event);
      continue;
    }
    if (!Number.isFinite(event.ts)) continue;
    const track = byTrack.get(counterTrack(event));
    if (!track) continue;
    for (const field of track) {
      let value = event.args;
      for (const key of field.path) value = value?.[key];
      if (Number.isFinite(value)) field.values.push({ ts: event.ts, value });
    }
  }
  for (const fields of byTrack.values()) {
    for (const field of fields) {
      if (field.cumulative) field.values.sort((a, b) => a.ts - b.ts);
      let previous = null;
      for (const point of field.values) {
        let value = point.value * field.factor;
        if (field.cumulative) {
          const before = previous;
          if (before?.ts === point.ts) {
            if (before.value !== point.value) throw new Error('同一时间出现不一致的累计计数，请检查源字段。');
            continue;
          }
          previous = point;
          value = before && point.value >= before.value
            ? (point.value - before.value) * field.factor * 1e6 / (point.ts - before.ts)
            : null;
        }
        events.push({ ph: 'C', name: 'resources', pid: 'mapped', tid: 0, ts: point.ts, args: { [field.key]: value } });
      }
    }
  }
  return normalizeTrace({ ...(Array.isArray(json) ? {} : json), traceEvents: events });
}

function element(tag, text) {
  const el = document.createElement(tag);
  if (text) el.textContent = text;
  return el;
}

function selectFor(label, choices) {
  const select = element('select');
  select.setAttribute('aria-label', label);
  for (const [value, text] of choices) select.add(new Option(text, value));
  return select;
}

/** @returns {Promise<import('./model.ts').Trace | null>} */
export async function chooseCounterMapping(json) {
  const options = getCounterOptions(json);
  if (!options.length) throw new Error('未找到含数值字段的 Chrome Trace 计数器（ph="C"）。');
  const dialog = element('dialog');
  dialog.className = 'counter-dialog';
  dialog.setAttribute('aria-labelledby', 'counter-map-heading');
  const form = element('form');
  const heading = element('h2', '映射资源指标');
  heading.id = 'counter-map-heading';
  const intro = element('p', '为需要展示的指标选择 Chrome 计数器字段及其原始单位。缺少的指标可以留空。');
  form.append(heading, intro);

  const grid = element('div');
  grid.className = 'counter-fields';
  const controls = new Map();
  const optionEntries = options.map((source, i) => [String(i), source.label]);
  for (const { key, mappingName: label, kind: group } of METRICS) {
    const row = element('div');
    row.className = 'counter-row';
    const name = element('label', label);
    name.htmlFor = 'counter-source-' + key;
    const source = selectFor(label + ' 来源字段', [['', '未绑定'], ...optionEntries]);
    source.id = name.htmlFor;
    const unit = selectFor(label + ' 来源单位', units[group]);
    unit.disabled = true;
    const stats = element('small');
    function updateStats() {
      const field = source.value === '' ? null : options[Number(source.value)];
      unit.disabled = !field;
      stats.textContent = field ? '原始范围 ' + formatValue(field.min) + ' – ' + formatValue(field.max) + ' · ' + field.count + ' 条' : '';
    }
    source.addEventListener('change', updateStats);
    // Preserve unambiguous, unit-aware automatic mappings when correcting a
    // partial import. A cumulative counter always requires an explicit choice.
    const matches = options.filter(item => item.recognized?.key === key);
    if (matches.length === 1) {
      const match = matches[0];
      const cumulative = group === 'rate' && /(?:total|cumulat|累计|bytes$)/i.test(match.arg);
      const suggestedUnit = units[group].find(entry => !entry[3] && entry[2] === match.recognized.factor);
      if (!cumulative && suggestedUnit) {
        source.value = String(options.indexOf(match));
        unit.value = suggestedUnit[0];
        updateStats();
      }
    }
    const selects = element('div');
    selects.className = 'counter-selects';
    selects.append(source, unit);
    row.append(name, selects, stats);
    grid.append(row);
    controls.set(key, { source, unit });
  }
  const error = element('p');
  error.className = 'counter-error';
  error.setAttribute('role', 'alert');
  const actions = element('div');
  actions.className = 'counter-actions';
  const cancel = element('button', '取消');
  cancel.type = 'button';
  const apply = element('button', '应用映射');
  apply.type = 'submit';
  actions.append(cancel, apply);
  form.append(grid, error, actions);
  dialog.append(form);
  document.body.append(dialog);
  let result = null;
  return new Promise(resolve => {
    cancel.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(result);
    }, { once: true });
    form.addEventListener('submit', event => {
      event.preventDefault();
      const bindings = Object.create(null);
      for (const [key, { source, unit }] of controls) {
        if (source.value !== '') bindings[key] = { source: options[Number(source.value)], unit: unit.value };
      }
      try {
        result = applyCounterMapping(json, bindings);
        dialog.close();
      } catch (err) {
        error.textContent = err.message;
      }
    });
    dialog.showModal();
  });
}

function formatValue(value) {
  return value.toLocaleString('zh-CN', { maximumSignificantDigits: 6 });
}
