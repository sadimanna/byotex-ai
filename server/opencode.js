'use strict';
// OpenCode provider: free models through a locally installed OpenCode (MIT-licensed, https://opencode.ai).
//
// BYOTeX.AI starts its own private `opencode serve` (loopback only, random port, random basic-auth password,
// --pure = no third-party plugins, run from an empty sandbox folder) and talks to it over OpenCode's
// documented HTTP API. Every OpenCode tool (file edit, shell, web fetch, …) is switched off for each
// request: the model only *proposes* edits as text, and BYOTeX.AI's diff review stays the only way to
// change files.
//
// Free models are rate-limited by OpenCode. When the limit is hit OpenCode retries silently, so we
// watch session status and fail fast with a clear message instead of hanging.
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const logger = require('./logger');

const IS_WIN = process.platform === 'win32';
const HOME = os.homedir();
const { DATA_DIR } = require('./store'); // same folder as the encrypted settings
const SANDBOX = path.join(DATA_DIR, 'opencode-sandbox'); // empty cwd: OpenCode sees no project files
const LOCAL_INSTALL = path.join(DATA_DIR, 'opencode'); // where "Install OpenCode" puts it (npm --prefix)

let userBin = '';
function setBinary(p) { userBin = p || ''; }

function candidates() {
  const exe = IS_WIN ? 'opencode.exe' : 'opencode';
  const list = [userBin];
  for (const d of (process.env.PATH || '').split(path.delimiter)) if (d) list.push(path.join(d, exe), ...(IS_WIN ? [path.join(d, 'opencode.cmd')] : []));
  list.push(
    path.join(HOME, '.opencode', 'bin', exe), // official install script
    path.join(LOCAL_INSTALL, 'node_modules', '.bin', IS_WIN ? 'opencode.cmd' : 'opencode'), // our npm --prefix install
    '/opt/homebrew/bin/opencode', '/usr/local/bin/opencode',
  );
  if (IS_WIN) list.push(path.join(process.env.APPDATA || '', 'npm', 'opencode.cmd'));
  return list.filter(Boolean);
}

function findBinary() {
  for (const p of candidates()) {
    try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return null;
}

const viaShell = (bin) => IS_WIN && /\.(cmd|bat)$/i.test(bin);
function spawnBin(bin, args, opts) {
  return viaShell(bin) ? spawn('cmd.exe', ['/c', bin, ...args], opts) : spawn(bin, args, opts);
}

function version(bin) {
  return new Promise((resolve) => {
    const child = spawnBin(bin, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const t = setTimeout(() => child.kill(), 10000);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(t); resolve(null); });
    child.on('close', () => { clearTimeout(t); resolve(out.trim().split('\n')[0] || null); });
  });
}

// ---- private server -------------------------------------------------------------------------
let server = null; // { proc, base, auth, bin }
let starting = null;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

async function ensureServer() {
  if (server && server.proc.exitCode === null) return server;
  if (starting) return starting;
  starting = (async () => {
    const bin = findBinary();
    if (!bin) throw Object.assign(new Error('OpenCode is not installed. Use Settings → OpenCode → Install OpenCode, or install it from https://opencode.ai.'), { status: 501, code: 'NO_OPENCODE' });
    fs.mkdirSync(SANDBOX, { recursive: true });
    const port = await freePort();
    const password = crypto.randomBytes(18).toString('hex');
    const env = { ...process.env, OPENCODE_SERVER_PASSWORD: password, OPENCODE_SERVER_USERNAME: 'byotex' };
    logger.info('opencode', `Starting private OpenCode server (${bin}) on 127.0.0.1:${port}`);
    const proc = spawnBin(bin, ['serve', '--hostname', '127.0.0.1', '--port', String(port), '--pure'], { cwd: SANDBOX, env, stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stderr.on('data', (d) => { const l = String(d).trim(); if (l && !/OPENCODE_SERVER_PASSWORD/.test(l)) logger.debug('opencode', l.slice(0, 300)); });
    proc.stdout.on('data', () => {});
    proc.on('exit', (code) => { logger.info('opencode', `OpenCode server exited (${code})`); if (server?.proc === proc) server = null; });
    const s = { proc, bin, base: `http://127.0.0.1:${port}`, auth: `Basic ${Buffer.from(`byotex:${password}`).toString('base64')}` };
    const t0 = Date.now();
    for (;;) {
      if (proc.exitCode !== null) throw new Error(`OpenCode server failed to start (exit ${proc.exitCode})`);
      try { const r = await fetch(`${s.base}/doc`, { headers: { authorization: s.auth } }); if (r.ok) break; } catch { /* not up yet */ }
      if (Date.now() - t0 > 30000) { proc.kill(); throw new Error('OpenCode server did not start within 30 s'); }
      await new Promise((r) => setTimeout(r, 300));
    }
    // Every tool OpenCode knows about is turned off per request (see disabledTools()).
    s.toolIds = await api(s, 'GET', '/experimental/tool/ids').catch(() => []);
    server = s;
    logger.info('opencode', `OpenCode server ready in ${Date.now() - t0} ms; ${s.toolIds.length} tools will be disabled per request`);
    return s;
  })();
  try { return await starting; } finally { starting = null; }
}

function stopServer() { if (server) { try { server.proc.kill(); } catch { /* gone */ } server = null; } }
process.on('exit', stopServer);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopServer(); process.exit(0); });

