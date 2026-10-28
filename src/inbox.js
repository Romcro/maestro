import crypto from 'node:crypto';
import { broadcast, notify } from './bus.js';

/**
 * Boîte de réception : tout ce qui attend une intervention de ta part.
 * kind: 'permission' | 'question' | 'review' | 'conflict' | 'error'
 */
class Inbox {
  constructor() {
    this.items = new Map();
    this.waiters = new Map();
  }

  list() {
    return [...this.items.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  emit() {
    broadcast('inbox', this.list());
  }

  /** Ajoute un élément. Si `wait` est vrai, renvoie une promesse résolue avec ta réponse. */
  add(item, { wait = false, silent = false, signal } = {}) {
    const id = item.id || crypto.randomUUID();
    const full = { ...item, id, createdAt: Date.now() };
    this.items.set(id, full);
    this.emit();
    if (!silent) {
      notify({
        title: item.title,
        body: item.notifyBody || item.detail || '',
        kind: item.kind,
        projectId: item.projectId,
        stepId: item.stepId,
        inboxId: id,
      });
    }
    if (!wait) return id;
    return new Promise((resolve) => {
      this.waiters.set(id, resolve);
      signal?.addEventListener('abort', () => this.resolve(id, { cancelled: true }), { once: true });
    });
  }

  resolve(id, response) {
    const waiter = this.waiters.get(id);
    this.waiters.delete(id);
    const existed = this.items.delete(id);
    if (existed) this.emit();
    if (waiter) waiter(response);
    return existed || !!waiter;
  }

  /** Retire les éléments qui correspondent (ex. revue d'une étape qu'on vient de valider). */
  clear(match) {
    let changed = false;
    for (const [id, it] of this.items) {
      if (Object.entries(match).every(([k, v]) => it[k] === v)) {
        if (this.waiters.has(id)) {
          this.waiters.get(id)({ cancelled: true });
          this.waiters.delete(id);
        }
        this.items.delete(id);
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  has(match) {
    return this.list().some((it) => Object.entries(match).every(([k, v]) => it[k] === v));
  }
}

export const inbox = new Inbox();
