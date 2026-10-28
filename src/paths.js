import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const HOME = process.env.MAESTRO_HOME || path.join(os.homedir(), '.maestro');
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const PORT = Number(process.env.MAESTRO_PORT || 4747);
export const HOST = '127.0.0.1';

export const paths = {
  config: path.join(HOME, 'config.json'),
  projects: path.join(HOME, 'projects.json'),
  token: path.join(HOME, 'token'),
  log: path.join(HOME, 'maestro.log'),
  pid: path.join(HOME, 'maestro.pid'),
  projectDir: (id) => path.join(HOME, 'projects', id),
  worktrees: (id) => path.join(HOME, 'worktrees', id),
  assistantDir: path.join(HOME, 'assistant'),
  claudeData: path.join(HOME, 'claude'), // projets et routines rapatriés de claude.ai
};

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Écriture atomique : on écrit dans un fichier temporaire puis on renomme. */
export function writeJSON(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function slugify(str, max = 40) {
  return (
    String(str)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max)
      .replace(/-+$/g, '') || 'x'
  );
}
