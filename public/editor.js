// BYOTeX.AI editor: CodeMirror 6 with LaTeX highlighting, find/replace, bracket matching, soft wrap and
// project-aware autocomplete. It replaces the plain <textarea> behind a small adapter with the same
// interface the rest of the app already uses (value, selectionStart, setSelectionRange, events, …).
// If this module fails to load, app.js simply keeps using the textarea.
import { EditorState, Compartment } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection,
  dropCursor, rectangularSelection, highlightActiveLine,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches, openSearchPanel } from '@codemirror/search';
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap, startCompletion } from '@codemirror/autocomplete';
import { StreamLanguage, syntaxHighlighting, HighlightStyle, bracketMatching, indentOnInput } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { stex } from '@codemirror/legacy-modes/mode/stex';

// ---- look ------------------------------------------------------------------------------------
const latexHighlight = HighlightStyle.define([
  { tag: t.tagName, color: '#000080', fontWeight: 'bold' }, // \commands
  { tag: t.keyword, color: '#800080' }, // math shifts, special
  { tag: t.atom, color: '#006060' }, // environment names / arguments
  { tag: t.comment, color: '#5a5a5a', fontStyle: 'italic' },
  { tag: t.number, color: '#800000' },
  { tag: t.bracket, color: '#404040' },
  { tag: t.invalid, color: '#c00000' },
]);

const win98Theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: '#fff', color: 'var(--ed-fg)', fontSize: 'var(--ed-fs)' },
  '.cm-scroller': { fontFamily: 'var(--ed-font)', lineHeight: 'var(--ed-lh)', overflow: 'auto' },
  '.cm-content': { fontWeight: 'var(--ed-fw)', caretColor: '#000', padding: '2px 0' },
  '.cm-gutters': { backgroundColor: 'var(--face)', color: 'var(--muted-fg)', borderRight: '1px solid var(--shadow)' },
  '.cm-activeLineGutter': { backgroundColor: '#d4d4d4' },
  '.cm-activeLine': { backgroundColor: '#f3f3ff' },
  '&.cm-focused': { outline: 'none' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: '#b8c4ff' },
  '.cm-selectionMatch': { backgroundColor: '#e4e4b0' },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: '#c8f0c8', outline: '1px solid #008000' },
  '&.cm-focused .cm-nonmatchingBracket': { backgroundColor: '#ffd0d0' },
  '.cm-searchMatch': { backgroundColor: '#ffff80', outline: '1px solid #a0a000' },
  '.cm-searchMatch-selected': { backgroundColor: '#ffb040' },
  '.cm-tooltip': { border: '1px solid #000', backgroundColor: '#ffffe1', borderRadius: '0' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: '#000080', color: '#fff' },
  '.cm-completionDetail': { fontStyle: 'normal', color: '#606060', marginLeft: '1em' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected] .cm-completionDetail': { color: '#d0d0ff' },
});

// ---- autocomplete ----------------------------------------------------------------------------
const COMMANDS = `section subsection subsubsection paragraph chapter part label ref eqref autoref cref Cref pageref cite citep citet
textbf textit emph texttt textsc underline footnote url href includegraphics caption centering item usepackage documentclass
input include newcommand renewcommand begin end frac dfrac sqrt sum prod int oint lim infty partial nabla cdot cdots ldots times
leq geq neq approx equiv sim propto in notin subset subseteq cup cap forall exists mathbb mathcal mathrm mathbf mathit operatorname
left right big Big alpha beta gamma delta epsilon varepsilon theta lambda mu sigma tau phi varphi omega Gamma Delta Theta Lambda
Sigma Phi Omega hline toprule midrule bottomrule multicolumn multirow vspace hspace newline noindent maketitle tableofcontents
bibliography bibliographystyle printbibliography addbibresource appendix today title author date thanks quad qquad text`.split(/\s+/);
const ENVS = `document abstract figure figure* table table* tabular tabular* equation equation* align align* gather gather* multline
split cases itemize enumerate description theorem lemma corollary proposition definition remark proof center minipage verbatim
quote quotation algorithm algorithmic matrix pmatrix bmatrix subfigure frame`.split(/\s+/);

/** Text after the last "{" or "," before the cursor → where a key/label being typed starts. */
function argStart(m) {
  const inner = m.text.slice(m.text.lastIndexOf('{') + 1);
  const afterComma = inner.slice(inner.lastIndexOf(',') + 1);
  const lead = afterComma.length - afterComma.trimStart().length;
  return m.to - afterComma.length + lead;
}

