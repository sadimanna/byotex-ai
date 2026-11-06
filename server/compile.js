'use strict';
// LaTeX compilation via latexmk. Output goes to <root>/.byotex-build/ so the project stays clean.
// Hardening: -norc (a project .latexmkrc is Perl and would otherwise be executed) and
// shell_escape=f (overrides texmf.cnf, disables \write18 entirely).
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const ws = require('./workspace');
const logger = require('./logger');

const texenv = require('./texenv');

const BUILD_DIR = '.byotex-build';
const ENGINES = { pdflatex: '-pdf', xelatex: '-pdfxe', lualatex: '-pdflua' };
const TIMEOUT_MS = 180000;

let running = null;

const envWithTex = texenv.envWithTex;
const findLatexmk = () => texenv.findTool('latexmk');

/** Parse a TeX .log (with -file-line-error and max_print_line=10000, so lines aren't wrapped). */
function parseLog(logText, cwd, root) {
  const errors = [];
  const warnings = [];
  const rel = (f) => {
    const abs = path.resolve(cwd, f);
    return abs.startsWith(root + path.sep) ? ws.toPosix(path.relative(root, abs)) : f;
  };
  const lines = logText.split(/\r?\n/);
  // TeX prints "(./file.tex" when it opens a file and ")" when it closes it: track a stack
  // so warnings with only "on input line N" can be attributed to the right source file.
  const stack = [];
  const current = () => { for (let k = stack.length - 1; k >= 0; k--) if (stack[k]) return stack[k]; return null; };
  const track = (l) => {
    for (let k = 0; k < l.length; k++) {
      if (l[k] === '(') {
        const m = /^\(([^\s()]+\.(?:tex|ltx|bbl))/.exec(l.slice(k));
        stack.push(m && !/^\//.test(m[1]) || (m && m[1].startsWith(cwd)) ? m[1] : null);
      } else if (l[k] === ')') stack.pop();
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const file = current();
    track(l);
    let m = /^(.*?\.(?:tex|ltx|sty|cls|bbl)):(\d+): (.+)$/.exec(l);
    if (m) {
      // the offending source text follows on a line starting with "l.<n>"
      const ctx = lines.slice(i + 1, i + 8).find((x) => /^l\.\d+/.test(x));
      errors.push({ level: 'error', path: rel(m[1]), line: Number(m[2]), message: m[3].trim() + (ctx ? `  [${ctx.trim().slice(0, 80)}]` : '') });
      continue;
    }
    if ((m = /^! (.+)$/.exec(l)) && !errors.length) errors.push({ level: 'error', path: null, line: null, message: m[1] });
    if ((m = /^(?:LaTeX|Package (\S+)) Warning: (.+?)(?: on input line (\d+))?\.?$/.exec(l))) {
      warnings.push({ level: 'warn', path: file && m[3] ? rel(file) : null, line: m[3] ? Number(m[3]) : null, message: `${m[1] ? `[${m[1]}] ` : ''}${m[2]}` });
    } else if ((m = /^(Overfull|Underfull) \\hbox .*? at lines (\d+)--\d+/.exec(l))) {
      warnings.push({ level: 'warn', path: file ? rel(file) : null, line: Number(m[2]), message: l.trim().slice(0, 120) });
    }
  }
  return { errors, warnings: warnings.slice(0, 200) };
}

function compile(root, mainRel, engine = 'pdflatex') {
  if (running) throw ws.httpErr(409, 'A compile is already running');
  if (!ENGINES[engine]) throw ws.httpErr(400, `Unknown engine ${engine}`);
  const latexmk = findLatexmk();
  if (!latexmk) throw Object.assign(ws.httpErr(501, 'LaTeX (latexmk) was not found on this computer.'), { code: 'NO_TEX' });
  const realRoot = fs.realpathSync(root);
  const mainAbs = ws.safeResolve(realRoot, mainRel);
  if (!fs.existsSync(mainAbs)) throw ws.httpErr(404, `Not found: ${mainRel}`);
  const cwd = path.dirname(mainAbs);
  const outDir = path.join(realRoot, BUILD_DIR);
  fs.mkdirSync(outDir, { recursive: true });
  const job = path.basename(mainAbs).replace(/\.(tex|ltx)$/i, '');
  const args = [ENGINES[engine], '-norc', '-f', '-interaction=nonstopmode', '-file-line-error', '-synctex=1', `-outdir=${outDir}`, path.basename(mainAbs)];

  logger.info('latex', `$ latexmk ${args.join(' ')}  (cwd ${path.relative(realRoot, cwd) || '.'})`);
  const t0 = Date.now();
  const tail = [];
  running = new Promise((resolve) => {
    const child = spawn(latexmk, args, { cwd, env: envWithTex(), stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { logger.error('latex', `Compile timed out after ${TIMEOUT_MS / 1000}s — killed`); child.kill('SIGKILL'); }, TIMEOUT_MS);
    const pipe = (stream) => {
      // keep the last lines so a failure with no .log (e.g. perl missing) can still be explained
      let buf = '';
      stream.on('data', (d) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); logger.debug('tex', l); if (l.trim()) { tail.push(l.trim()); if (tail.length > 15) tail.shift(); } buf = buf.slice(i + 1); }
      });
      stream.on('end', () => { if (buf) logger.debug('tex', buf); });
    };
    pipe(child.stdout);
    pipe(child.stderr);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, spawnError: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code }); });
  });

  return running.then(({ code, spawnError }) => {
    running = null;
    const pdfAbs = path.join(outDir, `${job}.pdf`);
    const logAbs = path.join(outDir, `${job}.log`);
    const parsed = fs.existsSync(logAbs) ? parseLog(fs.readFileSync(logAbs, 'utf8'), cwd, realRoot) : { errors: [], warnings: [] };
    // unattributed warnings belong to the main file
    for (const w of parsed.warnings) if (!w.path) w.path = mainRel;
    for (const e of parsed.errors) if (!e.path) e.path = mainRel;
    const pdfExists = fs.existsSync(pdfAbs);
    const result = {
      ok: code === 0 && !parsed.errors.length,
      code,
      ms: Date.now() - t0,
      pdf: pdfExists ? ws.toPosix(path.relative(realRoot, pdfAbs)) : null,
      pdfMtime: pdfExists ? fs.statSync(pdfAbs).mtimeMs : null,
      errors: parsed.errors,
      warnings: parsed.warnings,
    };
    if (spawnError) result.errors.unshift({ level: 'error', path: mainRel, line: null, message: spawnError });
    else if (code !== 0 && !result.errors.length) {
      const why = tail.filter((l) => /error|not found|cannot|can't|no such|failed|fatal/i.test(l)).slice(-3).join(' | ') || tail.slice(-2).join(' | ') || 'no output';
      result.errors.push({ level: 'error', path: mainRel, line: null, message: `latexmk exited with code ${code}: ${why}` });
    }
    const summary = `${result.ok ? 'Compiled' : 'Compile FAILED'} ${mainRel} [${engine}] in ${(result.ms / 1000).toFixed(1)}s — ${result.errors.length} error(s), ${result.warnings.length} warning(s)${result.pdf ? ` → ${result.pdf}` : ', no PDF'}`;
    (result.ok ? logger.info : logger.error)('latex', summary);
    for (const e of result.errors.slice(0, 20)) logger.error('latex', `${e.path}:${e.line ?? '?'} ${e.message}`);
    return result;
  });
}

