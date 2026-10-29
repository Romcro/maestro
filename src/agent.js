// Lance une session Claude Code via le Claude Agent SDK et normalise son flux d'événements.
import path from 'node:path';
import fs from 'node:fs';
import { z } from 'zod';
import { inbox } from './inbox.js';
import { getConfig } from './config.js';
import { claudeEnv, getKey } from './providers.js';
import { explainTool } from './explain.js';

const FAKE = process.env.MAESTRO_FAKE === '1';

let sdkPromise = null;
function sdk() {
  if (!sdkPromise) sdkPromise = import('@anthropic-ai/claude-agent-sdk');
  return sdkPromise;
}

const trunc = (s, n = 140) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Libellé lisible d'un appel d'outil, pour le fil d'activité et les demandes d'autorisation. */
export function describeTool(name, input = {}, cwd = '') {
  const rel = (p) => {
    if (!p) return '';
    const r = cwd ? path.relative(cwd, p) : p;
    return r && !r.startsWith('..') ? r : p;
  };
  switch (name) {
    case 'Read': return { icon: 'read', label: `Lit ${rel(input.file_path)}` };
    case 'Write': return { icon: 'write', label: `Crée ${rel(input.file_path)}` };
    case 'Edit':
    case 'MultiEdit': return { icon: 'edit', label: `Modifie ${rel(input.file_path)}` };
    case 'NotebookEdit': return { icon: 'edit', label: `Modifie ${rel(input.notebook_path)}` };
    case 'Bash': return { icon: 'terminal', label: `$ ${trunc(input.command, 160)}`, detail: input.description };
    case 'Glob': return { icon: 'search', label: `Cherche ${input.pattern}` };
    case 'Grep': return { icon: 'search', label: `Cherche « ${trunc(input.pattern, 60)} »` };
    case 'WebFetch': return { icon: 'web', label: `Ouvre ${trunc(input.url, 90)}` };
    case 'WebSearch': return { icon: 'web', label: `Recherche web « ${trunc(input.query, 70)} »` };
    case 'Task':
    case 'Agent': return { icon: 'agent', label: `Sous-agent : ${trunc(input.description || input.prompt, 90)}` };
    case 'TodoWrite': return { icon: 'list', label: 'Met à jour sa liste de tâches' };
    case 'Skill': return { icon: 'tool', label: `Skill ${input.skill || input.command || ''}`.trim() };
    case 'RemoteTrigger': return { icon: 'clock', label: input.action === 'list' ? 'Liste tes routines claude.ai' : `Routines claude.ai · ${input.action}` };
    case 'mcp__maestro__ask_user': return { icon: 'question', label: `Te pose une question` };
    case 'mcp__maestro__report_progress': return { icon: 'check', label: trunc(input.summary || 'Avancement', 120) };
    default:
      if (name.startsWith('mcp__')) {
        const [, server, tool] = name.split('__');
        return { icon: 'plug', label: `${server.replace(/^claude_ai_/, '').replace(/_/g, ' ')} · ${tool}` };
      }
      return { icon: 'tool', label: name };
  }
}

/**
 * Gestionnaire d'autorisations : ce qui n'est pas déjà autorisé arrive dans ta boîte de réception.
 */
