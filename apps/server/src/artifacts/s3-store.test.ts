import { Readable } from 'node:stream';

import { identityCrypto, openDb, repos, type Db } from '@s1pilot/db';
import { newId } from '@s1pilot/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../config.js';

import { createArtifactStore } from './factory.js';
import { startFakeS3, type FakeS3 } from './fake-s3.js';
import { registerArtifactRoutes } from './routes.js';
import { S3ArtifactStore } from './s3-store.js';
import { FsArtifactStore } from './store.js';

async function drain(stream: AsyncIterable<Buffer | string>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

let s3: FakeS3;
let db: Db;
beforeEach(async () => {
  s3 = await startFakeS3();
  db = openDb({ url: ':memory:', crypto: identityCrypto });
});
afterEach(async () => {
  db.close();
  await s3.close();
});

const credentials = { accessKeyId: 'test', secretAccessKey: 'test-secret' };
const meta = (projectId: string, name = 'a.txt') => ({ projectId, runId: 'run1', caseResultId: 'cr1', kind: 'log' as const, name, contentType: 'text/plain' });

describe('S3ArtifactStore', () => {
  async function setup(prefix = 's1p/') {
    const project = await repos.projects.create(db, { id: newId(), name: 'Shop', key: 'SHOP' });
    const store = new S3ArtifactStore(db, { bucket: 'arts', endpoint: s3.endpoint, prefix, credentials });
    return { project, store };
  }

  it('puts buffers and streams, reads ranges and deletes', async () => {
    const { project, store } = await setup();
    const id = await store.put(Buffer.from('0123456789'), meta(project.id));
    const rec = await store.stat(id);
    expect(rec).toMatchObject({ size: 10, contentType: 'text/plain', name: 'a.txt' });
    expect([...s3.objects.keys()]).toEqual([`arts/s1p/${rec?.path}`]);
    expect((await drain(await store.get(id))).toString()).toBe('0123456789');
    expect((await drain(await store.get(id, { start: 2, end: 4 }))).toString()).toBe('234');
    const streamed = await store.put(Readable.from([Buffer.from('ab'), Buffer.from('cd')]), meta(project.id, 'b.txt'));
    expect((await drain(await store.get(streamed))).toString()).toBe('abcd');
    await store.delete(id);
    expect(await store.stat(id)).toBeUndefined();
    expect(s3.objects.size).toBe(1);
    await expect(store.get(id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('purge removes objects and rows older than the cutoff', async () => {
    const { project, store } = await setup('');
    await store.put(Buffer.from('old'), meta(project.id, 'old.txt'));
    expect(await store.purge(new Date(Date.now() + 60_000), project.id)).toBe(1);
    expect(s3.objects.size).toBe(0);
    expect(await repos.artifacts.listOlderThan(db, project.id, '9999-12-31T00:00:00.000Z')).toHaveLength(0);
  });

  it('hands out presigned GET URLs that the bucket serves directly (with ranges)', async () => {
    const { project, store } = await setup();
    const id = await store.put(Buffer.from('hello world'), { ...meta(project.id, 'shot.png'), contentType: 'image/png' });
    const url = await store.presignedUrl(id, 60);
    expect(url).toBeDefined();
    const u = new URL(url ?? '');
    expect(u.searchParams.get('X-Amz-Signature')).toBeTruthy();
    expect(u.searchParams.get('X-Amz-Expires')).toBe('60');
    const res = await fetch(url ?? '', { headers: { range: 'bytes=6-10' } });
    expect(res.status).toBe(206);
    expect(await res.text()).toBe('world');
    expect(res.headers.get('content-disposition')).toContain('inline; filename="shot.png"');
    expect(await store.presignedUrl('missing')).toBeUndefined();
  });

  it('signs URLs for the public endpoint when it differs from the internal one', async () => {
    const project = await repos.projects.create(db, { id: newId(), name: 'Shop', key: 'SHOP' });
    const store = new S3ArtifactStore(db, { bucket: 'arts', endpoint: s3.endpoint, publicEndpoint: 'http://localhost:9000', credentials });
    const id = await store.put(Buffer.from('x'), meta(project.id));
    expect((await store.presignedUrl(id)) ?? '').toMatch(/^http:\/\/localhost:9000\/arts\//);
    expect(s3.objects.size).toBe(1); // writes still go to the internal endpoint
  });

  it('GET /api/artifacts/:id redirects to the presigned URL; presign=false proxies the bytes', async () => {
    const { project, store } = await setup();
    const id = await store.put(Buffer.from('payload'), meta(project.id));
    const Fastify = (await import('fastify')).default;
    const redirecting = Fastify();
    registerArtifactRoutes(redirecting, store);
    const res = await redirecting.inject({ method: 'GET', url: `/api/artifacts/${id}` });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain(`${s3.endpoint}/arts/s1p/`);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(await (await fetch(String(res.headers.location))).text()).toBe('payload');
    await redirecting.close();

    const proxying = Fastify();
    registerArtifactRoutes(proxying, store, { presign: false });
    const direct = await proxying.inject({ method: 'GET', url: `/api/artifacts/${id}`, headers: { range: 'bytes=0-2' } });
    expect(direct.statusCode).toBe(206);
    expect(direct.body).toBe('pay');
    await proxying.close();
  });
});

describe('createArtifactStore', () => {
  it('picks S3 when a bucket is configured, else the file system, once per database', () => {
    const fsConfig = loadConfig({ dataDir: '/tmp/s1p-x' }, {});
    expect(createArtifactStore(db, fsConfig)).toBeInstanceOf(FsArtifactStore);
    const s3Config = loadConfig({ dataDir: '/tmp/s1p-x' }, { S1PILOT_S3_BUCKET: 'b', S1PILOT_S3_ENDPOINT: 'http://minio:9000', S1PILOT_S3_PREFIX: 'p/' });
    expect(s3Config).toMatchObject({ s3Bucket: 'b', s3Endpoint: 'http://minio:9000', s3Prefix: 'p/' });
    const store = createArtifactStore(db, s3Config);
    expect(store).toBeInstanceOf(S3ArtifactStore);
    expect(createArtifactStore(db, s3Config)).toBe(store);
  });
});
