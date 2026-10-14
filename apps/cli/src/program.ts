import { readFileSync } from 'node:fs';

import { AdapterKindSchema, type ProbeResult } from '@s1pilot/domain';
import { probe as defaultProbe, type ProbeOptions, type ProbeTarget } from '@s1pilot/providers';
import { Command, Option } from 'commander';

import { registerAdminCommands } from './admin.js';
import { registerCalibrateCommand } from './calibrate.js';
import { registerCiCommentCommand } from './ci/comment.js';
import { executeServerRun } from './ci/server-run.js';
import { registerEvalCommand } from './eval.js';
import { executeRun, type RunOptions } from './run.js';
import { registerSyncCommands } from './sync.js';
import { openInBrowser, registerUiCommand } from './ui.js';
import { registerWorkerCommand } from './worker.js';

/**
 * Reads the version from the nearest package.json: the CLI's own (one level above `dist/` or `src/`, which is also
 * the packed tarball layout) or, in the monorepo, the root one (three levels above).
 */
export function getVersion(): string {
  for (const path of ['../package.json', '../../../package.json']) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch {
      // try the next candidate
    }
  }
  return '0.0.0';
}

/** Side effects of the CLI, injectable for tests. */
export interface CliDeps {
  probe: (target: ProbeTarget, options?: ProbeOptions) => Promise<ProbeResult>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Sets the process exit code. */
  setExitCode: (code: number) => void;
  /** Throw instead of exiting on usage errors (tests). */
  exitOverride: boolean;
  env: NodeJS.ProcessEnv;
  /** Opens a URL in the default browser (`s1pilot ui`); tests must inject a stub. */
  openBrowser: (url: string) => void;
  /** HTTP client for server mode and the GitHub API (tests inject a fake). */
  fetch?: typeof fetch;
}

