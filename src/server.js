import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { manager } from './manager.js';
import { inbox } from './inbox.js';
import { assistant } from './assistant.js';
import { claudeDir, listSkills, listScheduledTasks } from './claude-account.js';
import { bus, broadcast, setPresence, notify } from './bus.js';
import { getConfig, updateConfig, findClaude } from './config.js';
import { HOST, PORT, PUBLIC_DIR, paths, ensureDir, ROOT } from './paths.js';

const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

// Les commandes autorisées d'office contournent volontairement la demande d'autorisation :
// on masque l'avertissement du SDK qui le signale à chaque session.
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const code = typeof rest[0] === 'object' ? rest[0]?.code : rest[1];
  if (String(code || '').includes('CAN_USE_TOOL_SHADOWED') || String(warning).includes('canUseTool will not be invoked')) return;
  return emitWarning.call(process, warning, ...rest);
};

function getToken() {
  ensureDir(path.dirname(paths.token));
  if (fs.existsSync(paths.token)) return fs.readFileSync(paths.token, 'utf8').trim();
  const t = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(paths.token, t, { mode: 0o600 });
  return t;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isObj ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 2_000_000) reject(new Error('Requête trop volumineuse'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(Object.assign(new Error('JSON invalide'), { status: 400 }));
      }
    });
  });
}

function snapshot() {
  return {
    version: VERSION,
    projects: manager.summaries(),
    inbox: inbox.list(),
    assistant: assistant.snapshot(),
    config: getConfig(),
    claude: findClaude(),
    platform: process.platform,
    fake: process.env.MAESTRO_FAKE === '1',
  };
}

function serveStatic(req, res, pathname) {
  let file = pathname === '/' ? '/index.html' : pathname;
  const full = path.normalize(path.join(PUBLIC_DIR, file));
  if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    return serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
  }
  serveFile(res, full);
}

function serveFile(res, full) {
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(full).pipe(res);
}

// -------------------------------------------------------------------- routes API
const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)'))}$`);
  routes.push({ method, re, keys, handler });
};
const fire = (p) => Promise.resolve(p).catch((e) => console.error(e));

route('GET', '/api/state', () => snapshot());

route('POST', '/api/projects', async ({ body }) => {
  const p = await manager.add(body.path);
  return p.summary();
});
route('DELETE', '/api/projects/:id', ({ params }) => (manager.remove(params.id), { ok: true }));
route('POST', '/api/projects/:id/start', ({ params }) => (manager.get(params.id).start(), { ok: true }));
route('POST', '/api/projects/:id/pause', ({ params }) => (manager.get(params.id).pause(), { ok: true }));
route('POST', '/api/projects/:id/stop-all', ({ params }) => (manager.get(params.id).stopAll(), { ok: true }));
route('POST', '/api/projects/:id/reload', async ({ params }) => {
  const p = manager.get(params.id);
  await p.detectGit();
  p.loadPlan();
  p.tick();
  return { ok: true };
});
route('POST', '/api/projects/:id/init-git', async ({ params }) => (await manager.get(params.id).initGit(), { ok: true }));
route('POST', '/api/projects/:id/template', ({ params }) => (manager.get(params.id).createPlanFromTemplate(), { ok: true }));
route('POST', '/api/projects/:id/generate-plan', ({ params, body }) => {
  if (!body.description?.trim()) throw Object.assign(new Error('Décris ce que tu veux construire.'), { status: 400 });
  fire(manager.get(params.id).generatePlan(body.description.trim()));
  return { ok: true };
});
route('POST', '/api/projects/:id/open-editor', ({ params }) => ({ path: manager.get(params.id).openEditor(null) }));

route('GET', '/api/projects/:id/steps/:sid/log', ({ params }) => manager.get(params.id).getLog(decodeURIComponent(params.sid)));
route('GET', '/api/projects/:id/steps/:sid/diff', async ({ params, query }) => {
  const p = manager.get(params.id);
  const sid = decodeURIComponent(params.sid);
  if (query.get('file')) return { patch: await p.fileDiff(sid, query.get('file')) };
  return p.summary().steps.find((s) => s.id === sid)?.diff || null;
});
route('POST', '/api/projects/:id/steps/:sid/:action', async ({ params, body }) => {
  const p = manager.get(params.id);
  const sid = decodeURIComponent(params.sid);
  if (!p.step(sid)) throw Object.assign(new Error('Étape introuvable'), { status: 404 });
  switch (params.action) {
    case 'run': fire(p.runStepNow(sid)); return { ok: true };
    case 'stop': p.stop(sid); return { ok: true };
    case 'retry': fire(p.retry(sid)); return { ok: true };
    case 'validate': return p.validate(sid);
    case 'redo':
      if (!body.text?.trim()) throw Object.assign(new Error('Explique ce qu\'il faut corriger.'), { status: 400 });
      fire(p.redo(sid, body.text.trim()));
      return { ok: true };
    case 'message':
      if (!body.text?.trim()) throw Object.assign(new Error('Message vide'), { status: 400 });
      return p.message(sid, body.text.trim());
    case 'resolve': fire(p.resolveConflict(sid)); return { ok: true };
    case 'discard': await p.discard(sid); return { ok: true };
    case 'skip': await p.skip(sid); return { ok: true };
    case 'reopen': await p.reopen(sid); return { ok: true };
    case 'open-terminal': return { command: p.openTerminal(sid) };
    case 'open-editor': return { path: p.openEditor(sid) };
    default: throw Object.assign(new Error('Action inconnue'), { status: 404 });
  }
});

