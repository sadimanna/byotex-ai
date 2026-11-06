'use strict';
// BYOTeX.AI local backend: API gateway, workspace manager, patch engine, and log stream.
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const logger = require('./logger');
const store = require('./store');
const ws = require('./workspace');
const llm = require('./llm');
const patch = require('./patch');
const prompt = require('./prompt');
const latex = require('./compile');
const texenv = require('./texenv');

const PORT = Number(process.env.PORT || 4198);
const HOST = '127.0.0.1';
const TOKEN = crypto.randomBytes(24).toString('hex');
const PUBLIC = path.join(__dirname, '..', 'public');
const SAMPLE = path.join(__dirname, '..', 'sample');

// Fingerprint of the backend code this process loaded. The UI compares it with the code on disk and
// warns when the files changed but the server was not restarted (stale routes → "Not found").
function codeFingerprint() {
  const h = crypto.createHash('sha1');
  for (const f of fs.readdirSync(__dirname).sort()) if (f.endsWith('.js')) h.update(f).update(fs.readFileSync(path.join(__dirname, f)));
  return h.digest('hex').slice(0, 12);
}
const CODE_VERSION = codeFingerprint();

let settings;
try {
  settings = store.load();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
if (!settings.workspaceRoot || !fs.existsSync(settings.workspaceRoot)) settings.workspaceRoot = SAMPLE;
texenv.setTexPath(settings.texPath);

let scanCache = null;
function rescan() {
  scanCache = ws.scan(settings.workspaceRoot);
  const d = scanCache.diagnostics;
  logger.info('scan', `Scanned ${scanCache.root}: ${scanCache.fileCount} files, ${Object.keys(scanCache.files).length} parsed, ${d.length} diagnostics (${scanCache.ms} ms)`);
  return scanCache;
}

const app = express();
app.disable('x-powered-by');

// Only answer on loopback host names (blocks DNS-rebinding) and lock down the page.
app.use((req, res, next) => {
  const host = String(req.headers.host || '').toLowerCase();
  if (![`127.0.0.1:${PORT}`, `localhost:${PORT}`].includes(host)) return res.status(403).send('Forbidden host');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; font-src 'self' data: blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'");
  next();
});

app.get('/', (req, res) => {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8').replace('__BYOTEX_TOKEN__', TOKEN);
  res.type('html').set('Cache-Control', 'no-store').send(html);
});
app.use(express.static(PUBLIC, { index: false }));
// PDF.js (renderer, worker, CMaps, standard fonts) served locally — no CDN, works offline.
const PDFJS = path.join(__dirname, '..', 'node_modules', 'pdfjs-dist');
for (const sub of ['build', 'cmaps', 'standard_fonts']) app.use(`/vendor/pdfjs/${sub}`, express.static(path.join(PDFJS, sub), { index: false }));

// Every API call needs the per-launch session token (header, or ?token= for EventSource/img).
const tokenBuf = Buffer.from(TOKEN);
app.use('/api', (req, res, next) => {
  const t = Buffer.from(String(req.get('x-byotex-token') || req.query.token || ''));
  if (t.length !== tokenBuf.length || !crypto.timingSafeEqual(t, tokenBuf)) return res.status(401).json({ error: 'Session expired: the server was restarted. Reload the page.', code: 'BAD_TOKEN' });
  next();
});
app.use('/api', express.json({ limit: '25mb' }));

const route = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) logger.error('api', `${req.method} ${req.path}: ${e.message}`);
    else logger.warn('api', `${req.method} ${req.path}: ${e.message}`);
    if (!res.headersSent) res.status(status).json({ error: e.message, code: e.code });
  }
};

app.get('/api/version', route((req, res) => res.json({ loaded: CODE_VERSION, onDisk: codeFingerprint() })));

// ---- Settings ------------------------------------------------------------
app.get('/api/settings', route((req, res) => res.json(store.publicView(settings))));
app.put('/api/settings', route((req, res) => {
  try {
    settings = store.applyPatch(settings, req.body || {});
  } catch (e) {
    throw ws.httpErr(400, e.message);
  }
  store.save(settings);
  texenv.setTexPath(settings.texPath);
  logger.info('settings', `Settings saved (encrypted) → ${store.STORE_FILE}; active provider: ${settings.activeProvider}`);
  res.json(store.publicView(settings));
}));

