// Lecture et mise à jour de PLAN.md.
//
// Format (souple, FR ou EN) :
//
//   # Nom du projet
//   Contexte général envoyé à tous les agents.
//
//   ## 1. Base de données
//   agent: backend · après: aucune · validation: auto
//   - [ ] Schéma
//   - [ ] Migrations
//   Instructions libres pour l'agent…
//
//   ## 2. API d'authentification
//   agent: backend · après: 1
//
// Sans ligne « après: », une étape dépend de la précédente (exécution séquentielle).

const META_KEYS = {
  agent: 'agent',
  role: 'agent',
  'après': 'after',
  apres: 'after',
  after: 'after',
  'dépend de': 'after',
  'depend de': 'after',
  'dépend': 'after',
  depends: 'after',
  'depends on': 'after',
  needs: 'after',
  'modèle': 'model',
  modele: 'model',
  model: 'model',
  validation: 'validation',
  review: 'validation',
};

const META_RE = new RegExp(
  `^\\s*(?:[-*]\\s+)?\\**(${Object.keys(META_KEYS)
    .sort((a, b) => b.length - a.length)
    .map((k) => k.replace(/ /g, '\\s+'))
    .join('|')})\\**\\s*:`,
  'i',
);
const CHECK_RE = /^(\s*[-*+]\s+)\[( |x|X)\]\s+(.*)$/;
const H1_RE = /^#\s+(.+?)\s*#*\s*$/;
const H2_RE = /^##\s+(.+?)\s*#*\s*$/;
const DONE_MARK = '✅';
const NO_DEPS = /^(—|–|-|aucune?|rien|none|no|non|parall[eè]le|\/)$/i;

function parseHeading(raw) {
  let text = raw.trim();
  let done = false;
  if (text.endsWith(DONE_MARK)) {
    done = true;
    text = text.slice(0, -DONE_MARK.length).trim();
  }
  if (/^\[(x|X)\]\s*/.test(text)) {
    done = true;
    text = text.replace(/^\[(x|X)\]\s*/, '');
  }
  text = text.replace(/^\[ \]\s*/, '');
  let id = null;
  const m =
    text.match(/^(?:[ée]tape|step|phase|t[aâ]che|task)\s*(\d+[a-z]?)\s*[—–\-:.)]*\s*(.*)$/i) ||
    text.match(/^(\d+[a-z]?)\s*[—–\-:.)]+\s*(.*)$/i) ||
    text.match(/^(\d+[a-z]?)\s+(.*)$/i);
  if (m) {
    id = m[1].toLowerCase();
    text = m[2].trim() || text;
  }
  return { id, title: text, done };
}

function parseMetaLine(line, meta) {
  const segments = line.split(/\s*[·•|]\s*|\s{2,}(?=\w+\s*:)/);
  let matched = false;
  for (const seg of segments) {
    const m = seg.match(META_RE);
    if (!m) continue;
    matched = true;
    const key = META_KEYS[m[1].toLowerCase().replace(/\s+/g, ' ')];
    const value = seg.slice(m[0].length).replace(/\*\*/g, '').trim();
    meta[key] = value;
  }
  return matched;
}

