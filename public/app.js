/* BYOTeX.AI front end — vanilla JS, no build step. */
'use strict';

// Per-launch session token. The server makes a new one each time it starts, so it can change under an open page.
let TOKEN = document.querySelector('meta[name="byotex-token"]').content;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : String(k));
  return el;
}

const unreachable = () => Object.assign(new Error(`Cannot reach the BYOTeX.AI server at ${location.host}.\n\nIt may have been stopped or restarted. Start it with "npm start" (or "npm run dev") and reload this page.`), { status: 0 });

/**
 * The server restarted (new token) → fetch the page again from our own origin and take the new token
 * from it. Only same-origin code can read that page, so this keeps the protection against other sites.
 * Single-flight: concurrent 401s share one renewal.
 */
let renewing = null;
function renewToken() {
  if (!renewing) {
    renewing = (async () => {
      try {
        const html = await (await fetch('/', { cache: 'no-store' })).text();
        const m = /name="byotex-token" content="([a-f0-9]{48})"/.exec(html);
        if (!m) return false;
        if (m[1] === TOKEN) return true; // someone else already renewed it
        TOKEN = m[1];
        localLog('info', 'session', 'The server restarted, so the session was renewed automatically.');
        reconnectLogs();
        return true;
      } catch {
        return false;
      } finally {
        setTimeout(() => { renewing = null; }, 0);
      }
    })();
  }
  return renewing;
}
const sessionLost = () => Object.assign(new Error(`The BYOTeX.AI server at ${location.host} restarted and this page could not renew its session.\n\nReload the page.`), { status: 401 });

/** fetch() for our API: adds the token and, on 401, renews it once and retries. */
async function tokenFetch(url, opts = {}) {
  const go = () => fetch(url, { ...opts, headers: { ...(opts.headers || {}), 'x-byotex-token': TOKEN } });
  let res = await go().catch(() => { throw unreachable(); });
  if (res.status === 401 && (await renewToken())) res = await go().catch(() => { throw unreachable(); });
  if (res.status === 401) throw sessionLost();
  return res;
}

async function api(method, url, body) {
  const res = await tokenFetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(j.error || `${res.status} ${res.statusText}`), { status: res.status, code: j.code });
  return j;
}

const state = {
  scan: null,
  settings: null,
  expanded: new Set(['']),
  collapsed: new Set(),
  selected: null, // tree node descriptor
  file: null, // {path, kind, content, hash, dirty}
  targets: [], // [{path, start?, end?, label}]
  messages: [], // [{role, content}]
  streaming: null, // AbortController
  tokens: { in: 0, out: 0 },
};

const status = (msg) => { $('#sbMsg').textContent = msg; };

/* ------------------------------------------------------- server version */
let staleWarned = false;
async function checkServerVersion() {
  let stale = false;
  try {
    const v = await api('GET', '/api/version');
    stale = v.loaded !== v.onDisk;
  } catch (e) { stale = e.status === 404; }
  if (stale) {
    $('#sbMsg').textContent = 'SERVER OUT OF DATE — restart it';
    if (!staleWarned) {
      staleWarned = true;
      msgBox('Restart the server', 'The backend that is running is older than the code on disk, so newer features (such as Compile) are missing and return "Not found".\n\nStop the server (Ctrl+C in its terminal) and run:\n\n    npm start\n\nthen reload this page.', { warn: true });
    }
  }
  return stale;
}

/* ------------------------------------------------------------------ dialogs */
function dialog(title, body, buttons, { width } = {}) {
  return new Promise((resolve) => {
    const layer = $('#modalLayer');
    let win;
    const close = (v) => { win.remove(); if (!layer.childElementCount) layer.classList.remove('on'); document.removeEventListener('keydown', onKey, true); resolve(v); };
    const btns = buttons.map((b) => h('button', { class: `btn${b.default ? ' default' : ''}`, onclick: async () => {
      if (b.onClick) { const r = await b.onClick(); if (r === false) return; }
      close(b.value);
    } }, b.label));
    win = h('div', { class: 'window dialog', role: 'dialog', style: width ? `width:${width}px` : null },
      h('div', { class: 'titlebar' }, h('span', { class: 'title-text' }, title),
        h('span', { class: 'title-buttons' }, h('button', { class: 'tb-btn', onclick: () => close(null), 'aria-label': 'Close' }, '×'))),
      h('div', { class: 'dlg-body' }, body),
      h('div', { class: 'dlg-btns' }, btns));
    function onKey(e) {
      if (layer.lastElementChild !== win) return; // only the topmost dialog handles keys
      if (e.key === 'Escape') { e.stopPropagation(); close(null); }
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') { const d = buttons.findIndex((b) => b.default); if (d >= 0) { e.preventDefault(); btns[d].click(); } }
    }
    document.addEventListener('keydown', onKey, true);
    layer.append(win);
    layer.classList.add('on');
    const focus = win.querySelector('input, select, textarea') || btns.find((b) => b.classList.contains('default'));
    if (focus) focus.focus();
  });
}
const msgBox = (title, text, { warn = false, buttons } = {}) =>
  dialog(title, h('div', { class: 'dlg-msg' }, h('div', { class: `dlg-icon${warn ? ' warn' : ''}` }, warn ? '!' : 'i'), h('div', null, text)),
    buttons || [{ label: 'OK', value: true, default: true }]);
const confirmBox = (title, text) => msgBox(title, text, { warn: true, buttons: [{ label: 'Yes', value: true, default: true }, { label: 'No', value: false }] });

/* --------------------------------------------------------------------- log */
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const logLines = [];
function renderLogLine(e) {
  const minLevel = LEVELS[$('#logLevel').value];
  if (LEVELS[e.level] < minLevel) return null;
  const line = h('div', { class: `l-${e.level}` },
    h('span', { class: 't' }, e.t.slice(11, 19), ' '),
    h('span', { class: `tag tag-${e.tag}` }, `[${e.tag}]`), ' ', e.msg);
  if (e.data !== undefined && $('#logPayloads').checked) line.append(h('span', { class: 'data' }, JSON.stringify(e.data, null, 1)));
  return line;
}
function appendLog(e) {
  logLines.push(e);
  if (logLines.length > 3000) logLines.shift();
  const el = renderLogLine(e);
  if (!el) return;
  const con = $('#console');
  con.append(el);
  while (con.childElementCount > 3000) con.firstElementChild.remove();
  if ($('#logAutoscroll').checked) con.scrollTop = con.scrollHeight;
}
function rerenderLog() {
  const con = $('#console');
  con.replaceChildren(...logLines.map(renderLogLine).filter(Boolean));
  con.scrollTop = con.scrollHeight;
}
function localLog(level, tag, msg) { appendLog({ t: new Date().toISOString(), level, tag, msg }); }
let logStream = null;
function connectLogs() {
  const es = new EventSource(`/api/logs?token=${encodeURIComponent(TOKEN)}`);
  logStream = es;
  es.onmessage = (ev) => { try { appendLog(JSON.parse(ev.data)); } catch { /* ignore */ } };
  es.onerror = async () => {
    status(`Server at ${location.host} not reachable — retrying…`);
    // A restarted server rejects the old token (EventSource can't see the 401), so try renewing.
    if (es.readyState === EventSource.CLOSED || es.readyState === EventSource.CONNECTING) {
      const before = TOKEN;
      if ((await renewToken()) && TOKEN !== before) return; // renewToken() already reconnected
      if (es.readyState === EventSource.CLOSED && logStream === es) setTimeout(() => { if (logStream === es) reconnectLogs(); }, 3000);
    }
  };
  es.onopen = () => status('Ready');
}
function reconnectLogs() {
  if (logStream) { logStream.onerror = null; logStream.close(); }
  connectLogs();
}

/* -------------------------------------------------------------------- tree */
function fileNodes(f) {
  if (!f) return [];
  if (f.kind === 'bib') return f.entries.map((e) => ({ kind: 'env', path: f.path, start: e.line, end: e.line, label: `@${e.type} ${e.key}`, meta: e.fields.year || '' }));
  const sec = (s) => ({ kind: 'section', path: f.path, start: s.start, end: s.end, label: `${s.title}`, meta: `${s.cmd}${s.starred ? '*' : ''} L${s.start}`, children: s.children.map(sec) });
  const nodes = [];
  if (f.preamble) nodes.push({ kind: 'env', path: f.path, start: f.preamble.start, end: f.preamble.end, label: 'Preamble', meta: `${f.packages.length} pkgs` });
  nodes.push(...f.sections.map(sec));
  const SHOW = /^(figure|figure\*|table|table\*|equation|equation\*|align|align\*|abstract|theorem|lemma|proof|definition|algorithm|gather|multline)$/;
  const envs = f.environments.filter((e) => SHOW.test(e.name));
  if (envs.length) nodes.push({ kind: 'group', id: `${f.path}::envs`, label: `Environments (${envs.length})`, children: envs.map((e) => ({ kind: 'env', path: f.path, start: e.start, end: e.end, label: `${e.name}${e.label ? ` [${e.label}]` : ''}`, meta: e.caption ? `“${e.caption.slice(0, 40)}”` : `L${e.start}` })) });
  return nodes;
}

const nodeKey = (n) => n.id || `${n.kind}:${n.path}:${n.start || ''}`;

