// Connexions aux services d'IA : Claude (Anthropic), ChatGPT (OpenAI), Gemini (Google).
// L'utilisateur colle sa clé une seule fois : elle est reconnue, vérifiée auprès du service,
// puis rangée dans ~/.maestro/keys.json, lisible par lui seul. Elle n'est jamais renvoyée au navigateur.
import fs from 'node:fs';
import { paths, readJSON, writeJSON } from './paths.js';

const FAKE = process.env.MAESTRO_FAKE === '1';

export const PROVIDERS = {
  anthropic: {
    name: 'Claude',
    company: 'Anthropic',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    detect: /^sk-ant-[\w-]{20,}$/,
    prefer: [/opus/, /sonnet/],
  },
  openai: {
    name: 'ChatGPT',
    company: 'OpenAI',
    keyUrl: 'https://platform.openai.com/api-keys',
    detect: /^sk-(?!ant-)[\w-]{20,}$/,
    prefer: [/^gpt-5(\.\d+)?$/, /^gpt-5/, /^gpt-4\.1$/, /^gpt-4o$/],
  },
  google: {
    name: 'Gemini',
    company: 'Google',
    keyUrl: 'https://aistudio.google.com/apikey',
    detect: /^AIza[\w-]{30,}$/,
    prefer: [/^gemini-[\d.]+-pro$/, /^gemini-[\d.]+-flash$/, /^gemini-/],
  },
};

const file = () => paths.keys;
const load = () => readJSON(file(), {});
function save(data) {
  writeJSON(file(), data);
  try { fs.chmodSync(file(), 0o600); } catch {}
}

/** Devine le service d'après la forme de la clé. */
export function detectProvider(key) {
  const k = String(key || '').trim();
  return Object.keys(PROVIDERS).find((id) => PROVIDERS[id].detect.test(k)) || null;
}

/** Choisit un modèle par défaut parmi ceux que la clé donne, du plus récent au plus ancien. */
export function pickModel(provider, models) {
  const ids = [...models].sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
  const usable = ids.filter((m) => !/(mini|nano|lite|audio|realtime|transcribe|tts|image|embed|search|preview|exp|instruct|haiku|vision|live|thinking)/i.test(m));
  for (const re of PROVIDERS[provider].prefer) {
    const hit = usable.find((m) => re.test(m)) || ids.find((m) => re.test(m));
    if (hit) return hit;
  }
  return usable[0] || ids[0] || null;
}

async function http(url, opts) {
  const timeout = AbortSignal.timeout(opts?.method === 'POST' ? 180_000 : 20_000);
  const signal = opts?.signal && AbortSignal.any ? AbortSignal.any([opts.signal, timeout]) : opts?.signal || timeout;
  const res = await fetch(url, { ...opts, signal });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  if (!res.ok) {
    const msg = data?.error?.message || data?.error?.type || text.slice(0, 200) || `Erreur ${res.status}`;
    throw Object.assign(new Error(res.status === 401 || res.status === 403 || res.status === 400 ? `Clé refusée : ${msg}` : msg), { status: res.status });
  }
  return data;
}

/** Vérifie la clé auprès du service et renvoie les modèles qu'elle permet d'utiliser. */
async function listModels(provider, key) {
  if (FAKE) return { anthropic: ['claude-sonnet-simule'], openai: ['gpt-simule'], google: ['gemini-simule-pro'] }[provider];
  if (provider === 'anthropic') {
    const d = await http('https://api.anthropic.com/v1/models?limit=100', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } });
    return (d.data || []).map((m) => m.id);
  }
  if (provider === 'openai') {
    const d = await http('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` } });
    return (d.data || []).map((m) => m.id).filter((id) => /^(gpt|o\d|chatgpt)/.test(id));
  }
  const d = await http('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key } });
  return (d.models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent')).map((m) => m.name.replace(/^models\//, ''));
}

/** Connecte un service : reconnaît la clé, la vérifie, l'enregistre. */
export async function connect(rawKey, provider = null) {
  const key = String(rawKey || '').trim().replace(/^["']|["']$/g, '');
  const id = provider || detectProvider(key);
  if (!id || !PROVIDERS[id]) throw Object.assign(new Error("Je ne reconnais pas cette clé. Elle commence normalement par « sk-ant- » (Claude), « sk- » (ChatGPT) ou « AIza » (Gemini)."), { status: 400 });
  if (!PROVIDERS[id].detect.test(key)) throw Object.assign(new Error(`Ce n'est pas une clé ${PROVIDERS[id].name} valide.`), { status: 400 });
  let models;
  try {
    models = await listModels(id, key);
  } catch (e) {
    throw Object.assign(new Error(e.status ? e.message : `Impossible de joindre ${PROVIDERS[id].company} : ${e.message}`), { status: 400 });
  }
  const data = load();
  data[id] = { key, models, model: data[id]?.model && models.includes(data[id].model) ? data[id].model : pickModel(id, models), connectedAt: new Date().toISOString() };
  save(data);
  return publicInfo()[id];
}

export function disconnect(provider) {
  const data = load();
  delete data[provider];
  save(data);
}

export function setModel(provider, model) {
  const data = load();
  if (!data[provider]) throw Object.assign(new Error('Service non connecté.'), { status: 400 });
  data[provider].model = model;
  save(data);
}

export function getKey(provider) {
  return load()[provider]?.key || null;
}

/** Ce que le navigateur a le droit de voir : jamais la clé, seulement ses 4 derniers caractères. */
export function publicInfo() {
  const data = load();
  return Object.fromEntries(
    Object.entries(PROVIDERS).map(([id, p]) => {
      const c = data[id];
      return [id, { id, name: p.name, company: p.company, keyUrl: p.keyUrl, connected: !!c, hint: c ? `…${c.key.slice(-4)}` : null, model: c?.model || null, models: c?.models || [], connectedAt: c?.connectedAt || null }];
    }),
  );
}

/** Variables d'environnement pour Claude Code : la clé API si l'utilisateur en a mis une, sinon sa connexion Claude Code. */
export function claudeEnv() {
  const key = getKey('anthropic');
  return key ? { ...process.env, ANTHROPIC_API_KEY: key } : undefined;
}

/**
 * Conversation simple avec ChatGPT ou Gemini (sans outils).
 * @param {'openai'|'google'} provider
 * @param {{system: string, messages: {role: 'user'|'assistant', text: string}[]}} o
 */
export async function chat(provider, { system, messages, signal }) {
  const c = load()[provider];
  if (!c) throw new Error(`${PROVIDERS[provider]?.name || provider} n'est pas connecté. Ouvre la page Connexions.`);
  if (FAKE) {
    const last = messages.at(-1)?.text || '';
    return last.startsWith('[Message dicté') ? `Simulation ${PROVIDERS[provider].name} : je t'écoute.` : `_(simulation ${PROVIDERS[provider].name})_ Bien reçu : **${last.slice(0, 60)}**`;
  }
  const opts = (body, headers) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
  if (provider === 'openai') {
    const d = await http('https://api.openai.com/v1/chat/completions', opts(
      { model: c.model, messages: [{ role: 'system', content: system }, ...messages.map((m) => ({ role: m.role, content: m.text }))] },
      { Authorization: `Bearer ${c.key}` },
    ));
    return d.choices?.[0]?.message?.content || '';
  }
  const d = await http(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(c.model)}:generateContent`, opts(
    { systemInstruction: { parts: [{ text: system }] }, contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.text }] })) },
    { 'x-goog-api-key': c.key },
  ));
  return (d.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
}
