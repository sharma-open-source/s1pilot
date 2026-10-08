import { createMemoryHistory, createRootRoute, createRouter, RouterProvider, useRouterState } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Nav } from './Nav';

import { EMPTY_BADGES, EMPTY_MODELS, type ModelsStatus, type WorkspaceBadges } from '@/lib/nav-data';


const LABELS = [
  'Dashboard',
  'Project setup',
  'Environments',
  'Test cases',
  'Test plans',
  'Runs',
  'Manual testing',
  'Reports',
  'Review queue',
  'Defects',
  'Analytics',
  'Settings',
];

async function renderNavAt(path: string, badges: WorkspaceBadges = EMPTY_BADGES, models: ModelsStatus = EMPTY_MODELS) {
  function Host() {
    const pathname = useRouterState({ select: (s) => s.location.pathname });
    return (
      <Nav
        pathname={pathname}
        projects={[{ key: 'SHOP', name: 'Storefront' }]}
        currentProjectKey="shop"
        badges={badges}
        models={models}
      />
    );
  }
  const router = createRouter({
    routeTree: createRootRoute({ component: Host }),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(<RouterProvider router={router} />);
  return screen.findByRole('navigation', { name: 'Main' });
}

describe('Nav', () => {
  it('lists the 12 items in wireframe order', async () => {
    const nav = await renderNavAt('/');
    const links = within(nav).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual(LABELS);
  });

  it('marks only the current page with aria-current="page"', async () => {
    const nav = await renderNavAt('/p/shop/runs/abc/live');
    const current = within(nav).getAllByRole('link').filter((l) => l.getAttribute('aria-current') === 'page');
    expect(current.map((l) => l.textContent)).toEqual(['Runs']);
  });

  it('activates Dashboard only on "/"', async () => {
    const nav = await renderNavAt('/');
    expect(within(nav).getByRole('link', { name: 'Dashboard' })).toHaveAttribute('aria-current', 'page');
  });

  it('scopes project links to the selected project', async () => {
    const nav = await renderNavAt('/');
    expect(within(nav).getByRole('link', { name: 'Test cases' })).toHaveAttribute('href', '/p/shop/cases');
  });

  it('shows live-run and review badges only when non-zero', async () => {
    const nav = await renderNavAt('/', { liveRuns: 1, reviewCount: 4 });
    expect(within(nav).getByRole('link', { name: /Runs/ })).toHaveTextContent('1 live');
    expect(within(nav).getByRole('link', { name: /Review queue/ })).toHaveTextContent('4');
    expect(within(nav).getByRole('link', { name: 'Defects' })).toHaveTextContent(/^Defects$/);
  });

  it('shows the Models box with S1 and S2 status', async () => {
    const nav = await renderNavAt('/', EMPTY_BADGES, {
      s1: { model: 'clef-flash', endpoint: 'localhost:8000', reachable: true },
      s2: { model: 'openai-chat', endpoint: 'localhost:11434', reachable: false },
    });
    const box = within(nav).getByRole('region', { name: 'Models' });
    expect(box).toHaveTextContent('S1 clef-flash · localhost:8000');
    expect(box).toHaveTextContent('(reachable)');
    expect(box).toHaveTextContent('S2 openai-chat · localhost:11434');
    expect(box).toHaveTextContent('(unreachable)');
  });

  it('degrades to "status unknown" when models.status is absent', async () => {
    const nav = await renderNavAt('/');
    await waitFor(() => expect(within(nav).getByRole('region', { name: 'Models' })).toHaveTextContent('not configured'));
  });
});