/* ---- Document outline: the paper in reading order, following \input / \include / \subfile ---- */
const OUTLINE_ENVS = /^(abstract|figure\*?|table\*?|equation\*?|align\*?|gather\*?|multline\*?|theorem|lemma|corollary|definition|proposition|proof|algorithm)$/;
function normPath(p) {
  const out = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop(); else out.push(seg);
  }
  return out.join('/');
}
const dirOf = (p) => (p && p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');
/** TeX resolves \input against the directory it runs in (the main file's), so try that first. */
function resolveInclude(fromPath, file) {
  const files = state.scan.files;
  for (const base of [dirOf(prefs.mainFile), dirOf(fromPath), '']) {
    for (const ext of ['', '.tex']) {
      const p = normPath(base + file + ext);
      if (files[p]?.kind === 'tex') return p;
    }
  }
  return null;
}
function docOutline(main) {
  const files = state.scan?.files || {};
  const f0 = files[main];
  if (!f0) return [];
  const short = (p) => p.split('/').pop();
  const roots = [];
  const stack = [];
  let topLevel = 2;
  const attach = (node, level) => {
    if (level == null) { (stack.length ? stack[stack.length - 1].children : roots).push(node); return; }
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    (stack.length ? stack[stack.length - 1].children : roots).push(node);
    stack.push(node);
  };
  const mk = (kind, path, start, end, label, meta, extra = {}) => ({ id: `o:${kind}:${path}:${start}`, kind, path, start, end, label, meta, children: [], ...extra });
  if (f0.preamble) roots.push(mk('env', main, f0.preamble.start, f0.preamble.end, 'Preamble', `${f0.packages.length} pkgs`));
  const visiting = new Set();
  const RANK = { inc: 0, sec: 1, env: 2, bib: 3 };
  const walkFile = (path, depth) => {
    const f = files[path];
    if (!f || f.kind !== 'tex' || visiting.has(path) || depth > 12) return;
    visiting.add(path);
    const ev = [];
    const flat = (secs) => secs.forEach((s) => { ev.push({ line: s.start, t: 'sec', s }); flat(s.children); });
    flat(f.sections);
    for (const e of f.environments) if (OUTLINE_ENVS.test(e.name)) ev.push({ line: e.start, t: 'env', e });
    for (const i of f.includes) ev.push({ line: i.line, t: 'inc', i });
    for (const b of f.bibliographies.slice(0, 1)) ev.push({ line: b.line, t: 'bib', b });
    ev.sort((a, b) => a.line - b.line || RANK[a.t] - RANK[b.t]);
    for (const x of ev) {
      if (path === main && f.preamble && x.line <= f.preamble.end) continue;
      if (x.t === 'sec') {
        topLevel = Math.min(topLevel, x.s.level);
        attach(mk('section', path, x.s.start, x.s.end, x.s.title, `${short(path)}:${x.s.start}`, { level: x.s.level }), x.s.level);
      } else if (x.t === 'env') {
        const e = x.e;
        attach(mk('env', path, e.start, e.end, `${e.name}${e.label ? ` [${e.label}]` : ''}`, e.caption ? `“${e.caption.slice(0, 36)}”` : `${short(path)}:${e.start}`), null);
      } else if (x.t === 'inc') {
        const target = resolveInclude(path, x.i.file);
        if (target) walkFile(target, depth + 1);
        else attach(mk('env', path, x.i.line, x.i.line, `\\${x.i.cmd}{${x.i.file}} — not found`, `${short(path)}:${x.i.line}`, { missing: true }), null);
      } else {
        attach(mk('section', path, x.b.line, x.b.line, 'References', `${short(path)}:${x.b.line}`, { level: topLevel }), topLevel);
      }
    }
    visiting.delete(path);
  };
  walkFile(main, 0);
  return roots;
}
const isInCtx = (n) => state.targets.some((t) => t.path === n.path && (n.kind === 'file' ? !t.start : t.start === n.start));

function renderTree() {
  const tree = $('#tree');
  const scroll = tree.scrollTop;
  tree.replaceChildren();
  if (!state.scan) return;
  const diags = [...state.compileDiags, ...state.scan.diagnostics];
  const walk = (node, depth) => {
    let kids = [];
    let desc;
    if (node.type === 'dir') { desc = { kind: 'dir', path: node.path, id: `dir:${node.path}`, label: node.name || '/' }; kids = node.children; }
    else if (node.type === 'file') { desc = { kind: 'file', path: node.path, label: node.name, fkind: node.kind }; kids = fileNodes(state.scan.files[node.path]); }
    else { desc = node; kids = node.children || []; }
    const key = nodeKey(desc);
    const open = isOpen(key);
    const icon = desc.kind === 'file' ? desc.fkind : desc.kind === 'group' ? 'env' : desc.kind;
    const row = h('div', { class: 'tn', style: `padding-left:${depth * 14}px` },
      h('span', { class: `tog${kids.length ? '' : ' none'}`, onclick: (e) => { e.stopPropagation(); toggle(key); } }, kids.length ? (open ? '−' : '+') : ''),
      h('span', { class: `ico ${icon}` }),
      h('span', { class: 'lbl' }, desc.label),
      desc.meta ? h('span', { class: 'meta' }, desc.meta) : null);
    if (state.selected && nodeKey(state.selected) === key) row.classList.add('sel');
    if ((desc.kind === 'file' || desc.kind === 'section' || desc.kind === 'env') && isInCtx(desc)) row.classList.add('ctx');
    row.addEventListener('click', () => selectNode(desc));
    row.addEventListener('dblclick', () => {
      if (desc.kind === 'dir' || desc.kind === 'group') toggle(key);
      else toggleTarget(desc);
    });
    tree.append(row);
    if (open) for (const k of kids) walk(k, depth + 1);
  };
  if (prefs.treeView === 'outline') {
    const roots = docOutline(prefs.mainFile);
    if (!roots.length) tree.append(h('div', { class: 'tn' }, h('span', { class: 'tog none' }), h('span', { class: 'lbl' }, prefs.mainFile ? `No structure found in ${prefs.mainFile}` : 'No main file (one with a documentclass) found')));
    for (const r of roots) walk(r, 0);
  } else walk(state.scan.tree, 0);
  if (diags.length) {
    const key = 'diag';
    const open = state.expanded.has(key);
    tree.append(h('div', { class: 'tn', onclick: () => toggle(key) },
      h('span', { class: 'tog' }, open ? '−' : '+'), h('span', { class: 'ico diag' }), h('span', { class: 'lbl' }, `Problems (${diags.length})`)));
    if (open) for (const d of diags) {
      tree.append(h('div', { class: 'tn', style: 'padding-left:14px', title: d.message, onclick: () => (d.missingFile ? missingPackagesDialog([d.missingFile]) : d.path && openFile(d.path, d.line || undefined)) },
        h('span', { class: 'tog none' }), h('span', { class: 'lbl', style: `color:${d.level === 'error' ? '#800000' : '#000'}` }, `${d.src === 'latex' ? '[TeX] ' : ''}${d.path || ''}${d.line ? `:${d.line}` : ''} ${d.message}`)));
    }
  }
  tree.scrollTop = scroll;
}
// File-view nodes start collapsed (state.expanded); outline nodes ("o:" ids) start open (state.collapsed).
const isOpen = (key) => (key.startsWith('o:') ? !state.collapsed.has(key) : state.expanded.has(key));
function toggle(key) {
  const set = key.startsWith('o:') ? state.collapsed : state.expanded;
  if (set.has(key)) set.delete(key); else set.add(key);
  renderTree();
}
async function selectNode(desc) {
  state.selected = desc;
  renderTree();
  updateCtxButton();
  if (desc.kind === 'file') await openFile(desc.path);
  else if (desc.kind === 'section' || desc.kind === 'env') await openFile(desc.path, desc.start, desc.end);
}

/* ------------------------------------------------------------------ editor */
const code = () => $('#code');
function updateGutter() {
  const n = code().value.split('\n').length;
  const g = $('#gutter');
  if (g.dataset.n !== String(n)) {
    g.dataset.n = n;
    let s = '';
    for (let i = 1; i <= n; i++) s += i + '\n';
    g.textContent = s + '\n';
  }
  g.scrollTop = code().scrollTop;
}
function setDirty(d) { if (!state.file) return; state.file.dirty = d; $('#edPath').classList.toggle('dirty', d); }

async function openFile(rel, line, endLine) {
  if (!rel) return;
  if (state.file && state.file.path === rel && state.file.kind !== 'figure') { if (line) gotoLine(line, endLine); showTab('editor'); return; }
  if (state.file?.dirty && !(await confirmBox('Unsaved changes', `${state.file.path} has unsaved changes.\nDiscard them and open ${rel}?`))) return;
  const ext = rel.split('.').pop().toLowerCase();
  const prev = $('#preview');
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'pdf', 'eps'].includes(ext)) {
    state.file = { path: rel, kind: 'figure', dirty: false };
    $('#edPath').textContent = rel;
    $('#edPath').classList.remove('dirty');
    code().value = ''; code().disabled = true; updateGutter();
    const src = `/api/raw?path=${encodeURIComponent(rel)}&token=${encodeURIComponent(TOKEN)}`;
    prev.replaceChildren(h('div', null, `Figure: ${rel}`),
      ext === 'pdf' ? h('a', { href: src, target: '_blank', rel: 'noopener' }, 'Open PDF in a new window')
        : ext === 'eps' ? h('div', null, 'EPS preview not supported.') : h('img', { src, alt: rel }));
    prev.hidden = false;
    showTab('editor');
    return;
  }
  try {
    const f = await api('GET', `/api/file?path=${encodeURIComponent(rel)}`);
    state.file = { path: f.path, kind: f.kind, content: f.content, hash: f.hash, dirty: false };
    prev.hidden = true;
    code().disabled = false;
    code().value = f.content;
    code().scrollTop = 0;
    $('#edPath').textContent = `${f.path}  (${f.size} B)`;
    setDirty(false);
    updateGutter();
    if (line) gotoLine(line, endLine);
    showTab('editor');
    renderTargets();
    status(`Opened ${f.path}`);
  } catch (e) { msgBox('Open failed', e.message, { warn: true }); }
}
function lineOffset(text, line) {
  let off = 0;
  for (let i = 1; i < line; i++) { const nl = text.indexOf('\n', off); if (nl < 0) return text.length; off = nl + 1; }
  return off;
}
function gotoLine(line, endLine) {
  const ta = code();
  const t = ta.value;
  const a = lineOffset(t, line);
  const b = endLine && endLine >= line ? lineOffset(t, endLine + 1) - (endLine + 1 > t.split('\n').length ? 0 : 1) : a;
  ta.focus();
  ta.setSelectionRange(a, Math.max(a, b));
  ta.scrollTop = Math.max(0, (line - 4) * edLineHeight());
  updateGutter();
  updatePos();
}
function updatePos() {
  const ta = code();
  const before = ta.value.slice(0, ta.selectionStart);
  const ln = before.split('\n').length;
  const col = ta.selectionStart - before.lastIndexOf('\n');
  $('#sbPos').textContent = `Ln ${ln}, Col ${col}`;
}
async function saveFile({ skipAutoCompile = false } = {}) {
  const f = state.file;
  if (!f || f.kind === 'figure') return;
  try {
    const content = code().value;
    const r = await api('PUT', '/api/file', { path: f.path, content, baseHash: f.hash });
    f.hash = r.hash; f.content = content;
    setDirty(false);
    status(`Saved ${f.path}`);
    await loadWorkspace(false);
    if (prefs.autoCompile && !skipAutoCompile) compile();
  } catch (e) {
    if (e.status === 409) {
      const ok = await confirmBox('File changed on disk', `${f.path} was modified outside the editor (or by an applied patch).\nOverwrite it with the editor contents?`);
      if (ok) { const cur = await api('GET', `/api/file?path=${encodeURIComponent(f.path)}`); f.hash = cur.hash; return saveFile(); }
    } else msgBox('Save failed', e.message, { warn: true });
  }
}
async function reloadOpenFile() {
  if (!state.file || state.file.kind === 'figure') return;
  const f = await api('GET', `/api/file?path=${encodeURIComponent(state.file.path)}`).catch(() => null);
  if (!f || f.hash === state.file.hash) return;
  if (state.file.dirty) { localLog('warn', 'editor', `${f.path} changed on disk while you have unsaved edits — not reloaded`); return; }
  const top = code().scrollTop;
  Object.assign(state.file, { content: f.content, hash: f.hash });
  code().value = f.content;
  code().scrollTop = top;
  updateGutter();
  localLog('info', 'editor', `Reloaded ${f.path} from disk`);
}

/* ----------------------------------------------------------------- context */
function addTarget(t) {
  if (!t || !t.path) return;
  const target = t.kind === 'file' || (!t.start && !t.end)
    ? { path: t.path, label: t.path }
    : { path: t.path, start: t.start, end: t.end, label: `${t.path}:${t.start}-${t.end}${t.label ? ` ${t.label}` : ''}` };
  if (state.targets.some((x) => x.path === target.path && x.start === target.start && x.end === target.end)) return;
  state.targets.push(target);
  renderTargets();
  renderTree();
  status(`Added to context: ${target.label}`);
}
/** Remove the target matching a tree node (file → whole-file target, section/env → that range). */
function removeTargetFor(n) {
  const before = state.targets.length;
  state.targets = state.targets.filter((t) => !(t.path === n.path && (n.kind === 'file' ? !t.start : t.start === n.start)));
  if (state.targets.length !== before) { renderTargets(); renderTree(); status(`Removed from context: ${n.label || n.path}`); }
}
function toggleTarget(n) { if (isInCtx(n)) removeTargetFor(n); else addTarget(n); }

/** What will actually be sent: explicit targets, or (if enabled) the file open in the editor. */
function autoTarget() {
  return !state.targets.length && prefs.autoContext && state.file && state.file.kind !== 'figure' ? { path: state.file.path, label: state.file.path, auto: true } : null;
}
function effectiveTargets() {
  const auto = autoTarget();
  return auto ? [auto] : state.targets.map(({ path, start, end, label }) => ({ path, start, end, label }));
}
function renderTargets() {
  const list = $('#ctxList');
  list.replaceChildren();
  const auto = autoTarget();
  const chip = (label, onRemove, cls = '', title = label) => h('span', { class: `chip ${cls}`, title }, label.length > 60 ? label.slice(0, 57) + '…' : label,
    h('button', { onclick: onRemove, 'aria-label': 'Remove', title: 'Remove from context' }, '×'));
  if (auto) {
    list.append(chip(`${auto.path} (open file, auto)`, () => { setPref('autoContext', false); renderTargets(); status('Open file will no longer be sent automatically'); }, 'auto',
      'Sent because nothing else is in the context. × stops sending the open file automatically.'));
  } else if (!state.targets.length) {
    list.append(h('span', { class: 'empty' }, 'Nothing selected: only the project outline is sent.'));
  }
  state.targets.forEach((t, i) => list.append(chip(t.label, () => { state.targets.splice(i, 1); renderTargets(); renderTree(); })));
  $('#ctxAuto').checked = !!prefs.autoContext;
  const n = auto ? 1 : state.targets.length;
  $('#sbCtx').textContent = auto ? `Context: ${auto.path} (auto)` : `Context: ${n ? `${n} item${n > 1 ? 's' : ''}` : 'outline only'}`;
  updateCtxButton();
}
function updateCtxButton() {
  const n = state.selected;
  const btn = $('#ctxBtn');
  const inCtx = n && ['file', 'section', 'env'].includes(n.kind) && isInCtx(n);
  btn.textContent = inCtx ? '− Context' : '+ Context';
  btn.title = inCtx ? 'Remove the selected tree node from the chat context' : 'Add the selected tree node to the chat context';
}
function addEditorSelection() {
  const ta = code();
  if (!state.file || state.file.kind === 'figure') return msgBox('Context', 'Open a text file first.');
  const v = ta.value;
  const a = v.slice(0, ta.selectionStart).split('\n').length;
  const b = v.slice(0, Math.max(ta.selectionStart, ta.selectionEnd - 1)).split('\n').length;
  if (ta.selectionStart === ta.selectionEnd) return msgBox('Context', 'Select some lines in the editor first.');
  addTarget({ kind: 'range', path: state.file.path, start: a, end: Math.max(a, b), label: 'selection' });
}