export function permissionHandler(ctx) {
  return async (toolName, input, { signal, suggestions, blockedPath, decisionReason }) => {
    const d = describeTool(toolName, input, ctx.cwd);
    if (ctx.autoAllow?.(toolName, input)) {
      ctx.onEvent?.({ type: 'permission', tool: toolName, label: d.label, decision: 'auto' });
      return { behavior: 'allow', updatedInput: input };
    }
    const isFile = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName);
    const verb =
      toolName === 'Bash' ? 'veut lancer une commande'
      : isFile ? (blockedPath ? 'veut modifier un fichier hors de son dossier' : 'veut modifier un fichier')
      : toolName === 'WebFetch' || toolName === 'WebSearch' ? 'veut accéder au web'
      : `veut utiliser ${d.label}`;
    const explain = explainTool(toolName, input, ctx.cwd);
    const answer = await inbox.add(
      {
        kind: 'permission',
        projectId: ctx.projectId,
        stepId: ctx.stepId,
        title: `${ctx.label} ${verb}`,
        notifyBody: explain.steps.join(', puis '),
        detail: [toolName === 'Bash' && d.detail ? `L'agent précise : ${d.detail}` : null, blockedPath && !isFile ? `Chemin hors de son dossier : ${blockedPath}` : null].filter(Boolean).join(' — '),
        tool: toolName,
        explain,
        preview: toolName === 'Bash' ? input.command : toolName === 'Write' ? trunc(input.content, 1200) : toolName === 'Edit' ? `${trunc(input.old_string, 500)}\n→\n${trunc(input.new_string, 500)}` : JSON.stringify(input, null, 2).slice(0, 1200),
        options: [
          { id: 'allow', label: 'Autoriser' },
          { id: 'always', label: 'Toujours (cette session)' },
          { id: 'deny', label: 'Refuser' },
        ],
      },
      { wait: true, signal },
    );
    ctx.onEvent?.({ type: 'permission', tool: toolName, label: d.label, decision: answer?.choice || 'cancelled' });
    if (answer?.choice === 'allow') return { behavior: 'allow', updatedInput: input };
    if (answer?.choice === 'always') {
      const updatedPermissions = (suggestions || []).map((s) => ({ ...s, destination: 'session' }));
      return { behavior: 'allow', updatedInput: input, updatedPermissions };
    }
    return {
      behavior: 'deny',
      message: answer?.text ? `L'utilisateur a refusé : ${answer.text}` : "L'utilisateur a refusé cette action. Trouve une autre approche ou demande-lui via ask_user.",
    };
  };
}

/** Outils Maestro exposés à l'agent : poser une question, signaler son avancement. */
export function maestroTools(ctx, extra = []) {
  const tools = [
    {
      name: 'ask_user',
      description:
        "Pose une question à l'utilisateur et attend sa réponse. C'est le SEUL moyen de lui parler en cours de travail : il n'est pas devant le terminal. À utiliser seulement pour une vraie décision bloquante (choix produit, accès, information introuvable).",
      schema: {
        question: z.string().describe('La question, claire et autonome.'),
        options: z.array(z.string()).optional().describe('Réponses proposées (facultatif). L\'utilisateur peut toujours répondre librement.'),
      },
      handler: async ({ question, options }, signal) => {
        ctx.onEvent?.({ type: 'question', text: question, options: options || [] });
        const answer = await inbox.add(
          {
            kind: 'question',
            projectId: ctx.projectId,
            stepId: ctx.stepId,
            title: `${ctx.label} a une question`,
            notifyBody: trunc(question, 180),
            detail: question,
            choices: options || [],
          },
          { wait: true, signal },
        );
        if (answer?.cancelled) return "Pas de réponse (session interrompue). Choisis l'option la plus raisonnable et indique-le dans ton résumé.";
        ctx.onEvent?.({ type: 'answer', text: answer.text });
        return `Réponse de l'utilisateur : ${answer.text}`;
      },
    },
    {
      name: 'report_progress',
      description: "Signale ton avancement au tableau de bord de l'utilisateur. Appelle-le quand tu termines une sous-tâche (avec son numéro) ou à chaque étape importante.",
      schema: {
        summary: z.string().describe('Une phrase : ce qui vient d\'être fait.'),
        done_items: z.array(z.number()).optional().describe('Numéros (à partir de 1) des sous-tâches maintenant terminées.'),
      },
      handler: async ({ summary, done_items }) => {
        ctx.onProgress?.({ summary, doneItems: done_items || [] });
        return 'Noté.';
      },
    },
    ...extra,
  ];
  return tools;
}

/**
 * Exécute un tour d'agent. Résout avec { sessionId, ok, text, cost, turns, durationMs }.
 * @param {object} o
 * @param {string} o.cwd
 * @param {string} o.prompt
 * @param {string} [o.resume]
 * @param {string} [o.systemAppend]
 * @param {string} [o.model]
 * @param {object} o.ctx            { projectId, stepId, label, cwd, onEvent, onProgress }
 * @param {string[]} [o.allowedTools]
 * @param {string} [o.permissionMode]
 * @param {AbortController} o.abort
 * @param {Array} [o.extraTools]
 * @param {object} [o.mcpServers]
 * @param {string[]} [o.settingSources]
 */
