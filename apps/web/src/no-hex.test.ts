// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('.', import.meta.url));
const HEX = /#[0-9a-fA-F]{3,8}\b/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe('design tokens', () => {
  it('has no hex colours outside styles/tokens.css', () => {
    const offenders = walk(SRC)
      .filter((f) => /\.(tsx?|css)$/.test(f) && !f.endsWith('tokens.css') && !f.endsWith('no-hex.test.ts'))
      .filter((f) => HEX.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(SRC.length));
    expect(offenders).toEqual([]);
  });

  it('defines every token from design.md 2.1', () => {
    const css = readFileSync(join(SRC, 'styles/tokens.css'), 'utf8');
    const required = [
      'bg-app', 'surface', 'surface-subtle', 'surface-muted', 'surface-hatch-a', 'surface-hatch-b', 'surface-selected',
      'border', 'border-input', 'divider', 'divider-row', 'border-dashed', 'border-dashed-strong',
      'text', 'text-strong-2', 'text-secondary', 'text-muted', 'ink', 'ink-text',
      'primary', 'primary-soft', 'primary-text', 'primary-text-hover',
      'ai', 'ai-soft', 'ai-strong',
      'success', 'success-soft', 'success-strong', 'success-dot',
      'danger', 'danger-soft', 'danger-strong', 'danger-ink', 'danger-border', 'danger-hatch',
      'warning', 'warning-soft', 'warning-strong', 'warning-ink', 'warning-bar', 'warning-log',
      'flaky', 'flaky-soft', 'chart-1', 'chart-2', 'chart-3', 'track',
    ];
    const missing = required.filter((t) => !new RegExp(`--${t}:\\s*#[0-9a-f]{6};`).test(css));
    expect(missing).toEqual([]);
  });
});
