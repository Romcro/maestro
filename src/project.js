import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { parsePlan, markStepDone, setItem, PLAN_TEMPLATE } from './plan.js';
import * as G from './git.js';
import { runAgent } from './agent.js';
import { inbox } from './inbox.js';
import { broadcast, notify } from './bus.js';
import { getConfig, DEFAULT_ALLOW } from './config.js';
import { paths, readJSON, writeJSON, ensureDir, slugify } from './paths.js';
import { z } from 'zod';

const ACTIVE = new Set(['running', 'merging', 'review', 'conflict', 'failed', 'stopped', 'interrupted']);
const PLAN_NAMES = ['PLAN.md', 'plan.md', 'Plan.md', 'PLAN.MD', 'ROADMAP.md'];
const LOG_CAP = 500;
const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export class Project {
  constructor({ id, path: dir, name }) {
    this.id = id;
    this.dir = dir;
    this.name = name || path.basename(dir);
    this.plan = { title: this.name, context: '', steps: [], warnings: [] };
    this.planFile = null;
    this.isGit = false;
    this.runs = new Map(); // stepId -> { abort }
    this.logs = new Map(); // stepId -> events[]
    this.stateFile = path.join(paths.projectDir(id), 'state.json');
    this.state = readJSON(this.stateFile, { running: false, baseBranch: null, steps: {}, totalCost: 0 });
    this.emitTimer = null;
    this.watcher = null;
    this.planning = null;
  }

  // ----------------------------------------------------------------- cycle de vie
  async init() {
    ensureDir(paths.projectDir(this.id));
    this.exists = fs.existsSync(this.dir);
    if (!this.exists) return this;
    await this.detectGit();
    this.loadPlan();
    this.watch();
    for (const [stepId, st] of Object.entries(this.state.steps)) {
      if (st.status === 'running' || st.status === 'merging') {
        st.status = 'interrupted';
        st.error = 'Maestro a été arrêté pendant que cet agent travaillait.';
      }
      this.restoreInbox(stepId, st);
    }
    this.save();
    setTimeout(() => this.tick(), 500);
    return this;
  }

  async detectGit() {
    this.isGit = (await G.isRepo(this.dir)) && (await G.hasCommits(this.dir));
    this.hasRepo = await G.isRepo(this.dir);
    if (this.isGit && !this.state.baseBranch) this.state.baseBranch = await G.currentBranch(this.dir);
  }

  restoreInbox(stepId, st) {
    const step = this.step(stepId);
    if (!step) return;
    const label = this.label(step);
    if (st.status === 'review') this.addReview(step, st, { silent: true });
    if (st.status === 'conflict') {
      inbox.add({ kind: 'conflict', projectId: this.id, stepId, title: `${label} : conflit de fusion`, detail: (st.conflictFiles || []).join(', ') }, { silent: true });
    }
    if (st.status === 'failed' || st.status === 'interrupted') {
      inbox.add({ kind: 'error', projectId: this.id, stepId, title: `${label} : ${st.status === 'failed' ? 'échec' : 'interrompue'}`, detail: st.error || '' }, { silent: true });
    }
  }

  dispose() {
    this.watcher?.close();
    for (const r of this.runs.values()) r.abort.abort();
    inbox.clear({ projectId: this.id });
  }

  // ----------------------------------------------------------------- plan
  findPlanFile() {
    for (const n of PLAN_NAMES) {
      const p = path.join(this.dir, n);
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  loadPlan() {
    this.planFile = this.findPlanFile();
    if (!this.planFile) {
      this.plan = { title: this.name, context: '', steps: [], warnings: [] };
    } else {
      try {
        this.plan = parsePlan(fs.readFileSync(this.planFile, 'utf8'));
      } catch (e) {
        this.plan = { ...this.plan, warnings: [`Impossible de lire le plan : ${e.message}`] };
      }
    }
    this.emit();
  }

  watch() {
    try {
      this.watcher = fs.watch(this.dir, { persistent: false }, (_, file) => {
        if (file && !PLAN_NAMES.includes(String(file))) return;
        clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => {
          this.loadPlan();
          this.tick();
        }, 150);
      });
    } catch {}
  }

  editPlan(fn) {
    if (!this.planFile) return;
    const text = fs.readFileSync(this.planFile, 'utf8');
    const next = fn(text);
    if (next !== text) fs.writeFileSync(this.planFile, next);
    this.plan = parsePlan(next);
    this.emit();
  }

  createPlanFromTemplate() {
    if (this.findPlanFile()) return;
    fs.writeFileSync(path.join(this.dir, 'PLAN.md'), PLAN_TEMPLATE.replace('# Mon projet', `# ${this.name}`));
    this.loadPlan();
  }

  step(id) {
    return this.plan.steps.find((s) => s.id === id);
  }

  st(id) {
    if (!this.state.steps[id]) this.state.steps[id] = { cost: 0, queue: [] };
    return this.state.steps[id];
  }

  label(step) {
    return `Étape ${step.id}${step.agent ? ` · ${step.agent}` : ''}`;
  }

  status(step) {
    const st = this.state.steps[step.id];
    if (st && ACTIVE.has(st.status)) {
      if (st.status === 'running' && inbox.has({ projectId: this.id, stepId: step.id })) return 'waiting';
      return st.status;
    }
    if (step.done || st?.status === 'done') return 'done';
    const depsDone = step.after.every((d) => {
      const dep = this.step(d);
      return dep && this.status(dep) === 'done';
    });
    return depsDone ? 'ready' : 'blocked';
  }

  // ----------------------------------------------------------------- persistance & diffusion
  save() {
    writeJSON(this.stateFile, this.state);
  }

  emit() {
    clearTimeout(this.emitTimer);
    this.emitTimer = setTimeout(() => broadcast('project', this.summary()), 60);
  }

  log(stepId, event) {
    const e = { at: Date.now(), ...event };
    if (!this.logs.has(stepId)) this.logs.set(stepId, this.readLog(stepId));
    const arr = this.logs.get(stepId);
    arr.push(e);
    if (arr.length > LOG_CAP) arr.splice(0, arr.length - LOG_CAP);
    const st = this.state.steps[stepId];
    if (st && (e.type === 'tool' || e.type === 'text' || e.type === 'progress')) {
      st.lastActivity = { label: e.label || e.text, at: e.at, icon: e.icon || e.type };
    }
    if (st && e.type === 'todos') st.todos = e.todos;
    try {
      const dir = ensureDir(path.join(paths.projectDir(this.id), 'logs'));
      fs.appendFileSync(path.join(dir, `${slugify(stepId)}.jsonl`), JSON.stringify(e) + '\n');
    } catch {}
    broadcast('step-event', { projectId: this.id, stepId, event: e });
    this.emit();
  }

  readLog(stepId) {
    try {
      const file = path.join(paths.projectDir(this.id), 'logs', `${slugify(stepId)}.jsonl`);
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
      return lines.slice(-LOG_CAP).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }

  getLog(stepId) {
    if (!this.logs.has(stepId)) this.logs.set(stepId, this.readLog(stepId));
    return this.logs.get(stepId);
  }

  summary() {
    const steps = this.plan.steps.map((s) => {
      const st = this.state.steps[s.id] || {};
      return {
        ...s,
        status: this.status(s),
        cost: st.cost || 0,
        startedAt: st.startedAt || null,
        finishedAt: st.finishedAt || null,
        summary: st.summary || null,
        progress: st.progress || null,
        error: st.error || null,
        lastActivity: st.lastActivity || null,
        todos: st.todos || null,
        diff: st.diff || null,
        branch: st.branch || null,
        worktree: st.worktree || null,
        hasSession: !!st.sessionId,
        queued: st.queue?.length || 0,
        conflictFiles: st.conflictFiles || null,
      };
    });
    const count = (k) => steps.filter((s) => s.status === k).length;
    return {
      id: this.id,
      name: this.name,
      path: this.dir,
      exists: this.exists,
      title: this.plan.title,
      context: this.plan.context,
      warnings: this.plan.warnings,
      planFile: this.planFile ? path.basename(this.planFile) : null,
      isGit: this.isGit,
      hasRepo: this.hasRepo,
      baseBranch: this.state.baseBranch,
      running: !!this.state.running,
      planning: this.planning,
      steps,
      totals: {
        total: steps.length,
        done: count('done'),
        running: count('running') + count('waiting') + count('merging'),
        attention: count('waiting') + count('review') + count('conflict') + count('failed') + count('interrupted'),
        cost: this.state.totalCost || 0,
      },
    };
  }

  // ----------------------------------------------------------------- orchestration
  start() {
    this.state.running = true;
    this.save();
    this.emit();
    this.tick();
  }

  pause() {
    this.state.running = false;
    this.save();
    this.emit();
  }

  stopAll() {
    this.pause();
    for (const r of this.runs.values()) r.abort.abort();
  }

  async tick() {
    if (!this.state.running || this.ticking || !this.exists) return;
    this.ticking = true;
    try {
      const limit = this.isGit ? getConfig().maxParallel : 1;
      for (const step of this.plan.steps) {
        if (this.runs.size >= limit) break;
        if (this.status(step) === 'ready' && !this.runs.has(step.id)) {
          this.startStep(step.id).catch((e) => this.fail(step.id, e));
        }
      }
      const steps = this.plan.steps;
      if (steps.length && steps.every((s) => this.status(s) === 'done')) {
        this.state.running = false;
        this.save();
        this.emit();
        notify({ title: `${this.plan.title} : plan terminé`, body: `Les ${steps.length} étapes sont faites.`, kind: 'success', projectId: this.id });
      }
    } finally {
      this.ticking = false;
    }
  }

  buildPrompt(step) {
    const done = this.plan.steps.filter((s) => s.id !== step.id && this.status(s) === 'done');
    const items = step.items.map((it, i) => `${i + 1}. [${it.done ? 'x' : ' '}] ${it.text}`).join('\n');
    return [
      `# Plan : ${this.plan.title}`,
      this.plan.context ? `## Contexte du projet\n${this.plan.context}` : '',
      `## Ton étape : ${step.id}. ${step.title}`,
      step.body,
      items ? `### Sous-tâches\n${items}` : '',
      done.length
        ? `## Étapes déjà intégrées\n${done.map((s) => `- ${s.id}. ${s.title}${this.state.steps[s.id]?.summary ? ` — ${this.state.steps[s.id].summary.split('\n')[0].slice(0, 200)}` : ''}`).join('\n')}`
        : '',
      'Commence.',
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  systemAppend(step, st, role) {
    const isolated = this.isGit && st.worktree;
    return [
      '# Tu es un agent piloté par Maestro',
      `Tu travailles sur UNE étape d'un plan (fichier ${this.planFile ? path.basename(this.planFile) : 'PLAN.md'}).`,
      isolated
        ? `Ton dossier est un worktree git isolé sur la branche « ${st.branch} », créé depuis « ${this.state.baseBranch} ». D'autres agents travaillent en parallèle sur d'autres étapes, chacun dans son dossier. Ton travail sera fusionné après validation.`
        : 'Tu travailles directement dans le dossier du projet.',
      "L'utilisateur n'est pas devant ton terminal : il suit ton travail sur un tableau de bord.",
      '',
      '## Règles',
      '- Ne modifie pas le fichier du plan : Maestro coche les cases lui-même.',
      '- Reste dans le périmètre de ton étape.',
      "- Quand tu termines une sous-tâche, appelle mcp__maestro__report_progress avec son numéro.",
      "- Pour une décision réellement bloquante, appelle mcp__maestro__ask_user. Pour les détails, décide toi-même et mentionne-le dans ton résumé.",
      '- Lance les tests, le linter ou le build disponibles avant de terminer.',
      '- Fais un commit git clair de ton travail à la fin.',
      "- Termine par un résumé de 3 à 6 lignes : ce que tu as fait, ce que l'utilisateur doit vérifier.",
      role ? `\n## Ton rôle : ${step.agent}\n${role}` : step.agent ? `\n## Ton rôle : ${step.agent}` : '',
    ].join('\n');
  }

  loadRole(name) {
    if (!name) return { prompt: '', model: null };
    for (const base of [path.join(this.dir, '.claude/agents'), path.join(process.env.HOME || '', '.claude/agents')]) {
      const file = path.join(base, `${name}.md`);
      if (!fs.existsSync(file)) continue;
      const raw = fs.readFileSync(file, 'utf8');
      const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
      const front = {};
      if (m) for (const l of m[1].split('\n')) { const i = l.indexOf(':'); if (i > 0) front[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }
      return { prompt: (m ? m[2] : raw).trim(), model: front.model && front.model !== 'inherit' ? front.model : null };
    }
    return { prompt: '', model: null };
  }

  async prepareWorktree(step, st) {
    if (!this.isGit || st.worktree) return;
    const base = this.state.baseBranch || (await G.currentBranch(this.dir)) || 'main';
    this.state.baseBranch = base;
    const branch = `maestro/${slugify(step.id, 10)}-${slugify(step.title, 28)}`;
    const wt = path.join(paths.worktrees(this.id), `etape-${slugify(step.id, 10)}-${slugify(step.title, 20)}`);
    st.baseSha = await G.headSha(this.dir, base);
    await G.addWorktree(this.dir, wt, branch, base);
    st.branch = branch;
    st.worktree = wt;
  }

  async startStep(stepId) {
    const step = this.step(stepId);
    if (!step) throw new Error(`Étape ${stepId} introuvable`);
    const st = this.st(stepId);
    st.sessionId = null;
    st.summary = null;
    st.progress = null;
    st.todos = null;
    this.logs.set(stepId, []);
    this.log(stepId, { type: 'start', text: `Démarrage de ${this.label(step)}` });
    return this.run(stepId, this.buildPrompt(step), { resume: false });
  }

  async run(stepId, prompt, { resume, after = 'review' }) {
    const step = this.step(stepId);
    if (!step) throw new Error(`Étape ${stepId} introuvable`);
    if (this.runs.has(stepId)) throw new Error('Cet agent tourne déjà.');
    const st = this.st(stepId);
    const abort = new AbortController();
    this.runs.set(stepId, { abort });
    inbox.clear({ projectId: this.id, stepId });
    st.status = 'running';
    st.error = null;
    st.conflictFiles = null;
    st.startedAt = st.startedAt && resume ? st.startedAt : Date.now();
    st.finishedAt = null;
    this.save();
    this.emit();

    let result;
    try {
      await this.prepareWorktree(step, st);
      const cwd = st.worktree || this.dir;
      const role = this.loadRole(step.agent);
      const cfg = getConfig();
      result = await runAgent({
        cwd,
        prompt,
        resume: resume ? st.sessionId : undefined,
        systemAppend: this.systemAppend(step, st, role.prompt),
        model: step.model || role.model || cfg.model || undefined,
        permissionMode: cfg.permissionMode,
        allowedTools: ['Read', 'Glob', 'Grep', 'LS', 'TodoWrite', 'Task', 'Agent', ...DEFAULT_ALLOW, ...(cfg.allow || [])],
        abort,
        ctx: {
          projectId: this.id,
          stepId,
          label: this.label(step),
          cwd,
          onEvent: (e) => this.log(stepId, e),
          onProgress: (p) => this.onProgress(stepId, p),
        },
      });
    } catch (e) {
      this.runs.delete(stepId);
      return this.fail(stepId, e);
    }
    this.runs.delete(stepId);

    if (result.sessionId) st.sessionId = result.sessionId;
    st.cost = (st.cost || 0) + (result.cost || 0);
    this.state.totalCost = (this.state.totalCost || 0) + (result.cost || 0);

    if (result.aborted) {
      st.status = 'stopped';
      st.finishedAt = Date.now();
      this.log(stepId, { type: 'stopped', text: 'Agent arrêté.' });
      this.save();
      this.emit();
      return this.tick();
    }
    if (!result.ok) return this.fail(stepId, new Error(result.text || 'Erreur inconnue'));

    st.summary = result.text?.trim() || st.summary;
    if (st.queue?.length) {
      const next = st.queue.shift();
      this.save();
      return this.run(stepId, next, { resume: true, after });
    }

    try {
      if (st.worktree) {
        await G.commitAll(st.worktree, `Maestro · étape ${step.id} : ${step.title}`, { baseSha: st.baseSha, planFile: path.basename(this.planFile || 'PLAN.md') });
        st.headSha = await G.headSha(st.worktree);
        st.diff = await this.diffStats(st);
      }
    } catch (e) {
      this.log(stepId, { type: 'error', message: `Commit impossible : ${e.message}` });
    }
    st.finishedAt = Date.now();
    const auto = step.autoValidate ?? getConfig().autoValidate;
    if (after === 'review' && auto) {
      this.save();
      return this.validate(stepId, { auto: true });
    }
    st.status = 'review';
    this.save();
    this.emit();
    this.addReview(step, st);
    return this.tick();
  }

  addReview(step, st, { silent = false } = {}) {
    inbox.clear({ projectId: this.id, stepId: step.id, kind: 'review' });
    const d = st.diff;
    inbox.add(
      {
        kind: 'review',
        projectId: this.id,
        stepId: step.id,
        title: `${this.label(step)} terminée : à valider`,
        notifyBody: `${step.title}${d ? ` · ${d.files} fichier(s), +${d.add} −${d.del}` : ''}`,
        detail: st.summary || '',
      },
      { silent },
    );
  }

  fail(stepId, err) {
    const step = this.step(stepId);
    const st = this.st(stepId);
    st.status = 'failed';
    st.error = String(err?.message || err);
    st.finishedAt = Date.now();
    this.log(stepId, { type: 'error', message: st.error });
    this.save();
    this.emit();
    if (step) inbox.add({ kind: 'error', projectId: this.id, stepId, title: `${this.label(step)} : échec`, detail: st.error });
  }

  onProgress(stepId, { summary, doneItems }) {
    const st = this.st(stepId);
    if (summary) st.progress = summary;
    if (doneItems?.length && this.planFile) {
      this.editPlan((text) => doneItems.reduce((t, n) => setItem(t, stepId, n - 1, true), text));
    }
    this.save();
    this.emit();
  }

  async diffStats(st) {
    if (!st.baseSha || !st.headSha) return null;
    const r = await G.git(this.dir, ['diff', '--numstat', st.baseSha, st.headSha], { allowFail: true });
    const files = r.stdout.split('\n').filter(Boolean).map((l) => {
      const [a, d, ...f] = l.split('\t');
      return { file: f.join('\t'), add: Number(a) || 0, del: Number(d) || 0 };
    });
    return { files: files.length, add: files.reduce((s, f) => s + f.add, 0), del: files.reduce((s, f) => s + f.del, 0), list: files.slice(0, 200) };
  }

  async fileDiff(stepId, file) {
    const st = this.state.steps[stepId];
    if (!st?.baseSha || !st?.headSha) return '';
    const r = await G.git(this.dir, ['diff', st.baseSha, st.headSha, '--', file], { allowFail: true });
    return r.stdout.slice(0, 400_000);
  }

  // ----------------------------------------------------------------- actions sur une étape
  async validate(stepId, { auto = false } = {}) {
    const step = this.step(stepId);
    const st = this.st(stepId);
    if (!step) throw new Error('Étape introuvable');
    inbox.clear({ projectId: this.id, stepId });
    if (st.worktree) {
      st.status = 'merging';
      this.emit();
      await G.commitAll(st.worktree, `Maestro · étape ${step.id} : ajustements`, { baseSha: st.baseSha, planFile: path.basename(this.planFile || 'PLAN.md') }).catch(() => {});
      st.headSha = await G.headSha(st.worktree).catch(() => st.headSha);
      const r = await G.mergeBranch(this.dir, st.branch, this.state.baseBranch, `Maestro · étape ${step.id} : ${step.title}`);
      if (!r.ok) {
        if (r.reason === 'conflict') {
          st.status = 'conflict';
          st.conflictFiles = r.files;
          this.log(stepId, { type: 'error', message: `${r.message} ${r.files?.join(', ') || ''}` });
          inbox.add({ kind: 'conflict', projectId: this.id, stepId, title: `${this.label(step)} : conflit de fusion`, notifyBody: r.files?.join(', '), detail: (r.files || []).join(', ') });
        } else {
          st.status = 'review';
          this.log(stepId, { type: 'error', message: r.message });
          inbox.add({ kind: 'review', projectId: this.id, stepId, title: `${this.label(step)} : fusion bloquée`, detail: r.message, notifyBody: r.message });
        }
        this.save();
        this.emit();
        return { ok: false, message: r.message };
      }
      st.diff = (await this.diffStats(st)) || st.diff;
      await G.removeWorktree(this.dir, st.worktree, st.branch);
      st.worktree = null;
    }
    st.status = 'done';
    st.finishedAt = st.finishedAt || Date.now();
    this.editPlan((t) => markStepDone(t, stepId, true));
    this.log(stepId, { type: 'done', text: auto ? 'Validée automatiquement et fusionnée.' : this.isGit ? `Fusionnée dans ${this.state.baseBranch}.` : 'Validée.' });
    this.save();
    this.emit();
    this.tick();
    return { ok: true };
  }

  async redo(stepId, feedback) {
    const text = `Retour de l'utilisateur sur ton travail :\n\n${feedback}\n\nCorrige, vérifie, commit, puis termine par un nouveau résumé.`;
    return this.run(stepId, text, { resume: true });
  }

  async message(stepId, text) {
    const st = this.st(stepId);
    if (this.runs.has(stepId)) {
      st.queue = [...(st.queue || []), text];
      this.log(stepId, { type: 'user', text, queued: true });
      this.save();
      this.emit();
      return { queued: true };
    }
    this.log(stepId, { type: 'user', text });
    const p = st.sessionId
      ? this.run(stepId, text, { resume: true })
      : this.run(stepId, `${this.buildPrompt(this.step(stepId))}\n\nPrécision de l'utilisateur : ${text}`, { resume: false });
    p.catch((e) => this.fail(stepId, e));
    return { queued: false };
  }

  async resolveConflict(stepId) {
    const st = this.st(stepId);
    const files = (st.conflictFiles || []).join(', ') || 'plusieurs fichiers';
    const text = `La fusion de ta branche dans « ${this.state.baseBranch} » a échoué à cause de conflits (${files}). D'autres étapes ont été intégrées entre-temps.\n\nLance \`git merge ${this.state.baseBranch}\` dans ton dossier, résous chaque conflit en conservant les deux intentions, vérifie que les tests passent, puis commit. Termine par un résumé.`;
    this.log(stepId, { type: 'user', text: 'Résolution du conflit demandée à l\'agent.' });
    this.run(stepId, text, { resume: !!st.sessionId }).catch((e) => this.fail(stepId, e));
  }

  retry(stepId) {
    const st = this.st(stepId);
    if (st.sessionId) {
      this.log(stepId, { type: 'user', text: 'Reprise.' });
      return this.run(stepId, "Tu as été interrompu. Reprends là où tu t'étais arrêté, termine l'étape, commit, puis donne ton résumé.", { resume: true });
    }
    return this.startStep(stepId);
  }

  stop(stepId) {
    this.runs.get(stepId)?.abort.abort();
  }

  async discard(stepId) {
    this.stop(stepId);
    const st = this.st(stepId);
    if (st.worktree) await G.removeWorktree(this.dir, st.worktree, st.branch);
    this.state.steps[stepId] = { cost: st.cost || 0, queue: [] };
    inbox.clear({ projectId: this.id, stepId });
    this.log(stepId, { type: 'info', text: 'Travail abandonné, étape remise à zéro.' });
    this.save();
    this.emit();
    this.tick();
  }

  async skip(stepId) {
    this.stop(stepId);
    const st = this.st(stepId);
    if (st.worktree) await G.removeWorktree(this.dir, st.worktree, st.branch);
    st.worktree = null;
    st.status = 'done';
    inbox.clear({ projectId: this.id, stepId });
    this.editPlan((t) => markStepDone(t, stepId, true));
    this.log(stepId, { type: 'done', text: 'Marquée comme terminée à la main.' });
    this.save();
    this.emit();
    this.tick();
  }

  async reopen(stepId) {
    const st = this.st(stepId);
    st.status = null;
    this.editPlan((t) => markStepDone(t, stepId, false));
    this.save();
    this.emit();
    this.tick();
  }

  runStepNow(stepId) {
    if (this.runs.has(stepId)) return;
    return this.startStep(stepId).catch((e) => this.fail(stepId, e));
  }

  openTerminal(stepId) {
    const st = this.state.steps[stepId] || {};
    if (this.runs.has(stepId)) throw new Error("L'agent tourne encore : attends qu'il ait fini ou arrête-le.");
    const cwd = st.worktree || this.dir;
    const cmd = st.sessionId ? `cd ${sh(cwd)} && claude --resume ${sh(st.sessionId)}` : `cd ${sh(cwd)} && claude`;
    if (process.platform !== 'darwin') return cmd;
    const script = `tell application "Terminal"\n activate\n do script "${cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\nend tell`;
    execFile('osascript', ['-e', script], () => {});
    return cmd;
  }

  openEditor(stepId) {
    const st = this.state.steps[stepId] || {};
    const target = st.worktree || this.dir;
    if (process.platform === 'darwin') {
      execFile('open', ['-a', 'Visual Studio Code', target], (err) => {
        if (err) execFile('code', [target], () => {});
      });
    } else execFile('code', [target], () => {});
    return target;
  }

  async initGit() {
    await G.initRepo(this.dir);
    await this.detectGit();
    this.save();
    this.emit();
  }

  // ----------------------------------------------------------------- génération de plan
  async generatePlan(description) {
    if (this.planning?.status === 'running') throw new Error('Un plan est déjà en cours de rédaction.');
    const abort = new AbortController();
    this.planning = { status: 'running', startedAt: Date.now(), text: 'Analyse du projet…' };
    this.emit();
    const planName = this.planFile ? path.basename(this.planFile) : 'PLAN.md';
    const writePlan = {
      name: 'write_plan',
      description: `Écrit le plan dans ${planName}. Le contenu doit suivre exactement le format demandé.`,
      schema: { markdown: z.string() },
      handler: async ({ markdown }) => {
        const parsed = parsePlan(markdown);
        if (!parsed.steps.length) return 'Refusé : aucune étape « ## » trouvée. Corrige le format et rappelle write_plan.';
        fs.writeFileSync(path.join(this.dir, planName), markdown.trimEnd() + '\n');
        this.loadPlan();
        return `Plan enregistré : ${parsed.steps.length} étapes.${parsed.warnings.length ? ` Avertissements : ${parsed.warnings.join(' ')}` : ''}`;
      },
    };
    const prompt = [
      `Rédige le plan de travail de ce projet pour des agents de code qui travailleront en parallèle.`,
      `Demande de l'utilisateur :\n${description}`,
      this.planFile ? `Un plan existe déjà (${planName}) : lis-le et améliore-le en conservant les étapes déjà terminées.` : '',
      `Explore d'abord le dépôt (lecture seule), puis appelle l'outil write_plan UNE fois avec le plan complet.`,
      `Format exact :\n\n${PLAN_TEMPLATE}`,
      `Règles : 3 à 10 étapes ; chaque étape doit être réalisable par un seul agent en une session ; indique « après: » pour chaque étape et rends parallèles celles qui touchent des fichiers différents ; 2 à 6 cases par étape ; noms d'agents courts (backend, frontend, tests, reviewer, docs…). Puis résume le plan en 3 lignes.`,
    ]
      .filter(Boolean)
      .join('\n\n');
    try {
      const r = await runAgent({
        cwd: this.dir,
        prompt,
        abort,
        permissionMode: 'default',
        allowedTools: ['Read', 'Glob', 'Grep', 'LS', 'Bash(ls:*)', 'Bash(git log:*)', 'Bash(cat:*)'],
        extraTools: [writePlan],
        ctx: {
          projectId: this.id,
          stepId: '__plan',
          label: 'Rédaction du plan',
          cwd: this.dir,
          onEvent: (e) => {
            if (e.type === 'tool' || e.type === 'text') {
              this.planning = { ...this.planning, text: e.label || e.text.split('\n')[0].slice(0, 160) };
              this.emit();
            }
          },
        },
      });
      this.state.totalCost = (this.state.totalCost || 0) + (r.cost || 0);
      this.planning = r.ok ? null : { status: 'failed', text: r.text };
      if (r.ok) notify({ title: `${this.name} : plan prêt`, body: `${this.plan.steps.length} étapes. Relis-le puis lance.`, kind: 'success', projectId: this.id });
    } catch (e) {
      this.planning = { status: 'failed', text: String(e.message || e) };
    }
    this.save();
    this.loadPlan();
  }
}
