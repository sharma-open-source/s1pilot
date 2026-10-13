import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { repos, type ArtifactKind, type ArtifactRecord, type Db } from '@s1pilot/db';
import { S1PilotError, newId } from '@s1pilot/domain';

/** What a stored artifact belongs to. */
export interface ArtifactMeta {
  projectId: string;
  runId: string;
  caseResultId: string;
  /** Step index; absent for case-level artifacts (video, trace, logs). */
  stepIndex?: number;
  kind: ArtifactKind;
  /** File name shown to users, e.g. `step-01.png`. */
  name: string;
  contentType: string;
}

/** Byte range (inclusive) for partial reads. */
export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Where run artifacts live. `FsArtifactStore` is the local implementation, `S3ArtifactStore` the S3/MinIO one (S-068).
 */
export interface ArtifactStore {
  /** Stores the bytes and returns the artifact id. */
  put(data: Buffer | Readable, meta: ArtifactMeta): Promise<string>;
  /** Metadata of an artifact, or undefined. */
  stat(id: string): Promise<ArtifactRecord | undefined>;
  /** Content stream (optionally a byte range, inclusive). Throws `NOT_FOUND` for an unknown id. */
  get(id: string, range?: ByteRange): Promise<Readable>;
  /** Removes the file, the metadata and the evidence rows pointing at it. */
  delete(id: string): Promise<void>;
  /** Deletes artifacts of a project created before `olderThan`; returns how many were removed. */
  purge(olderThan: Date, projectId: string): Promise<number>;
  /**
   * Time-limited URL the client can GET directly from the storage backend (S3 presigned URL); stores without one
   * (file system) omit it and the server streams the bytes (S-068).
   */
  presignedUrl?(id: string, ttlSeconds?: number): Promise<string | undefined>;
}

const safeName = (s: string): string => s.replace(/[^\w.-]+/g, '_').slice(0, 120) || 'file';

/** Artifact store on the local file system under `<root>/<project>/<run>/<result>/<id>-<name>`. */
export class FsArtifactStore implements ArtifactStore {
  constructor(
    private readonly db: Db,
    readonly root: string,
  ) {}

  private abs(rel: string): string {
    const full = resolve(this.root, rel);
    if (!full.startsWith(resolve(this.root) + sep))
      throw new S1PilotError('ARTIFACT_PATH', 'Artifact path escapes the store root');
    return full;
  }

  async put(data: Buffer | Readable, meta: ArtifactMeta): Promise<string> {
    const id = newId();
    const rel = join(
      safeName(meta.projectId),
      safeName(meta.runId),
      safeName(meta.caseResultId),
      `${id}-${safeName(meta.name)}`,
    );
    const file = this.abs(rel);
    await mkdir(dirname(file), { recursive: true });
    await pipeline(Buffer.isBuffer(data) ? Readable.from([data]) : data, createWriteStream(file));
    const { size } = await stat(file);
    await repos.artifacts.create(this.db, {
      id,
      projectId: meta.projectId,
      runId: meta.runId,
      caseResultId: meta.caseResultId,
      ...(meta.stepIndex !== undefined ? { stepIndex: meta.stepIndex } : {}),
      kind: meta.kind,
      name: meta.name,
      contentType: meta.contentType,
      size,
      path: rel,
    });
    return id;
  }

  stat(id: string): Promise<ArtifactRecord | undefined> {
    return repos.artifacts.get(this.db, id);
  }

  async get(id: string, range?: ByteRange): Promise<Readable> {
    const record = await this.stat(id);
    if (!record) throw new S1PilotError('NOT_FOUND', `Artifact not found: ${id}`, { id });
    return createReadStream(
      this.abs(record.path),
      range ? { start: range.start, end: range.end } : {},
    );
  }

  async delete(id: string): Promise<void> {
    const record = await this.stat(id);
    if (!record) return;
    await rm(this.abs(record.path), { force: true });
    await repos.artifacts.deleteMany(this.db, [id]);
  }

  async purge(olderThan: Date, projectId: string): Promise<number> {
    const old = await repos.artifacts.listOlderThan(this.db, projectId, olderThan.toISOString());
    for (const record of old) await rm(this.abs(record.path), { force: true });
    return repos.artifacts.deleteMany(
      this.db,
      old.map((r) => r.id),
    );
  }
}
