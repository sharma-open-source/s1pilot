import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { ProbeResultSchema } from '@s1pilot/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { buildProgram, type CliDeps } from './program.js';

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

/** Fake `systemone` server; remembers the Authorization header of the last request. */
async function systemOneServer(): Promise<{ url: string; auth: () => string | undefined }> {
  let auth: string | undefined;
  const server = createServer((req, res) => {
    auth = req.headers['authorization'];
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/v1/systemone') {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as { questions: Record<string, { type: string }> };
        const answers = Object.fromEntries(
          Object.entries(body.questions).map(([id, q]) => [id, q.type === 'choice' ? { probabilities: { e2: 0.8, e1: 0.1, e3: 0.1 } } : { noul: 0.7 }]),
        );
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ answers }));
      } else {
        res.writeHead(404).end('not found');
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, auth: () => auth };
}

function run(args: string[], overrides: Partial<CliDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  let exitCode = 0;
  const program = buildProgram({
    stdout: (t) => void out.push(t),
    stderr: (t) => void err.push(t),
    setExitCode: (c) => void (exitCode = c),
    exitOverride: true,
    env: {},
    ...overrides,
  });
  return {
    done: program.parseAsync(['probe', ...args], { from: 'user' }),
    out: () => out.join(''),
    err: () => err.join(''),
    exitCode: () => exitCode,
  };
}

describe('s1pilot probe', () => {
  it('--json prints a result that validates against ProbeResultSchema', async () => {
    const { url } = await systemOneServer();
    const cli = run(['--url', url, '--model', 'Cloudflare/clef-flash', '--json']);
    await cli.done;
    const parsed = ProbeResultSchema.safeParse(JSON.parse(cli.out()));
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ ok: true, adapter: 'systemone', model: 'Cloudflare/clef-flash', isCloud: false });
    expect(cli.exitCode()).toBe(0);
  });

  it('prints the capability grid by default', async () => {
    const { url } = await systemOneServer();
    const cli = run(['--url', url, '--model', 'Cloudflare/clef-flash']);
    await cli.done;
    const text = cli.out();
    for (const label of ['Adapter', 'Model', 'Max options', 'Questions per call', 'Images', 'Context', 'Latency (p50)']) {
      expect(text).toContain(label);
    }
    expect(text).toMatch(/Adapter\s+systemone/);
    expect(text).toMatch(/Max options\s+64/);
    expect(text).toMatch(/Questions per call\s+several/);
    expect(text).toContain('local / private network');
  });

  it('exits 1 with a readable message when the server is unreachable (also with --json)', async () => {
    const { url } = await systemOneServer();
    servers.pop()?.close();
    const plain = run(['--url', url]);
    await plain.done;
    expect(plain.out()).toMatch(/Probe failed\s+Could not connect/);
    expect(plain.exitCode()).toBe(1);

    const asJson = run(['--url', url, '--json']);
    await asJson.done;
    expect(ProbeResultSchema.safeParse(JSON.parse(asJson.out())).success).toBe(true);
    expect(JSON.parse(asJson.out())).toMatchObject({ ok: false });
    expect(asJson.exitCode()).toBe(1);
  });

  it('sends --key (or S1PILOT_API_KEY) as the bearer token', async () => {
    const withFlag = await systemOneServer();
    await run(['--url', withFlag.url, '--model', 'm', '--key', 'sk-flag-key-0123456789abcdef']).done;
    expect(withFlag.auth()).toBe('Bearer sk-flag-key-0123456789abcdef');

    const withEnv = await systemOneServer();
    await run(['--url', withEnv.url, '--model', 'm'], { env: { S1PILOT_API_KEY: 'sk-env-key-0123456789abcdef' } }).done;
    expect(withEnv.auth()).toBe('Bearer sk-env-key-0123456789abcdef');
  });

  it('never prints the API key', async () => {
    const { url } = await systemOneServer();
    const cli = run(['--url', url, '--model', 'm', '--key', 'sk-flag-key-0123456789abcdef', '--json']);
    await cli.done;
    expect(cli.out()).not.toContain('sk-flag-key');
  });

  it('requires --url and rejects unknown adapters', async () => {
    await expect(run([]).done).rejects.toMatchObject({ code: 'commander.missingMandatoryOptionValue' });
    await expect(run(['--url', 'http://x.test', '--adapter', 'nope']).done).rejects.toMatchObject({
      code: 'commander.invalidArgument',
    });
  });

  it('passes an explicit --adapter to the probe', async () => {
    let seen: unknown;
    const cli = run(['--url', 'http://x.test', '--adapter', 'decide', '--model', 'jev'], {
      probe: async (target) => {
        seen = target;
        return { ok: false, latencyMs: { p50: 0, samples: [] }, isCloud: true, warnings: [], error: 'stub' };
      },
    });
    await cli.done;
    expect(seen).toEqual({ baseUrl: 'http://x.test', adapter: 'decide', model: 'jev' });
  });
});