export async function runAgent(o) {
  const { ctx } = o;
  const emit = (e) => ctx.onEvent?.({ ...e, at: Date.now() });
  const tools = maestroTools(ctx, o.extraTools);
  if (o.abort.signal.aborted) return { sessionId: o.resume || null, ok: false, aborted: true, text: 'Arrêté.', cost: 0 };
  if (FAKE) return fakeRun(o, tools, emit);

  const { query, tool, createSdkMcpServer } = await sdk();
  const server = createSdkMcpServer({
    name: 'maestro',
    version: '1.0.0',
    tools: tools.map((t) =>
      tool(t.name, t.description, t.schema, async (args) => ({
        content: [{ type: 'text', text: await t.handler(args, o.abort.signal) }],
      })),
    ),
  });

  // Par défaut, l'exécutable intégré au SDK (version garantie compatible). Il partage ta connexion Claude Code.
  const claudePath = getConfig().claudePath || null;
  const options = {
    cwd: o.cwd,
    abortController: o.abort,
    resume: o.resume || undefined,
    model: o.model || undefined,
    permissionMode: o.permissionMode || 'acceptEdits',
    allowedTools: [...(o.allowedTools || []), ...tools.map((t) => `mcp__maestro__${t.name}`)],
    disallowedTools: ['AskUserQuestion'],
    canUseTool: permissionHandler(ctx),
    mcpServers: { ...(o.mcpServers || {}), maestro: server },
    settingSources: o.settingSources || ['user', 'project', 'local'],
    systemPrompt: { type: 'preset', preset: 'claude_code', append: o.systemAppend || '' },
    ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
    // Clé API Claude collée dans Connexions : prioritaire sur la connexion Claude Code de ce Mac.
    ...(claudeEnv() ? { env: claudeEnv() } : {}),
    stderr: (d) => {
      if (/error/i.test(d)) emit({ type: 'stderr', text: trunc(d, 400) });
    },
  };

  let sessionId = o.resume || null;
  let final = null;
  const toolNames = new Map();
  try {
    for await (const msg of query({ prompt: o.prompt, options })) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        sessionId = msg.session_id;
        emit({ type: 'init', sessionId, model: msg.model, tools: msg.tools?.length });
      } else if (msg.type === 'assistant') {
        const sub = !!msg.parent_tool_use_id;
        if (msg.error) emit({ type: 'error', message: apiErrorLabel(msg.error) });
        for (const block of msg.message?.content || []) {
          if (block.type === 'text' && block.text?.trim()) emit({ type: 'text', text: block.text, sub });
          else if (block.type === 'tool_use') {
            toolNames.set(block.id, block.name);
            if (block.name === 'TodoWrite') emit({ type: 'todos', todos: block.input?.todos || [], sub });
            if (block.name === 'mcp__maestro__ask_user' || block.name === 'mcp__maestro__report_progress') {
              if (block.name === 'mcp__maestro__report_progress') emit({ type: 'progress', text: block.input?.summary, sub });
              continue;
            }
            const d = describeTool(block.name, block.input, o.cwd);
            emit({ type: 'tool', id: block.id, name: block.name, icon: d.icon, label: d.label, detail: d.detail, sub });
          }
        }
      } else if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
        for (const block of msg.message.content) {
          if (block.type === 'tool_result' && block.is_error) {
            const name = toolNames.get(block.tool_use_id);
            if (name === 'mcp__maestro__ask_user') continue;
            const text = Array.isArray(block.content) ? block.content.map((c) => c.text || '').join(' ') : block.content;
            emit({ type: 'tool_error', id: block.tool_use_id, text: trunc(text, 300) });
          }
        }
      } else if (msg.type === 'result') {
        final = {
          sessionId: msg.session_id || sessionId,
          ok: msg.subtype === 'success' && !msg.is_error,
          text: msg.result || (msg.errors || []).join('\n') || '',
          cost: msg.total_cost_usd || 0,
          turns: msg.num_turns,
          durationMs: msg.duration_ms,
        };
        if (!final.ok && final.text) final.text = friendlyError(final.text);
      }
    }
  } catch (err) {
    if (o.abort.signal.aborted) {
      return { sessionId, ok: false, aborted: true, text: 'Arrêté.', cost: final?.cost || 0 };
    }
    emit({ type: 'error', message: friendlyError(err) });
    return { sessionId, ok: false, text: friendlyError(err), cost: final?.cost || 0 };
  }
  if (!final) final = { sessionId, ok: !o.abort.signal.aborted, aborted: o.abort.signal.aborted, text: '', cost: 0 };
  emit({ type: 'result', ok: final.ok, text: final.text, cost: final.cost, turns: final.turns, durationMs: final.durationMs });
  return final;
}

