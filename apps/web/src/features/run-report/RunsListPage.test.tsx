import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { RunsListPage, type RunsListSearch } from './RunsListPage';

import { createFakeTrpc, FakeTrpcProvider } from '@/test/fake-trpc';

const SUMMARY = { passed: 1, failed: 0, blocked: 0, skipped: 0, flaky: 0, needsReview: 0 };
const run = (n: number, status = 'passed') => ({
  id: `run-zzzzz${n}`,
  projectId: 'p1',
  trigger: 'manual',
  status,
  startedAt: '2026-10-01T00:00:00.000Z',
  summary: SUMMARY,
  config: { environment: 'staging' },
  progress: { total: 1, completed: 1 },
});

function renderPage(search: RunsListSearch = {}, reports = false) {
  const fake = createFakeTrpc({
    'runs.page': (input) => {
      const { page } = input as { page: number };
      return {
        items: page === 1 ? [run(1), run(2, 'running')] : [run(3)],
        total: 27,
        page,
        pageSize: 25,
      };
    },
  });
  const onSearch = vi.fn();
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <RunsListPage projectKey="SHOP" reports={reports} search={search} onSearch={onSearch} />
      ),
    }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  render(
    <FakeTrpcProvider fake={fake}>
      <RouterProvider router={router} />
    </FakeTrpcProvider>,
  );
  return { fake, onSearch };
}

describe('RunsListPage pagination', () => {
  it('asks the server for one page and links to the next', async () => {
    const { fake, onSearch } = renderPage();
    expect(await screen.findByText('#zzzzz1')).toBeInTheDocument();
    expect(screen.getByText('Showing 2 of 27')).toBeInTheDocument();
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
    expect(fake.calls.find((c) => c.path === 'runs.page')?.input).toMatchObject({
      projectKey: 'SHOP',
      finished: false,
      page: 1,
      pageSize: 25,
    });
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(onSearch).toHaveBeenCalledWith({ page: 2 });
  });

  it('reports list requests finished runs on the page from the URL', async () => {
    const { fake, onSearch } = renderPage({ page: 2 }, true);
    expect(await screen.findByText('Page 2 of 2')).toBeInTheDocument();
    await waitFor(() =>
      expect(fake.calls.find((c) => c.path === 'runs.page')?.input).toMatchObject({
        finished: true,
        page: 2,
      }),
    );
    expect(screen.getAllByRole('link', { name: 'JUnit' })).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(onSearch).toHaveBeenCalledWith({});
  });
});