function buildPaths(root, mainRel) {
  const realRoot = fs.realpathSync(root);
  const mainAbs = ws.safeResolve(realRoot, mainRel);
  const outDir = path.join(realRoot, BUILD_DIR);
  const job = path.basename(mainAbs).replace(/\.(tex|ltx)$/i, '');
  return { realRoot, mainAbs, cwd: path.dirname(mainAbs), outDir, pdfAbs: path.join(outDir, `${job}.pdf`) };
}

function runSynctex(args) {
  return new Promise((resolve, reject) => {
    execFile(texenv.findTool('synctex') || 'synctex', args, { env: envWithTex(), timeout: 15000 }, (err, stdout) => {
      if (err && !stdout) return reject(ws.httpErr(err.code === 'ENOENT' ? 501 : 500, err.code === 'ENOENT' ? 'synctex not found (it ships with TeX Live / MacTeX)' : `synctex failed: ${err.message}`));
      resolve(stdout);
    });
  });
}

/** Source → PDF. Returns boxes [{page, x, y, h, v, W, H}] in PDF points, origin top-left. */
async function forwardSearch(root, mainRel, fileRel, line, column = 0) {
  const p = buildPaths(root, mainRel);
  if (!fs.existsSync(p.pdfAbs)) throw ws.httpErr(404, 'No compiled PDF yet — compile first');
  const src = ws.safeResolve(p.realRoot, fileRel);
  const out = await runSynctex(['view', '-i', `${line}:${column}:${src}`, '-o', p.pdfAbs, '-d', p.outDir]);
  const boxes = [];
  let cur = null;
  for (const l of out.split('\n')) {
    const m = /^(Page|x|y|h|v|W|H):(-?[\d.]+)$/.exec(l.trim());
    if (!m) continue;
    if (m[1] === 'Page') { cur = { page: Number(m[2]) }; boxes.push(cur); } else if (cur) cur[m[1]] = Number(m[2]);
  }
  return boxes;
}

/** PDF → source. x/y in PDF points from the page's top-left. */
async function inverseSearch(root, mainRel, page, x, y) {
  const p = buildPaths(root, mainRel);
  if (!fs.existsSync(p.pdfAbs)) throw ws.httpErr(404, 'No compiled PDF yet — compile first');
  const out = await runSynctex(['edit', '-o', `${page}:${x}:${y}:${p.pdfAbs}`, '-d', p.outDir]);
  const input = /^Input:(.+)$/m.exec(out);
  const line = /^Line:(-?\d+)$/m.exec(out);
  if (!input || !line) return null;
  const abs = path.resolve(input[1].trim());
  if (!abs.startsWith(p.realRoot + path.sep)) return { outside: abs };
  return { path: ws.toPosix(path.relative(p.realRoot, abs)), line: Math.max(1, Number(line[1])) };
}

module.exports = { compile, findLatexmk, parseLog, forwardSearch, inverseSearch, BUILD_DIR };
