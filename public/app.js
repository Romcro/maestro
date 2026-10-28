// Maestro — tableau de bord (vanilla JS, aucune étape de build).

// ------------------------------------------------------------------ jeton & API
const hashToken = location.hash.match(/[?&]t=([^&]+)/);
if (hashToken) {
  try { localStorage.setItem('maestro.token', decodeURIComponent(hashToken[1])); } catch {}
  history.replaceState(null, '', location.pathname + location.hash.replace(/[?&]t=[^&]+/, ''));
}
const TOKEN = (() => { try { return localStorage.getItem('maestro.token') || ''; } catch { return ''; } })();
const CLIENT = Math.random().toString(36).slice(2);

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Maestro-Token': TOKEN },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}
const act = async (method, url, body, okMsg) => {
  try {
    const r = await api(method, url, body);
    if (r && r.ok === false && r.message) toast({ title: 'Action impossible', body: r.message, kind: 'error' });
    else if (okMsg) toast({ title: okMsg, kind: 'success' });
    return r;
  } catch (e) {
    toast({ title: 'Action impossible', body: e.message, kind: 'error' });
    return null;
  }
};

// ------------------------------------------------------------------ état
const S = {
  connected: false,
  projects: new Map(),
  order: [],
  inbox: [],
  assistant: { messages: [], busy: false, live: null, routines: [] },
  config: {},
  claude: null,
  fake: false,
  version: '',
};
const logs = new Map(); // "pid/sid" -> events
const diffs = new Map(); // "pid/sid" -> { stats, open: Set, patches: Map }
const drafts = {};
let detailTab = 'activity';

// ------------------------------------------------------------------ utilitaires
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;
const money = (n) => (n >= 0.995 ? `${n.toFixed(2)} $` : n > 0 ? `${(n * 100).toFixed(0)} ¢` : '0 $');

function ago(ts) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 45) return "à l'instant";
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.round(s / 3600)} h`;
  return new Date(ts).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}
function duration(a, b) {
  if (!a) return '';
  const s = Math.round(((b || Date.now()) - a) / 1000);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')}`;
  return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
}
const clock = (ts) => new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

