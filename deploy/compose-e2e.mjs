#!/usr/bin/env node
// Nightly compose integration test (S-068). Run against a stack started with
//   docker compose -f deploy/compose.team.yml -f deploy/compose.e2e.yml up -d --build --wait
// Checks: both remote workers registered with their labels, a plan runs on the remote workers, a plan labelled `gpu`
// runs only on the gpu worker, and artifacts are served from MinIO through presigned URLs.
//
// Needs no dependencies (Node 22). Environment: S1PILOT_URL (default http://localhost:5317), S1PILOT_WORKER_TOKEN.
// The model is the `mock` adapter, so verdicts are not asserted: the point is where jobs run and where evidence lands.

const base = process.env.S1PILOT_URL ?? 'http://localhost:5317';
const token = process.env.S1PILOT_WORKER_TOKEN;
if (!token) throw new Error('Set S1PILOT_WORKER_TOKEN (the same value the stack uses)');
const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (cond, message) => {
  if (!cond) throw new Error(`FAILED: ${message}`);
  console.log(`ok - ${message}`);
};

async function waitFor(what, fn, timeoutMs = 240_000) {
  const start = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      // not ready yet
    }
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await sleep(2000);
  }
}

/** tRPC over HTTP, without a transformer: queries take ?input=<json>, mutations a JSON body. */
async function trpc(path, input, mutation = false) {
  const res = await fetch(mutation ? `${base}/trpc/${path}` : `${base}/trpc/${path}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`, {
    method: mutation ? 'POST' : 'GET',
    headers: auth,
    ...(mutation ? { body: JSON.stringify(input ?? {}) } : {}),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${path}: ${JSON.stringify(body.error ?? body)}`);
  return body.result.data;
}

await waitFor('the server', async () => (await fetch(`${base}/api/health`)).ok);
const workers = await waitFor('two remote workers', async () => {
  const { remote } = await trpc('workspace.workers');
  return remote.filter((w) => w.status !== 'offline').length >= 2 ? remote : undefined;
});
assert(workers.some((w) => w.labels.includes('gpu')) && workers.some((w) => !w.labels.includes('gpu')), 'a gpu-labelled and a plain worker registered');

const project = await trpc('projects.create', { name: 'Shop', key: 'SHOP', baseUrl: 'http://fixtures:4400/shop' }, true);
await trpc('models.updateSettings', {
  target: 'SHOP',
  settings: { system1: { adapter: 'mock', model: 'mock' }, thresholds: { act: 0.8, pass: 0.9, fail: 0.1, escalate: 0.4 }, dualOrderSensitive: false },
}, true);
const envs = await trpc('environments.list', { projectKey: 'SHOP' });
const env = envs[0];
const testCase = await trpc('cases.create', {
  projectKey: 'SHOP',
  title: 'Open a product',
  priority: 'P2',
  type: 'e2e',
  tags: [],
  steps: [{ action: 'Search for "t-shirt" and open the "Classic Tee" product', expected: 'The product page for Classic Tee is shown' }],
}, true);

const plan = (name, workerLabels) =>
  trpc('plans.create', { projectKey: 'SHOP', name, selection: { kind: 'list', caseIds: [testCase.id] }, matrix: [{ environmentId: env.id, browser: 'chromium' }], workerLabels }, true);
const finished = (runId) =>
  waitFor(`run ${runId}`, async () => {
    const run = await trpc('runs.get', runId);
    return ['passed', 'failed', 'needs-review', 'cancelled', 'error'].includes(run.status) ? run : undefined;
  });

// 1. An unlabelled plan runs on a remote worker and its evidence lands in MinIO.
const anyRun = await trpc('runs.create', { projectKey: 'SHOP', planId: (await plan('Any worker', [])).id }, true);
const anyDone = await finished(anyRun.id);
assert(anyDone.jobs.length === 1 && anyDone.results.length === 1, 'the unlabelled plan produced a result');
const registered = new Set((await trpc('workspace.workers')).remote.map((w) => w.id));
const owner = anyDone.jobs[0].workerId;
assert(owner !== undefined && registered.has(owner), 'the job ran on a registered remote worker');

const detail = await trpc('runs.report', anyRun.id).catch(() => undefined);
const artifactIds = [];
const collect = (value) => {
  if (Array.isArray(value)) value.forEach(collect);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'artifactId' && typeof v === 'string') artifactIds.push(v);
      else collect(v);
    }
  }
};
collect(detail);
collect(anyDone);
assert(artifactIds.length > 0, 'the run has artifacts');
const res = await fetch(`${base}/api/artifacts/${artifactIds[0]}`, { headers: auth, redirect: 'manual' });
assert(res.status === 302, 'artifact requests redirect');
const location = res.headers.get('location') ?? '';
assert(new URL(location).searchParams.has('X-Amz-Signature'), 'the redirect is a presigned URL');
assert((await fetch(location)).ok, 'the presigned URL serves the artifact from MinIO');

// 2. A gpu plan runs only on the gpu worker.
const gpuRun = await trpc('runs.create', { projectKey: 'SHOP', planId: (await plan('GPU only', ['gpu'])).id }, true);
const gpuDone = await finished(gpuRun.id);
const gpuWorkers = new Set((await trpc('workspace.workers')).remote.filter((w) => w.labels.includes('gpu')).map((w) => w.id));
const gpuOwner = gpuDone.jobs[0].workerId;
assert(gpuOwner !== undefined && gpuWorkers.has(gpuOwner), 'the gpu-labelled plan ran on a gpu worker');
console.log(`project ${project.key ?? 'SHOP'} done`);
