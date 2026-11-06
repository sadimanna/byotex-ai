'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.BYOTEX_QUIET = '1';
const { parseTex, parseBib, stripComment } = require('../server/parser');
const { diffLines, analyze, rebuild } = require('../server/diff');
const patch = require('../server/patch');
const ws = require('../server/workspace');

test('stripComment respects escaped percent', () => {
  assert.strictEqual(stripComment('50\\% of cases % note'), '50\\% of cases ');
  assert.strictEqual(stripComment('a \\\\% b'), 'a \\\\');
});

test('parseTex builds a section tree and environments', () => {
  const tex = [
    '\\documentclass{article}', '\\begin{document}', '\\section{Intro}', 'text \\cite{a,b}',
    '\\subsection{Sub \\emph{x}}', '\\begin{figure}', '\\caption{Cap}', '\\label{fig:a}', '\\end{figure}',
    '\\section*{Two}', 'see \\ref{fig:a}', '\\end{document}',
  ].join('\n');
  const p = parseTex(tex, 'm.tex');
  assert.strictEqual(p.documentclass, 'article');
  assert.deepStrictEqual(p.sections.map((s) => [s.title, s.start, s.end]), [['Intro', 3, 9], ['Two', 10, 11]]);
  assert.strictEqual(p.sections[0].children[0].title, 'Sub x');
  assert.deepStrictEqual(p.cites.map((c) => c.key), ['a', 'b']);
  const fig = p.environments.find((e) => e.name === 'figure');
  assert.deepStrictEqual([fig.start, fig.end, fig.label, fig.caption], [6, 9, 'fig:a', 'Cap']);
  assert.strictEqual(p.errors.length, 0);
});

test('parseBib extracts keys and fields', () => {
  const b = parseBib('@article{k1,\n title={A {B} c},\n year=2020}\n@comment{x}\n@book{k2, author="Doe"}', 'r.bib');
  assert.deepStrictEqual(b.entries.map((e) => e.key), ['k1', 'k2']);
  assert.strictEqual(b.entries[0].fields.title, 'A B c');
  assert.strictEqual(b.entries[0].fields.year, '2020');
});

test('diff + selective rebuild', () => {
  const a = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];
  const b = ['1', 'TWO', '3', '4', '5', '6', '7', '8', 'NINE', '10'];
  const ops = diffLines(a, b);
  const { hunks } = analyze(ops);
  assert.strictEqual(hunks.length, 2);
  assert.deepStrictEqual(rebuild(ops, new Set([0, 1])), b);
  assert.deepStrictEqual(rebuild(ops, new Set()), a);
  assert.deepStrictEqual(rebuild(ops, new Set([1])), ['1', '2', '3', '4', '5', '6', '7', '8', 'NINE', '10']);
});

test('parseEditBlocks + applyBlock (exact, fuzzy, ambiguous, missing)', () => {
  const out = 'Summary.\n<<<<<<< EDIT a.tex\nfoo\n=======\nbar\n>>>>>>> END\n<<<<<<< EDIT b.tex\nx\n=======\n';
  const blocks = patch.parseEditBlocks(out);
  assert.strictEqual(blocks.length, 2);
  assert.deepStrictEqual([blocks[0].path, blocks[0].search, blocks[0].replace], ['a.tex', 'foo', 'bar']);
  assert.ok(blocks[1].incomplete);
  assert.strictEqual(patch.applyBlock('a\nfoo\nb', blocks[0]).content, 'a\nbar\nb');
  assert.strictEqual(patch.applyBlock('a\nfoo\nb', { search: 'foo   \nb', replace: 'X' }).how, 'trailing-ws');
  assert.match(patch.applyBlock('foo\nfoo', blocks[0]).error, /more than one/);
  assert.match(patch.applyBlock('zzz', blocks[0]).error, /not found/);
  assert.strictEqual(patch.applyBlock('a\nfoo\nb', { search: 'foo', replace: '' }).content, 'a\nb');
});

test('proposal → partial apply → conflict detection → path confinement', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'byotex-'));
  fs.writeFileSync(path.join(root, 'm.tex'), 'L1\nL2\nL3\nL4\nL5\nL6\nL7\nL8\nL9\nL10\n');
  const p = patch.createProposal(root, patch.parseEditBlocks(
    '<<<<<<< EDIT m.tex\nL2\n=======\nline two\n>>>>>>> END\n<<<<<<< EDIT m.tex\nL9\n=======\nline nine\n>>>>>>> END\n<<<<<<< EDIT ../evil.tex\n\n=======\nx\n>>>>>>> END'));
  const f = p.files.find((x) => x.path === 'm.tex');
  assert.strictEqual(f.hunks.length, 2);
  assert.match(p.files.find((x) => x.path === '../evil.tex').fatal, /escapes/);
  const r = patch.applyProposal(root, p.id, { 'm.tex': [1] }, { backups: true });
  assert.strictEqual(r.find((x) => x.path === 'm.tex').status, 'written');
  assert.strictEqual(fs.readFileSync(path.join(root, 'm.tex'), 'utf8'), 'L1\nL2\nL3\nL4\nL5\nL6\nL7\nL8\nline nine\nL10\n');
  assert.ok(fs.existsSync(path.join(root, '.byotex-backups')));

  const p2 = patch.createProposal(root, patch.parseEditBlocks('<<<<<<< EDIT m.tex\nL3\n=======\nTHREE\n>>>>>>> END'));
  fs.appendFileSync(path.join(root, 'm.tex'), 'external edit\n');
  const r2 = patch.applyProposal(root, p2.id, null);
  assert.strictEqual(r2[0].status, 'error');
  assert.match(r2[0].reason, /changed on disk/);
  assert.throws(() => ws.writeText(root, 'x.png', 'no'), /restricted/);
});