/** Markdown minimal et sûr (le texte est échappé avant transformation). */
function md(src) {
  const blocks = [];
  let text = esc(src || '').replace(/```[\w-]*\n([\s\S]*?)```/g, (_, code) => {
    blocks.push(`<pre><code>${code.replace(/\n$/, '')}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  const inline = (s) =>
    s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const out = [];
  let list = null;
  const flush = () => { if (list) { out.push(`<${list.t}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.t}>`); list = null; } };
  let para = [];
  const flushP = () => { if (para.length) { out.push(`<p>${inline(para.join('<br>'))}</p>`); para = []; } };
  for (const line of text.split('\n')) {
    const b = line.match(/^\u0000(\d+)\u0000$/);
    const ul = line.match(/^\s*[-*•]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const h = line.match(/^#{1,4}\s+(.*)$/);
    if (b) { flushP(); flush(); out.push(blocks[Number(b[1])]); }
    else if (ul || ol) { flushP(); const t = ul ? 'ul' : 'ol'; if (list && list.t !== t) flush(); list = list || { t, items: [] }; list.items.push((ul || ol)[1]); }
    else if (h) { flushP(); flush(); out.push(`<h4>${inline(h[1])}</h4>`); }
    else if (!line.trim()) { flushP(); flush(); }
    else { flush(); para.push(line); }
  }
  flushP(); flush();
  return `<div class="md">${out.join('')}</div>`;
}

// ------------------------------------------------------------------ icônes
const P = {
  read: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  write: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 11v6M9 14h6"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  terminal: '<path d="M5 7l5 5-5 5M12 18h7"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
  web: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/>',
  agent: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.8-3.2 3-5 5.5-5s4.7 1.8 5.5 5"/><circle cx="17" cy="9" r="2.4"/><path d="M16 14.2c2.4.2 4 1.8 4.6 4.8"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/>',
  question: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.6 2.6 0 0 1 5 .9c0 1.8-2.5 2.2-2.5 3.8"/><circle cx="12" cy="17.3" r=".6" fill="currentColor"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  plug: '<path d="M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0zM12 16v5"/>',
  tool: '<path d="M14.5 5.5a4 4 0 0 0 4.9 4.9L10 19.8a2 2 0 0 1-2.8-2.8l9.4-9.4"/>',
  error: '<path d="M12 4l9 16H3z"/><path d="M12 10v4"/><circle cx="12" cy="17" r=".6" fill="currentColor"/>',
  play: '<path d="M8 5.5v13l10-6.5z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  inbox: '<path d="M4 13l2.5-7h11L20 13v6H4z"/><path d="M4 13h4.5l1 2h5l1-2H20"/>',
  chat: '<path d="M5 18.5V6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8.5z"/>',
  folder: '<path d="M3.5 7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  branch: '<circle cx="7" cy="6" r="2"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="8" r="2"/><path d="M7 8v8M17 10c0 4-10 2-10 6"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  send: '<path d="M4.5 12h13M12.5 6l6 6-6 6"/>',
  refresh: '<path d="M19.5 8A8 8 0 0 0 5 9M4.5 16A8 8 0 0 0 19 15"/><path d="M19.5 3.5V8H15M4.5 20.5V16H9"/>',
  code: '<path d="M8.5 7L3.5 12l5 5M15.5 7l5 5-5 5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  coin: '<circle cx="12" cy="12" r="8.5"/><path d="M14.8 9.3c-.5-.9-1.6-1.4-2.8-1.4-1.6 0-2.8.9-2.8 2.1 0 2.8 5.8 1.4 5.8 4.2 0 1.2-1.3 2.1-3 2.1-1.3 0-2.4-.6-2.9-1.5M12 6v1.9M12 16.3V18"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  wave: '<path d="M3 12c2.5-6 5.5-6 8 0s5.5 6 8 0"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
};
const icon = (name, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || P.tool}</svg>`;
const REACTOR = `<svg viewBox="0 0 64 64" fill="none" aria-hidden="true"><circle cx="32" cy="32" r="27" stroke="currentColor" stroke-opacity=".45" stroke-width="3.5" stroke-dasharray="1.8 3.6"/><circle cx="32" cy="32" r="19" stroke="currentColor" stroke-width="2.6" stroke-dasharray="22 7.8"/><circle cx="32" cy="32" r="12" stroke="currentColor" stroke-opacity=".6" stroke-width="1.2"/><circle cx="32" cy="32" r="7.5" fill="currentColor"/></svg>`;
const BRAND = `<div class="brand">${REACTOR}<span>Maestro<small>Système en ligne</small></span></div>`;

const STATUS = {
  blocked: 'À venir',
  ready: 'Prête',
  running: 'Au travail',
  waiting: 'Attend ta réponse',
  review: 'À valider',
  merging: 'Fusion…',
  conflict: 'Conflit',
  failed: 'Échec',
  stopped: 'Arrêtée',
  interrupted: 'Interrompue',
  done: 'Terminée',
};
const ATTENTION = new Set(['waiting', 'review', 'conflict', 'failed', 'interrupted', 'stopped']);
const ACTIVE = new Set(['running', 'waiting', 'merging']);
const chip = (status) => `<span class="chip s-${status}">${STATUS[status] || status}</span>`;

// ------------------------------------------------------------------ routage
function parseRoute() {
  const h = location.hash.replace(/^#/, '').replace(/[?&]t=[^&]*/, '') || '/';
  let m;
  if ((m = h.match(/^\/p\/([^/]+)\/s\/([^/]+)/))) return { view: 'project', pid: m[1], sid: decodeURIComponent(m[2]) };
  if ((m = h.match(/^\/p\/([^/]+)/))) return { view: 'project', pid: m[1], sid: null };
  if (h.startsWith('/inbox')) return { view: 'inbox' };
  if (h.startsWith('/assistant')) return { view: 'assistant' };
  return { view: 'home' };
}
let R = parseRoute();
const go = (path) => { location.hash = path; };
window.addEventListener('hashchange', () => {
  const prev = R;
  R = parseRoute();
  if (prev.sid !== R.sid || prev.pid !== R.pid) detailTab = 'activity';
  $('#app').classList.remove('show-nav');
  render();
  if (R.sid) loadLog(R.pid, R.sid);
});

// ------------------------------------------------------------------ rendu avec préservation de la saisie
function patch(el, html) {
  if (!el) return;
  const active = document.activeElement;
  const key = active && el.contains(active) ? active.dataset.key : null;
  const sel = key && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
  const scrolls = [...el.querySelectorAll('[data-scroll]')].map((n) => [n.dataset.scroll, n.scrollTop, n.scrollHeight - n.scrollTop - n.clientHeight < 40]);
  el.innerHTML = html;
  for (const [k, top, atBottom] of scrolls) {
    const n = el.querySelector(`[data-scroll="${k}"]`);
    if (n) n.scrollTop = atBottom ? n.scrollHeight : top;
  }
  if (key) {
    const n = el.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (n) {
      n.focus();
      if (sel && 'setSelectionRange' in n) try { n.setSelectionRange(...sel); } catch {}
    }
  }
}
const draft = (key, placeholder, { rows = 1, cls = '' } = {}) =>
  `<textarea data-key="${esc(key)}" class="${cls}" rows="${rows}" placeholder="${esc(placeholder)}">${esc(drafts[key] || '')}</textarea>`;

document.addEventListener('input', (e) => {
  const k = e.target.dataset?.key;
  if (k) drafts[k] = e.target.value;
  if (e.target.tagName === 'TEXTAREA' && e.target.closest('.composer, .chat-input, .answer')) autosize(e.target);
});
function autosize(t) {
  t.style.height = 'auto';
  t.style.height = `${Math.min(t.scrollHeight + 2, 200)}px`;
}

let renderQueued = false;
function render() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderNow();
  });
}

function renderNow() {
  const app = $('#app');
  if (!TOKEN) {
    app.className = 'app';
    app.style.gridTemplateColumns = '1fr';
    app.innerHTML = `<main class="main"><div class="empty">
      ${BRAND.replace('class="brand"', 'class="brand" style="padding:0"')}
      <h1>Ouvre Maestro depuis ton terminal</h1>
      <p>Pour des raisons de sécurité, le tableau de bord a besoin du jeton que la commande lui transmet. Dans le dossier de ton projet, tape :</p>
      <div class="term"><span class="p">$ </span>maestro</div>
    </div></main>`;
    return;
  }
  const project = R.view === 'project' ? S.projects.get(R.pid) : null;
  const step = project && R.sid ? project.steps.find((s) => s.id === R.sid) : null;
  const shell = $('#shell-side');
  if (!shell) {
    app.innerHTML = `<aside class="side" id="shell-side"></aside><main class="main" id="shell-main"></main><aside class="detail" id="shell-detail" hidden></aside>`;
  }
  app.classList.toggle('with-detail', !!step);
  $('#shell-detail').hidden = !step;
  patch($('#shell-side'), renderSide());
  let main;
  if (R.view === 'project') main = project ? renderProject(project) : renderMissing();
  else if (R.view === 'inbox') main = renderInboxPage();
  else if (R.view === 'assistant') main = renderAssistant();
  else main = renderHome();
  patch($('#shell-main'), main);
  if (step) patch($('#shell-detail'), renderDetail(project, step));
  if (project) requestAnimationFrame(drawLinks);
  const fab = $('#voice-fab');
  fab.hidden = R.view === 'assistant';
  fab.dataset.state = coreState();
  document.querySelectorAll('.composer textarea, .chat-input textarea, .answer textarea').forEach(autosize);
  const n = S.inbox.length;
  document.title = n ? `(${n}) Maestro` : 'Maestro';
  if ('setAppBadge' in navigator) (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch?.(() => {});
}

// ------------------------------------------------------------------ barre latérale
function renderSide() {
  const n = S.inbox.length;
  const cur = (v, pid) => (R.view === v && (!pid || R.pid === pid) ? ' aria-current="page"' : '');
  const projects = S.order.map((id) => S.projects.get(id)).filter(Boolean);
  return `
    ${BRAND}
    <nav class="nav" aria-label="Navigation">
      <a class="nav-item" href="#/inbox"${cur('inbox')}>${icon('inbox')}<span>À traiter</span>${n ? `<span class="count">${n}</span>` : ''}</a>
      <a class="nav-item" href="#/assistant"${cur('assistant')}>${icon('chat')}<span>Assistant</span>${S.assistant.busy ? '<span class="dot on" style="margin-left:auto"></span>' : ''}</a>
      <button class="nav-item" data-action="voice" title="Raccourci : ⌥ M">${icon('mic')}<span>${V.state === 'listening' ? 'J\'écoute…' : 'Parler à Maestro'}</span></button>
    </nav>
    <div class="nav-heading">Projets</div>
    <div class="projects">
      ${projects.map((p) => `
        <a class="nav-item proj-item" href="#/p/${p.id}"${cur('project', p.id)} title="${esc(p.path)}">
          <span class="name">${esc(p.title)}</span><span class="dot${p.running ? ' on' : ''}" title="${p.running ? 'En cours' : 'En pause'}"></span>
          <span class="meter">${p.steps.map((s) => `<i class="${s.status === 'done' ? 'done' : ACTIVE.has(s.status) ? 'active' : ATTENTION.has(s.status) ? 'attention' : ''}"></i>`).join('')}</span>
        </a>`).join('') || '<div class="side-foot hint" style="border:0">Aucun projet pour l\'instant.</div>'}
    </div>
    <div class="side-foot">
      <button class="nav-item" data-action="add-project">${icon('plus')}<span>Ajouter un projet</span></button>
      <button class="nav-item" data-action="settings">${icon('settings')}<span>Réglages</span></button>
      <div class="hint">${S.connected ? `Connecté · v${esc(S.version)}` : 'Reconnexion…'}</div>
    </div>`;
}

// ------------------------------------------------------------------ accueil
function renderHome() {
  const projects = S.order.map((id) => S.projects.get(id)).filter(Boolean);
  if (!projects.length) {
    return `<div class="empty">
      <h1>Ajoute ton premier projet</h1>
      <p>Maestro lit le <code>PLAN.md</code> de ton projet, lance un agent Claude Code par étape, en parallèle quand c'est possible, et te prévient quand il a besoin de toi.</p>
      <p>Depuis un terminal, dans le dossier du projet :</p>
      <div class="term"><span class="p">$ </span>maestro</div>
      <p>Ou colle le chemin du dossier :</p>
      <form class="btn-row" data-form="add-project" style="flex-wrap:nowrap">
        <input type="text" name="path" placeholder="/Users/toi/code/mon-projet" required>
        <button class="btn primary" type="submit">Ajouter</button>
      </form>
    </div>`;
  }
  return `<div class="page">
    <h1>${greet()}</h1>
    <p class="lead">${homeLine(projects)}</p>
    ${S.inbox.length ? `<div style="display:grid;gap:10px;margin-bottom:28px">${S.inbox.slice(0, 4).map(renderAsk).join('')}${S.inbox.length > 4 ? `<a href="#/inbox">Voir les ${S.inbox.length} éléments</a>` : ''}</div>` : ''}
    <div style="display:grid;gap:12px">
      ${projects.map((p) => `
        <a class="panel" href="#/p/${p.id}" style="text-decoration:none;color:inherit">
          <div style="display:flex;justify-content:space-between;gap:12px;align-items:baseline">
            <h3>${esc(p.title)}</h3>${p.running ? chip('running').replace('Au travail', 'Actif') : '<span class="muted" style="font-size:13px">En pause</span>'}
          </div>
          ${progressBar(p)}
          <p class="muted" style="margin:0">${whereText(p, false)}</p>
        </a>`).join('')}
    </div>
  </div>`;
}
function homeLine(projects) {
  const active = projects.reduce((n, p) => n + p.totals.running, 0);
  const parts = [];
  parts.push(active ? `${plural(active, 'agent travaille', 'agents travaillent')} en ce moment.` : 'Aucun agent ne travaille en ce moment.');
  if (S.inbox.length) parts.push(`${plural(S.inbox.length, 'chose attend', 'choses attendent')} ta réponse.`);
  return parts.join(' ');
}
const greet = () => { const h = new Date().getHours(); return h < 5 ? 'Bonne nuit' : h < 18 ? 'Bonjour' : 'Bonsoir'; };

function renderMissing() {
  return `<div class="empty"><h1>Projet introuvable</h1><p>Il a peut-être été retiré de Maestro.</p><p><a href="#/">Retour à l'accueil</a></p></div>`;
}

// ------------------------------------------------------------------ projet
function progressBar(p) {
  const t = p.totals.total || 1;
  const done = p.steps.filter((s) => s.status === 'done').length;
  const act = p.steps.filter((s) => s.status === 'running' || s.status === 'merging').length;
  const att = p.steps.filter((s) => ATTENTION.has(s.status)).length;
  const seg = (n, cls) => (n ? `<i class="${cls}" style="width:${(n / t) * 100}%"></i>` : '');
  return `<div class="bar" role="img" aria-label="${done} étapes terminées sur ${p.totals.total}">${seg(done, 'done')}${seg(act, 'active')}${seg(att, 'attention')}</div>`;
}

function whereText(p, withLink = true) {
  const { total, done } = p.totals;
  if (!total) return p.planFile ? 'Le plan ne contient aucune étape « ## ».' : 'Pas encore de plan.';
  const running = p.steps.filter((s) => ACTIVE.has(s.status)).length;
  const att = S.inbox.filter((i) => i.projectId === p.id).length;
  if (done === total) return `<b>Plan terminé.</b> Les ${total} étapes sont faites.`;
  const parts = [`<b>${done} étape${done > 1 ? 's' : ''} sur ${total}</b> terminée${done > 1 ? 's' : ''}.`];
  if (running) parts.push(`${plural(running, 'agent au travail', 'agents au travail')}.`);
  else if (!p.running) parts.push('Le plan est en pause.');
  if (att) parts.push(withLink ? `<button class="link" data-action="scroll-attn">${plural(att, 'chose attend', 'choses attendent')} ta réponse</button>.` : `${plural(att, 'chose attend', 'choses attendent')} ta réponse.`);
  else if (p.running && !running) {
    const next = p.steps.find((s) => s.status === 'blocked');
    if (next) parts.push(`En attente avant l'étape ${esc(next.id)}.`);
  }
  return parts.join(' ');
}

function renderProject(p) {
  const banners = [];
  if (!p.exists) banners.push(banner('error', `Le dossier ${esc(p.path)} n'existe plus.`, `<button class="btn sm" data-action="remove-project" data-pid="${p.id}">Retirer de Maestro</button>`, 'warn'));
  if (S.fake) banners.push(banner('wave', 'Mode simulé : les agents font semblant, rien n\'est envoyé à Claude.'));
  if (p.exists && !p.isGit) {
    banners.push(
      banner(
        'branch',
        p.hasRepo
          ? "Le dépôt git n'a encore aucun commit. Sans commit, les étapes tournent une par une, directement dans ton dossier."
          : "Ce dossier n'est pas un dépôt git. Les étapes tourneront une par une, directement dans ton dossier. Avec git, chaque agent a sa propre copie et ils peuvent travailler en parallèle.",
        `<button class="btn sm" data-action="init-git" data-pid="${p.id}">Initialiser git</button>`,
      ),
    );
  }
  for (const w of p.warnings || []) banners.push(banner('error', esc(w), '', 'warn'));
  if (!S.claude && !S.fake) banners.push(banner('terminal', "Maestro n'a pas trouvé la commande <code>claude</code>. Les agents utilisent ta connexion Claude Code : installe-la et connecte-toi une fois avec <code>claude</code> dans un terminal."));

  const attn = S.inbox.filter((i) => i.projectId === p.id);
  const head = `
    <header class="head">
      <div class="head-top">
        <div>
          <h1>${esc(p.title)}</h1>
          <div class="path">
            <span>${icon('folder')}${esc(p.path.replace(/^\/Users\/[^/]+/, '~'))}</span>
            ${p.isGit ? `<span>${icon('branch')}${esc(p.baseBranch || '')}</span>` : ''}
            ${p.totals.cost ? `<span>${icon('coin')}${money(p.totals.cost)}</span>` : ''}
          </div>
        </div>
        <div class="btn-row">
          <button class="btn back icon" data-action="nav" aria-label="Menu">${icon('menu')}</button>
          <button class="btn ghost icon" data-action="open-editor" data-pid="${p.id}" title="Ouvrir dans VS Code" aria-label="Ouvrir dans VS Code">${icon('code')}</button>
          <button class="btn ghost icon" data-action="reload" data-pid="${p.id}" title="Relire le plan" aria-label="Relire le plan">${icon('refresh')}</button>
          ${p.steps.length ? (p.running
            ? `<button class="btn" data-action="pause" data-pid="${p.id}">${icon('pause')}Mettre en pause</button>`
            : `<button class="btn primary" data-action="start" data-pid="${p.id}" ${p.totals.done === p.totals.total ? 'disabled' : ''}>${icon('play')}Lancer le plan</button>`) : ''}
        </div>
      </div>
      ${p.steps.length ? `<div class="where">${whereText(p)}</div>${progressBar(p)}` : ''}
    </header>`;

  if (!p.steps.length) return head + banners.join('') + renderNoPlan(p);

  return `${head}${banners.join('')}
    <div class="proj-body${attn.length ? ' has-attn' : ''}">
      ${attn.length ? `<section class="attn-col" id="attn" aria-label="À traiter"><h2 class="attn-h">${icon('bell')}À toi de jouer</h2>${attn.map((it) => renderAsk(it, { inProject: true })).join('')}</section>` : ''}
      <section class="score-wrap" aria-label="Plan">${renderScore(p)}</section>
    </div>`;
}

function banner(ic, html, actions = '', cls = '') {
  return `<div class="banner ${cls}">${icon(ic)}<div class="grow">${html}</div>${actions}</div>`;
}

function renderNoPlan(p) {
  if (p.planning?.status === 'running') {
    return `<div class="empty"><h1>Claude rédige ton plan…</h1><p>${esc(p.planning.text || '')}</p><div class="typing"><i></i><i></i><i></i></div><p class="muted">Le plan apparaîtra ici dès qu'il sera enregistré dans PLAN.md. Tu pourras le relire et le modifier avant de lancer.</p></div>`;
  }
  return `<div class="empty" style="max-width:860px">
    <h1>Ce projet n'a pas encore de plan</h1>
    <p>Maestro cherche un fichier <code>PLAN.md</code> à la racine du dossier. Chaque titre <code>## </code> devient une étape confiée à un agent.</p>
    ${p.planning?.status === 'failed' ? banner('error', `La rédaction a échoué : ${esc(p.planning.text)}`, '', 'warn') : ''}
    <div class="choice-grid">
      <form class="panel" data-form="generate-plan" data-pid="${p.id}">
        <h3>Décris ce que tu veux construire</h3>
        <p class="muted" style="margin:0">Claude explore le dépôt et écrit un plan découpé en étapes parallélisables.</p>
        ${draft(`plan-${p.id}`, 'Ex. : une app de suivi de budget en Next.js avec authentification, import CSV et graphiques mensuels.', { rows: 4 })}
        <div><button class="btn primary" type="submit">Rédiger le plan</button></div>
      </form>
      <div class="panel">
        <h3>Écrire le plan moi-même</h3>
        <p class="muted" style="margin:0">Crée un PLAN.md modèle à compléter dans VS Code.</p>
        <pre style="font-size:12px;margin:0;padding:10px;border:1px solid var(--line);border-radius:9px;background:var(--bg)">## 2. API
agent: backend · après: 1
- [ ] Endpoint /login</pre>
        <div class="btn-row"><button class="btn" data-action="template" data-pid="${p.id}">Créer PLAN.md</button><button class="btn ghost" data-action="open-editor" data-pid="${p.id}">Ouvrir dans VS Code</button></div>
      </div>
    </div>
  </div>`;
}

/** Disposition en « vagues » : une colonne par profondeur de dépendance. */
function waves(p) {
  const byId = new Map(p.steps.map((s) => [s.id, s]));
  const depth = new Map();
  const visiting = new Set();
  const d = (s) => {
    if (depth.has(s.id)) return depth.get(s.id);
    if (visiting.has(s.id)) return 0;
    visiting.add(s.id);
    const v = s.after.length ? Math.max(...s.after.map((a) => (byId.has(a) ? d(byId.get(a)) + 1 : 0))) : 0;
    visiting.delete(s.id);
    depth.set(s.id, v);
    return v;
  };
  p.steps.forEach(d);
  const cols = [];
  for (const s of p.steps) (cols[depth.get(s.id)] ||= []).push(s);
  return cols.filter(Boolean);
}

function renderScore(p) {
  const cols = waves(p);
  return `<div class="score" id="score" data-pid="${p.id}">
    <svg class="links" id="links"></svg>
    ${cols.map((col, i) => `
      <div class="wave">
        <div class="wave-label">${i === 0 ? 'Démarrage' : col.length > 1 ? `Puis, en parallèle` : 'Puis'}</div>
        ${col.map((s) => renderNode(p, s)).join('')}
      </div>`).join('')}
  </div>`;
}

function renderNode(p, s) {
  const done = s.items.filter((i) => i.done).length;
  let ticker = '';
  if (ACTIVE.has(s.status)) {
    const la = s.progress || s.lastActivity?.label;
    ticker = la ? `<span class="ticker">${icon(s.lastActivity?.icon || 'wave')}<span>${esc(la)}</span></span>` : `<span class="ticker">${icon('wave')}<span>Démarrage…</span></span>`;
  } else if (s.status === 'review' && s.diff) {
    ticker = `<span class="ticker">${icon('edit')}<span>${plural(s.diff.files, 'fichier', 'fichiers')} <span class="add">+${s.diff.add}</span> <span class="del">−${s.diff.del}</span></span></span>`;
  } else if (s.status === 'blocked' && s.after.length) {
    ticker = `<span class="ticker muted">Après ${s.after.map((a) => `l'étape ${esc(a)}`).join(' et ')}</span>`;
  } else if ((s.status === 'failed' || s.status === 'interrupted') && s.error) {
    ticker = `<span class="ticker" style="color:var(--red)">${icon('error')}<span>${esc(s.error)}</span></span>`;
  } else if (s.status === 'done' && s.finishedAt) {
    ticker = `<span class="ticker muted">${ago(s.finishedAt)}${s.cost ? ` · ${money(s.cost)}` : ''}</span>`;
  }
  return `<button class="node s-${s.status}" id="node-${esc(s.id)}" data-step="${esc(s.id)}" data-after="${esc(s.after.join(','))}" ${R.sid === s.id ? 'aria-current="true"' : ''} data-action="open-step" data-pid="${p.id}">
    <span class="node-top"><span class="num">${esc(s.id)}</span><span class="title">${esc(s.title)}</span></span>
    <span class="who"><span>${s.agent ? esc(s.agent) : 'agent'}</span>${chip(s.status)}</span>
    ${ticker}
    ${s.items.length ? `<span class="items" title="${done} sur ${s.items.length} sous-tâches">${s.items.map((it) => `<i class="${it.done ? 'on' : ''}"></i>`).join('')}</span>` : ''}
  </button>`;
}

function drawLinks() {
  const score = $('#score');
  const svg = $('#links');
  if (!score || !svg) return;
  const pid = score.dataset.pid;
  const p = S.projects.get(pid);
  const box = score.getBoundingClientRect();
  svg.setAttribute('width', box.width);
  svg.setAttribute('height', box.height);
  const paths = [];
  for (const node of score.querySelectorAll('.node')) {
    const deps = node.dataset.after ? node.dataset.after.split(',') : [];
    const to = node.getBoundingClientRect();
    const step = p?.steps.find((s) => s.id === node.dataset.step);
    for (const d of deps) {
      const from = document.getElementById(`node-${d}`);
      if (!from) continue;
      const f = from.getBoundingClientRect();
      const x1 = f.right - box.left, y1 = f.top + 26 - box.top;
      const x2 = to.left - box.left, y2 = to.top + 26 - box.top;
      if (x2 <= x1) continue;
      const mx = (x1 + x2) / 2;
      const dep = p?.steps.find((s) => s.id === d);
      const cls = step && ACTIVE.has(step.status) ? 'live' : dep?.status === 'done' ? 'lit' : '';
      paths.push(`<path class="${cls}" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}"/>`);
    }
  }
  svg.innerHTML = paths.join('');
}
window.addEventListener('resize', () => requestAnimationFrame(drawLinks));

// ------------------------------------------------------------------ éléments « à traiter »
function renderAsk(it, { inProject = false } = {}) {
  const p = it.projectId ? S.projects.get(it.projectId) : null;
  const where = inProject ? '' : p
    ? `<a href="#/p/${p.id}${it.stepId && !it.stepId.startsWith('__') ? `/s/${encodeURIComponent(it.stepId)}` : ''}">${esc(p.title)}</a>`
    : it.stepId === '__assistant' ? '<a href="#/assistant">Assistant</a>' : '';
  let body = '';
  let actions = '';
  if (it.kind === 'permission') {
    body = `${it.detail ? `<div class="body">${esc(it.detail)}</div>` : ''}${it.preview ? `<pre>${esc(it.preview)}</pre>` : ''}`;
    actions = `<div class="btn-row">
      <button class="btn primary sm" data-action="answer" data-id="${it.id}" data-choice="allow">Autoriser</button>
      <button class="btn sm" data-action="answer" data-id="${it.id}" data-choice="always">Toujours pour cette session</button>
      <button class="btn sm danger" data-action="answer" data-id="${it.id}" data-choice="deny">Refuser</button></div>`;
  } else if (it.kind === 'question') {
    body = `<div class="body" style="color:var(--ink);font-size:15px">${md(it.detail)}</div>`;
    actions = `${it.choices?.length ? `<div class="choices">${it.choices.map((c) => `<button class="btn sm" data-action="answer" data-id="${it.id}" data-text="${esc(c)}">${esc(c)}</button>`).join('')}</div>` : ''}
      <form class="answer" data-form="answer" data-id="${it.id}">${draft(`ans-${it.id}`, 'Ta réponse…')}<button class="btn primary" type="submit">Répondre</button></form>`;
  } else if (it.kind === 'review') {
    body = it.detail ? `<div class="body">${md(it.detail.length > 700 ? `${it.detail.slice(0, 700)}…` : it.detail)}</div>` : '';
    actions = `<div class="btn-row">
      ${/bloquée/.test(it.title) ? `<button class="btn primary sm" data-action="step" data-op="validate" data-pid="${it.projectId}" data-sid="${esc(it.stepId)}">Réessayer la fusion</button>` : `<button class="btn primary sm" data-action="step" data-op="validate" data-pid="${it.projectId}" data-sid="${esc(it.stepId)}">${p?.isGit ? 'Valider et fusionner' : 'Valider'}</button>`}
      <a class="btn sm" href="#/p/${it.projectId}/s/${encodeURIComponent(it.stepId)}">Voir le travail</a></div>`;
  } else if (it.kind === 'conflict') {
    body = `<div class="body">D'autres étapes ont modifié les mêmes fichiers : ${esc(it.detail || '')}</div>`;
    actions = `<div class="btn-row"><button class="btn primary sm" data-action="step" data-op="resolve" data-pid="${it.projectId}" data-sid="${esc(it.stepId)}">Laisser l'agent résoudre</button><a class="btn sm" href="#/p/${it.projectId}/s/${encodeURIComponent(it.stepId)}">Voir</a></div>`;
  } else if (it.kind === 'error') {
    body = it.detail ? `<div class="body">${esc(it.detail)}</div>` : '';
    actions = `<div class="btn-row"><button class="btn primary sm" data-action="step" data-op="retry" data-pid="${it.projectId}" data-sid="${esc(it.stepId)}">Reprendre</button><a class="btn sm" href="#/p/${it.projectId}/s/${encodeURIComponent(it.stepId)}">Voir</a></div>`;
  }
  return `<article class="ask k-${it.kind}">
    <div class="ask-head"><span class="ask-title">${esc(it.title)}</span><span class="ask-where">${where}${where ? ' · ' : ''}${ago(it.createdAt)}</span></div>
    ${body}${actions}
  </article>`;
}

function renderInboxPage() {
  const items = S.inbox;
  return `<div class="page">
    <div class="btn-row" style="justify-content:space-between"><h1>À traiter</h1><button class="btn back icon" data-action="nav" aria-label="Menu">${icon('menu')}</button></div>
    <p class="lead">${items.length ? `Les agents attendent ${items.length > 1 ? 'ces réponses' : 'cette réponse'} pour continuer. Tu peux aussi répondre depuis la notification.` : 'Rien ne t\'attend. Les agents te préviendront dès qu\'ils auront besoin de toi.'}</p>
    <div style="display:grid;gap:10px">${items.map(renderAsk).join('')}</div>
  </div>`;
}

// ------------------------------------------------------------------ panneau d'une étape
function renderDetail(p, s) {
  const key = `${p.id}/${s.id}`;
  const tabs = [
    ['activity', 'Activité'],
    ['changes', `Modifications${s.diff?.files ? ` (${s.diff.files})` : ''}`],
    ['brief', 'Consigne'],
  ];
  const meta = [
    s.agent ? `<span>${icon('agent')}${esc(s.agent)}</span>` : '',
    s.branch ? `<span title="Branche">${icon('branch')}${esc(s.branch)}</span>` : '',
    s.startedAt ? `<span>${icon('clock')}${duration(s.startedAt, ACTIVE.has(s.status) ? null : s.finishedAt)}</span>` : '',
    s.cost ? `<span>${icon('coin')}${money(s.cost)}</span>` : '',
  ].join('');
  return `
    <div class="d-head">
      <div class="d-title"><span class="num">${esc(s.id)}</span><h2>${esc(s.title)}</h2><a class="btn ghost sm icon" href="#/p/${p.id}" aria-label="Fermer">${icon('x')}</a></div>
      <div class="d-meta">${chip(s.status)}${meta}</div>
    </div>
    <div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button class="tab" role="tab" aria-selected="${detailTab === k}" data-action="tab" data-tab="${k}">${l}</button>`).join('')}</div>
    <div class="d-body" data-scroll="d-${key}">${detailTab === 'activity' ? renderFeed(p, s) : detailTab === 'changes' ? renderChanges(p, s) : renderBrief(p, s)}</div>
    <div class="d-actions">${renderStepActions(p, s)}</div>`;
}

function renderStepActions(p, s) {
  const b = (op, label, cls = '', ic = '') => `<button class="btn sm ${cls}" data-action="step" data-op="${op}" data-pid="${p.id}" data-sid="${esc(s.id)}">${ic ? icon(ic) : ''}${label}</button>`;
  const tools = `${b('open-editor', '', 'ghost icon', 'code').replace('></button>', ' title="Ouvrir dans VS Code" aria-label="Ouvrir dans VS Code"></button>')}${s.hasSession && !ACTIVE.has(s.status) ? b('open-terminal', 'Terminal', 'ghost', 'terminal') : ''}`;
  let row = '';
  let composer = true;
  let placeholder = "Écrire à l'agent…";
  switch (s.status) {
    case 'blocked':
      row = b('run', 'Lancer quand même', '', 'play');
      composer = false;
      break;
    case 'ready':
      row = b('run', 'Lancer cette étape', 'primary', 'play');
      composer = false;
      break;
    case 'running':
    case 'waiting':
      row = b('stop', 'Arrêter', 'danger', 'stop');
      placeholder = "Écrire à l'agent (il le lira à la fin de son tour)…";
      break;
    case 'merging':
      composer = false;
      break;
    case 'review':
      row = `${b('validate', p.isGit ? 'Valider et fusionner' : 'Valider', 'primary', 'check')}${b('discard', 'Abandonner', 'ghost danger', 'trash')}`;
      placeholder = 'Demander une correction…';
      break;
    case 'conflict':
      row = `${b('resolve', "Laisser l'agent résoudre", 'primary')}${b('discard', 'Abandonner', 'ghost danger', 'trash')}`;
      break;
    case 'failed':
    case 'interrupted':
    case 'stopped':
      row = `${b('retry', 'Reprendre', 'primary', 'play')}${b('restart', 'Recommencer', '', 'undo')}${b('skip', 'Marquer comme terminée', 'ghost')}`;
      break;
    case 'done':
      row = b('reopen', 'Rouvrir', 'ghost', 'undo');
      composer = false;
      break;
  }
  const k = `msg-${p.id}-${s.id}`;
  return `<div class="btn-row">${row}<span class="spacer"></span>${tools}</div>
    ${composer ? `<form class="composer" data-form="message" data-pid="${p.id}" data-sid="${esc(s.id)}">${draft(k, placeholder)}<button class="btn primary icon" type="submit" aria-label="Envoyer">${icon('send')}</button></form>` : ''}`;
}

function renderFeed(p, s) {
  const key = `${p.id}/${s.id}`;
  const events = logs.get(key);
  if (!events) return '<p class="muted">Chargement…</p>';
  const parts = [];
  if (s.status === 'review' && s.summary) {
    parts.push(`<div class="ask k-review" style="margin-bottom:12px"><div class="ask-title">Résumé de l'agent</div>${md(s.summary)}</div>`);
  }
  if (s.todos?.length && ACTIVE.has(s.status)) {
    parts.push(`<div class="todos">${s.todos.map((t) => `<div class="${t.status}">${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '›' : '·'} ${esc(t.content || t.activeForm || '')}</div>`).join('')}</div>`);
  }
  if (!events.length) parts.push(`<p class="muted">${s.status === 'blocked' ? `Cette étape démarrera après l'étape ${esc(s.after.join(' et '))}.` : s.status === 'ready' ? 'Prête à démarrer dès qu\'un agent est libre.' : "Pas encore d'activité."}</p>`);
  const ev = (cls, ic, html, e) => `<div class="ev ${cls}${e.sub ? ' sub' : ''}">${icon(ic)}<div class="lbl">${html}</div><span class="time">${clock(e.at)}</span></div>`;
  let lastText = null;
  for (const e of events) {
    switch (e.type) {
      case 'start': parts.push(`<div class="sep">${esc(e.text)} · ${clock(e.at)}</div>`); break;
      case 'text': if (e.text !== lastText) parts.push(ev('text', 'chat', md(e.text), e)); lastText = e.text; break;
      case 'tool': parts.push(ev('tool', e.icon, esc(e.label), e)); break;
      case 'tool_error': parts.push(ev('err', 'error', esc(e.text), e)); break;
      case 'progress': parts.push(ev('good', 'check', esc(e.text), e)); break;
      case 'question': parts.push(ev('question', 'question', md(e.text), e)); break;
      case 'answer': parts.push(ev('user', 'send', esc(e.text), e)); break;
      case 'user': parts.push(ev('user', 'send', `${esc(e.text)}${e.queued ? ' <span class="muted">(en attente)</span>' : ''}`, e)); break;
      case 'permission': parts.push(ev(e.decision === 'deny' ? 'err' : 'good', 'bell', `${e.decision === 'deny' ? 'Refusé' : e.decision === 'cancelled' ? 'Annulé' : 'Autorisé'} : ${esc(e.label)}`, e)); break;
      case 'error': parts.push(ev('err', 'error', esc(e.message), e)); break;
      case 'stopped': parts.push(ev('err', 'stop', esc(e.text), e)); break;
      case 'done': parts.push(ev('good', 'check', esc(e.text), e)); break;
      case 'info': parts.push(ev('', 'wave', esc(e.text), e)); break;
      case 'result':
        if (e.text && e.text === lastText) break;
        if (!e.ok && e.text) parts.push(ev('err', 'error', esc(e.text), e));
        break;
      default: break;
    }
  }
  if (ACTIVE.has(s.status)) parts.push('<div class="typing" aria-label="En cours"><i></i><i></i><i></i></div>');
  return `<div class="feed">${parts.join('')}</div>`;
}

function renderChanges(p, s) {
  const key = `${p.id}/${s.id}`;
  if (!s.diff) return `<p class="muted">${ACTIVE.has(s.status) ? "Les modifications s'afficheront quand l'agent aura terminé son tour." : 'Aucune modification enregistrée.'}</p>`;
  const st = diffs.get(key) || { open: new Set(), patches: new Map() };
  diffs.set(key, st);
  return `<p class="muted" style="margin:0 0 8px">${plural(s.diff.files, 'fichier modifié', 'fichiers modifiés')} · <span class="add">+${s.diff.add}</span> <span class="del">−${s.diff.del}</span></p>
    <div class="files">${(s.diff.list || []).map((f) => `
      <button class="file" data-action="file" data-pid="${p.id}" data-sid="${esc(s.id)}" data-file="${esc(f.file)}">${icon(st.open.has(f.file) ? 'code' : 'read')}<span>${esc(f.file)}</span><span class="n"><span class="add">+${f.add}</span> <span class="del">−${f.del}</span></span></button>
      ${st.open.has(f.file) ? renderPatch(st.patches.get(f.file)) : ''}`).join('')}</div>`;
}
function renderPatch(patchText) {
  if (patchText == null) return '<div class="patch"><div>Chargement…</div></div>';
  const lines = patchText.split('\n').filter((l) => !/^(diff --git|index |--- |\+\+\+ )/.test(l));
  return `<div class="patch">${lines.map((l) => `<div class="${l.startsWith('+') ? 'a' : l.startsWith('-') ? 'd' : l.startsWith('@@') ? 'h' : ''}">${esc(l) || ' '}</div>`).join('')}</div>`;
}

function renderBrief(p, s) {
  return `<div style="display:grid;gap:14px">
    ${s.after.length ? `<p class="muted" style="margin:0">Démarre après ${s.after.map((a) => `l'étape ${esc(a)}`).join(' et ')}.</p>` : ''}
    ${s.items.length ? `<div class="todos">${s.items.map((it) => `<div class="${it.done ? 'completed' : ''}">${it.done ? '✓' : '○'} ${esc(it.text)}</div>`).join('')}</div>` : ''}
    ${s.body ? md(s.body) : '<p class="muted" style="margin:0">Pas de consigne supplémentaire dans le plan.</p>'}
    <p class="muted" style="margin:0;font-size:13px">Modifie la consigne directement dans ${esc(p.planFile || 'PLAN.md')} : Maestro relit le fichier à chaque changement.</p>
  </div>`;
}

async function loadLog(pid, sid) {
  if (!pid || !sid) return;
  try {
    const events = await api('GET', `/api/projects/${pid}/steps/${encodeURIComponent(sid)}/log`);
    logs.set(`${pid}/${sid}`, events);
    render();
  } catch {}
}

// ------------------------------------------------------------------ assistant
function renderAssistant() {
  const a = S.assistant;
  const msgs = a.messages || [];
  const suggestions = ['Où en sont mes projets ?', "Qu'est-ce qui m'attend aujourd'hui ?", 'Programme un brief chaque matin à 8 h 30', 'Mets en pause tous les projets'];
  return `<div class="chat">
    <div class="chat-head">
      <div><h1>Assistant</h1><p>Il connaît l'état de tes projets et utilise tes outils connectés (agenda, Notion…) configurés dans les réglages.</p></div>
      <div class="btn-row">
        <button class="btn back icon" data-action="nav" aria-label="Menu">${icon('menu')}</button>
        <button class="btn ghost sm" data-action="settings" data-section="routines">${icon('clock')}Routines${a.routines?.length ? ` (${a.routines.length})` : ''}</button>
        ${msgs.length ? `<button class="btn ghost sm" data-action="assistant-reset">Nouvelle conversation</button>` : ''}
      </div>
    </div>
    ${renderCore()}
    <div class="chat-log" data-scroll="chat">
      ${msgs.length ? '' : `<div class="empty" style="padding:24px 0"><p>Demande-lui ce que tu veux, en français, comme à un collègue.</p><div class="suggestions">${suggestions.map((s) => `<button data-action="suggest" data-text="${esc(s)}">${esc(s)}</button>`).join('')}</div></div>`}
      ${msgs.map((m) => `
        <div class="msg ${m.role}">
          ${m.routine && m.role === 'user' ? `<span class="tag">Routine « ${esc(m.routine)} » · ${clock(m.at)}</span>` : ''}
          ${m.voice && m.role === 'user' ? `<span class="tag">${icon('mic')}Dicté au micro</span>` : ''}
          ${m.role === 'user' ? `<div>${esc(m.text).replace(/\n/g, '<br>')}</div>` : `${m.tools?.length ? `<div class="tools">${m.tools.map((t) => `<span>${esc(t.label)}</span>`).join('')}</div>` : ''}${md(m.text)}`}
        </div>`).join('')}
      ${a.busy ? `<div class="msg assistant">${a.live?.tools?.length ? `<div class="tools">${a.live.tools.map((t) => `<span>${esc(t.label)}</span>`).join('')}</div>` : ''}${a.live?.text ? md(a.live.text) : ''}<div class="typing"><i></i><i></i><i></i></div></div>` : ''}
    </div>
    <form class="chat-input" data-form="assistant">
      ${draft('assistant', 'Écris à ton assistant…  (Entrée pour envoyer, Maj+Entrée pour une nouvelle ligne)')}
      ${a.busy ? `<button class="btn icon" type="button" data-action="assistant-stop" aria-label="Arrêter">${icon('stop')}</button>` : ''}
      <button class="btn icon mic${V.state === 'listening' ? ' on' : ''}" type="button" data-action="voice" aria-label="${V.state === 'listening' ? 'Arrêter l\'écoute' : 'Parler'}" title="Parler (⌥ M)">${icon('mic')}</button>
      <button class="btn primary icon" type="submit" aria-label="Envoyer">${icon('send')}</button>
    </form>
  </div>`;
}

// ------------------------------------------------------------------ voix
// Web Speech API du navigateur : reconnaissance (Chrome, Safari) et synthèse vocale, sans clé ni serveur.
const SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
const TTS = 'speechSynthesis' in window ? window.speechSynthesis : null;
const VOICE_DEFAULTS = { replies: true, all: false, loop: false, announce: false, voice: '', rate: 1.05 };
const V = {
  state: 'idle', // idle | listening | speaking (thinking se déduit de l'assistant)
  heard: '',
  awaiting: false, // une question dictée ici attend sa réponse
  loopNext: false,
  rec: null,
  prefs: (() => {
    try { return { ...VOICE_DEFAULTS, ...JSON.parse(localStorage.getItem('maestro.voice') || '{}') }; } catch { return { ...VOICE_DEFAULTS }; }
  })(),
};
TTS?.getVoices(); // déclenche le chargement des voix
const saveVoicePrefs = () => { try { localStorage.setItem('maestro.voice', JSON.stringify(V.prefs)); } catch {} };
const voiceForm = (f) => ({
  replies: !!f.get('v-replies'),
  all: !!f.get('v-all'),
  loop: !!f.get('v-loop'),
  announce: !!f.get('v-announce'),
  voice: String(f.get('v-voice') || ''),
  rate: Number(f.get('v-rate')) || VOICE_DEFAULTS.rate,
});
function setVoice(state, heard = '') {
  V.state = state;
  V.heard = heard;
  render();
}
function coreState() {
  if (!SR && !TTS) return 'off';
  if (V.state !== 'idle') return V.state;
  return S.assistant.busy ? 'thinking' : 'idle';
}

function listen() {
  if (V.rec) return V.rec.stop(); // deuxième clic : envoie ce qui a été entendu
  if (!SR) return toast({ title: 'Micro indisponible ici', body: 'Ouvre Maestro dans Chrome ou Safari pour lui parler.', kind: 'error' });
  V.loopNext = false;
  TTS?.cancel();
  const rec = new SR();
  rec.lang = 'fr-FR';
  rec.interimResults = true;
  rec.continuous = false;
  let final = '';
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) final += e.results[i][0].transcript;
      else interim += e.results[i][0].transcript;
    }
    setVoice('listening', `${final} ${interim}`.trim());
  };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      toast({ title: 'Micro refusé', body: "Autorise le micro pour Maestro : clique sur l'icône à gauche de l'adresse, ou Réglages Système › Confidentialité et sécurité › Micro.", kind: 'error' });
    } else if (e.error === 'network') {
      toast({ title: 'Transcription impossible', body: 'La reconnaissance vocale du navigateur a besoin d\'internet.', kind: 'error' });
    } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
      toast({ title: 'Micro', body: e.error, kind: 'error' });
    }
  };
  rec.onend = () => {
    const text = V.heard.trim();
    V.rec = null;
    setVoice('idle');
    if (V.cancelled) { V.cancelled = false; return; }
    if (text) {
      V.awaiting = true;
      sendAssistant(text, { voice: true });
    }
  };
  V.rec = rec;
  setVoice('listening');
  try { rec.start(); } catch { V.rec = null; setVoice('idle'); }
}

function stopVoice() {
  V.loopNext = false;
  if (V.rec) { V.cancelled = true; V.rec.abort(); }
  TTS?.cancel();
  setVoice('idle');
}

/** Transforme une réponse Markdown en texte agréable à écouter. */
function speechText(src) {
  let t = String(src || '')
    .replace(/```[\s\S]*?```/g, ' Le code est affiché à l\'écran. ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'le lien affiché')
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_>#|~]/g, '')
    .replace(/\n{2,}/g, '.\n')
    .trim();
  if (t.length > 1400) t = `${t.slice(0, 1400).replace(/[^.!?]*$/, '')} La suite est affichée à l'écran.`;
  return t;
}
const frVoices = () => (TTS?.getVoices() || []).filter((v) => /^fr/i.test(v.lang));
function pickVoice(name) {
  const all = frVoices();
  return all.find((v) => v.name === name)
    || all.find((v) => /thomas/i.test(v.name) && /amélior|enhanced|premium/i.test(v.name))
    || all.find((v) => /thomas/i.test(v.name))
    || all.find((v) => /fr[-_]FR/i.test(v.lang))
    || all[0] || null;
}

