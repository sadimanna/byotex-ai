'use strict';
// Module 2 (prompt half): wraps the user's request with project structure + targeted .tex context.
const ws = require('./workspace');

const BASE = `You are BYOTeX.AI, a meticulous LaTeX manuscript assistant running inside a local editing workstation.
The user's project files are supplied below as context. Always preserve LaTeX validity: balanced braces,
matched \\begin/\\end environments, existing macros, \\label names and citation keys. Do not invent citation
keys that are absent from the bibliography. When a statement needs a reference that is not in the bibliography,
write [[cite: <paper title or a precise description>]] in your reply (outside any edit block) so the user can look it
up and add a verified entry; inside edit blocks leave such a citation out rather than making up a key.

SCOPE: Only help with this manuscript and closely related work: LaTeX and BibTeX, document structure,
figures/tables/equations, compile errors, and academic writing (clarity, grammar, style, argument, citations).
If a request is unrelated (general knowledge, other programming, personal tasks, etc.), do not fulfil it:
briefly decline in one or two sentences and say what you can help with in this manuscript instead.`;

const EDIT_RULES = `
MODE: EDIT. When the request requires changing files, express every change as an edit block in exactly this format:

<<<<<<< EDIT path/relative/to/project.tex
(existing lines to replace, copied verbatim from the current file)
=======
(the new lines)
>>>>>>> END

Rules:
1. The text between the EDIT line and ======= must match a contiguous span of the current file exactly
   (whitespace and % comments included) and must occur only once in that file. Add neighbouring lines if needed.
2. Keep blocks minimal: just the lines that change plus enough anchor context. Use several blocks for separate changes.
3. To delete text, leave the replacement part empty. To create a new file, use a new path and leave the search part empty.
4. Only edit files shown in the context (or new files). Use the exact relative paths shown after "FILE:".
5. Do not wrap edit blocks in code fences. Start with a short plain-language summary of the change.
6. If no change is needed, say so and emit no blocks.`;

const ASK_RULES = `
MODE: ASK. Answer questions, review, and advise. Quote LaTeX where useful, but do NOT emit edit blocks.`;

function systemPrompt(mode) {
  return BASE + (mode === 'ask' ? ASK_RULES : EDIT_RULES);
}

function outline(scan) {
  const out = [];
  const walk = (secs, depth) => {
    for (const s of secs) {
      out.push(`${'  '.repeat(depth + 1)}- ${s.cmd}${s.starred ? '*' : ''}: ${s.title} [L${s.start}-${s.end}]`);
      walk(s.children, depth + 1);
    }
  };
  for (const f of Object.values(scan.files)) {
    if (f.kind === 'tex') {
      out.push(`- ${f.path} (${f.lineCount} lines${f.documentclass ? `, \\documentclass{${f.documentclass}}` : ''})`);
      walk(f.sections, 0);
    } else out.push(`- ${f.path} (${f.entries.length} BibTeX entries)`);
  }
  return out.join('\n');
}

/**
 * targets: [{path, start?, end?}] — whole file when start/end omitted.
 * Returns {text, included:[{path,start,end,chars}], truncated}
 */
function buildContext(root, scan, targets, maxChars) {
  const parts = ['## PROJECT OUTLINE', outline(scan) || '(no .tex files found)'];
  let budget = maxChars - parts.join('\n').length;
  const included = [];
  let truncated = false;

  // Whole-file targets subsume range targets for the same file.
  const whole = new Set(targets.filter((t) => !t.start).map((t) => t.path));
  const seen = new Set();
  const list = targets.filter((t) => {
    const k = `${t.path}:${t.start || ''}-${t.end || ''}`;
    if (seen.has(k) || (t.start && whole.has(t.path))) return false;
    seen.add(k);
    return true;
  });

  if (list.length) parts.push('', '## CONTEXT FILES');
  for (const t of list) {
    let file;
    try {
      file = ws.readText(root, t.path);
    } catch (e) {
      parts.push(`### FILE: ${t.path}\n(unreadable: ${e.message})`);
      continue;
    }
    const all = file.content.replace(/\r\n/g, '\n').split('\n');
    const start = t.start ? Math.max(1, t.start) : 1;
    const end = t.end ? Math.min(all.length, t.end) : all.length;
    let body = all.slice(start - 1, end).join('\n');
    const header = t.start
      ? `### FILE: ${t.path}  (EXCERPT lines ${start}-${end} of ${all.length}${t.label ? ` — ${t.label}` : ''})`
      : `### FILE: ${t.path}  (full file, ${all.length} lines)`;
    if (body.length > budget) {
      body = body.slice(0, Math.max(0, budget)) + '\n%% …[context truncated by BYOTeX.AI]';
      truncated = true;
    }
    parts.push(header, `----- BEGIN ${t.path} -----`, body, `----- END ${t.path} -----`, '');
    budget -= body.length + header.length + 60;
    included.push({ path: t.path, start, end, chars: body.length });
    if (budget <= 0) { truncated = true; break; }
  }

  const keys = Object.values(scan.files).filter((f) => f.kind === 'bib').flatMap((f) => f.entries.map((e) => e.key));
  if (keys.length && budget > 200) {
    const k = keys.slice(0, 400).join(', ');
    parts.push('## AVAILABLE CITATION KEYS', k.slice(0, Math.max(0, budget - 50)));
  }
  return { text: parts.join('\n'), included, truncated };
}

module.exports = { systemPrompt, buildContext };
