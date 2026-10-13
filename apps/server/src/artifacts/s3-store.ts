import { Readable } from 'node:stream';

import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { repos, type ArtifactRecord, type Db } from '@s1pilot/db';
import { S1PilotError, newId } from '@s1pilot/domain';

import type { ArtifactMeta, ArtifactStore, ByteRange } from './store.js';

/** Connection settings of an {@link S3ArtifactStore}. Credentials come from the AWS SDK default chain, never from here. */
export interface S3StoreOptions {
  bucket: string;
  /** Key prefix inside the bucket, e.g. `s1pilot/`. Default none. */
  prefix?: string;
  region?: string;
  /** Endpoint of an S3-compatible service (MinIO: `http://minio:9000`). */
  endpoint?: string;
  /**
   * Endpoint browsers use for presigned URLs when it differs from `endpoint` (the server reaches MinIO at
   * `http://minio:9000` inside the compose network, browsers at `http://localhost:9000`). Signatures bind the host.
   */
  publicEndpoint?: string;
  /** Path-style addressing (`endpoint/bucket/key`); MinIO needs it. Default true when `endpoint` is set. */
  forcePathStyle?: boolean;
  /** Lifetime of presigned GET URLs in seconds. Default 900. */
  presignTtlSeconds?: number;
  /** Explicit credentials (tests). Production uses `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` or an instance role. */
  credentials?: S3ClientConfig['credentials'];
  /** Pre-built client (tests). */
  client?: S3Client;
}

const safeName = (s: string): string => s.replace(/[^\w.-]+/g, '_').slice(0, 120) || 'file';

async function toBuffer(data: Buffer | Readable): Promise<Buffer> {
  if (Buffer.isBuffer(data)) return data;
  const chunks: Buffer[] = [];
  for await (const chunk of data) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

/**
 * Artifact store on S3-compatible object storage (AWS S3, MinIO). Objects live at
 * `<prefix><project>/<run>/<result>/<id>-<name>`; the `artifacts` table keeps the key relative to the prefix.
 * The UI can fetch artifacts straight from the bucket through {@link S3ArtifactStore.presignedUrl}.
 */
export class S3ArtifactStore implements ArtifactStore {
  readonly client: S3Client;
  /** Client that signs URLs for browsers (same as `client` unless a public endpoint is set). */
  private readonly signer: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly ttl: number;

  constructor(
    private readonly db: Db,
    opts: S3StoreOptions,
  ) {
    this.bucket = opts.bucket;
    this.prefix = opts.prefix ? opts.prefix.replace(/^\/+/, '').replace(/\/?$/, '/') : '';
    this.ttl = opts.presignTtlSeconds ?? 900;
    this.client =
      opts.client ??
      new S3Client({
        region: opts.region ?? 'us-east-1',
        ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
        forcePathStyle: opts.forcePathStyle ?? opts.endpoint !== undefined,
        ...(opts.credentials ? { credentials: opts.credentials } : {}),
      });
    this.signer =
      opts.publicEndpoint && opts.publicEndpoint !== opts.endpoint
        ? new S3Client({
            region: opts.region ?? 'us-east-1',
            endpoint: opts.publicEndpoint,
            forcePathStyle: opts.forcePathStyle ?? true,
            ...(opts.credentials ? { credentials: opts.credentials } : {}),
          })
        : this.client;
  }

  private key(rel: string): string {
    return this.prefix + rel;
  }

  async put(data: Buffer | Readable, meta: ArtifactMeta): Promise<string> {
    const id = newId();
    const rel = [safeName(meta.projectId), safeName(meta.runId), safeName(meta.caseResultId), `${id}-${safeName(meta.name)}`].join('/');
    // PutObject needs the length up front; artifacts are screenshots, traces and short videos, so buffering is fine.
    const body = await toBuffer(data);
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: this.key(rel), Body: body, ContentType: meta.contentType, ContentLength: body.length }),
    );
    await repos.artifacts.create(this.db, {
      id,
      projectId: meta.projectId,
      runId: meta.runId,
      caseResultId: meta.caseResultId,
      ...(meta.stepIndex !== undefined ? { stepIndex: meta.stepIndex } : {}),
      kind: meta.kind,
      name: meta.name,
      contentType: meta.contentType,
      size: body.length,
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
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: this.key(record.path), ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}) }),
    );
    if (!res.Body) throw new S1PilotError('NOT_FOUND', `Artifact object is empty: ${id}`, { id });
    return res.Body instanceof Readable ? res.Body : Readable.from(res.Body as AsyncIterable<Uint8Array>);
  }

  /** Presigned GET URL of an artifact (inline disposition for images/video), or undefined for an unknown id. */
  async presignedUrl(id: string, ttlSeconds: number = this.ttl): Promise<string | undefined> {
    const record = await this.stat(id);
    if (!record) return undefined;
    const inline = record.contentType.startsWith('image/') || record.contentType.startsWith('video/');
    return getSignedUrl(
      this.signer,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.key(record.path),
        ResponseContentType: record.contentType,
        ResponseContentDisposition: `${inline ? 'inline' : 'attachment'}; filename="${record.name.replace(/"/g, '')}"`,
      }),
      { expiresIn: ttlSeconds },
    );
  }

  async delete(id: string): Promise<void> {
    const record = await this.stat(id);
    if (!record) return;
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(record.path) }));
    await repos.artifacts.deleteMany(this.db, [id]);
  }

  async purge(olderThan: Date, projectId: string): Promise<number> {
    const old = await repos.artifacts.listOlderThan(this.db, projectId, olderThan.toISOString());
    // DeleteObjects takes at most 1000 keys per call.
    for (let i = 0; i < old.length; i += 1000) {
      const batch = old.slice(i, i + 1000);
      await this.client.send(
        new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: batch.map((r) => ({ Key: this.key(r.path) })), Quiet: true } }),
      );
    }
    return repos.artifacts.deleteMany(
      this.db,
      old.map((r) => r.id),
    );
  }
}