function apiErrorLabel(code) {
  return (
    {
      authentication_failed: "Claude n'est pas connecté. Ouvre la page Connexions de Chlamyd.I.A. et colle ta clé Claude.",
      rate_limit: 'Limite d\'utilisation atteinte. Réessaie plus tard ou baisse le nombre d\'agents en parallèle.',
      billing_error: noCreditMessage(),
      overloaded: 'Serveurs surchargés, nouvelle tentative…',
    }[code] || `Erreur API : ${code}`
  );
}

/** Plus de crédit : la clé API utilisée est vide. Avec un abonnement Claude, il suffit de ne pas utiliser de clé. */
export function noCreditMessage() {
  const where = getKey('anthropic')
    ? 'ta clé Claude enregistrée dans Connexions'
    : process.env.ANTHROPIC_API_KEY
      ? 'la clé ANTHROPIC_API_KEY définie dans ton terminal (fichier ~/.zshrc)'
      : 'la clé API utilisée par Claude Code';
  return `Plus de crédit sur ${where}. Si tu as un abonnement Claude (Pro ou Max), retire cette clé : Chlamyd.I.A. utilisera ta connexion Claude Code, comprise dans l'abonnement (au besoin, tape claude puis /login). Sinon, recharge des crédits sur console.anthropic.com, ou choisis le modèle local en haut de la page Assistant.`;
}

export function friendlyError(err) {
  const m = String(err?.message || err);
  if (/credit balance|billing|insufficient.?credit|purchase credits/i.test(m)) return noCreditMessage();
  if (/ENOENT|spawn/.test(m)) return `Impossible de lancer Claude Code (${trunc(m, 160)}). Vérifie que \`claude\` est installé.`;
  if (/auth|login|401/i.test(m)) return "Claude n'est pas connecté. Ouvre la page Connexions de Chlamyd.I.A. et colle ta clé Claude.";
  return trunc(m, 400);
}

// ---------------------------------------------------------------------------
// Mode simulé (MAESTRO_FAKE=1) : pour tester l'interface et l'orchestration sans consommer de quota.
// ---------------------------------------------------------------------------
const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
  });