async function api(s, method, p, body, signal) {
  const res = await fetch(s.base + p, {
    method,
    signal,
    headers: { authorization: s.auth, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`OpenCode ${method} ${p} → HTTP ${res.status}: ${text.slice(0, 300)}`), { status: 502 });
  return text ? JSON.parse(text) : null;
}

function disabledTools(s) {
  const base = ['bash', 'read', 'glob', 'grep', 'edit', 'write', 'patch', 'apply_patch', 'task', 'webfetch', 'websearch', 'todowrite', 'todoread', 'skill', 'question', 'list'];
  return Object.fromEntries([...new Set([...base, ...(s.toolIds || [])])].map((t) => [t, false]).concat([['*', false]]));
}

/** Free models only: cost 0 for input and output. Returns [{id, name}]. */
async function listModels() {
  const s = await ensureServer();
  const d = await api(s, 'GET', '/config/providers');
  const oc = (d.providers || []).find((p) => p.id === 'opencode');
  const models = Object.entries(oc?.models || {})
    .filter(([, m]) => (m.cost?.input ?? 1) === 0 && (m.cost?.output ?? 1) === 0)
    .map(([id, m]) => ({ id, name: m.name || '' }));
  models.sort((a, b) => a.id.localeCompare(b.id));
  return models;
}

/** One prompt string: OpenCode sessions are created fresh per request, so earlier turns go in as a transcript. */
function flatten(messages) {
  if (messages.length === 1) return messages[0].content;
  const turns = messages.slice(0, -1).map((m) => `### ${m.role === 'user' ? 'USER' : 'ASSISTANT'}\n${m.content}`);
  return `## EARLIER CONVERSATION\n${turns.join('\n\n')}\n\n## CURRENT MESSAGE\n${messages[messages.length - 1].content}`;
}

/** Stream a reply. Yields {type:'text'|'usage'|'stop'} like the other providers. */
async function* stream({ cfg, system, messages, signal, kick = () => {} }) {
  const s = await ensureServer();
  const ses = await api(s, 'POST', '/session', { title: 'BYOTeX.AI request' }, signal);
  const sid = ses.id;
  logger.info('http', `→ OpenCode session ${sid} model=opencode/${cfg.model} (tools disabled)`);

  // Event stream → queue consumed by this generator.
  const evCtrl = new AbortController();
  const queue = [];
  let wake = null;
  const push = (x) => { queue.push(x); if (wake) { wake(); wake = null; } };
  const textParts = new Set();
  let streamed = '';
  (async () => {
    try {
      const res = await fetch(`${s.base}/event`, { headers: { authorization: s.auth }, signal: evCtrl.signal });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (!line.startsWith('data:')) continue;
          let ev;
          try { ev = JSON.parse(line.slice(5)); } catch { continue; }
          const p = ev.properties || {};
          const evSid = p.sessionID || p.part?.sessionID || p.info?.sessionID;
          if (evSid !== sid) continue;
          kick();
          if (ev.type === 'message.part.updated' && p.part?.type === 'text') textParts.add(p.part.id);
          else if (ev.type === 'message.part.delta' && p.field === 'text' && textParts.has(p.partID) && p.delta) push({ t: 'delta', text: p.delta });
          else if (ev.type === 'session.status' && p.status?.type === 'retry') push({ t: 'retry', status: p.status });
          else if (ev.type === 'session.error') push({ t: 'error', error: p.error });
          else if (ev.type === 'session.idle') push({ t: 'idle' });
        }
      }
    } catch (e) {
      if (!evCtrl.signal.aborted) push({ t: 'error', error: { data: { message: `event stream: ${e.message}` } } });
    }
  })();

  const abortSession = () => api(s, 'POST', `/session/${sid}/abort`).catch(() => {});
  const onAbort = () => { abortSession(); push({ t: 'aborted' }); };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    await new Promise((r) => setTimeout(r, 150)); // let the event subscription attach
    const body = {
      model: { providerID: 'opencode', modelID: cfg.model },
      system,
      tools: disabledTools(s),
      parts: [{ type: 'text', text: flatten(messages) }],
    };
    await api(s, 'POST', `/session/${sid}/prompt_async`, body, signal);
    for (;;) {
      while (!queue.length) await new Promise((r) => { wake = r; });
      const x = queue.shift();
      if (x.t === 'delta') { streamed += x.text; yield { type: 'text', text: x.text }; }
      else if (x.t === 'retry') {
        await abortSession();
        const st = x.status;
        if (st.action?.reason === 'free_tier_limit') {
          const when = st.next ? new Date(st.next).toLocaleString() : 'later';
          throw Object.assign(new Error(`OpenCode free usage limit reached ("${st.message}"). It resets around ${when}. Try again then, or use another provider. (${st.action.link || 'https://opencode.ai'})`), { status: 429 });
        }
        throw Object.assign(new Error(`OpenCode is retrying: ${st.message || 'provider error'}`), { status: 502 });
      } else if (x.t === 'error') {
        const msg = x.error?.data?.message || x.error?.message || x.error?.name || JSON.stringify(x.error);
        throw Object.assign(new Error(`OpenCode error: ${msg}`), { status: 502 });
      } else if (x.t === 'aborted') {
        const e = new Error('aborted');
        e.name = 'AbortError';
        throw e;
      } else if (x.t === 'idle') break;
    }
    // Final message: tokens, plus any text the event stream didn't deliver.
    const msgs = await api(s, 'GET', `/session/${sid}/message`).catch(() => []);
    const last = [...(msgs || [])].reverse().find((m) => m.info?.role === 'assistant');
    if (last) {
      const final = (last.parts || []).filter((p) => p.type === 'text').map((p) => p.text).join('');
      if (final.length > streamed.length && final.startsWith(streamed)) yield { type: 'text', text: final.slice(streamed.length) };
      else if (!streamed && final) yield { type: 'text', text: final };
      if (last.info.error) throw Object.assign(new Error(`OpenCode error: ${last.info.error.data?.message || last.info.error.name}`), { status: 502 });
      const tk = last.info.tokens || {};
      yield { type: 'usage', input: (tk.input || 0) + (tk.cache?.read || 0), output: (tk.output || 0) + (tk.reasoning || 0) };
      if (last.info.finish) yield { type: 'stop', reason: last.info.finish };
    }
    logger.info('http', `← OpenCode session ${sid} done`);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    evCtrl.abort();
    api(s, 'DELETE', `/session/${sid}`).catch(() => {});
  }
}

