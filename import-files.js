import { normalizeCaptureTables } from './data.js';

let sequence = 0;
let coreDialog = null;

async function readJson(file) {
  let text;
  const magic = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  if (magic[0] === 0x1f && magic[1] === 0x8b) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('请先解压 ' + file.name + '，再导入 JSON。');
    }
    try {
      text = await new Response(file.stream().pipeThrough(new DecompressionStream('gzip'))).text();
    } catch {
      throw new Error(file.name + ' 的 gzip 数据无法解压。');
    }
  } else {
    text = await file.text();
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error(file.name + ' 的内容不是有效的 JSON。');
  }
}

function requestCores(initial) {
  const dialog = document.createElement('dialog');
  dialog.className = 'help-dialog core-dialog';
  dialog.setAttribute('aria-labelledby', 'core-dialog-title');
  dialog.setAttribute('aria-describedby', 'core-dialog-explanation');
  // All dialog markup is static. File and manifest data are never inserted as HTML.
  dialog.innerHTML = `
    <form method="dialog">
      <div class="dialog-head"><h2 id="core-dialog-title">确认 CPU 核数</h2></div>
      <p id="core-dialog-explanation">CPU 利用率按实际使用核数 ÷ 分配核数计算。</p>
      <label for="allocated-cores">本次采集分配的 CPU 核数</label>
      <input id="allocated-cores" type="number" min="0" step="any" inputmode="decimal" required placeholder="参考采集为 8 核">
      <div class="dialog-actions">
        <button type="button" class="btn secondary">取消</button>
        <button type="submit" class="btn primary">确认并导入</button>
      </div>
    </form>`;
  const input = dialog.querySelector('input');
  if (initial !== undefined) input.valueAsNumber = initial;
  dialog.querySelector('button[type="button"]').addEventListener('click', () => dialog.close());
  input.addEventListener('input', () => input.setCustomValidity(''));
  let cores = null;
  dialog.querySelector('form').addEventListener('submit', event => {
    event.preventDefault();
    if (!(Number.isFinite(input.valueAsNumber) && input.valueAsNumber > 0)) {
      input.setCustomValidity('请输入大于 0 的分配核数。');
      input.reportValidity();
      return;
    }
    cores = input.valueAsNumber;
    dialog.close();
  });
  document.body.append(dialog);
  coreDialog = dialog;
  return new Promise(resolve => {
    dialog.addEventListener('close', () => {
      if (coreDialog === dialog) coreDialog = null;
      dialog.remove();
      resolve(cores);
    }, { once: true });
    dialog.showModal();
    input.focus();
  });
}

const TABLE_FILES = new Set(['resources.csv', 'phases.csv', 'manifest.json']);

export async function readCaptureFiles(files) {
  const current = ++sequence;
  if (coreDialog?.open) coreDialog.close();
  const list = Array.from(files);
  if (!list.length) return null;
  const single = list.length === 1 ? list[0] : null;
  if (single && /\.json(?:\.gz)?$/i.test(single.name) && single.name.toLowerCase() !== 'manifest.json') {
    return { json: await readJson(single), name: single.name };
  }

  const byName = new Map();
  for (const file of list) {
    const filename = file.name.toLowerCase();
    if (!TABLE_FILES.has(filename)) {
      const isArchive = /\.tar\.gz$|\.tgz$/i.test(filename);
      throw new Error(isArchive
        ? '请先解压归档，然后选择 resources.csv，可同时选择 phases.csv 和 manifest.json。'
        : '请选择单个 JSON 或 JSON.gz，或同一轮采集的 resources.csv、phases.csv 和 manifest.json。');
    }
    if (byName.has(filename)) throw new Error('发现两个 ' + filename + '。请只选择同一轮采集的一组文件。');
    byName.set(filename, file);
  }
  const resourceFile = byName.get('resources.csv');
  const phaseFile = byName.get('phases.csv');
  const manifestFile = byName.get('manifest.json');
  if (!resourceFile) throw new Error('缺少 resources.csv。请将它与阶段表或 manifest.json 一起选择。');

  const [resources, phases, manifest] = await Promise.all([
    resourceFile.text(), phaseFile ? phaseFile.text() : null, manifestFile ? readJson(manifestFile) : {},
  ]);
  if (current !== sequence) return null;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('manifest.json 应包含一个 JSON 对象。');
  const options = {};
  if (manifest.duration_s !== undefined) {
    if (!Number.isFinite(manifest.duration_s) || manifest.duration_s < 0) throw new Error('manifest.json 的 duration_s 应为非负秒数。');
    options.duration = manifest.duration_s;
  }
  if (typeof manifest.run_id === 'string') options.title = manifest.run_id;
  const header = resources.replace(/^\uFEFF/, '').split(/[\r\n]/, 1)[0];
  if (/(^|,)\s*"?cpu_cores"?\s*(,|$)/.test(header)) {
    const recordedCores = manifest.allocated_cpu_cores ?? manifest.allocatedCores;
    const initial = Number.isFinite(recordedCores) && recordedCores > 0 ? recordedCores : undefined;
    options.allocatedCores = await requestCores(initial);
    if (options.allocatedCores === null || current !== sequence) return null;
  }
  const json = normalizeCaptureTables(resources, phases, options);
  const name = [resourceFile, phaseFile, manifestFile].filter(Boolean).map(file => file.name).join(' + ');
  return { json, name };
}
