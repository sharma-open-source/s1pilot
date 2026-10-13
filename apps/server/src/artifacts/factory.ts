import type { Db } from '@s1pilot/db';

import type { ServerConfig } from '../config.js';

import { S3ArtifactStore } from './s3-store.js';
import { FsArtifactStore, type ArtifactStore } from './store.js';

const cache = new WeakMap<Db, { key: string; store: ArtifactStore }>();

/**
 * The artifact store the config selects: S3 / MinIO when `s3Bucket` is set, else the file system under
 * `artifactsDir`. One instance per database and config, so the S3 client is reused.
 */
export function createArtifactStore(db: Db, config: Pick<ServerConfig, 'artifactsDir' | 's3Bucket' | 's3Endpoint' | 's3PublicEndpoint' | 's3Region' | 's3Prefix'>): ArtifactStore {
  const key = JSON.stringify([config.artifactsDir, config.s3Bucket, config.s3Endpoint, config.s3PublicEndpoint, config.s3Region, config.s3Prefix]);
  const hit = cache.get(db);
  if (hit?.key === key) return hit.store;
  const store: ArtifactStore = config.s3Bucket
    ? new S3ArtifactStore(db, {
        bucket: config.s3Bucket,
        ...(config.s3Prefix ? { prefix: config.s3Prefix } : {}),
        ...(config.s3Region ? { region: config.s3Region } : {}),
        ...(config.s3Endpoint ? { endpoint: config.s3Endpoint } : {}),
        ...(config.s3PublicEndpoint ? { publicEndpoint: config.s3PublicEndpoint } : {}),
      })
    : new FsArtifactStore(db, config.artifactsDir);
  cache.set(db, { key, store });
  return store;
}
