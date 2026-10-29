// Explique en français simple ce que va faire une action avant que tu l'autorises,
// pour quelqu'un qui ne connaît ni le code ni le terminal. Aucun appel à une IA : des règles fixes,
// donc instantané, gratuit et toujours la même explication pour la même commande.
import path from 'node:path';
import os from 'node:os';

// Niveaux de risque, du plus doux au plus fort.
export const RISK = {
  read: { rank: 0, label: 'Sans risque : regarde seulement, ne change rien' },
  change: { rank: 1, label: 'Modifie des choses sur ton Mac' },
  danger: { rank: 2, label: 'Attention : difficile ou impossible à annuler' },
};
const worse = (a, b) => (RISK[b].rank > RISK[a].rank ? b : a);

const trunc = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s || '');
const home = os.homedir();
/** Chemin lisible : ~/… plutôt que /Users/romu/…, guillemets typographiques. */
function nice(p) {
  if (!p) return '';
  let s = String(p);
  if (s === '.' || s === './') return 'le dossier courant';
  if (s === '..') return 'le dossier parent';
  if (s === '~' || s === home) return 'ton dossier personnel';
  if (s.startsWith(`${home}/`)) s = `~/${s.slice(home.length + 1)}`;
  return `« ${trunc(s, 70)} »`;
}
const list = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} et ${items.at(-1)}`);
const many = (args) => list(args.slice(0, 4).map(nice)) + (args.length > 4 ? ` (et ${args.length - 4} autres)` : '');

// ------------------------------------------------------------------ découpage de la ligne de commande

/** Découpe en mots en respectant les guillemets ; sépare les enchaînements (&&, ||, ;, |) et les redirections. */
export function tokenize(cmd) {
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  const push = () => {
    if (has) out.push({ w: cur });
    cur = '';
    has = false;
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < cmd.length) cur += cmd[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; has = true; continue; }
    if (c === '\\' && i + 1 < cmd.length) { cur += cmd[++i]; has = true; continue; }
    if (c === ' ' || c === '\t') { push(); continue; }
    const two = cmd.slice(i, i + 2);
    if (two === '&&' || two === '||' || two === '>>' || two === '2>' || two === '&>') {
      push();
      if (two === '2>' && cmd[i + 2] === '&') { i += 3; continue; } // 2>&1 : simple détail technique
      out.push({ op: two });
      i++;
      continue;
    }
    if (c === '\n' || c === ';' || c === '|' || c === '>' || c === '<' || c === '&') {
      push();
      out.push({ op: c === '\n' ? ';' : c });
      continue;
    }
    cur += c;
    has = true;
  }
  push();
  return out;
}

/** Regroupe les mots en commandes simples : [{ argv, redirects, pipedFrom, joint }]. */
function splitCommands(tokens) {
  const cmds = [];
  let c = { argv: [], redirects: [], joint: null, piped: false };
  const flush = (joint) => {
    if (c.argv.length || c.redirects.length) cmds.push(c);
    c = { argv: [], redirects: [], joint, piped: joint === '|' };
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.op === '>' || t.op === '>>' || t.op === '2>' || t.op === '&>' || t.op === '<') {
      const target = tokens[i + 1]?.w;
      if (target !== undefined) i++;
      c.redirects.push({ op: t.op, target });
    } else if (t.op) {
      flush(t.op);
    } else {
      c.argv.push(t.w);
    }
  }
  flush(null);
  return cmds;
}

// ------------------------------------------------------------------ dictionnaire des commandes

const flagsOf = (args) => args.filter((a) => a.startsWith('-'));
const plain = (args) => args.filter((a) => !a.startsWith('-'));
const hasFlag = (args, ...letters) => flagsOf(args).some((f) => letters.some((l) => (l.length > 1 ? f === l : !f.startsWith('--') && f.includes(l))));

/** Chaque entrée renvoie { text, risk, warn? }. `args` ne contient pas le nom de la commande. */
const COMMANDS = {
  ls: (a) => ({ text: `Affiche la liste des fichiers ${plain(a).length ? `de ${many(plain(a))}` : 'du dossier'}`, risk: 'read' }),
  pwd: () => ({ text: 'Affiche dans quel dossier il se trouve', risk: 'read' }),
  cd: (a) => ({ text: `Se place dans ${nice(a[0] || '~')}`, risk: 'read' }),
  cat: (a) => ({ text: `Affiche le contenu de ${many(plain(a))}`, risk: 'read' }),
  less: (a) => ({ text: `Affiche le contenu de ${many(plain(a))}`, risk: 'read' }),
  head: (a) => ({ text: `Affiche le début de ${plain(a).length ? many(plain(a).filter((x) => !/^\d+$/.test(x))) : 'ce qui précède'}`, risk: 'read' }),
  tail: (a) => ({ text: `Affiche la fin de ${plain(a).length ? many(plain(a).filter((x) => !/^\d+$/.test(x))) : 'ce qui précède'}`, risk: 'read' }),
  wc: (a) => ({ text: `Compte les lignes et les mots ${plain(a).length ? `de ${many(plain(a))}` : ''}`.trim(), risk: 'read' }),
  grep: (a) => {
    const [pat, ...files] = plain(a);
    return { text: `Cherche le texte « ${trunc(pat, 50)} »${files.length ? ` dans ${many(files)}` : ''}${hasFlag(a, 'r', 'R') ? ' (et dans tous les sous-dossiers)' : ''}`, risk: 'read' };
  },
  rg: (a) => COMMANDS.grep([...a, '-r']),
  find: (a) => {
    if (a.includes('-delete') || a.includes('-exec')) {
      return { text: `Cherche des fichiers dans ${nice(plain(a)[0] || '.')} puis ${a.includes('-delete') ? 'les supprime' : 'lance une commande sur chacun'}`, risk: a.includes('-delete') ? 'danger' : 'change', warn: a.includes('-delete') ? 'Les fichiers trouvés seront supprimés définitivement (pas de Corbeille).' : null };
    }
    const name = a[a.indexOf('-name') + 1];
    return { text: `Cherche des fichiers${a.includes('-name') ? ` nommés « ${name} »` : ''} dans ${nice(plain(a)[0] || '.')}`, risk: 'read' };
  },
  which: (a) => ({ text: `Vérifie si le programme ${many(plain(a))} est installé`, risk: 'read' }),
  echo: (a) => ({ text: `Écrit le texte « ${trunc(a.join(' '), 60)} »`, risk: 'read' }),
  printf: (a) => ({ text: `Écrit le texte « ${trunc(a.join(' '), 60)} »`, risk: 'read' }),
  date: () => ({ text: "Affiche la date et l'heure", risk: 'read' }),
  cal: () => ({ text: 'Affiche un calendrier', risk: 'read' }),
  whoami: () => ({ text: "Affiche ton nom d'utilisateur", risk: 'read' }),
  sleep: (a) => ({ text: `Attend ${a[0] || 'quelques'} secondes`, risk: 'read' }),
  diff: (a) => ({ text: `Compare ${many(plain(a))}`, risk: 'read' }),
  sort: () => ({ text: 'Trie les lignes', risk: 'read' }),
  uniq: () => ({ text: 'Retire les lignes en double', risk: 'read' }),
  jq: () => ({ text: 'Extrait des informations de données JSON', risk: 'read' }),
  du: (a) => ({ text: `Mesure la place prise par ${plain(a).length ? many(plain(a)) : 'le dossier'}`, risk: 'read' }),
  df: () => ({ text: "Affiche l'espace libre sur le disque", risk: 'read' }),
  ps: () => ({ text: 'Liste les programmes en cours', risk: 'read' }),
  env: () => ({ text: "Affiche les réglages de l'environnement (peut contenir des mots de passe)", risk: 'read' }),
  mkdir: (a) => ({ text: `Crée le dossier ${many(plain(a))}`, risk: 'change' }),
  touch: (a) => ({ text: `Crée le fichier vide ${many(plain(a))} (ou met à jour sa date s'il existe)`, risk: 'change' }),
  cp: (a) => {
    const p = plain(a);
    return { text: `Copie ${many(p.slice(0, -1))} vers ${nice(p.at(-1))}${hasFlag(a, 'r', 'R') ? ' (avec tout son contenu)' : ''}`, risk: 'change', warn: 'Si un fichier du même nom existe déjà à la destination, il sera remplacé.' };
  },
  mv: (a) => {
    const p = plain(a);
    return { text: `Déplace ou renomme ${many(p.slice(0, -1))} en ${nice(p.at(-1))}`, risk: 'change', warn: 'Si un fichier du même nom existe déjà à la destination, il sera remplacé.' };
  },
  rm: (a) => {
    const rec = hasFlag(a, 'r', 'R', '--recursive');
    return {
      text: `Supprime ${rec ? 'le dossier' : 'le fichier'} ${many(plain(a))}${rec ? ' et tout ce qu\'il contient' : ''}`,
      risk: 'danger',
      warn: `Suppression définitive : ça ne passe pas par la Corbeille${hasFlag(a, 'f', '--force') ? ", et sans aucune confirmation" : ''}.`,
    };
  },
  rmdir: (a) => ({ text: `Supprime le dossier vide ${many(plain(a))}`, risk: 'change' }),
  ln: (a) => ({ text: `Crée un raccourci vers ${nice(plain(a)[0])}`, risk: 'change' }),
  chmod: (a) => ({
    text: `Change qui a le droit de lire, modifier ou lancer ${many(plain(a).slice(1))}`,
    risk: a.includes('777') || hasFlag(a, 'R') ? 'danger' : 'change',
    warn: a.includes('777') ? "777 donne tous les droits à tout le monde : c'est rarement une bonne idée." : null,
  }),
  chown: (a) => ({ text: `Change le propriétaire de ${many(plain(a).slice(1))}`, risk: 'danger' }),
  open: (a) => ({ text: `Ouvre ${many(plain(a))} avec l'application habituelle`, risk: 'read' }),
  kill: (a) => ({ text: `Arrête de force un programme en cours (n° ${plain(a).join(', ')})`, risk: 'danger', warn: 'Le programme arrêté peut perdre ce qui n\'était pas enregistré.' }),
  pkill: (a) => ({ text: `Arrête de force les programmes nommés « ${plain(a)[0]} »`, risk: 'danger', warn: 'Le programme arrêté peut perdre ce qui n\'était pas enregistré.' }),
  killall: (a) => COMMANDS.pkill(a),
  curl: (a) => {
    const url = a.find((x) => /^https?:\/\//.test(x)) || plain(a).at(-1);
    const sends = a.some((x) => /^(-d|--data|-F|--form|-T|--upload-file|-X)$/.test(x) || /^--data/.test(x));
    const saves = hasFlag(a, 'o', 'O', '--output');
    return {
      text: sends ? `Envoie des données à l'adresse ${nice(url)}` : `Télécharge ${nice(url)}${saves ? ' et l\'enregistre dans un fichier' : ''}`,
      risk: sends || saves ? 'change' : 'read',
      warn: sends ? 'Des informations vont sortir de ton Mac vers ce site.' : null,
    };
  },
  wget: (a) => ({ text: `Télécharge ${nice(plain(a).at(-1))} et l'enregistre dans un fichier`, risk: 'change' }),
  sudo: (a) => {
    const inner = explainArgv(a.filter((x, i) => !(i === 0 && x.startsWith('-'))));
    return { text: `${inner.text}, avec les droits d'administrateur`, risk: 'danger', warn: [inner.warn, 'sudo donne tous les pouvoirs sur ton Mac : ton mot de passe sera demandé. N\'accepte que si tu sais pourquoi.'].filter(Boolean).join(' ') };
  },
  tar: (a) => ({ text: hasFlag(a, 'x') ? `Décompresse l'archive ${nice(plain(a).find((x) => /\.(tar|tgz|gz|bz2|xz)/.test(x)))}` : `Crée une archive compressée ${nice(plain(a)[0])}`, risk: 'change' }),
  unzip: (a) => ({ text: `Décompresse l'archive ${nice(plain(a)[0])}`, risk: 'change' }),
  zip: (a) => ({ text: `Crée l'archive compressée ${nice(plain(a)[0])}`, risk: 'change' }),
  sed: (a) => ({ text: hasFlag(a, 'i') ? `Remplace du texte directement dans ${many(plain(a).slice(1))}` : 'Transforme du texte (sans modifier de fichier)', risk: hasFlag(a, 'i') ? 'change' : 'read' }),
  dd: () => ({ text: 'Copie des données brutes, octet par octet (souvent un disque entier)', risk: 'danger', warn: "Une erreur de cible peut effacer un disque entier." }),
  diskutil: (a) => ({ text: `Agit sur les disques (${a[0] || 'gestion'})`, risk: /erase|partition|format/i.test(a[0]) ? 'danger' : 'read' }),
  defaults: (a) => ({ text: a[0] === 'write' || a[0] === 'delete' ? `Change un réglage caché de macOS (${a[1] || ''})` : 'Lit un réglage de macOS', risk: a[0] === 'write' || a[0] === 'delete' ? 'change' : 'read' }),
  launchctl: () => ({ text: 'Gère les programmes qui se lancent tout seuls sur ton Mac', risk: 'change' }),
  osascript: () => ({ text: 'Lance un script qui pilote des applications de ton Mac', risk: 'change' }),
  ssh: (a) => ({ text: `Se connecte à l'ordinateur distant ${nice(plain(a)[0])}`, risk: 'change' }),
  scp: (a) => ({ text: `Copie des fichiers vers ou depuis un autre ordinateur (${nice(plain(a).at(-1))})`, risk: 'change', warn: 'Des fichiers vont sortir de ton Mac ou y entrer.' }),
  rsync: (a) => ({ text: `Synchronise ${many(plain(a).slice(0, -1))} vers ${nice(plain(a).at(-1))}`, risk: a.includes('--delete') ? 'danger' : 'change', warn: a.includes('--delete') ? 'Les fichiers absents de la source seront supprimés à la destination.' : null }),
  git: (a) => explainGit(a),
  npm: (a) => explainPkg('npm', a),
  pnpm: (a) => explainPkg('pnpm', a),
  yarn: (a) => explainPkg('yarn', a),
  bun: (a) => explainPkg('bun', a),
  npx: (a) => ({ text: `Télécharge si besoin puis lance l'outil « ${plain(a)[0]} »`, risk: 'change' }),
  node: (a) => ({ text: a[0] === '--version' || a[0] === '-v' ? 'Affiche la version de Node.js' : `Lance le programme JavaScript ${nice(plain(a)[0] || 'tapé à la suite')}`, risk: a[0] === '--version' || a[0] === '-v' ? 'read' : 'change' }),
  python: (a) => explainPython(a),
  python3: (a) => explainPython(a),
  pip: (a) => explainPip(a),
  pip3: (a) => explainPip(a),
  pytest: () => ({ text: 'Lance les tests automatiques du projet (vérifie que le code marche)', risk: 'read' }),
  brew: (a) => ({
    text: { install: `Installe le logiciel ${many(plain(a).slice(1))} avec Homebrew`, uninstall: `Désinstalle ${many(plain(a).slice(1))}`, update: 'Met à jour la liste des logiciels Homebrew', upgrade: 'Met à jour les logiciels installés avec Homebrew', list: 'Liste les logiciels installés avec Homebrew' }[a[0]] || `Homebrew : ${a[0] || ''}`,
    risk: a[0] === 'list' || a[0] === 'info' ? 'read' : 'change',
  }),
  docker: (a) => ({ text: { ps: 'Liste les conteneurs Docker en cours', build: "Construit une image Docker (un paquet prêt à lancer)", run: 'Lance un conteneur Docker', compose: `Lance ou gère plusieurs conteneurs Docker (${a[1] || ''})`, rm: 'Supprime un conteneur Docker', rmi: 'Supprime une image Docker' }[a[0]] || `Docker : ${a[0] || ''}`, risk: a[0] === 'ps' || a[0] === 'images' ? 'read' : /^(rm|rmi|prune|system)$/.test(a[0]) ? 'danger' : 'change' }),
  make: (a) => ({ text: `Lance la recette « ${plain(a)[0] || 'par défaut'} » du projet (souvent : compiler ou installer)`, risk: 'change' }),
  go: (a) => ({ text: { test: 'Lance les tests du projet Go', build: 'Compile le projet Go', run: 'Compile et lance le programme Go', vet: 'Vérifie le code Go' }[a[0]] || `Go : ${a[0] || ''}`, risk: a[0] === 'test' || a[0] === 'vet' ? 'read' : 'change' }),
  cargo: (a) => ({ text: { test: 'Lance les tests du projet Rust', build: 'Compile le projet Rust', run: 'Compile et lance le programme Rust', check: 'Vérifie le code Rust' }[a[0]] || `Cargo : ${a[0] || ''}`, risk: a[0] === 'test' || a[0] === 'check' ? 'read' : 'change' }),
  claude: () => ({ text: 'Lance Claude Code', risk: 'change' }),
  maestro: (a) => ({ text: a[0] === 'update' ? 'Met Chlamyd.I.A. à jour' : `Commande Chlamyd.I.A. ${a[0] || ''}`.trim(), risk: 'change' }),
  bash: (a) => explainShell(a),
  sh: (a) => explainShell(a),
  zsh: (a) => explainShell(a),
  source: (a) => ({ text: `Exécute les commandes écrites dans ${nice(a[0])}`, risk: 'change' }),
  export: (a) => ({ text: `Définit un réglage temporaire (${a.map((x) => x.split('=')[0]).join(', ')})`, risk: 'read' }),
  true: () => ({ text: 'Ne fait rien', risk: 'read' }),
};
COMMANDS['.'] = COMMANDS.source;

function explainGit(a) {
  const [sub, ...rest] = a.filter((x, i) => !(x === '-C' || a[i - 1] === '-C'));
  const r = (text, risk = 'change', warn = null) => ({ text, risk, warn });
  switch (sub) {
    case 'status': return r("Regarde quels fichiers ont changé depuis la dernière sauvegarde (commit)", 'read');
    case 'diff': return r('Montre ligne par ligne ce qui a changé', 'read');
    case 'log': return r("Affiche l'historique des sauvegardes (commits)", 'read');
    case 'show': return r("Affiche le détail d'une sauvegarde (commit)", 'read');
    case 'branch': return plain(rest).length && !hasFlag(rest, 'd', 'D') ? r(`Crée la branche ${nice(plain(rest)[0])} (une copie de travail parallèle)`) : hasFlag(rest, 'D') ? r(`Supprime la branche ${nice(plain(rest)[0])}, même si son travail n'a pas été fusionné`, 'danger', 'Le travail de cette branche peut être perdu.') : hasFlag(rest, 'd') ? r(`Supprime la branche ${nice(plain(rest)[0])}`) : r('Liste les branches', 'read');
    case 'add': return r(`Prépare ${plain(rest).includes('.') || hasFlag(rest, 'A', '--all') ? 'tous les fichiers modifiés' : many(plain(rest))} pour la prochaine sauvegarde (commit)`);
    case 'commit': {
      const i = rest.findIndex((x) => x === '-m' || x === '--message');
      return r(`Enregistre une sauvegarde (commit) des changements${i >= 0 && rest[i + 1] ? ` avec la note « ${trunc(rest[i + 1], 70)} »` : ''}`, hasFlag(rest, '--amend') ? 'danger' : 'change', hasFlag(rest, '--amend') ? 'Remplace la dernière sauvegarde au lieu d\'en créer une nouvelle.' : null);
    }
    case 'push': {
      const force = rest.some((x) => x === '-f' || x === '--force' || x.startsWith('--force-with-lease'));
      return r(`Envoie tes sauvegardes (commits) sur le serveur en ligne${plain(rest).length ? ` (${plain(rest).join(' ')})` : ''}`, force ? 'danger' : 'change', force ? "Forcé : ça écrase ce qu'il y a en ligne, le travail des autres peut être perdu." : 'Le code part sur le serveur (GitHub…) : visible par ceux qui y ont accès.');
    }
    case 'pull': return r('Récupère et intègre les dernières modifications du serveur en ligne');
    case 'fetch': return r('Télécharge les nouveautés du serveur en ligne, sans rien modifier de ton travail', 'read');
    case 'clone': return r(`Télécharge une copie complète du projet ${nice(plain(rest)[0])}`);
    case 'checkout':
    case 'switch': return hasFlag(rest, 'b', 'c') ? r(`Crée la branche ${nice(plain(rest)[0])} et passe dessus`) : rest.includes('--') || rest.includes('.') ? r(`Annule les modifications non sauvegardées de ${many(plain(rest).filter((x) => x !== '--'))}`, 'danger', 'Les modifications non sauvegardées de ces fichiers seront perdues.') : r(`Passe sur la branche ${nice(plain(rest)[0])}`);
    case 'restore': return r(`Annule les modifications non sauvegardées de ${many(plain(rest))}`, 'danger', 'Ces modifications seront perdues.');
    case 'merge': return r(`Fusionne la branche ${nice(plain(rest)[0])} dans la branche actuelle`);
    case 'rebase': return r(`Réécrit l'historique pour repartir de ${nice(plain(rest)[0])}`, 'danger', "Réécrit l'historique : à éviter sur une branche partagée.");
    case 'reset': return hasFlag(rest, '--hard') ? r(`Revient en arrière${plain(rest)[0] ? ` jusqu'à ${nice(plain(rest)[0])}` : ''} en effaçant tout le travail non sauvegardé`, 'danger', 'Tout ce qui n\'est pas sauvegardé (commit) sera perdu.') : r('Retire des fichiers de la prochaine sauvegarde (sans perdre de travail)');
    case 'clean': return r('Supprime tous les fichiers que git ne suit pas', 'danger', 'Suppression définitive, sans Corbeille.');
    case 'stash': return rest[0] === 'drop' || rest[0] === 'clear' ? r('Jette du travail mis de côté', 'danger', 'Ce travail sera perdu.') : rest[0] === 'pop' || rest[0] === 'apply' ? r('Remet le travail mis de côté') : r('Met de côté les modifications en cours, pour les reprendre plus tard');
    case 'tag': return r(`Pose l'étiquette ${nice(plain(rest)[0])} sur la version actuelle`);
    case 'init': return r('Démarre le suivi des versions (git) dans ce dossier');
    case 'worktree': return r('Gère les dossiers de travail parallèles de git');
    case 'config': return r(plain(rest).length > 1 ? 'Change un réglage de git' : 'Lit un réglage de git', plain(rest).length > 1 ? 'change' : 'read');
    case 'remote': return r(rest[0] === 'add' || rest[0] === 'set-url' ? 'Change l\'adresse du serveur en ligne du projet' : 'Affiche le serveur en ligne du projet', rest[0] === 'add' || rest[0] === 'set-url' ? 'change' : 'read');
    default: return r(`Commande git « ${sub || ''} »`);
  }
}

function explainPkg(tool, a) {
  const [sub, ...rest] = a;
  const names = plain(rest);
  switch (sub) {
    case 'install':
    case 'i':
    case 'add':
    case 'ci':
      return names.length
        ? { text: `Télécharge et ajoute au projet la bibliothèque ${many(names)}`, risk: 'change', warn: 'Du code venu d\'internet sera installé et pourra s\'exécuter.' }
        : { text: 'Installe toutes les bibliothèques dont le projet a besoin', risk: 'change' };
    case 'uninstall':
    case 'remove':
    case 'rm':
      return { text: `Retire la bibliothèque ${many(names)} du projet`, risk: 'change' };
    case 'test':
    case 't':
      return { text: 'Lance les tests automatiques du projet (vérifie que le code marche)', risk: 'read' };
    case 'run': {
      const s = names[0] || '';
      const known = { test: 'Lance les tests automatiques du projet', build: 'Prépare la version finale du projet (build)', dev: 'Démarre le projet en mode développement', start: 'Démarre le projet', lint: 'Vérifie la propreté du code', format: 'Remet le code en forme', typecheck: 'Vérifie les types du code' };
      return { text: known[s] || `Lance le script « ${s} » du projet`, risk: s === 'test' || s === 'lint' || s === 'typecheck' ? 'read' : 'change' };
    }
    case 'start': return { text: 'Démarre le projet', risk: 'change' };
    case 'publish': return { text: 'Publie le projet sur internet (registre npm), visible par tout le monde', risk: 'danger', warn: 'Le code devient public.' };
    case 'update':
    case 'upgrade': return { text: 'Met à jour les bibliothèques du projet', risk: 'change' };
    case '--version':
    case '-v': return { text: `Affiche la version de ${tool}`, risk: 'read' };
    default: return { text: `${tool} ${sub || ''}`.trim(), risk: 'change' };
  }
}

function explainPython(a) {
  if (a[0] === '-m' && a[1] === 'pytest') return COMMANDS.pytest();
  if (a[0] === '-m' && a[1] === 'pip') return explainPip(a.slice(2));
  if (a[0] === '--version' || a[0] === '-V') return { text: 'Affiche la version de Python', risk: 'read' };
  if (a[0] === '-c') return { text: 'Lance un petit programme Python écrit directement dans la commande', risk: 'change' };
  return { text: `Lance le programme Python ${nice(plain(a)[0] || '?')}`, risk: 'change' };
}

function explainPip(a) {
  if (a[0] === 'install') return { text: `Télécharge et installe la bibliothèque Python ${many(plain(a.slice(1)))}`, risk: 'change', warn: 'Du code venu d\'internet sera installé et pourra s\'exécuter.' };
  if (a[0] === 'list' || a[0] === 'show' || a[0] === 'freeze') return { text: 'Liste les bibliothèques Python installées', risk: 'read' };
  return { text: `pip ${a[0] || ''}`, risk: 'change' };
}

function explainShell(a) {
  const i = a.indexOf('-c');
  if (i >= 0 && a[i + 1]) {
    const inner = explainCommand(a[i + 1]);
    return { text: inner.steps.join(', puis '), risk: inner.risk, warn: inner.warnings[0] || null };
  }
  return { text: plain(a)[0] ? `Exécute les commandes du script ${nice(plain(a)[0])}` : 'Exécute les commandes reçues', risk: 'change' };
}

function explainArgv(argv) {
  let args = argv.slice();
  // Réglages placés devant la commande : FOO=bar commande
  while (args.length > 1 && /^[A-Za-z_]\w*=/.test(args[0])) args.shift();
  const name = path.basename(args[0] || '');
  const fn = COMMANDS[name];
  if (fn) return fn(args.slice(1));
  if (/^\.{0,2}\//.test(args[0] || '')) return { text: `Lance le programme ${nice(args[0])}`, risk: 'change' };
  return { text: `Lance le programme « ${name} »${args.length > 1 ? ` (${trunc(args.slice(1).join(' '), 50)})` : ''}`, risk: 'change', unknown: true };
}

/**
 * Explique une commande du terminal.
 * @returns {{ steps: string[], risk: 'read'|'change'|'danger', warnings: string[] }}
 */
export function explainCommand(cmd) {
  const cmds = splitCommands(tokenize(String(cmd || '').trim()));
  const steps = [];
  const warnings = [];
  let risk = 'read';
  let unknown = false;
  for (const [n, c] of cmds.entries()) {
    let e = c.argv.length ? explainArgv(c.argv) : { text: 'Prépare un fichier', risk: 'change' };
    let text = e.text;
    if (c.piped && n > 0) text = `${text.charAt(0).toLowerCase()}${text.slice(1)} sur le résultat`;
    for (const r of c.redirects) {
      if (r.op === '>' || r.op === '&>') {
        if (r.target === '/dev/null') text += ' (sans afficher le résultat)';
        else {
          text += `, et écrit le résultat dans ${nice(r.target)}`;
          e = { ...e, risk: worse(e.risk, 'change') };
          warnings.push(`Le contenu actuel de ${nice(r.target)} sera remplacé.`);
        }
      } else if (r.op === '>>') {
        text += `, et ajoute le résultat à la fin de ${nice(r.target)}`;
        e = { ...e, risk: worse(e.risk, 'change') };
      } else if (r.op === '<') {
        text += ` à partir de ${nice(r.target)}`;
      }
    }
    // Télécharger un script puis l'exécuter directement : classique, mais à faire seulement si on a confiance.
    if (c.piped && /^(ba|z)?sh$/.test(path.basename(c.argv[0] || '')) && cmds[n - 1] && /^(curl|wget)$/.test(path.basename(cmds[n - 1].argv[0] || ''))) {
      text = "exécute tout de suite ce qui a été téléchargé, sans que tu le voies";
      e = { ...e, risk: 'danger' };
      warnings.push("Un programme téléchargé d'internet va s'exécuter sur ton Mac : n'accepte que si tu connais et fais confiance au site.");
    }
    if (n > 0 && !c.piped) text = `${c.joint === '||' ? 'Si ça échoue : ' : ''}${text}`;
    steps.push(text);
    if (e.warn) warnings.push(e.warn);
    if (e.unknown) unknown = true;
    risk = worse(risk, e.risk);
  }
  // Fusionne les commandes reliées par | en une seule phrase.
  const merged = [];
  for (const [n, c] of cmds.entries()) {
    if (c.piped && n > 0 && merged.length) merged[merged.length - 1] += `, puis ${steps[n]}`;
    else merged.push(steps[n]);
  }
  if (unknown) warnings.push("Je ne connais pas ce programme : je ne peux pas te dire précisément ce qu'il fait.");
  return { steps: merged.length ? merged : ['Commande vide'], risk, warnings: [...new Set(warnings)] };
}

// ------------------------------------------------------------------ autres outils des agents

const lines = (s) => (s ? String(s).split('\n').length : 0);

/**
 * Explique n'importe quelle demande d'autorisation d'un agent.
 * @returns {{ steps: string[], risk: 'read'|'change'|'danger', warnings: string[] }}
 */
export function explainTool(name, input = {}, cwd = '') {
  const rel = (p) => {
    if (!p) return '';
    const r = cwd ? path.relative(cwd, p) : p;
    return nice(r && !r.startsWith('..') ? r : p);
  };
  const one = (text, risk = 'change', warnings = []) => ({ steps: [text], risk, warnings: warnings.filter(Boolean) });
  switch (name) {
    case 'Bash': return explainCommand(input.command);
    case 'Write': return one(`Crée le fichier ${rel(input.file_path)} (ou le remplace s'il existe) avec ${lines(input.content)} ligne${lines(input.content) > 1 ? 's' : ''} de contenu`, 'change', ['Si ce fichier existe déjà, son contenu actuel sera remplacé.']);
    case 'Edit': return one(`Modifie un passage du fichier ${rel(input.file_path)} : ${lines(input.old_string)} ligne${lines(input.old_string) > 1 ? 's' : ''} remplacée${lines(input.old_string) > 1 ? 's' : ''} par ${lines(input.new_string)}${input.replace_all ? ', partout où ce passage apparaît' : ''}`);
    case 'MultiEdit': return one(`Fait ${input.edits?.length || 'plusieurs'} modifications dans le fichier ${rel(input.file_path)}`);
    case 'NotebookEdit': return one(`Modifie une cellule du carnet ${rel(input.notebook_path)}`);
    case 'Read': return one(`Lit le fichier ${rel(input.file_path)}`, 'read');
    case 'Glob':
    case 'Grep': return one('Cherche dans les fichiers', 'read');
    case 'WebFetch': return one(`Ouvre la page ${nice(input.url)} pour la lire`, 'read', ["Seule l'adresse de la page sort de ton Mac."]);
    case 'WebSearch': return one(`Fait une recherche sur internet : « ${trunc(input.query, 80)} »`, 'read');
    case 'Task':
    case 'Agent': return one(`Confie une partie du travail à un assistant secondaire : ${trunc(input.description || input.prompt, 90)}`);
    case 'Skill': return one(`Utilise ton skill « ${input.skill || input.command || ''} » (une recette enregistrée dans ton compte Claude)`);
    case 'RemoteTrigger': {
      const verb = { list: 'Lit la liste de tes routines claude.ai', get: "Lit le détail d'une routine claude.ai", list_runs: "Lit l'historique d'une routine claude.ai", get_run_log: "Lit le résultat d'une routine claude.ai", run: 'Lance maintenant une de tes routines claude.ai', create: 'Crée une nouvelle routine claude.ai', update: 'Modifie une de tes routines claude.ai', delete: 'Supprime une de tes routines claude.ai' }[input.action];
      return one(verb || `Routines claude.ai : ${input.action}`, ['list', 'get', 'list_runs', 'get_run_log'].includes(input.action) ? 'read' : input.action === 'delete' ? 'danger' : 'change');
    }
    default:
      if (name.startsWith('mcp__')) {
        const [, server, ...rest] = name.split('__');
        const tool = rest.join('__');
        const service = server.replace(/^claude_ai_/, '').replace(/_/g, ' ');
        const words = tool.replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
        const risky = /(delete|remove|trash|send|pay|purchase|archive)/i.test(tool);
        const writes = /(create|update|write|modify|upsert|post|add|move|set|edit)/i.test(tool);
        const what = Object.entries(input || {}).filter(([, v]) => typeof v === 'string' && v.length < 120).slice(0, 2).map(([k, v]) => `${k} : « ${v} »`).join(', ');
        return one(
          `Utilise ton service ${service} pour : ${words}${what ? ` (${what})` : ''}`,
          risky ? 'danger' : writes ? 'change' : 'read',
          [/send|post/i.test(tool) ? 'Un message ou un contenu va être envoyé à quelqu\'un ou publié.' : null, /delete|remove|trash/i.test(tool) ? 'Quelque chose va être supprimé.' : null],
        );
      }
      return one(`Utilise l'outil « ${name} »`);
  }
}
