'use strict';
// Module 2 (gateway half): provider adapters that stream text + token usage.
// Anthropic Messages API, and OpenAI-compatible Chat Completions (OpenAI, Google Gemini, OpenRouter, local servers
// such as Ollama / LM Studio / llama.cpp / vLLM).
const logger = require('./logger');

const DEFAULT_BASE = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  openrouter: 'https://openrouter.ai/api/v1',
  local: 'http://localhost:11434/v1',
};

const joinUrl = (base, p) => base.replace(/\/+$/, '') + p;

/** fetch() that turns low-level network failures into a readable message. */
async function netFetch(url, opts) {
  try {
    return await fetch(url, opts);
  } catch (e) {
    if (e.name === 'AbortError' && opts.signal?.aborted && opts.signal.reason?.name !== 'TimeoutError') throw e;
    const code = e.cause?.code || '';
    const origin = new URL(url).origin;
    if (code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') {
      throw Object.assign(new Error(`Connected to ${origin}, but it sent no response within Node's 300 s limit (${code}). The model is probably overloaded or slow to start; try again or choose a faster model.`), { status: 504 });
    }
    const cause = code || e.cause?.message || e.message;
    throw Object.assign(new Error(`Could not connect to ${origin} (${cause}). Check the Base URL and your network.`), { status: 502 });
  }
}

function redactHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    out[k] = /key|authorization/i.test(k) ? (v ? `${String(v).slice(0, 10)}…[redacted]` : '') : v;
  }
  return out;
}

async function* lines(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      yield buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
    }
  }
  buf += dec.decode();
  if (buf) yield buf;
}

async function* sseData(res, kick = () => {}) {
  for await (const line of lines(res)) {
    kick(); // any bytes (including keep-alive comments) count as progress
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data) yield data;
  }
}

async function post(provider, url, headers, body, signal) {
  logger.info('http', `→ POST ${url} [${provider}] model=${body.model}`, { headers: redactHeaders(headers), body });
  const res = await netFetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  logger.info('http', `← ${res.status} ${res.statusText || ''} [${provider}]`);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const e = new Error(`HTTP ${res.status} from ${provider}: ${text.slice(0, 800)}`);
    e.status = 502;
    throw e;
  }
  return res;
}

async function* anthropic({ cfg, system, messages, maxTokens, temperature, signal, kick }) {
  const url = joinUrl(cfg.baseUrl || DEFAULT_BASE.anthropic, '/v1/messages');
  const body = { model: cfg.model, max_tokens: maxTokens, system, messages, stream: true };
  if (temperature != null) body.temperature = temperature;
  const headers = { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' };
  const res = await post('anthropic', url, headers, body, signal);
  kick();
  for await (const data of sseData(res, kick)) {
    let ev;
    try { ev = JSON.parse(data); } catch { continue; }
    switch (ev.type) {
      case 'message_start': {
        const u = ev.message?.usage || {};
        yield { type: 'usage', input: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) };
        break;
      }
      case 'content_block_delta':
        if (ev.delta?.type === 'text_delta') yield { type: 'text', text: ev.delta.text };
        break;
      case 'message_delta':
        if (ev.usage?.output_tokens != null) yield { type: 'usage', output: ev.usage.output_tokens };
        if (ev.delta?.stop_reason) yield { type: 'stop', reason: ev.delta.stop_reason };
        break;
      case 'error':
        throw new Error(`anthropic stream error: ${ev.error?.message || data}`);
      default:
    }
  }
}

async function* openaiCompatible(provider, { cfg, system, messages, maxTokens, temperature, signal, kick }) {
  const url = joinUrl(cfg.baseUrl || DEFAULT_BASE[provider], '/chat/completions');
  const body = { model: cfg.model, messages: [{ role: 'system', content: system }, ...messages], stream: true };
  if (provider === 'openai') body.max_completion_tokens = maxTokens;
  else body.max_tokens = maxTokens;
  // Gemini's OpenAI-compatible endpoint reports usage on its own; local servers may reject the option.
  if (provider === 'openai' || provider === 'openrouter') body.stream_options = { include_usage: true };
  if (temperature != null) body.temperature = temperature;
  const headers = { 'content-type': 'application/json' };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  if (provider === 'openrouter') {
    headers['http-referer'] = 'http://localhost';
    headers['x-title'] = 'BYOTeX.AI LaTeX Workspace';
  }
  const res = await post(provider, url, headers, body, signal);
  kick();
  for await (const data of sseData(res, kick)) {
    if (data === '[DONE]') return;
    let ev;
    try { ev = JSON.parse(data); } catch { continue; }
    if (ev.error) throw new Error(`${provider} stream error: ${ev.error.message || JSON.stringify(ev.error)}`);
    const choice = ev.choices?.[0];
    const text = choice?.delta?.content;
    if (text) yield { type: 'text', text };
    if (choice?.finish_reason) yield { type: 'stop', reason: choice.finish_reason };
    if (ev.usage) yield { type: 'usage', input: ev.usage.prompt_tokens, output: ev.usage.completion_tokens };
  }
}

