import type { BrowserContext, Page, Route } from 'playwright';

import type { GuardBlockedEvent, GuardEventSink, InstalledGuard } from './events.js';

/** Options for {@link installDomainGuard}. */
export interface DomainGuardOptions {
  /** Environment base URL; its host is always allowed. */
  baseUrl: string;
  /** Extra allowed hosts. `example.com` also allows subdomains; `*.example.com` allows subdomains only. */
  allowDomains?: readonly string[];
  onEvent?: GuardEventSink;
}

const GUARDED_TYPES = new Set(['document', 'xhr', 'fetch']);

/** True when `hostname` equals an allowed entry or is a subdomain of it. */
export function hostAllowed(hostname: string, allowed: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  return allowed.some((raw) => {
    const entry = raw.toLowerCase().trim();
    if (entry.startsWith('*.')) return host.endsWith(entry.slice(1));
    return host === entry || host.endsWith(`.${entry}`);
  });
}

/**
 * Aborts document, xhr and fetch requests to hosts outside `baseUrl` + `allowDomains` and emits
 * `guard.blocked` events. Non-http(s) URLs (data:, blob:, about:) and subresources
 * (images, scripts, styles) are left alone.
 */
export async function installDomainGuard(
  target: Page | BrowserContext,
  opts: DomainGuardOptions,
): Promise<InstalledGuard> {
  const allowed = [new URL(opts.baseUrl).hostname, ...(opts.allowDomains ?? [])];
  const blocked: GuardBlockedEvent[] = [];
  const handler = async (route: Route): Promise<void> => {
    const req = route.request();
    let url: URL;
    try {
      url = new URL(req.url());
    } catch {
      return route.fallback();
    }
    if (!/^https?:$/.test(url.protocol) || !GUARDED_TYPES.has(req.resourceType()) || hostAllowed(url.hostname, allowed)) {
      return route.fallback();
    }
    const event: GuardBlockedEvent = {
      type: 'guard.blocked',
      guard: 'domain',
      url: req.url(),
      method: req.method(),
      resourceType: req.resourceType(),
      reason: `Host ${url.hostname} is not in the allowed domains`,
      at: new Date().toISOString(),
    };
    blocked.push(event);
    opts.onEvent?.(event);
    await route.abort('blockedbyclient');
  };
  await target.route('**/*', handler);
  return { blocked, dispose: () => target.unroute('**/*', handler) };
}
