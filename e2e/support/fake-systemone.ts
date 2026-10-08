import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { DecideRequestSchema } from '@s1pilot/domain';
import { MockDecisionModel, MockScriptSchema, mockResolver, type MockScript } from '@s1pilot/providers';

export interface FakeSystemOne {
  /** Base URL to paste into the app, e.g. `http://127.0.0.1:41233`. */
  url: string;
  /** Number of decision calls answered so far. */
  readonly calls: number;
  /** Makes the next `next_action` answer unsure (confidence 0.6) so the engine escalates to a human. */
  escalateNextAction(): void;
  close(): Promise<void>;
}

/** Oracle script for the first-test flow: which options to pick on the fixture shop (click-only, so no test data is needed). */
export const CART_SCRIPT: MockScript = MockScriptSchema.parse({
  steps: {
    'Add the Classic Tee': ['[link] Classic Tee', '[radio] Blue', '[radio] M', '[button] Add to cart'],
  },
  expected: 0.95,
});

/**
 * A fake System 1 server speaking the `systemone` wire format (`POST /v1/systemone`), answering with the oracle
 * mock: it always knows the right answer, so the E2E checks the product wiring, not model quality.
 * Never reaches the network.
 */
export async function startFakeSystemOne(script: MockScript = CART_SCRIPT): Promise<FakeSystemOne> {
  const model = new MockDecisionModel({ fallback: mockResolver(script) });
  let calls = 0;
  let unsure = 0;

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        const send = (status: number, body: unknown): void => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
        };
        if (req.method === 'GET') return send(200, { data: [{ id: 'oracle' }] });
        const parsed = DecideRequestSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString() || '{}'));
        if (!parsed.success) return send(400, { error: 'bad request' });
        calls++;
        const answers = await model.decide(parsed.data);
        const first = answers['next_action'];
        if (unsure > 0 && first?.choice !== undefined && first.choice !== 'step_done') {
          unsure--;
          const others = Object.keys(first.probabilities).filter((k) => k !== first.choice);
          const rest = others.length > 0 ? 0.4 / others.length : 0;
          answers['next_action'] = {
            ...first,
            confidence: 0.6,
            probabilities: Object.fromEntries(Object.keys(first.probabilities).map((k) => [k, k === first.choice ? 0.6 : rest])),
          };
        }
        send(200, { answers });
      })().catch((error: unknown) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(error) }));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    get calls() {
      return calls;
    },
    escalateNextAction: () => {
      unsure++;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
