// Mode assistant : une conversation continue avec Claude, en dehors des projets,
// qui connaît l'état de tes projets et peut utiliser tes serveurs MCP (agenda, Notion…).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { runAgent } from './agent.js';
import { broadcast, notify } from './bus.js';
import { getConfig, updateConfig } from './config.js';
import { manager } from './manager.js';
import { paths, readJSON, writeJSON, ensureDir } from './paths.js';

const HISTORY = path.join(paths.assistantDir, 'history.json');
const MEMORY = path.join(paths.assistantDir, 'MEMOIRE.md');
const MAX_MESSAGES = 300;
// Préfixe ajouté aux messages dictés au micro : la réponse sera lue à voix haute dans le navigateur.
export const VOICE_HINT =
  "[Message dicté au micro. Ta réponse sera lue à voix haute : réponds en une à quatre phrases parlées, naturelles, sans Markdown, liste, tableau, lien ni bloc de code. Si un détail technique est nécessaire, dis qu'il est affiché à l'écran.]";

class Assistant {
  constructor() {
    this.data = readJSON(HISTORY, { sessionId: null, messages: [], cost: 0, routineRuns: {} });
    this.busy = false;
    this.queue = [];
    this.abort = null;
    this.live = null; // message assistant en cours de rédaction
  }

  init() {
    ensureDir(paths.assistantDir);
    if (!fs.existsSync(MEMORY)) {
      fs.writeFileSync(MEMORY, "# Mémoire de l'assistant\n\nNotes durables sur l'utilisateur, ses préférences et ses projets.\n");
    }
    setInterval(() => this.checkRoutines(), 30_000).unref();
  }

  snapshot() {
    return {
      busy: this.busy,
      queued: this.queue.length,
      messages: this.data.messages.slice(-120),
      live: this.live,
      cost: this.data.cost || 0,
      routines: getConfig().routines || [],
    };
  }

  save() {
    if (this.data.messages.length > MAX_MESSAGES) this.data.messages = this.data.messages.slice(-MAX_MESSAGES);
    writeJSON(HISTORY, this.data);
  }

  push(msg) {
    const m = { id: crypto.randomUUID(), at: Date.now(), ...msg };
    this.data.messages.push(m);
    this.save();
    broadcast('assistant-message', m);
    return m;
  }

  status() {
    broadcast('assistant-status', { busy: this.busy, queued: this.queue.length, live: this.live, cost: this.data.cost || 0 });
  }

  reset() {
    this.abort?.abort();
    this.data = { ...this.data, sessionId: null, messages: [] };
    this.save();
    broadcast('assistant-reset', this.snapshot());
  }

  stop() {
    this.abort?.abort();
  }

  send(text, { routine = null, voice = false } = {}) {
    this.push({ role: 'user', text, routine, ...(voice ? { voice: true } : {}) });
    this.queue.push({ text, routine, voice });
    this.status();
    if (!this.busy) this.drain();
  }

