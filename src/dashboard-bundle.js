// Tiny zero-dependency bundler for the dashboard client. The client is authored
// as ES modules (util → api → map → views → app), but ES-module `import`s can't be
// cache-busted with a ?v= query (a relative import doesn't inherit its parent's
// query), so a deploy would stay shadowed by a stale CF/browser copy. We instead
// concatenate the modules into ONE classic script whose URL carries a content hash,
// so every change yields a fresh URL that busts CF and the browser automatically —
// no manual purge, no build tool. Built once at boot and served from memory.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIR = join(__dirname, 'public', 'dashboard');
// Dependency order: a module must appear after everything it references.
const ORDER = ['util.js', 'api.js', 'map.js', 'views.js', 'app.js'];

function strip(src) {
  return src
    // drop local module imports (`import { x } from './y.js'`)
    .replace(/^[ \t]*import\s+[^;]*?from\s+['"]\.\/[^'"]+['"];?[ \t]*$/gm, '')
    // drop bare re-export statements (`export { a, b };`)
    .replace(/^[ \t]*export\s+\{[^}]*\};?[ \t]*$/gm, '')
    // unwrap declaration exports (`export const X` → `const X`, incl. async/default)
    .replace(/^([ \t]*)export\s+(default\s+)?(function|const|let|var|class|async)/gm, '$1$3');
}

let cached = null;

export function getBundle() {
  if (cached) return cached;
  const parts = ORDER.map((f) => `// ==== ${f} ====\n${strip(readFileSync(join(DIR, f), 'utf8'))}`);
  const code = `(function(){\n"use strict";\n${parts.join('\n')}\n})();\n`;
  const css = readFileSync(join(DIR, 'app.css'), 'utf8');
  // Version reflects both JS and CSS so either change yields a new asset URL.
  const version = createHash('sha1').update(code).update(css).digest('hex').slice(0, 10);
  cached = { code, version };
  return cached;
}