function speak(text, prefs = V.prefs) {
  if (!TTS) return;
  const t = speechText(text);
  if (!t) return;
  TTS.cancel();
  // Phrases regroupées par morceaux courts : Chrome coupe les énoncés trop longs.
  const chunks = [];
  let cur = '';
  for (const part of t.match(/[^.!?…\n]+[.!?…]*\s*|\n/g) || [t]) {
    if (cur && (cur + part).length > 220) { chunks.push(cur); cur = ''; }
    cur += part;
  }
  if (cur.trim()) chunks.push(cur);
  const voice = pickVoice(prefs.voice);
  chunks.forEach((c, i) => {
    const u = new SpeechSynthesisUtterance(c.trim());
    u.lang = voice?.lang || 'fr-FR';
    if (voice) u.voice = voice;
    u.rate = prefs.rate || 1;
    u.pitch = 0.95;
    if (i === 0) u.onstart = () => setVoice('speaking');
    if (i === chunks.length - 1) {
      u.onend = () => {
        if (V.state === 'speaking') setVoice('idle');
        if (V.loopNext && V.prefs.loop && !V.rec) { V.loopNext = false; setTimeout(listen, 300); }
      };
      u.onerror = () => { if (V.state === 'speaking') setVoice('idle'); };
    }
    TTS.speak(u);
  });
}

