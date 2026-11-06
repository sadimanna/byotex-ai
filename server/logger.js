'use strict';
// Central log bus. Every backend module logs here; the UI console subscribes via SSE.
const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(100);
const history = [];
const HISTORY_MAX = 1500;
let seq = 0;

function truncateDeep(value, max = 400, depth = 0) {
  if (depth > 8) return '[depth]';
  if (typeof value === 'string') {
    return value.length > max ? value.slice(0, max) + `…[+${value.length - max} chars]` : value;
  }
  if (Array.isArray(value)) return value.map((v) => truncateDeep(v, max, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = truncateDeep(v, max, depth + 1);
    return out;
  }
  return value;
}

function log(level, tag, msg, data) {
  const entry = { id: ++seq, t: new Date().toISOString(), level, tag, msg };
  if (data !== undefined) entry.data = truncateDeep(data);
  history.push(entry);
  if (history.length > HISTORY_MAX) history.shift();
  bus.emit('log', entry);
  if (process.env.BYOTEX_QUIET !== '1') {
    process.stdout.write(`[${entry.t.slice(11, 19)}] ${level.toUpperCase().padEnd(5)} ${tag.padEnd(8)} ${msg}\n`);
  }
  return entry;
}

module.exports = {
  bus,
  history,
  truncateDeep,
  log,
  info: (tag, msg, data) => log('info', tag, msg, data),
  warn: (tag, msg, data) => log('warn', tag, msg, data),
  error: (tag, msg, data) => log('error', tag, msg, data),
  debug: (tag, msg, data) => log('debug', tag, msg, data),
};
