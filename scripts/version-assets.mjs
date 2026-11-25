// Run before publishing. Pages can cache ES module dependencies separately
// from index.html, so each local asset URL follows its own contents.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const versions = new Map();

function version(url) {
  if (versions.has(url.href)) return versions.get(url.href);
  const source = readFileSync(url, 'utf8');
  const contents = source.replace(/(\bfrom\s+['"])(\.\/[^'"?]+\.js)(?:\?v=[\w-]+)?(?=['"])/g,
    (_, prefix, path) => prefix + path + '?v=' + version(new URL(path, url)));
  if (contents !== source) writeFileSync(url, contents);
  const hash = createHash('sha256').update(contents).digest('hex').slice(0, 12);
  versions.set(url.href, hash);
  return hash;
}

const index = new URL('../index.html', import.meta.url);
const source = readFileSync(index, 'utf8');
const contents = source.replace(/((?:href|src)=")([\w.-]+\.(?:css|js|svg))(?:\?v=[\w-]+)?(?=")/g,
  (_, prefix, path) => prefix + path + '?v=' + version(new URL(path, index)));
if (contents !== source) writeFileSync(index, contents);