function renderCore() {
  const st = coreState();
  const label = { off: 'Voix indisponible', idle: 'En veille', listening: "J'écoute…", thinking: 'Analyse en cours…', speaking: 'Réponse vocale' }[st];
  const heard = V.heard
    ? `<div class="core-heard">${esc(V.heard)}</div>`
    : st === 'idle' ? `<div class="core-heard hint">Clique sur le réacteur ou appuie sur <kbd>⌥ M</kbd> pour parler.${V.prefs.replies ? ' Je te répondrai à voix haute.' : ''}</div>`
    : st === 'off' ? '<div class="core-heard hint">Ouvre Maestro dans Chrome ou Safari pour lui parler.</div>'
    : st === 'speaking' ? '<div class="core-heard hint">Clique sur le réacteur pour m\'interrompre.</div>'
    : '<div class="core-heard"></div>';
  // La phase négative garde les anneaux en mouvement continu malgré les re-rendus.
  const ph = (performance.now() / 1000).toFixed(2);
  return `<div class="core-wrap">
    <button class="core" data-action="core" data-state="${st}" style="--ph:-${ph}s" aria-label="${st === 'listening' ? 'Arrêter l\'écoute' : st === 'speaking' ? 'Arrêter la voix' : 'Parler à Maestro'}"><span class="ring ticks"></span><span class="ring arcs"></span><span class="ring arcs2"></span><span class="eye"></span></button>
    <div class="core-info"><div class="core-status ${st}">${label}</div>${heard}</div>
  </div>`;
}

