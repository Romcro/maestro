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
  inbox.resolve(item.id, { choice: 'deny' });
  assert.equal((await pending).behavior, 'deny');
});
await test("l'assistant répond sur tes skills", async () => {
  const { assistant } = await import('../src/assistant.js');
  const before = assistant.data.messages.length;
  assistant.send('Quels skills j\'ai ?', { voice: true });
  await wait(() => assistant.data.messages.length >= before + 2 && !assistant.busy);
  assert.match(assistant.data.messages.at(-1).text, /2 skills : outils:pdf, veille/);
});

console.log(`\n${passed} test(s) réussi(s)${process.exitCode ? ', des échecs' : ''}.`);
for (const pr of manager.projects.values()) pr.dispose();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(process.exitCode || 0);
