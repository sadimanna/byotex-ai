'use strict';
// Verified citations: search Crossref (journals/conferences) and arXiv (preprints), fetch real BibTeX
// (DOI content negotiation at doi.org, or built from arXiv metadata), and append it to a .bib file.
// The AI never writes BibTeX itself: it can only ask for a reference, and the user picks a real one here.
const fs = require('fs');
const path = require('path');
const ws = require('./workspace');
const logger = require('./logger');
const { parseBib } = require('./parser');

const UA = 'BYOTeX.AI/0.1 (+https://github.com/sadimanna/byotex-ai)';
const TIMEOUT = 15000;
const DOI_RE = /\b(10\.\d{4,9}\/[^\s"<>]+)\b/i;
const ARXIV_RE = /(?:arxiv[:/ ]|abs\/)?(\d{4}\.\d{4,5})(v\d+)?\b/i;

async function get(url, accept = 'application/json') {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept }, signal: AbortSignal.timeout(TIMEOUT), redirect: 'follow' });
  if (!res.ok) throw Object.assign(new Error(`${new URL(url).host} answered HTTP ${res.status}`), { status: 502 });
  return res;
}

const decodeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const clean = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

function fromCrossref(it) {
  const authors = (it.author || []).map((a) => [a.family, a.given].filter(Boolean).join(', ') || a.name).filter(Boolean);
  const year = it.issued?.['date-parts']?.[0]?.[0] || it.published?.['date-parts']?.[0]?.[0] || null;
  return { source: 'crossref', id: it.DOI, doi: it.DOI, title: clean((it.title || [])[0]), authors, year, venue: clean((it['container-title'] || [])[0]) || it.publisher || '', type: it.type, url: `https://doi.org/${it.DOI}` };
}

function parseArxivFeed(xml) {
  const out = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const tag = (t) => { const x = new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`).exec(e); return x ? decodeXml(clean(x[1])) : ''; };
    const idUrl = tag('id');
    const id = (/abs\/([^v\s]+(?:v\d+)?)/.exec(idUrl) || [])[1]?.replace(/v\d+$/, '');
    if (!id) continue;
    const authors = [...e.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map((a) => {
      const n = decodeXml(clean(a[1])).split(' ');
      return n.length > 1 ? `${n[n.length - 1]}, ${n.slice(0, -1).join(' ')}` : n[0];
    });
    const doi = (/<arxiv:doi[^>]*>([^<]+)<\/arxiv:doi>/.exec(e) || [])[1] || null;
    const cat = (/<arxiv:primary_category[^>]*term="([^"]+)"/.exec(e) || [])[1] || '';
    out.push({ source: 'arxiv', id, arxiv: id, doi, title: tag('title'), authors, year: Number(tag('published').slice(0, 4)) || null, venue: `arXiv${cat ? ` [${cat}]` : ''}`, category: cat, url: `https://arxiv.org/abs/${id}` });
  }
  return out;
}

/** Search both sources (or look up a DOI / arXiv id directly). */
async function search(q) {
  q = String(q || '').trim();
  if (q.length < 3) throw ws.httpErr(400, 'Type at least 3 characters');
  const doi = DOI_RE.exec(q)?.[1];
  const arxivId = /^(?:arxiv:)?\d{4}\.\d{4,5}(v\d+)?$/i.test(q) || /arxiv\.org\/abs\//i.test(q) ? ARXIV_RE.exec(q)?.[1] : null;
  const tasks = [];
  if (doi) tasks.push(get(`https://api.crossref.org/works/${encodeURIComponent(doi)}`).then((r) => r.json()).then((j) => [fromCrossref(j.message)]));
  else if (arxivId) tasks.push(get(`https://export.arxiv.org/api/query?id_list=${arxivId}`, 'application/atom+xml').then((r) => r.text()).then(parseArxivFeed));
  else {
    const sel = 'DOI,title,author,issued,published,container-title,publisher,type';
    tasks.push(get(`https://api.crossref.org/works?rows=8&select=${sel}&query.bibliographic=${encodeURIComponent(q)}`).then((r) => r.json()).then((j) => (j.message.items || []).filter((i) => i.title?.length).map(fromCrossref)));
    const terms = q.replace(/["()]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 8).map((t) => `all:${t}`).join('+AND+');
    tasks.push(get(`https://export.arxiv.org/api/query?max_results=6&search_query=${encodeURIComponent(terms).replace(/%2B/g, '+')}`, 'application/atom+xml').then((r) => r.text()).then(parseArxivFeed));
  }
  const settled = await Promise.allSettled(tasks);
  const results = [];
  const errors = [];
  for (const s of settled) { if (s.status === 'fulfilled') results.push(...s.value); else errors.push(s.reason.message); }
  // drop arXiv duplicates of journal versions (same DOI or same title)
  const seen = new Set(results.filter((r) => r.source === 'crossref').flatMap((r) => [r.doi?.toLowerCase(), r.title.toLowerCase()]));
  const merged = results.filter((r) => r.source === 'crossref' || !(seen.has(r.doi?.toLowerCase()) || seen.has(r.title.toLowerCase())));
  logger.info('cite', `"${q.slice(0, 60)}" → ${merged.length} result(s)${errors.length ? ` (${errors.join('; ')})` : ''}`);
  return { results: merged, errors };
}

// ---- BibTeX --------------------------------------------------------------------------------
const STOP = new Set(['a', 'an', 'the', 'on', 'of', 'for', 'in', 'to', 'and', 'with', 'via', 'from', 'towards', 'toward', 'is', 'are', 'by', 'at', 'as']);
const ascii = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]/g, '');