// ------------------------------------------------------------------ réglages
function openSettings(section) {
  const c = S.config;
  const dlg = $('#settings');
  const theme = (() => { try { return localStorage.getItem('maestro.theme') || 'system'; } catch { return 'system'; } })();
  const notif = 'Notification' in window ? Notification.permission : 'unsupported';
  const dayNames = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];
  const vp = V.prefs;
  dlg.innerHTML = `
    <form method="dialog" data-form="settings">
      <div class="dlg-head"><h2>Réglages</h2><button class="btn ghost icon sm" value="cancel" aria-label="Fermer">${icon('x')}</button></div>
      <div class="dlg-body">
        <h3 style="margin:16px 0 0">Agents</h3>
        <div class="field"><label for="f-par">Agents en parallèle</label><input id="f-par" type="number" min="1" max="8" name="maxParallel" value="${c.maxParallel}"><div class="help">Chaque agent consomme ton forfait Claude. 2 ou 3 est un bon équilibre.</div></div>
        <div class="field"><label for="f-auto">Fusionner sans me demander</label><input id="f-auto" class="switch" type="checkbox" name="autoValidate" ${c.autoValidate ? 'checked' : ''}><div class="help">Sinon, chaque étape terminée attend ta validation. Une étape peut forcer ce choix avec « validation: auto » ou « validation: manuelle ».</div></div>
        <div class="field"><label for="f-perm">Autorisations</label>
          <select id="f-perm" name="permissionMode">
            <option value="acceptEdits" ${c.permissionMode === 'acceptEdits' ? 'selected' : ''}>Fichiers libres, commandes sur demande</option>
            <option value="auto" ${c.permissionMode === 'auto' ? 'selected' : ''}>Classifieur automatique</option>
            <option value="default" ${c.permissionMode === 'default' ? 'selected' : ''}>Tout me demander</option>
            <option value="bypassPermissions" ${c.permissionMode === 'bypassPermissions' ? 'selected' : ''}>Tout autoriser (risqué)</option>
          </select>
          <div class="help">Les commandes courantes (git, tests, installation de dépendances…) sont toujours autorisées.</div></div>
        <div class="field stack"><label for="f-allow">Commandes autorisées en plus</label><textarea id="f-allow" name="allow" rows="3" placeholder="Bash(docker compose up:*)&#10;Bash(make:*)">${esc((c.allow || []).join('\n'))}</textarea><div class="help">Une règle par ligne, au format des permissions Claude Code.</div></div>
        <div class="field"><label for="f-model">Modèle</label><input id="f-model" type="text" name="model" value="${esc(c.model || '')}" placeholder="par défaut" style="width:180px"><div class="help">Laisse vide pour le modèle par défaut de Claude Code. Une étape peut préciser « modèle: … ».</div></div>

        <h3 style="margin:22px 0 0">Notifications</h3>
        <div class="field"><label>Notifications du navigateur</label>
          ${notif === 'granted' ? '<span class="chip s-done">Activées</span>' : notif === 'denied' ? '<span class="chip s-failed">Bloquées</span>' : notif === 'unsupported' ? '<span class="muted">Non disponibles</span>' : `<button class="btn sm" type="button" data-action="ask-notif">Activer</button>`}
          <div class="help">Cliquer sur une notification ouvre directement l'élément concerné.${notif === 'denied' ? ' Débloque-les dans les réglages du site de ton navigateur.' : ''}</div></div>
        <div class="field"><label for="f-native">Notifications macOS</label>
          <select id="f-native" name="native">
            <option value="auto" ${c.notifications?.native === 'auto' ? 'selected' : ''}>Quand le tableau de bord est fermé</option>
            <option value="always" ${c.notifications?.native === 'always' ? 'selected' : ''}>Toujours</option>
            <option value="never" ${c.notifications?.native === 'never' ? 'selected' : ''}>Jamais</option>
          </select>
          <div class="help">Installe <code>terminal-notifier</code> (<code>brew install terminal-notifier</code>) pour qu'un clic sur la notification ouvre Maestro.</div></div>
        <div class="field"><label for="f-sound">Son</label><input id="f-sound" class="switch" type="checkbox" name="sound" ${c.notifications?.sound ? 'checked' : ''}><div class="help"></div></div>
        <div class="field"><span></span><button class="btn sm" type="button" data-action="test-notif">${icon('bell')}Envoyer une notification de test</button></div>

        <h3 style="margin:22px 0 0" id="routines">Routines de l'assistant</h3>
        <div>${(c.routines || []).map((r) => `
          <div class="routine"><span class="when">${esc(r.time)}</span><div><div>${esc(r.name)}</div><div class="what">${(r.days || []).map((d) => dayNames[d - 1]).join(' ')} · ${esc(r.prompt.slice(0, 90))}</div></div>
          <div class="btn-row"><button class="btn ghost sm" type="button" data-action="routine-run" data-id="${r.id}">Lancer</button><button class="btn ghost sm icon" type="button" data-action="routine-del" data-id="${r.id}" aria-label="Supprimer">${icon('trash')}</button></div></div>`).join('') || '<p class="muted">Aucune routine. Exemple : un brief chaque matin avec ton agenda et l\'état de tes projets.</p>'}</div>
        <div class="panel" style="margin-top:12px">
          <div class="btn-row" style="flex-wrap:nowrap"><input type="text" name="r-name" placeholder="Nom (ex. Brief du matin)"><input type="time" name="r-time" value="08:30" style="width:120px"></div>
          <div class="days">${dayNames.map((d, i) => `<label><input type="checkbox" name="r-day" value="${i + 1}" ${i < 5 ? 'checked' : ''}><span>${d}</span></label>`).join('')}</div>
          <textarea name="r-prompt" rows="2" placeholder="Consigne (ex. Résume mon agenda du jour et l'état de mes projets Maestro)"></textarea>
          <div><button class="btn sm" type="button" data-action="routine-add">${icon('plus')}Ajouter la routine</button></div>
        </div>

        <h3 style="margin:22px 0 0">Assistant</h3>
        <div class="field stack"><label for="f-mcp">Serveurs MCP de l'assistant</label>
          <textarea id="f-mcp" name="mcp" rows="5" style="font-family:var(--mono);font-size:12.5px" placeholder='{ "notion": { "type": "http", "url": "https://mcp.notion.com/mcp" } }'>${esc(JSON.stringify(c.assistant?.mcpServers || {}, null, 2))}</textarea>
          <div class="help">Les serveurs que tu as déjà ajoutés à Claude Code avec <code>claude mcp add --scope user</code> sont aussi disponibles.</div></div>
        <div class="field"><label for="f-amodel">Modèle de l'assistant</label><input id="f-amodel" type="text" name="amodel" value="${esc(c.assistant?.model || '')}" placeholder="par défaut" style="width:180px"><div class="help"></div></div>

        <h3 style="margin:22px 0 0" id="voice">Voix</h3>
        ${SR ? '' : '<p class="muted">La reconnaissance vocale n\'est pas disponible dans ce navigateur : ouvre Maestro dans Chrome ou Safari pour parler au micro.</p>'}
        <div class="field"><label for="v-replies">Répondre à voix haute</label><input id="v-replies" class="switch" type="checkbox" name="v-replies" ${vp.replies ? 'checked' : ''}><div class="help">Quand tu parles au micro, la réponse est lue à voix haute.</div></div>
        <div class="field"><label for="v-all">Lire toutes les réponses</label><input id="v-all" class="switch" type="checkbox" name="v-all" ${vp.all ? 'checked' : ''}><div class="help">Même celles écrites au clavier et celles des routines.</div></div>
        <div class="field"><label for="v-loop">Conversation continue</label><input id="v-loop" class="switch" type="checkbox" name="v-loop" ${vp.loop ? 'checked' : ''}><div class="help">Le micro se rouvre après chaque réponse parlée. Clique sur le réacteur ou appuie sur Échap pour arrêter.</div></div>
        <div class="field"><label for="v-announce">Annonces vocales</label><input id="v-announce" class="switch" type="checkbox" name="v-announce" ${vp.announce ? 'checked' : ''}><div class="help">Annonce à voix haute quand une étape attend ta réponse, ta validation, ou échoue.</div></div>
        <div class="field"><label for="v-voice">Voix</label>
          <select id="v-voice" name="v-voice"><option value="">Automatique</option>${frVoices().map((v) => `<option value="${esc(v.name)}" ${v.name === vp.voice ? 'selected' : ''}>${esc(v.name)} (${esc(v.lang)})</option>`).join('')}</select>
          <div class="help">Pour une voix plus naturelle sur Mac : Réglages Système › Accessibilité › Contenu énoncé › Voix du système › Gérer les voix, puis télécharge « Thomas (amélioré) ».</div></div>
        <div class="field"><label for="v-rate">Vitesse</label><input id="v-rate" type="range" name="v-rate" min="0.8" max="1.4" step="0.05" value="${vp.rate}"><div class="help"></div></div>
        <div class="field"><span></span><button class="btn sm" type="button" data-action="voice-test">${icon('mic')}Tester la voix</button></div>

        <h3 style="margin:22px 0 0">Affichage</h3>
        <div class="field"><label for="f-theme">Thème</label><select id="f-theme" name="theme"><option value="system" ${theme === 'system' ? 'selected' : ''}>Comme macOS</option><option value="dark" ${theme === 'dark' ? 'selected' : ''}>Sombre</option><option value="light" ${theme === 'light' ? 'selected' : ''}>Clair</option></select><div class="help"></div></div>
        <div class="field"><label for="f-open">Ouvrir Maestro</label><select id="f-open" name="openAs"><option value="app" ${c.openAs !== 'browser' ? 'selected' : ''}>Dans une fenêtre d'app</option><option value="browser" ${c.openAs === 'browser' ? 'selected' : ''}>Dans un onglet</option></select><div class="help">Tu peux aussi l'installer depuis Chrome : menu ⋮ › Caster, enregistrer et partager › Installer la page en tant qu'appli.</div></div>
      </div>
      <div class="dlg-foot"><button class="btn ghost" value="cancel">Annuler</button><button class="btn primary" value="save" data-action="settings-save">Enregistrer</button></div>
    </form>`;
  dlg.showModal();
  if (section) dlg.querySelector(`#${section}`)?.scrollIntoView({ block: 'start' });
}

