'use strict';
// Offline mock of an OpenAI-compatible /chat/completions endpoint, for trying the app without an API key.
// Usage: npm run mock-llm   → then Settings → Local endpoint, Base URL http://127.0.0.1:4199/v1
// It reads the context BYOTeX.AI sends and streams back a plausible EDIT block for the first context file.
const http = require('http');

const PORT = Number(process.env.MOCK_PORT || 4199);

function makeReply(userText, systemText) {
  const m = /----- BEGIN (.+?) -----\n([\s\S]*?)\n----- END \1 -----/.exec(userText);
  if (!m) return 'I could not find any file context in the request. Add a file to the context and try again.';
  const [, file, body] = m;
  if (/MODE: ASK/.test(systemText)) return `(mock) ${file} has ${body.split('\n').length} lines in context. No edits in ASK mode.`;
  const abs = /\\begin\{abstract\}\n([\s\S]*?)\n\\end\{abstract\}/.exec(body);
  if (abs) {
    return [
      'Tightened the abstract: removed passive constructions and filler ("for the purpose of", "it is shown").',
      '',
      `<<<<<<< EDIT ${file}`,
      abs[1],
      '=======',
      'We present a sparse attention prior that improves retrieval over very long documents.',
      'Experiments on three long-context benchmarks show consistent gains, and the prior',
      'transfers across task types without modification.',
      '>>>>>>> END',
      '',
    ].join('\n');
  }
  const lines = body.split('\n');
  const idx = lines.findIndex((l) => l.trim() && !l.trim().startsWith('%') && !l.trim().startsWith('\\'));
  if (idx < 0) return 'No prose lines found to edit.';
  return [
    'Marked the first prose line for review.',
    '',
    `<<<<<<< EDIT ${file}`,
    lines[idx],
    '=======',
    `${lines[idx]} % (mock) reviewed`,
    '>>>>>>> END',
  ].join('\n');
}

http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: ['mock', 'mock-large', 'models/mock-gemini-style'].map((id) => ({ id, object: 'model' })) }));
    return;
  }
  if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) { res.writeHead(404).end(); return; }
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', async () => {
    const body = JSON.parse(raw || '{}');
    // MOCK_DELAY_MS simulates a provider that is slow to start responding.
    if (process.env.MOCK_DELAY_MS) await new Promise((r) => setTimeout(r, Number(process.env.MOCK_DELAY_MS)));
    const sys = (body.messages || []).find((x) => x.role === 'system')?.content || '';
    const user = [...(body.messages || [])].reverse().find((x) => x.role === 'user')?.content || '';
    const reply = makeReply(user, sys);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunks = reply.match(/[\s\S]{1,24}/g) || [];
    for (const c of chunks) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`);
      await new Promise((r) => setTimeout(r, 15));
    }
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: Math.ceil(raw.length / 4), completion_tokens: Math.ceil(reply.length / 4) } })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
}).listen(PORT, '127.0.0.1', () => console.log(`mock LLM on http://127.0.0.1:${PORT}/v1`));
