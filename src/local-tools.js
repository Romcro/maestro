// Outils du modèle local (Ollama) : créer, écrire, lire et lister des fichiers.
// Il travaille librement dans son dossier (par défaut ~/Documents/Chlamyd.I.A.).
// Lire ou écrire ailleurs passe par ta boîte « À traiter », avec l'explication de ce qu'il veut faire.
// Il n'a aucun outil pour supprimer ni pour lancer des commandes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inbox } from './inbox.js';
import { getConfig } from './config.js';
import { ollamaChat } from './providers.js';

const MAX_READ = 40_000;
const MAX_ROUNDS = 8;

export function localFolder() {
  const f = getConfig().assistant?.localFolder;
  return f ? path.resolve(f.replace(/^~(?=$|\/)/, os.homedir())) : path.join(os.homedir(), 'Documents', 'Chlamyd.I.A.');
}

/** Chemin absolu : relatif au dossier du modèle, ~ pour le dossier personnel. */
function resolvePath(p) {
  const s = String(p || '').trim().replace(/^~(?=$|\/)/, os.homedir());
  return path.resolve(localFolder(), s || '.');
}

/** Vrai si le chemin est dans son dossier (liens symboliques suivis pour ce qui existe déjà). */
export function insideFolder(abs) {
  const real = (p) => {
    let cur = p;
    const rest = [];
    while (!fs.existsSync(cur) && path.dirname(cur) !== cur) {
      rest.unshift(path.basename(cur));
      cur = path.dirname(cur);
    }
    try { cur = fs.realpathSync(cur); } catch {}
    return path.join(cur, ...rest);
  };
  fs.mkdirSync(localFolder(), { recursive: true });
  const rel = path.relative(real(localFolder()), real(abs));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

const home = os.homedir();
const show = (abs) => (abs.startsWith(`${home}/`) ? `~/${abs.slice(home.length + 1)}` : abs);

/** Demande ton accord pour sortir de son dossier. Renvoie true si tu acceptes. */
async function askOutside({ verb, abs, steps, risk, warnings, preview }, ctx) {
  const answer = await inbox.add(
    {
      kind: 'permission',
      projectId: null,
      stepId: '__assistant',
      title: `Le modèle local veut ${verb} hors de son dossier`,
      notifyBody: steps.join(', puis '),
      detail: `Son dossier est ${show(localFolder())}. Ce fichier est ailleurs, donc il te demande.`,
      tool: 'local',
      explain: { steps, risk, warnings },
      preview: preview ?? show(abs),
      options: [
        { id: 'allow', label: 'Autoriser' },
        { id: 'deny', label: 'Refuser' },
      ],
    },
    { wait: true, signal: ctx.signal },
  );
  return answer?.choice === 'allow';
}

const isText = (buf) => !buf.subarray(0, 8000).includes(0);

export const TOOLS = [
  {
    name: 'list_files',
    description: "Liste les fichiers et dossiers d'un dossier. Sans chemin : ton dossier de travail.",
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Dossier à lister (facultatif).' } } },
    label: (a) => `Regarde le dossier ${a.path || 'de travail'}`,
    async run({ path: p }, ctx) {
      const abs = resolvePath(p);
      if (!insideFolder(abs) && !(await askOutside({ verb: 'regarder un dossier', abs, steps: [`Affiche la liste des fichiers de « ${show(abs)} »`], risk: 'read', warnings: [] }, ctx))) return "Refusé par l'utilisateur.";
      if (!fs.existsSync(abs)) return `Le dossier ${show(abs)} n'existe pas.`;
      const entries = fs.readdirSync(abs, { withFileTypes: true }).filter((e) => !e.name.startsWith('.'));
      if (!entries.length) return `Le dossier ${show(abs)} est vide.`;
      return entries.slice(0, 200).map((e) => (e.isDirectory() ? `${e.name}/` : `${e.name} (${fs.statSync(path.join(abs, e.name)).size} octets)`)).join('\n');
    },
  },
  {
    name: 'read_file',
    description: "Lit un fichier texte (txt, md, csv, json, code…) pour le résumer ou répondre à une question dessus.",
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Chemin du fichier (relatif à ton dossier, ou commençant par ~/).' } }, required: ['path'] },
    label: (a) => `Lit ${a.path}`,
    async run({ path: p }, ctx) {
      const abs = resolvePath(p);
      if (!insideFolder(abs) && !(await askOutside({ verb: 'lire un fichier', abs, steps: [`Lit le fichier « ${show(abs)} » pour s'en servir dans sa réponse`], risk: 'read', warnings: ['Le fichier reste sur ton Mac : le modèle local ne l\'envoie nulle part.'] }, ctx))) return "Refusé par l'utilisateur.";
      if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return `Fichier introuvable : ${show(abs)}. Utilise list_files pour voir ce qui existe.`;
      const buf = fs.readFileSync(abs);
      if (!isText(buf)) return "Ce fichier n'est pas du texte (PDF, image, Word…) : je ne sais lire que les fichiers texte.";
      const text = buf.toString('utf8');
      return text.length > MAX_READ ? `${text.slice(0, MAX_READ)}\n…(fichier tronqué, ${text.length} caractères au total)` : text || '(fichier vide)';
    },
  },
  {
    name: 'write_file',
    description: "Crée un fichier texte, ou remplace entièrement son contenu s'il existe déjà. Crée les dossiers manquants.",
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Nom ou chemin du fichier, par ex. « courses.md ».' }, content: { type: 'string', description: 'Tout le contenu du fichier.' } }, required: ['path', 'content'] },
    label: (a) => `Écrit ${a.path}`,
    async run({ path: p, content = '' }, ctx) {
      const abs = resolvePath(p);
      const exists = fs.existsSync(abs);
      if (exists && fs.statSync(abs).isDirectory()) return `${show(abs)} est un dossier, pas un fichier.`;
      if (!insideFolder(abs) && !(await askOutside({
        verb: exists ? 'remplacer un fichier' : 'créer un fichier',
        abs,
        steps: [`${exists ? 'Remplace tout le contenu du fichier' : 'Crée le fichier'} « ${show(abs)} » (${String(content).split('\n').length} lignes)`],
        risk: exists ? 'danger' : 'change',
        warnings: exists ? ['Le contenu actuel de ce fichier sera perdu.'] : [],
        preview: String(content).slice(0, 1200),
      }, ctx))) return "Refusé par l'utilisateur.";
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, String(content));
      return `${exists ? 'Fichier remplacé' : 'Fichier créé'} : ${show(abs)}`;
    },
  },
  {
    name: 'append_file',
    description: "Ajoute du texte à la fin d'un fichier (le crée s'il n'existe pas). Pratique pour une liste ou un journal.",
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string', description: 'Texte à ajouter à la fin.' } }, required: ['path', 'content'] },
    label: (a) => `Complète ${a.path}`,
    async run({ path: p, content = '' }, ctx) {
      const abs = resolvePath(p);
      if (!insideFolder(abs) && !(await askOutside({ verb: 'compléter un fichier', abs, steps: [`Ajoute ${String(content).split('\n').length} ligne(s) à la fin du fichier « ${show(abs)} »`], risk: 'change', warnings: [], preview: String(content).slice(0, 1200) }, ctx))) return "Refusé par l'utilisateur.";
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const prev = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
      fs.appendFileSync(abs, `${prev && !prev.endsWith('\n') ? '\n' : ''}${content}`);
      return `Texte ajouté à ${show(abs)}`;
    },
  },
  {
    name: 'create_folder',
    description: 'Crée un dossier (et ses parents si besoin).',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    label: (a) => `Crée le dossier ${a.path}`,
    async run({ path: p }, ctx) {
      const abs = resolvePath(p);
      if (!insideFolder(abs) && !(await askOutside({ verb: 'créer un dossier', abs, steps: [`Crée le dossier « ${show(abs)} »`], risk: 'change', warnings: [] }, ctx))) return "Refusé par l'utilisateur.";
      fs.mkdirSync(abs, { recursive: true });
      return `Dossier prêt : ${show(abs)}`;
    },
  },
];

