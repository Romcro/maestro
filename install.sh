#!/bin/bash
# Installation de Maestro sur macOS.
set -e
cd "$(dirname "$0")"

violet=$'\e[35m'; green=$'\e[32m'; red=$'\e[31m'; dim=$'\e[2m'; reset=$'\e[0m'
echo "${violet}◆ Maestro${reset} — installation"

if ! command -v node >/dev/null 2>&1; then
  echo "${red}Node.js est introuvable.${reset} Installe-le avec : brew install node"
  exit 1
fi
major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$major" -lt 18 ]; then
  echo "${red}Node.js $major est trop ancien (18 minimum).${reset} Mets-le à jour : brew upgrade node"
  exit 1
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "${dim}Claude Code n'est pas dans ton PATH. Les agents utilisent ta connexion Claude Code :"
  echo "installe-le (https://claude.com/claude-code) puis lance « claude » une fois pour te connecter.${reset}"
fi

echo "${dim}Installation des dépendances…${reset}"
npm install --omit=dev --no-audit --no-fund --loglevel=error

echo "${dim}Ajout de la commande « maestro »…${reset}"
if ! npm install -g . --no-audit --no-fund --loglevel=error 2>/dev/null; then
  echo "${dim}Droits insuffisants pour npm -g, on passe par ~/.local/bin.${reset}"
  mkdir -p "$HOME/.local/bin"
  ln -sf "$(pwd)/bin/maestro.js" "$HOME/.local/bin/maestro"
  chmod +x bin/maestro.js
  case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo "Ajoute ~/.local/bin à ton PATH : echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc";; esac
fi

if ! command -v terminal-notifier >/dev/null 2>&1 && command -v brew >/dev/null 2>&1; then
  read -r -p "Installer terminal-notifier pour des notifications macOS cliquables ? [O/n] " ans
  if [ -z "$ans" ] || [[ "$ans" =~ ^[oOyY] ]]; then brew install terminal-notifier; fi
fi

read -r -p "Lancer Maestro automatiquement à l'ouverture de ta session ? [O/n] " ans
if [ -z "$ans" ] || [[ "$ans" =~ ^[oOyY] ]]; then node bin/maestro.js service; fi

echo
echo "${green}C'est prêt.${reset} Dans le dossier d'un projet, tape :  ${violet}maestro${reset}"
echo "${dim}Pour essayer sans consommer ton forfait : maestro stop && MAESTRO_FAKE=1 maestro${reset}"
