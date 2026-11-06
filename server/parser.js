'use strict';
// Lightweight LaTeX + BibTeX structure parser.
// Not a full TeX engine: it produces line-addressed structural nodes (preamble, sectioning tree,
// environments, labels, refs, citations, includes, graphics) that the UI and the prompt builder use.

const SECTION_LEVELS = {
  part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5, subparagraph: 6,
};
const SECTION_RE = /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)(\*?)\s*(?:\[[^\]]*\])?\s*\{/g;
const ENV_RE = /\\(begin|end)\s*\{([^}]+)\}/g;
const LABEL_RE = /\\label\s*\{([^}]*)\}/g;
const REF_RE = /\\(?:ref|eqref|autoref|pageref|cref|Cref|vref|nameref)\s*\{([^}]*)\}/g;
const CITE_RE = /\\(?:no)?cite[a-zA-Z]*\*?\s*(?:\[[^\]]*\]\s*){0,2}\{([^}]*)\}/g;
const GRAPHICS_RE = /\\includegraphics\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;
const INCLUDE_RE = /\\(input|include|subfile)\s*\{([^}]*)\}/g;
const BIB_RE = /\\(bibliography|addbibresource)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;
const PKG_RE = /\\usepackage\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;
const DOCCLASS_RE = /\\documentclass\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/;
const TITLE_RE = /\\title\s*(?:\[[^\]]*\])?\s*\{/;
const CAPTION_RE = /\\caption\s*(?:\[[^\]]*\])?\s*\{/;

/** Remove an unescaped % comment from a line. */
function stripComment(line) {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '%') {
      let bs = 0;
      for (let j = i - 1; j >= 0 && line[j] === '\\'; j--) bs++;
      if (bs % 2 === 0) return line.slice(0, i);
    }
  }
  return line;
}

/** Read a brace group. `open` is the index of '{'. Returns content (unclosed → rest of string). */
function readBraced(str, open) {
  let depth = 0;
  for (let i = open; i < str.length; i++) {
    const c = str[i];
    if (c === '\\') { i++; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return { content: str.slice(open + 1, i), end: i, closed: true };
    }
  }
  return { content: str.slice(open + 1), end: str.length, closed: false };
}

const splitKeys = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
const cleanTitle = (s) => s.replace(/\\[a-zA-Z]+\*?\s*/g, '').replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();