test('parseLog attributes errors and warnings to source files', () => {
  const { parseLog } = require('../server/compile');
  const root = path.resolve('/proj'); // absolute on every OS (C:\proj on Windows)
  const log = [
    '(./main.tex (/usr/share/texmf/article.cls (/usr/share/texmf/size11.clo))',
    '(./sections/method.tex',
    './sections/method.tex:8: Undefined control sequence.',
    'l.8 where \\badmacro',
    "LaTeX Warning: Citation `x' on page 1 undefined on input line 11.",
    ')',
    'LaTeX Warning: Reference `y\' on page 2 undefined on input line 30.',
    ')',
  ].join('\n');
  const r = parseLog(log, root, root);
  assert.deepStrictEqual([r.errors[0].path, r.errors[0].line], ['sections/method.tex', 8]);
  assert.match(r.errors[0].message, /badmacro/);
  assert.deepStrictEqual(r.warnings.map((w) => [w.path, w.line]), [['sections/method.tex', 11], ['main.tex', 30]]);
});

test('every server module loads (catches syntax errors outside the tested paths)', () => {
  process.env.BYOTEX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'byotex-data-'));
  for (const m of ['store', 'llm', 'prompt', 'compile', 'texenv', 'opencode', 'workspace', 'patch', 'parser', 'diff', 'logger']) {
    assert.doesNotThrow(() => require(`../server/${m}`), `server/${m}.js failed to load`);
  }
});

test('compiles the sample paper end to end (skipped when LaTeX is not installed)', async (t) => {
  const texenv = require('../server/texenv');
  if (!texenv.findTool('latexmk') || !texenv.findTool('pdflatex')) return t.skip('latexmk/pdflatex not installed');
  const compile = require('../server/compile');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'byotex-compile-'));
  fs.cpSync(path.join(__dirname, '..', 'sample'), root, { recursive: true, filter: (src) => !/[\\/]\.byotex-/.test(src) });
  const r = await compile.compile(root, 'main.tex', 'pdflatex');
  assert.ok(r.pdf, `no PDF produced: ${JSON.stringify(r.errors)}`);
  assert.strictEqual(r.errors.length, 0, JSON.stringify(r.errors));
  // the sample deliberately cites a key that is missing from refs.bib
  assert.ok(r.warnings.some((w) => /izacard2021fid/.test(w.message) && w.path === 'sections/method.tex'));
});

test('citation helpers: BibTeX splitting/formatting, keys, arXiv feed parsing (offline)', () => {
  const cite = require('../server/cite');
  const e = cite.splitEntry(' @inproceedings{Karpukhin_2020, title={Dense Passage Retrieval for {Open-Domain} QA}, author={Karpukhin, Vladimir and Oguz, Barlas}, year={2020}, pages={6769–6781}}');
  assert.strictEqual(e.type, 'inproceedings');
  assert.deepStrictEqual(e.fields.map(([k]) => k), ['title', 'author', 'year', 'pages']);
  assert.strictEqual(e.fields[0][1], '{Dense Passage Retrieval for {Open-Domain} QA}');
  const out = cite.format(e.type, 'karpukhin2020dense', e.fields);
  assert.match(out, /^@inproceedings\{karpukhin2020dense,\n {2}title\s+= \{Dense/);
  const item = { authors: ['Karpukhin, Vladimir'], year: 2020, title: 'Dense Passage Retrieval for Open-Domain Question Answering' };
  assert.strictEqual(cite.makeKey(item, new Set()), 'karpukhin2020dense');
  assert.strictEqual(cite.makeKey(item, new Set(['karpukhin2020dense'])), 'karpukhin2020densea');
  const feed = '<feed><entry><id>http://arxiv.org/abs/2007.01282v2</id><published>2020-07-02T17:44:57Z</published><title>Leveraging Passage\n  Retrieval</title><author><name>Gautier Izacard</name></author><author><name>Edouard Grave</name></author><arxiv:primary_category term="cs.CL"/></entry></feed>';
  const [a] = cite.parseArxivFeed(feed);
  assert.deepStrictEqual([a.arxiv, a.year, a.title, a.authors[0], a.category], ['2007.01282', 2020, 'Leveraging Passage Retrieval', 'Izacard, Gautier', 'cs.CL']);
});
