// Tests de bout en bout en mode simulé : `npm test`
// Aucun appel à Claude : l'agent simulé crée des fichiers, pose des questions et demande des autorisations.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-test-'));
process.env.MAESTRO_HOME = path.join(tmp, 'home');
process.env.MAESTRO_FAKE = '1';
process.env.MAESTRO_FAKE_SPEED = '20';
process.env.MAESTRO_PORT = '4799';

const { parsePlan, markStepDone, setItem } = await import('../src/plan.js');
const { manager } = await import('../src/manager.js');
const { inbox } = await import('../src/inbox.js');
const { updateConfig } = await import('../src/config.js');

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.stack}`);
    process.exitCode = 1;
  }
}
const wait = async (cond, ms = 8000) => {
  const t = Date.now();
  while (!(await cond())) {
    if (Date.now() - t > ms) throw new Error('Délai dépassé');
    await new Promise((r) => setTimeout(r, 25));
  }
};
function repo(name, plan) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' }).toString();
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  fs.writeFileSync(path.join(dir, 'PLAN.md'), plan);
  g('add', '-A');
  g('commit', '-qm', 'init');
  return { dir, g };
}

console.log('Plan');
await test('lit étapes, agents, dépendances et cases', () => {
  const p = parsePlan(`# Titre\nContexte\n\n## 1. A\nagent: back · après: aucune\n- [ ] x\n- [x] y\n\n## 2. B\n## Étape 3 — C\n**Après :** 1 et 2\nvalidation: auto\nTexte libre`);
  assert.equal(p.title, 'Titre');
  assert.equal(p.context, 'Contexte');
  assert.deepEqual(p.steps.map((s) => s.id), ['1', '2', '3']);
  assert.equal(p.steps[0].agent, 'back');
  assert.deepEqual(p.steps[0].after, []);
  assert.deepEqual(p.steps[1].after, ['1']);
  assert.deepEqual(p.steps[2].after, ['1', '2']);
  assert.equal(p.steps[2].autoValidate, true);
  assert.equal(p.steps[2].body, 'Texte libre');
  assert.equal(p.steps[0].items[1].done, true);
});
await test('coche les cases et marque une étape sans case', () => {
  let t = '# T\n## 1. A\n- [ ] x\n- [ ] y\n## 2. B\nrien';
  t = setItem(t, '1', 1, true);
  assert.match(t, /- \[ \] x\n- \[x\] y/);
  t = markStepDone(t, '2');
  assert.match(t, /## 2\. B ✅/);
  assert.equal(parsePlan(t).steps[1].done, true);
  t = markStepDone(t, '2', false);
  assert.equal(parsePlan(t).steps[1].done, false);
});
await test('détecte les boucles et dépendances inconnues', () => {
  const p = parsePlan('## 1. A\naprès: 2\n## 2. B\naprès: 1, 9');
  assert.ok(p.warnings.some((w) => /boucle/.test(w)));
  assert.ok(p.warnings.some((w) => /« 9 »/.test(w)));
});
await test('ignore les titres dans les blocs de code', () => {
  const p = parsePlan('## 1. A\n```md\n## pas une étape\n- [ ] pas une case\n```\n- [ ] vraie');
  assert.equal(p.steps.length, 1);
  assert.equal(p.steps[0].items.length, 1);
});

console.log('Orchestration');
updateConfig({ maxParallel: 3, autoValidate: false });

await test('parallélisme, question, autorisation, validation et fusion', async () => {
  const { dir, g } = repo('flow', `# Flow\n\n## 1. Base\nagent: back · après: aucune\n- [ ] Modèle\n\n## 2. Auth\nagent: back · après: 1\n- [ ] Login avec question\n\n## 3. Import\nagent: back · après: 1\n- [ ] Parser permission\n\n## 4. Fin\nagent: reviewer · après: 2, 3 · validation: auto\n- [ ] Relire\n`);
  const p = await manager.add(dir);
  p.start();
  await wait(() => p.summary().steps[0].status === 'review');
  assert.equal(p.summary().steps[1].status, 'blocked');
  await p.validate('1');
  await wait(() => inbox.list().filter((i) => i.projectId === p.id).length >= 2);
  const st = p.summary().steps;
  assert.equal(st[1].status, 'waiting');
  assert.equal(st[2].status, 'waiting');
  const q = inbox.list().find((i) => i.kind === 'question');
  const perm = inbox.list().find((i) => i.kind === 'permission');
  assert.ok(q && perm, 'question et autorisation attendues');
  assert.match(perm.title, /veut lancer une commande/);
  assert.ok(perm.explain?.steps?.length, 'la commande est expliquée en clair');
  inbox.resolve(q.id, { text: 'SQLite' });
  inbox.resolve(perm.id, { choice: 'deny' });
  await wait(() => p.summary().steps[1].status === 'review' && p.summary().steps[2].status === 'review');
  assert.ok(p.getLog('2').some((e) => e.type === 'answer' && e.text === 'SQLite'));
  assert.ok(p.getLog('3').some((e) => e.type === 'permission' && e.decision === 'deny'));
  assert.equal((await p.validate('2')).ok, true);
  assert.equal((await p.validate('3')).ok, true);
  await wait(() => p.summary().steps[3].status === 'done');
  assert.equal(p.state.running, false);
  const plan = fs.readFileSync(path.join(dir, 'PLAN.md'), 'utf8');
  assert.equal((plan.match(/\[x\]/g) || []).length, 4);
  assert.match(g('log', '--oneline'), /étape 4 : Fin/);
  assert.equal(g('worktree', 'list').trim().split('\n').length, 1, 'worktrees nettoyés');
  assert.equal(g('branch').includes('maestro/'), false, 'branches nettoyées');
});

await test('conflit de fusion puis résolution par l\'agent', async () => {
  const { dir, g } = repo('conflict', `# C\n\n## 1. Gauche\naprès: aucune\n- [ ] Fichier commun\n\n## 2. Droite\naprès: aucune\n- [ ] Fichier commun\n`);
  const p = await manager.add(dir);
  p.start();
  await wait(() => p.summary().steps.every((s) => s.status === 'review'));
  assert.equal((await p.validate('1')).ok, true);
  const r = await p.validate('2');
  assert.equal(r.ok, false);
  assert.equal(p.summary().steps[1].status, 'conflict');
  assert.ok(inbox.list().some((i) => i.kind === 'conflict' && i.projectId === p.id));
  assert.equal(g('status', '--porcelain').includes('UU'), false, 'dossier utilisateur propre après conflit');
  // L'agent simulé ne sait pas résoudre : on simule sa résolution dans le worktree.
  const wt = p.state.steps['2'].worktree;
  const w = (...a) => execFileSync('git', a, { cwd: wt, stdio: 'pipe' }).toString();
  try { w('merge', 'main'); } catch {}
  fs.writeFileSync(path.join(wt, 'src/fichier-commun.js'), '// fusionné\n');
  w('add', '-A');
  w('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'résolution');
  assert.equal((await p.validate('2')).ok, true);
  assert.equal(fs.readFileSync(path.join(dir, 'src/fichier-commun.js'), 'utf8'), '// fusionné\n');
});

await test('arrêt, reprise et message à un agent', async () => {
  process.env.MAESTRO_FAKE_SPEED = '1';
  const { dir } = repo('stop', `# S\n\n## 1. Long\n- [ ] Un\n- [ ] Deux\n- [ ] Trois\n`);
  const p = await manager.add(dir);
  p.start();
  await wait(() => p.summary().steps[0].status === 'running');
  p.stop('1');
  await wait(() => p.summary().steps[0].status === 'stopped');
  process.env.MAESTRO_FAKE_SPEED = '20';
  p.retry('1');
  await wait(() => p.summary().steps[0].status === 'running');
  const r = await p.message('1', 'Ajoute aussi un test');
  assert.equal(r.queued, true);
  await wait(() => p.summary().steps[0].status === 'review');
  assert.ok(p.getLog('1').some((e) => e.type === 'text' && /Ajoute aussi un test/.test(e.text)), 'message traité après le tour');
});

await test('projet sans git : une étape à la fois, dans le dossier', async () => {
  const dir = path.join(tmp, 'nogit');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'PLAN.md'), '# N\n## 1. A\naprès: aucune\n- [ ] Un\n## 2. B\naprès: aucune\n- [ ] Deux\n');
  const p = await manager.add(dir);
  assert.equal(p.isGit, false);
  p.start();
  await wait(() => p.summary().steps.some((s) => s.status === 'running'));
  assert.equal(p.summary().steps.filter((s) => s.status === 'running').length, 1);
  await wait(() => p.summary().steps[0].status === 'review');
  assert.ok(fs.existsSync(path.join(dir, 'src/un.js')));
  await p.validate('1');
  await wait(() => p.summary().steps[1].status === 'review');
});

