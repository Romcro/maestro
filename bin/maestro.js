#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HOME, PORT, HOST, paths, ensureDir } from '../src/paths.js';
import { PLAN_TEMPLATE } from '../src/plan.js';

const SELF = fileURLToPath(import.meta.url);
const BASE = `http://${HOST}:${PORT}`;
const LABEL = 'com.maestro.agents';
const REPO_DIR = path.resolve(path.dirname(SELF), '..');
const REPO_URL = process.env.MAESTRO_REPO || 'https://github.com/Romcro/maestro.git';
const PLIST = path.join(os.homedir(), 'Library/LaunchAgents', `${LABEL}.plist`);

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  violet: (s) => `\x1b[35m${s}\x1b[0m`,
};

const token = () => (fs.existsSync(paths.token) ? fs.readFileSync(paths.token, 'utf8').trim() : '');

async function api(method, route, body) {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Maestro-Token': token() },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function health() {
  try {
    const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(800) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

async function ensureServer() {
  if (await health()) return;
  ensureDir(HOME);
  const out = fs.openSync(paths.log, 'a');
  const child = spawn(process.execPath, [SELF, 'serve'], { detached: true, stdio: ['ignore', out, out], env: process.env });
  child.unref();
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 150));
    if (await health()) return;
  }
  throw new Error(`Le serveur Chlamyd.I.A. ne démarre pas. Regarde ${paths.log}`);
}

/**
 * Ouvre le tableau de bord. Par défaut dans une fenêtre d'application (sans barre d'onglets)
 * si Chrome, Edge ou Brave est installé ; sinon dans ton navigateur par défaut.
 */
function openDashboard(hash = '') {
  const target = withTokenUrl(hash);
  console.log(c.dim(`  Adresse (pour le Simple Browser de VS Code) : ${target}`));
  if (process.platform !== 'darwin') return;
  if (readCfg().openAs !== 'browser') {
    for (const b of ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium']) {
      if (fs.existsSync(`/Applications/${b}.app`)) {
        execFile('open', ['-na', b, '--args', `--app=${target}`], () => {});
        return;
      }
    }
  }
  execFile('open', [target], () => {});
}