function parseDeps(value) {
  if (value == null) return null;
  const v = value.trim();
  if (!v || NO_DEPS.test(v)) return [];
  return v
    .split(/\s*(?:,|;|\bet\b|\band\b|&|\+)\s*/i)
    .map((s) => s.replace(/^(?:[ée]tape|step|#)\s*/i, '').trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Analyse le texte d'un PLAN.md.
 * @returns {{ title: string, context: string, steps: Step[], warnings: string[] }}
 */
export function parsePlan(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const steps = [];
  const warnings = [];
  let title = '';
  const contextLines = [];
  let current = null;
  let inFence = false;

  lines.forEach((line, idx) => {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence) {
      const h1 = line.match(H1_RE);
      if (h1 && !current && !title) {
        title = h1[1].trim();
        return;
      }
      const h2 = line.match(H2_RE);
      if (h2) {
        const h = parseHeading(h2[1]);
        current = {
          rawId: h.id,
          title: h.title,
          headingDone: h.done,
          headingLine: idx,
          meta: {},
          items: [],
          bodyLines: [],
          endLine: idx,
        };
        steps.push(current);
        return;
      }
    }
    if (!current) {
      contextLines.push(line);
      return;
    }
    current.endLine = idx;
    if (!inFence) {
      const c = line.match(CHECK_RE);
      if (c) {
        current.items.push({ line: idx, text: c[3].trim(), done: c[2].toLowerCase() === 'x' });
        return;
      }
      if (current.bodyLines.filter((l) => l.trim()).length === 0 && parseMetaLine(line, current.meta)) {
        return;
      }
    }
    current.bodyLines.push(line);
  });

  // Identifiants : numéro du titre, sinon position.
  const used = new Set();
  steps.forEach((s, i) => {
    let id = s.rawId || String(i + 1);
    while (used.has(id)) id = `${id}b`;
    used.add(id);
    s.id = id;
  });
  const ids = steps.map((s) => s.id);

  const result = steps.map((s, i) => {
    let after = parseDeps(s.meta.after);
    if (after === null) after = i > 0 ? [steps[i - 1].id] : [];
    after = after.filter((d) => {
      if (d === s.id) return false;
      if (!ids.includes(d)) {
        warnings.push(`Étape ${s.id} : dépendance « ${d} » introuvable, ignorée.`);
        return false;
      }
      return true;
    });
    const itemsDone = s.items.length > 0 && s.items.every((it) => it.done);
    const validation = (s.meta.validation || '').toLowerCase();
    return {
      id: s.id,
      title: s.title,
      agent: (s.meta.agent || '').trim() || null,
      model: (s.meta.model || '').trim() || null,
      autoValidate: /^(auto|automatique|automatic|non|no|aucune|none)$/.test(validation)
        ? true
        : /^(manuelle?|manual|oui|yes|moi)$/.test(validation)
          ? false
          : null,
      after,
      items: s.items.map(({ text, done }) => ({ text, done })),
      body: s.bodyLines.join('\n').trim(),
      done: s.headingDone || itemsDone,
      headingLine: s.headingLine,
    };
  });

  if (hasCycle(result)) warnings.push('Les dépendances forment une boucle : certaines étapes ne démarreront jamais.');

  return {
    title: title || 'Projet sans titre',
    context: contextLines.join('\n').trim(),
    steps: result,
    warnings,
  };
}

function hasCycle(steps) {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const state = new Map();
  const visit = (id) => {
    if (state.get(id) === 1) return true;
    if (state.get(id) === 2) return false;
    state.set(id, 1);
    for (const d of byId.get(id)?.after || []) if (visit(d)) return true;
    state.set(id, 2);
    return false;
  };
  return steps.some((s) => visit(s.id));
}

/** Coche/décoche une case d'une étape. */
export function setItem(text, stepId, index, checked) {
  return editStep(text, stepId, (lines, step) => {
    const item = step.itemLines[index];
    if (item == null) return;
    lines[item] = lines[item].replace(/\[( |x|X)\]/, checked ? '[x]' : '[ ]');
  });
}

/** Marque une étape terminée : toutes les cases cochées, ou ✅ sur le titre s'il n'y en a pas. */
export function markStepDone(text, stepId, done = true) {
  return editStep(text, stepId, (lines, step) => {
    if (step.itemLines.length) {
      for (const l of step.itemLines) lines[l] = lines[l].replace(/\[( |x|X)\]/, done ? '[x]' : '[ ]');
    }
    const h = lines[step.headingLine];
    const has = h.trimEnd().endsWith(DONE_MARK);
    if (!step.itemLines.length && done && !has) lines[step.headingLine] = `${h.trimEnd()} ${DONE_MARK}`;
    if (!done && has) lines[step.headingLine] = h.trimEnd().slice(0, -DONE_MARK.length).trimEnd();
  });
}

function editStep(text, stepId, fn) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const parsed = parsePlan(text);
  const step = parsed.steps.find((s) => s.id === stepId);
  if (!step) return text;
  // Retrouver les lignes des cases de cette étape.
  const next = parsed.steps.find((s) => s.headingLine > step.headingLine);
  const end = next ? next.headingLine : lines.length;
  const itemLines = [];
  let inFence = false;
  for (let i = step.headingLine + 1; i < end; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) inFence = !inFence;
    if (!inFence && CHECK_RE.test(lines[i])) itemLines.push(i);
  }
  fn(lines, { headingLine: step.headingLine, itemLines });
  return lines.join(eol);
}

export const PLAN_TEMPLATE = `# Mon projet

Décris ici le contexte général : stack, conventions, ce qu'il ne faut pas toucher.
Ce texte est transmis à chaque agent.

## 1. Mise en place
agent: backend · après: aucune
- [ ] Initialiser la structure du projet
- [ ] Ajouter les scripts de test

## 2. Interface
agent: frontend · après: 1
- [ ] Page d'accueil
- [ ] Formulaire de connexion

## 3. API
agent: backend · après: 1
- [ ] Endpoint /login
- [ ] Tests d'intégration

## 4. Relecture finale
agent: reviewer · après: 2, 3 · validation: manuelle
Relis l'ensemble, corrige les incohérences et mets à jour le README.
`;
