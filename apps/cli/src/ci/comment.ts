import { readFileSync } from 'node:fs';

import type { Command } from 'commander';

import { upsertPrComment } from './github.js';
import { renderPrComment, type CiSummary } from './summary.js';

/** The slice of `CliDeps` that `ci-comment` needs. */
interface CommentDeps {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  setExitCode: (code: number) => void;
  env: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}

/** Pull request number from `--pr` or the GitHub event payload (`GITHUB_EVENT_PATH`); undefined outside pull requests. */
function pullNumber(flag: string | undefined, env: NodeJS.ProcessEnv): number | undefined {
  if (flag !== undefined) {
    const n = Number.parseInt(flag, 10);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  }
  const path = env['GITHUB_EVENT_PATH'];
  if (!path) return undefined;
  try {
    const event = JSON.parse(readFileSync(path, 'utf8')) as { pull_request?: { number?: number }; number?: number };
    return event.pull_request?.number;
  } catch {
    return undefined;
  }
}

/**
 * `s1pilot ci-comment --summary <ci-summary.json>`: renders the PR comment and creates or updates it through the
 * GitHub API (`GITHUB_TOKEN`, `GITHUB_REPOSITORY`, `GITHUB_API_URL`). With `--print` only prints the body.
 * Outside a pull request it does nothing and exits 0.
 */
export function registerCiCommentCommand(program: Command, deps: CommentDeps): void {
  program
    .command('ci-comment')
    .description('Post or update the s1-pilot summary comment on a GitHub pull request (used by the run-action)')
    .requiredOption('--summary <file>', 'ci-summary.json written by `s1pilot run`')
    .option('--repo <owner/name>', 'repository (default: $GITHUB_REPOSITORY)')
    .option('--pr <number>', 'pull request number (default: from $GITHUB_EVENT_PATH)')
    .option('--github-token <token>', 'GitHub token (default: $GITHUB_TOKEN)')
    .option('--print', 'print the comment body instead of posting it')
    .action(async (opts: { summary: string; repo?: string; pr?: string; githubToken?: string; print?: boolean }) => {
      let summary: CiSummary;
      try {
        summary = JSON.parse(readFileSync(opts.summary, 'utf8')) as CiSummary;
      } catch (error) {
        deps.stderr(`error: cannot read ${opts.summary}: ${error instanceof Error ? error.message : String(error)}\n`);
        deps.setExitCode(3);
        return;
      }
      const body = renderPrComment(summary);
      if (opts.print) {
        deps.stdout(body);
        return;
      }
      const repo = opts.repo ?? deps.env['GITHUB_REPOSITORY'];
      const token = opts.githubToken ?? deps.env['GITHUB_TOKEN'];
      const pr = pullNumber(opts.pr, deps.env);
      if (pr === undefined) {
        deps.stdout('Not a pull request run; skipping the PR comment.\n');
        return;
      }
      if (!repo || !token) {
        deps.stderr('error: --repo/GITHUB_REPOSITORY and a GitHub token (GITHUB_TOKEN) are required to comment\n');
        deps.setExitCode(3);
        return;
      }
      try {
        const apiUrl = deps.env['GITHUB_API_URL'];
        const r = await upsertPrComment({ repo, pullNumber: pr, token, ...(apiUrl ? { apiUrl } : {}) }, body, deps.fetch ?? fetch);
        deps.stdout(`${r.created ? 'Posted' : 'Updated'} PR comment on ${repo}#${pr}\n`);
      } catch (error) {
        // A failed comment must not turn a passing test run into a failed job.
        deps.stderr(`warning: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    });
}
