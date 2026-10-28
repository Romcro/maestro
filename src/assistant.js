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
import { listSkills, listScheduledTasks, readSkillContent, isReadOnlyCall } from './claude-account.js';
import { listClaudeProjects, readClaudeProject, searchClaudeProjects, getClaudeRoutines } from './claude-sync.js';
import { paths, readJSON, writeJSON, ensureDir } from './paths.js';

const HISTORY = path.join(paths.assistantDir, 'history.json');
const MEMORY = path.join(paths.assistantDir, 'MEMOIRE.md');
const MAX_MESSAGES = 300;
// Préfixe ajouté aux messages dictés au micro : la réponse sera lue à voix haute dans le navigateur.
export const VOICE_HINT =
  "[Message dicté au micro. Ta réponse sera lue à voix haute : réponds en une à quatre phrases parlées, naturelles, sans Markdown, liste, tableau, lien ni bloc de code. Si un détail technique est nécessaire, dis qu'il est affiché à l'écran. Exception : s'il te demande de lui lire un mail, une newsletter ou un texte, lis-en l'essentiel en phrases parlées, sans limite de longueur, sans liens ni adresses.]";

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
          allowedTools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite', 'Skill', 'Bash(date:*)', 'Bash(cal:*)', 'mcp__maestro__projects_status', 'mcp__maestro__project_control', 'mcp__maestro__routines', 'mcp__maestro__claude_account', 'mcp__maestro__claude_projects'],
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
            // Lire (mails, routines claude.ai, notes…) sans te demander ; envoyer, créer ou supprimer passe toujours par ta boîte.
            autoAllow: cfg.assistant?.autoAllowReads === false ? null : isReadOnlyCall,
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
      "# Tu t'appelles Chlamyd.I.A. : tu es l'assistant personnel de l'utilisateur, sur son Mac",
      "Quand tu parles de toi ou de l'application, dis « Chlamyd.I.A. » (prononcé Chlamydia), jamais « Maestro ». S'il t'appelle Chlamydia à l'oral, c'est toi.",
      `Nous sommes le ${now}.`,
      "Chlamyd.I.A. orchestre des agents Claude Code sur ses projets de code. Tu peux consulter leur état (projects_status), lancer ou mettre en pause un projet (project_control) et gérer ses routines programmées (routines).",
      "Pour le reste (agenda, notes, mails, recherches…), utilise les outils MCP disponibles. S'il en manque un, dis-lui lequel ajouter dans les réglages de Chlamyd.I.A..",
      "",
      "## Son compte Claude",
      "Tu tournes dans Claude Code connecté à son compte Claude : tu as ses skills, ses connecteurs claude.ai (Gmail, Agenda… : outils mcp__claude_ai_*) et ses routines claude.ai.",
      "- Ses projets claude.ai (instructions et documents qu'il a importés dans Chlamyd.I.A.) : outil claude_projects (list, read avec name et éventuellement doc, search avec query). Quand il parle d'un de ses projets Claude, appuie-toi dessus et suis ses instructions. S'il n'y en a aucun, explique-lui qu'il peut les importer depuis la page Compte Claude.",
      "- Ses skills : outil claude_account (action skills pour la liste, skill + name pour le détail). Tu peux aussi en utiliser un avec l'outil Skill.",
      "- Ses routines et tâches planifiées : outil RemoteTrigger action list (routines claude.ai, dans le cloud), outil claude_account action scheduled (tâches de l'app Claude sur ce Mac et routines Chlamyd.I.A.). Donne pour chacune son nom, quand elle tourne et ce qu'elle fait, en clair (traduis les expressions cron en heures et jours). Ne crée, modifie ni lance une routine claude.ai sans son accord explicite.",
      "- Ses newsletters : il les génère lui-même avec ses routines claude.ai. Pour lui en lire une : RemoteTrigger action list, repère la ou les routines qui produisent une newsletter (nom ou consigne : newsletter, veille, digest, revue, brief…), puis action list_runs avec son trigger_id, prends l'exécution terminée la plus récente et récupère son contenu avec action get_run_log (session_id de l'exécution ; suis next_cursor jusqu'à la fin). La newsletter est le texte final rédigé par la routine : lis-la telle quelle, en entier, sauf s'il demande un résumé. Si la consigne de la routine dit qu'elle publie ailleurs (mail, Notion, document, fichier), va la lire à cet endroit avec l'outil correspondant. S'il a plusieurs routines de ce type, demande laquelle, ou lis la plus récente s'il dit « ma newsletter ». Note dans ta mémoire quelles routines sont ses newsletters pour ne pas chercher la prochaine fois.",
      "- S'il parle d'une newsletter reçue par mail (pas d'une routine), cherche-la dans Gmail. Ne marque rien comme lu, ne supprime et n'envoie rien.",
      "- Si un outil manque : pour les routines, Claude Code doit être connecté avec son compte claude.ai (commande claude puis /login) ; pour Gmail, il doit connecter Gmail sur claude.ai (Paramètres › Connecteurs) avec le même compte. Dis-le simplement.",
      `Ta mémoire durable est le fichier ${MEMORY} : relis-le si utile et ajoute-y (Edit) les informations durables qu'il te donne (préférences, contexte). N'y mets jamais de mots de passe.`,
      "Réponds en français, de façon directe et concise, en Markdown léger. Avant une action irréversible (envoyer un message, supprimer, payer), demande confirmation.",
      memory ? `\n## Mémoire actuelle\n${memory}` : '',
    ].join('\n');
  }

  tools() {
    return [
      {
        name: 'projects_status',
        description: "État de tous les projets suivis par Chlamyd.I.A. : étapes, agents en cours, ce qui attend l'utilisateur, coût.",
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
        description: 'Lance (start) ou met en pause (pause) un projet de Chlamyd.I.A.',
        schema: { project_id: z.string(), action: z.enum(['start', 'pause']) },
        handler: async ({ project_id, action }) => {
          const p = manager.get(project_id);
          if (action === 'start') p.start();
          else p.pause();
          return `Projet ${p.plan.title} : ${action === 'start' ? 'lancé' : 'en pause'}.`;
        },
      },
      {
        name: 'claude_projects',
        description:
          "Ses projets claude.ai importés dans Chlamyd.I.A. : action list (noms, descriptions, documents), read (instructions d'un projet par name, ou contenu d'un document avec doc), search (cherche query dans tous les documents).",
        schema: { action: z.enum(['list', 'read', 'search']), name: z.string().optional(), doc: z.string().optional(), query: z.string().optional() },
        handler: async ({ action, name, doc, query }) => {
          if (action === 'list') {
            const list = listClaudeProjects();
            return list.length ? JSON.stringify(list.map((p) => ({ nom: p.name, description: p.description, documents: p.docs })), null, 1) : "Aucun projet claude.ai importé. Il peut les importer depuis la page Compte Claude de Chlamyd.I.A. (export de ses données claude.ai).";
          }
          if (action === 'search') return JSON.stringify(searchClaudeProjects(query), null, 1);
          const r = readClaudeProject(name, doc);
          if (!r) return `Aucun projet nommé « ${name} ».`;
          if (r.missing) return `Pas de document « ${r.missing} » dans ${r.project.name}. Documents : ${r.project.docs.join(', ')}`;
          if (r.doc) return `# ${r.project.name} · ${r.doc}\n${r.content}`;
          return `# ${r.project.name}\n${r.project.description}\n\n## Instructions\n${r.project.instructions || '(aucune)'}\n\n## Documents\n${r.project.docs.join('\n') || '(aucun)'}`;
        },
      },
      {
        name: 'claude_account',
        description:
          "Ton compte Claude sur ce Mac, en lecture : action skills (liste des skills perso et des plugins), skill (contenu d'un skill ou d'une tâche planifiée, par name), scheduled (tâches planifiées de l'app Claude sur ce Mac et routines Maestro). Pour les routines claude.ai dans le cloud, utilise RemoteTrigger action list.",
        schema: { action: z.enum(['skills', 'skill', 'scheduled']), name: z.string().optional() },
        handler: async ({ action, name }) => {
          if (action === 'skills') {
            const skills = listSkills();
            return skills.length ? JSON.stringify(skills.map(({ name: n, description, source }) => ({ nom: n, description, source })), null, 1) : 'Aucun skill trouvé dans ~/.claude/skills ni dans les plugins installés.';
          }
          if (action === 'skill') {
            const s = readSkillContent(name);
            return s ? `# ${s.name} (${s.source})\n${s.content}` : `Aucun skill ni tâche planifiée nommé « ${name} ».`;
          }
          return JSON.stringify(
            {
              tâches_app_claude: listScheduledTasks().map(({ name: n, description, schedule }) => ({ nom: n, description, planification: schedule })),
              routines_maestro: (getConfig().routines || []).map((r) => ({ nom: r.name, heure: r.time, jours: r.days, consigne: r.prompt, active: r.enabled })),
              routines_claude_ai: (() => {
                const c = getClaudeRoutines();
                return c.routines.length ? { dernière_lecture: c.fetchedAt, liste: c.routines.map((r) => ({ nom: r.name, quand: r.schedule_fr || r.cron, consigne: r.prompt, id: r.id })), note: 'Pour la liste à jour ou les résultats, utilise RemoteTrigger.' } : 'Utilise RemoteTrigger action list pour les obtenir.';
              })(),
            },
            null,
            1,
          );
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