route('POST', '/api/inbox/:id', ({ params, body }) => {
  if (!inbox.resolve(params.id, body)) throw Object.assign(new Error('Déjà traité'), { status: 404 });
  return { ok: true };
});

route('POST', '/api/assistant', ({ body }) => {
  if (!body.text?.trim()) throw Object.assign(new Error('Message vide'), { status: 400 });
  assistant.send(body.text.trim(), { voice: body.voice === true });
  return { ok: true };
});
route('POST', '/api/assistant/stop', () => (assistant.stop(), { ok: true }));
route('POST', '/api/assistant/reset', () => (assistant.reset(), { ok: true }));
route('GET', '/api/claude-account', () => ({ dir: claudeDir(), skills: listSkills(), scheduled: listScheduledTasks() }));
route('POST', '/api/routines/:id/run', ({ params }) => (assistant.runRoutineNow(params.id), { ok: true }));

route('GET', '/api/config', () => getConfig());
route('PUT', '/api/config', ({ body }) => {
  const next = updateConfig(body);
  broadcast('config', next);
  for (const p of manager.projects.values()) p.tick();
  return next;
});

route('POST', '/api/presence', ({ body }) => (setPresence(body.client, { visible: !!body.visible, notif: body.notif }), { ok: true }));
route('POST', '/api/test-notification', () => (notify({ title: 'Test', body: 'Les notifications fonctionnent.', kind: 'info' }), { ok: true }));
route('POST', '/api/shutdown', () => {
  setTimeout(() => process.exit(0), 200);
  return { ok: true };
});

// -------------------------------------------------------------------- SSE
const sseClients = new Set();
bus.on('broadcast', ({ type, data }) => {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(payload);
});

function openSSE(req, res, query) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const client = query.get('client') || crypto.randomUUID();
  res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
  sseClients.add(res);
  setPresence(client, { visible: query.get('visible') === '1', notif: query.get('notif') || 'default' });
  const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(res);
    setPresence(client, null);
  });
}

// -------------------------------------------------------------------- serveur
export async function startServer() {
  const token = getToken();
  await manager.load();
  assistant.init();

  const allowedOrigins = new Set([`http://${HOST}:${PORT}`, `http://localhost:${PORT}`]);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    const { pathname } = url;

    if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);
    if (pathname === '/api/health') return send(res, 200, { ok: true, version: VERSION, pid: process.pid });

    // Protection : jeton + origine (empêche un site web quelconque de piloter tes agents).
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) return send(res, 403, { error: 'Origine refusée' });
    const given = req.headers['x-maestro-token'] || url.searchParams.get('t');
    if (given !== token) return send(res, 401, { error: 'Jeton manquant ou invalide. Relance `maestro` pour ouvrir le tableau de bord.' });

    if (pathname === '/api/events') return openSSE(req, res, url.searchParams);

    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = pathname.match(r.re);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
      try {
        const body = req.method === 'GET' ? {} : await readBody(req);
        const out = await r.handler({ params, body, query: url.searchParams, req });
        return send(res, 200, out ?? { ok: true });
      } catch (e) {
        if (!e.status) console.error(e);
        return send(res, e.status || 500, { error: e.message || String(e) });
      }
    }
    send(res, 404, { error: 'Route inconnue' });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, resolve);
  });
  fs.writeFileSync(paths.pid, String(process.pid));
  console.log(`Maestro ${VERSION} — http://${HOST}:${PORT}  (${manager.projects.size} projet(s))${process.env.MAESTRO_FAKE === '1' ? ' [mode simulé]' : ''}`);

  const shutdown = () => {
    for (const p of manager.projects.values()) for (const r of p.runs.values()) r.abort.abort();
    try { fs.unlinkSync(paths.pid); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return { server, token };
}