function parseTex(text, relPath) {
  const lines = text.split(/\r?\n/);
  const out = {
    path: relPath,
    kind: 'tex',
    lineCount: lines.length,
    words: 0,
    documentclass: null,
    title: null,
    packages: [],
    preamble: null,
    body: null,
    sections: [],
    environments: [],
    labels: [],
    refs: [],
    cites: [],
    includes: [],
    graphics: [],
    bibliographies: [],
    errors: [],
  };
  const secStack = [];
  const envStack = [];
  let docStart = null;

  const closeSections = (level, endLine) => {
    while (secStack.length && secStack[secStack.length - 1].level >= level) {
      secStack.pop().end = endLine;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const ln = i + 1;
    const code = stripComment(lines[i]);
    if (!code.trim()) continue;
    if (docStart !== null) out.words += (code.replace(/\\[a-zA-Z]+/g, ' ').match(/[A-Za-z0-9][\w'-]*/g) || []).length;

    let m;
    if (!out.documentclass && (m = DOCCLASS_RE.exec(code))) out.documentclass = m[1].trim();
    if (!out.title && (m = TITLE_RE.exec(code))) out.title = cleanTitle(readBraced(code, m.index + m[0].length - 1).content);

    // Sectioning
    SECTION_RE.lastIndex = 0;
    while ((m = SECTION_RE.exec(code))) {
      const cmd = m[1];
      const level = SECTION_LEVELS[cmd];
      const br = readBraced(code, m.index + m[0].length - 1);
      closeSections(level, ln - 1);
      const node = {
        id: `${relPath}#L${ln}`,
        type: 'section',
        cmd,
        starred: m[2] === '*',
        level,
        title: cleanTitle(br.content) || '(untitled)',
        start: ln,
        end: null,
        children: [],
      };
      if (secStack.length) secStack[secStack.length - 1].children.push(node);
      else out.sections.push(node);
      secStack.push(node);
    }

    // Environments
    ENV_RE.lastIndex = 0;
    while ((m = ENV_RE.exec(code))) {
      const name = m[2].trim();
      if (m[1] === 'begin') {
        if (name === 'document') {
          docStart = ln;
          out.preamble = { start: 1, end: Math.max(1, ln - 1) };
          continue;
        }
        envStack.push({ name, start: ln, depth: envStack.length, label: null, caption: null });
      } else {
        if (name === 'document') {
          closeSections(-1, ln - 1);
          out.body = { start: docStart || 1, end: ln };
          continue;
        }
        let idx = envStack.length - 1;
        while (idx >= 0 && envStack[idx].name !== name) idx--;
        if (idx < 0) {
          out.errors.push({ line: ln, message: `\\end{${name}} without matching \\begin` });
          continue;
        }
        for (let k = envStack.length - 1; k > idx; k--) {
          const lost = envStack.pop();
          out.errors.push({ line: lost.start, message: `\\begin{${lost.name}} not closed before \\end{${name}} (line ${ln})` });
        }
        const env = envStack.pop();
        out.environments.push({ id: `${relPath}#E${env.start}`, type: 'env', name, start: env.start, end: ln, depth: env.depth, label: env.label, caption: env.caption });
      }
    }

    const top = envStack[envStack.length - 1];
    if (top && !top.caption && (m = CAPTION_RE.exec(code))) top.caption = cleanTitle(readBraced(code, m.index + m[0].length - 1).content).slice(0, 80);

    LABEL_RE.lastIndex = 0;
    while ((m = LABEL_RE.exec(code))) {
      const name = m[1].trim();
      if (top && !top.label) top.label = name;
      out.labels.push({ name, line: ln, env: top ? top.name : null });
    }
    REF_RE.lastIndex = 0;
    while ((m = REF_RE.exec(code))) for (const k of splitKeys(m[1])) out.refs.push({ name: k, line: ln });
    CITE_RE.lastIndex = 0;
    while ((m = CITE_RE.exec(code))) for (const k of splitKeys(m[1])) out.cites.push({ key: k, line: ln });
    GRAPHICS_RE.lastIndex = 0;
    while ((m = GRAPHICS_RE.exec(code))) out.graphics.push({ file: m[1].trim(), line: ln });
    INCLUDE_RE.lastIndex = 0;
    while ((m = INCLUDE_RE.exec(code))) out.includes.push({ cmd: m[1], file: m[2].trim(), line: ln });
    BIB_RE.lastIndex = 0;
    while ((m = BIB_RE.exec(code))) for (const k of splitKeys(m[2])) out.bibliographies.push({ file: k, line: ln });
    PKG_RE.lastIndex = 0;
    while ((m = PKG_RE.exec(code))) out.packages.push(...splitKeys(m[1]));
  }

  closeSections(-1, out.body ? out.body.end - 1 : lines.length);
  for (const env of envStack) out.errors.push({ line: env.start, message: `\\begin{${env.name}} never closed` });
  out.environments.sort((a, b) => a.start - b.start);
  return out;
}

/** Parse a BibTeX file into entries {key, type, line, fields}. */
function parseBib(text, relPath) {
  const entries = [];
  const errors = [];
  let i = 0;
  const lineAt = (idx) => text.slice(0, idx).split('\n').length;
  while ((i = text.indexOf('@', i)) !== -1) {
    const m = /^@\s*([a-zA-Z]+)\s*([{(])/.exec(text.slice(i, i + 64));
    if (!m) { i++; continue; }
    const type = m[1].toLowerCase();
    const openIdx = i + m[0].length - 1;
    const closeCh = m[2] === '{' ? '}' : ')';
    let depth = 0;
    let j = openIdx;
    for (; j < text.length; j++) {
      const c = text[j];
      if (c === '{' || (c === '(' && m[2] === '(')) depth++;
      else if (c === '}' || (c === ')' && closeCh === ')')) {
        depth--;
        if (depth === 0) break;
      }
    }
    const body = text.slice(openIdx + 1, j);
    const line = lineAt(i);
    if (j >= text.length) errors.push({ line, message: `Unterminated @${type} entry` });
    i = j + 1;
    if (['comment', 'preamble', 'string'].includes(type)) continue;
    const comma = body.indexOf(',');
    const key = (comma === -1 ? body : body.slice(0, comma)).trim();
    const fields = {};
    const rest = comma === -1 ? '' : body.slice(comma + 1);
    const FIELD_RE = /([a-zA-Z_-]+)\s*=\s*/g;
    let f;
    while ((f = FIELD_RE.exec(rest))) {
      const name = f[1].toLowerCase();
      let k = FIELD_RE.lastIndex;
      let val = '';
      if (rest[k] === '{') {
        const br = readBraced(rest, k);
        val = br.content;
        k = br.end + 1;
      } else if (rest[k] === '"') {
        const end = rest.indexOf('"', k + 1);
        val = rest.slice(k + 1, end === -1 ? undefined : end);
        k = end === -1 ? rest.length : end + 1;
      } else {
        const mm = /^[^,]*/.exec(rest.slice(k));
        val = mm[0].trim();
        k += mm[0].length;
      }
      FIELD_RE.lastIndex = k;
      if (['title', 'author', 'year', 'journal', 'booktitle'].includes(name)) fields[name] = val.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
    }
    if (key) entries.push({ key, type, line, fields });
  }
  return { path: relPath, kind: 'bib', entries, errors };
}

module.exports = { parseTex, parseBib, stripComment, readBraced };
