import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { paths, readJSON, writeJSON } from './paths.js';

// Commandes que les agents peuvent lancer sans te demander.
// Les modifications de fichiers dans leur dossier isolé sont toujours acceptées.
export const DEFAULT_ALLOW = [
  'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git add:*)',
  'Bash(git commit:*)', 'Bash(git branch:*)', 'Bash(git merge:*)', 'Bash(git restore:*)', 'Bash(git stash:*)',
  'Bash(ls:*)', 'Bash(pwd)', 'Bash(cat:*)', 'Bash(head:*)', 'Bash(tail:*)', 'Bash(wc:*)', 'Bash(mkdir:*)',
  'Bash(touch:*)', 'Bash(which:*)', 'Bash(node --version)', 'Bash(npm --version)',
  'Bash(npm install:*)', 'Bash(npm ci:*)', 'Bash(npm test:*)', 'Bash(npm run test:*)', 'Bash(npm run lint:*)',
  'Bash(npm run build:*)', 'Bash(npm run typecheck:*)', 'Bash(npm run format:*)', 'Bash(npx tsc:*)',
  'Bash(npx eslint:*)', 'Bash(npx prettier:*)', 'Bash(npx vitest:*)', 'Bash(npx jest:*)',
  'Bash(pnpm install:*)', 'Bash(pnpm test:*)', 'Bash(pnpm run:*)', 'Bash(yarn install:*)', 'Bash(yarn test:*)',
  'Bash(bun install:*)', 'Bash(bun test:*)', 'Bash(pytest:*)', 'Bash(python -m pytest:*)', 'Bash(python3 -m pytest:*)',
  'Bash(ruff:*)', 'Bash(go test:*)', 'Bash(go build:*)', 'Bash(go vet:*)', 'Bash(cargo test:*)', 'Bash(cargo build:*)',
  'Bash(cargo check:*)', 'Bash(swift build:*)', 'Bash(swift test:*)',
];

export const DEFAULT_CONFIG = {
  maxParallel: 2,
  autoValidate: false,
  model: '',
  permissionMode: 'acceptEdits',
  allow: [],
  notifications: { native: 'auto', sound: true },
  openAs: 'app',
  claudePath: '',
  assistant: { model: '', mcpServers: {}, autoAllowReads: true },
  routines: [],
};

let cache = null;

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])
      ? merge(base[k], v)
      : v;
  }
  return out;
}

export function getConfig() {
  if (!cache) cache = merge(DEFAULT_CONFIG, readJSON(paths.config, {}));
  return cache;
}

export function updateConfig(patch) {
  const next = merge(getConfig(), patch);
  next.maxParallel = Math.max(1, Math.min(8, Number(next.maxParallel) || 2));
  if (Array.isArray(patch?.routines)) next.routines = patch.routines;
  if (Array.isArray(patch?.allow)) next.allow = patch.allow;
  writeJSON(paths.config, next);
  cache = next;
  return next;
}

/** Trouve l'exécutable `claude` installé, pour réutiliser ta version et ta connexion. */
export function findClaude() {
  const cfg = getConfig();
  if (cfg.claudePath && fs.existsSync(cfg.claudePath)) return cfg.claudePath;
  const home = os.homedir();
  const candidates = [
    path.join(home, '.local/bin/claude'),
    path.join(home, '.claude/local/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    path.join(home, '.npm-global/bin/claude'),
    path.join(home, '.bun/bin/claude'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const p = execFileSync(shell, ['-lc', 'command -v claude'], { encoding: 'utf8', timeout: 4000 }).trim();
    if (p && fs.existsSync(p)) return p;
  } catch {}
  return null; // le SDK utilisera son exécutable intégré
}
