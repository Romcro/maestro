# Maestro

Un chef d'orchestre local pour tes agents Claude Code, sur ton Mac.

Tu écris les étapes de ton projet dans un `PLAN.md`. Maestro lance un agent par étape, en parallèle dès que les dépendances le permettent, chacun dans sa propre copie git du projet. Tu suis tout depuis un tableau de bord, et tu reçois une notification macOS uniquement quand tu dois intervenir : une question, une commande à autoriser, une étape à valider.

À côté, un **assistant** connaît l'état de tes projets, utilise tes outils connectés (agenda, Notion…) et peut exécuter des **routines** à heure fixe, comme un brief du matin.

## Installation

Prérequis : Node.js 18 ou plus (`brew install node`) et Claude Code installé et connecté (lance `claude` une fois dans un terminal).

```bash
git clone https://github.com/Romcro/maestro.git ~/maestro
cd ~/maestro
./install.sh
```

Le script installe les dépendances et ajoute la commande `maestro`, qui pointe vers ce dossier : garde-le à cet endroit. Il propose aussi d'installer `terminal-notifier`, pour que les notifications soient cliquables, et de lancer Maestro automatiquement à l'ouverture de ta session.

## Mise à jour

```bash
maestro update
```

Récupère la dernière version sur GitHub, met à jour les dépendances si besoin et redémarre Maestro. Tes projets, réglages, routines et l'historique de l'assistant sont dans `~/.maestro/` : une mise à jour n'y touche pas.

Si le dépôt est privé, connecte une fois git à ton compte GitHub : `brew install gh && gh auth login`.

## Premier projet

```bash
cd ~/code/mon-projet
maestro
```

Le tableau de bord s'ouvre dans une fenêtre d'app. S'il n'y a pas encore de `PLAN.md`, tu as deux options :

- décrire ce que tu veux construire, et Claude explore le dépôt puis rédige le plan ;
- partir du modèle et l'écrire toi-même.

Relis le plan, puis clique sur **Lancer le plan**.

## Le format du PLAN.md

```markdown
# Budget perso

Contexte transmis à tous les agents : stack, conventions, ce qu'il ne faut pas toucher.

## 1. Socle du projet
agent: backend · après: aucune
- [ ] Initialiser Next.js et Vitest
- [ ] Schéma de base de données

## 2. Authentification
agent: backend · après: 1
- [ ] Connexion par e-mail
Consigne libre pour l'agent : utiliser des sessions en base, pas de JWT.

## 3. Tableau de bord
agent: frontend · après: 1
- [ ] Graphique mensuel

## 4. Relecture finale
agent: reviewer · après: 2, 3 · validation: manuelle
```

| Ligne | Effet |
|---|---|
| `## …` | Une étape. Le numéro au début sert d'identifiant. |
| `agent:` | Le rôle de l'agent. Si `.claude/agents/<rôle>.md` existe dans le projet, ou dans `~/.claude/agents/`, son contenu devient sa consigne de rôle. Des exemples sont dans `examples/agents/`. |
| `après:` | Les étapes à terminer avant. Si la ligne est absente, l'étape suit la précédente. `après: aucune` la fait démarrer tout de suite. |
| `validation:` | `auto` fusionne sans te demander ; `manuelle` attend toujours ton feu vert. |
| `modèle:` | Un modèle précis pour cette étape (ex. `opus`, `haiku`). |
| `- [ ]` | Les sous-tâches. Maestro les coche au fur et à mesure que l'agent avance. |

Tu peux modifier le fichier pendant que les agents travaillent : Maestro le relit à chaque enregistrement.

## Comment ça se passe

1. **Lancement.** Pour chaque étape prête, Maestro crée un *worktree* git, c'est-à-dire une copie isolée du projet sur une branche `maestro/…`, et y lance une session Claude Code. Les worktrees sont rangés dans `~/.maestro/worktrees/`, en dehors de ton projet.
2. **Pendant le travail.**
   - Les modifications de fichiers et les commandes courantes (git, tests, installation de dépendances…) sont autorisées d'office.
   - Pour tout le reste, l'agent te demande l'autorisation dans le tableau de bord.
   - S'il a besoin d'une décision, il te pose la question au même endroit.
3. **Fin d'une étape.**
   - L'agent fait un commit et écrit un résumé.
   - Tu vois ses modifications fichier par fichier.
   - **Valider et fusionner** intègre sa branche dans ta branche de travail. Tu peux aussi écrire une demande de correction.