// List models for a provider. Uses the key / base URL typed in the Settings dialog if given
// (so you can browse before saving), otherwise the stored ones. POST keeps the key out of URLs.
app.post('/api/models', route(async (req, res) => {
  const provider = String(req.body?.provider || '');
  if (!settings.providers[provider]) throw ws.httpErr(400, `Unknown provider ${provider}`);
  const cfg = { ...settings.providers[provider] };
  if (typeof req.body.apiKey === 'string' && req.body.apiKey.trim()) cfg.apiKey = req.body.apiKey.trim();
  if (typeof req.body.baseUrl === 'string' && req.body.baseUrl.trim()) {
    try { const u = new URL(req.body.baseUrl.trim()); if (!/^https?:$/.test(u.protocol)) throw new Error(); } catch { throw ws.httpErr(400, 'Invalid base URL'); }
    cfg.baseUrl = req.body.baseUrl.trim();
  }
  if (!['local', 'opencode'].includes(provider) && !cfg.apiKey) throw ws.httpErr(400, `Enter an API key for ${provider} first`);
  const models = await llm.listModels(provider, cfg);
  logger.info('models', `${provider}: ${models.length} model(s) available`);
  res.json({ models });
}));

// ---- Workspace -------------------------------------------------------------
app.get('/api/workspace', route((req, res) => res.json(scanCache || rescan())));
app.post('/api/workspace/rescan', route((req, res) => res.json(rescan())));
app.post('/api/workspace', route((req, res) => {
  let root = String(req.body?.root || '').trim();
  if (root.startsWith('~')) root = path.join(require('os').homedir(), root.slice(1));
  root = path.resolve(root);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw ws.httpErr(400, `Not a directory: ${root}`);
  settings.workspaceRoot = root;
  store.save(settings);
  logger.info('workspace', `Workspace root set to ${root}`);
  res.json(rescan());
}));

app.get('/api/file', route((req, res) => {
  const f = ws.readText(settings.workspaceRoot, String(req.query.path || ''));
  res.json({ path: f.path, content: f.content, hash: f.hash, kind: f.kind, size: f.size, mtime: f.mtime });
}));

app.put('/api/file', route((req, res) => {
  const { path: rel, content, baseHash } = req.body || {};
  if (typeof content !== 'string') throw ws.httpErr(400, 'content must be a string');
  const w = ws.writeText(settings.workspaceRoot, rel, content, { backups: settings.backups, expectHash: baseHash === undefined ? undefined : baseHash });
  logger.info('write', `Saved ${rel} from editor (${w.bytes} B)${w.backup ? ` backup → ${w.backup}` : ''}`);
  rescan();
  res.json(w);
}));

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.pdf': 'application/pdf' };
app.get('/api/raw', route((req, res) => {
  const rel = String(req.query.path || '');
  const ext = path.extname(rel).toLowerCase();
  if (!MIME[ext]) throw ws.httpErr(415, 'Preview not supported for this file type');
  const abs = ws.safeResolve(settings.workspaceRoot, rel);
  if (!fs.existsSync(abs)) throw ws.httpErr(404, 'Not found');
    const csp = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
  res.set({ 'Content-Security-Policy': csp, 'Cache-Control': 'no-store' }).type(MIME[ext]).send(fs.readFileSync(abs));
}));