function makeKey(item, existing) {
  const last = ascii((item.authors[0] || 'anon').split(',')[0]).toLowerCase() || 'anon';
  const word = (item.title.toLowerCase().match(/[a-z0-9]+/g) || []).find((w) => !STOP.has(w) && w.length > 2) || '';
  const base = `${last}${item.year || ''}${word}`;
  let key = base;
  for (let i = 0; existing.has(key); i++) key = base + String.fromCharCode(97 + i);
  return key;
}

/** Split "@type{key, a={..}, b="..", c=12}" into {type, key, fields:[[name, rawValue]]} (brace-aware). */
function splitEntry(bib) {
  const m = /@\s*(\w+)\s*\{\s*([^,]*),/.exec(bib);
  if (!m) return null;
  const body = bib.slice(m.index + m[0].length, bib.lastIndexOf('}'));
  const fields = [];
  let depth = 0, inQ = false, start = 0;
  const push = (seg) => { const k = /^\s*([\w-]+)\s*=\s*([\s\S]*?)\s*$/.exec(seg); if (k) fields.push([k[1].toLowerCase(), k[2]]); };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\') { i++; continue; }
    if (c === '"' && depth === 0) inQ = !inQ;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === ',' && depth === 0 && !inQ) { push(body.slice(start, i)); start = i + 1; }
  }
  push(body.slice(start));
  return { type: m[1].toLowerCase(), key: m[2].trim(), fields };
}

function format(type, key, fields) {
  const order = ['title', 'author', 'editor', 'booktitle', 'journal', 'volume', 'number', 'pages', 'year', 'month', 'publisher', 'doi', 'eprint', 'archiveprefix', 'primaryclass', 'url'];
  const sorted = [...fields].sort((a, b) => (order.indexOf(a[0]) + 1 || 99) - (order.indexOf(b[0]) + 1 || 99));
  const w = Math.max(...sorted.map(([k]) => k.length));
  return `@${type}{${key},\n${sorted.map(([k, v]) => `  ${k.padEnd(w)} = ${v}`).join(',\n')}\n}`;
}

function projectBib(root) {
  const scan = ws.scan(root);
  const bibs = Object.values(scan.files).filter((f) => f.kind === 'bib');
  return { bibs, keys: new Set(bibs.flatMap((b) => b.entries.map((e) => e.key))), scan };
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Real BibTeX for a search result, re-keyed to fit the project; reports an existing duplicate instead. */
async function bibtexFor(root, item) {
  const { bibs, keys } = projectBib(root);
  // duplicate? (same DOI / arXiv id / title already in a .bib)
  for (const b of bibs) {
    const text = fs.readFileSync(ws.safeResolve(root, b.path), 'utf8');
    for (const e of parseBib(text, b.path).entries) {
      const block = text.slice(text.indexOf(`{${e.key},`));
      const hasId = (item.doi && block.slice(0, 2000).toLowerCase().includes(item.doi.toLowerCase())) || (item.arxiv && block.slice(0, 2000).includes(item.arxiv));
      if (hasId || (e.fields.title && norm(e.fields.title) === norm(item.title))) return { existingKey: e.key, bibFile: b.path };
    }
  }
  const key = makeKey(item, keys);
  if (item.doi && item.source === 'crossref') {
    const raw = (await (await get(`https://doi.org/${encodeURIComponent(item.doi).replace(/%2F/g, '/')}`, 'application/x-bibtex')).text()).trim();
    const e = splitEntry(raw);
    if (e) {
      const fields = e.fields.filter(([k]) => !['month'].includes(k)).map(([k, v]) => [k, k === 'pages' ? v.replace(/[\u2013\u2014]/g, '--') : v]);
      return { key, bibtex: format(e.type, key, fields), from: 'doi.org' };
    }
  }
  // arXiv (or a DOI without usable BibTeX): build it from the metadata we have.
  const esc = (s) => `{${String(s).replace(/[{}]/g, '')}}`;
  const fields = [['title', `{${esc(item.title)}}`], ['author', esc(item.authors.join(' and '))], ['year', esc(item.year || '')]];
  if (item.arxiv) fields.push(['eprint', esc(item.arxiv)], ['archiveprefix', '{arXiv}'], ...(item.category ? [['primaryclass', esc(item.category)]] : []));
  if (item.doi) fields.push(['doi', esc(item.doi)]);
  fields.push(['url', esc(item.url)]);
  return { key, bibtex: format(item.arxiv ? 'misc' : 'article', key, fields), from: item.arxiv ? 'arxiv.org' : 'crossref' };
}

/** Append an entry to a project .bib (created next to the main file if there is none yet). */
function addToBib(root, bibRel, bibtex, note) {
  const { bibs, scan } = projectBib(root);
  let rel = bibRel;
  let created = false;
  if (!rel) {
    rel = bibs[0]?.path || path.posix.join(path.posix.dirname(scan.mainFile || 'main.tex'), 'refs.bib').replace(/^\.\//, '');
    created = !bibs.length;
  }
  if (!rel.endsWith('.bib')) throw ws.httpErr(400, 'Citations can only be added to a .bib file');
  if (!/^@\w+\{[^,\s]+,/.test(bibtex.trim())) throw ws.httpErr(400, 'Not a BibTeX entry');
  const abs = ws.safeResolve(root, rel);
  const current = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
  const sep = current && !current.endsWith('\n\n') ? (current.endsWith('\n') ? '\n' : '\n\n') : '';
  const w = ws.writeText(root, rel, `${current}${sep}${bibtex.trim()}\n`, { backups: true, reason: { source: 'citation', note } });
  logger.info('cite', `${note} → ${rel}`);
  return { ...w, bibFile: rel, createdBib: created || w.created };
}

module.exports = { search, bibtexFor, addToBib, makeKey, splitEntry, format, parseArxivFeed };
