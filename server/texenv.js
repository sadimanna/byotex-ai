'use strict';
// Where LaTeX lives, and how to get it.
//  • A user-chosen "TeX bin folder" (Settings) is searched first, then the process PATH,
//    then the usual install locations for MacTeX / TeX Live / MiKTeX / TinyTeX.
//  • installTinyTeX() runs the official TinyTeX installer for this OS. TinyTeX is a small
//    TeX Live distribution that installs into the user's home folder without admin rights.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const logger = require('./logger');

const IS_WIN = process.platform === 'win32';
const HOME = os.homedir();

let userTexPath = '';
function setTexPath(p) { userTexPath = p || ''; }

/** TinyTeX root for this OS (where the official installer puts it). */
function tinytexRoot() {
  if (IS_WIN) return path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'TinyTeX');
  if (process.platform === 'darwin') return path.join(HOME, 'Library', 'TinyTeX');
  return path.join(HOME, '.TinyTeX');
}

/** bin/<arch> folders under a TeX Live-style root (arch name differs per OS and release). */
function archBins(root) {
  const bin = path.join(root, 'bin');
  try {
    return fs.readdirSync(bin).map((d) => path.join(bin, d)).filter((d) => fs.statSync(d).isDirectory());
  } catch {
    return [];
  }
}

function knownDirs() {
  const dirs = [];
  if (IS_WIN) {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const local = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
    dirs.push(path.join(pf, 'MiKTeX', 'miktex', 'bin', 'x64'), path.join(local, 'Programs', 'MiKTeX', 'miktex', 'bin', 'x64'));
    for (const y of ['2026', '2025', '2024', '2023']) dirs.push(...archBins(path.join('C:\\texlive', y)));
  } else {
    dirs.push('/Library/TeX/texbin', '/usr/texbin', '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin');
    for (const y of ['2026', '2025', '2024', '2023']) dirs.push(...archBins(path.join('/usr/local/texlive', y)));
  }
  dirs.push(...archBins(tinytexRoot()));
  return dirs;
}

function searchDirs() {
  // BYOTEX_TEX_ONLY_USER_PATH=1 (tests): pretend nothing is installed except the configured folder.
  if (process.env.BYOTEX_TEX_ONLY_USER_PATH === '1') return [userTexPath].filter(Boolean);
  return [userTexPath, ...(process.env.PATH || '').split(path.delimiter), ...knownDirs()].filter(Boolean);
}

function envWithTex() {
  return { ...process.env, PATH: [...new Set(searchDirs())].join(path.delimiter), shell_escape: 'f', max_print_line: '10000' };
}

/** Absolute path of a TeX tool, or null. */
function findTool(name) {
  const names = IS_WIN ? [`${name}.exe`, `${name}.bat`, `${name}.cmd`] : [name];
  for (const dir of searchDirs()) {
    for (const n of names) {
      const p = path.join(dir, n);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* keep looking */ }
    }
  }
  return null;
}

const TOOLS = ['latexmk', 'pdflatex', 'xelatex', 'lualatex', 'bibtex', 'biber', 'synctex', 'tlmgr', 'perl'];

function version(bin) {
  return new Promise((resolve) => {
    const [c, a] = IS_WIN && /\.(bat|cmd)$/i.test(bin) ? ['cmd.exe', ['/c', bin, '--version']] : [bin, ['--version']];
    execFile(c, a, { env: envWithTex(), timeout: 8000 }, (err, stdout) => resolve(err && !stdout ? null : String(stdout).split('\n')[0].trim()));
  });
}

async function status() {
  const tools = {};
  for (const t of TOOLS) tools[t] = findTool(t);
  return {
    platform: process.platform,
    texPath: userTexPath,
    tools,
    pdflatexVersion: tools.pdflatex ? await version(tools.pdflatex) : null,
    ready: !!(tools.latexmk && tools.pdflatex),
    tinytexRoot: tinytexRoot(),
    install: installState,
    manual: manualOptions(),
  };
}

/** Full distributions need admin rights, so they're offered as commands to run yourself. */
function manualOptions() {
  if (process.platform === 'darwin') {
    return [
      { name: 'MacTeX (full, ~6 GB)', how: 'brew install --cask mactex-no-gui', url: 'https://www.tug.org/mactex/' },
      { name: 'BasicTeX (small)', how: 'brew install --cask basictex && sudo tlmgr install latexmk', url: 'https://www.tug.org/mactex/morepackages.html' },
    ];
  }
  if (IS_WIN) {
    return [
      { name: 'MiKTeX', how: 'winget install MiKTeX.MiKTeX', url: 'https://miktex.org/download' },
      { name: 'TeX Live (full)', how: 'Download install-tl-windows.exe', url: 'https://www.tug.org/texlive/windows.html' },
    ];
  }
  return [
    { name: 'TeX Live (Debian/Ubuntu)', how: 'sudo apt install texlive-latex-extra texlive-bibtex-extra latexmk', url: 'https://www.tug.org/texlive/' },
    { name: 'TeX Live (Fedora)', how: 'sudo dnf install texlive-scheme-medium latexmk', url: 'https://www.tug.org/texlive/' },
  ];
}