/* -------------------------------------------------------------------- chat */
const EB_RE = /(^|\n)(<{5,}\s*EDIT\s+[^\n]*\n[\s\S]*?(?:\n>{5,}[^\n]*|$))/g;
const CITE_REQ_RE = /\[\[cite:\s*([^\]\n]+?)\s*\]\]/g;
/** Plain text, with [[cite: …]] requests from the model turned into "find this reference" links. */
function appendWithCites(el, text) {
  let last = 0;
  for (const m of text.matchAll(CITE_REQ_RE)) {
    if (m.index > last) el.append(text.slice(last, m.index));
    el.append(h('a', { href: '#', class: 'cite-req', title: 'Find a real reference for this (Crossref / arXiv)', onclick: (e) => { e.preventDefault(); citeDialog(m[1]); } }, `[cite: ${m[1]}]`));
    last = m.index + m[0].length;
  }
  if (last < text.length) el.append(text.slice(last));
}
function renderAssistantBody(el, text, streaming) {
  el.replaceChildren();
  let last = 0;
  for (const m of text.matchAll(EB_RE)) {
    const s = m.index + m[1].length;
    if (s > last) appendWithCites(el, text.slice(last, s));
    const block = m[2];
    const firstNl = block.indexOf('\n');
    el.append(h('span', { class: 'eb' }, h('b', null, block.slice(0, firstNl)), block.slice(firstNl)));
    last = s + block.length;
  }
  if (last < text.length) appendWithCites(el, text.slice(last));
  if (streaming) el.append(h('span', { class: 'cursor' }, '_'));
}
function addMsg(role, title, info) {
  const body = h('div', { class: 'msg-b' });
  const infoEl = h('span', { class: 'info' }, info || '');
  const el = h('div', { class: `msg ${role}` }, h('div', { class: 'msg-h' }, h('span', null, title), infoEl), body);
  const tr = $('#transcript');
  tr.querySelector('.hint')?.remove();
  tr.append(el);
  tr.scrollTop = tr.scrollHeight;
  return { el, body, infoEl };
}
function chatHint() {
  $('#transcript').replaceChildren(h('div', { class: 'hint' },
    'Chat Inspector\n\n',
    '• Select files / sections in the Project tree and press "+ Node" (or double-click) to target them.\n',
    '• With nothing selected, the file open in the editor is sent (shown as an "auto" chip; × or the checkbox turns that off).\n',
    '• Double-click a tree node again, or click × on its chip, to remove it from the context.\n',
    '• Edit mode asks the model for EDIT blocks, which become a reviewable line diff.\n',
    '• Accept or reject individual hunks, then "Apply Selected" writes to disk (with backups).'));
  $('#transcript .hint').style.whiteSpace = 'pre-wrap';
}

async function sendPrompt() {
  const text = $('#prompt').value.trim();
  if (!text || state.streaming) return;
  if (state.file?.dirty) {
    const ok = await confirmBox('Unsaved changes', `${state.file.path} has unsaved edits. The model reads files from disk.\nSave before sending?`);
    if (ok) await saveFile();
  }
  const targets = effectiveTargets();
  const mode = $('#mode').value;
  state.messages.push({ role: 'user', content: text });
  $('#prompt').value = '';
  addMsg('user', 'You', `${mode.toUpperCase()} · ${targets.map((t) => t.label || t.path).join(', ') || 'outline only'}`).body.textContent = text;
  const a = addMsg('assistant', 'Assistant', 'connecting…');
  let full = '';
  let raf = 0;
  const paint = () => { raf = 0; renderAssistantBody(a.body, full, true); $('#transcript').scrollTop = $('#transcript').scrollHeight; };
  const ac = new AbortController();
  state.streaming = ac;
  // Show elapsed time until the first token arrives, so a slow provider is visible rather than silent.
  const t0 = Date.now();
  let metaText = 'connecting…';
  let gotFirst = false;
  const waitTimer = setInterval(() => {
    if (gotFirst) return;
    const secs = Math.round((Date.now() - t0) / 1000);
    a.infoEl.textContent = `${metaText} · waiting for first token… ${secs}s`;
    status(`Waiting for ${state.settings.activeProvider} to respond… ${secs}s (Stop to cancel)`);
  }, 1000);
  $('#sendBtn').disabled = true; $('#stopBtn').disabled = false;
  status('Streaming response…');
  let errored = false;
  try {
    const res = await tokenFetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: state.messages, targets, mode }),
      signal: ac.signal,
    });
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || res.statusText); }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        if (ev.type === 'meta') { metaText = `${ev.provider}/${ev.model} · ~${ev.inputEstimate} tok ctx${ev.truncated ? ' (truncated)' : ''}`; a.infoEl.textContent = metaText; }
        else if (ev.type === 'delta') {
          if (!gotFirst) { gotFirst = true; a.infoEl.textContent = `${metaText} · first token ${((Date.now() - t0) / 1000).toFixed(1)}s`; status('Streaming response…'); }
          full += ev.text; if (!raf) raf = requestAnimationFrame(paint);
        }
        else if (ev.type === 'usage') {
          state.tokens.in += ev.input; state.tokens.out += ev.output;
          a.infoEl.textContent += ` · ${ev.input} in / ${ev.output} out${ev.estimated ? ' (est.)' : ''} · ${(ev.ms / 1000).toFixed(1)}s`;
          updateTokens();
        } else if (ev.type === 'proposal') renderProposal(ev.proposal, a.el);
        else if (ev.type === 'applied') markApplied(ev.id, ev.results);
        else if (ev.type === 'error') { errored = true; a.el.classList.add('error'); full += (full ? '\n\n' : '') + `ERROR: ${ev.message}`; }
      }
    }
  } catch (e) {
    errored = true;
    if (e.name === 'AbortError') full += '\n\n[stopped by user]';
    else { a.el.classList.add('error'); full += (full ? '\n\n' : '') + `ERROR: ${e.message}`; }
  } finally {
    clearInterval(waitTimer);
    if (raf) cancelAnimationFrame(raf);
    renderAssistantBody(a.body, full, false);
    state.streaming = null;
    $('#sendBtn').disabled = false; $('#stopBtn').disabled = true;
    status(errored ? 'Request ended with an error' : 'Response complete');
  }
  if (!errored && full) state.messages.push({ role: 'assistant', content: full });
  else state.messages.pop(); // drop the failed user turn so history stays alternating
}
function updateTokens() { $('#sbTokens').textContent = `Tokens: ${state.tokens.in} in / ${state.tokens.out} out`; }

/* ---------------------------------------------------------------- proposal */
const proposalEls = new Map();
function renderProposal(p, after) {
  const box = h('div', { class: 'proposal', 'data-id': p.id }, h('div', { class: 'p-title' }, `Proposed Changes — #${p.id}`));
  const checks = [];
  for (const f of p.files) {
    const fileBox = h('div', { class: 'p-file' });
    fileBox.append(h('div', { class: 'p-file-h' },
      h('span', null, f.path), f.isNew ? h('span', null, '[NEW FILE]') : null,
      h('span', { class: 'stat-add' }, `+${f.stats.add}`), h('span', { class: 'stat-del' }, `-${f.stats.del}`),
      h('span', { style: 'margin-left:auto' }, `${f.applied.length}/${f.blocksTotal} blocks matched`),
      h('button', { class: 'btn small', style: 'color:#000', onclick: () => openFile(f.path, f.hunks[0]?.oldStart) }, 'Open')));
    if (f.fatal) fileBox.append(h('div', { class: 'p-err' }, `Cannot patch: ${f.fatal}`));
    for (const er of f.errors) fileBox.append(h('div', { class: 'p-err', title: er.search }, `Block #${er.block}: ${er.error}\n  search: ${er.search.split('\n')[0].slice(0, 100)}`));
    if (f.hunks.length) {
      const tbl = h('table', { class: 'diff' });
      let lastH = null;
      for (const r of f.view) {
        if (r.t === '~') { tbl.append(h('tr', { class: 'skip' }, h('td', { colspan: 4 }, `··· ${r.count} unchanged line${r.count > 1 ? 's' : ''} ···`))); lastH = null; continue; }
        if (r.h !== null && r.h !== lastH) {
          const hk = f.hunks[r.h];
          const cb = h('input', { type: 'checkbox', checked: true, 'data-path': f.path, 'data-h': hk.id });
          cb.addEventListener('change', () => $$(`tr[data-k="${CSS.escape(f.path)}:${hk.id}"]`, tbl).forEach((tr) => tr.classList.toggle('off', !cb.checked)));
          checks.push(cb);
          tbl.append(h('tr', { class: 'hh' }, h('td', { colspan: 4 }, h('label', null, cb, `Accept hunk ${hk.id + 1}`), `   @@ -${hk.oldStart},${hk.del} +${hk.newStart},${hk.add} @@`)));
        }
        lastH = r.h;
        const cls = r.t === '+' ? 'add' : r.t === '-' ? 'del' : 'ctx';
        tbl.append(h('tr', { class: cls, 'data-k': r.h !== null ? `${f.path}:${r.h}` : null },
          h('td', { class: 'ln' }, r.o ?? ''), h('td', { class: 'ln' }, r.n ?? ''), h('td', { class: 'sg' }, r.t === '=' ? ' ' : r.t), h('td', { class: 'tx' }, r.s || ' ')));
      }
      fileBox.append(tbl);
    }
    box.append(fileBox);
  }
  const statusEl = h('span', { class: 'status' }, p.status === 'pending' ? '' : p.status.toUpperCase());
  const resultsEl = h('div', { class: 'p-results', hidden: true });
  const btns = [
    h('button', { class: 'btn small', onclick: () => checks.forEach((c) => { c.checked = true; c.dispatchEvent(new Event('change')); }) }, 'Select All'),
    h('button', { class: 'btn small', onclick: () => checks.forEach((c) => { c.checked = false; c.dispatchEvent(new Event('change')); }) }, 'Select None'),
    h('button', { class: 'btn default', onclick: () => applyProposal(p.id) }, 'Apply Selected'),
    h('button', { class: 'btn', onclick: () => rejectProposal(p.id) }, 'Reject All'),
  ];
  if (!checks.length) btns.slice(0, 3).forEach((b) => { b.disabled = true; });
  box.append(h('div', { class: 'p-actions' }, btns, statusEl), resultsEl);
  after.after(box);
  proposalEls.set(p.id, { box, checks, btns, statusEl, resultsEl });
  $('#transcript').scrollTop = $('#transcript').scrollHeight;
}
function lockProposal(id, label) {
  const p = proposalEls.get(id);
  if (!p) return;
  p.checks.forEach((c) => { c.disabled = true; });
  p.btns.forEach((b) => { b.disabled = true; });
  p.statusEl.textContent = label;
}
function markApplied(id, results) {
  const p = proposalEls.get(id);
  if (!p) return;
  lockProposal(id, results.some((r) => r.status === 'written') ? 'APPLIED' : 'NOTHING WRITTEN');
  p.resultsEl.hidden = false;
  p.resultsEl.textContent = results.map((r) => `${r.status.toUpperCase().padEnd(8)} ${r.path}${r.hunks ? `  (${r.hunks}/${r.of} hunks, ${r.bytes} B)` : ''}${r.backup ? `\n         backup: ${r.backup}` : ''}${r.reason ? `  — ${r.reason}` : ''}`).join('\n');
  loadWorkspace(false).then(reloadOpenFile).then(() => { if (prefs.autoCompile && results.some((r) => r.status === 'written')) compile(); });
}
async function applyProposal(id) {
  const p = proposalEls.get(id);
  const selection = {};
  for (const c of p.checks) {
    const path = c.dataset.path;
    selection[path] = selection[path] || [];
    if (c.checked) selection[path].push(Number(c.dataset.h));
  }
  const total = Object.values(selection).reduce((a, x) => a + x.length, 0);
  if (!total) return msgBox('Apply', 'No hunks are selected.');
  try {
    const r = await api('POST', `/api/proposals/${id}/apply`, { selection });
    markApplied(id, r.results);
    const errs = r.results.filter((x) => x.status === 'error');
    if (errs.length) msgBox('Apply finished with errors', errs.map((x) => `${x.path}: ${x.reason}`).join('\n'), { warn: true });
  } catch (e) { msgBox('Apply failed', e.message, { warn: true }); }
}
async function rejectProposal(id) {
  try { await api('POST', `/api/proposals/${id}/reject`); lockProposal(id, 'REJECTED'); } catch (e) { msgBox('Reject failed', e.message, { warn: true }); }
}