// ---- LaTeX compile -------------------------------------------------------------
app.get('/api/compile/status', route((req, res) => res.json({ latexmk: latex.findLatexmk() })));
const opencode = require('./opencode');
app.get('/api/opencode/status', route(async (req, res) => res.json(await opencode.status())));
app.post('/api/opencode/install', route((req, res) => res.json(opencode.install())));
app.post('/api/tex/package/find', route(async (req, res) => {
  const r = await texenv.findPackage(String(req.body?.file || ''));
  res.json({ ...r, commands: Object.fromEntries((r.packages || []).map((p) => [p, r.command ? r.command(p) : ''])), command: undefined });
}));
app.post('/api/tex/package/install', route((req, res) => res.json(texenv.installPackage(String(req.body?.pkg || ''), req.body?.repo || null))));
app.get('/api/tex/package/status', route((req, res) => res.json(texenv.pkgStatus())));
app.get('/api/tex/status', route(async (req, res) => res.json(await texenv.status())));
app.post('/api/tex/install', route((req, res) => {
  const st = texenv.installTinyTeX((binDir) => {
    if (!binDir) return;
    settings.texPath = binDir; // remember where it went
    store.save(settings);
    logger.info('settings', `TeX bin folder set to ${binDir}`);
  });
  res.json(st);
}));
app.post('/api/compile', route(async (req, res) => {
  const scan = scanCache || rescan();
  const file = String(req.body?.file || scan.mainFile || '');
  if (!file) throw ws.httpErr(400, 'No main .tex file (one with \\documentclass) found');
  res.json(await latex.compile(settings.workspaceRoot, file, req.body?.engine || 'pdflatex'));
}));
app.get('/api/synctex/view', route(async (req, res) => {
  const { main, file, line } = req.query;
  const boxes = await latex.forwardSearch(settings.workspaceRoot, String(main), String(file), Number(line) || 1);
  logger.info('synctex', `${file}:${line} → ${boxes.length ? `page ${boxes[0].page}` : 'no match'}`);
  res.json({ boxes });
}));
app.get('/api/synctex/edit', route(async (req, res) => {
  const { main, page, x, y } = req.query;
  const hit = await latex.inverseSearch(settings.workspaceRoot, String(main), Number(page), Number(x), Number(y));
  logger.info('synctex', `page ${page} (${Number(x).toFixed(0)},${Number(y).toFixed(0)}) → ${hit?.path ? `${hit.path}:${hit.line}` : 'no match'}`);
  res.json({ hit });
}));

