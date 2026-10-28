import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Project } from './project.js';
import { paths, readJSON, writeJSON, slugify } from './paths.js';
import { broadcast } from './bus.js';

/** Liste des projets suivis par Maestro. */
class Manager {
  constructor() {
    this.projects = new Map();
  }

  async load() {
    const list = readJSON(paths.projects, []);
    for (const p of list) {
      try {
        this.projects.set(p.id, await new Project(p).init());
      } catch (e) {
        console.error(`Projet ${p.path} : ${e.message}`);
      }
    }
  }

  persist() {
    writeJSON(
      paths.projects,
      [...this.projects.values()].map((p) => ({ id: p.id, path: p.dir, name: p.name })),
    );
  }

  get(id) {
    const p = this.projects.get(id);
    if (!p) throw Object.assign(new Error('Projet introuvable'), { status: 404 });
    return p;
  }

  byPath(dir) {
    const real = safeReal(dir);
    return [...this.projects.values()].find((p) => safeReal(p.dir) === real);
  }

  async add(dir) {
    const abs = path.resolve(dir);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      throw Object.assign(new Error(`Dossier introuvable : ${abs}`), { status: 400 });
    }
    const existing = this.byPath(abs);
    if (existing) {
      existing.loadPlan();
      await existing.detectGit();
      existing.emit();
      return existing;
    }
    const id = `${slugify(path.basename(abs), 24)}-${crypto.createHash('sha1').update(abs).digest('hex').slice(0, 6)}`;
    const project = await new Project({ id, path: abs, name: path.basename(abs) }).init();
    this.projects.set(id, project);
    this.persist();
    broadcast('project', project.summary());
    return project;
  }

  remove(id) {
    const p = this.get(id);
    p.dispose();
    this.projects.delete(id);
    this.persist();
    broadcast('project-removed', { id });
  }

  summaries() {
    return [...this.projects.values()].map((p) => p.summary());
  }
}

function safeReal(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

export const manager = new Manager();
