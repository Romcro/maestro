import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export class GitError extends Error {
  constructor(message, { stdout = '', stderr = '', code } = {}) {
    super(message);
    this.stdout = stdout;
    this.stderr = stderr;
    this.code = code;
  }
}

export function git(cwd, args, { allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
      if (err && !allowFail) {
        reject(new GitError(`git ${args.join(' ')} : ${(stderr || err.message).trim()}`, { stdout, stderr, code: err.code }));
      } else {
        resolve({ ok: !err, stdout: stdout.trim(), stderr: stderr.trim(), code: err ? err.code : 0 });
      }
    });
  });
}

export async function isRepo(dir) {
  const r = await git(dir, ['rev-parse', '--show-toplevel'], { allowFail: true });
  return r.ok;
}

export async function hasCommits(dir) {
  return (await git(dir, ['rev-parse', '--verify', 'HEAD'], { allowFail: true })).ok;
}

export async function currentBranch(dir) {
  const r = await git(dir, ['symbolic-ref', '--short', 'HEAD'], { allowFail: true });
  return r.ok ? r.stdout : null;
}

export async function headSha(dir, ref = 'HEAD') {
  return (await git(dir, ['rev-parse', ref])).stdout;
}

export async function isDirty(dir) {
  const r = await git(dir, ['status', '--porcelain']);
  return r.stdout.length > 0;
}

/** Initialise un dépôt avec un premier commit (bouton « Initialiser git » du tableau de bord). */
export async function initRepo(dir) {
  if (!(await isRepo(dir))) await git(dir, ['init', '-b', 'main']);
  if (!(await hasCommits(dir))) {
    await git(dir, ['add', '-A']);
    await git(dir, ['-c', 'user.name=Maestro', '-c', 'user.email=maestro@localhost', 'commit', '--allow-empty', '-m', 'Premier commit (Maestro)'], { allowFail: false });
  }
}

/** Crée (ou réutilise) un worktree isolé pour une étape. */
export async function addWorktree(repo, wtPath, branch, base) {
  if (fs.existsSync(path.join(wtPath, '.git'))) return { reused: true };
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  const exists = (await git(repo, ['rev-parse', '--verify', `refs/heads/${branch}`], { allowFail: true })).ok;
  if (exists) await git(repo, ['worktree', 'add', wtPath, branch]);
  else await git(repo, ['worktree', 'add', '-b', branch, wtPath, base]);
  return { reused: false };
}

export async function removeWorktree(repo, wtPath, branch, { deleteBranch = true } = {}) {
  await git(repo, ['worktree', 'remove', '--force', wtPath], { allowFail: true });
  await git(repo, ['worktree', 'prune'], { allowFail: true });
  if (deleteBranch && branch) await git(repo, ['branch', '-D', branch], { allowFail: true });
}

/** Commit de tout ce qui reste dans le worktree, sans toucher à PLAN.md (géré par Maestro). */
export async function commitAll(wtPath, message, { baseSha, planFile = 'PLAN.md' } = {}) {
  if (baseSha) {
    const changed = await git(wtPath, ['diff', '--quiet', baseSha, '--', planFile], { allowFail: true });
    if (!changed.ok) {
      const existed = await git(wtPath, ['cat-file', '-e', `${baseSha}:${planFile}`], { allowFail: true });
      if (existed.ok) await git(wtPath, ['checkout', baseSha, '--', planFile], { allowFail: true });
      else await git(wtPath, ['rm', '-f', '--cached', '--ignore-unmatch', planFile], { allowFail: true });
    }
  }
  await git(wtPath, ['add', '-A']);
  if (baseSha) {
    // Si l'agent a créé PLAN.md alors qu'il n'existait pas au départ, on ne l'inclut pas.
    const existed = await git(wtPath, ['cat-file', '-e', `${baseSha}:${planFile}`], { allowFail: true });
    if (!existed.ok) await git(wtPath, ['reset', '-q', '--', planFile], { allowFail: true });
  }
  const staged = await git(wtPath, ['diff', '--cached', '--quiet'], { allowFail: true });
  if (staged.ok) return false;
  await git(wtPath, ['-c', 'user.name=Maestro', '-c', 'user.email=maestro@localhost', 'commit', '-q', '-m', message]);
  return true;
}

/** Résumé des changements d'une branche par rapport à son point de départ. */
export async function diffSummary(wtPath, baseSha) {
  const stat = await git(wtPath, ['diff', '--numstat', baseSha], { allowFail: true });
  const untracked = await git(wtPath, ['ls-files', '--others', '--exclude-standard'], { allowFail: true });
  const files = [];
  for (const line of stat.stdout.split('\n').filter(Boolean)) {
    const [add, del, ...rest] = line.split('\t');
    files.push({ file: rest.join('\t'), add: Number(add) || 0, del: Number(del) || 0 });
  }
  for (const f of untracked.stdout.split('\n').filter(Boolean)) {
    if (!files.find((x) => x.file === f)) {
      let n = 0;
      try {
        n = fs.readFileSync(path.join(wtPath, f), 'utf8').split('\n').length;
      } catch {}
      files.push({ file: f, add: n, del: 0, untracked: true });
    }
  }
  return files;
}

export async function fileDiff(wtPath, baseSha, file) {
  const tracked = await git(wtPath, ['diff', baseSha, '--', file], { allowFail: true });
  if (tracked.stdout) return tracked.stdout;
  const r = await git(wtPath, ['diff', '--no-index', '/dev/null', file], { allowFail: true });
  return r.stdout;
}

/**
 * Fusionne la branche de l'étape dans la branche de base, dans le dossier de l'utilisateur.
 * @returns {{ ok: true } | { ok: false, reason: 'branch'|'local'|'conflict', message: string, files?: string[] }}
 */
export async function mergeBranch(repo, branch, baseBranch, message) {
  const cur = await currentBranch(repo);
  if (cur !== baseBranch) {
    return { ok: false, reason: 'branch', message: `Ton dossier est sur la branche « ${cur || 'détachée'} » au lieu de « ${baseBranch} ».` };
  }
  const r = await git(
    repo,
    ['-c', 'user.name=Maestro', '-c', 'user.email=maestro@localhost', 'merge', '--no-ff', '--no-edit', '-m', message, branch],
    { allowFail: true },
  );
  if (r.ok) return { ok: true };
  const out = `${r.stdout}\n${r.stderr}`;
  if (/would be overwritten|commit your changes or stash/i.test(out)) {
    return { ok: false, reason: 'local', message: 'Des modifications non commitées dans ton dossier bloquent la fusion. Commit ou stash-les, puis réessaie.' };
  }
  const conflicted = await git(repo, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true });
  await git(repo, ['merge', '--abort'], { allowFail: true });
  return {
    ok: false,
    reason: 'conflict',
    message: 'Conflit de fusion avec le travail déjà intégré.',
    files: conflicted.stdout.split('\n').filter(Boolean),
  };
}

/** Exclut un chemin localement (sans modifier le .gitignore du projet). */
export async function excludeLocally(repo, pattern) {
  const r = await git(repo, ['rev-parse', '--git-common-dir'], { allowFail: true });
  if (!r.ok) return;
  const dir = path.resolve(repo, r.stdout);
  const file = path.join(dir, 'info', 'exclude');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (!cur.split('\n').includes(pattern)) fs.appendFileSync(file, `${cur.endsWith('\n') || !cur ? '' : '\n'}${pattern}\n`);
}
