import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeAll, describe, expect, it } from 'vitest';

import { RequirementsPage } from './RequirementsPage';

import { createQueryClient, createTrpcClient, trpc } from '@/lib/trpc';
import { createFakeTrpc, FakeTrpcError, type FakeTrpc, type Handler } from '@/test/fake-trpc';

interface Req {
  id: string;
  projectId: string;
  key: string;
  title: string;
  description?: string;
  caseIds: string[];
}

const CASES = [
  { id: 'c1', key: 'SHOP-TC-1', title: 'Guest checkout', priority: 'P1', status: 'ready', tags: [] },
  { id: 'c2', key: 'SHOP-TC-2', title: 'Member checkout', priority: 'P2', status: 'ready', tags: [] },
];

function setup(initial: Req[], over: Record<string, Handler> = {}): { fake: FakeTrpc; store: { reqs: Req[] } } {
  const store = { reqs: [...initial] };
  const fake = createFakeTrpc({
    'requirements.list': () =>
      store.reqs.map((r) => {
        const covering = CASES.filter((c) => r.caseIds.includes(c.id));
        return { ...r, caseKeys: covering.map((c) => c.key), coveringCaseIds: covering.map((c) => c.id), coverage: covering.length };
      }),
    'requirements.create': (input) => {
      const i = input as { key?: string; title: string; description?: string };
      const key = i.key ?? `SHOP-REQ-${store.reqs.length + 1}`;
      if (store.reqs.some((r) => r.key === key)) throw new FakeTrpcError(`Requirement ${key} already exists`, 'CONFLICT');
      const r: Req = { id: `r${store.reqs.length + 1}`, projectId: 'p1', key, title: i.title, ...(i.description ? { description: i.description } : {}), caseIds: [] };
      store.reqs.push(r);
      return r;
    },
    'requirements.update': (input) => {
      const i = input as { key: string; patch: { title?: string; description?: string } };
      const r = store.reqs.find((x) => x.key === i.key) as Req;
      Object.assign(r, i.patch.title ? { title: i.patch.title } : {}, i.patch.description !== undefined ? { description: i.patch.description } : {});
      return r;
    },
    'requirements.setCases': (input) => {
      const i = input as { key: string; caseIds: string[] };
      const r = store.reqs.find((x) => x.key === i.key) as Req;
      const added = i.caseIds.filter((id) => !r.caseIds.includes(id)).length;
      const removed = r.caseIds.filter((id) => !i.caseIds.includes(id)).length;
      r.caseIds = [...i.caseIds];
      return { key: r.key, added, removed };
    },
    'requirements.delete': (input) => {
      const i = input as { key: string };
      store.reqs = store.reqs.filter((r) => r.key !== i.key);
      return { key: i.key, unlinked: 0 };
    },
    'cases.list': () => ({ items: CASES, total: CASES.length }),
    ...over,
  });
  const queryClient = createQueryClient();
  const client = createTrpcClient(fake.fetch);
  const root = createRootRoute();
  const route = createRoute({ getParentRoute: () => root, path: '/p/$key/library/requirements', component: () => <RequirementsPage projectKey="SHOP" /> });
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ['/p/SHOP/library/requirements'] }) });
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
  return { fake, store };
}

const calls = (fake: FakeTrpc, path: string) => fake.calls.filter((c) => c.path === path);

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => undefined;
  Element.prototype.releasePointerCapture ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
});

