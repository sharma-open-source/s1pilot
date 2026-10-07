import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { createReadlineHumanHook } from './human.js';

const req = {
  question: 'Which?',
  options: { a: 'Buy', b: 'Cancel' },
  probabilities: { a: 0.6, b: 0.4 },
  reason: 'low confidence',
};

function setup(isTTY: boolean) {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (d: Buffer) => (written += d.toString()));
  return { input, hook: createReadlineHumanHook({ input, output, isTTY }), text: () => written };
}

describe('createReadlineHumanHook', () => {
  it('is unavailable on a non-TTY', async () => {
    const { hook, text } = setup(false);
    await expect(hook.ask(req)).rejects.toMatchObject({ code: 'HUMAN_UNAVAILABLE' });
    expect(text()).toBe('');
  });

  it('accepts a number, an id, and s/a/t on a TTY', async () => {
    for (const [line, expected] of [
      ['2', { choice: 'b' }],
      ['a', { abort: true }],
      ['s', { skip: true }],
      ['t', { takeover: true }],
    ] as const) {
      const { input, hook } = setup(true);
      const p = hook.ask(req);
      input.write(`${line}\n`);
      await expect(p).resolves.toEqual(expected);
    }
    const { input, hook } = setup(true);
    const p = hook.ask({ ...req, options: { x: 'X', y: 'Y' } });
    input.write('y\n');
    await expect(p).resolves.toEqual({ choice: 'y' });
  });

  it('re-prompts on invalid input and shows options with probabilities', async () => {
    const { input, hook, text } = setup(true);
    const p = hook.ask(req);
    input.write('nonsense\n9\n1\n');
    await expect(p).resolves.toEqual({ choice: 'a' });
    expect(text()).toContain('p=0.60');
    expect(text()).toContain('Not a valid answer');
  });

  it('is unavailable when input closes before an answer', async () => {
    const { input, hook } = setup(true);
    const p = hook.ask(req);
    input.end();
    await expect(p).rejects.toMatchObject({ code: 'HUMAN_UNAVAILABLE' });
  });
});
