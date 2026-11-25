import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { normalizeTrace } from '../data.ts';

const { values } = parseArgs({
  options: {
    dist: { type: 'string', default: 'dist' },
    output: { type: 'string' },
    capture: { type: 'string' },
  },
});
const dist = resolve(values.dist);
const index = join(dist, 'index.html');
const output = resolve(values.output ?? join(dist, 'standalone.html'));
if (extname(output).toLowerCase() !== '.html' || output === index) {
  throw new Error('请为输出选择独立的 .html 文件，并保留构建生成的 index.html。');
}
let html = readFileSync(index, 'utf8');

function asset(pattern, attribute) {
  const tag = html.match(pattern)?.[0];
  const path = tag?.match(new RegExp('\\b' + attribute + '="([^"]+)"'))?.[1];
  if (!path) throw new Error('构建入口缺少资源标签：' + pattern);
  return { tag, path };
}

function jsonScript(id, value) {
  // Escaping every "<" also covers mixed-case end tags and HTML comment delimiters.
  const serialized = JSON.stringify(value).replaceAll('<', '\\u003c');
  return '<script type="application/json" id="' + id + '">' + serialized + '</script>';
}

const bundle = asset(/<script\b[^>]*\btype="module"[^>]*><\/script>/i, 'src');
const sheet = asset(/<link\b[^>]*\brel="stylesheet"[^>]*>/i, 'href');
const icon = asset(/<link\b[^>]*\brel="icon"[^>]*>/i, 'href');
const script = readFileSync(resolve(dist, bundle.path), 'utf8');
const css = readFileSync(resolve(dist, sheet.path), 'utf8');
html = html.replace(bundle.tag, () => '<script type="module">' + script.replace(/<\/script/gi, '<\\/script') + '</script>');
html = html.replace(sheet.tag, () => '<style>' + css + '</style>');
if (!icon.path.startsWith('data:')) {
  const svg = readFileSync(resolve(dist, icon.path)).toString('base64');
  html = html.replace(icon.tag, () => '<link rel="icon" href="data:image/svg+xml;base64,' + svg + '">');
}

// Include the full runtime dependency license even when the bundler strips comments.
const notices = { uPlot: readFileSync(new URL('../node_modules/uplot/LICENSE', import.meta.url), 'utf8') };
for (const path of readdirSync(dist, { recursive: true })) {
  if (/(?:^|[/\\.])(?:licen[sc]e|legal|notice)s?\.(?:md|txt)$/i.test(path)) {
    notices[path] = readFileSync(join(dist, path), 'utf8');
  }
}
let embedded = jsonScript('third-party-notices', notices);
if (values.capture) {
  const raw = JSON.parse(readFileSync(values.capture, 'utf8').replace(/^\uFEFF/, ''));
  normalizeTrace(raw);
  embedded += '\n' + jsonScript('embedded-capture', raw);
}
html = html.replace('</head>', () => embedded + '\n</head>');
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, html);
console.log(output);