  async drain() {
    while (this.queue.length) {
      const { text, routine, voice } = this.queue.shift();
      this.busy = true;
      this.live = { text: '', tools: [] };
      this.abort = new AbortController();
      this.status();
      const cfg = getConfig();
      let reply = '';
      const tools = [];
      try {
        const r = await runAgent({
          cwd: paths.assistantDir,
          prompt: routine ? `[Routine programmée « ${routine} »]\n${text}` : voice ? `${VOICE_HINT}\n${text}` : text,
          resume: this.data.sessionId || undefined,
          model: cfg.assistant?.model || cfg.model || undefined,
          permissionMode: 'acceptEdits',
          allowedTools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite', 'Bash(date:*)', 'Bash(cal:*)', 'mcp__maestro__projects_status', 'mcp__maestro__project_control', 'mcp__maestro__routines'],
          systemAppend: this.systemAppend(),
          mcpServers: cfg.assistant?.mcpServers || {},
          settingSources: ['user'],
          extraTools: this.tools(),
          abort: this.abort,
          ctx: {
            projectId: null,
            stepId: '__assistant',
            label: 'Assistant',
            cwd: paths.assistantDir,
            onEvent: (e) => {
              if (e.type === 'text' && !e.sub) {
                reply = reply ? `${reply}\n\n${e.text}` : e.text;
                this.live = { text: reply, tools };
                this.status();
              } else if (e.type === 'tool' && !e.sub) {
                tools.push({ icon: e.icon, label: e.label });
                this.live = { text: reply, tools };
                this.status();
              } else if (e.type === 'error') {
                tools.push({ icon: 'error', label: e.message });
              }
            },
          },
        });
        if (r.sessionId) this.data.sessionId = r.sessionId;
        this.data.cost = (this.data.cost || 0) + (r.cost || 0);
        const finalText = r.ok ? r.text || reply : r.aborted ? `${reply}\n\n_(arrêté)_`.trim() : `⚠️ ${r.text}`;
        this.push({ role: 'assistant', text: finalText, tools, routine, cost: r.cost, ...(voice ? { voice: true } : {}) });
        if (routine) notify({ title: `Routine « ${routine} »`, body: finalText.replace(/[#*_`>]/g, '').slice(0, 180), kind: 'info' });
        else notify({ title: 'Assistant', body: finalText.replace(/[#*_`>]/g, '').slice(0, 180), kind: 'assistant' });
      } catch (e) {
        this.push({ role: 'assistant', text: `⚠️ ${e.message}`, tools });
      }
      this.busy = false;
      this.live = null;
      this.abort = null;
      this.status();
    }
  }

  systemAppend() {
    const memory = fs.existsSync(MEMORY) ? fs.readFileSync(MEMORY, 'utf8').slice(0, 8000) : '';
    const now = new Date().toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'short' });
    return [
      "# Tu es l'assistant personnel de l'utilisateur, intégré à Maestro sur son Mac",
      `Nous sommes le ${now}.`,
      "Maestro orchestre des agents Claude Code sur ses projets de code. Tu peux consulter leur état (projects_status), lancer ou mettre en pause un projet (project_control) et gérer ses routines programmées (routines).",
      "Pour le reste (agenda, notes, mails, recherches…), utilise les outils MCP disponibles. S'il en manque un, dis-lui lequel ajouter dans les réglages de Maestro.",
      `Ta mémoire durable est le fichier ${MEMORY} : relis-le si utile et ajoute-y (Edit) les informations durables qu'il te donne (préférences, contexte). N'y mets jamais de mots de passe.`,
      "Réponds en français, de façon directe et concise, en Markdown léger. Avant une action irréversible (envoyer un message, supprimer, payer), demande confirmation.",
      memory ? `\n## Mémoire actuelle\n${memory}` : '',
    ].join('\n');
  }

  tools() {
    return [
      {
        name: 'projects_status',
        description: "État de tous les projets suivis par Maestro : étapes, agents en cours, ce qui attend l'utilisateur, coût.",
        schema: {},
        handler: async () =>
          JSON.stringify(
            manager.summaries().map((p) => ({
              id: p.id,
              projet: p.title,
              dossier: p.path,
              actif: p.running,
              progression: `${p.totals.done}/${p.totals.total}`,
              coût_usd: Number(p.totals.cost.toFixed(2)),
              étapes: p.steps.map((s) => ({ id: s.id, titre: s.title, agent: s.agent, statut: s.status, activité: s.progress || s.lastActivity?.label || null })),
            })),
            null,
            1,
          ),
      },
      {
        name: 'project_control',
        description: 'Lance (start) ou met en pause (pause) un projet Maestro.',
        schema: { project_id: z.string(), action: z.enum(['start', 'pause']) },
        handler: async ({ project_id, action }) => {
          const p = manager.get(project_id);
          if (action === 'start') p.start();
          else p.pause();
          return `Projet ${p.plan.title} : ${action === 'start' ? 'lancé' : 'en pause'}.`;
        },
      },
      {
        name: 'routines',
        description:
          'Liste, ajoute ou supprime une routine programmée (une consigne exécutée automatiquement à heure fixe, ex. brief du matin). days : 1=lundi … 7=dimanche.',
        schema: {
          action: z.enum(['list', 'add', 'remove']),
          name: z.string().optional(),
          time: z.string().optional().describe('HH:MM'),
          days: z.array(z.number()).optional(),
          prompt: z.string().optional(),
        },
        handler: async ({ action, name, time, days, prompt }) => {
          const routines = getConfig().routines || [];
          if (action === 'list') return JSON.stringify(routines);
          if (action === 'add') {
            if (!name || !/^\d{1,2}:\d{2}$/.test(time || '') || !prompt) return 'Il faut name, time (HH:MM) et prompt.';
            const r = { id: crypto.randomUUID(), name, time, days: days?.length ? days : [1, 2, 3, 4, 5], prompt, enabled: true };
            updateConfig({ routines: [...routines, r] });
            broadcast('config', getConfig());
            return `Routine « ${name} » ajoutée.`;
          }
          const next = routines.filter((r) => r.name !== name && r.id !== name);
          updateConfig({ routines: next });
          broadcast('config', getConfig());
          return next.length < routines.length ? 'Supprimée.' : 'Introuvable.';
        },
      },
    ];
  }

  checkRoutines() {
    const now = new Date();
    const day = now.getDay() === 0 ? 7 : now.getDay();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const today = now.toISOString().slice(0, 10);
    for (const r of getConfig().routines || []) {
      if (!r.enabled) continue;
      const [h, m] = r.time.split(':').map(Number);
      const due = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      if (due !== hhmm || !(r.days || []).includes(day)) continue;
      if (this.data.routineRuns?.[r.id] === today) continue;
      this.data.routineRuns = { ...(this.data.routineRuns || {}), [r.id]: today };
      this.save();
      this.send(r.prompt, { routine: r.name });
    }
  }

  runRoutineNow(id) {
    const r = (getConfig().routines || []).find((x) => x.id === id);
    if (!r) throw new Error('Routine introuvable');
    this.send(r.prompt, { routine: r.name });
  }
}

export const assistant = new Assistant();
