// Ce que Claude Code sait de ton compte sur ce Mac : skills, plugins et tâches planifiées.
// Lecture seule, dans ~/.claude (ou CLAUDE_CONFIG_DIR). Rien n'est envoyé ailleurs.
// Les routines claude.ai (cloud) et les connecteurs (Gmail…) passent par la session Claude Code elle-même :
// l'outil intégré RemoteTrigger et les connecteurs claude.ai, disponibles quand `claude` est connecté à ton compte.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/** En-tête YAML simple d'un SKILL.md : name, description (sur une ou plusieurs lignes). */
export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = {};
  if (!m) return out;
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) {
      key = kv[1];
      out[key] = /^[|>][-+]?$/.test(kv[2]) ? '' : kv[2].replace(/^(["'])(.*)\1$/, '$2');
    } else if (key && /^\s+\S/.test(line)) {
      out[key] = `${out[key]} ${line.trim()}`.trim();
    }
  }
  return out;
}

function readSkill(file, source) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const fm = parseFrontmatter(text);
    const dir = path.basename(path.dirname(file));
    return { name: fm.name || dir, description: fm.description || '', source, file };
  } catch {
    return null;
  }
}

function skillsIn(dir, source) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .map((e) => path.join(dir, e.name, 'SKILL.md'))
    .filter((f) => fs.existsSync(f))
    .map((f) => readSkill(f, source))
    .filter(Boolean);
}

/** Dossiers des plugins installés, d'après installed_plugins.json. */
function pluginDirs(base) {
  const data = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(base, 'plugins', 'installed_plugins.json'), 'utf8'));
    } catch {
      return null;
    }
  })();
  const out = [];
  for (const [key, val] of Object.entries(data?.plugins || {})) {
    for (const inst of Array.isArray(val) ? val : [val]) {
      if (inst?.installPath) out.push({ name: key.split('@')[0], dir: inst.installPath });
    }
  }
  return out;
}

/** Skills visibles par Claude Code : les tiens (~/.claude/skills) et ceux de tes plugins. */
export function listSkills() {
  const base = claudeDir();
  const skills = skillsIn(path.join(base, 'skills'), 'perso');
  for (const p of pluginDirs(base)) {
    for (const s of skillsIn(path.join(p.dir, 'skills'), `plugin ${p.name}`)) skills.push({ ...s, name: `${p.name}:${s.name}` });
  }
  const seen = new Set();
  return skills.filter((s) => !seen.has(s.name) && seen.add(s.name)).sort((a, b) => a.name.localeCompare(b.name));
}

/** Tâches planifiées créées dans l'app Claude sur ce Mac (~/.claude/scheduled-tasks), s'il y en a. */
export function listScheduledTasks() {
  return skillsIn(path.join(claudeDir(), 'scheduled-tasks'), 'app Claude').map((t) => {
    const fm = parseFrontmatter(fs.readFileSync(t.file, 'utf8'));
    return { ...t, schedule: fm.schedule || fm.cron || fm.cronExpression || null };
  });
}

/** Contenu d'un skill ou d'une tâche planifiée, par nom. */
export function readSkillContent(name, max = 8000) {
  const all = [...listSkills(), ...listScheduledTasks()];
  const n = String(name || '').toLowerCase();
  const s = all.find((x) => x.name.toLowerCase() === n) || all.find((x) => x.name.toLowerCase().endsWith(`:${n}`)) || all.find((x) => x.name.toLowerCase().includes(n));
  if (!s) return null;
  const text = fs.readFileSync(s.file, 'utf8');
  return { ...s, content: text.length > max ? `${text.slice(0, max)}\n…(tronqué)` : text };
}

// Lecture sans demande d'autorisation pour l'assistant : uniquement ce qui ne modifie ni n'envoie rien.
const READ_VERB = /^(search|get|list|read|fetch|find|query|lookup|view|show)(_|[A-Z]|$)/i;
const WRITE_WORD = /(send|delete|create|update|upsert|write|modify|trash|remove|archive)/i;
const REMOTE_READ = ['list', 'get', 'list_runs', 'get_run_log'];

export function isReadOnlyCall(toolName, input = {}) {
  if (toolName === 'RemoteTrigger') return REMOTE_READ.includes(input?.action);
  if (!toolName.startsWith('mcp__') || toolName.startsWith('mcp__maestro__')) return false;
  const tool = toolName.split('__').slice(2).join('__');
  return READ_VERB.test(tool) && !WRITE_WORD.test(tool.replace(READ_VERB, ''));
}