async function saveSettings(form) {
  const f = new FormData(form);
  let mcp = {};
  try {
    mcp = JSON.parse(f.get('mcp') || '{}');
  } catch {
    toast({ title: 'Réglages non enregistrés', body: 'Le JSON des serveurs MCP est invalide.', kind: 'error' });
    return false;
  }
  const theme = f.get('theme');
  try { localStorage.setItem('maestro.theme', theme); } catch {}
  V.prefs = { ...V.prefs, ...voiceForm(f) };
  saveVoicePrefs();
  applyTheme();
  const r = await act('PUT', '/api/config', {
    maxParallel: Number(f.get('maxParallel')),
    autoValidate: !!f.get('autoValidate'),
    permissionMode: f.get('permissionMode'),
    allow: String(f.get('allow') || '').split('\n').map((s) => s.trim()).filter(Boolean),
    model: String(f.get('model') || '').trim(),
    notifications: { native: f.get('native'), sound: !!f.get('sound') },
    assistant: { model: String(f.get('amodel') || '').trim(), mcpServers: mcp },
    openAs: f.get('openAs'),
  }, 'Réglages enregistrés');
  if (r) S.config = r;
  return !!r;
}

function applyTheme() {
  let t = 'system';
  try { t = localStorage.getItem('maestro.theme') || 'system'; } catch {}
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}
applyTheme();