// ---- Chat / prompt runner --------------------------------------------------
app.post('/api/chat', route(async (req, res) => {
  const { messages = [], targets = [], mode = 'edit' } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) throw ws.httpErr(400, 'messages required');
  for (const m of messages) {
    if (!['user', 'assistant'].includes(m.role) || typeof m.content !== 'string') throw ws.httpErr(400, 'Malformed message');
  }
  if (messages[messages.length - 1].role !== 'user') throw ws.httpErr(400, 'Last message must be from the user');
  const provider = settings.activeProvider;
  const cfg = settings.providers[provider];
  if (!['local', 'opencode'].includes(provider) && !cfg.apiKey) throw ws.httpErr(400, `No API key configured for ${provider}. Open Settings to add one.`);

  const scan = scanCache || rescan();
  const ctx = prompt.buildContext(settings.workspaceRoot, scan, Array.isArray(targets) ? targets : [], settings.maxContextChars);
  const system = prompt.systemPrompt(mode);
  const last = messages[messages.length - 1];
  const finalMessages = [...messages.slice(0, -1), { role: 'user', content: `${ctx.text}\n\n## REQUEST\n${last.content}` }];
  const inputEstimate = llm.estimateTokens(system + finalMessages.map((m) => m.content).join('\n'));

  res.status(200).set({ 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const send = (o) => { if (!res.writableEnded) res.write(JSON.stringify(o) + '\n'); };
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });

  logger.info('chat', `Prompt [${mode}] → ${provider}/${cfg.model}; context: ${ctx.included.map((c) => `${c.path}${c.start > 1 || c.end ? `:${c.start}-${c.end}` : ''}`).join(', ') || 'outline only'}${ctx.truncated ? ' (TRUNCATED)' : ''}; ~${inputEstimate} input tokens`);
  send({ type: 'meta', provider, model: cfg.model, mode, included: ctx.included, truncated: ctx.truncated, inputEstimate });

  const t0 = Date.now();
  let full = '';
  const usage = { input: null, output: null };
  let stopReason = null;
  try {
    for await (const ev of llm.stream(provider, { cfg, system, messages: finalMessages, maxTokens: settings.maxTokens, temperature: settings.temperature, signal: ac.signal, timeoutSec: settings.responseTimeout })) {
      if (ev.type === 'text') { full += ev.text; send({ type: 'delta', text: ev.text }); }
      else if (ev.type === 'usage') { if (ev.input != null) usage.input = ev.input; if (ev.output != null) usage.output = ev.output; }
      else if (ev.type === 'stop') stopReason = ev.reason;
    }
  } catch (e) {
    if (ac.signal.aborted) { logger.warn('chat', `Request aborted by client after ${Date.now() - t0} ms`); return res.end(); }
    logger.error('chat', e.message);
    send({ type: 'error', message: e.message });
    send({ type: 'done' });
    return res.end();
  }
  const estimated = usage.input == null || usage.output == null;
  if (usage.input == null) usage.input = inputEstimate;
  if (usage.output == null) usage.output = llm.estimateTokens(full);
  logger.info('tokens', `in=${usage.input} out=${usage.output}${estimated ? ' (estimated)' : ''} stop=${stopReason || '?'} ${Date.now() - t0} ms [${provider}/${cfg.model}]`);
  if (stopReason === 'max_tokens' || stopReason === 'length') logger.warn('chat', 'Response hit the max output token limit — edit blocks may be incomplete');
  send({ type: 'usage', ...usage, estimated, stopReason, ms: Date.now() - t0 });

  if (mode === 'edit') {
    const blocks = patch.parseEditBlocks(full);
    if (blocks.length) {
      const p = patch.createProposal(settings.workspaceRoot, blocks, { provider, model: cfg.model });
      const pub = patch.publicProposal(p);
      const errs = pub.files.reduce((a, f) => a + f.errors.length + (f.fatal ? 1 : 0), 0);
      logger.info('patch', `Proposal ${p.id}: ${blocks.length} edit block(s) across ${pub.files.length} file(s), ${pub.files.reduce((a, f) => a + f.hunks.length, 0)} hunk(s), ${errs} error(s)`);
      for (const f of pub.files) for (const er of f.errors) logger.warn('patch', `${f.path} block #${er.block}: ${er.error}`);
      send({ type: 'proposal', proposal: pub });
      if (settings.autoApply) {
        const results = patch.applyProposal(settings.workspaceRoot, p.id, null, { backups: settings.backups });
        rescan();
        send({ type: 'applied', id: p.id, results });
      }
    }
  }
  send({ type: 'done' });
  res.end();
}));

app.get('/api/proposals/:id', route((req, res) => res.json(patch.publicProposal(patch.getProposal(req.params.id)))));
app.post('/api/proposals/:id/apply', route((req, res) => {
  const selection = req.body?.selection ?? null;
  logger.info('patch', `Applying proposal ${req.params.id}${selection ? ` (selected: ${Object.entries(selection).map(([p, h]) => `${p}[${h.join(',')}]`).join(' ')})` : ' (all hunks)'}`);
  const results = patch.applyProposal(settings.workspaceRoot, req.params.id, selection, { backups: settings.backups });
  rescan();
  res.json({ results, proposal: patch.publicProposal(patch.getProposal(req.params.id)) });
}));
app.post('/api/proposals/:id/reject', route((req, res) => {
  patch.rejectProposal(req.params.id);
  res.json({ ok: true });
}));

// ---- Log stream (SSE) --------------------------------------------------------
app.get('/api/logs', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  res.flushHeaders();
  const write = (e) => res.write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`);
  const since = Number(req.get('last-event-id') || 0);
  for (const e of logger.history) if (e.id > since) write(e);
  logger.bus.on('log', write);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); logger.bus.off('log', write); });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

const server = app.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}/`;
  logger.info('server', `BYOTeX.AI workspace listening on ${url}`);
  logger.info('server', `Settings store: ${store.STORE_FILE}`);
  try { rescan(); } catch (e) { logger.error('scan', e.message); }
  if (process.argv.includes('--open')) execFile(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open', [url], () => {});
});
server.on('error', (e) => { console.error(e.message); process.exit(1); });

module.exports = { app, server };
