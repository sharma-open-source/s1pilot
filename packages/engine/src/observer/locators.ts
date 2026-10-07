import type { LocatorCandidate } from '@s1pilot/domain';
import type { Frame, Locator, Page } from 'playwright';

/** Matches the test-id attributes we recognise: `data-testid`, `data-test`, `data-qa`. */
function testIdSelector(value: string): string {
  const v = JSON.stringify(value);
  return `[data-testid=${v}],[data-test=${v}],[data-qa=${v}]`;
}

/**
 * Turns a {@link LocatorCandidate} into a Playwright locator.
 * `role` candidates use an exact accessible-name match; `testId` matches `data-testid`, `data-test`
 * or `data-qa`; `text` is an exact text match. Pass a `Frame` for elements inside iframes.
 */
export function toPlaywrightLocator(scope: Page | Frame, candidate: LocatorCandidate): Locator {
  switch (candidate.kind) {
    case 'role': {
      const role = candidate.value as Parameters<Page['getByRole']>[0];
      return candidate.name === undefined
        ? scope.getByRole(role)
        : scope.getByRole(role, { name: candidate.name, exact: true });
    }
    case 'testId':
      return scope.locator(testIdSelector(candidate.value));
    case 'text':
      return scope.getByText(candidate.value, { exact: true });
    case 'css':
      return scope.locator(candidate.value);
  }
}

/**
 * Returns the first candidate (in order) that resolves to exactly one element, with its locator;
 * `null` if none is unique.
 */
export async function resolveFirstUnique(
  scope: Page | Frame,
  candidates: readonly LocatorCandidate[],
): Promise<{ candidate: LocatorCandidate; locator: Locator } | null> {
  for (const candidate of candidates) {
    const locator = toPlaywrightLocator(scope, candidate);
    if ((await locator.count()) === 1) return { candidate, locator };
  }
  return null;
}