// ------------------------------------------------------------------ toasts & notifications
function toast({ title, body = '', kind = 'info', path }) {
  const el = document.createElement('div');
  el.className = `toast k-${kind}`;
  el.innerHTML = `<b>${esc(title)}</b>${body ? `<span>${esc(body)}</span>` : ''}`;
  el.addEventListener('click', () => { if (path) go(path); el.remove(); });
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 9000 : 5500);
}

let swReg = null;
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then((r) => { swReg = r; }).catch(() => {});
  navigator.serviceWorker.addEventListener('message', (e) => { if (e.data?.type === 'navigate') go(e.data.path.replace(/^#/, '')); });
}

function systemNotify(n) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return false;
  const opts = { body: n.body, tag: n.path, data: { path: n.path }, icon: '/icon.svg', renotify: true };
  if (swReg?.showNotification) swReg.showNotification(n.title, opts);
  else {
    const x = new Notification(n.title, opts);
    x.onclick = () => { window.focus(); go(n.path.replace(/^#/, '')); };
  }
  return true;
}

function onNotify(n) {
  const visible = document.visibilityState === 'visible';
  if (n.kind === 'assistant' && visible && R.view === 'assistant') return;
  if (visible) toast(n);
  else systemNotify(n);
  if (V.prefs.announce && ['question', 'permission', 'review', 'error', 'conflict'].includes(n.kind) && V.state === 'idle') speak(`${n.title}. ${n.body || ''}`);
}

function sendPresence() {
  api('POST', '/api/presence', { client: CLIENT, visible: document.visibilityState === 'visible', notif: 'Notification' in window ? Notification.permission : 'unsupported' }).catch(() => {});
}
document.addEventListener('visibilitychange', sendPresence);

// ------------------------------------------------------------------ flux temps réel
function connect() {
  const notif = 'Notification' in window ? Notification.permission : 'unsupported';
  const es = new EventSource(`/api/events?t=${encodeURIComponent(TOKEN)}&client=${CLIENT}&visible=${document.visibilityState === 'visible' ? 1 : 0}&notif=${notif}`);
  es.addEventListener('snapshot', (e) => {
    const d = JSON.parse(e.data);
    S.connected = true;
    S.version = d.version;
    S.projects = new Map(d.projects.map((p) => [p.id, p]));
    S.order = d.projects.map((p) => p.id);
    S.inbox = d.inbox;
    S.assistant = d.assistant;
    S.config = d.config;
    S.claude = d.claude;
    S.fake = d.fake;
    if (R.sid) loadLog(R.pid, R.sid);
    render();
  });
  es.addEventListener('project', (e) => {
    const p = JSON.parse(e.data);
    if (!S.projects.has(p.id)) S.order.push(p.id);
    S.projects.set(p.id, p);
    render();
  });
  es.addEventListener('project-removed', (e) => {
    const { id } = JSON.parse(e.data);
    S.projects.delete(id);
    S.order = S.order.filter((x) => x !== id);
    render();
  });
  es.addEventListener('inbox', (e) => { S.inbox = JSON.parse(e.data); render(); });
  es.addEventListener('step-event', (e) => {
    const { projectId, stepId, event } = JSON.parse(e.data);
    const key = `${projectId}/${stepId}`;
    if (event.type === 'start') logs.set(key, []);
    if (logs.has(key)) logs.get(key).push(event);
    if (event.type === 'result') diffs.delete(key);
    if (R.pid === projectId && R.sid === stepId) render();
  });
  es.addEventListener('assistant-message', (e) => {
    const m = JSON.parse(e.data);
    S.assistant.messages = [...(S.assistant.messages || []), m];
    if (m.role === 'assistant') {
      const mine = V.awaiting && m.voice;
      if (mine) V.awaiting = false;
      if ((mine && V.prefs.replies) || V.prefs.all) { V.loopNext = mine; speak(m.text); }
    }
    render();
  });
  es.addEventListener('assistant-status', (e) => { Object.assign(S.assistant, JSON.parse(e.data)); render(); });
  es.addEventListener('assistant-reset', (e) => { S.assistant = JSON.parse(e.data); render(); });
  es.addEventListener('config', (e) => { S.config = JSON.parse(e.data); S.assistant.routines = S.config.routines; render(); });
  es.addEventListener('notify', (e) => onNotify(JSON.parse(e.data)));
  es.onerror = () => {
    if (S.connected) { S.connected = false; render(); }
  };
}

// ------------------------------------------------------------------ interactions
document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-action]');
  if (!t) return;
  const a = t.dataset.action;
  const { pid, sid, op, id } = t.dataset;
  const stepUrl = (o) => `/api/projects/${pid}/steps/${encodeURIComponent(sid)}/${o}`;
  switch (a) {
    case 'nav': $('#app').classList.toggle('show-nav'); break;
    case 'open-step': go(`/p/${pid}/s/${encodeURIComponent(t.dataset.step)}`); break;
    case 'tab': detailTab = t.dataset.tab; render(); break;
    case 'start': act('POST', `/api/projects/${pid}/start`); break;
    case 'pause': act('POST', `/api/projects/${pid}/pause`, null, 'Plan en pause : les agents en cours terminent leur étape.'); break;
    case 'reload': act('POST', `/api/projects/${pid}/reload`, null, 'Plan relu'); break;
    case 'init-git': act('POST', `/api/projects/${pid}/init-git`, null, 'Dépôt git initialisé'); break;
    case 'template': act('POST', `/api/projects/${pid}/template`, null, 'PLAN.md créé'); break;
    case 'open-editor': act('POST', `/api/projects/${pid}/open-editor`); break;
    case 'remove-project': if (confirm('Retirer ce projet de Maestro ? Tes fichiers ne sont pas touchés.')) { await act('DELETE', `/api/projects/${pid}`); go('/'); } break;
    case 'scroll-attn': $('#attn')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); break;
    case 'answer': {
      const body = t.dataset.choice ? { choice: t.dataset.choice } : { text: t.dataset.text };
      t.disabled = true;
      act('POST', `/api/inbox/${id}`, body);
      break;
    }
    case 'step': {
      if (op === 'discard' && !confirm("Abandonner le travail de cette étape ? Sa branche et ses modifications seront supprimées.")) return;
      if (op === 'restart') {
        if (!confirm("Recommencer l'étape de zéro ? Le travail en cours sera supprimé.")) return;
        await act('POST', stepUrl('discard'));
        act('POST', stepUrl('run'));
        return;
      }
      if (op === 'open-terminal') {
        const r = await act('POST', stepUrl('open-terminal'));
        if (r?.command && S.config && !navigator.platform.includes('Mac')) toast({ title: 'Commande', body: r.command });
        return;
      }
      t.disabled = true;
      const r = await act('POST', stepUrl(op));
      if (op === 'validate' && r?.ok) toast({ title: `Étape ${sid} fusionnée`, kind: 'success' });
      break;
    }
    case 'file': {
      const key = `${pid}/${sid}`;
      const st = diffs.get(key) || { open: new Set(), patches: new Map() };
      diffs.set(key, st);
      const f = t.dataset.file;
      if (st.open.has(f)) st.open.delete(f);
      else {
        st.open.add(f);
        if (!st.patches.has(f)) {
          api('GET', `/api/projects/${pid}/steps/${encodeURIComponent(sid)}/diff?file=${encodeURIComponent(f)}`).then((r) => { st.patches.set(f, r.patch || '(pas de différence)'); render(); });
        }
      }
      render();
      break;
    }
    case 'suggest': sendAssistant(t.dataset.text); break;
    case 'assistant-stop': stopVoice(); act('POST', '/api/assistant/stop'); break;
    case 'voice': if (R.view !== 'assistant' && V.state !== 'listening') go('/assistant'); listen(); break;
    case 'core':
      if (V.state === 'speaking') stopVoice();
      else { if (R.view !== 'assistant' && V.state !== 'listening') go('/assistant'); listen(); }
      break;
    case 'voice-test': {
      const f = voiceForm(new FormData(t.closest('form')));
      speak('Systèmes en ligne. Tous les agents sont prêts, je t\'écoute.', f);
      break;
    }
    case 'assistant-reset': if (confirm('Commencer une nouvelle conversation ? La mémoire durable de l\'assistant est conservée.')) act('POST', '/api/assistant/reset'); break;
    case 'settings': openSettings(t.dataset.section); break;
    case 'settings-save': e.preventDefault(); if (await saveSettings(t.closest('form'))) $('#settings').close(); break;
    case 'ask-notif': await Notification.requestPermission(); sendPresence(); openSettings(); break;
    case 'test-notif': act('POST', '/api/test-notification'); break;
    case 'routine-add': {
      const form = t.closest('form');
      const f = new FormData(form);
      const name = String(f.get('r-name') || '').trim();
      const prompt = String(f.get('r-prompt') || '').trim();
      if (!name || !prompt) return toast({ title: 'Il manque le nom ou la consigne', kind: 'error' });
      const routine = { id: crypto.randomUUID(), name, time: f.get('r-time') || '08:30', days: f.getAll('r-day').map(Number), prompt, enabled: true };
      const r = await act('PUT', '/api/config', { routines: [...(S.config.routines || []), routine] }, 'Routine ajoutée');
      if (r) { S.config = r; openSettings('routines'); }
      break;
    }
    case 'routine-del': {
      const r = await act('PUT', '/api/config', { routines: (S.config.routines || []).filter((x) => x.id !== id) });
      if (r) { S.config = r; openSettings('routines'); }
      break;
    }
    case 'routine-run': act('POST', `/api/routines/${id}/run`, null, 'Routine lancée : réponse dans l\'assistant'); break;
    case 'add-project': {
      const path = prompt('Chemin du dossier du projet :', '');
      if (!path) return;
      const p = await act('POST', '/api/projects', { path: path.trim() });
      if (p?.id) go(`/p/${p.id}`);
      break;
    }
  }
});

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  const kind = form.dataset.form;
  const ta = form.querySelector('textarea');
  const text = ta?.value.trim();
  const clear = () => { if (ta) { delete drafts[ta.dataset.key]; ta.value = ''; autosize(ta); } };
  if (kind === 'message' && text) {
    clear();
    const { pid, sid } = form.dataset;
    const st = S.projects.get(pid)?.steps.find((s) => s.id === sid);
    const r = await act('POST', `/api/projects/${pid}/steps/${encodeURIComponent(sid)}/${st?.status === 'review' ? 'redo' : 'message'}`, { text });
    if (r?.queued) toast({ title: 'Message en attente', body: "L'agent le lira à la fin de son tour." });
  } else if (kind === 'answer' && text) {
    clear();
    act('POST', `/api/inbox/${form.dataset.id}`, { text });
  } else if (kind === 'assistant' && text) {
    clear();
    sendAssistant(text);
  } else if (kind === 'generate-plan' && text) {
    act('POST', `/api/projects/${form.dataset.pid}/generate-plan`, { description: text });
  } else if (kind === 'add-project') {
    const path = new FormData(form).get('path');
    const p = await act('POST', '/api/projects', { path: String(path).trim() });
    if (p?.id) go(`/p/${p.id}`);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.target.matches('.chat-input textarea, .composer textarea, .answer textarea')) {
    e.preventDefault();
    e.target.closest('form').requestSubmit();
  }
  if (e.code === 'KeyM' && e.altKey && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    if (R.view !== 'assistant' && V.state !== 'listening') go('/assistant');
    listen();
    return;
  }
  if (e.key === 'Escape' && V.state !== 'idle') { stopVoice(); return; }
  if (e.key === 'Escape' && R.sid && !$('#settings').open) go(`/p/${R.pid}`);
});

function sendAssistant(text, { voice = false } = {}) {
  if (!S.assistant.busy) S.assistant.busy = true;
  render();
  act('POST', '/api/assistant', voice ? { text, voice: true } : { text });
}

// Rafraîchit les durées affichées.
setInterval(() => { if (S.order.some((id) => S.projects.get(id)?.totals.running)) render(); }, 15_000);

render();
if (TOKEN) {
  connect();
  sendPresence();
}
