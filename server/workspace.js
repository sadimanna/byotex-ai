'use strict';
// Module 1: LaTeX file manager. Scans a project root, classifies files, parses .tex/.bib,
// cross-checks references, and provides path-confined read/write helpers.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseTex, parseBib } = require('./parser');
const logger = require('./logger');

const TEXT_EXT = new Set(['.tex', '.bib', '.sty', '.cls', '.bst', '.txt', '.md', '.ltx', '.bbx', '.cbx']);
const WRITABLE_EXT = new Set(['.tex', '.bib', '.sty', '.cls', '.txt', '.ltx']);
const FIGURE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.pdf', '.eps']);
const IGNORE_DIRS = new Set(['node_modules', '.git', '.byotex-backups', '__pycache__']);
const MAX_FILES = 5000;
const MAX_DEPTH = 10;
const MAX_TEXT_BYTES = 5 * 1024 * 1024;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const toPosix = (p) => p.split(path.sep).join('/');

function kindOf(name) {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.tex' || ext === '.ltx') return 'tex';
  if (ext === '.bib') return 'bib';
  if (FIGURE_EXT.has(ext)) return 'figure';
  if (TEXT_EXT.has(ext)) return 'text';
  return 'other';
}

/** Resolve a project-relative path and guarantee it stays inside root (symlinks included). */
function safeResolve(root, rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) throw httpErr(400, 'Invalid path');
  const realRoot = fs.realpathSync(root);
  const abs = path.resolve(realRoot, rel);
  const inside = (p) => p === realRoot || p.startsWith(realRoot + path.sep);
  if (!inside(abs)) throw httpErr(403, `Path escapes workspace: ${rel}`);
  let probe = abs;
  while (!fs.existsSync(probe)) probe = path.dirname(probe);
  if (!inside(fs.realpathSync(probe))) throw httpErr(403, `Path escapes workspace via symlink: ${rel}`);
  if (fs.existsSync(abs) && !inside(fs.realpathSync(abs))) throw httpErr(403, `Path escapes workspace via symlink: ${rel}`);
  return abs;
}

function httpErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function scan(root) {
  const t0 = Date.now();
  if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw httpErr(400, `Workspace root is not a directory: ${root}`);
  const realRoot = fs.realpathSync(root);
  const files = {};
  let count = 0;

  function walk(dir, depth) {
    const node = { name: path.basename(dir) || dir, path: toPosix(path.relative(realRoot, dir)), type: 'dir', children: [] };
    if (depth > MAX_DEPTH) return node;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return node;
    }
    entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
    for (const ent of entries) {
      if (count >= MAX_FILES) break;
      if (ent.name.startsWith('.') || IGNORE_DIRS.has(ent.name)) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        const child = walk(abs, depth + 1);
        if (child.children.length) node.children.push(child);
        continue;
      }
      if (!ent.isFile()) continue;
      const kind = kindOf(ent.name);
      if (kind === 'other') continue;
      count++;
      const rel = toPosix(path.relative(realRoot, abs));
      const size = fs.statSync(abs).size;
      node.children.push({ name: ent.name, path: rel, type: 'file', kind, size });
      if ((kind === 'tex' || kind === 'bib') && size <= MAX_TEXT_BYTES) {
        try {
          const text = fs.readFileSync(abs, 'utf8');
          files[rel] = kind === 'tex' ? parseTex(text, rel) : parseBib(text, rel);
        } catch (e) {
          logger.warn('parse', `Failed to parse ${rel}: ${e.message}`);
        }
      }
    }
    return node;
  }

  const tree = walk(realRoot, 0);
  tree.name = path.basename(realRoot);
  const result = { root: realRoot, tree, files, diagnostics: diagnose(realRoot, files), fileCount: count, scannedAt: new Date().toISOString() };
  result.mainFile = Object.values(files).find((f) => f.kind === 'tex' && f.documentclass)?.path || null;
  result.ms = Date.now() - t0;
  return result;
}