export const TOOL_DEFS = TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));

/** Consigne ajoutée au modèle local quand il a ses outils. */
export function toolsHint() {
  return [
    `\n## Tes outils pour les fichiers`,
    `Tu peux créer, écrire, compléter, lire et lister des fichiers texte avec tes outils (list_files, read_file, write_file, append_file, create_folder).`,
    `Ton dossier de travail est ${show(localFolder())} : un nom de fichier simple (« notes.md ») y est rangé. Hors de ce dossier, l'utilisateur doit accepter.`,
    "Utilise un outil seulement quand il te demande d'agir sur un fichier ; sinon réponds directement. Pour résumer un fichier, lis-le d'abord avec read_file.",
    "Tu ne peux ni supprimer un fichier ni lancer de commande. Après une action, dis en une phrase ce que tu as fait et où se trouve le fichier.",
  ].join('\n');
}

/**
 * Conversation avec le modèle local et ses outils : il appelle des outils tant qu'il en a besoin,
 * puis donne sa réponse. Lève une erreur `noTools` si le modèle ne sait pas utiliser d'outils.
 */
export async function runLocal({ model, system, messages, signal, onTool }) {
  const msgs = [{ role: 'system', content: system }, ...messages.map((m) => ({ role: m.role, content: m.text }))];
  const ctx = { signal };
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const d = await ollamaChat({ model, messages: msgs, tools: TOOL_DEFS }, signal);
    const msg = d.message || {};
    const calls = msg.tool_calls || [];
    if (!calls.length) return msg.content || '';
    msgs.push({ role: 'assistant', content: msg.content || '', tool_calls: calls });
    for (const call of calls) {
      const name = call.function?.name;
      let args = call.function?.arguments || {};
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch { args = {}; }
      }
      const tool = TOOLS.find((t) => t.name === name);
      let result;
      if (!tool) result = `Outil inconnu : ${name}. Outils disponibles : ${TOOLS.map((t) => t.name).join(', ')}.`;
      else {
        onTool?.({ icon: name === 'read_file' || name === 'list_files' ? 'read' : 'write', label: tool.label(args) });
        try {
          result = await tool.run(args, ctx);
        } catch (e) {
          if (signal?.aborted) throw e;
          result = `Erreur : ${e.message}`;
        }
      }
      msgs.push({ role: 'tool', content: String(result), tool_name: name });
    }
  }
  const d = await ollamaChat({ model, messages: [...msgs, { role: 'user', content: 'Arrête les outils et réponds maintenant en une phrase.' }] }, signal);
  return d.message?.content || "J'ai fait plusieurs actions mais je n'ai pas réussi à conclure.";
}
