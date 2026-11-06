'use strict';
// Module 3: Diff & apply engine.
// Parses EDIT blocks out of model output, resolves them against the files on disk,
// produces per-hunk line diffs, and writes only the accepted hunks back atomically.
const crypto = require('crypto');
const fs = require('fs');
const ws = require('./workspace');
const { diffLines, analyze, rebuild } = require('./diff');
const logger = require('./logger');

const proposals = new Map();
const MAX_PROPOSALS = 200;

const START_RE = /^\s*<{5,}\s*EDIT\s+(.+?)\s*$/;
const MID_RE = /^\s*={5,}\s*$/;
const END_RE = /^\s*>{5,}(\s*END)?\s*$/;

/** Extract edit blocks: [{path, search, replace, incomplete?}] */
function parseEditBlocks(text) {
  const lines = String(text).split(/\r?\n/);
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const m = START_RE.exec(lines[i]);
    if (!m) { i++; continue; }
    const p = m[1].replace(/^[`'"]+|[`'"]+$/g, '').trim();
    const search = [];
    const replace = [];
    i++;
    while (i < lines.length && !MID_RE.test(lines[i])) search.push(lines[i++]);
    if (i >= lines.length) { blocks.push({ path: p, search: search.join('\n'), replace: '', incomplete: true }); break; }
    i++;
    while (i < lines.length && !END_RE.test(lines[i])) replace.push(lines[i++]);
    const incomplete = i >= lines.length;
    blocks.push({ path: p, search: search.join('\n'), replace: replace.join('\n'), incomplete });
    i++;
  }
  return blocks;
}

function findAllLineMatches(cLines, sLines, norm) {
  const target = sLines.map(norm);
  const hits = [];
  outer: for (let i = 0; i + target.length <= cLines.length; i++) {
    for (let k = 0; k < target.length; k++) if (norm(cLines[i + k]) !== target[k]) continue outer;
    hits.push(i);
    if (hits.length > 1) break;
  }
  return hits;
}

/** Apply one block to (LF-normalised) content. */
function applyBlock(content, block) {
  if (block.incomplete) return { ok: false, error: 'Edit block is incomplete (output was cut off?)' };
  if (!block.search.trim()) {
    if (content.trim() === '') return { ok: true, content: block.replace.endsWith('\n') ? block.replace : block.replace + '\n', how: 'create' };
    return { ok: false, error: 'Empty SEARCH section on an existing, non-empty file' };
  }
  // 1. exact unique match
  const first = content.indexOf(block.search);
  if (first !== -1) {
    if (content.indexOf(block.search, first + 1) !== -1) return { ok: false, error: 'SEARCH text matches more than one location — needs more context' };
    let end = first + block.search.length;
    if (block.replace === '' && content[end] === '\n') end++; // deleting whole lines: drop the newline too
    return { ok: true, content: content.slice(0, first) + block.replace + content.slice(end), how: 'exact' };
  }
  // 2. line-based fuzzy matches (trailing whitespace, then indentation)
  const cLines = content.split('\n');
  const sLines = block.search.split('\n');
  while (sLines.length && !sLines[0].trim()) sLines.shift();
  while (sLines.length && !sLines[sLines.length - 1].trim()) sLines.pop();
  const rLines = block.replace === '' ? [] : block.replace.split('\n');
  for (const [how, norm] of [['trailing-ws', (s) => s.replace(/\s+$/, '')], ['indent', (s) => s.trim()]]) {
    const hits = findAllLineMatches(cLines, sLines, norm);
    if (hits.length === 1) {
      const at = hits[0];
      return { ok: true, content: [...cLines.slice(0, at), ...rLines, ...cLines.slice(at + sLines.length)].join('\n'), how };
    }
    if (hits.length > 1) return { ok: false, error: `SEARCH text matches more than one location (${how}-insensitive)` };
  }
  return { ok: false, error: 'SEARCH text not found in file' };
}

const splitLines = (s) => s.split('\n');

function createProposal(root, blocks, meta = {}) {
  const byPath = new Map();
  blocks.forEach((b, idx) => {
    if (!byPath.has(b.path)) byPath.set(b.path, []);
    byPath.get(b.path).push({ ...b, index: idx + 1 });
  });
  const files = [];
  for (const [rel, list] of byPath) {
    const f = { path: rel, isNew: false, errors: [], applied: [], blocksTotal: list.length, fatal: null };
    try {
      ws.assertWritable(rel);
      const abs = ws.safeResolve(root, rel);
      const exists = fs.existsSync(abs);
      const raw = exists ? fs.readFileSync(abs, 'utf8') : '';
      f.isNew = !exists;
      f.originalHash = exists ? ws.sha256(raw) : null;
      f.eol = raw.includes('\r\n') ? '\r\n' : '\n';
      const original = raw.replace(/\r\n/g, '\n');
      let work = original;
      for (const b of list) {
        const r = applyBlock(work, b);
        if (r.ok) { work = r.content; f.applied.push({ block: b.index, how: r.how }); }
        else f.errors.push({ block: b.index, error: r.error, search: b.search.slice(0, 300) });
      }
      f.ops = diffLines(splitLines(original), splitLines(work));
      Object.assign(f, analyze(f.ops));
    } catch (e) {
      f.fatal = e.message;
      f.hunks = [];
      f.view = [];
    }
    files.push(f);
  }
  const id = crypto.randomBytes(6).toString('hex');
  const proposal = { id, createdAt: new Date().toISOString(), status: 'pending', files, meta };
  proposals.set(id, proposal);
  if (proposals.size > MAX_PROPOSALS) proposals.delete(proposals.keys().next().value);
  return proposal;
}

function publicProposal(p) {
  return {
    id: p.id,
    createdAt: p.createdAt,
    status: p.status,
    results: p.results || null,
    files: p.files.map((f) => ({
      path: f.path,
      isNew: f.isNew,
      fatal: f.fatal,
      errors: f.errors,
      applied: f.applied,
      blocksTotal: f.blocksTotal,
      hunks: f.hunks,
      view: f.view,
      stats: { add: f.hunks.reduce((a, h) => a + h.add, 0), del: f.hunks.reduce((a, h) => a + h.del, 0) },
    })),
  };
}

function getProposal(id) {
  const p = proposals.get(id);
  if (!p) throw ws.httpErr(404, `Unknown proposal ${id}`);
  return p;
}

/**
 * Write accepted hunks to disk. selection: {path: [hunkIds]} or null for "accept everything".
 * Each file is verified against the hash captured when the proposal was built.
 */
function applyProposal(root, id, selection, { backups = true } = {}) {
  const p = getProposal(id);
  if (p.status !== 'pending') throw ws.httpErr(409, `Proposal ${id} is already ${p.status}`);
  const results = [];
  for (const f of p.files) {
    if (f.fatal || !f.hunks.length) { results.push({ path: f.path, status: 'skipped', reason: f.fatal || 'no changes' }); continue; }
    const accepted = new Set(selection == null ? f.hunks.map((h) => h.id) : (selection[f.path] || []).map(Number));
    if (!accepted.size) { results.push({ path: f.path, status: 'skipped', reason: 'no hunks accepted' }); continue; }
    try {
      let out = rebuild(f.ops, accepted).join('\n');
      if (f.eol === '\r\n') out = out.replace(/\n/g, '\r\n');
      const note = [p.meta?.prompt, p.meta?.model ? `(${p.meta.provider}/${p.meta.model})` : ''].filter(Boolean).join(' ');
      const w = ws.writeText(root, f.path, out, { backups, expectHash: f.originalHash, reason: { source: 'ai', note } });
      results.push({ path: f.path, status: 'written', hunks: accepted.size, of: f.hunks.length, bytes: w.bytes, backup: w.backup, created: w.created });
      logger.info('write', `${w.created ? 'Created' : 'Wrote'} ${f.path} (${accepted.size}/${f.hunks.length} hunks, ${w.bytes} B)${w.backup ? ` backup → ${w.backup}` : ''}`);
    } catch (e) {
      results.push({ path: f.path, status: 'error', reason: e.message });
      logger.error('write', `Failed to write ${f.path}: ${e.message}`);
    }
  }
  p.status = results.some((r) => r.status === 'written') ? 'applied' : 'pending';
  p.results = results;
  return results;
}

function rejectProposal(id) {
  const p = getProposal(id);
  if (p.status !== 'pending') throw ws.httpErr(409, `Proposal ${id} is already ${p.status}`);
  p.status = 'rejected';
  logger.info('patch', `Proposal ${id} rejected`);
}

module.exports = { parseEditBlocks, applyBlock, createProposal, publicProposal, applyProposal, rejectProposal, getProposal };