/* ---------------------------------------------------------------- settings */
const PROVIDER_LABELS = { anthropic: 'Anthropic', openai: 'OpenAI', gemini: 'Google Gemini', openrouter: 'OpenRouter', opencode: 'OpenCode (free models, no key)', local: 'Local endpoint (OpenAI-compatible)' };
function renderProviderSelect() {
  const sel = $('#providerSelect');
  const s = state.settings;
  sel.replaceChildren(...Object.keys(PROVIDER_LABELS).map((p) => h('option', { value: p, selected: p === s.activeProvider }, `${p === 'gemini' ? 'Gemini' : PROVIDER_LABELS[p].split(' ')[0]}${s.providers[p].hasKey || p === 'local' || p === 'opencode' ? '' : ' (no key)'}`)));
  const cfg = s.providers[s.activeProvider];
  $('#sbProvider').textContent = `${s.activeProvider}: ${cfg.model}`;
}
async function loadSettings() { state.settings = await api('GET', '/api/settings'); renderProviderSelect(); }

async function openSettings() {
  const s = state.settings;
  const inputs = {};
  const groups = Object.keys(PROVIDER_LABELS).map((p) => {
    const c = s.providers[p];
    const key = h('input', { type: 'password', class: 'field', autocomplete: 'off', placeholder: c.hasKey ? `stored (${c.keyHint}) — leave blank to keep` : p === 'local' ? 'optional' : 'not set' });
    const clear = h('input', { type: 'checkbox' });
    const model = h('input', { type: 'text', class: 'field', value: c.model });
    const base = h('input', { type: 'text', class: 'field', value: c.baseUrl });
    inputs[p] = { key, clear, model, base };
    const list = h('button', { class: 'btn small', title: 'Fetch the models this key can use', onclick: () => pickModel(p, inputs[p]) }, 'List...');
    if (p === 'opencode') {
      const st = h('span', { class: 'oc-status' }, 'checking…');
      api('GET', '/api/opencode/status').then((o) => { st.textContent = o.bin ? `installed: ${o.version || ''} (${o.bin})` : 'not installed'; }).catch(() => { st.textContent = 'unknown'; });
      return h('fieldset', { class: `group${p === s.activeProvider ? ' activep' : ''}` }, h('legend', null, PROVIDER_LABELS[p]),
        h('div', { class: 'form-grid' },
          h('label', null, 'OpenCode:'), st, h('button', { class: 'btn small', onclick: () => openCodeSetup() }, 'Install...'),
          h('label', null, 'Free model:'), model, list,
          h('div', { class: 'full note' }, OC_PRIVACY)));
    }
    return h('fieldset', { class: `group${p === s.activeProvider ? ' activep' : ''}` }, h('legend', null, PROVIDER_LABELS[p]),
      h('div', { class: 'form-grid' },
        h('label', null, 'API key:'), key, h('label', { title: 'Remove the stored key' }, clear, 'Clear'),
        h('label', null, 'Model:'), model, list,
        h('label', null, 'Base URL:'), base, h('span')));
  });
  const active = h('select', { class: 'field' }, Object.keys(PROVIDER_LABELS).map((p) => h('option', { value: p, selected: p === s.activeProvider }, PROVIDER_LABELS[p])));
  const maxTokens = h('input', { type: 'number', class: 'field', value: s.maxTokens, min: 64 });
  const temp = h('input', { type: 'text', class: 'field', value: s.temperature ?? '', placeholder: 'provider default' });
  const maxCtx = h('input', { type: 'number', class: 'field', value: s.maxContextChars, min: 1000 });
  const respTimeout = h('input', { type: 'number', class: 'field', value: s.responseTimeout ?? 120, min: 10, max: 290, title: 'Give up if the provider sends nothing for this many seconds (10-290)' });
  const autoApply = h('input', { type: 'checkbox', checked: s.autoApply });
  const backups = h('input', { type: 'checkbox', checked: s.backups });

  const tex = texSettingsGroup(s);
  const body = h('div', { class: 'settings' },
    h('div', { class: 'form-grid' }, h('label', null, 'Active provider:'), active, h('span')),
    groups,
    tex.group,
    h('fieldset', { class: 'group' }, h('legend', null, 'Generation & Patching'),
      h('div', { class: 'form-grid' },
        h('label', null, 'Max output tokens:'), maxTokens, h('span'),
        h('label', null, 'Temperature:'), temp, h('span'),
        h('label', null, 'Max context chars:'), maxCtx, h('span'),
        h('label', null, 'Response timeout (s):'), respTimeout, h('span'),
        h('label', { class: 'full' }, autoApply, 'Automatically apply all proposed hunks (no review)'),
        h('label', { class: 'full' }, backups, 'Back up files to .byotex-backups/ before every write'))),
    h('div', { class: 'note' }, `Keys are stored encrypted (AES-256-GCM, ${s.kdf}) in:\n${s.storePath}\nThey are never sent back to this page.`));
  body.querySelector('.note').style.whiteSpace = 'pre-wrap';

  const collect = () => {
    const patch = { activeProvider: active.value, maxTokens: Number(maxTokens.value), temperature: temp.value.trim() === '' ? null : Number(temp.value), maxContextChars: Number(maxCtx.value), responseTimeout: Number(respTimeout.value), autoApply: autoApply.checked, backups: backups.checked, texPath: tex.pathInput.value, providers: {} };
    for (const [p, i] of Object.entries(inputs)) patch.providers[p] = p === 'opencode' ? { model: i.model.value } : { apiKey: i.key.value, clearKey: i.clear.checked, model: i.model.value, baseUrl: i.base.value };
    return patch;
  };
  const save = async () => {
    if (active.value === 'opencode' && state.settings.activeProvider !== 'opencode' && !(await confirmOpenCode())) return false;
    try { state.settings = await api('PUT', '/api/settings', collect()); renderProviderSelect(); status('Settings saved'); return true; }
    catch (e) { await msgBox('Settings', e.message, { warn: true }); return false; }
  };
  await dialog('Settings', body, [
    { label: 'OK', default: true, onClick: async () => (await save()) || false },
    { label: 'Cancel', value: null },
    { label: 'Apply', onClick: async () => { if (await save()) Object.values(inputs).forEach((i) => { i.key.value = ''; i.clear.checked = false; }); return false; } },
  ], { width: 560 });
}