// ---- TinyTeX installer --------------------------------------------------------------------
const TINYTEX = {
  unix: 'https://yihui.org/tinytex/install-bin-unix.sh',
  windows: 'https://yihui.org/tinytex/install-bin-windows.bat',
};
let installState = { running: false, done: false, ok: null, message: '', startedAt: null, binDir: null };

function installCommand() {
  if (process.env.BYOTEX_TEX_INSTALL_DRYRUN === '1') {
    // Test hook: exercise the whole flow without downloading anything.
    return IS_WIN ? ['cmd.exe', ['/c', 'echo [dry run] would install TinyTeX']] : ['sh', ['-c', 'echo "[dry run] would run the TinyTeX installer"; sleep 1; echo done']];
  }
  if (IS_WIN) {
    const ps = `$ErrorActionPreference='Stop'; $f = Join-Path $env:TEMP 'install-bin-windows.bat'; Invoke-WebRequest -UseBasicParsing '${TINYTEX.windows}' -OutFile $f; & cmd.exe /c $f`;
    return ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps]];
  }
  const fetchCmd = `if command -v curl >/dev/null 2>&1; then curl -fsSL '${TINYTEX.unix}'; else wget -qO- '${TINYTEX.unix}'; fi`;
  return ['sh', ['-c', `set -e; ${fetchCmd} | sh`]];
}

function run(cmd, args, tag) {
  return new Promise((resolve) => {
    logger.info(tag, `$ ${cmd} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
    // The installer needs the normal system tools (sh, curl, powershell), so use the plain environment.
    const viaCmd = IS_WIN && /\.(bat|cmd)$/i.test(cmd);
    const opts = { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] };
    const child = viaCmd ? spawn('cmd.exe', ['/c', cmd, ...args], opts) : spawn(cmd, args, opts);
    const pipe = (s) => {
      let buf = '';
      s.on('data', (d) => {
        buf += d.toString();
        let i;
        while ((i = buf.search(/[\r\n]/)) >= 0) { const l = buf.slice(0, i).trim(); if (l) logger.info(tag, l); buf = buf.slice(i + 1); }
      });
      s.on('end', () => { if (buf.trim()) logger.info(tag, buf.trim()); });
    };
    pipe(child.stdout);
    pipe(child.stderr);
    child.on('error', (e) => resolve({ code: -1, error: e.message }));
    child.on('close', (code) => resolve({ code }));
  });
}

/** Start the install in the background. onDone(binDir) is called after a successful install. */
function installTinyTeX(onDone) {
  if (installState.running) throw Object.assign(new Error('An installation is already running'), { status: 409 });
  installState = { running: true, done: false, ok: null, message: 'Downloading and installing TinyTeX…', startedAt: new Date().toISOString(), binDir: null };
  logger.info('install', `Installing TinyTeX into ${tinytexRoot()} (no admin rights needed). Output follows.`);
  (async () => {
    const [cmd, args] = installCommand();
    const r = await run(cmd, args, 'install');
    if (r.code !== 0) {
      installState = { ...installState, running: false, done: true, ok: false, message: `Installer failed (${r.error || `exit code ${r.code}`}). See the log for details.` };
      logger.error('install', installState.message);
      return;
    }
    const binDir = archBins(tinytexRoot())[0] || null;
    const dry = process.env.BYOTEX_TEX_INSTALL_DRYRUN === '1';
    if (binDir && !dry) {
      // TinyTeX's base set doesn't always include latexmk; make sure it's there.
      const tlmgr = path.join(binDir, IS_WIN ? 'tlmgr.bat' : 'tlmgr');
      if (!fs.existsSync(path.join(binDir, IS_WIN ? 'latexmk.exe' : 'latexmk'))) await run(tlmgr, ['install', 'latexmk'], 'install');
    }
    setTexPath(binDir || userTexPath);
    const ok = dry || !!findTool('latexmk');
    installState = {
      ...installState,
      running: false,
      done: true,
      ok,
      binDir,
      message: ok ? `TinyTeX is installed${binDir ? ` (${binDir})` : ''}. You can compile now.` : 'The installer finished, but latexmk was not found afterwards. See the log.',
    };
    (ok ? logger.info : logger.error)('install', installState.message);
    if (ok && onDone) onDone(binDir);
  })();
  return installState;
}

module.exports = { setTexPath, envWithTex, findTool, status, installTinyTeX, tinytexRoot, IS_WIN };
