import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { CasesPage, learnedLabel, type CasesSearch } from './CasesPage';
import { fieldValue, setFieldTerm, splitTerms } from './query';

import { createFakeTrpc, FakeTrpcProvider, type FakeTrpc, type Handler } from '@/test/fake-trpc';

const mk = (n: number, over: Record<string, unknown> = {}) => ({
  id: `c${n}`,
  key: `SHOP-TC-${n}`,
  title: `Case ${n}`,
  priority: n % 2 === 0 ? 'P2' : 'P1',
  status: 'ready',
  tags: ['checkout'],
  owner: n === 1 ? 'Ann' : undefined,
  stepCount: 2,
  suitePath: [],
  learned: [{ environment: 'e1', environmentName: 'staging', status: 'current' }],
  lastResult: { runId: 'r1', verdict: 'passed', mode: 'replay', caseVersion: 1, durationMs: 5 },
  ...over,
});

const CASES = [mk(1), mk(2, { lastResult: null, learned: [{ environment: 'e1', environmentName: 'staging', status: 'none' }] }), mk(3), mk(4, { status: 'draft', tags: ['s2-generated'], lastResult: null, learned: [] })];

const TREE = {
  tree: [
    { id: 's1', name: 'Checkout', position: 0, caseCount: 1, totalCount: 3, children: [{ id: 's2', name: 'Guest', parentId: 's1', position: 0, caseCount: 2, totalCount: 2, children: [] }] },
  ],
  totalCases: 4,
  unsortedCases: 1,
};

function handlers(over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'cases.list': () => ({ items: CASES, total: 4, page: 1, pageSize: 25 }),
    'suites.tree': () => TREE,
    'syncStatus': () => ({ clean: true, changedFiles: [], conflicts: [] }),
    'projects.list': () => [{ key: 'SHOP', name: 'Storefront' }],
    'environments.list': () => [{ id: 'e1', name: 'staging', baseUrl: 'http://x' }],
    'cases.bulk': (i) => ({ action: (i as { action: string }).action, affected: 2, keys: [] }),
    'cases.create': () => ({ key: 'SHOP-TC-9' }),
    'runs.create': () => ({ id: 'run-7' }),
    ...over,
  };
}

function Host({ fake, onSearch, navigate, initial = {} }: { fake: FakeTrpc; onSearch?: (s: CasesSearch) => void; navigate?: (to: string) => void; initial?: CasesSearch }) {
  const [search, setSearch] = useState<CasesSearch>(initial);
  return (
    <FakeTrpcProvider fake={fake}>
      <CasesPage
        projectKey="SHOP"
        search={search}
        onSearch={(s) => {
          onSearch?.(s);
          setSearch(s);
        }}
        navigate={navigate ?? (() => undefined)}
      />
    </FakeTrpcProvider>
  );
}

afterEach(() => vi.unstubAllGlobals());

const callsTo = (fake: FakeTrpc, path: string) => fake.calls.filter((c) => c.path === path);

beforeAll(() => {
  // Radix primitives probe these in jsdom.
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => undefined;
  Element.prototype.releasePointerCapture ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
});

describe('query helpers', () => {
  it('replaces a field term and keeps the rest', () => {
    expect(setFieldTerm('tags:checkout priority=P1', 'priority', 'priority=P2')).toBe('tags:checkout priority=P2');
    expect(setFieldTerm('tags:checkout', 'owner', 'owner:"Ann Lee"')).toBe('tags:checkout owner:"Ann Lee"');
    expect(setFieldTerm('status:draft login', 'status', undefined)).toBe('login');
    expect(fieldValue('owner:"Ann Lee" x', 'owner')).toBe('Ann Lee');
    expect(splitTerms('a "b c" d')).toEqual(['a', '"b c"', 'd']);
  });

  it('labels the learned script state', () => {
    expect(learnedLabel({ status: 'ready', learned: [{ environmentId: 'e', environmentName: 'staging', status: 'current' }] })).toBe('Ready · staging');
    expect(learnedLabel({ status: 'ready', learned: [{ environmentId: 'e', environmentName: 'staging', status: 'needs-review' }] })).toBe('Healed · needs approval');
    expect(learnedLabel({ status: 'ready', learned: [{ environmentId: 'e', environmentName: 'staging', status: 'none' }] })).toBe('Not learned yet');
    expect(learnedLabel({ status: 'draft', learned: [] })).toBe('—');
  });
});