async function pickModel(provider, inp) {
  status(`Fetching ${PROVIDER_LABELS[provider]} models…`);
  let models;
  try {
    models = (await api('POST', '/api/models', { provider, apiKey: inp.key.value, baseUrl: inp.base.value })).models;
  } catch (e) {
    status('Ready');
    return msgBox('List models', e.message, { warn: true });
  }
  status('Ready');
  if (!models.length) return msgBox('List models', `${PROVIDER_LABELS[provider]} returned no models.`);
  const filter = h('input', { type: 'text', class: 'field', placeholder: 'Filter…', style: 'width:100%;margin-bottom:4px' });
  const box = h('select', { class: 'field', size: 14, style: 'width:100%;height:auto;font-family:var(--mono)' });
  const count = h('div', { style: 'margin-top:4px' });
  const fill = () => {
    const q = filter.value.trim().toLowerCase();
    const shown = models.filter((m) => !q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
    box.replaceChildren(...shown.map((m) => h('option', { value: m.id, selected: m.id === inp.model.value }, m.name && m.name !== m.id ? `${m.id}  —  ${m.name}` : m.id)));
    if (box.selectedIndex < 0 && box.options.length) box.selectedIndex = 0;
    count.textContent = `${shown.length} of ${models.length} model(s). Current: ${inp.model.value || '(none)'}`;
  };
  filter.addEventListener('input', fill);
  filter.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') { e.preventDefault(); box.focus(); } });
  fill();
  let chosen = null;
  box.addEventListener('dblclick', () => { chosen = box.value; $('#modalLayer').lastElementChild.querySelector('.btn.default').click(); });
  const ok = await dialog(`${PROVIDER_LABELS[provider]} — Models`, h('div', null, filter, box, count),
    [{ label: 'Use Model', value: true, default: true }, { label: 'Cancel', value: false }], { width: 460 });
  if (ok && (chosen || box.value)) {
    inp.model.value = chosen || box.value;
    status(`Model set to ${inp.model.value} — click OK or Apply to save`);
  }
}

/* ------------------------------------------------------------ LaTeX setup */
const TOOL_LABELS = { latexmk: 'latexmk', pdflatex: 'pdfLaTeX', xelatex: 'XeLaTeX', lualatex: 'LuaLaTeX', bibtex: 'BibTeX', biber: 'Biber', synctex: 'SyncTeX', perl: 'Perl' }; // latexmk is a Perl script
function texToolsView(st) {
  const box = h('div', { class: 'tex-tools sunken' });
  for (const [k, label] of Object.entries(TOOL_LABELS)) {
    const p = st.tools[k];
    box.append(h('div', { class: p ? 'ok' : 'miss' }, `${p ? '✓' : '✗'} ${label.padEnd(9)} ${p || 'not found'}`));
  }
  if (st.pdflatexVersion) box.append(h('div', { class: 'ver' }, st.pdflatexVersion));
  return box;
}

/** Settings section: folder field, detection, install button. */
function texSettingsGroup(s) {
  const pathInput = h('input', { type: 'text', class: 'field', value: s.texPath || '', placeholder: 'auto-detect (MacTeX, TeX Live, MiKTeX, TinyTeX)', title: 'Folder that contains latexmk and pdflatex, e.g. /Library/TeX/texbin' });
  const result = h('div', { class: 'tex-result' }, 'Click Detect to check this computer.');
  const detect = async () => {
    result.textContent = 'Checking…';
    try {
      // Save the folder first so detection uses it.
      if ((pathInput.value.trim() || '') !== (state.settings.texPath || '')) state.settings = await api('PUT', '/api/settings', { texPath: pathInput.value });
      const st = await api('GET', '/api/tex/status');
      result.replaceChildren(h('div', { style: 'font-weight:bold;margin-bottom:3px' }, st.ready ? 'LaTeX is ready.' : 'LaTeX is not fully available.'), texToolsView(st));
    } catch (e) { result.textContent = e.message; }
  };
  const group = h('fieldset', { class: 'group' }, h('legend', null, 'LaTeX Installation'),
    h('div', { class: 'form-grid' },
      h('label', null, 'TeX bin folder:'), pathInput, h('button', { class: 'btn small', onclick: detect }, 'Detect'),
      h('div', { class: 'full' }, result),
      h('div', { class: 'full', style: 'display:flex;gap:4px' },
        h('button', { class: 'btn small', onclick: () => texSetupDialog() }, 'Install LaTeX...'))));
  return { group, pathInput };
}

/** Shown when compiling finds no LaTeX, and from Settings → Install LaTeX. */
async function texSetupDialog(reason) {
  let st;
  try { st = await api('GET', '/api/tex/status'); } catch (e) { return msgBox('LaTeX setup', e.message, { warn: true }); }
  const osName = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[st.platform] || st.platform;
  const pathInput = h('input', { type: 'text', class: 'field', value: st.texPath || '', placeholder: st.platform === 'win32' ? 'C:\\texlive\\2025\\bin\\windows' : '/Library/TeX/texbin', style: 'width:100%' });
  const manual = h('div', { class: 'tex-manual' }, st.manual.map((m) => h('div', null,
    h('b', null, m.name), h('br'), h('code', null, m.how), ' ', h('a', { href: m.url, target: '_blank', rel: 'noopener noreferrer' }, 'website'))));
  const body = h('div', { class: 'tex-setup' },
    reason ? h('div', { class: 'dlg-msg', style: 'margin-bottom:8px' }, h('div', { class: 'dlg-icon warn' }, '!'), h('div', null, reason)) : null,
    h('fieldset', { class: 'group' }, h('legend', null, `Detected on this computer (${osName})`), texToolsView(st)),
    h('fieldset', { class: 'group' }, h('legend', null, 'Option 1 — LaTeX is installed somewhere else'),
      h('div', null, 'Enter the folder that contains latexmk and pdflatex:'), pathInput,
      h('div', { class: 'note' }, 'Tip: in a terminal, run "which pdflatex" (macOS/Linux) or "where pdflatex" (Windows) and use its folder.')),
    h('fieldset', { class: 'group' }, h('legend', null, 'Option 2 — Install TinyTeX from here'),
      h('div', null, `Downloads the official TinyTeX installer from yihui.org and installs a small TeX Live into\n${st.tinytexRoot}\nNo administrator password is needed. Expect a few hundred MB of downloads; missing LaTeX packages can be added later with tlmgr. Progress appears in the Log Console.`)),
    h('fieldset', { class: 'group' }, h('legend', null, 'Option 3 — Install a full distribution yourself (needs admin)'), manual));
  body.querySelectorAll('.tex-setup .group > div').forEach((d) => { d.style.whiteSpace = 'pre-wrap'; });
  const choice = await dialog('LaTeX Setup', body, [
    { label: 'Use This Folder', value: 'path' },
    { label: st.install.running ? 'Installing…' : 'Install TinyTeX', value: 'install' },
    { label: 'Close', value: null, default: true },
  ], { width: 600 });
  if (choice === 'path') {
    try {
      state.settings = await api('PUT', '/api/settings', { texPath: pathInput.value });
      const s2 = await api('GET', '/api/tex/status');
      msgBox('LaTeX setup', s2.ready ? `LaTeX found:\n${s2.tools.latexmk}\n${s2.pdflatexVersion || ''}` : 'latexmk / pdflatex were not found in that folder (or anywhere else).', { warn: !s2.ready });
    } catch (e) { msgBox('LaTeX setup', e.message, { warn: true }); }
  } else if (choice === 'install') {
    if (st.install.running) return msgBox('LaTeX setup', 'An installation is already running — watch the Log Console.');
    const ok = await confirmBox('Install TinyTeX', `This downloads and runs the official TinyTeX installer:\n  ${st.platform === 'win32' ? 'https://yihui.org/tinytex/install-bin-windows.bat' : 'https://yihui.org/tinytex/install-bin-unix.sh'}\nand installs into ${st.tinytexRoot}.\n\nContinue?`);
    if (ok) startTexInstall();
  }
}

/* ---------------------------------------------------------------- citations */
/** Insert text at the editor cursor (marks the file modified). */
function editorInsertText(text) {
  const ta = code();
  if (!state.file || state.file.kind === 'figure' || ta.disabled) return false;
  ta.focus();
  ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
  ta.dispatchEvent(new Event('input'));
  return true;
}
/** Search Crossref + arXiv, preview real BibTeX, add it to a .bib, optionally insert \cite{key}. */
async function citeDialog(initial = '') {
  const bibs = Object.values(state.scan?.files || {}).filter((f) => f.kind === 'bib').map((f) => f.path);
  const q = h('input', { type: 'text', class: 'field', value: initial, placeholder: 'Title, authors + keywords, a DOI (10.…) or an arXiv id (2007.01282)', style: 'flex:1' });
  const go = h('button', { class: 'btn' }, 'Search');
  const results = h('div', { class: 'cite-results sunken' }, h('div', { class: 'hint' }, 'Results come from Crossref (journals, conferences) and arXiv (preprints). Nothing here is generated by the AI.'));
  const preview = h('pre', { class: 'cite-bib sunken' }, '');
  const info = h('div', { class: 'cite-info' }, '');
  const bibSel = h('select', { class: 'field' }, (bibs.length ? bibs : ['refs.bib (new)']).map((b) => h('option', { value: bibs.length ? b : '' }, b)));
  let current = null; // { item, key, bibtex, existingKey }
  const insertBtn = h('button', { class: 'btn', disabled: true }, 'Add + Insert \\cite');
  const addBtn = h('button', { class: 'btn', disabled: true }, 'Add to .bib');
  const setButtons = () => {
    const ok = !!current && !current.loading;
    addBtn.disabled = !ok || !!current?.existingKey;
    insertBtn.disabled = !ok;
    insertBtn.textContent = current?.existingKey ? `Insert \\cite{${current.existingKey}}` : 'Add + Insert \\cite';
  };
  const run = async () => {
    const text = q.value.trim();
    if (text.length < 3) return;
    results.replaceChildren(h('div', { class: 'hint' }, 'Searching Crossref and arXiv…'));
    current = null; preview.textContent = ''; info.textContent = ''; setButtons();
    let r;
    try { r = await api('GET', `/api/cite/search?q=${encodeURIComponent(text)}`); } catch (e) { results.replaceChildren(h('div', { class: 'p-err' }, e.message)); return; }
    results.replaceChildren();
    if (!r.results.length) results.append(h('div', { class: 'hint' }, `No matches.${r.errors.length ? ` (${r.errors.join('; ')})` : ' Try different words or the exact title.'}`));
    for (const it of r.results) {
      const authors = it.authors.length > 3 ? `${it.authors.slice(0, 3).map((a) => a.split(',')[0]).join(', ')} et al.` : it.authors.map((a) => a.split(',')[0]).join(', ');
      const row = h('div', { class: 'cite-row' },
        h('div', { class: 'cite-title' }, it.title),
        h('div', { class: 'cite-meta' }, [authors, it.year, it.venue].filter(Boolean).join(' · ')),
        h('div', { class: 'cite-id' }, h('span', { class: `cite-src src-${it.source}` }, it.source === 'arxiv' ? 'arXiv' : 'DOI'), ' ', it.source === 'arxiv' ? it.arxiv : it.doi));
      row.addEventListener('click', async () => {
        results.querySelectorAll('.cite-row.sel').forEach((x) => x.classList.remove('sel'));
        row.classList.add('sel');
        current = { item: it, loading: true }; setButtons();
        preview.textContent = 'Fetching BibTeX…'; info.textContent = '';
        try {
          const b = await api('POST', '/api/cite/bibtex', { item: it });
          current = { item: it, ...b };
          if (b.existingKey) { preview.textContent = ''; info.textContent = `Already in ${b.bibFile} as ${b.existingKey}, so nothing new will be added.`; }
          else { preview.textContent = b.bibtex; info.textContent = `BibTeX from ${b.from}. Key: ${b.key}`; }
        } catch (e) { current = null; preview.textContent = ''; info.textContent = e.message; }
        setButtons();
      });
      results.append(row);
    }
  };
  go.addEventListener('click', run);
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); run(); } });
  const add = async (insert) => {
    if (!current) return;
    let key = current.existingKey;
    if (!key) {
      try {
        const w = await api('POST', '/api/cite/add', { bibFile: bibSel.value || null, bibtex: current.bibtex, note: `Added ${current.key}: ${current.item.title.slice(0, 90)}` });
        key = current.key;
        status(`Added ${key} to ${w.bibFile}`);
        if (w.createdBib) msgBox('New bibliography file', `Created ${w.bibFile}. Make sure your main file loads it, e.g.\n\n\\bibliographystyle{plain}\n\\bibliography{${w.bibFile.replace(/\.bib$/, '')}}`);
        await loadWorkspace(false);
        current.existingKey = key; setButtons();
        info.textContent = `Added to ${w.bibFile} as ${key}.`;
      } catch (e) { return msgBox('Add citation', e.message, { warn: true }); }
    }
    if (insert) {
      if (editorInsertText(`\\cite{${key}}`)) status(`Inserted \\cite{${key}} (unsaved)`);
      else { copyText(`\\cite{${key}}`); status(`No .tex file open: copied \\cite{${key}} to the clipboard`); }
    }
  };
  addBtn.addEventListener('click', () => add(false));
  insertBtn.addEventListener('click', () => add(true));
  const body = h('div', { class: 'cite' },
    h('div', { class: 'cite-search' }, q, go),
    h('div', { class: 'cite-main' }, results, h('div', { class: 'cite-side' }, preview, info,
      h('div', { class: 'cite-actions' }, h('label', null, 'Add to: '), bibSel, addBtn, insertBtn))));
  const p = dialog('Find Reference', body, [{ label: 'Close', value: null, default: true }], { width: 940 });
  setTimeout(() => { q.focus(); if (initial) run(); }, 0);
  await p;
}

/* ------------------------------------------------------------------ history */
const SOURCE_LABEL = { ai: 'AI edit', editor: 'Editor save', restore: 'Restore', citation: 'Citation added' };
/** Read-only diff table from a server "view" (same rows as proposals, without checkboxes). */
function renderDiffView(view) {
  const tbl = h('table', { class: 'diff' });
  for (const r of view) {
    if (r.t === '~') { tbl.append(h('tr', { class: 'skip' }, h('td', { colspan: 4 }, `··· ${r.count} unchanged line${r.count > 1 ? 's' : ''} ···`))); continue; }
    const cls = r.t === '+' ? 'add' : r.t === '-' ? 'del' : 'ctx';
    tbl.append(h('tr', { class: cls }, h('td', { class: 'ln' }, r.o ?? ''), h('td', { class: 'ln' }, r.n ?? ''), h('td', { class: 'sg' }, r.t === '=' ? ' ' : r.t), h('td', { class: 'tx' }, r.s || ' ')));
  }
  return tbl;
}
async function historyDialog() {
  let entries;
  try { entries = (await api('GET', '/api/history')).entries; } catch (e) { return msgBox('History', e.message, { warn: true }); }
  const list = h('div', { class: 'hist-list sunken' });
  const detail = h('div', { class: 'hist-detail' }, h('div', { class: 'hint' }, entries.length ? 'Select a change to see how the file differs from the version saved before it.' : 'No changes recorded yet in this project. Every AI edit, editor save, restore and added citation will appear here.'));
  let selected = null;
  const restoreBtn = h('button', { class: 'btn', disabled: true, onclick: async () => {
    if (!selected) return;
    const ok = await confirmBox('Restore version', `Put ${selected.path} back to how it was just before this change (${new Date(selected.time).toLocaleString()})?\n\nThe current version is backed up first, so this can be undone from History too.`);
    if (!ok) return;
    try {
      await api('POST', `/api/history/${selected.id}/restore`);
      status(`Restored ${selected.path}`);
      await loadWorkspace(false);
      await reloadOpenFile();
      if (prefs.autoCompile) compile();
      $('#modalLayer').lastElementChild.querySelector('.dlg-btns .btn:last-child').click(); // close; reopen shows the new entry
      historyDialog();
    } catch (e) { msgBox('Restore failed', e.message, { warn: true }); }
  } }, 'Restore This Version');
  const openBtn = h('button', { class: 'btn', disabled: true, onclick: () => selected && openFile(selected.path) }, 'Open File');
  for (const e of entries) {
    const row = h('div', { class: 'hist-row' },
      h('span', { class: 'hist-time' }, new Date(e.time).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })),
      h('span', { class: `hist-src src-${e.source}` }, SOURCE_LABEL[e.source] || e.source),
      h('span', { class: 'hist-path' }, e.path),
      h('span', { class: 'hist-note', title: e.note }, e.note || ''));
    row.addEventListener('click', async () => {
      list.querySelectorAll('.hist-row.sel').forEach((x) => x.classList.remove('sel'));
      row.classList.add('sel');
      selected = e;
      restoreBtn.disabled = !e.restorable;
      openBtn.disabled = false;
      detail.replaceChildren(h('div', { class: 'hint' }, 'Loading…'));
      try {
        const d = await api('GET', `/api/history/${e.id}`);
        detail.replaceChildren(
          h('div', { class: 'hist-head' }, `${e.path}: version before this change → the file now`, e.restorable ? '' : '  (no earlier version: this change created the file)'),
          d.identical ? h('div', { class: 'hint' }, 'The file is currently identical to the version before this change.') : renderDiffView(d.view));
      } catch (err) { detail.replaceChildren(h('div', { class: 'p-err' }, err.message)); }
    });
    list.append(row);
  }
  const syncButtons = () => {
    const btns = $('#modalLayer').lastElementChild?.querySelectorAll('.dlg-btns .btn');
    if (btns && btns.length === 3) { btns[0].disabled = restoreBtn.disabled; btns[1].disabled = openBtn.disabled; }
  };
  new MutationObserver(syncButtons).observe(restoreBtn, { attributes: true });
  new MutationObserver(syncButtons).observe(openBtn, { attributes: true });
  setTimeout(syncButtons, 0);
  await dialog('History', h('div', { class: 'hist' }, list, detail), [
    { label: 'Restore This Version', onClick: () => { restoreBtn.click(); return false; } },
    { label: 'Open File', onClick: () => { openBtn.click(); return !!selected; } },
    { label: 'Close', value: null, default: true },
  ], { width: 860 });
}

