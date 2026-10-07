import { readFileSync } from 'node:fs';

import { AdapterKindSchema, type ProbeResult } from '@s1pilot/domain';
import { probe as defaultProbe, type ProbeTarget } from '@s1pilot/providers';
import { Command, Option } from 'commander';

/** Reads the version from the root package.json (three levels above `dist/` or `src/`). */
export function getVersion(): string {
  const raw = readFileSync(new URL('../../../package.json', import.meta.url), 'utf8');
  return (JSON.parse(raw) as { version: string }).version;
}

/** Side effects of the CLI, injectable for tests. */
export interface CliDeps {
  probe: (target: ProbeTarget) => Promise<ProbeResult>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Sets the process exit code. */
  setExitCode: (code: number) => void;
  /** Throw instead of exiting on usage errors (tests). */
  exitOverride: boolean;
  env: NodeJS.ProcessEnv;
}

const defaultDeps: CliDeps = {
  probe: (target) => defaultProbe(target),
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
  setExitCode: (code) => {
    process.exitCode = code;
  },
  exitOverride: false,
  env: process.env,
};

/** Renders a probe result as the capability grid shown in the new-project wizard. */
export function formatProbe(result: ProbeResult): string {
  const rows: [string, string][] = [];
  if (result.ok && result.capabilities) {
    const c = result.capabilities;
    rows.push(
      ['Adapter', result.adapter ?? '-'],
      ['Model', result.model ?? '-'],
      ['Max options', String(c.maxOptions)],
      ['Questions per call', c.multiQuestionPerCall ? 'several' : '1'],
      ['Images', c.supportsImages ? 'yes' : 'no'],
      ['Context', `${c.maxContextTokens} tokens`],
      ['Order sensitive', c.orderSensitive ? 'yes' : 'no'],
      ['Latency (p50)', `${result.latencyMs.p50} ms  (samples: ${result.latencyMs.samples.join(', ')})`],
      ['Endpoint', result.isCloud ? 'cloud (data leaves your network)' : 'local / private network'],
    );
  } else {
    rows.push(['Probe failed', result.error ?? 'unknown error']);
  }
  const width = Math.max(...rows.map(([label]) => label.length));
  const lines = rows.map(([label, value]) => `${label.padEnd(width)}  ${value}`);
  for (const warning of result.warnings) lines.push(`! ${warning}`);
  return `${lines.join('\n')}\n`;
}

/** Builds the `s1pilot` command tree. */
export function buildProgram(overrides: Partial<CliDeps> = {}): Command {
  const deps: CliDeps = { ...defaultDeps, ...overrides };
  const program = new Command('s1pilot').description('s1-pilot CLI').version(getVersion());
  if (deps.exitOverride) {
    program.exitOverride();
    program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  }

  program
    .command('probe')
    .description('Detect which adapter a model endpoint speaks, its capabilities and latency')
    .requiredOption('--url <url>', 'base URL of the model server, e.g. http://localhost:8000')
    .option('--model <name>', 'model name (looked up from /v1/models when omitted)')
    .option('--key <key>', 'API key (or set S1PILOT_API_KEY)')
    .addOption(
      new Option('--adapter <adapter>', 'force an adapter instead of auto-detecting')
        .choices(['auto', ...AdapterKindSchema.options])
        .default('auto'),
    )
    .option('--json', 'print the result as JSON')
    .action(async (opts: { url: string; model?: string; key?: string; adapter: ProbeTarget['adapter']; json?: boolean }) => {
      const apiKey = opts.key ?? deps.env['S1PILOT_API_KEY'];
      const result = await deps.probe({
        baseUrl: opts.url,
        adapter: opts.adapter,
        ...(opts.model ? { model: opts.model } : {}),
        ...(apiKey ? { apiKey } : {}),
      });
      deps.stdout(opts.json ? `${JSON.stringify(result, null, 2)}\n` : formatProbe(result));
      if (!result.ok) deps.setExitCode(1);
    });

  return program;
}
