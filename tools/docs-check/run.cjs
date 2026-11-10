'use strict';

// Checks that every relative link in the Markdown files points at a file that exists and, when it has `#anchor`, at a heading that exists.
// No dependencies:  node tools/docs-check/run.cjs
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const SKIP = new Set(['node_modules', 'target', 'target-pkg', '.git', '.tools', 'dist', 'build', '.gradle', 'legacy', 'server']);

function markdownFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) markdownFiles(full, out);
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

/** the anchor GitHub makes of a heading: lower case, punctuation gone, spaces to hyphens */
function slug(heading) {
  return heading
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
}

const anchorCache = new Map();
function anchorsOf(file) {
  if (anchorCache.has(file)) return anchorCache.get(file);
  const text = fs.readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '');
  const seen = new Map();
  const anchors = new Set();
  for (const match of text.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = slug(match[1]);
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  anchorCache.set(file, anchors);
  return anchors;
}

let problems = 0;
let links = 0;
for (const file of markdownFiles(ROOT)) {
  const text = fs.readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '');
  for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = match[1];
    if (/^(https?:|mailto:)/.test(target)) continue;
    links += 1;
    const [pathPart, anchor] = target.split('#');
    const resolved = pathPart ? path.resolve(path.dirname(file), decodeURIComponent(pathPart)) : file;
    const shown = path.relative(ROOT, file);
    if (!fs.existsSync(resolved)) { console.log(`${shown}: ${target} does not exist`); problems += 1; continue; }
    if (anchor && resolved.endsWith('.md') && !anchorsOf(resolved).has(decodeURIComponent(anchor))) {
      console.log(`${shown}: ${target}: no such heading in ${path.relative(ROOT, resolved)}`);
      problems += 1;
    }
  }
}
console.log(`${links} links checked, ${problems} problem${problems === 1 ? '' : 's'}`);
process.exit(problems ? 1 : 0);