/* ---------------------------------------------------- missing LaTeX packages */
const askedMissing = new Set();
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); status('Copied to clipboard'); } catch { status('Copy failed: select the text and copy it manually'); }
}
/** "File `x.sty' not found" → find the package with tlmgr → install it, or show the command to run. */
async function missingPackagesDialog(files) {
  const body = h('div', { class: 'pkg-dialog' }, h('div', { style: 'margin-bottom:6px' }, `Compiling needs ${files.length === 1 ? 'a file' : 'files'} that your LaTeX doesn't have yet. Looking up which package provides ${files.length === 1 ? 'it' : 'them'}…`));
  const rows = files.map((f) => {
    const row = h('fieldset', { class: 'group' }, h('legend', null, f), h('div', { class: 'pkg-msg' }, 'searching…'));
    body.append(row);
    return { f, row };
  });
  const done = dialog('Missing LaTeX Packages', body, [{ label: 'Compile Again', value: 'compile' }, { label: 'Close', value: null, default: true }], { width: 620 });
  for (const { f, row } of rows) {
    const msg = row.querySelector('.pkg-msg');
    let r;
    try { r = await api('POST', '/api/tex/package/find', { file: f }); } catch (e) { msg.textContent = e.message; continue; }
    msg.replaceChildren();
    if (r.noTlmgr) {
      msg.append(r.miktex
        ? 'MiKTeX normally installs missing packages by itself during the compile. If it asked and you declined, open MiKTeX Console → Packages and install it there.'
        : 'tlmgr (TeX Live\'s package manager) was not found. Install TinyTeX from Build → LaTeX Installation…, or install the package with your system\'s package manager.');
      continue;
    }
    if (r.oldRelease) msg.append(h('div', { class: 'note' }, `Your TeX Live ${r.oldRelease.local} is older than the current ${r.oldRelease.remote}, so packages come from the frozen ${r.oldRelease.local} archive.`));
    if (!r.packages.length) {
      msg.append(h('div', null, `No TeX Live package contains ${f}.${r.error ? ` (${r.error})` : ''} Check the spelling in \\usepackage / \\documentclass, or whether the file should be in your project.`));
      continue;
    }
    for (const pkg of r.packages) {
      const line = h('div', { class: 'pkg-line' }, h('span', null, 'Package: '), h('b', null, pkg), ' ');
      if (r.writable) {
        const btn = h('button', { class: 'btn small', onclick: async () => {
          btn.disabled = true;
          try { await api('POST', '/api/tex/package/install', { pkg, repo: r.repo }); } catch (e) { btn.disabled = false; return msgBox('Install package', e.message, { warn: true }); }
          if (prefs.logCollapsed) setPref('logCollapsed', false);
          btn.textContent = 'Installing…';
          const poll = setInterval(async () => {
            const st = await api('GET', '/api/tex/package/status').catch(() => null);
            if (!st || st.running) return;
            clearInterval(poll);
            btn.textContent = st.ok ? 'Installed ✓' : 'Failed';
            status(st.message);
          }, 1500);
        } }, `Install ${pkg}`);
        line.append(btn);
      } else {
        const cmd = r.commands[pkg];
        line.append(h('div', { class: 'note' }, 'Your TeX Live folder needs administrator rights, so run this in a terminal (it asks for your password):'),
          h('div', { class: 'pkg-cmd' }, h('code', null, cmd), h('button', { class: 'btn small', onclick: () => copyText(cmd) }, 'Copy')));
      }
      msg.append(line);
    }
  }
  if ((await done) === 'compile') compile();
}

async function startTexInstall() {
  try { await api('POST', '/api/tex/install'); } catch (e) { return msgBox('Install TinyTeX', e.message, { warn: true }); }
  if (prefs.logCollapsed) setPref('logCollapsed', false);
  const t0 = Date.now();
  const poll = setInterval(async () => {
    let st;
    try { st = await api('GET', '/api/tex/status'); } catch { return; }
    if (st.install.running) { status(`Installing TinyTeX… ${Math.round((Date.now() - t0) / 1000)}s (see Log Console)`); return; }
    clearInterval(poll);
    status(st.install.ok ? 'TinyTeX installed' : 'TinyTeX install failed');
    await loadSettings();
    msgBox('Install TinyTeX', st.install.message, { warn: !st.install.ok });
  }, 2000);
}

/* ---------------------------------------------------------------- OpenCode */
const OC_PRIVACY = 'Privacy: OpenCode says prompts sent to its FREE models may be stored and used to train or improve those models. Your manuscript text is sent with each request, so avoid free models for confidential or unpublished work you do not want shared. OpenCode tools (file edits, shell) are disabled: edits still go through BYOTeX.AI\'s diff review. Free use is rate-limited by OpenCode.';
/** Before switching to OpenCode: privacy notice once, and install if missing. */
async function confirmOpenCode() {
  let st;
  try { st = await api('GET', '/api/opencode/status'); } catch (e) { msgBox('OpenCode', e.message, { warn: true }); return false; }
  if (!st.bin) { await openCodeSetup(); return false; }
  if (!prefs.ocPrivacyOk) {
    const ok = await confirmBox('Use OpenCode free models?', `${OC_PRIVACY}\n\nContinue with OpenCode?`);
    if (!ok) return false;
    setPref('ocPrivacyOk', true);
  }
  return true;
}
async function openCodeSetup() {
  let st;
  try { st = await api('GET', '/api/opencode/status'); } catch (e) { return msgBox('OpenCode', e.message, { warn: true }); }
  if (st.bin) return msgBox('OpenCode', `OpenCode is installed:\n${st.bin}\n${st.version || ''}\n\nChoose "OpenCode" as the provider and pick a free model with List... in Settings.`);
  const ok = await confirmBox('Install OpenCode', `OpenCode was not found on this computer.\n\nInstall it now? BYOTeX.AI will run:\n  npm install opencode-ai  (into ${st.installDir})\n\nThis downloads the official, MIT-licensed OpenCode package from the npm registry (roughly 100 MB with its platform binary). No administrator rights are needed. Progress appears in the Log Console.\n\n${OC_PRIVACY}`);
  if (!ok) return;
  try { await api('POST', '/api/opencode/install'); } catch (e) { return msgBox('Install OpenCode', e.message, { warn: true }); }
  if (prefs.logCollapsed) setPref('logCollapsed', false);
  const t0 = Date.now();
  const poll = setInterval(async () => {
    let s2;
    try { s2 = await api('GET', '/api/opencode/status'); } catch { return; }
    if (s2.install.running) { status(`Installing OpenCode… ${Math.round((Date.now() - t0) / 1000)}s`); return; }
    clearInterval(poll);
    status(s2.install.ok ? 'OpenCode installed' : 'OpenCode install failed');
    msgBox('Install OpenCode', s2.install.message, { warn: !s2.install.ok });
  }, 2000);
}

async function testProvider() {
  const s = state.settings;
  status(`Testing ${s.activeProvider}…`);
  try {
    const res = await tokenFetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'Connection test. Reply with exactly: OK' }], targets: [], mode: 'ask' }) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    const text = await res.text();
    const evs = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const err = evs.find((e) => e.type === 'error');
    if (err) throw new Error(err.message);
    const reply = evs.filter((e) => e.type === 'delta').map((e) => e.text).join('');
    const u = evs.find((e) => e.type === 'usage');
    msgBox('Provider test', `${s.activeProvider} / ${s.providers[s.activeProvider].model}\n\nReply: ${reply.slice(0, 200)}\nTokens: ${u?.input} in / ${u?.output} out`);
  } catch (e) { msgBox('Provider test failed', e.message, { warn: true }); }
  status('Ready');
}

/* --------------------------------------------------------------- workspace */
async function loadWorkspace(log = true) {
  state.scan = await api('GET', '/api/workspace');
  // Folder name only (keeps the home-folder path out of screenshots); full path on hover.
  $('#sbRoot').textContent = state.scan.root.split(/[\\/]/).filter(Boolean).pop() || state.scan.root;
  $('#sbRoot').title = state.scan.root;
  if (state.expanded.size <= 1) {
    // first load: expand dirs and the main file
    const walk = (n) => { if (n.type === 'dir') { state.expanded.add(`dir:${n.path}`); n.children.forEach(walk); } };
    walk(state.scan.tree);
    if (state.scan.mainFile) state.expanded.add(nodeKey({ kind: 'file', path: state.scan.mainFile }));
  }
  renderMainSelect();
  renderTree();
  $('#outlineMain').textContent = prefs.treeView === 'outline' && prefs.mainFile ? `from ${prefs.mainFile}` : '';
  if (log) status(`Workspace: ${state.scan.fileCount} files`);
}
async function rescan() {
  state.scan = await api('POST', '/api/workspace/rescan');
  renderTree();
  status('Rescanned');
}
async function openWorkspace() {
  const input = h('input', { type: 'text', class: 'field', value: state.scan?.root || '', style: 'width:100%' });
  const ok = await dialog('Open Workspace', h('div', null, h('div', { style: 'margin-bottom:6px' }, 'Absolute path of the LaTeX project folder:'), input),
    [{ label: 'Open', value: true, default: true }, { label: 'Cancel', value: false }], { width: 480 });
  if (!ok) return;
  try {
    state.scan = await api('POST', '/api/workspace', { root: input.value });
    state.expanded = new Set(['']);
    state.targets = []; renderTargets();
    state.compileDiags = []; state.pdf = null; prefs.mainFile = null;
    state.file = null; code().value = ''; code().disabled = true; $('#edPath').textContent = '(no file open)'; updateGutter();
    await loadWorkspace();
  } catch (e) { msgBox('Open Workspace', e.message, { warn: true }); }
}
function printDiagnostics() {
  const d = state.scan?.diagnostics || [];
  if (!d.length) return localLog('info', 'diag', 'No problems found.');
  for (const x of d) localLog(x.level === 'error' ? 'error' : 'warn', 'diag', `${x.path}:${x.line} ${x.message}`);
}

/* ------------------------------------------------------- layout & prefs */
const PREF_KEY = 'byotex.prefs.v1';
const prefs = Object.assign({
  chatLayout: 'tabs', // tabs | bottom | right
  treeView: 'files', // files | outline
  autoContext: true, // send the open file when nothing else is in the context
  pdfSide: 'none', // none | left | right
  leftHidden: false,
  logCollapsed: false,
  edFont: 12, chatFont: 12, conFont: 11,
  edFamily: 'Menlo', edWeight: 400,
  uiColor: '#000000', mutedColor: '#000000', edColor: '#000000', chatColor: '#000000', conColor: '#c0c0c0', conBg: '#000000',
  pdfZoom: 'width',
  engine: 'pdflatex',
  mainFile: null,
  autoCompile: false,
  pdfWidth: null, chatSize: null, leftWidth: null,
}, (() => { try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch { return {}; } })());
function savePrefs() { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* storage unavailable */ } }
const edLineHeight = () => Math.round(prefs.edFont * 1.34);