function diagnose(root, files) {
  const diags = [];
  const bibKeys = new Set();
  const labels = new Set();
  let hasBib = false;
  for (const f of Object.values(files)) {
    if (f.kind === 'bib') {
      hasBib = true;
      const seen = new Set();
      for (const e of f.entries) {
        if (seen.has(e.key)) diags.push({ level: 'warn', path: f.path, line: e.line, message: `Duplicate BibTeX key '${e.key}'` });
        seen.add(e.key);
        bibKeys.add(e.key);
      }
    } else {
      for (const l of f.labels) {
        if (labels.has(l.name)) diags.push({ level: 'warn', path: f.path, line: l.line, message: `Duplicate label '${l.name}'` });
        labels.add(l.name);
      }
    }
    for (const e of f.errors) diags.push({ level: 'error', path: f.path, line: e.line, message: e.message });
  }
  for (const f of Object.values(files)) {
    if (f.kind !== 'tex') continue;
    const dir = path.dirname(path.join(root, f.path));
    const exists = (rel, exts) =>
      [root, dir].some((base) => exts.some((x) => fs.existsSync(path.join(base, rel + x))));
    if (hasBib) for (const c of f.cites) if (!bibKeys.has(c.key)) diags.push({ level: 'warn', path: f.path, line: c.line, message: `Citation '${c.key}' not found in any .bib file` });
    for (const r of f.refs) if (!labels.has(r.name)) diags.push({ level: 'warn', path: f.path, line: r.line, message: `Reference to undefined label '${r.name}'` });
    for (const g of f.graphics) if (!exists(g.file, ['', '.pdf', '.png', '.jpg', '.jpeg', '.eps', '.svg'])) diags.push({ level: 'warn', path: f.path, line: g.line, message: `Graphic not found: ${g.file}` });
    for (const inc of f.includes) if (!exists(inc.file, ['', '.tex'])) diags.push({ level: 'error', path: f.path, line: inc.line, message: `\\${inc.cmd}{${inc.file}}: file not found` });
    for (const b of f.bibliographies) if (!exists(b.file, ['', '.bib'])) diags.push({ level: 'error', path: f.path, line: b.line, message: `Bibliography not found: ${b.file}` });
  }
  return diags;
}

function readText(root, rel) {
  const abs = safeResolve(root, rel);
  if (!fs.existsSync(abs)) throw httpErr(404, `Not found: ${rel}`);
  const kind = kindOf(abs);
  if (kind === 'figure' || kind === 'other') throw httpErr(415, `Not a text file: ${rel}`);
  const st = fs.statSync(abs);
  if (st.size > MAX_TEXT_BYTES) throw httpErr(413, `File too large: ${rel}`);
  const content = fs.readFileSync(abs, 'utf8');
  return { path: rel, abs, content, hash: sha256(content), kind, size: st.size, mtime: st.mtime.toISOString() };
}

function assertWritable(rel) {
  if (!WRITABLE_EXT.has(path.extname(rel).toLowerCase())) throw httpErr(403, `Writes are restricted to ${[...WRITABLE_EXT].join(' ')} files: ${rel}`);
}


// ---- Change history -------------------------------------------------------------------------
// One JSON line per write in <project>/.byotex-backups/history.jsonl, pointing at the backup taken
// just before it. Restoring a version writes that backup back (itself backed up and recorded).
const HISTORY_FILE = path.join('.byotex-backups', 'history.jsonl');
const HISTORY_MAX_READ = 500;

function recordHistory(root, entry) {
  try {
    const file = path.join(fs.realpathSync(root), HISTORY_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ id: crypto.randomBytes(5).toString('hex'), time: new Date().toISOString(), ...entry }) + '\n');
  } catch (e) {
    logger.warn('history', `Could not record history: ${e.message}`);
  }
}

function readHistory(root) {
  const file = path.join(fs.realpathSync(root), HISTORY_FILE);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).slice(-HISTORY_MAX_READ);
  const out = [];
  for (const l of lines) { try { out.push(JSON.parse(l)); } catch { /* skip damaged line */ } }
  return out.reverse(); // newest first
}

function backupFile(root, rel, content) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(fs.realpathSync(root), '.byotex-backups', stamp, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content);
  return toPosix(path.relative(fs.realpathSync(root), dest));
}

/** Atomic, path-confined write with optional backup of the previous version. */
function writeText(root, rel, content, { backups = true, expectHash, reason } = {}) {
  assertWritable(rel);
  const abs = safeResolve(root, rel);
  const exists = fs.existsSync(abs);
  const current = exists ? fs.readFileSync(abs, 'utf8') : null;
  if (expectHash !== undefined) {
    const curHash = current === null ? null : sha256(current);
    if (curHash !== expectHash) throw httpErr(409, `${rel} changed on disk since it was loaded`);
  }
  let backup = null;
  if (backups && current !== null) backup = backupFile(root, rel, current);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.byotex-tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, abs);
  // reason = { source: 'ai' | 'editor' | 'restore' | 'citation', note? } → recorded in the project's history
  if (reason) recordHistory(root, { path: rel, source: reason.source, note: reason.note || '', backup, created: !exists, bytes: Buffer.byteLength(content) });
  return { path: rel, bytes: Buffer.byteLength(content), hash: sha256(content), backup, created: !exists };
}

module.exports = { readHistory, toPosix, scan, safeResolve, readText, writeText, assertWritable, kindOf, sha256, httpErr, FIGURE_EXT };