function withTokenUrl(hash) {
  // Le jeton passe dans le fragment (#) : il n'est jamais envoyé dans les journaux réseau.
  const h = hash ? hash.replace(/^#/, '') : '/';
  return `${BASE}/#${h}${h.includes('?') ? '&' : '?'}t=${encodeURIComponent(token())}`;
}

function readCfg() {
  try {
    return JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  } catch {
    return {};
  }
}

function findPlan(dir) {
  return ['PLAN.md', 'plan.md', 'Plan.md', 'ROADMAP.md'].map((n) => path.join(dir, n)).find((p) => fs.existsSync(p));
}

const commands = {
  async default(args) {
    const dir = path.resolve(args[0] || process.cwd());
    if (dir === os.homedir() || dir === '/') {
      // Lancé depuis le dossier personnel : on ouvre simplement le tableau de bord.
      console.log(c.dim("  Tu es dans ton dossier personnel : j'ouvre le tableau de bord sans y ajouter de projet."));
      console.log(c.dim('  Pour ajouter un projet : cd chemin/du/projet && maestro'));
      return commands.open();
    }
    await ensureServer();
    const p = await api('POST', '/api/projects', { path: dir });
    const plan = findPlan(dir);
    console.log(`${c.violet('◆ Chlamyd.I.A.')}  ${c.bold(p.title)}  ${c.dim(dir)}`);
    if (!plan) console.log(c.dim('  Pas encore de PLAN.md : crée-le depuis le tableau de bord, ou lance `maestro init`.'));
    else console.log(c.dim(`  ${p.totals.done}/${p.totals.total} étapes terminées · tableau de bord : ${BASE}`));
    openDashboard(`#/p/${p.id}`);
  },

  async serve() {
    const { startServer } = await import('../src/server.js');
    await startServer();
  },

  async open() {
    await ensureServer();
    openDashboard('#/');
  },

  async init(args) {
    const dir = path.resolve(args[0] || process.cwd());
    const existing = findPlan(dir);
    if (existing) {
      console.log(`Plan déjà présent : ${existing}`);
    } else {
      fs.writeFileSync(path.join(dir, 'PLAN.md'), PLAN_TEMPLATE.replace('# Mon projet', `# ${path.basename(dir)}`));
      console.log(c.green(`PLAN.md créé dans ${dir}`));
    }
    await commands.default([dir]);
  },

  async status() {
    if (!(await health())) return console.log(c.dim('Chlamyd.I.A. ne tourne pas.'));
    const s = await api('GET', '/api/state');
    console.log(`${c.violet('◆ Chlamyd.I.A.')} ${s.version}  ${BASE}`);
    for (const p of s.projects) {
      console.log(`  ${p.running ? c.green('●') : c.dim('○')} ${c.bold(p.title)}  ${p.totals.done}/${p.totals.total}  ${c.dim(`$${p.totals.cost.toFixed(2)}`)}`);
      for (const st of p.steps.filter((x) => !['done', 'blocked', 'ready'].includes(x.status))) {
        console.log(`      ${st.status.padEnd(11)} ${st.id}. ${st.title}`);
      }
    }
    if (s.inbox.length) console.log(c.bold(`\n  ${s.inbox.length} élément(s) attendent ta réponse.`));
  },

  async stop() {
    if (!(await health())) return console.log(c.dim('Chlamyd.I.A. ne tourne pas.'));
    await api('POST', '/api/shutdown');
    console.log('Chlamyd.I.A. arrêté.');
  },

  async service(args) {
    if (process.platform !== 'darwin') return console.log('Disponible uniquement sur macOS.');
    if (args[0] === 'uninstall') {
      try { execFileSync('launchctl', ['unload', PLIST]); } catch {}
      if (fs.existsSync(PLIST)) fs.unlinkSync(PLIST);
      return console.log('Chlamyd.I.A. ne démarrera plus automatiquement.');
    }
    if (await health()) await api('POST', '/api/shutdown').catch(() => {});
    const shellPath = (() => {
      try { return execFileSync(process.env.SHELL || '/bin/zsh', ['-lc', 'echo $PATH'], { encoding: 'utf8' }).trim(); } catch { return process.env.PATH; }
    })();
    ensureDir(path.dirname(PLIST));
    fs.writeFileSync(
      PLIST,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${process.execPath}</string><string>${SELF}</string><string>serve</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${shellPath}</string></dict>
  <key>StandardOutPath</key><string>${paths.log}</string>
  <key>StandardErrorPath</key><string>${paths.log}</string>
</dict></plist>
`,
    );
    try { execFileSync('launchctl', ['unload', PLIST], { stdio: 'ignore' }); } catch {}
    execFileSync('launchctl', ['load', PLIST]);
    console.log(c.green('Chlamyd.I.A. démarrera automatiquement à chaque ouverture de session.'));
  },

  async update() {
    // Avec stdio: 'inherit', execFileSync renvoie null : d'où le ?? ''.
    const run = (cmd, args, opts = {}) => (execFileSync(cmd, args, { cwd: REPO_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }) ?? '').trim();
    const tryRun = (cmd, args) => { try { return run(cmd, args); } catch { return null; } };
    console.log(`${c.violet('◆ Chlamyd.I.A.')} — mise à jour`);

    // Installation depuis un zip : on relie le dossier au dépôt GitHub.
    if (!fs.existsSync(path.join(REPO_DIR, '.git'))) {
      console.log(c.dim('  Ce dossier vient d\'un zip : je le relie à GitHub…'));
      run('git', ['init', '-q', '-b', 'main']);
      run('git', ['remote', 'add', 'origin', REPO_URL]);
    }
    const before = tryRun('git', ['rev-parse', 'HEAD']);
    try {
      run('git', ['fetch', '-q', 'origin', 'main'], { stdio: ['ignore', 'pipe', 'inherit'] });
    } catch {
      throw new Error("Impossible de joindre GitHub. Si le dépôt est privé, connecte-toi d'abord : brew install gh && gh auth login");
    }
    const after = run('git', ['rev-parse', 'origin/main']);
    if (before === after) return console.log(c.green('  Déjà à jour.'));

    const pkgBefore = fs.readFileSync(path.join(REPO_DIR, 'package.json'), 'utf8');
    if (before) {
      const dirty = run('git', ['status', '--porcelain', '--untracked-files=no']);
      if (dirty) throw new Error(`Tu as modifié des fichiers de Maestro à la main :\n${dirty}\nCommit-les ou annule-les (git -C ${REPO_DIR} stash), puis relance maestro update.`);
      const log = tryRun('git', ['log', '--oneline', '--no-decorate', `${before}..${after}`]);
      run('git', ['merge', '--ff-only', '-q', after]);
      if (log) console.log(log.split('\n').map((l) => `  ${c.dim('•')} ${l.replace(/^\w+ /, '')}`).join('\n'));
    } else {
      // Premier rattachement : les fichiers du zip sont remplacés par ceux du dépôt.
      run('git', ['reset', '-q', '--hard', after]);
      run('git', ['branch', '-q', '--set-upstream-to=origin/main', 'main']);
    }

    const pkgAfter = fs.readFileSync(path.join(REPO_DIR, 'package.json'), 'utf8');
    if (pkgAfter !== pkgBefore || !fs.existsSync(path.join(REPO_DIR, 'node_modules'))) {
      console.log(c.dim('  Mise à jour des dépendances…'));
      run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], { stdio: 'inherit' });
    }

    const version = JSON.parse(pkgAfter).version;
    if (await health()) {
      console.log(c.dim('  Redémarrage de Chlamyd.I.A. (les agents en cours seront à reprendre d\'un clic)…'));
      await api('POST', '/api/shutdown').catch(() => {});
      await new Promise((r) => setTimeout(r, 600));
      if (process.platform === 'darwin' && fs.existsSync(PLIST)) {
        try { execFileSync('launchctl', ['unload', PLIST], { stdio: 'ignore' }); } catch {}
        execFileSync('launchctl', ['load', PLIST]);
      } else {
        // On relance avec la nouvelle version du fichier.
        const out = fs.openSync(paths.log, 'a');
        spawn(process.execPath, [SELF, 'serve'], { detached: true, stdio: ['ignore', out, out] }).unref();
      }
    }
    console.log(c.green(`  Chlamyd.I.A. est à jour (version ${version}).`));
  },

  help() {
    console.log(`${c.violet('◆ Chlamyd.I.A.')} — chef d'orchestre pour agents Claude Code

  ${c.bold('maestro')} [dossier]       Ajoute le projet et ouvre le tableau de bord
  ${c.bold('maestro init')} [dossier]  Crée un PLAN.md modèle puis ouvre le projet
  ${c.bold('maestro open')}            Ouvre le tableau de bord
  ${c.bold('maestro status')}          État des projets dans le terminal
  ${c.bold('maestro stop')}            Arrête Chlamyd.I.A. (et les agents en cours)
  ${c.bold('maestro service')}         Lance Chlamyd.I.A. automatiquement au démarrage du Mac
  ${c.bold('maestro service uninstall')}
  ${c.bold('maestro update')}          Installe la dernière version depuis GitHub
`);
  },
};

const [cmd, ...rest] = process.argv.slice(2);
const fn = cmd && commands[cmd] && cmd !== 'default' ? commands[cmd] : cmd === '-h' || cmd === '--help' ? commands.help : commands.default;
const args = commands[cmd] && cmd !== 'default' ? rest : cmd ? [cmd, ...rest] : [];
Promise.resolve().then(() => fn(args)).catch((e) => {
  console.error(c.red(`✗ ${e.message}`));
  process.exit(1);
});