describe('CasesPage', () => {
  it('renders the wireframe sections with seeded cases', async () => {
    render(<Host fake={createFakeTrpc(handlers())} />);
    expect(await screen.findByText('SHOP-TC-1')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Test cases' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Record in browser' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Generate from story · S2' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'New test case' })).toBeEnabled();
    expect(screen.getByRole('complementary', { name: 'Suites' })).toBeInTheDocument();
    expect(await screen.findByText(/Synced with/)).toHaveTextContent('.s1pilot/ in git · clean');
    expect(screen.getByText('Showing 4 of 4')).toBeInTheDocument();
    expect(screen.getByText('Page 1 of 1')).toBeInTheDocument();
    expect(screen.getByText('generated by S2 · needs review')).toBeInTheDocument();
    expect(screen.getByText('Not learned yet')).toBeInTheDocument();
    expect(screen.getAllByText('Ready · staging').length).toBeGreaterThan(0);
    expect(screen.getByText('Ann')).toBeInTheDocument();
    expect(within(screen.getByRole('complementary', { name: 'Suites' })).getByText('Checkout')).toBeInTheDocument();
  });

  it('generates drafts from a story when System 2 is configured', async () => {
    const user = userEvent.setup();
    const fake = createFakeTrpc(
      handlers({
        'generate.status': () => ({ s2Configured: true, model: 'm' }),
        'requirements.list': () => [{ key: 'SHOP-REQ-1', title: 'Cart', caseKeys: [], coverage: 0 }],
        'generate.fromStory': () => ({ cases: [{ key: 'SHOP-TC-10' }, { key: 'SHOP-TC-11' }] }),
      }),
    );
    const navigate = vi.fn();
    render(<Host fake={fake} navigate={navigate} />);
    const button = await screen.findByRole('button', { name: 'Generate from story · S2' });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    const dialog = await screen.findByRole('dialog');
    const submit = within(dialog).getByRole('button', { name: 'Generate drafts' });
    expect(submit).toBeDisabled();
    await user.type(within(dialog).getByLabelText('User story or acceptance criteria'), 'As a shopper I can add to cart');
    await user.selectOptions(within(dialog).getByLabelText('Requirement (optional)'), 'SHOP-REQ-1');
    await user.selectOptions(within(dialog).getByLabelText('Number of test cases'), '5');
    await user.click(submit);
    await waitFor(() => expect(callsTo(fake, 'generate.fromStory')).toHaveLength(1));
    expect(callsTo(fake, 'generate.fromStory')[0]?.input).toEqual({ projectKey: 'SHOP', storyText: 'As a shopper I can add to cart', count: 5, requirementKey: 'SHOP-REQ-1' });
    expect(await within(dialog).findByText(/2 draft test cases were added to the review queue/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Review drafts' }));
    expect(navigate).toHaveBeenCalledWith('/p/SHOP/review?tab=drafts');
  });

  it('disables generation with a tooltip when System 2 is missing', async () => {
    const fake = createFakeTrpc(handlers({ 'generate.status': () => ({ s2Configured: false, model: null }) }));
    render(<Host fake={fake} />);
    const button = await screen.findByRole('button', { name: 'Generate from story · S2' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', expect.stringContaining('System 2'));
  });

  it('debounces the filter into the URL and sends it to cases.list', async () => {
    const user = userEvent.setup();
    const fake = createFakeTrpc(handlers());
    const onSearch = vi.fn();
    render(<Host fake={fake} onSearch={onSearch} />);
    await screen.findByText('SHOP-TC-1');
    await user.type(screen.getByLabelText('Filter'), 'tags:checkout');
    await waitFor(() => expect(onSearch).toHaveBeenCalledWith({ q: 'tags:checkout' }));
    expect(onSearch).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(callsTo(fake, 'cases.list').some((c) => (c.input as { query?: string }).query === 'tags:checkout')).toBe(true));
  });

  it('appends dropdown terms to the query', async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn();
    render(<Host fake={createFakeTrpc(handlers())} onSearch={onSearch} initial={{ q: 'tags:checkout' }} />);
    await screen.findByText('SHOP-TC-1');
    await user.click(screen.getByRole('button', { name: /^Priority/ }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'P1' }));
    expect(onSearch).toHaveBeenLastCalledWith({ q: 'tags:checkout priority=P1' });
    expect(screen.getByLabelText('Filter')).toHaveValue('tags:checkout priority=P1');
  });

  it('restores the filter input when the URL changes (back/forward)', async () => {
    const user = userEvent.setup();
    function Controlled() {
      const [search, setSearch] = useState<CasesSearch>({ q: 'one' });
      return (
        <FakeTrpcProvider fake={createFakeTrpc(handlers())}>
          <button onClick={() => setSearch({ q: 'two', suite: 's1' })}>back</button>
          <CasesPage projectKey="SHOP" search={search} onSearch={setSearch} navigate={() => undefined} />
        </FakeTrpcProvider>
      );
    }
    render(<Controlled />);
    expect(screen.getByLabelText('Filter')).toHaveValue('one');
    await user.click(screen.getByRole('button', { name: 'back' }));
    expect(screen.getByLabelText('Filter')).toHaveValue('two');
  });

  it('selects with the keyboard (arrows move, space toggles) and shows the count', async () => {
    const user = userEvent.setup();
    render(<Host fake={createFakeTrpc(handlers())} />);
    await screen.findByText('SHOP-TC-1');
    expect(screen.getByRole('button', { name: 'Run now' })).toBeDisabled();
    screen.getByLabelText('Select SHOP-TC-1').focus();
    await user.keyboard(' ');
    await user.keyboard('{ArrowDown}');
    expect(screen.getByLabelText('Select SHOP-TC-2')).toHaveFocus();
    await user.keyboard('{ArrowDown} ');
    expect(screen.getByLabelText('Select SHOP-TC-3')).toBeChecked();
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(screen.getByLabelText('Select SHOP-TC-1')).toHaveFocus();
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run now' })).toBeEnabled();
    expect(screen.getByLabelText('Select SHOP-TC-1').closest('tr')).toHaveClass('bg-surface-selected');
  });

  it('bulk moves and tags the selected cases', async () => {
    const user = userEvent.setup();
    const fake = createFakeTrpc(handlers());
    render(<Host fake={fake} />);
    await screen.findByText('SHOP-TC-1');
    await user.click(screen.getByLabelText('Select SHOP-TC-1'));
    await user.click(screen.getByLabelText('Select SHOP-TC-3'));

    await user.click(screen.getByRole('button', { name: 'Move' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Guest' }));
    await waitFor(() => expect(callsTo(fake, 'cases.bulk')).toHaveLength(1));
    expect(callsTo(fake, 'cases.bulk')[0]?.input).toEqual({ ids: ['c1', 'c3'], action: 'move', suiteId: 's2' });
    expect(await screen.findByText('Moved 2 cases to Guest')).toBeInTheDocument();
    expect(screen.getByLabelText('Select SHOP-TC-1')).not.toBeChecked();

    await user.click(screen.getByLabelText('Select SHOP-TC-2'));
    await user.click(screen.getByLabelText('Select SHOP-TC-3'));
    await user.click(screen.getByRole('button', { name: 'Tag' }));
    await user.type(await screen.findByLabelText('Add tags'), 'smoke, pricing');
    await user.type(screen.getByLabelText('Remove tags'), 'old');
    await user.click(screen.getByRole('button', { name: 'Apply tags' }));
    await waitFor(() => expect(callsTo(fake, 'cases.bulk')).toHaveLength(2));
    expect(callsTo(fake, 'cases.bulk')[1]?.input).toEqual({ ids: ['c2', 'c3'], action: 'tag', add: ['smoke', 'pricing'], remove: ['old'] });
  });

  it('Run now opens the launcher and navigates to the live run', async () => {
    const user = userEvent.setup();
    const fake = createFakeTrpc(handlers());
    vi.stubGlobal('fetch', fake.fetch); // the untyped client resolves fetch late
    const navigate = vi.fn();
    render(<Host fake={fake} navigate={navigate} />);
    await screen.findByText('SHOP-TC-1');
    await user.click(screen.getByLabelText('Select SHOP-TC-1'));
    await user.click(screen.getByRole('button', { name: 'Run now' }));
    const dialog = await screen.findByRole('dialog', { name: 'Run now' });
    await waitFor(() => expect(within(dialog).getByLabelText('Environment')).toHaveValue('e1'));
    await user.selectOptions(within(dialog).getByLabelText('Mode'), 'explore');
    await user.click(within(dialog).getByRole('button', { name: 'Start run' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/p/SHOP/runs/run-7/live'));
    expect(callsTo(fake, 'runs.create')[0]?.input).toEqual({
      projectKey: 'SHOP',
      caseKeys: ['SHOP-TC-1'],
      environment: 'e1',
      browser: 'chromium',
      mode: 'explore',
      attended: false,
    });
  });

  it('New test case creates a draft in the current suite and opens the editor', async () => {
    const user = userEvent.setup();
    const fake = createFakeTrpc(handlers());
    const navigate = vi.fn();
    render(<Host fake={fake} navigate={navigate} initial={{ suite: 's2' }} />);
    await screen.findByText('SHOP-TC-1');
    await user.click(screen.getByRole('button', { name: 'New test case' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/p/SHOP/cases/SHOP-TC-9'));
    expect(callsTo(fake, 'cases.create')[0]?.input).toMatchObject({ projectKey: 'SHOP', status: 'draft', suiteId: 's2' });
  });

  it('adds, renames and deletes suites from the tree', async () => {
    const user = userEvent.setup();
    const fake = createFakeTrpc(
      handlers({
        'suites.create': () => ({ id: 's9' }),
        'suites.rename': () => ({ id: 's1' }),
        'suites.delete': () => ({ deleted: true, id: 's1', movedCases: 3 }),
      }),
    );
    render(<Host fake={fake} />);
    await screen.findByText('SHOP-TC-1');
    await user.click(screen.getByRole('button', { name: 'Add suite' }));
    await user.type(screen.getByLabelText('New suite name'), 'Account{Enter}');
    await waitFor(() => expect(callsTo(fake, 'suites.create')[0]?.input).toEqual({ projectKey: 'SHOP', name: 'Account' }));

    await user.click(screen.getByRole('button', { name: 'Actions for Checkout' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const input = screen.getByLabelText('Name for Checkout');
    await user.clear(input);
    await user.type(input, 'Payment{Enter}');
    await waitFor(() => expect(callsTo(fake, 'suites.rename')[0]?.input).toEqual({ id: 's1', name: 'Payment' }));

    await user.click(screen.getByRole('button', { name: 'Actions for Checkout' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await user.click(await screen.findByRole('button', { name: 'Delete suite' }));
    await waitFor(() => expect(callsTo(fake, 'suites.delete')[0]?.input).toEqual({ id: 's1', moveCasesTo: null }));
  });

  it('shows the server error for an invalid query and an empty state', async () => {
    const fake = createFakeTrpc(
      handlers({
        'cases.list': () => {
          throw new Error('OR is not supported yet');
        },
      }),
    );
    render(<Host fake={fake} initial={{ q: 'a OR b' }} />);
    expect(await screen.findByText('OR is not supported yet')).toBeInTheDocument();
  });

  it('shows an empty state with a clear action when nothing matches', async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn();
    render(<Host fake={createFakeTrpc(handlers({ 'cases.list': () => ({ items: [], total: 0, page: 1, pageSize: 25 }) }))} initial={{ q: 'zzz' }} onSearch={onSearch} />);
    expect(await screen.findByText('No test cases match this filter.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(onSearch).toHaveBeenLastCalledWith({});
  });
});