async function fakeRun(o, tools, emit) {
  const speed = Number(process.env.MAESTRO_FAKE_SPEED || 1);
  const wait = (ms) => sleep(ms / speed, o.abort.signal);
  const sessionId = o.resume || `fake-${Math.random().toString(36).slice(2, 10)}`;
  const toolByName = Object.fromEntries(tools.map((t) => [t.name, t]));
  const canUse = permissionHandler(o.ctx);
  try {
    emit({ type: 'init', sessionId, model: 'simulé' });
    await wait(400);
    if (o.ctx.stepId === '__assistant' && /skill/i.test(o.prompt)) {
      emit({ type: 'tool', icon: 'plug', name: 'mcp__maestro__claude_account', label: 'maestro · claude_account' });
      const list = await toolByName.claude_account.handler({ action: 'skills' });
      const names = list.startsWith('[') ? JSON.parse(list).map((s) => s.nom) : [];
      const text = `Simulation : tu as ${names.length} skill${names.length > 1 ? 's' : ''}${names.length ? ` : ${names.join(', ')}` : ''}.`;
      emit({ type: 'text', text });
      return { sessionId, ok: true, text, cost: 0.002, turns: 2 };
    }
    if (o.ctx.stepId === '__assistant') {
      emit({ type: 'tool', icon: 'plug', name: 'mcp__maestro__projects_status', label: 'maestro · projects_status' });
      const status = JSON.parse(await toolByName.projects_status.handler({}));
      await wait(600);
      const text = o.prompt.startsWith('[Message dicté')
        ? `Simulation : tu as ${status.length} projet${status.length > 1 ? 's' : ''} suivi${status.length > 1 ? 's' : ''}. Tout est sous contrôle.`
        : `_(simulation)_ Tu as ${status.length} projet${status.length > 1 ? 's' : ''} :\n${status.map((p) => `- **${p.projet}** : ${p.progression} étapes, ${p.actif ? 'en cours' : 'en pause'}`).join('\n')}`;
      emit({ type: 'text', text });
      return { sessionId, ok: true, text, cost: 0.003, turns: 2 };
    }
    if (toolByName.save_routines) {
      emit({ type: 'tool', icon: 'clock', name: 'RemoteTrigger', label: 'Liste tes routines claude.ai' });
      await wait(300);
      await toolByName.save_routines.handler({
        routines: [
          { id: 'trig_veille', name: 'Newsletter IA', enabled: true, cron: '0 6 * * 1-5', schedule_fr: 'Du lundi au vendredi à 8 h', time_local: '08:00', days: [1, 2, 3, 4, 5], prompt: 'Rédige ma newsletter IA du jour.', last_run: null },
          { id: 'trig_heure', name: 'Veille horaire', enabled: true, cron: '0 * * * *', schedule_fr: 'Toutes les heures', time_local: null, days: null, prompt: 'Surveille les nouveautés.' },
        ],
      });
      return { sessionId, ok: true, text: 'Fait.', cost: 0.001, turns: 2 };
    }
    if (toolByName.write_plan) {
      emit({ type: 'tool', icon: 'search', name: 'Glob', label: 'Cherche **/*' });
      await wait(800);
      const { PLAN_TEMPLATE } = await import('./plan.js');
      emit({ type: 'tool', icon: 'write', name: 'mcp__maestro__write_plan', label: 'Écrit le plan' });
      await toolByName.write_plan.handler({ markdown: PLAN_TEMPLATE.replace('# Mon projet', `# ${trunc((o.prompt.match(/Demande de l'utilisateur :\n(.+)/) || [])[1] || 'Projet', 50)}`) });
      return { sessionId, ok: true, text: 'Plan rédigé (simulation).', cost: 0.01, turns: 3 };
    }
    emit({ type: 'text', text: o.resume ?`Je reprends : ${trunc(o.prompt, 120)}` : "Je regarde la structure du projet avant de commencer." });
    emit({ type: 'tool', icon: 'search', name: 'Glob', label: 'Cherche **/*' });
    await wait(600);
    emit({ type: 'tool', icon: 'read', name: 'Read', label: 'Lit README.md' });
    await wait(500);
    const items = [...o.prompt.matchAll(/^(\d+)\. \[ \] (.+)$/gm)];
    let n = 0;
    for (const [, num, text] of items.length ? items : [[null, '1', 'travail']]) {
      n++;
      const file = `src/${text.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'fichier'}.js`;
      emit({ type: 'tool', icon: 'write', name: 'Write', label: `Crée ${file}` });
      fs.mkdirSync(path.join(o.cwd, 'src'), { recursive: true });
      fs.writeFileSync(path.join(o.cwd, file), `// ${text} (${o.ctx.label})\nexport function run() {\n  return ${JSON.stringify(text)};\n}\n`);
      await wait(700);
      await toolByName.report_progress.handler({ summary: `${text} : fait`, done_items: [Number(num)] });
      emit({ type: 'progress', text: `${text} : fait` });
    }
    if (/question|demande|choix/i.test(o.prompt) && !o.resume) {
      emit({ type: 'tool', icon: 'question', name: 'mcp__maestro__ask_user', label: 'Te pose une question' });
      await toolByName.ask_user.handler({ question: 'Tu préfères une base PostgreSQL ou SQLite pour commencer ?', options: ['PostgreSQL', 'SQLite'] }, o.abort.signal);
    }
    if (/permission|install|déploie/i.test(o.prompt) && !o.resume) {
      const input = { command: 'brew install redis', description: 'Installer Redis localement' };
      emit({ type: 'tool', icon: 'terminal', name: 'Bash', label: `$ ${input.command}` });
      const r = await canUse('Bash', input, { signal: o.abort.signal, suggestions: [] });
      emit({ type: r.behavior === 'allow' ? 'text' : 'tool_error', text: r.behavior === 'allow' ? 'Redis installé.' : 'Refusé, je passe à une autre approche.' });
    }
    emit({ type: 'tool', icon: 'terminal', name: 'Bash', label: '$ npm test' });
    await wait(800);
    emit({ type: 'text', text: 'Tous les tests passent.' });
    const text = `Étape terminée (simulation). ${n} fichier(s) créé(s) dans src/.\nÀ vérifier : les noms de fonctions.`;
    emit({ type: 'text', text });
    const result = { sessionId, ok: true, text, cost: 0.02 * n, turns: 4 + n, durationMs: 3000 };
    emit({ type: 'result', ok: true, text, cost: result.cost, turns: result.turns, durationMs: result.durationMs });
    return result;
  } catch (err) {
    if (o.abort.signal.aborted) return { sessionId, ok: false, aborted: true, text: 'Arrêté.', cost: 0 };
    throw err;
  }
}