/**
 * Watchdog: aborts the request if the provider sends nothing for `ms` — first while waiting for the
 * response to start ('start'), then between chunks once streaming ('stall'). The caller's own
 * signal (user pressed Stop) is forwarded unchanged.
 */
function watchdog(userSignal, ms) {
  const ctrl = new AbortController();
  let fired = null;
  let timer = null;
  const onUser = () => ctrl.abort(userSignal.reason);
  if (userSignal) {
    if (userSignal.aborted) ctrl.abort(userSignal.reason);
    else userSignal.addEventListener('abort', onUser, { once: true });
  }
  const arm = (phase) => {
    clearTimeout(timer);
    if (ms > 0) timer = setTimeout(() => { fired = phase; ctrl.abort(); }, ms);
  };
  const stop = () => { clearTimeout(timer); userSignal?.removeEventListener('abort', onUser); };
  return { signal: ctrl.signal, arm, stop, fired: () => fired };
}

function timeoutError(provider, phase, ms) {
  const s = Math.round(ms / 1000);
  const msg = phase === 'start'
    ? `${provider} accepted the request but sent no response for ${s} s, so BYOTeX.AI gave up. The model may be overloaded, or a "thinking" model may still be reasoning before it streams. Try again, choose a faster model (e.g. a -lite or -flash variant), or raise "Response timeout" in Settings.`
    : `${provider} stopped sending data for ${s} s in the middle of the response, so BYOTeX.AI gave up. Try again, or raise "Response timeout" in Settings.`;
  return Object.assign(new Error(msg), { status: 504, timeout: phase });
}

/** Unified streaming entry point. Yields {type:'text'|'usage'|'stop', ...}. */
async function* stream(provider, opts) {
  if (!opts.cfg.model) throw Object.assign(new Error(`No model configured for ${provider}`), { status: 400 });
  const impl = provider === 'anthropic' ? anthropic
    : provider === 'opencode' ? require('./opencode').stream
      : ['openai', 'gemini', 'openrouter', 'local'].includes(provider) ? (o) => openaiCompatible(provider, o) : null;
  if (!impl) throw Object.assign(new Error(`Unknown provider ${provider}`), { status: 400 });
  const ms = Math.max(0, Number(opts.timeoutSec) || 0) * 1000;
  const wd = watchdog(opts.signal, ms);
  wd.arm('start');
  try {
    yield* impl({ ...opts, signal: wd.signal, kick: () => wd.arm('stall') });
  } catch (e) {
    const phase = wd.fired();
    if (phase) throw timeoutError(provider, phase, ms);
    throw e;
  } finally {
    wd.stop();
  }
}

const estimateTokens = (s) => Math.ceil(String(s).length / 4);

/** List the models the configured key can use. Returns [{id, name}] sorted by id. */
async function listModels(provider, cfg) {
  if (provider === 'opencode') return require('./opencode').listModels();
  if (!DEFAULT_BASE[provider]) throw Object.assign(new Error(`Unknown provider ${provider}`), { status: 400 });
  const base = cfg.baseUrl || DEFAULT_BASE[provider];
  let url;
  const headers = {};
  if (provider === 'anthropic') {
    url = joinUrl(base, '/v1/models?limit=1000');
    headers['x-api-key'] = cfg.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    url = joinUrl(base, '/models');
    if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  }
  logger.info('http', `→ GET ${url} [${provider}] (list models)`, { headers: redactHeaders(headers) });
  const res = await netFetch(url, { headers, signal: AbortSignal.timeout(20000) });
  logger.info('http', `← ${res.status} ${res.statusText || ''} [${provider}]`);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw Object.assign(new Error(`HTTP ${res.status} from ${provider}: ${text.slice(0, 600)}`), { status: 502 });
  }
  const j = await res.json();
  const rows = Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : [];
  const seen = new Set();
  const models = [];
  for (const m of rows) {
    // Gemini's OpenAI-compatible listing prefixes ids with "models/"; its chat endpoint takes the bare name.
    const id = String(m.id || m.name || '').replace(/^models\//, '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, name: m.display_name || m.name && m.name !== m.id ? String(m.display_name || m.name).replace(/^models\//, '') : '' });
  }
  models.sort((a, b) => a.id.localeCompare(b.id));
  return models;
}

module.exports = { stream, estimateTokens, listModels };
