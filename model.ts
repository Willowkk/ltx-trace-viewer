const units = { percent: '%', size: 'GiB', rate: 'MiB/s' } as const;

const fields = {
  cpu: { kind: 'percent', name: 'CPU', legend: '进程 CPU', mappingName: '进程 CPU（按分配核归一化）' },
  gpu: { kind: 'percent', name: 'GPU', legend: 'GPU', mappingName: 'GPU 利用率' },
  rss: { kind: 'size', name: 'RSS', legend: '进程 RSS', mappingName: '进程 RSS' },
  vram: { kind: 'size', name: '显存', legend: '设备显存', mappingName: '设备显存' },
  read: { kind: 'rate', name: '读取', legend: '读取', mappingName: '存储读取' },
  write: { kind: 'rate', name: '写入', legend: '写入', mappingName: '存储写入' },
  rx: { kind: 'rate', name: 'PCIe RX', legend: '设备 RX', mappingName: 'PCIe RX' },
  tx: { kind: 'rate', name: 'PCIe TX', legend: '设备 TX', mappingName: 'PCIe TX' },
} as const;

export type MetricKey = keyof typeof fields;
export type MetricUnit = typeof units[keyof typeof units];
export const METRIC_KEYS = Object.keys(fields) as MetricKey[];
export const METRICS = METRIC_KEYS.map(key => ({
  key, ...fields[key], unit: units[fields[key].kind],
}));

function plot(title: string, first: MetricKey, second: MetricKey) {
  return {
    title,
    unit: units[fields[first].kind],
    series: [[first, fields[first].legend], [second, fields[second].legend]] as const,
  };
}

export const PLOTS = [
  plot('计算利用率', 'cpu', 'gpu'),
  plot('内存与显存', 'rss', 'vram'),
  plot('存储 I/O', 'read', 'write'),
  plot('PCIe 吞吐量', 'rx', 'tx'),
];

export type Sample = { time: number } & Record<MetricKey, number | null>;
export type Readings = Record<MetricKey, string>;
export type TimeRange = [number, number];

export interface Stage {
  id: string;
  name: string;
  start: number;
  end: number;
}

export interface Trace {
  title: string;
  duration: number;
  samples: Sample[];
  stages: Stage[];
  timeBasis?: 'trace';
}

// First sample at or after time; use afterEqual for the exclusive end of a window.
export function lowerBound(samples: readonly Sample[], time: number, afterEqual = false): number {
  let low = 0;
  let high = samples.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const sampleTime = samples[mid].time;
    if (sampleTime < time || (afterEqual && sampleTime === time)) low = mid + 1;
    else high = mid;
  }
  return low;
}
