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
    'notifications.channels.list': () => [],
    'notifications.rules.list': () => [],
    'notifications.log': () => [],
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
    expect(screen.getAllByText('Not connected')).toHaveLength(9);
    expect(await screen.findByRole('region', { name: 'CLI command' })).toHaveTextContent('--server http://localhost');
    expect(screen.getByText('Available in team mode (Postgres + SSO)')).toBeInTheDocument();
  });

  it('shows GitHub as connected after recent CI use and reveals the workflow snippet without a token value', async () => {
    const user = userEvent.setup();
    renderPage('integrations', {
      'tokens.ciUsage': () => ({
        github: { lastUsedAt: new Date().toISOString(), connected: true },
        gitlab: { lastUsedAt: null, connected: false },
        other: { lastUsedAt: null, connected: false },
      }),
    });
    expect(await screen.findByText('Connected')).toBeInTheDocument();
    expect(screen.getAllByText('Not connected')).toHaveLength(8);
    const buttons = screen.getAllByRole('button', { name: 'Configure' });
    await user.click(buttons[0] as HTMLElement);
    const snippet = await screen.findByRole('region', { name: 'GitHub Actions workflow' });
    expect(snippet).toHaveTextContent('s1pilot/run-action@v1');
    expect(snippet).toHaveTextContent('secrets.S1PILOT_TOKEN');
  });

  it('adds a Slack channel without echoing the secret back, tests it and lists the delivery log', async () => {
    const user = userEvent.setup();
    let channels: Array<Record<string, unknown>> = [];
    const { fake } = renderPage('notifications', {
      'notifications.channels.list': () => channels,
      'notifications.channels.save': (input) => {
        const i = input as { name: string };
        channels = [{ id: 'c1', name: i.name, kind: 'slack', config: {}, secretsSet: { webhookUrl: true, botToken: false } }];
        return channels[0];
      },
      'notifications.channels.test': () => ({ ok: true, attempts: 1 }),
      'notifications.log': () => [{ id: 'l1', at: '2026-10-09T10:00:00.000Z', channelId: 'c1', channelName: 'Slack #qa', event: 'run.finished', ok: false, attempts: 4, error: 'HTTP 500' }],
    });
    expect(await screen.findByText(/No channels yet/)).toBeInTheDocument();
    expect(await screen.findByText(/4 attempts: HTTP 500/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add channel' }));
    await user.type(await screen.findByLabelText('Name'), 'Slack #qa');
    await user.type(screen.getByLabelText('Incoming webhook URL'), 'https://hooks.slack.test/T/B/x');
    await user.click(screen.getByRole('button', { name: 'Save channel' }));
    expect(await screen.findByText('Slack #qa')).toBeInTheDocument();
    expect(fake.calls.find((c) => c.path === 'notifications.channels.save')?.input).toMatchObject({ config: { kind: 'slack', webhookUrl: 'https://hooks.slack.test/T/B/x' } });
    expect(document.body.textContent).not.toContain('hooks.slack.test');
    await user.click(screen.getByRole('button', { name: 'Send test to Slack #qa' }));
    expect(await screen.findByText('Test message delivered.')).toBeInTheDocument();
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

  it('warns on save that a pasted System 2 key is not stored, and never sends it', async () => {
    const user = userEvent.setup();
    const saved = {
      system1: { adapter: 'systemone', baseUrl: 'https://openrouter.ai/api/alpha/decisions', model: 'cloudflare/clef', apiKeyRef: 'env:OR_KEY' },
      system2: { adapter: 'openai-chat', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-haiku-4.5' },
      thresholds: { act: 0.8, pass: 0.8, fail: 0.2, escalate: 0.5 },
      dualOrderSensitive: true,
    };
    const { fake } = renderPage('models', {
      'models.getSettings': () => ({ scope: 'workspace', settings: saved, effective: saved, inheritsFromWorkspace: false }),
      'models.updateSettings': () => saved,
      'models.status': () => ({ system1: { configured: true, reachable: true }, system2: { configured: true, reachable: true } }),
    });
    await screen.findByDisplayValue('anthropic/claude-haiku-4.5');
    expect(screen.getByText(/Without a reference, S1PILOT_S2_API_KEY is used/)).toBeInTheDocument();
    const keyFields = screen.getAllByLabelText(/API key \(optional\)/);
    await user.type(keyFields[1] as HTMLElement, 'sk-or-pasted-key');
    await user.click(screen.getByRole('button', { name: 'Save model defaults' }));
    expect(await screen.findByText(/the pasted API key was not stored/)).toBeInTheDocument();
    const call = fake.calls.find((c) => c.path === 'models.updateSettings');
    expect(JSON.stringify(call?.input)).not.toContain('sk-or-pasted-key');
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

  it('deletes a project only after typing "delete"', async () => {
    const user = userEvent.setup();
    const { fake } = renderPage('data', {
      'workspace.get': () => ({ name: 'W', timezone: 'UTC', retentionDays: 30, mode: 'local' }),
      'workspace.data': () => [{ key: 'SHOP', name: 'Storefront', retentionDays: 30, artifacts: 12 }],
      'projects.delete': () => ({ deleted: true, key: 'SHOP' }),
    });
    await user.click(await screen.findByRole('button', { name: 'Delete project SHOP' }));
    const confirm = await screen.findByRole('button', { name: 'Delete project' });
    expect(confirm).toBeDisabled();
    const field = screen.getByLabelText('Type "delete" to confirm');
    await user.type(field, 'del');
    expect(confirm).toBeDisabled();
    await user.type(field, 'ete');
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(await screen.findByText('Deleted project SHOP.')).toBeInTheDocument();
    expect(fake.calls.find((c) => c.path === 'projects.delete')?.input).toEqual({ key: 'SHOP' });
  });

  it('lists workers with their current job', async () => {
    renderPage('workers', {
      'workspace.workers': () => ({ configured: 2, workers: [{ id: 'worker-1', status: 'busy', jobId: 'j1', runId: 'r1' }, { id: 'worker-2', status: 'idle' }] }),
    });
    expect(await screen.findByText('worker-1')).toBeInTheDocument();
    expect(screen.getByText('job j1 · run r1')).toBeInTheDocument();
    expect(screen.getByText('Idle')).toBeInTheDocument();
  });

  it('lists remote workers with labels, version, status, current job and last heartbeat', async () => {
    const beat = new Date(Date.now() - 5 * 60_000).toISOString();
    renderPage('workers', {
      'workspace.workers': () => ({
        configured: 0,
        workers: [],
        remote: [
          { id: 'rw-gpu1', name: 'gpu-box', labels: ['gpu', 'eu'], version: '1.2.3', concurrency: 2, status: 'busy', jobs: [{ jobId: 'j9', runId: 'r9' }], registeredAt: beat, lastHeartbeatAt: beat },
          { id: 'rw-old', name: 'rw-old', labels: [], version: '1.0.0', concurrency: 1, status: 'offline', jobs: [], registeredAt: beat, lastHeartbeatAt: beat },
        ],
      }),
    });
    expect(await screen.findByText('gpu-box')).toBeInTheDocument();
    expect(screen.getByText('gpu')).toBeInTheDocument();
    expect(screen.getByText('eu')).toBeInTheDocument();
    expect(screen.getByText('1.2.3')).toBeInTheDocument();
    expect(screen.getByText('job j9 · run r9')).toBeInTheDocument();
    expect(screen.getByText('Busy')).toBeInTheDocument();
    expect(screen.getByText('Offline')).toBeInTheDocument();
    expect(screen.getAllByText('Last heartbeat 5 min ago')).toHaveLength(2);
    expect(screen.getByText('1 online')).toBeInTheDocument();
  });

  it('explains how to start a remote worker when none registered', async () => {
    renderPage('workers', { 'workspace.workers': () => ({ configured: 1, workers: [], remote: [] }) });
    expect(await screen.findByText(/No remote workers have registered/)).toBeInTheDocument();
  });

  it('connects GitHub Issues with a write-only token and lists the connected tracker', async () => {
    const user = userEvent.setup();
    const list = [
      { provider: 'jira', connected: true, baseUrl: 'https://acme.atlassian.net', email: 'qa@acme.test', webhookEnabled: false, updatedAt: 't' },
      { provider: 'github', connected: false, baseUrl: null, email: null, webhookEnabled: false, updatedAt: null },
      { provider: 'linear', connected: false, baseUrl: null, email: null, webhookEnabled: false, updatedAt: null },
    ];
    const { fake } = renderPage('integrations', {
      'trackers.list': () => list,
      'trackers.test': () => ({ ok: true, detail: 'Signed in as quinn' }),
      'trackers.connect': () => ({ ...list[1], connected: true, detail: 'Signed in as quinn' }),
    });
    expect(await screen.findByRole('button', { name: 'Configure Jira' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Connect GitHub Issues' }));
    const token = await screen.findByLabelText('Personal access token');
    expect(token).toHaveAttribute('type', 'password');
    await user.type(token, 'ghp_secret');
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText('Signed in as quinn')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save connection' }));
    await waitFor(() => expect(fake.calls.find((c) => c.path === 'trackers.connect')?.input).toEqual({ provider: 'github', token: 'ghp_secret' }));
    expect(await screen.findByText('Connected. Signed in as quinn')).toBeInTheDocument();
    // The token is cleared from the form after saving.
    expect(screen.getByLabelText('Personal access token')).toHaveValue('');
  });
});