function applyPrefs() {
  const root = document.documentElement.style;
  root.setProperty('--ed-fs', `${prefs.edFont}px`);
  root.setProperty('--ed-lh', `${edLineHeight()}px`);
  root.setProperty('--ed-font', `"${prefs.edFamily}", var(--mono)`);
  root.setProperty('--ed-fw', String(prefs.edWeight));
  root.setProperty('--chat-fs', `${prefs.chatFont}px`);
  root.setProperty('--con-fs', `${prefs.conFont}px`);
  root.setProperty('--ui-fg', prefs.uiColor);
  root.setProperty('--muted-fg', prefs.mutedColor);
  root.setProperty('--ed-fg', prefs.edColor);
  root.setProperty('--chat-fg', prefs.chatColor);
  root.setProperty('--con-fg', prefs.conColor);
  root.setProperty('--con-bg', prefs.conBg);

  $('#app').classList.toggle('no-left', prefs.leftHidden);
  $$('.tree-tabs .btn').forEach((b) => b.classList.toggle('on', b.dataset.arg === prefs.treeView));
  $('#outlineMain').textContent = prefs.treeView === 'outline' && prefs.mainFile ? `from ${prefs.mainFile}` : '';
  $('#leftBtn').classList.toggle('on', !prefs.leftHidden);
  $('#left').classList.toggle('log-collapsed', prefs.logCollapsed);
  $('#logToggle').textContent = prefs.logCollapsed ? '+' : '−';
  if (prefs.leftWidth) $('#left').style.width = `${prefs.leftWidth}px`;

  const work = $('#work');
  work.className = `work mode-${prefs.chatLayout}`;
  const chat = $('#panel-chat');
  chat.style.height = prefs.chatLayout === 'bottom' && prefs.chatSize ? `${prefs.chatSize}px` : '';
  chat.style.width = prefs.chatLayout === 'right' && prefs.chatSize ? `${prefs.chatSize}px` : '';
  if (prefs.chatLayout === 'tabs') showTab($('.tab.active')?.dataset.tab || 'editor');
  else { $('#panel-editor').hidden = false; $('#panel-chat').hidden = false; }

  const right = $('#right');
  const pdfOn = prefs.pdfSide !== 'none';
  right.classList.toggle('pdf-left', prefs.pdfSide === 'left');
  right.classList.toggle('pdf-right', prefs.pdfSide === 'right');
  $('#pdfPane').hidden = !pdfOn;
  $('#pdfSplit').hidden = !pdfOn;
  $('#pdfBtn').classList.toggle('on', pdfOn);
  if (prefs.pdfWidth) $('#pdfPane').style.flexBasis = `${prefs.pdfWidth}px`;

  refreshMenuChecks();
  updateGutter();
}
function refreshMenuChecks() {
  const checked = {
    'toggle-left': !prefs.leftHidden,
    'toggle-log': !prefs.logCollapsed,
    'toggle-autocompile': prefs.autoCompile,
    'tree-view': prefs.treeView,
    layout: prefs.chatLayout,
    'pdf-side': prefs.pdfSide,
    engine: prefs.engine,
  };
  $$('.mi.chk, .mi.radio').forEach((mi) => {
    const v = checked[mi.dataset.cmd];
    mi.classList.toggle('checked', mi.dataset.arg !== undefined ? v === mi.dataset.arg : !!v);
  });
}
function setPref(k, v) { prefs[k] = v; savePrefs(); applyPrefs(); }

const FONT_DEFAULTS = { edFamily: 'Menlo', edWeight: 400, edFont: 12, chatFont: 12, conFont: 11, uiColor: '#000000', mutedColor: '#000000', edColor: '#000000', chatColor: '#000000', conColor: '#c0c0c0', conBg: '#000000' };
async function fontDialog() {
  const keys = Object.keys(FONT_DEFAULTS);
  const orig = Object.fromEntries(keys.map((k) => [k, prefs[k]]));
  const grid = h('div', { class: 'font-grid' }, h('span', { class: 'hdr' }, 'Area'), h('span', { class: 'hdr' }, 'Size'), h('span', { class: 'hdr' }, 'Text'), h('span', { class: 'hdr' }, 'Back'), h('span', { class: 'hdr' }, 'Sample'));
  const controls = [];
  const rows = [
    ['Menus & panes', null, 'uiColor', null, 'font-family:var(--font)'],
    ['Secondary text', null, 'mutedColor', null, 'font-family:var(--font)'],
    ['Editor', 'edFont', 'edColor', null, ''],
    ['Chat / diffs', 'chatFont', 'chatColor', null, ''],
    ['Log console', 'conFont', 'conColor', 'conBg', ''],
  ];
  for (const [label, sizeKey, colorKey, bgKey, extra] of rows) {
    const sample = h('div', { class: 'sample', style: extra }, '\\section{Intro} % Aa');
    const paint = () => {
      sample.style.fontSize = sizeKey ? `${prefs[sizeKey]}px` : '11px';
      sample.style.color = prefs[colorKey];
      sample.style.background = bgKey ? prefs[bgKey] : '#fff';
    };
    const size = sizeKey ? h('input', { type: 'number', class: 'field', min: 8, max: 32, value: prefs[sizeKey] }) : h('span');
    if (sizeKey) size.addEventListener('input', () => { prefs[sizeKey] = Math.max(8, Math.min(32, Number(size.value) || orig[sizeKey])); paint(); applyPrefs(); });
    const color = h('input', { type: 'color', value: prefs[colorKey], title: 'Text colour' });
    color.addEventListener('input', () => { prefs[colorKey] = color.value; paint(); applyPrefs(); });
    const bg = bgKey ? h('input', { type: 'color', value: prefs[bgKey], title: 'Background colour' }) : h('span');
    if (bgKey) bg.addEventListener('input', () => { prefs[bgKey] = bg.value; paint(); applyPrefs(); });
    controls.push({ sizeKey, colorKey, bgKey, size, color, bg, paint });
    paint();
    grid.append(h('label', null, `${label}:`), size, color, bg, sample);
  }
  // Editor typeface: only offer monospace fonts that are actually installed.
  const CANDIDATES = ['Menlo', 'Monaco', 'SF Mono', 'PT Mono', 'Andale Mono', 'JetBrains Mono', 'Fira Code', 'Source Code Pro', 'IBM Plex Mono', 'Consolas', 'Lucida Console', 'DejaVu Sans Mono', 'Courier New'];
  const cvs = document.createElement('canvas').getContext('2d');
  const width = (f) => { cvs.font = `40px ${f}`; return cvs.measureText('mmmmmiiiiilllWW@#').width; };
  const baseMono = width('monospace'); const baseSerif = width('serif');
  const installed = CANDIDATES.filter((f) => width(`"${f}", monospace`) !== baseMono || width(`"${f}", serif`) !== baseSerif);
  if (!installed.includes(prefs.edFamily)) installed.unshift(prefs.edFamily);
  const family = h('select', { class: 'field' }, installed.map((f) => h('option', { value: f, selected: f === prefs.edFamily, style: `font-family:"${f}"` }, f)));
  const weight = h('select', { class: 'field' }, [[400, 'Normal'], [500, 'Medium'], [600, 'Semibold'], [700, 'Bold']].map(([v, l]) => h('option', { value: v, selected: v === Number(prefs.edWeight) }, l)));
  const edSample = controls.find((c) => c.sizeKey === 'edFont');
  const paintEd = () => { const el = grid.children[[...grid.children].indexOf(edSample.size) + 3]; if (el) { el.style.fontFamily = `"${prefs.edFamily}", monospace`; el.style.fontWeight = prefs.edWeight; } };
  family.addEventListener('change', () => { prefs.edFamily = family.value; paintEd(); applyPrefs(); });
  weight.addEventListener('change', () => { prefs.edWeight = Number(weight.value); paintEd(); applyPrefs(); });
  paintEd();
  const fontRow = h('div', { class: 'font-row' }, h('label', null, 'Editor font:'), family, weight);
  const sync = () => {
    family.value = prefs.edFamily; weight.value = String(prefs.edWeight); paintEd();
    syncRows();
  };
  const syncRows = () => controls.forEach((c) => {
    if (c.sizeKey) c.size.value = prefs[c.sizeKey];
    c.color.value = prefs[c.colorKey];
    if (c.bgKey) c.bg.value = prefs[c.bgKey];
    c.paint();
  });
  const preset = (vals) => { Object.assign(prefs, vals); sync(); applyPrefs(); return false; };
  const ok = await dialog('Fonts & Colors', h('div', null, grid, fontRow,
    h('div', { style: 'margin-top:10px;color:#000' }, 'Sizes in pixels (8–32). Changes preview live.')),
  [
    { label: 'OK', value: true, default: true },
    { label: 'Cancel', value: false },
    { label: 'Light Console', onClick: () => preset({ conColor: '#000000', conBg: '#ffffff' }) },
    { label: 'Defaults', onClick: () => preset({ ...FONT_DEFAULTS }) },
  ], { width: 520 });
  if (!ok) Object.assign(prefs, orig);
  savePrefs();
  applyPrefs();
}

/* ------------------------------------------------------------------ compile */
state.compileDiags = [];
state.pdf = null;
const texMains = () => Object.values(state.scan?.files || {}).filter((f) => f.kind === 'tex' && f.documentclass).map((f) => f.path);
function renderMainSelect() {
  const mains = texMains();
  if (!mains.includes(prefs.mainFile)) prefs.mainFile = state.scan?.mainFile || mains[0] || null;
  $('#mainSelect').replaceChildren(...(mains.length ? mains : ['(no main file)']).map((m) => h('option', { value: m, selected: m === prefs.mainFile }, m)));
}
function pdfUrlFor(rel, v) { return `/api/raw?path=${encodeURIComponent(rel)}&token=${encodeURIComponent(TOKEN)}&v=${v || Date.now()}`; }
let viewer = null;
function pdfViewer() {
  if (viewer) return viewer;
  const zoomSel = $('#pdfZoom');
  zoomSel.replaceChildren(
    h('option', { value: 'width' }, 'Fit width'), h('option', { value: 'page' }, 'Fit page'),
    ...PdfView.ZOOMS.map((z) => h('option', { value: String(z) }, `${Math.round(z * 100)}%`)),
    h('option', { value: 'custom', hidden: true }, ''));
  viewer = new PdfView.Viewer($('#pdfBody'), {
    onInverse: inverseSearch,
    onPage: (n, total) => { if (document.activeElement !== $('#pdfPage')) $('#pdfPage').value = n; $('#pdfPages').textContent = `/ ${total}`; },
    onZoom: (scale, mode) => {
      if (mode !== 'fixed') zoomSel.value = mode;
      else if (PdfView.ZOOMS.includes(scale)) zoomSel.value = String(scale);
      else { zoomSel.lastElementChild.textContent = `${Math.round(scale * 100)}%`; zoomSel.value = 'custom'; }
      prefs.pdfZoom = mode === 'fixed' ? scale : mode; savePrefs();
    },
  });
  const z = prefs.pdfZoom;
  if (typeof z === 'number') { viewer.mode = 'fixed'; viewer.scale = z; } else viewer.mode = z || 'width';
  return viewer;
}
async function showPdf(rel, v) {
  state.pdf = rel;
  $('#pdfEmpty').hidden = true;
  $('#pdfBody').hidden = false;
  try {
    await pdfViewer().open(pdfUrlFor(rel, v));
  } catch (e) {
    // PDF.js reports an expired token as "Unexpected server response (401)".
    if (/401/.test(String(e.message)) && (await renewToken())) {
      try { await pdfViewer().open(pdfUrlFor(rel, v)); return; } catch (e2) { e = e2; }
    }
    localLog('error', 'pdf', `PDF.js could not open ${rel}: ${e.message}`);
  }
}
function showNoPdf() {
  state.pdf = null;
  viewer?.clear();
  $('#pdfBody').hidden = true;
  $('#pdfEmpty').hidden = false;
  $('#pdfInfo').textContent = '';
}
async function loadExistingPdf() {
  if (!prefs.mainFile) return showNoPdf();
  const rel = `.byotex-build/${prefs.mainFile.split('/').pop().replace(/\.(tex|ltx)$/i, '')}.pdf`;
  let res = await fetch(pdfUrlFor(rel), { method: 'HEAD' }).catch(() => null);
  if (res && res.status === 401 && (await renewToken())) res = await fetch(pdfUrlFor(rel), { method: 'HEAD' }).catch(() => null);
  if (res && res.ok) { await showPdf(rel); $('#pdfInfo').textContent = rel.split('/').pop(); } else showNoPdf();
}
async function forwardSearch() {
  const f = state.file;
  if (!f || f.kind !== 'tex') return msgBox('Show in PDF', 'Open a .tex file and place the cursor on a line first.');
  if (!prefs.mainFile) return msgBox('Show in PDF', 'No main file to search in.');
  const line = code().value.slice(0, code().selectionStart).split('\n').length;
  if (prefs.pdfSide === 'none') setPref('pdfSide', 'right');
  if (!state.pdf) await loadExistingPdf();
  if (!state.pdf) return msgBox('Show in PDF', 'Compile the document first (Ctrl+Shift+B).');
  try {
    const r = await api('GET', `/api/synctex/view?main=${encodeURIComponent(prefs.mainFile)}&file=${encodeURIComponent(f.path)}&line=${line}`);
    if (!r.boxes.length) return status(`No PDF location for ${f.path}:${line} (is it part of ${prefs.mainFile}?)`);
    viewer.showBox(r.boxes[0]);
    status(`${f.path}:${line} → PDF page ${r.boxes[0].page}`);
  } catch (e) { msgBox('Show in PDF', e.message, { warn: true }); }
}
async function inverseSearch(page, x, y) {
  if (!prefs.mainFile) return;
  try {
    const r = await api('GET', `/api/synctex/edit?main=${encodeURIComponent(prefs.mainFile)}&page=${page}&x=${x.toFixed(2)}&y=${y.toFixed(2)}`);
    if (!r.hit || !r.hit.path) return status(r.hit?.outside ? `Source is outside the workspace: ${r.hit.outside}` : 'No source location at that spot');
    await openFile(r.hit.path, r.hit.line, r.hit.line);
    status(`PDF page ${page} → ${r.hit.path}:${r.hit.line}`);
  } catch (e) { msgBox('Jump to source', e.message, { warn: true }); }
}

