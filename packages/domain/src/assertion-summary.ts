// Pure, dependency-free so the web UI can import it via `@s1pilot/domain/assertion-summary` (S-021, S-044).
import type { Assertion } from './test-case.js';

/** Fields that locate an element in an assertion. */
export interface Target {
  role?: string | undefined;
  name?: string | undefined;
  text?: string | undefined;
  testId?: string | undefined;
  css?: string | undefined;
}

/** Short description of an assertion target (`status`, `button "Add"`). */
export function describeTarget(t: Target): string {
  if (t.testId) return t.testId;
  if (t.role) return t.name ? `${t.role} "${t.name}"` : t.role;
  if (t.text) return `"${t.text}"`;
  return t.css ?? '?';
}

const q = (s: string): string => JSON.stringify(s);

/**
 * Human-readable one-line summary of an assertion, as shown in UI tags
 * (`url ~ /checkout/payment`, `text(status) ⊇ "1"`).
 */
export function summarizeAssertion(a: Assertion): string {
  switch (a.type) {
    case 'urlMatches':
      return `url ~ ${a.pattern.startsWith('/') ? a.pattern : `/${a.pattern}`}`;
    case 'titleContains':
      return `title ⊇ ${q(a.contains)}`;
    case 'elementVisible':
      return `${a.visible ? 'visible' : 'hidden'}(${describeTarget(a)})`;
    case 'elementText':
      return a.equals !== undefined
        ? `text(${describeTarget(a)}) = ${q(a.equals)}`
        : `text(${describeTarget(a)}) ⊇ ${q(a.contains ?? '')}`;
    case 'elementValue':
      return `value(${describeTarget(a)}) = ${q(a.equals)}`;
    case 'elementCount': {
      const parts: string[] = [];
      if (a.equals !== undefined) parts.push(`= ${a.equals}`);
      if (a.min !== undefined) parts.push(`≥ ${a.min}`);
      if (a.max !== undefined) parts.push(`≤ ${a.max}`);
      return `count(${describeTarget(a)}) ${parts.join(' ') || '≥ 0'}`;
    }
    case 'responseStatus':
      return `response${a.method ? ` ${a.method.toUpperCase()}` : ''} ~ ${a.urlPattern} → ${a.status}`;
    case 'noConsoleErrors':
      return 'no console errors';
    case 'downloadExists':
      return a.filenamePattern ? `download ~ ${a.filenamePattern}` : 'download exists';
    case 'apiCheck':
      return `api ${a.method} ${a.url}${a.status !== undefined ? ` → ${a.status}` : ''}${a.bodyContains ? ` ⊇ ${q(a.bodyContains)}` : ''}`;
    case 'ai':
      return `AI: ${a.expected}`;
  }
}
