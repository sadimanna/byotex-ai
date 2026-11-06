'use strict';
// Serves browser ES modules straight from node_modules (no bundler), with a generated import map.
// Only the packages reachable from ROOTS are exposed, and only their files, under /vendor/npm/<name>/.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const NM = path.join(__dirname, '..', 'node_modules');
const ROOTS = ['codemirror', '@codemirror/legacy-modes'];
const EXTRA = { '@codemirror/legacy-modes/mode/stex': '@codemirror/legacy-modes/mode/stex.js' };

function pkgJson(name) {
  return JSON.parse(fs.readFileSync(path.join(NM, name, 'package.json'), 'utf8'));
}

/** ESM entry file of a package (handles string / "." / import-condition exports, then module, then main). */
function entryOf(pj) {
  let e = pj.exports;
  if (e && typeof e === 'object' && '.' in e) e = e['.'];
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object') {
    const imp = e.import ?? e.module ?? e.default ?? e.browser;
    if (typeof imp === 'string') return imp;
    if (imp && typeof imp === 'object') return imp.default ?? imp.import ?? null;
  }
  return pj.module || pj.main || 'index.js';
}

function collect() {
  const pkgs = new Map();
  const walk = (name) => {
    if (pkgs.has(name)) return;
    let pj;
    try { pj = pkgJson(name); } catch { return; }
    pkgs.set(name, pj);
    for (const d of Object.keys(pj.dependencies || {})) walk(d);
  };
  ROOTS.forEach(walk);
  return pkgs;
}

let cached = null;
function build() {
  if (cached) return cached;
  const pkgs = collect();
  const imports = {};
  for (const [name, pj] of pkgs) {
    const entry = entryOf(pj);
    if (entry) imports[name] = `/vendor/npm/${name}/${entry.replace(/^\.\//, '')}`;
  }
  for (const [spec, file] of Object.entries(EXTRA)) imports[spec] = `/vendor/npm/${file}`;
  const json = JSON.stringify({ imports });
  const hash = crypto.createHash('sha256').update(json).digest('base64');
  cached = { pkgs, json, cspHash: `'sha256-${hash}'`, tag: `<script type="importmap">${json}</script>` };
  return cached;
}

/** Mount static handlers for the allowed packages. */
function mount(app, express) {
  const { pkgs } = build();
  for (const name of pkgs.keys()) {
    app.use(`/vendor/npm/${name}`, express.static(path.join(NM, name), { index: false, dotfiles: 'ignore', fallthrough: false }));
  }
}

module.exports = { build, mount, entryOf };
