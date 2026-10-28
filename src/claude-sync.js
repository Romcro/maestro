// Rapatrie dans Chlamyd.I.A. ce qui vit sur claude.ai :
// - tes projets claude.ai (instructions et documents), depuis l'export de tes données (claude.ai › Paramètres › Confidentialité) ;
// - tes routines claude.ai, lues par une courte session Claude Code (outil RemoteTrigger, en lecture seule).
// Tout est rangé dans ~/.maestro/claude/ et ne quitte pas ton Mac.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { runAgent } from './agent.js';
import { broadcast } from './bus.js';
import { getConfig, updateConfig } from './config.js';
import { isReadOnlyCall } from './claude-account.js';
import { paths, readJSON, writeJSON, ensureDir, slugify } from './paths.js';

const ROUTINES = () => path.join(paths.claudeData, 'routines.json');
const PROJECTS = () => path.join(paths.claudeData, 'projects');

// ----------------------------------------------------------------- projets claude.ai

/** Cherche projects.json dans le dossier d'export (il peut être dans un sous-dossier). */
function findProjectsFile(dir, depth = 3) {
  const direct = path.join(dir, 'projects.json');
  if (fs.existsSync(direct)) return direct;
  if (depth <= 0) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && !e.name.startsWith('.') && e.name !== '__MACOSX') {
      const f = findProjectsFile(path.join(dir, e.name), depth - 1);
      if (f) return f;
    }
  }
  return null;
}

const safeName = (name, i) => {
  const base = path.basename(String(name || '')).replace(/[^\p{L}\p{N}._ -]+/gu, '_').trim();
  return base && base !== '.' && base !== '..' ? base : `document-${i + 1}.md`;
};

/**
 * Importe les projets d'un export claude.ai : un .zip, son dossier décompressé ou projects.json.
 * Chaque projet est (ré)écrit dans ~/.maestro/claude/projects/<nom>/ : project.json + docs/.
 */
