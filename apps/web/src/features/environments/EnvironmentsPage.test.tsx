import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeAll, describe, expect, it } from 'vitest';

import { EnvironmentsPage } from './EnvironmentsPage';

import { createQueryClient, createTrpcClient, trpc } from '@/lib/trpc';
import { createFakeTrpc, FakeTrpcError, type FakeTrpc, type Handler } from '@/test/fake-trpc';

const SECRET = 'hunter2-s3cret';

function makeEnv(over: Record<string, unknown> = {}) {
  return {
    id: 'env-stg',
    projectId: 'p1',
    name: 'staging',
    baseUrl: 'https://staging.shop.example',
    variables: [
      { key: 'shipping_zip', secret: false, value: '560001', source: 'inline' },
      { key: 'customer_password', secret: true, masked: true, source: 'inline' },
      { key: 'test_card', secret: true, masked: true, source: 'env', envVar: 'S1P_TEST_CARD' },
    ],
    allowDomains: ['staging.shop.example'],
    browsers: [{ browser: 'chromium' }],
    readOnly: false,
    requireApprovalFor: ['pay', 'delete', 'send'],
    locale: 'en-US',
    timezone: 'UTC',
    ...over,
  };
}

const ENVS = [makeEnv({ id: 'env-dev', name: 'dev' }), makeEnv(), makeEnv({ id: 'env-prod', name: 'prod', readOnly: true })];

interface Ctx {
  fake: FakeTrpc;
  queryClient: QueryClient;
}

function renderPage(over: Record<string, Handler> = {}, envName = 'staging'): Ctx {
  const fake = createFakeTrpc({
    'environments.list': () => ENVS,
    'projects.list': () => [{ key: 'SHOP', name: 'Storefront', counts: { cases: 1, environments: 3 }, lastRun: null, s1Model: null, status: 'none' }],
    'auth.list': () => [
      { id: 'a1', environmentId: 'env-stg', name: 'login-as-customer', kind: 'recorded', hasState: true, status: 'valid', lastRefreshedAt: new Date(Date.now() - 300_000).toISOString() },
      { id: 'a2', environmentId: 'env-stg', name: 'login-as-admin', kind: 'flow', flowId: 'admin-login', hasState: false, status: 'expired' },
    ],
    ...over,
  });
  const queryClient = createQueryClient();
  const client = createTrpcClient(fake.fetch);
  const root = createRootRoute();
  const route = createRoute({ getParentRoute: () => root, path: '/p/$key/environments/$env', component: () => <EnvironmentsPage projectKey="SHOP" envName={envName} /> });
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: [`/p/SHOP/environments/${envName}`] }) });
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

const calls = (fake: FakeTrpc, path: string) => fake.calls.filter((c) => c.path === path);