// ---- install ----------------------------------------------------------------------------------
let installState = { running: false, done: false, ok: null, message: '' };

/** Installs the official npm package (opencode-ai) into BYOTeX.AI's data folder: no admin rights, any OS. */
function install() {
  if (installState.running) throw Object.assign(new Error('OpenCode installation already running'), { status: 409 });
  const npm = IS_WIN ? 'npm.cmd' : 'npm';
  const args = ['install', '--prefix', LOCAL_INSTALL, '--no-audit', '--no-fund', 'opencode-ai@latest'];
  fs.mkdirSync(LOCAL_INSTALL, { recursive: true });
  installState = { running: true, done: false, ok: null, message: 'Installing OpenCode…' };
  logger.info('install', `$ ${npm} ${args.join(' ')}`);
  const child = IS_WIN ? spawn('cmd.exe', ['/c', npm, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }) : spawn(npm, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const pipe = (st) => st.on('data', (d) => String(d).split(/\r?\n/).forEach((l) => l.trim() && logger.info('install', l.trim())));
  pipe(child.stdout);
  pipe(child.stderr);
  const finish = async (code, err) => {
    const bin = findBinary();
    const ver = bin ? await version(bin) : null;
    const ok = code === 0 && !!bin;
    installState = { running: false, done: true, ok, message: ok ? `OpenCode ${ver || ''} installed (${bin}).` : `Installation failed (${err || `exit ${code}`}). See the Log Console.` };
    (ok ? logger.info : logger.error)('install', installState.message);
  };
  child.on('error', (e) => finish(-1, e.message));
  child.on('close', (code) => finish(code));
  return installState;
}

async function status() {
  const bin = findBinary();
  return { bin, version: bin ? await version(bin) : null, running: !!server, install: installState, installDir: LOCAL_INSTALL };
}

module.exports = { setBinary, findBinary, listModels, stream, status, install, stopServer };