4. **Étapes suivantes.** Dès qu'une étape est fusionnée, celles qui en dépendent démarrent à partir du code à jour.
5. **En cas de conflit.** Si deux agents ont touché les mêmes lignes, Maestro annule la fusion, ton dossier reste propre, et tu peux demander à l'agent de résoudre le conflit lui-même.

À tout moment, tu peux :

- **Arrêter** un agent puis le **Reprendre** : il garde sa conversation ;
- **Recommencer** une étape de zéro ;
- ouvrir son dossier dans VS Code ;
- reprendre sa session dans le Terminal avec `claude --resume`.

> Les agents partent du **dernier commit** de ta branche. Commit ton travail en cours avant de lancer un plan.

Sans dépôt git, les étapes tournent une par une, directement dans ton dossier. Le bouton **Initialiser git** règle ça.

## Notifications

- **Tableau de bord visible :** un bandeau s'affiche dans l'interface.
- **Tableau de bord ouvert en arrière-plan :** tu reçois une notification système, si tu les as activées dans **Réglages**.
- **Tableau de bord fermé :** tu reçois une notification macOS native. Avec `terminal-notifier`, cliquer dessus ouvre l'élément concerné.

Le nombre d'éléments à traiter s'affiche aussi dans le titre de la fenêtre et sur l'icône du Dock si tu installes Maestro comme app (Chrome : menu ⋮ › *Installer la page en tant qu'appli*).

## Dans VS Code

- Le bouton `</>` ouvre le projet, ou le worktree d'une étape, dans VS Code.
- Pour garder le tableau de bord dans un panneau de VS Code : palette de commandes › **Simple Browser: Show** › colle l'adresse affichée par `maestro open`.

## L'assistant

Onglet **Assistant** : une conversation continue, hors projets. Il peut :

- dire où en sont tes projets, les lancer ou les mettre en pause ;
- créer des routines : « programme un brief chaque matin à 8 h 30 » ;
- utiliser les serveurs MCP que tu as ajoutés à Claude Code (`claude mcp add --scope user …`) ou ceux définis dans **Réglages › Serveurs MCP de l'assistant** ;
- retenir tes préférences dans `~/.maestro/assistant/MEMOIRE.md`.

Les routines ne tournent que si Maestro tourne : c'est le rôle de `maestro service`.

## Commandes

| Commande | Effet |
|---|---|
| `maestro [dossier]` | Ajoute le projet et ouvre le tableau de bord (depuis ton dossier personnel, ouvre juste le tableau de bord) |
| `maestro init` | Crée un PLAN.md modèle puis ouvre le projet |
| `maestro open` | Ouvre le tableau de bord |
| `maestro status` | État des projets dans le terminal |
| `maestro stop` | Arrête Maestro et les agents en cours |
| `maestro service` / `maestro service uninstall` | Démarrage automatique à l'ouverture de session |
| `maestro update` | Installe la dernière version depuis GitHub |

## Réglages utiles

- **Agents en parallèle** : 2 par défaut. Chaque agent consomme ton forfait Claude : au-delà de 3, tu atteindras vite les limites.
- **Autorisations** : par défaut, les fichiers sont libres et les commandes inhabituelles sont soumises à ton accord. Tu peux ajouter tes propres règles (ex. `Bash(docker compose up:*)`).
- **Coût** : affiché par étape et par projet. C'est l'équivalent API calculé par Claude Code ; avec un abonnement, c'est ton quota qui est consommé.

## Essayer sans consommer de quota

```bash
maestro stop
MAESTRO_FAKE=1 maestro
```

Les agents font semblant : ils créent de petits fichiers, posent une question, demandent une autorisation. Pratique pour découvrir l'interface. Relance ensuite `maestro stop` puis `maestro` pour revenir au mode normal.

## Sécurité et données

- Le serveur écoute uniquement sur `127.0.0.1:4747`. Chaque requête exige un jeton stocké dans `~/.maestro/token`, et les autres origines sont refusées : un site web ne peut pas piloter tes agents.
- Tout reste sur ton Mac, dans `~/.maestro/` : état des projets, journaux d'activité, historique de l'assistant. Seules les sessions Claude Code communiquent avec Anthropic, comme quand tu utilises `claude` dans un terminal.

## Dépannage

- **« Claude Code n'est pas connecté »** : lance `claude` dans un terminal et connecte-toi.
- **Le tableau de bord demande un jeton** : ouvre-le avec `maestro open` plutôt qu'avec un favori.
- **Journal du serveur** : `~/.maestro/maestro.log`.
- **Tests** : `npm test`, entièrement en mode simulé.
