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


// ---- Missing packages (tlmgr) ------------------------------------------------------------------
// "File `x.sty' not found" → which TeX Live package provides x.sty → install it (or show the command).
const MISSING_RE = /File [`'"‘]?([^`'"’\s]+\.(?:sty|cls|bst|bbx|cbx|lbx|def|fd|cfg|clo|ldf|tex))['"’]? not found/;
const archiveUrl = (year) => `https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/${year}/tlnet-final`;
const ARCHIVE_RE = /^https:\/\/ftp\.math\.utah\.edu\/pub\/tex\/historic\/systems\/texlive\/\d{4}\/tlnet-final$/;

function missingFileOf(message) {
  const m = MISSING_RE.exec(String(message || ''));
  return m ? m[1] : null;
}

/** Run tlmgr and collect its output (no streaming; used for quick queries). */
function tlmgr(args) {
  const bin = findTool('tlmgr');
  if (!bin) return Promise.resolve({ code: -1, out: '', missing: true });
  return new Promise((resolve) => {
    const [c, a] = IS_WIN && /\.(bat|cmd)$/i.test(bin) ? ['cmd.exe', ['/c', bin, ...args]] : [bin, args];
    execFile(c, a, { env: envWithTex(), timeout: 120000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code || 1 : 0, out: `${stdout || ''}\n${stderr || ''}` });
    });
  });
}

/** TeX Live root of the tlmgr in use (…/2025basic for /usr/local/texlive/2025basic/bin/<arch>/tlmgr). */
function tlRoot() {
  const bin = findTool('tlmgr');
  if (!bin) return null;
  try { return path.resolve(fs.realpathSync(bin), '..', '..', '..'); } catch { return null; }
}
function canWriteTexLive() {
  const root = tlRoot();
  if (!root) return false;
  try { fs.accessSync(path.join(root, 'texmf-dist'), fs.constants.W_OK); return true; } catch { return false; }
}

/** Which packages provide `file`? Falls back to the frozen archive when the local TeX Live is an older edition. */
async function findPackage(file) {
  if (!/^[\w.+-]+$/.test(file)) throw Object.assign(new Error('Invalid file name'), { status: 400 });
  if (!findTool('tlmgr')) {
    const miktex = findTool('miktex') || findTool('mpm');
    return { file, packages: [], noTlmgr: true, miktex: !!miktex };
  }
  let repo = null;
  let old = null;
  let r = await tlmgr(['search', '--global', '--file', `/${file}`]);
  const tooOld = /Local TeX Live \((\d{4})\) is older than remote repository \((\d{4})\)/.exec(r.out);
  if (tooOld) {
    old = { local: Number(tooOld[1]), remote: Number(tooOld[2]) };
    repo = archiveUrl(old.local);
    logger.info('tex', `Local TeX Live ${old.local} is older than the current ${old.remote}; searching the ${old.local} archive instead`);
    r = await tlmgr(['--repository', repo, 'search', '--global', '--file', `/${file}`]);
  }
  const packages = [];
  let cur = null;
  for (const line of r.out.split('\n')) {
    const head = /^([A-Za-z0-9._+-]+):\s*$/.exec(line);
    if (head) { cur = head[1]; continue; }
    if (cur && line.trim().endsWith(`/${file}`) && !packages.includes(cur)) packages.push(cur);
  }
  logger.info('tex', `${file} → ${packages.length ? packages.join(', ') : 'no package found'}`);
  const tl = findTool('tlmgr');
  return {
    file,
    packages,
    repo,
    oldRelease: old,
    writable: canWriteTexLive(),
    // what to run yourself when the TeX Live folder needs admin rights
    command: (pkg) => `${IS_WIN ? '' : 'sudo '}"${tl}" ${repo ? `--repository ${repo} ` : ''}install ${pkg}`,
    error: r.code !== 0 && !packages.length ? r.out.trim().split('\n').slice(-3).join(' ').slice(0, 300) : null,
  };
}

let pkgState = { running: false, done: false, ok: null, message: '', pkg: null };
function installPackage(pkg, repo) {
  if (!/^[A-Za-z0-9._+-]+$/.test(pkg)) throw Object.assign(new Error('Invalid package name'), { status: 400 });
  if (repo && !ARCHIVE_RE.test(repo)) throw Object.assign(new Error('Unexpected repository'), { status: 400 });
  if (pkgState.running) throw Object.assign(new Error('A package installation is already running'), { status: 409 });
  if (!canWriteTexLive()) throw Object.assign(new Error('This TeX Live folder needs administrator rights; run the shown command in a terminal.'), { status: 403, code: 'NEEDS_ADMIN' });
  const bin = findTool('tlmgr');
  pkgState = { running: true, done: false, ok: null, message: `Installing ${pkg}…`, pkg };
  (async () => {
    const r = await run(bin, [...(repo ? ['--repository', repo] : []), 'install', pkg], 'install');
    const ok = r.code === 0;
    pkgState = { running: false, done: true, ok, pkg, message: ok ? `Installed ${pkg}. Compile again to use it.` : `tlmgr install ${pkg} failed (${r.error || `exit ${r.code}`}). See the Log Console.` };
    (ok ? logger.info : logger.error)('install', pkgState.message);
  })();
  return pkgState;
}

module.exports = { setTexPath, envWithTex, findTool, status, installTinyTeX, tinytexRoot, IS_WIN, missingFileOf, findPackage, installPackage, pkgStatus: () => pkgState };