describe('RequirementsPage', () => {
  it('creates the first requirement from the empty state', async () => {
    const user = userEvent.setup();
    const { fake } = setup([]);
    expect(await screen.findByText(/No requirements yet/)).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'New requirement' })[0] as HTMLElement);
    const dialog = await screen.findByRole('dialog', { name: 'New requirement' });
    await user.click(within(dialog).getByRole('button', { name: 'Create requirement' }));
    expect(within(dialog).getByText('Enter a title')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Title'), 'Guest can check out');
    await user.type(within(dialog).getByLabelText('Description (optional)'), 'No account needed');
    await user.click(within(dialog).getByRole('button', { name: 'Create requirement' }));
    await waitFor(() => expect(calls(fake, 'requirements.create')[0]?.input).toEqual({ projectKey: 'SHOP', title: 'Guest can check out', description: 'No account needed' }));
    expect(await screen.findByText(/Created SHOP-REQ-1/)).toBeInTheDocument();
    const row = (await screen.findByText('Guest can check out')).closest('tr') as HTMLElement;
    expect(within(row).getByText('Not covered', { selector: 'span.rounded-pill' })).toBeInTheDocument();
  });

  it('shows a duplicate-key error in the dialog', async () => {
    const user = userEvent.setup();
    setup([{ id: 'r1', projectId: 'p1', key: 'AUTH-1', title: 'Login', caseIds: [] }]);
    await screen.findByText('Login');
    await user.click(screen.getByRole('button', { name: 'New requirement' }));
    const dialog = await screen.findByRole('dialog', { name: 'New requirement' });
    await user.type(within(dialog).getByLabelText('Title'), 'Again');
    await user.type(within(dialog).getByLabelText('Key (optional)'), 'AUTH-1');
    await user.click(within(dialog).getByRole('button', { name: 'Create requirement' }));
    expect(await within(dialog).findByText(/AUTH-1 already exists/)).toBeInTheDocument();
  });

  it('links covering cases through the picker, preselecting the current ones', async () => {
    const user = userEvent.setup();
    const { fake } = setup([{ id: 'r1', projectId: 'p1', key: 'SHOP-REQ-1', title: 'Checkout', caseIds: ['c1'] }]);
    const row = (await screen.findByText('Checkout')).closest('tr') as HTMLElement;
    expect(within(row).getByRole('link', { name: 'SHOP-TC-1' })).toHaveAttribute('href', '/p/SHOP/cases/SHOP-TC-1');
    await user.click(within(row).getByRole('button', { name: 'Link cases to SHOP-REQ-1' }));
    const dialog = await screen.findByRole('dialog', { name: 'Pick test cases' });
    expect(within(dialog).getByText(/cover SHOP-REQ-1 · Checkout/)).toBeInTheDocument();
    expect(await within(dialog).findByLabelText('Pick SHOP-TC-1')).toBeChecked();
    await user.click(within(dialog).getByLabelText('Pick SHOP-TC-2'));
    await user.click(within(dialog).getByRole('button', { name: 'Link 2 cases' }));
    await waitFor(() => expect(calls(fake, 'requirements.setCases')[0]?.input).toEqual({ projectKey: 'SHOP', key: 'SHOP-REQ-1', caseIds: ['c1', 'c2'] }));
    expect(await screen.findByText('SHOP-REQ-1: 1 linked, 0 unlinked')).toBeInTheDocument();
    expect(await screen.findByText('2 cases')).toBeInTheDocument();
  });

  it('edits the title (not the key) and deletes after confirmation', async () => {
    const user = userEvent.setup();
    const { fake } = setup([{ id: 'r1', projectId: 'p1', key: 'SHOP-REQ-1', title: 'Checkout', caseIds: ['c1'] }]);
    await user.click(await screen.findByRole('button', { name: 'Edit SHOP-REQ-1' }));
    const edit = await screen.findByRole('dialog', { name: 'Edit SHOP-REQ-1' });
    expect(within(edit).queryByLabelText('Key (optional)')).toBeNull();
    const title = within(edit).getByLabelText('Title');
    await user.clear(title);
    await user.type(title, 'Guest checkout');
    await user.click(within(edit).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls(fake, 'requirements.update')[0]?.input).toMatchObject({ key: 'SHOP-REQ-1', patch: { title: 'Guest checkout' } }));
    expect(await screen.findByText('Guest checkout')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Delete SHOP-REQ-1' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete SHOP-REQ-1?' });
    expect(within(confirm).getByText(/removed from the 1 test case that cover it/)).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Delete requirement' }));
    await waitFor(() => expect(calls(fake, 'requirements.delete')[0]?.input).toEqual({ projectKey: 'SHOP', key: 'SHOP-REQ-1' }));
    expect(await screen.findByText(/No requirements yet/)).toBeInTheDocument();
  });

  it('filters by key, title or description and counts uncovered requirements', async () => {
    const user = userEvent.setup();
    setup([
      { id: 'r1', projectId: 'p1', key: 'SHOP-REQ-1', title: 'Checkout', caseIds: ['c1'] },
      { id: 'r2', projectId: 'p1', key: 'SHOP-REQ-2', title: 'Coupons', description: 'Percentage and flat discounts', caseIds: [] },
    ]);
    expect(await screen.findByText('2 requirements · 1 not covered')).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText('Key, title or description'), 'flat');
    expect(screen.queryByText('Checkout')).toBeNull();
    expect(screen.getByText('Coupons')).toBeInTheDocument();
    await user.clear(screen.getByPlaceholderText('Key, title or description'));
    await user.type(screen.getByPlaceholderText('Key, title or description'), 'zzz');
    expect(screen.getByText(/No requirement matches/)).toBeInTheDocument();
  });
});