console.log('Assistant');
await test('mode vocal : consigne de réponse parlée et messages marqués', async () => {
  const { assistant, VOICE_HINT } = await import('../src/assistant.js');
  assistant.init();
  const before = assistant.data.messages.length;
  assistant.send('Où en sont mes projets ?', { voice: true });
  await wait(() => assistant.data.messages.length >= before + 2 && !assistant.busy);
  const [q, a] = assistant.data.messages.slice(before);
  assert.equal(q.voice, true);
  assert.equal(q.text, 'Où en sont mes projets ?', 'la consigne vocale reste invisible dans la conversation');
  assert.equal(a.role, 'assistant');
  assert.equal(a.voice, true);
  assert.doesNotMatch(a.text, /[*_#`]/, 'réponse sans Markdown, prête à être lue');
  assert.match(VOICE_HINT, /voix haute/);
  assistant.send('Et en texte ?');
  await wait(() => assistant.data.messages.length >= before + 4 && !assistant.busy);
  assert.equal(assistant.data.messages.at(-1).voice, undefined);
  assert.match(assistant.data.messages.at(-1).text, /\*\*/);
});

console.log('Compte Claude');
const claudeHome = path.join(tmp, 'claude');
process.env.CLAUDE_CONFIG_DIR = claudeHome;
const skill = (dir, name, desc) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: >\n  ${desc}\n  sur deux lignes\n---\n# ${name}\nCorps du skill.`);
};
skill(path.join(claudeHome, 'skills', 'veille'), 'veille', 'Fait ma veille');
skill(path.join(claudeHome, 'plugins', 'cache', 'mkt', 'outils', '1.0', 'skills', 'pdf'), 'pdf', 'Lit des PDF');
fs.writeFileSync(path.join(claudeHome, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'outils@mkt': [{ installPath: path.join(claudeHome, 'plugins', 'cache', 'mkt', 'outils', '1.0') }] } }));
skill(path.join(claudeHome, 'scheduled-tasks', 'brief'), 'brief', 'Brief du matin');
await test('liste les skills perso, des plugins et les tâches planifiées', async () => {
  const { listSkills, listScheduledTasks, readSkillContent } = await import('../src/claude-account.js');
  const skills = listSkills();
  assert.deepEqual(skills.map((s) => s.name), ['outils:pdf', 'veille']);
  assert.equal(skills.find((s) => s.name === 'veille').description, 'Fait ma veille sur deux lignes');
  assert.deepEqual(listScheduledTasks().map((t) => t.name), ['brief']);
  assert.match(readSkillContent('pdf').content, /Corps du skill/);
  assert.equal(readSkillContent('inconnu'), null);
});
await test("lecture sans autorisation, écriture via la boîte « À traiter »", async () => {
  const { isReadOnlyCall } = await import('../src/claude-account.js');
  const { permissionHandler } = await import('../src/agent.js');
  assert.ok(isReadOnlyCall('mcp__claude_ai_Gmail__search_threads'));
  assert.ok(isReadOnlyCall('mcp__claude_ai_Gmail__list_labels'));
  assert.ok(isReadOnlyCall('RemoteTrigger', { action: 'list' }));
  assert.ok(!isReadOnlyCall('RemoteTrigger', { action: 'run' }));
  assert.ok(!isReadOnlyCall('mcp__claude_ai_Gmail__send_message'));
  assert.ok(!isReadOnlyCall('mcp__claude_ai_Gmail__create_draft'));
  assert.ok(!isReadOnlyCall('mcp__notion__get_or_create_page'));
  assert.ok(!isReadOnlyCall('Bash', { command: 'ls' }));
  const events = [];
  const ctx = { projectId: null, stepId: '__assistant', label: 'Assistant', autoAllow: isReadOnlyCall, onEvent: (e) => events.push(e) };
  const r = await permissionHandler(ctx)('mcp__claude_ai_Gmail__get_thread', { id: 'x' }, { signal: new AbortController().signal });
  assert.equal(r.behavior, 'allow');
  assert.equal(events[0].decision, 'auto');
  const pending = permissionHandler(ctx)('mcp__claude_ai_Gmail__send_message', {}, { signal: new AbortController().signal });
  await wait(() => inbox.list().some((i) => i.tool === 'mcp__claude_ai_Gmail__send_message'));
  const item = inbox.list().find((i) => i.tool === 'mcp__claude_ai_Gmail__send_message');
  assert.equal(item.explain.risk, 'danger');
  assert.match(item.explain.warnings.join(' '), /envoyé/);
  inbox.resolve(item.id, { choice: 'deny' });
  assert.equal((await pending).behavior, 'deny');
});
await test('newsletters : lues depuis le résultat des routines claude.ai, sans autorisation', async () => {
  const { assistant } = await import('../src/assistant.js');
  const { isReadOnlyCall } = await import('../src/claude-account.js');
  const sys = assistant.systemAppend();
  assert.match(sys, /newsletters : il les génère lui-même avec ses routines claude\.ai/);
  assert.match(sys, /list_runs/);
  assert.match(sys, /get_run_log/);
  assert.ok(isReadOnlyCall('RemoteTrigger', { action: 'list_runs', trigger_id: 't' }));
  assert.ok(isReadOnlyCall('RemoteTrigger', { action: 'get_run_log', session_id: 's' }));
  assert.ok(!isReadOnlyCall('RemoteTrigger', { action: 'update', trigger_id: 't' }));
});
await test("l'assistant s'appelle Chlamyd.I.A.", async () => {
  const { assistant } = await import('../src/assistant.js');
  const sys = assistant.systemAppend();
  assert.match(sys, /Tu t'appelles Chlamyd\.I\.A\./);
  assert.doesNotMatch(sys.replace(/jamais « Maestro »/, ''), /Maestro/);
});
await test("l'assistant répond sur tes skills", async () => {
  const { assistant } = await import('../src/assistant.js');
  const before = assistant.data.messages.length;
  assistant.send('Quels skills j\'ai ?', { voice: true });
  await wait(() => assistant.data.messages.length >= before + 2 && !assistant.busy);
  assert.match(assistant.data.messages.at(-1).text, /2 skills : outils:pdf, veille/);
});

console.log('Projets et routines claude.ai');
await test("importe les projets d'un export claude.ai (zip) et les lit", async () => {
  const { importClaudeExport, listClaudeProjects, readClaudeProject, searchClaudeProjects } = await import('../src/claude-sync.js');
  const exp = path.join(tmp, 'export', 'data-2026');
  fs.mkdirSync(exp, { recursive: true });
  fs.writeFileSync(path.join(exp, 'conversations.json'), '[]');
  fs.writeFileSync(path.join(exp, 'projects.json'), JSON.stringify([
    { uuid: 'u1', name: 'Agence Créa', description: 'Mes clients', prompt_template: 'Réponds comme un DA.', docs: [{ filename: 'charte.md', content: 'Couleur principale : bleu nuit.' }, { filename: '../evil.md', content: 'x' }] },
    { uuid: 'u2', name: 'Exemple', is_starter_project: true, docs: [] },
  ]));
  const zip = path.join(tmp, 'export.zip');
  execFileSync('zip', ['-qr', zip, 'data-2026'], { cwd: path.join(tmp, 'export') });
  const r = importClaudeExport(zip);
  assert.equal(r.projects, 1);
  assert.equal(r.docs, 2);
  const [p] = listClaudeProjects();
  assert.equal(p.name, 'Agence Créa');
  assert.equal(p.instructions, 'Réponds comme un DA.');
  assert.deepEqual(p.docs.sort(), ['charte.md', 'evil.md']);
  assert.ok(!fs.existsSync(path.join(process.env.MAESTRO_HOME, 'claude', 'projects', 'evil.md')), 'pas de sortie du dossier');
  assert.match(readClaudeProject('agence', 'charte').content, /bleu nuit/);
  assert.equal(searchClaudeProjects('couleur bleu')[0].document, 'charte.md');
  assert.equal(importClaudeExport(path.join(tmp, 'export')).projects, 1, 'réimport depuis le dossier, sans doublon');
  assert.equal(listClaudeProjects().length, 1);
  assert.throws(() => importClaudeExport(path.join(tmp, 'nulle-part.zip')), /introuvable/);
});
await test('récupère les routines claude.ai et en copie une ici', async () => {
  const { fetchClaudeRoutines, getClaudeRoutines, copyRoutineLocally } = await import('../src/claude-sync.js');
  const { getConfig } = await import('../src/config.js');
  await fetchClaudeRoutines();
  const rt = getClaudeRoutines();
  assert.ok(rt.fetchedAt);
  assert.deepEqual(rt.routines.map((r) => r.name), ['Newsletter IA', 'Veille horaire']);
  const local = copyRoutineLocally('trig_veille');
  assert.equal(local.time, '08:00');
  assert.deepEqual(local.days, [1, 2, 3, 4, 5]);
  assert.ok(getConfig().routines.some((r) => r.claudeId === 'trig_veille'));
  assert.throws(() => copyRoutineLocally('trig_veille'), /déjà copiée/);
  assert.throws(() => copyRoutineLocally('trig_heure'), /heure fixe/);
});
await test("l'assistant lit les projets claude.ai importés", async () => {
  const { assistant } = await import('../src/assistant.js');
  const tool = assistant.tools().find((t) => t.name === 'claude_projects');
  assert.match(await tool.handler({ action: 'list' }), /Agence Créa/);
  assert.match(await tool.handler({ action: 'read', name: 'Agence Créa' }), /Réponds comme un DA/);
  assert.match(await tool.handler({ action: 'read', name: 'Agence Créa', doc: 'charte.md' }), /bleu nuit/);
  assert.match(assistant.systemAppend(), /claude_projects/);
});

console.log('Connexions');
await test('reconnaît, vérifie et range les clés sans jamais les exposer', async () => {
  const { detectProvider, connect, publicInfo, getKey, claudeEnv, disconnect, pickModel } = await import('../src/providers.js');
  assert.equal(detectProvider('sk-ant-api03-abcdefghijklmnopqrstuvwxyz'), 'anthropic');
  assert.equal(detectProvider('sk-proj-abcdefghijklmnopqrstuvwxyz'), 'openai');
  assert.equal(detectProvider('AIzaSyAbcdefghijklmnopqrstuvwxyz0123456'), 'google');
  assert.equal(detectProvider('bonjour'), null);
  await assert.rejects(() => connect('bonjour'), /reconnais pas/);
  const info = await connect('  "sk-proj-abcdefghijklmnopqrstuvwxyz1234"  ');
  assert.equal(info.id, 'openai');
  assert.equal(info.connected, true);
  assert.equal(info.hint, '…1234');
  assert.ok(!JSON.stringify(publicInfo()).includes('abcdefghij'), 'la clé ne sort pas du serveur');
  assert.equal(getKey('openai'), 'sk-proj-abcdefghijklmnopqrstuvwxyz1234');
  const mode = fs.statSync(path.join(process.env.MAESTRO_HOME, 'keys.json')).mode & 0o777;
  assert.equal(mode, 0o600, 'fichier lisible par toi seul');
  assert.equal(claudeEnv(), undefined, 'sans clé Claude, on garde la connexion Claude Code');
  await connect('sk-ant-api03-abcdefghijklmnopqrstuvwxyz');
  assert.equal(claudeEnv().ANTHROPIC_API_KEY, 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz');
  disconnect('anthropic');
  assert.equal(claudeEnv(), undefined);
  assert.equal(pickModel('openai', ['gpt-4o', 'gpt-5-mini', 'gpt-5', 'gpt-4o-audio-preview']), 'gpt-5');
  assert.equal(pickModel('google', ['gemini-2.0-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite']), 'gemini-2.5-pro');
});
await test("l'assistant peut discuter avec ChatGPT à la place de Claude", async () => {
  const { assistant } = await import('../src/assistant.js');
  const { updateConfig } = await import('../src/config.js');
  updateConfig({ assistant: { provider: 'openai' } });
  const before = assistant.data.messages.length;
  assistant.send('Bonjour toi');
  await wait(() => assistant.data.messages.length >= before + 2 && !assistant.busy);
  const a = assistant.data.messages.at(-1);
  assert.equal(a.provider, 'openai');
  assert.match(a.text, /simulation ChatGPT/);
  assert.match(await assistant.systemOther('openai'), /propulsé ici par ChatGPT/);
  updateConfig({ assistant: { provider: 'claude' } });
});

await test('modèle local gratuit : installation, connexion et discussion', async () => {
  const { connectLocal, pullLocalModel, publicInfo, LOCAL_MODELS } = await import('../src/providers.js');
  const { assistant } = await import('../src/assistant.js');
  const { updateConfig } = await import('../src/config.js');
  await assert.rejects(() => connectLocal(), /aucun modèle/);
  await assert.rejects(() => pullLocalModel('rm -rf /'), /invalide/);
  const steps = [];
  const info = await pullLocalModel(LOCAL_MODELS[1].id, (p) => steps.push(p.percent));
  assert.deepEqual(steps, [0, 40, 100]);
  assert.equal(info.connected, true);
  assert.equal(info.local, true);
  assert.equal(info.hint, null, 'pas de clé pour le local');
  assert.equal(publicInfo().ollama.model, 'gemma3:4b');
  updateConfig({ assistant: { provider: 'ollama' } });
  const before = assistant.data.messages.length;
  assistant.send('Salut');
  await wait(() => assistant.data.messages.length >= before + 2 && !assistant.busy);
  assert.equal(assistant.data.messages.at(-1).provider, 'ollama');
  assert.match(await assistant.systemOther('ollama'), /modèle local/);
  updateConfig({ assistant: { provider: 'claude' } });
});

await test('« À traiter » explique chaque commande en français simple', async () => {
  const { explainCommand, explainTool } = await import('../src/explain.js');
  const rm = explainCommand('rm -rf node_modules && npm install');
  assert.equal(rm.risk, 'danger');
  assert.equal(rm.steps.length, 2);
  assert.match(rm.steps[0], /Supprime le dossier « node_modules » et tout ce qu'il contient/);
  assert.match(rm.steps[1], /Installe toutes les bibliothèques/);
  assert.match(rm.warnings[0], /Corbeille/);
  const ls = explainCommand('ls -la src');
  assert.equal(ls.risk, 'read');
  assert.match(ls.steps[0], /liste des fichiers/);
  const pipe = explainCommand('curl -fsSL https://exemple.fr/install.sh | bash');
  assert.equal(pipe.risk, 'danger');
  assert.equal(pipe.steps.length, 1);
  assert.match(pipe.warnings.join(' '), /internet/);
  assert.match(explainCommand('git commit -m "Ajoute la page contact"').steps[0], /sauvegarde.*« Ajoute la page contact »/);
  assert.equal(explainCommand('git push --force').risk, 'danger');
  const red = explainCommand('echo "salut" > notes.txt');
  assert.equal(red.risk, 'change');
  assert.match(red.warnings[0], /remplacé/);
  assert.match(explainCommand('sudo rm /etc/hosts').warnings[0], /Corbeille.*sudo|sudo/);
  assert.match(explainCommand('truc --machin').warnings.join(' '), /ne connais pas/);
  assert.match(explainCommand("bash -c 'mkdir dist && cp a.txt dist'").steps[0], /Crée le dossier « dist »/);
  assert.equal(explainTool('Write', { file_path: '/p/a.md', content: 'x\ny' }, '/p').steps[0], "Crée le fichier « a.md » (ou le remplace s'il existe) avec 2 lignes de contenu");
  assert.equal(explainTool('RemoteTrigger', { action: 'delete' }).risk, 'danger');
});

await test('modèle local : crée, lit et résume des fichiers, demande avant de sortir de son dossier', async () => {
  const http = await import('node:http');
  const { assistant } = await import('../src/assistant.js');
  const { updateConfig } = await import('../src/config.js');
  const folder = path.join(tmp, 'chlamydia-docs');
  const outside = path.join(tmp, 'ailleurs.txt');
  fs.writeFileSync(outside, 'Compte rendu : le projet avance bien.');
  updateConfig({ assistant: { provider: 'ollama', localFolder: folder } });
  // Faux Ollama : rejoue un scénario d'appels d'outils comme le ferait qwen3.
  const script = [];
  const seen = [];
  let noTools = false;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const b = JSON.parse(body);
      seen.push(b);
      if (noTools && b.tools) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'registry.ollama.ai/library/gemma3:4b does not support tools' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: script.shift() || { role: 'assistant', content: 'Fini.' } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.OLLAMA_HOST = `http://127.0.0.1:${server.address().port}`;
  const call = (name, args) => ({ role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] });
  const turn = async (text) => {
    const before = assistant.data.messages.length;
    assistant.send(text);
    await wait(() => assistant.data.messages.length >= before + 2 && !assistant.busy);
    return assistant.data.messages.at(-1);
  };
  try {
    // 1. Créer un fichier dans son dossier : aucune question.
    script.push(call('write_file', { path: 'courses.md', content: '- pain\n- lait' }), { role: 'assistant', content: "<think>ok</think>J'ai créé courses.md." });
    let m = await turn('Crée un fichier courses.md avec du pain et du lait');
    assert.equal(fs.readFileSync(path.join(folder, 'courses.md'), 'utf8'), '- pain\n- lait');
    assert.equal(m.text, "J'ai créé courses.md.");
    assert.equal(m.tools[0].label, 'Écrit courses.md');
    assert.ok(seen[0].tools.some((t) => t.function.name === 'read_file'), 'les outils sont proposés au modèle');
    assert.match(seen[0].messages[0].content, /dossier de travail/);
    assert.equal(seen[1].messages.at(-1).role, 'tool');
    assert.match(seen[1].messages.at(-1).content, /Fichier créé/);
    // 2. Compléter puis lire pour résumer (arguments en texte JSON, comme certains modèles).
    script.push(call('append_file', { path: 'courses.md', content: '- œufs' }), call('read_file', JSON.stringify({ path: 'courses.md' })), { role: 'assistant', content: 'Trois courses : pain, lait, œufs.' });
    m = await turn('Ajoute des œufs puis résume');
    assert.equal(m.text, 'Trois courses : pain, lait, œufs.');
    assert.match(seen.at(-1).messages.at(-1).content, /- œufs/);
    // 3. Lire hors de son dossier : demande d'accord expliquée, puis refus.
    script.push(call('read_file', { path: outside }), { role: 'assistant', content: "Tu as refusé, je n'ai pas lu le fichier." });
    const pending = turn('Résume ailleurs.txt');
    await wait(() => inbox.list().some((i) => i.tool === 'local'));
    const ask = inbox.list().find((i) => i.tool === 'local');
    assert.match(ask.title, /hors de son dossier/);
    assert.equal(ask.explain.risk, 'read');
    assert.match(ask.explain.steps[0], /ailleurs\.txt/);
    assert.deepEqual(ask.options.map((o) => o.id), ['allow', 'deny']);
    inbox.resolve(ask.id, { choice: 'deny' });
    m = await pending;
    assert.match(seen.at(-1).messages.at(-1).content, /Refusé/);
    // 4. Même chose, acceptée : il lit le fichier.
    script.push(call('read_file', { path: outside }), { role: 'assistant', content: 'Le projet avance bien.' });
    const ok = turn('Résume ailleurs.txt, je suis d\'accord');
    await wait(() => inbox.list().some((i) => i.tool === 'local'));
    inbox.resolve(inbox.list().find((i) => i.tool === 'local').id, { choice: 'allow' });
    m = await ok;
    assert.match(seen.at(-1).messages.at(-1).content, /le projet avance bien/);
    // 5. Pas de « .. » pour s'échapper sans demander.
    script.push(call('write_file', { path: '../evasion.txt', content: 'x' }), { role: 'assistant', content: 'ok' });
    const esc = turn('Écris ../evasion.txt');
    await wait(() => inbox.list().some((i) => i.tool === 'local'));
    inbox.resolve(inbox.list().find((i) => i.tool === 'local').id, { choice: 'deny' });
    await esc;
    assert.equal(fs.existsSync(path.join(tmp, 'evasion.txt')), false);
    // 6. Modèle sans outils (Gemma) : il discute quand même et explique pourquoi il ne touche pas aux fichiers.
    noTools = true;
    m = await turn('Salut');
    assert.match(m.text, /ne sait pas utiliser d'outils/);
  } finally {
    delete process.env.OLLAMA_HOST;
    server.close();
    updateConfig({ assistant: { provider: 'claude' } });
  }
});

await test('crédit épuisé : explique quoi faire au lieu du message brut', async () => {
  const { friendlyError } = await import('../src/agent.js');
  const { connect, disconnect } = await import('../src/providers.js');
  const m = friendlyError(new Error('Claude Code returned an error result: Credit balance is too low'));
  assert.match(m, /Plus de crédit sur la clé API utilisée par Claude Code/);
  assert.match(m, /abonnement Claude/);
  assert.doesNotMatch(m, /Credit balance/);
  await connect('sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123');
  assert.match(friendlyError('Credit balance is too low'), /ta clé Claude enregistrée dans Connexions/);
  disconnect('anthropic');
  assert.equal(friendlyError('autre souci'), 'autre souci');
});

console.log(`\n${passed} test(s) réussi(s)${process.exitCode ? ', des échecs' : ''}.`);
for (const pr of manager.projects.values()) pr.dispose();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(process.exitCode || 0);