describe('EnvironmentsPage', () => {
  it('renders tabs, masked secrets and login statuses', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Environments', level: 1 })).toBeInTheDocument();
    const tabs = await screen.findByRole('navigation', { name: 'Environment' });
    expect(within(tabs).getByText('read-only')).toBeInTheDocument();
    expect(within(tabs).getByRole('link', { name: 'staging' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getAllByText('Key name only')).toHaveLength(2);
    expect(screen.getByText('Key + value')).toBeInTheDocument();
    expect(screen.getByText('••••••••••')).toBeInTheDocument();
    expect(await screen.findByText('Valid')).toBeInTheDocument();
    expect(screen.getByText('Expired')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  it('does not keep a revealed secret in the query or mutation cache after re-mask', async () => {
    const user = userEvent.setup();
    const { queryClient, fake } = renderPage({ 'environments.revealSecret': () => ({ key: 'customer_password', value: SECRET }) });
    await user.click(await screen.findByRole('button', { name: 'Reveal customer_password' }));
    const shown = await screen.findByLabelText('customer_password value');
    expect(shown).toHaveValue(SECRET);
    expect(calls(fake, 'environments.revealSecret')[0]?.input).toEqual({ envId: 'env-stg', key: 'customer_password' });
    await user.click(screen.getByRole('button', { name: 'Hide' }));
    await waitFor(() => expect(screen.queryByLabelText('customer_password value')).not.toBeInTheDocument());
    expect(screen.queryByDisplayValue(SECRET)).not.toBeInTheDocument();
    const dump = JSON.stringify({
      q: queryClient.getQueryCache().getAll().map((q) => q.state.data),
      m: queryClient.getMutationCache().getAll().map((m) => [m.state.data, m.state.variables]),
    });
    expect(dump).not.toContain(SECRET);
  });

  it('re-masks on blur and shows a reveal error', async () => {
    const user = userEvent.setup();
    renderPage({ 'environments.revealSecret': () => ({ key: 'customer_password', value: SECRET }) });
    await user.click(await screen.findByRole('button', { name: 'Reveal customer_password' }));
    await screen.findByLabelText('customer_password value');
    await user.click(screen.getByLabelText('Base URL'));
    await waitFor(() => expect(screen.queryByDisplayValue(SECRET)).not.toBeInTheDocument());
  });

  it('shows the server error when a reveal is refused', async () => {
    const user = userEvent.setup();
    renderPage({
      'environments.revealSecret': () => {
        throw new FakeTrpcError('Only admins and leads can reveal secrets', 'FORBIDDEN');
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Reveal customer_password' }));
    expect(await screen.findByText('Only admins and leads can reveal secrets')).toBeInTheDocument();
  });

  it('saves only the changed fields and validates inline', async () => {
    const user = userEvent.setup();
    const { fake } = renderPage({ 'environments.update': (i) => ({ ...makeEnv(), ...(i as { patch: object }).patch }) });
    const url = await screen.findByLabelText('Base URL');
    await user.clear(url);
    await user.type(url, 'not a url');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(/Enter a valid URL/)).toBeInTheDocument();
    expect(calls(fake, 'environments.update')).toHaveLength(0);

    await user.clear(url);
    await user.type(url, 'https://staging2.shop.example');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls(fake, 'environments.update')).toHaveLength(1));
    expect(calls(fake, 'environments.update')[0]?.input).toEqual({ id: 'env-stg', patch: { baseUrl: 'https://staging2.shop.example' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled());
  });

  it('turns allowed domains into chips on blur', async () => {
    const user = userEvent.setup();
    renderPage();
    const field = await screen.findByLabelText('Allowed domains');
    await user.type(field, 'pay.sandbox.example, cdn.shop.example');
    await user.tab();
    const list = screen.getByRole('list', { name: 'Allowed domain list' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
  });

  it('adds a secret variable and sends its value only on save', async () => {
    const user = userEvent.setup();
    const { fake } = renderPage({ 'environments.update': () => makeEnv() });
    await user.click(await screen.findByRole('button', { name: '+ Add' }));
    await user.type(screen.getByLabelText('New variable key'), 'api_token');
    await user.selectOptions(screen.getByLabelText('Type for api_token'), 'secret-encrypted');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Secret value is required')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Value for api_token'), 'tok-123');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls(fake, 'environments.update')).toHaveLength(1));
    const patch = (calls(fake, 'environments.update')[0]?.input as { patch: { variables: Array<Record<string, unknown>>; baseUrl?: string } }).patch;
    expect(Object.keys(patch)).toEqual(['variables']);
    expect(patch.variables.find((v) => v['key'] === 'api_token')).toEqual({ key: 'api_token', secret: true, source: 'inline', value: 'tok-123' });
    // existing secrets are sent without a value so the server keeps theirs
    expect(patch.variables.find((v) => v['key'] === 'customer_password')).toEqual({ key: 'customer_password', secret: true, source: 'inline' });
  });

  it('requires a validation page and check to record a login, then marks it valid', async () => {
    const user = userEvent.setup();
    let status = 'never';
    const { fake } = renderPage({
      'auth.list': () => [{ id: 'a1', environmentId: 'env-stg', name: 'login-as-customer', kind: 'recorded', hasState: status === 'valid', status, ...(status === 'valid' ? { lastRefreshedAt: new Date().toISOString() } : {}) }],
      'auth.record': () => ({ id: 'a1', recording: true }),
      'auth.finishRecording': () => {
        status = 'valid';
        return { id: 'a1', status };
      },
    });
    expect(await screen.findByText('Not recorded')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Record a login' }));
    const dialog = await screen.findByRole('dialog');
    await user.clear(within(dialog).getByLabelText('Validation page'));
    await user.click(within(dialog).getByRole('button', { name: 'Open browser' }));
    expect(await within(dialog).findByText('Validation page is required')).toBeInTheDocument();
    expect(within(dialog).getByText('Assertion text is required')).toBeInTheDocument();
    expect(calls(fake, 'auth.record')).toHaveLength(0);

    await user.type(within(dialog).getByLabelText('Validation page'), '/account');
    await user.type(within(dialog).getByLabelText('Check value'), 'Sign out');
    await user.click(within(dialog).getByRole('button', { name: 'Open browser' }));
    expect(await within(dialog).findByText(/A browser window is open/)).toBeInTheDocument();
    expect(calls(fake, 'auth.record')[0]?.input).toEqual({
      environmentId: 'env-stg',
      name: 'login-as-customer',
      validation: { url: '/account', assertion: { kind: 'text-visible', value: 'Sign out' } },
    });
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText('Valid')).toBeInTheDocument();
  });

  it('refreshes all logins', async () => {
    const user = userEvent.setup();
    const { fake } = renderPage({ 'auth.refresh': () => ({ status: 'valid' }) });
    await screen.findByText('Valid');
    await user.click(screen.getByRole('button', { name: 'Refresh now' }));
    expect(await screen.findByText('Logins refreshed')).toBeInTheDocument();
    expect(calls(fake, 'auth.refresh').map((c) => c.input)).toEqual([{ id: 'a1' }, { id: 'a2' }]);
  });

  it('previews the first 20 rows of an uploaded CSV before uploading', async () => {
    const user = userEvent.setup();
    renderPage();
    const csv = ['zip,city', ...Array.from({ length: 30 }, (_, i) => `${560000 + i},City ${i}`)].join('\n');
    await user.upload(await screen.findByLabelText('Choose a CSV or JSON file'), new File([csv], 'addresses.csv', { type: 'text/csv' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/30 rows, 2 columns. Showing the first 20/)).toBeInTheDocument();
    expect(within(dialog).getAllByRole('row')).toHaveLength(21);
  });
});