function latexCompletions(ctx) {
  const data = typeof window.BYOTeXCompletionData === 'function' ? window.BYOTeXCompletionData() : { labels: [], cites: [] };
  let m = ctx.matchBefore(/\\(?:ref|eqref|autoref|pageref|cref|Cref|vref|nameref|labelcref)\{[^}]*$/);
  if (m) return { from: argStart(m), options: data.labels.map((l) => ({ label: l.name, detail: l.detail, type: 'variable' })), validFor: /^[^},\s]*$/ };
  m = ctx.matchBefore(/\\(?:no)?cite[a-zA-Z]*\*?(?:\[[^\]]*\]){0,2}\{[^}]*$/);
  if (m) return { from: argStart(m), options: data.cites.map((c) => ({ label: c.key, detail: c.detail, type: 'text' })), validFor: /^[^},\s]*$/ };
  m = ctx.matchBefore(/\\begin\{[a-zA-Z*]*$/);
  if (m) {
    return {
      from: m.from + m.text.indexOf('{') + 1,
      validFor: /^[a-zA-Z*]*$/,
      options: ENVS.map((env) => ({
        label: env,
        type: 'type',
        detail: 'environment',
        apply: (view, _c, from, to) => {
          const line = view.state.doc.lineAt(from);
          const indent = /^\s*/.exec(line.text)[0];
          const closeBrace = view.state.sliceDoc(to, to + 1) === '}' ? 1 : 0; // closeBrackets may have added it
          const insert = `${env}}\n${indent}  \n${indent}\\end{${env}}`;
          view.dispatch({ changes: { from, to: to + closeBrace, insert }, selection: { anchor: from + env.length + 2 + indent.length + 2 } });
        },
      })),
    };
  }
  m = ctx.matchBefore(/\\end\{[a-zA-Z*]*$/);
  if (m) return { from: m.from + m.text.indexOf('{') + 1, options: ENVS.map((e) => ({ label: e, type: 'type' })), validFor: /^[a-zA-Z*]*$/ };
  m = ctx.matchBefore(/\\[a-zA-Z]*$/);
  if (m && (m.text.length > 1 || ctx.explicit)) return { from: m.from, options: COMMANDS.map((c) => ({ label: `\\${c}`, type: 'keyword' })), validFor: /^\\[a-zA-Z]*$/ };
  return null;
}

// ---- editor + adapter ------------------------------------------------------------------------
const host = document.getElementById('edBody');
const textarea = document.getElementById('code');
const cmHost = document.createElement('div');
cmHost.className = 'cm-host';
host.insertBefore(cmHost, textarea);

const editable = new Compartment();
const wrapping = new Compartment();
let isEditable = false;
let isWrapped = true;
let silent = false; // programmatic loads don't count as user edits
const listeners = { input: [], scroll: [], keyup: [], click: [], keydown: [] };
const emit = (type, ev) => listeners[type].forEach((f) => f(ev || new Event(type)));

const extensions = () => [
  lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), drawSelection(), dropCursor(),
  EditorState.allowMultipleSelections.of(true), indentOnInput(), bracketMatching(), closeBrackets(),
  autocompletion({ override: [latexCompletions], activateOnTyping: true, icons: false }),
  rectangularSelection(), highlightActiveLine(), highlightSelectionMatches(),
  keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
  StreamLanguage.define(stex),
  EditorState.languageData.of(() => [{ closeBrackets: { brackets: ['{', '[', '('] } }]), // no quote pairing in prose
  syntaxHighlighting(latexHighlight),
  win98Theme,
  editable.of([EditorView.editable.of(isEditable), EditorState.readOnly.of(!isEditable)]),
  wrapping.of(isWrapped ? EditorView.lineWrapping : []),
  EditorView.updateListener.of((u) => {
    if (u.docChanged && !silent) emit('input');
    if (u.selectionSet || u.docChanged) { emit('keyup'); }
  }),
];

const view = new EditorView({ parent: cmHost, state: EditorState.create({ doc: '', extensions: extensions() }) });
view.scrollDOM.addEventListener('scroll', () => emit('scroll'));
view.dom.addEventListener('click', (e) => emit('click', e));

const adapter = {
  isCM: true,
  view,
  get value() { return view.state.doc.toString(); },
  set value(v) {
    silent = true;
    view.setState(EditorState.create({ doc: v, extensions: extensions() })); // fresh undo history per file
    silent = false;
  },
  get selectionStart() { return view.state.selection.main.from; },
  get selectionEnd() { return view.state.selection.main.to; },
  setSelectionRange(a, b) {
    const len = view.state.doc.length;
    view.dispatch({ selection: { anchor: Math.min(a, len), head: Math.min(b ?? a, len) } });
  },
  /** Scroll so a position sits in the upper third of the editor. */
  revealPos(pos) { view.dispatch({ effects: EditorView.scrollIntoView(Math.min(pos, view.state.doc.length), { y: 'start', yMargin: 60 }) }); },
  setRangeText(text, a, b) { view.dispatch({ changes: { from: a, to: b, insert: text }, selection: { anchor: a + text.length }, userEvent: 'input' }); },
  focus() { view.focus(); },
  get scrollTop() { return view.scrollDOM.scrollTop; },
  set scrollTop(v) { view.scrollDOM.scrollTop = v; },
  get disabled() { return !isEditable; },
  set disabled(d) {
    isEditable = !d;
    view.dispatch({ effects: editable.reconfigure([EditorView.editable.of(isEditable), EditorState.readOnly.of(!isEditable)]) });
  },
  addEventListener(type, fn) { if (listeners[type]) listeners[type].push(fn); },
  dispatchEvent(ev) { if (listeners[ev.type]) emit(ev.type, ev); return true; },
};

window.BYOTeXEditor = {
  adapter,
  setWrap(on) { isWrapped = !!on; view.dispatch({ effects: wrapping.reconfigure(isWrapped ? EditorView.lineWrapping : []) }); },
  openSearch() { view.focus(); openSearchPanel(view); },
  complete() { view.focus(); startCompletion(view); },
};
host.classList.add('cm-active');
window.dispatchEvent(new Event('byotex-editor-ready'));