const defaultDeps: CliDeps = {
  probe: (target, options) => defaultProbe(target, options),
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
  setExitCode: (code) => {
    process.exitCode = code;
  },
  exitOverride: false,
  env: process.env,
  openBrowser: openInBrowser,
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
      [
        'Latency (p50)',
        `${result.latencyMs.p50} ms  (samples: ${result.latencyMs.samples.join(', ')})`,
      ],
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

/** Flags that only apply to server mode (`--plan` / `--server`). */
interface ServerFlags {
  plan?: string;
  server?: string;
  token?: string;
  projectKey?: string;
  pollInterval?: number;
  waitTimeout?: number;
}

/** Builds the `s1pilot` command tree. */
export function buildProgram(overrides: Partial<CliDeps> = {}): Command {
  const deps: CliDeps = { ...defaultDeps, ...overrides };
  const program = new Command('s1pilot').description('s1pilot CLI').version(getVersion());
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
    .option(
      '--timeout <ms>',
      'per-request timeout in ms (default 5000; raise it for slow cloud endpoints)',
      (v) => Number.parseInt(v, 10),
    )
    .option('--json', 'print the result as JSON')
    .action(
      async (opts: {
        url: string;
        model?: string;
        key?: string;
        adapter: ProbeTarget['adapter'];
        timeout?: number;
        json?: boolean;
      }) => {
        const apiKey = opts.key ?? deps.env['S1PILOT_API_KEY'];
        const result = await deps.probe(
          {
            baseUrl: opts.url,
            adapter: opts.adapter,
            ...(opts.model ? { model: opts.model } : {}),
            ...(apiKey ? { apiKey } : {}),
          },
          opts.timeout !== undefined && opts.timeout > 0 ? { timeoutMs: opts.timeout } : {},
        );
        deps.stdout(opts.json ? `${JSON.stringify(result, null, 2)}\n` : formatProbe(result));
        if (!result.ok) deps.setExitCode(1);
      },
    );

  program
    .command('run')
    .description(
      'Run YAML test cases: replay learned scripts (healing broken steps) or explore with AI (exit codes: 0 passed, 1 failed, 2 needs review, 3 config error)',
    )
    .argument('[file-or-dir]', 'a test case YAML file or a directory of them (omit with --plan --server)')
    .option('--plan <name>', 'run a test plan by name on an s1pilot server (needs --server)')
    .option('--server <url>', 'report to / run on this s1pilot server (with --plan)')
    .option('--token <token>', 'API token for --server (or set S1PILOT_TOKEN)')
    .option('--project-key <key>', 'project key on the server (default: key from .s1pilot/project.yaml)')
    .option('--build-ref <ref>', 'build number or reference recorded on the run')
    .option('--commit <sha>', 'commit SHA recorded on the run (used as build reference when --build-ref is absent)')
    .option('--branch <name>', 'branch name shown in the PR comment')
    .option('--poll-interval <ms>', 'server mode: milliseconds between status polls', (v) => Number.parseInt(v, 10), 2000)
    .option('--wait-timeout <ms>', 'server mode: stop waiting after this many milliseconds', (v) => Number.parseInt(v, 10), 3_600_000)
    .option('--env <name>', 'environment from .s1pilot/project.yaml (default: the project default)')
    .option('--model-url <url>', 'System 1 model server base URL')
    .option('--model <name>', 'System 1 model name')
    .addOption(
      new Option('--adapter <adapter>', 'System 1 adapter').choices(AdapterKindSchema.options),
    )
    .option('--profile <id>', 'model capability profile (thresholds), e.g. clef-flash')
    .option('--key <key>', 'System 1 API key (or set S1PILOT_API_KEY)')
    .option('--s2-url <url>', 'System 2 (chat LLM) base URL')
    .option('--s2-model <name>', 'System 2 model name')
    .option('--headed', 'show the browser window')
    .option('--attended', 'ask a human on the terminal when the engine cannot decide')
    .addOption(
      new Option('--browser <name>', 'browser engine')
        .choices(['chromium', 'firefox', 'webkit'])
        .default('chromium'),
    )
    .option('--out <dir>', 'output directory for trace.jsonl and result.json', './s1pilot-results')
    .option(
      '--project <dir>',
      'project directory containing .s1pilot/project.yaml (default: searched upwards from the target)',
    )
    .option(
      '--base-url <url>',
      'override the environment base URL (or define an ad-hoc environment)',
    )
    .addOption(
      new Option('--mode <mode>', 'replay-heal: replay learned scripts and heal broken steps; explore: always use AI; replay-only: never call a model')
        .choices(['replay-heal', 'explore', 'replay-only'])
        .default('replay-heal'),
    )
    .option('--reporter <names>', 'comma-separated reports to write into --out: junit (junit.xml), json (report.json), html (report.html)')
    .option('--parallel <n>', 'cases to run at the same time, each in its own browser context', (v) => Number.parseInt(v, 10), 1)
    .option('--mock-script <file>', 'JSON script for --adapter mock (steps, inputs, expected)')
    .action(async (target: string | undefined, opts: RunOptions & ServerFlags) => {
      if (opts.plan !== undefined || opts.server !== undefined) {
        deps.setExitCode(
          await executeServerRun(
            { ...opts, ...(opts.pollInterval !== undefined ? { pollInterval: opts.pollInterval } : {}) },
            { ...deps, ...(deps.fetch ? { fetch: deps.fetch } : {}) },
          ),
        );
        return;
      }
      if (target === undefined) {
        deps.stderr('error: pass a test case file or directory, or --plan <name> --server <url>\n');
        deps.setExitCode(3);
        return;
      }
      deps.setExitCode(await executeRun(target, opts, deps));
    });

  registerSyncCommands(program, deps);
  registerEvalCommand(program, deps);
  registerCalibrateCommand(program, deps);
  registerAdminCommands(program, deps);
  registerUiCommand(program, deps);
  registerWorkerCommand(program, deps);
  registerCiCommentCommand(program, deps);

  return program;
}