let compiling = false;
async function compile() {
  if (compiling) return;
  if (!prefs.mainFile) return msgBox('Compile', 'No main .tex file (one containing \\documentclass) was found in this workspace.', { warn: true });
  if (state.file?.dirty) await saveFile({ skipAutoCompile: true });
  compiling = true;
  $('#compileBtn').disabled = true;
  status(`Compiling ${prefs.mainFile} with ${prefs.engine}…`);
  $('#pdfInfo').textContent = 'compiling…';
  try {
    const r = await api('POST', '/api/compile', { file: prefs.mainFile, engine: prefs.engine });
    state.compileDiags = [...r.errors, ...r.warnings].map((d) => ({ ...d, src: 'latex' }));
    const newMissing = (r.missing || []).filter((f) => !askedMissing.has(f));
    newMissing.forEach((f) => askedMissing.add(f));
    if (r.errors.length) state.expanded.add('diag');
    renderTree();
    if (r.pdf) {
      if (prefs.pdfSide === 'none') setPref('pdfSide', 'right');
      await showPdf(r.pdf, r.pdfMtime);
    }
    $('#pdfInfo').textContent = `${r.pdf ? r.pdf.split('/').pop() : 'no PDF'} — ${r.ok ? 'OK' : `${r.errors.length} error(s)`}, ${r.warnings.length} warning(s), ${(r.ms / 1000).toFixed(1)}s`;
    status(r.ok ? `Compiled in ${(r.ms / 1000).toFixed(1)}s` : `Compile finished with ${r.errors.length} error(s) — see Problems`);
    if (newMissing.length) missingPackagesDialog(newMissing); // once per file per session
  } catch (e) {
    $('#pdfInfo').textContent = 'compile failed';
    if (e.code === 'NO_TEX') { $('#pdfInfo').textContent = 'LaTeX not found'; return texSetupDialog('LaTeX (latexmk) was not found on this computer, so the document cannot be compiled yet.'); }
    if (e.status === 404 && /not found/i.test(e.message) && (await checkServerVersion())) return;
    msgBox('Compile failed', e.message, { warn: true });
  } finally {
    compiling = false;
    $('#compileBtn').disabled = false;
  }
}

/* ---------------------------------------------------------------- commands */
const commands = {
  'open-workspace': openWorkspace,
  rescan,
  save: saveFile,
  revert: async () => { if (state.file && state.file.kind !== 'figure') { state.file.dirty = false; const p = state.file.path; state.file = null; await openFile(p); } },
  settings: openSettings,
  'ctx-file': () => (state.file ? addTarget({ kind: 'file', path: state.file.path }) : msgBox('Context', 'No file is open.')),
  'ctx-node': () => {
    const n = state.selected;
    if (!n || !['file', 'section', 'env'].includes(n.kind)) return msgBox('Context', 'Select a file, section or environment in the Project tree first.');
    toggleTarget(n);
  },
  'ctx-sel': addEditorSelection,
  'ctx-clear': () => { state.targets = []; renderTargets(); renderTree(); },
  'chat-clear': () => { if (state.streaming) return; state.messages = []; proposalEls.clear(); chatHint(); status('New conversation'); },
  diagnostics: printDiagnostics,
  'toggle-left': () => setPref('leftHidden', !prefs.leftHidden),
  'tree-view': (arg) => { setPref('treeView', arg); renderTree(); },
  'toggle-log': () => setPref('logCollapsed', !prefs.logCollapsed),
  layout: (arg) => { prefs.chatSize = null; setPref('chatLayout', arg); },
  'pdf-side': (arg) => { setPref('pdfSide', arg); if (arg !== 'none' && !state.pdf) loadExistingPdf(); },
  'pdf-toggle': () => commands['pdf-side'](prefs.pdfSide === 'none' ? 'right' : 'none'),
  'pdf-swap': () => setPref('pdfSide', prefs.pdfSide === 'left' ? 'right' : 'left'),
  'font-dialog': fontDialog,
  'font-step': (arg) => setPref('edFont', Math.max(8, Math.min(32, prefs.edFont + Number(arg)))),
  compile,
  'pdf-prev': () => viewer?.goto(viewer.current - 1),
  'pdf-next': () => viewer?.goto(viewer.current + 1),
  'pdf-zoom': (arg) => viewer?.zoomStep(Number(arg)),
  'sync-forward': forwardSearch,
  'toggle-autocompile': () => setPref('autoCompile', !prefs.autoCompile),
  engine: (arg) => setPref('engine', arg),
  'tex-setup': () => texSetupDialog(),
  history: historyDialog,
  cite: () => citeDialog(),
  'test-provider': testProvider,
  'log-clear': () => { logLines.length = 0; $('#console').replaceChildren(); },
  about: () => msgBox('About BYOTeX.AI', 'BYOTeX.AI LaTeX Workspace 0.1\n\nLocal manuscript manager with an LLM gateway and a reviewable diff/apply patch engine.\nBackend: Node.js + Express, bound to 127.0.0.1.'),
};
function runCmd(name, arg) { const fn = commands[name]; if (fn) Promise.resolve(fn(arg)).catch((e) => msgBox('Error', e.message, { warn: true })); }

function showTab(name) {
  if (prefs.chatLayout !== 'tabs') { if (name === 'chat') $('#prompt').focus(); return; }
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $('#panel-editor').hidden = name !== 'editor';
  $('#panel-chat').hidden = name !== 'chat';
  if (name === 'chat') $('#prompt').focus();
}

/* ------------------------------------------------------------------- wiring */
function wire() {
  document.addEventListener('click', (e) => {
    const cmdEl = e.target.closest('[data-cmd]');
    const menu = e.target.closest('.menu');
    $$('.menu.open').forEach((m) => { if (m !== menu || cmdEl) m.classList.remove('open'); });
    if (menu && !cmdEl) menu.classList.toggle('open');
    if (cmdEl) runCmd(cmdEl.dataset.cmd, cmdEl.dataset.arg);
  });
  $$('.menu').forEach((m) => m.addEventListener('mouseenter', () => { if ($('.menu.open') && !m.classList.contains('open')) { $$('.menu.open').forEach((x) => x.classList.remove('open')); m.classList.add('open'); } }));
  $$('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

  const ta = code();
  ta.addEventListener('input', () => { setDirty(true); updateGutter(); });
  ta.addEventListener('scroll', () => { $('#gutter').scrollTop = ta.scrollTop; });
  ta.addEventListener('keyup', updatePos);
  ta.addEventListener('click', updatePos);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') { e.preventDefault(); const s = ta.selectionStart; ta.setRangeText('  ', s, ta.selectionEnd, 'end'); setDirty(true); }
  });

  $('#sendBtn').addEventListener('click', sendPrompt);
  $('#stopBtn').addEventListener('click', () => state.streaming?.abort());
  $('#prompt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendPrompt(); } });
  $('#providerSelect').addEventListener('change', async (e) => {
    if (e.target.value === 'opencode' && !(await confirmOpenCode())) { renderProviderSelect(); return; }
    try { state.settings = await api('PUT', '/api/settings', { activeProvider: e.target.value }); renderProviderSelect(); }
    catch (err) { msgBox('Settings', err.message, { warn: true }); }
  });
  $('#logPayloads').addEventListener('change', rerenderLog);
  $('#ctxAuto').addEventListener('change', (e) => { setPref('autoContext', e.target.checked); renderTargets(); });
  $('#sbCtx').addEventListener('click', () => showTab('chat'));
  $('#logLevel').addEventListener('change', rerenderLog);

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveFile(); }
    if (e.key === 'F5') { e.preventDefault(); rescan(); }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'b') { e.preventDefault(); runCmd('toggle-left'); }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'b') { e.preventDefault(); runCmd('compile'); }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'j') { e.preventDefault(); runCmd('sync-forward'); }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'h') { e.preventDefault(); runCmd('history'); }
    if (mod && e.shiftKey && (e.key === '>' || e.key === '.')) { e.preventDefault(); runCmd('font-step', 1); }
    if (mod && e.shiftKey && (e.key === '<' || e.key === ',')) { e.preventDefault(); runCmd('font-step', -1); }
  });
  window.addEventListener('beforeunload', (e) => { if (state.file?.dirty) { e.preventDefault(); e.returnValue = ''; } });

  // Splitters
  const drag = (el, onMove) => el.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const move = (ev) => onMove(ev);
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); document.body.classList.remove('dragging'); savePrefs(); };
    document.body.classList.add('dragging');
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
  drag($('#vsplit'), (ev) => { const left = $('#left'); const x = ev.clientX - left.getBoundingClientRect().left; prefs.leftWidth = Math.max(180, Math.min(window.innerWidth - 360, x)); left.style.width = `${prefs.leftWidth}px`; });
  drag($('#chatSplit'), (ev) => {
    const work = $('#work').getBoundingClientRect();
    const chat = $('#panel-chat');
    if (prefs.chatLayout === 'bottom') { prefs.chatSize = Math.max(140, Math.min(work.height - 120, work.bottom - ev.clientY)); chat.style.height = `${prefs.chatSize}px`; }
    else { prefs.chatSize = Math.max(260, Math.min(work.width - 200, work.right - ev.clientX)); chat.style.width = `${prefs.chatSize}px`; }
  });
  drag($('#pdfSplit'), (ev) => {
    const r = $('#right').getBoundingClientRect();
    const w = prefs.pdfSide === 'left' ? ev.clientX - r.left : r.right - ev.clientX;
    prefs.pdfWidth = Math.max(220, Math.min(r.width - 300, w));
    $('#pdfPane').style.flexBasis = `${prefs.pdfWidth}px`;
  });
  $('#pdfZoom').addEventListener('change', (e) => {
    const v = e.target.value;
    if (!viewer || v === 'custom') return;
    if (v === 'width' || v === 'page') viewer.setZoom(v); else viewer.setZoom('fixed', Number(v));
  });
  $('#pdfPage').addEventListener('keydown', (e) => { if (e.key === 'Enter') { viewer?.goto(Number(e.target.value)); e.target.blur(); } });
  $('#pdfBody').addEventListener('wheel', (e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); viewer?.zoomStep(e.deltaY < 0 ? 1 : -1); } }, { passive: false });
  $('#mainSelect').addEventListener('change', (e) => { prefs.mainFile = e.target.value; savePrefs(); applyPrefs(); renderTree(); state.pdf = null; if (prefs.pdfSide !== 'none') loadExistingPdf(); });
  drag($('#hsplit'), (ev) => { const g = $('#treeGroup'); const top = g.getBoundingClientRect().top; const total = $('#left').getBoundingClientRect().height; g.style.height = `${Math.max(80, Math.min(total - 100, ev.clientY - top))}px`; });
}

(async function init() {
  wire();
  applyPrefs();
  renderTargets();
  chatHint();
  connectLogs();
  try {
    checkServerVersion();
    await loadSettings();
    await loadWorkspace();
    if (state.scan.mainFile) await openFile(state.scan.mainFile);
    if (prefs.pdfSide !== 'none') loadExistingPdf();
  } catch (e) {
    msgBox('Startup error', e.message, { warn: true });
  }
})();
