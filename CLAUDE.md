# Maestro — guide pour travailler sur le code

Maestro est un orchestrateur local d'agents Claude Code pour macOS. Il lit un `PLAN.md`, lance un agent par étape (Claude Agent SDK), en parallèle via des worktrees git, et expose un tableau de bord web local avec notifications.

L'interface et les messages sont en français, tutoiement, ton direct.

## Architecture

```
bin/maestro.js     CLI : maestro [dossier] | open | init | status | stop | service | update
src/server.js      Serveur HTTP 127.0.0.1:4747, API REST + flux SSE (/api/events), jeton obligatoire
src/manager.js     Liste des projets suivis (~/.maestro/projects.json)
src/project.js     Un projet : lecture du plan, ordonnanceur, cycle de vie des étapes, fusion
src/plan.js        Analyse et mise à jour de PLAN.md (étapes ##, agent:, après:, validation:, cases)
src/agent.js       Lance une session via query() du SDK, normalise les événements, autorisations,
                   outils MCP internes (ask_user, report_progress), mode simulé MAESTRO_FAKE=1
src/git.js         Worktrees, commits, fusion --no-ff, détection de conflits
src/inbox.js       Boîte « À traiter » : autorisations, questions, validations, conflits, erreurs
src/bus.js         Diffusion SSE et notifications (bandeau, navigateur, macOS natif)
src/assistant.js   Conversation assistant, mémoire (MEMOIRE.md), routines à heure fixe
src/claude-account.js  Compte Claude en lecture (~/.claude) : skills, plugins, tâches planifiées ; lecture MCP sans autorisation
src/claude-sync.js Projets claude.ai (import de l'export de données) et routines claude.ai (RemoteTrigger) → ~/.maestro/claude/
src/providers.js   Connexions Claude / ChatGPT / Gemini / modèle local (Ollama, sans clé) : clé collée, vérifiée, rangée dans ~/.maestro/keys.json (600) ; chat simple ChatGPT/Gemini
src/config.js      Réglages (~/.maestro/config.json), commandes autorisées par défaut
public/            Tableau de bord sans étape de build : index.html, app.js, styles.css, sw.js
test/run-tests.js  Tests de bout en bout en mode simulé (npm test)
```

## Statuts d'une étape

`blocked` → `ready` → `running` (`waiting` si un élément l'attend dans la boîte) → `review` → `merging` → `done`.
Branches de sortie : `conflict`, `failed`, `stopped`, `interrupted` (serveur arrêté pendant le travail).
Une étape `done` dans PLAN.md (toutes les cases cochées ou ✅) est terminée, sauf si un statut actif est en cours.

## Règles

- Données utilisateur uniquement dans `~/.maestro/` (variable `MAESTRO_HOME` pour les tests). Ne jamais les écrire dans le dépôt.
- Les agents ne modifient pas PLAN.md : `commitAll` restaure le fichier avant commit.
- Le serveur n'écoute que sur 127.0.0.1 et exige le jeton (`X-Maestro-Token` ou `?t=`).
- Aucune dépendance front, aucune étape de build. Garder `public/` en JS natif.
- Thème « bioluminescence » : tokens CSS dans `:root` (dégradé irisé `--iri`), sombre par défaut, clair via `prefers-color-scheme` ou `data-theme`. Pas de logos de marques (Claude, OpenAI, Google) : monogrammes maison.
- Clés des services : jamais renvoyées au navigateur (`publicInfo` ne donne que les 4 derniers caractères). Pas de bouton « Se connecter avec Claude » : interdit par Anthropic pour une appli tierce.
- Toute nouvelle fonctionnalité d'orchestration a un test dans `test/run-tests.js` (mode simulé, aucun appel à Claude).

## Vérifier

```bash
npm test                                   # tests simulés
MAESTRO_FAKE=1 MAESTRO_PORT=4790 node bin/maestro.js serve   # serveur simulé pour l'interface
```

Pour livrer : bumper `version` dans package.json, commit sur `main`, push. Les utilisateurs récupèrent avec `maestro update`.
