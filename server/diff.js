'use strict';
// Line diff (common prefix/suffix trim + LCS on the middle) and hunk analysis.

const LCS_CELL_LIMIT = 12_000_000;

/** Returns ops: [{t:'='|'-'|'+', s:string}] */
function diffLines(a, b) {
  const ops = [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  for (let i = 0; i < start; i++) ops.push({ t: '=', s: a[i] });

  const n = endA - start;
  const m = endB - start;
  if (n * m > LCS_CELL_LIMIT) {
    for (let i = start; i < endA; i++) ops.push({ t: '-', s: a[i] });
    for (let j = start; j < endB; j++) ops.push({ t: '+', s: b[j] });
  } else if (n || m) {
    // dp[i][j] = LCS length of a[start+i..endA) and b[start+j..endB)
    const W = m + 1;
    const dp = new Uint32Array((n + 1) * W);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * W + j] = a[start + i] === b[start + j]
          ? dp[(i + 1) * W + j + 1] + 1
          : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[start + i] === b[start + j]) { ops.push({ t: '=', s: a[start + i] }); i++; j++; }
      else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) { ops.push({ t: '-', s: a[start + i] }); i++; }
      else { ops.push({ t: '+', s: b[start + j] }); j++; }
    }
    while (i < n) ops.push({ t: '-', s: a[start + i++] });
    while (j < m) ops.push({ t: '+', s: b[start + j++] });
  }
  for (let i = endA; i < a.length; i++) ops.push({ t: '=', s: a[i] });
  return ops;
}

/**
 * Group consecutive changes into hunks and build a compact view with `ctx` context lines.
 * View rows: {t:'='|'-'|'+', o, n, s, h} or {t:'~', count} for collapsed unchanged runs.
 */
function analyze(ops, ctx = 3) {
  const rows = [];
  const hunks = [];
  let o = 1;
  let n = 1;
  let inChange = false;
  for (const op of ops) {
    if (op.t === '=') {
      rows.push({ t: '=', o: o++, n: n++, s: op.s, h: null });
      inChange = false;
      continue;
    }
    if (!inChange) {
      hunks.push({ id: hunks.length, oldStart: o, newStart: n, del: 0, add: 0 });
      inChange = true;
    }
    const h = hunks.length - 1;
    if (op.t === '-') { rows.push({ t: '-', o: o++, n: null, s: op.s, h }); hunks[h].del++; }
    else { rows.push({ t: '+', o: null, n: n++, s: op.s, h }); hunks[h].add++; }
  }
  const keep = new Uint8Array(rows.length);
  rows.forEach((r, i) => {
    if (r.t === '=') return;
    for (let k = Math.max(0, i - ctx); k <= Math.min(rows.length - 1, i + ctx); k++) keep[k] = 1;
  });
  const view = [];
  let skip = 0;
  rows.forEach((r, i) => {
    if (keep[i]) {
      if (skip) { view.push({ t: '~', count: skip }); skip = 0; }
      view.push(r);
    } else skip++;
  });
  if (skip) view.push({ t: '~', count: skip });
  return { hunks, view };
}

/** Rebuild the new text applying only the hunks in `accepted` (a Set of hunk ids). */
function rebuild(ops, accepted) {
  const out = [];
  let h = -1;
  let inChange = false;
  for (const op of ops) {
    if (op.t === '=') { out.push(op.s); inChange = false; continue; }
    if (!inChange) { h++; inChange = true; }
    const take = accepted.has(h);
    if (op.t === '-' && !take) out.push(op.s);
    if (op.t === '+' && take) out.push(op.s);
  }
  return out;
}

module.exports = { diffLines, analyze, rebuild };
