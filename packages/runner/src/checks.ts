import AxeBuilder from '@axe-core/playwright';
import {
  A11yImpactSchema,
  impactAtLeast,
  matchesAllowList,
  type A11yImpact,
  type CheckConfig,
  type CheckItem,
  type CheckResult,
  type Redactor,
} from '@s1pilot/domain';
import type { BrowserContext, Page } from 'playwright';

/** Most nodes kept per axe violation and most check items per kind (evidence stays small). */
const MAX_NODES_PER_RULE = 20;
const MAX_ITEMS = 200;

/** Failure texts that are not real network failures (navigations cancelled by the next one, our own guards). */
const IGNORED_FAILURES = /ERR_ABORTED|ERR_BLOCKED_BY_CLIENT|NS_BINDING_ABORTED|cancelled/i;

/**
 * Cheap identity of what is on screen: URL without query, title, and counts of the elements axe cares about. A
 * page that keeps the same fingerprint after a step is not scanned again. Evaluated as a string: the runner is
 * compiled without DOM typings.
 */
const FINGERPRINT_SCRIPT = `(() => {
  const count = (sel) => document.querySelectorAll(sel).length;
  const heads = Array.from(document.querySelectorAll('h1,h2')).slice(0, 8).map((h) => (h.textContent || '').trim().slice(0, 40)).join(',');
  return [location.origin + location.pathname, document.title, count('input,select,textarea'), count('button,[role=button]'), count('a[href]'), count('img'), count('[role=dialog],dialog[open]'), heads].join('|');
})()`;

/**
 * Collects the health checks of one case instance (S-053): console errors and uncaught page errors, failing
 * network requests, and an axe accessibility scan after steps (once per page fingerprint).
 */
export class CaseChecks {
  private readonly consoleItems: CheckItem[] = [];
  private readonly networkItems: CheckItem[] = [];
  private readonly a11yItems: CheckItem[] = [];
  private readonly seenA11y = new Set<string>();
  private readonly scanned = new Set<string>();
  private readonly origin: string;
  private step = 0;
  /** Milliseconds spent in axe scans (overhead measurement). */
  scanMs = 0;
  /** Number of axe scans run. */
  scans = 0;

  constructor(
    private readonly config: CheckConfig,
    baseUrl: string,
    private readonly redactor: Redactor,
  ) {
    this.origin = safeOrigin(baseUrl);
  }

  /** Starts listening on the context (call before the first page opens). */
  attach(context: BrowserContext): void {
    const { console: con, network } = this.config;
    context.on('console', (m) => {
      if (m.type() !== 'error') return;
      const text = m.text();
      const loc = m.location();
      if (matchesAllowList(`${text} ${loc.url}`, con.allow)) return;
      this.push(this.consoleItems, {
        summary: this.redactor.redact(text),
        severity: con.mode,
        type: 'error',
        ...(loc.url ? { url: this.redactor.redact(`${loc.url}:${loc.lineNumber}`) } : {}),
        stepIndex: this.step,
      });
    });
    context.on('weberror', (e) => {
      const text = e.error().message;
      if (matchesAllowList(text, con.allow)) return;
      this.push(this.consoleItems, { summary: this.redactor.redact(text), severity: con.mode, type: 'pageerror', stepIndex: this.step });
    });
    const considered = (url: string): boolean =>
      !matchesAllowList(url, network.allow) && (network.thirdParty || this.origin === '' || safeOrigin(url) === this.origin);
    context.on('response', (res) => {
      const status = res.status();
      if (status < 500 || !considered(res.url())) return;
      const url = this.redactor.redact(res.url());
      this.push(this.networkItems, {
        summary: `${res.request().method()} ${url} -> ${status}`,
        severity: network.mode,
        status,
        url,
        stepIndex: this.step,
      });
    });
    context.on('requestfailed', (req) => {
      const failure = req.failure()?.errorText ?? 'failed';
      if (IGNORED_FAILURES.test(failure) || !considered(req.url())) return;
      const url = this.redactor.redact(req.url());
      this.push(this.networkItems, {
        summary: `${req.method()} ${url} failed: ${this.redactor.redact(failure)}`,
        severity: network.mode,
        type: failure,
        url,
        stepIndex: this.step,
      });
    });
  }

  private push(list: CheckItem[], item: CheckItem): void {
    if (list.length < MAX_ITEMS) list.push(item);
  }

  /** Call after step `index` finished: scans the page with axe unless this fingerprint was scanned already. */
  async afterStep(page: Page, index: number): Promise<void> {
    this.step = index + 1;
    const a11y = this.config.a11y;
    if (!a11y || page.isClosed()) return;
    const started = Date.now();
    try {
      const fingerprint = (await page.evaluate(FINGERPRINT_SCRIPT)) as string;
      if (this.scanned.has(fingerprint)) return;
      this.scanned.add(fingerprint);
      const builder = new AxeBuilder({ page });
      if (a11y.disabledRules.length > 0) builder.disableRules(a11y.disabledRules);
      const { violations, url } = await builder.analyze();
      this.scans++;
      const path = safePath(url);
      for (const v of violations) {
        const impact = A11yImpactSchema.safeParse(v.impact);
        for (const node of v.nodes.slice(0, MAX_NODES_PER_RULE)) {
          const nodeImpact: A11yImpact = (A11yImpactSchema.safeParse(node.impact).data ?? (impact.success ? impact.data : 'moderate'));
          const target = node.target.map((t) => (Array.isArray(t) ? t.join(' ') : String(t))).join(' ');
          const key = `${v.id}|${target}|${path}`;
          if (this.seenA11y.has(key)) continue;
          this.seenA11y.add(key);
          this.push(this.a11yItems, {
            summary: this.redactor.redact(v.help),
            severity: impactAtLeast(nodeImpact, a11y.failImpact) ? 'fail' : 'warn',
            ruleId: v.id,
            impact: nodeImpact,
            target: this.redactor.redact(target),
            helpUrl: v.helpUrl,
            url: this.redactor.redact(url),
            stepIndex: index,
          });
        }
      }
    } catch {
      // A page that navigates or closes mid-scan is not a finding.
    } finally {
      this.scanMs += Date.now() - started;
    }
  }

  /** The check results; a kind appears only when it is configured (a11y) or always (console, network). */
  results(): CheckResult[] {
    const make = (kind: CheckResult['kind'], items: CheckItem[]): CheckResult => ({
      kind,
      severity: items.some((i) => i.severity === 'fail') ? 'fail' : items.length > 0 ? 'warn' : 'pass',
      items,
    });
    return [
      ...(this.config.a11y ? [make('a11y', this.a11yItems)] : []),
      make('console', this.consoleItems),
      make('network', this.networkItems),
    ];
  }
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