export function importClaudeExport(src) {
  const input = path.resolve(String(src || '').replace(/^~(?=$|\/)/, os.homedir()));
  if (!fs.existsSync(input)) throw Object.assign(new Error(`Fichier introuvable : ${input}`), { status: 400 });
  let tmp = null;
  let file = input;
  try {
    if (/\.zip$/i.test(input)) {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chlamydia-export-'));
      try {
        execFileSync('unzip', ['-q', '-o', input, '-d', tmp], { stdio: 'pipe' });
      } catch {
        throw Object.assign(new Error("Impossible d'ouvrir ce fichier zip."), { status: 400 });
      }
      file = findProjectsFile(tmp);
    } else if (fs.statSync(input).isDirectory()) {
      file = findProjectsFile(input);
    }
    if (!file) throw Object.assign(new Error("Aucun fichier projects.json dans cet export. Vérifie que c'est bien l'export de tes données claude.ai."), { status: 400 });
    let list;
    try {
      list = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      throw Object.assign(new Error('projects.json illisible.'), { status: 400 });
    }
    if (!Array.isArray(list)) list = list?.projects || [];
    const used = new Set();
    let docs = 0;
    const imported = [];
    for (const p of list) {
      if (!p || p.is_starter_project) continue;
      const name = String(p.name || 'Projet sans nom');
      let id = slugify(name);
      while (used.has(id)) id = `${id}-${used.size}`;
      used.add(id);
      const dir = path.join(PROJECTS(), id);
      fs.rmSync(dir, { recursive: true, force: true });
      ensureDir(path.join(dir, 'docs'));
      const files = [];
      for (const [i, d] of (p.docs || []).entries()) {
        const content = d?.content ?? d?.text ?? '';
        if (!content) continue;
        let fname = safeName(d.filename || d.file_name || d.name || d.path, i);
        while (files.includes(fname)) fname = `${i + 1}-${fname}`;
        fs.writeFileSync(path.join(dir, 'docs', fname), String(content));
        files.push(fname);
      }
      docs += files.length;
      const meta = {
        id,
        uuid: p.uuid || null,
        name,
        description: String(p.description || ''),
        instructions: String(p.prompt_template || p.instructions || p.custom_instructions || ''),
        docs: files,
        createdAt: p.created_at || null,
        updatedAt: p.updated_at || null,
        importedAt: new Date().toISOString(),
      };
      writeJSON(path.join(dir, 'project.json'), meta);
      imported.push(meta);
    }
    broadcast('claude-sync', accountSnapshot());
    return { projects: imported.length, docs, names: imported.map((p) => p.name) };
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function listClaudeProjects() {
  let ids = [];
  try {
    ids = fs.readdirSync(PROJECTS());
  } catch {
    return [];
  }
  return ids
    .map((id) => readJSON(path.join(PROJECTS(), id, 'project.json'), null))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function findProject(name) {
  const n = String(name || '').toLowerCase();
  const all = listClaudeProjects();
  return all.find((p) => p.id === n || p.name.toLowerCase() === n) || all.find((p) => p.name.toLowerCase().includes(n)) || null;
}

/** Instructions et liste des documents d'un projet, ou le contenu d'un document. */
export function readClaudeProject(name, doc, max = 12000) {
  const p = findProject(name);
  if (!p) return null;
  if (doc) {
    const d = p.docs.find((x) => x === doc) || p.docs.find((x) => x.toLowerCase().includes(String(doc).toLowerCase()));
    if (!d) return { project: p, missing: doc };
    const text = fs.readFileSync(path.join(PROJECTS(), p.id, 'docs', d), 'utf8');
    return { project: p, doc: d, content: text.length > max ? `${text.slice(0, max)}\n…(tronqué)` : text };
  }
  return { project: p };
}

/** Recherche simple dans les instructions et documents des projets importés. */
export function searchClaudeProjects(query, limit = 8) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  if (!words.length) return [];
  const hits = [];
  for (const p of listClaudeProjects()) {
    const sources = [['instructions', p.instructions], ...p.docs.map((d) => [d, fs.readFileSync(path.join(PROJECTS(), p.id, 'docs', d), 'utf8')])];
    for (const [where, text] of sources) {
      const low = text.toLowerCase();
      const score = words.reduce((s, w) => s + (low.includes(w) ? 1 : 0), 0);
      if (!score) continue;
      const at = Math.max(0, low.indexOf(words.find((w) => low.includes(w))) - 200);
      hits.push({ projet: p.name, document: where, score, extrait: text.slice(at, at + 600) });
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ----------------------------------------------------------------- routines claude.ai

const RoutineSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean().optional(),
  cron: z.string().optional(),
  schedule_fr: z.string().optional().describe('La planification en clair, en français, en heure locale.'),
  time_local: z.string().nullable().optional().describe('HH:MM en heure locale si elle tourne à heure fixe, sinon null.'),
  days: z.array(z.number()).nullable().optional().describe('Jours où elle tourne : 1=lundi … 7=dimanche.'),
  prompt: z.string().optional().describe('La consigne complète de la routine.'),
  last_run: z.string().nullable().optional(),
});

export function getClaudeRoutines() {
  return readJSON(ROUTINES(), { fetchedAt: null, routines: [], error: null });
}

let fetching = null;
export function isFetchingRoutines() {
  return !!fetching;
}

/** Lit tes routines claude.ai avec une courte session Claude Code (lecture seule) et les enregistre. */
export function fetchClaudeRoutines() {
  if (fetching) return fetching;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 180_000);
  let saved = false;
  const save = (data) => {
    saved = true;
    writeJSON(ROUTINES(), { fetchedAt: new Date().toISOString(), ...data });
  };
  broadcast('claude-sync', { ...accountSnapshot(), fetching: true });
  fetching = runAgent({
    cwd: ensureDir(paths.claudeData),
    prompt: [
      "Récupère la liste de mes routines claude.ai : appelle l'outil RemoteTrigger avec action list (et suis la pagination s'il y en a).",
      "Ne crée, ne modifie et ne lance aucune routine.",
      `Puis appelle save_routines une seule fois avec toutes les routines. L'heure locale de ce Mac est le fuseau ${tz} : convertis l'expression cron (souvent en UTC) dans ce fuseau pour schedule_fr, time_local et days.`,
      "Si l'outil RemoteTrigger n'existe pas ou échoue, appelle save_routines avec une liste vide et error expliquant pourquoi en une phrase simple.",
      'Ne réponds rien d\'autre que « Fait. ».',
    ].join('\n'),
    model: getConfig().assistant?.model || getConfig().model || undefined,
    permissionMode: 'default',
    allowedTools: ['mcp__maestro__save_routines'],
    settingSources: ['user'],
    abort,
    extraTools: [
      {
        name: 'save_routines',
        description: 'Enregistre la liste des routines claude.ai dans Chlamyd.I.A.',
        schema: { routines: z.array(RoutineSchema), error: z.string().optional() },
        handler: async ({ routines, error }) => {
          save({ routines, error: error || null });
          return `${routines.length} routine(s) enregistrée(s).`;
        },
      },
    ],
    ctx: {
      projectId: null,
      stepId: '__claude_sync',
      label: 'Synchronisation Claude',
      cwd: paths.claudeData,
      autoAllow: isReadOnlyCall,
    },
  })
    .then((r) => {
      if (!saved) save({ ...getClaudeRoutines(), error: r.aborted ? 'Délai dépassé.' : r.ok ? "Claude Code n'a renvoyé aucune routine." : r.text || 'Échec de la récupération.' });
      return getClaudeRoutines();
    })
    .catch((e) => {
      save({ ...getClaudeRoutines(), error: e.message });
      return getClaudeRoutines();
    })
    .finally(() => {
      clearTimeout(timer);
      fetching = null;
      broadcast('claude-sync', accountSnapshot());
    });
  return fetching;
}

/** Copie une routine claude.ai dans les routines de Chlamyd.I.A. (exécutée sur ton Mac par l'assistant). */
export function copyRoutineLocally(id) {
  const r = getClaudeRoutines().routines.find((x) => x.id === id);
  if (!r) throw Object.assign(new Error('Routine introuvable. Actualise la liste.'), { status: 404 });
  if (!/^\d{1,2}:\d{2}$/.test(r.time_local || '')) throw Object.assign(new Error("Cette routine ne tourne pas à une heure fixe : je ne peux pas la recopier telle quelle."), { status: 400 });
  if (!r.prompt) throw Object.assign(new Error("La consigne de cette routine n'a pas pu être lue."), { status: 400 });
  const routines = getConfig().routines || [];
  if (routines.some((x) => x.claudeId === r.id)) throw Object.assign(new Error('Cette routine est déjà copiée.'), { status: 409 });
  const local = { id: crypto.randomUUID(), name: r.name, time: r.time_local, days: r.days?.length ? r.days : [1, 2, 3, 4, 5, 6, 7], prompt: r.prompt, enabled: true, claudeId: r.id };
  const next = updateConfig({ routines: [...routines, local] });
  broadcast('config', next);
  return local;
}

export function accountSnapshot() {
  return { projects: listClaudeProjects(), routines: getClaudeRoutines(), fetching: !!fetching };
}
