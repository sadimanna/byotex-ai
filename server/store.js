'use strict';
// Encrypted local settings store.
// Settings (including API keys) are serialised to JSON and sealed with AES-256-GCM.
// Key material: a random 256-bit master key in <dataDir>/master.key (chmod 600), or —
// if BYOTEX_PASSPHRASE is set — a key derived from the passphrase with scrypt.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = process.env.BYOTEX_DATA_DIR || path.join(os.homedir(), '.byotex-ai');
const KEY_FILE = path.join(DATA_DIR, 'master.key');
const SALT_FILE = path.join(DATA_DIR, 'kdf.salt');
const STORE_FILE = path.join(DATA_DIR, 'settings.enc.json');

const PROVIDERS = ['anthropic', 'openai', 'gemini', 'openrouter', 'local', 'opencode'];

const DEFAULTS = {
  activeProvider: 'anthropic',
  providers: {
    anthropic: { apiKey: '', model: 'claude-sonnet-5-5', baseUrl: 'https://api.anthropic.com' },
    openai: { apiKey: '', model: 'gpt-4.1', baseUrl: 'https://api.openai.com/v1' },
    gemini: { apiKey: '', model: 'gemini-3.8-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
    openrouter: { apiKey: '', model: 'anthropic/claude-sonnet-4.5', baseUrl: 'https://openrouter.ai/api/v1' },
    local: { apiKey: '', model: 'llama3.1', baseUrl: 'http://localhost:11434/v1' },
    // OpenCode needs no key: BYOTeX.AI runs a private `opencode serve`. Model = OpenCode Zen model id (free ones).
    opencode: { apiKey: '', model: 'big-pickle', baseUrl: '' },
  },
  workspaceRoot: '',
  maxTokens: 8192,
  temperature: null, // null → provider default (not sent)
  maxContextChars: 120000,
  texPath: '', // folder containing latexmk/pdflatex; '' = auto-detect
  responseTimeout: 120, // seconds without any data from the provider before giving up
  autoApply: false,
  backups: true,
};

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

let cachedKey = null;
function getKey() {
  if (cachedKey) return cachedKey;
  ensureDir();
  if (process.env.BYOTEX_PASSPHRASE) {
    let salt;
    if (fs.existsSync(SALT_FILE)) salt = fs.readFileSync(SALT_FILE);
    else {
      salt = crypto.randomBytes(16);
      fs.writeFileSync(SALT_FILE, salt, { mode: 0o600 });
    }
    cachedKey = crypto.scryptSync(process.env.BYOTEX_PASSPHRASE, salt, 32);
  } else if (fs.existsSync(KEY_FILE)) {
    cachedKey = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'base64');
  } else {
    cachedKey = crypto.randomBytes(32);
    fs.writeFileSync(KEY_FILE, cachedKey.toString('base64'), { mode: 0o600 });
  }
  if (cachedKey.length !== 32) throw new Error('Invalid master key length');
  return cachedKey;
}

function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return {
    v: 1,
    alg: 'aes-256-gcm',
    kdf: process.env.BYOTEX_PASSPHRASE ? 'scrypt' : 'keyfile',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

function decrypt(sealed) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(sealed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  const out = Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]);
  return JSON.parse(out.toString('utf8'));
}

function merge(defaults, saved) {
  const out = JSON.parse(JSON.stringify(defaults));
  if (!saved || typeof saved !== 'object') return out;
  for (const k of Object.keys(out)) {
    if (k === 'providers') continue;
    if (saved[k] !== undefined) out[k] = saved[k];
  }
  for (const p of PROVIDERS) Object.assign(out.providers[p], (saved.providers || {})[p] || {});
  if (!PROVIDERS.includes(out.activeProvider)) out.activeProvider = 'anthropic';
  return out;
}

function load() {
  if (!fs.existsSync(STORE_FILE)) return merge(DEFAULTS, null);
  try {
    return merge(DEFAULTS, decrypt(JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'))));
  } catch (e) {
    const err = new Error(`Could not decrypt ${STORE_FILE} (${e.message}). Wrong passphrase or corrupted store.`);
    err.code = 'DECRYPT_FAILED';
    throw err;
  }
}

function save(settings) {
  ensureDir();
  const tmp = STORE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(encrypt(settings), null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STORE_FILE);
}

function keyHint(key) {
  if (!key) return '';
  return key.length <= 8 ? '••••' : `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/** Settings as sent to the UI — keys are never returned, only a hint. */
function publicView(s) {
  const providers = {};
  for (const p of PROVIDERS) {
    const { apiKey, ...rest } = s.providers[p];
    providers[p] = { ...rest, hasKey: !!apiKey, keyHint: keyHint(apiKey) };
  }
  return { ...s, providers, storePath: STORE_FILE, kdf: process.env.BYOTEX_PASSPHRASE ? 'scrypt passphrase' : 'local key file' };
}

function validUrl(u) {
  try {
    const x = new URL(u);
    return x.protocol === 'http:' || x.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Apply a patch from the UI. For apiKey: undefined/'' keeps the stored key,
 * a non-empty string replaces it, and clearKey:true removes it.
 */
function applyPatch(current, patch) {
  const next = JSON.parse(JSON.stringify(current));
  if (patch.activeProvider !== undefined) {
    if (!PROVIDERS.includes(patch.activeProvider)) throw new Error('Unknown provider');
    next.activeProvider = patch.activeProvider;
  }
  for (const p of PROVIDERS) {
    const pp = (patch.providers || {})[p];
    if (!pp) continue;
    if (pp.clearKey) next.providers[p].apiKey = '';
    else if (typeof pp.apiKey === 'string' && pp.apiKey.trim()) next.providers[p].apiKey = pp.apiKey.trim();
    if (typeof pp.model === 'string') next.providers[p].model = pp.model.trim();
    if (typeof pp.baseUrl === 'string' && p !== 'opencode') {
      if (!validUrl(pp.baseUrl.trim())) throw new Error(`Invalid base URL for ${p}`);
      next.providers[p].baseUrl = pp.baseUrl.trim();
    }
  }
  const num = (v, lo, hi) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`Value out of range: ${v}`);
    return n;
  };
  if (patch.maxTokens !== undefined) next.maxTokens = Math.round(num(patch.maxTokens, 64, 200000));
  if (patch.maxContextChars !== undefined) next.maxContextChars = Math.round(num(patch.maxContextChars, 1000, 5000000));
  if (patch.temperature !== undefined) {
    next.temperature = patch.temperature === null || patch.temperature === '' ? null : num(patch.temperature, 0, 2);
  }
  if (patch.responseTimeout !== undefined) next.responseTimeout = Math.round(num(patch.responseTimeout, 10, 290));
  if (patch.texPath !== undefined) {
    const p = String(patch.texPath || '').trim().replace(/^~(?=$|[\\/])/, require('os').homedir());
    if (p && !(fs.existsSync(p) && fs.statSync(p).isDirectory())) throw new Error(`TeX bin folder does not exist: ${p}`);
    next.texPath = p ? path.resolve(p) : '';
  }
  if (patch.autoApply !== undefined) next.autoApply = !!patch.autoApply;
  if (patch.backups !== undefined) next.backups = !!patch.backups;
  return next;
}

module.exports = { load, save, publicView, applyPatch, PROVIDERS, DATA_DIR, STORE_FILE };
