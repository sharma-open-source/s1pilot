import type { BrowserContext, Page, Route } from 'playwright';

import type { GuardBlockedEvent, GuardEventSink, InstalledGuard } from './events.js';

/** Options for {@link installReadOnlyGuard}. */
export interface ReadOnlyGuardOptions {
  /**
   * Patterns (RegExp, or substring) tested against `METHOD url` that stay allowed, e.g. a login
   * POST or a search form.
   */
  allow?: ReadonlyArray<string | RegExp>;
  onEvent?: GuardEventSink;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * For read-only environments: aborts every non-GET/HEAD/OPTIONS request (form submissions and
 * xhr/fetch writes) unless it matches an allow pattern, and emits `guard.blocked`. Applies to all
 * hosts, which is a superset of the spec's same-origin requirement.
 */
export async function installReadOnlyGuard(
  target: Page | BrowserContext,
  opts: ReadOnlyGuardOptions = {},
): Promise<InstalledGuard> {
  const blocked: GuardBlockedEvent[] = [];
  const isAllowed = (key: string): boolean =>
    (opts.allow ?? []).some((p) => (typeof p === 'string' ? key.includes(p) : p.test(key)));
  const handler = async (route: Route): Promise<void> => {
    const req = route.request();
    const method = req.method().toUpperCase();
    if (SAFE_METHODS.has(method) || isAllowed(`${method} ${req.url()}`)) return route.fallback();
    const event: GuardBlockedEvent = {
      type: 'guard.blocked',
      guard: 'read-only',
      url: req.url(),
      method,
      resourceType: req.resourceType(),
      reason: `${method} requests are blocked in a read-only environment`,
      at: new Date().toISOString(),
    };
    blocked.push(event);
    opts.onEvent?.(event);
    await route.abort('blockedbyclient');
  };
  await target.route('**/*', handler);
  return { blocked, dispose: () => target.unroute('**/*', handler) };
}
