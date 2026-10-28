import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { getConfig } from './config.js';
import { PORT } from './paths.js';

/** Bus d'événements interne : tout ce qui doit arriver au tableau de bord passe par ici. */
export const bus = new EventEmitter();
bus.setMaxListeners(100);

export function broadcast(type, data) {
  bus.emit('broadcast', { type, data });
}

// Présence des tableaux de bord ouverts : sert à éviter les notifications en double.
const clients = new Map(); // id -> { visible, notif }
export function setPresence(id, state) {
  if (state === null) clients.delete(id);
  else clients.set(id, { ...(clients.get(id) || {}), ...state });
}
export function presence() {
  return [...clients.values()];
}

let notifier;
function findTerminalNotifier() {
  if (notifier !== undefined) return notifier;
  notifier = ['/opt/homebrew/bin/terminal-notifier', '/usr/local/bin/terminal-notifier'].find((p) => fs.existsSync(p)) || null;
  return notifier;
}

const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

function nativeNotify({ title, body, url, group }) {
  const { sound } = getConfig().notifications;
  if (process.platform === 'darwin') {
    const tn = findTerminalNotifier();
    if (tn) {
      const args = ['-title', 'Maestro', '-subtitle', title, '-message', body || ' ', '-group', group || 'maestro'];
      if (url) args.push('-open', url);
      if (sound) args.push('-sound', 'Glass');
      execFile(tn, args, () => {});
    } else {
      const script = `display notification "${esc(body || '')}" with title "Maestro" subtitle "${esc(title)}"${sound ? ' sound name "Glass"' : ''}`;
      execFile('osascript', ['-e', script], () => {});
    }
  } else if (process.platform === 'linux') {
    execFile('notify-send', ['Maestro — ' + title, body || ''], () => {});
  }
}

/**
 * Notifie l'utilisateur.
 * - Tableau de bord visible : bandeau dans l'interface.
 * - Tableau de bord ouvert en arrière-plan avec les notifications autorisées : notification du navigateur.
 * - Sinon : notification macOS native (avec terminal-notifier si installé, cliquable).
 */
export function notify({ title, body = '', kind = 'info', projectId = null, stepId = null, inboxId = null }) {
  const path = projectId ? `#/p/${projectId}${stepId ? `/s/${encodeURIComponent(stepId)}` : ''}` : inboxId ? '#/inbox' : '#/';
  const url = `http://127.0.0.1:${PORT}/${path}`;
  broadcast('notify', { title, body, kind, path, at: Date.now() });
  const mode = getConfig().notifications.native;
  if (mode === 'never') return;
  const handledByBrowser = presence().some((c) => c.visible || c.notif === 'granted');
  if (mode === 'always' || !handledByBrowser) nativeNotify({ title, body, url, group: projectId || 'maestro' });
}
