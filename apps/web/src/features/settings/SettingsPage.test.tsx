import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeAll, describe, expect, it } from 'vitest';

import { ciCommand, parseSection, SETTINGS_SECTIONS } from './model';
import { SettingsPage } from './SettingsPage';

import { createQueryClient, createTrpcClient, trpc } from '@/lib/trpc';
import { createFakeTrpc, type FakeTrpc, type Handler } from '@/test/fake-trpc';

const TOKEN = 's1p_1a2b3c4d_' + 'ab'.repeat(24);

function renderPage(section: string, over: Record<string, Handler> = {}): { fake: FakeTrpc; queryClient: QueryClient } {
  const fake = createFakeTrpc({
    'projects.list': () => [{ key: 'SHOP', name: 'Storefront' }],
    'plans.list': () => [{ id: 'pl1', name: 'Checkout regression' }],
    'environments.list': () => [{ id: 'e1', name: 'staging' }],
    ...over,
  });
  const queryClient = createQueryClient();
  const client = createTrpcClient(fake.fetch);
  const root = createRootRoute();
  const route = createRoute({ getParentRoute: () => root, path: '/settings/$section', component: () => <SettingsPage section={section} /> });
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: [`/settings/${section}`] }) });
  function Wrapper() {
    const [c] = useState(() => client);
    return (
      <trpc.Provider client={c} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </trpc.Provider>
    );
  }
  render(<Wrapper />);
  return { fake, queryClient };
}

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => undefined;
  Element.prototype.releasePointerCapture ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
});

describe('settings model', () => {
  it('keeps the artboard section order and parses slugs', () => {
    expect(SETTINGS_SECTIONS.map((s) => s.label)).toEqual([
      'General',
      'Models & endpoints',
      'Integrations',
      'Notifications',
      'Users & roles',
      'Data & retention',
      'Workers',
      'API tokens & CLI',
      'Audit log',
    ]);
    expect(parseSection('models')).toBe('models');
    expect(parseSection('nope')).toBeUndefined();
  });

  it('builds the CI command with the server and plan, never a token value', () => {
    const c = ciCommand({ server: 'https://s1p.example', plan: 'Nightly', env: 'prod' });
    expect(c).toContain('--plan "Nightly" --env prod');
    expect(c).toContain('--server https://s1p.example --token $S1P_TOKEN');
  });
});

describe('SettingsPage', () => {
  it('renders the nav in artboard order with the active section marked, and the integrations placeholders', async () => {
    renderPage('integrations');
    expect(await screen.findByRole('heading', { name: 'Settings', level: 1 })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    const links = within(nav).getAllByRole('link');
    expect(links).toHaveLength(9);
    expect(links[0]).toHaveTextContent('General');
    expect(links[2]).toHaveAttribute('aria-current', 'page');
    expect(links[4]).toHaveTextContent('team mode');
    expect(screen.getAllByText('Not connected')).toHaveLength(8);
    expect(screen.getByRole('button', { name: /Configure GitHub Actions/ })).toBeDisabled();
    expect(await screen.findByRole('region', { name: 'CLI command' })).toHaveTextContent('--server http://localhost');
    expect(screen.getByText('Available in team mode (Postgres + SSO)')).toBeInTheDocument();
  });

  it('shows the token once at creation and only the prefix afterwards', async () => {
    const user = userEvent.setup();
    let tokens: Array<Record<string, unknown>> = [];
    const { queryClient, fake } = renderPage('tokens', {
      'tokens.list': () => tokens,
      'tokens.create': (input) => {
        const i = input as { name: string; scopes: string[] };
        tokens = [{ id: 't1', name: i.name, prefix: 's1p_1a2b3c4d', scopes: i.scopes, createdAt: new Date().toISOString(), lastUsedAt: null, revokedAt: null }];
        return { token: TOKEN, record: tokens[0] };
      },
    });
    expect(await screen.findByText(/No API tokens yet/)).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Create API token' })[0] as HTMLElement);
    await user.type(await screen.findByLabelText('Name'), 'github-actions');
    await user.click(screen.getByRole('button', { name: 'Create token' }));

    expect(await screen.findByText(TOKEN)).toBeInTheDocument();
    expect(fake.calls.find((c) => c.path === 'tokens.create')?.input).toEqual({ name: 'github-actions', scopes: ['runs:write', 'results:read'] });

    await user.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByText(TOKEN)).not.toBeInTheDocument());
    expect(await screen.findByText('github-actions')).toBeInTheDocument();
    expect(screen.getByText('s1p_1a2b3c4d…')).toBeInTheDocument();
    // the plaintext token is not kept in the query / mutation cache
    const dump = JSON.stringify({
      q: queryClient.getQueryCache().getAll().map((q) => q.state.data),
      m: queryClient.getMutationCache().getAll().map((m) => [m.state.data, m.state.variables]),
    });
    expect(dump).not.toContain(TOKEN);
  });

  it('revokes a token after confirmation', async () => {
    const user = userEvent.setup();
    const { fake } = renderPage('tokens', {
      'tokens.list': () => [{ id: 't1', name: 'ci', prefix: 's1p_aaaaaaaa', scopes: ['results:read'], createdAt: '2026-10-01T00:00:00Z', lastUsedAt: null, revokedAt: null }],
      'tokens.revoke': () => ({ ok: true }),
    });
    await user.click(await screen.findByRole('button', { name: 'Revoke ci' }));
    await user.click(await screen.findByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(fake.calls.some((c) => c.path === 'tokens.revoke')).toBe(true));
    expect(fake.calls.find((c) => c.path === 'tokens.revoke')?.input).toEqual({ id: 't1' });
  });

  it('purges a project only after confirming', async () => {
    const user = userEvent.setup();
    const { fake } = renderPage('data', {
      'workspace.get': () => ({ name: 'W', timezone: 'UTC', retentionDays: 30, mode: 'local' }),
      'workspace.data': () => [{ key: 'SHOP', name: 'Storefront', retentionDays: 30, artifacts: 12 }],
      'workspace.purge': () => ({ removed: 12 }),
    });
    await user.click(await screen.findByRole('button', { name: 'Purge now SHOP' }));
    expect(fake.calls.some((c) => c.path === 'workspace.purge')).toBe(false);
    await user.click(await screen.findByRole('button', { name: 'Purge now' }));
    expect(await screen.findByText('Purged 12 artifacts of SHOP.')).toBeInTheDocument();
    expect(fake.calls.find((c) => c.path === 'workspace.purge')?.input).toEqual({ projectKey: 'SHOP' });
  });

  it('lists workers with their current job', async () => {
    renderPage('workers', {
      'workspace.workers': () => ({ configured: 2, workers: [{ id: 'worker-1', status: 'busy', jobId: 'j1', runId: 'r1' }, { id: 'worker-2', status: 'idle' }] }),
    });
    expect(await screen.findByText('worker-1')).toBeInTheDocument();
    expect(screen.getByText('job j1 · run r1')).toBeInTheDocument();
    expect(screen.getByText('Idle')).toBeInTheDocument();
  });
});
