import { ProjectSchema, type Project } from '@s1pilot/domain';
import { asc, eq } from 'drizzle-orm';
import type { z } from 'zod';

import type { Db } from '../db.js';
import { projects as t } from '../schema/index.js';

import { fromRow, notFound, nowIso } from './util.js';

export type ProjectInput = z.input<typeof ProjectSchema>;

/** Projects. Deleting a project cascades to all of its children. */
export const projects = {
  /** Inserts a project (defaults applied, `createdAt`/`updatedAt` set when absent). */
  async create(db: Db, input: ProjectInput): Promise<Project> {
    const project = ProjectSchema.parse(input);
    const ts = nowIso();
    db.orm
      .insert(t)
      .values({ ...project, createdAt: project.createdAt ?? ts, updatedAt: project.updatedAt ?? ts })
      .run();
    return this.get(db, project.id) as Promise<Project>;
  },

  async get(db: Db, id: string): Promise<Project | undefined> {
    const row = db.orm.select().from(t).where(eq(t.id, id)).get();
    return row && fromRow(ProjectSchema, row);
  },

  async getByKey(db: Db, key: string): Promise<Project | undefined> {
    const row = db.orm.select().from(t).where(eq(t.key, key)).get();
    return row && fromRow(ProjectSchema, row);
  },

  async list(db: Db): Promise<Project[]> {
    return db.orm
      .select()
      .from(t)
      .orderBy(asc(t.name))
      .all()
      .map((row) => fromRow(ProjectSchema, row));
  },

  /** Merges `patch` into the project. The key is immutable (case keys derive from it). */
  async update(db: Db, id: string, patch: Partial<Omit<ProjectInput, 'id' | 'key'>>): Promise<Project> {
    const existing = await this.get(db, id);
    if (!existing) return notFound('Project', id);
    const merged = ProjectSchema.parse({ ...existing, ...patch, id, key: existing.key });
    db.orm
      .update(t)
      .set({ ...merged, modelSettings: merged.modelSettings ?? null, updatedAt: nowIso() })
      .where(eq(t.id, id))
      .run();
    return (await this.get(db, id)) as Project;
  },

  async delete(db: Db, id: string): Promise<void> {
    db.orm.delete(t).where(eq(t.id, id)).run();
  },
};
export type ProjectsRepo = typeof projects;
