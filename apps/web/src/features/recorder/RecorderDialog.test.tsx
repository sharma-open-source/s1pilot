import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RecorderDialog } from './RecorderDialog';

import { createFakeTrpc, FakeTrpcProvider, type FakeTrpc, type Handler } from '@/test/fake-trpc';

const STATUS = (over: Record<string, unknown> = {}) => ({
  sessionId: 's1',
  state: 'recording',
  actionCount: 3,
  fromStep: 0,
  stoppedFromBrowser: false,
  steps: [{ id: 'a1', action: "Fill 'Search products' with search_term, click 'Search'" }],
  ...over,
});

const DRAFT = {
  textSource: 'template',
  startUrl: 'http://x/shop',
  variables: [
    { key: 'search_term', value: 't-shirt', secret: false, field: 'Search products' },
    { key: 'password', secret: true, field: 'Password' },
  ],
  steps: [
    {
      id: 'a1',
      action: "Fill 'Search products' with search_term, click 'Search'",
      inputs: ['search_term'],
      actions: [
        { kind: 'fill', valueRef: 'var:search_term', locators: [], fingerprint: 'f', postFingerprint: 'f', navigated: false },
        { kind: 'fill', valueRef: 'secret:password', locators: [], fingerprint: 'f', postFingerprint: 'f', navigated: false },
      ],
    },
    { id: 'a2', action: "Click 'Classic Tee'", inputs: [], actions: [] },
  ],
};

function handlers(over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'environments.list': () => [{ id: 'e1', name: 'dev' }],
    'recorder.start': () => STATUS({ steps: [] }),
    'recorder.status': () => STATUS(),
    'recorder.pause': () => STATUS({ state: 'paused' }),
    'recorder.resume': () => STATUS(),
    'recorder.addExpectation': () => STATUS(),
    'recorder.stop': () => STATUS({ state: 'stopped', draft: DRAFT }),
    'recorder.cancel': () => ({ cancelled: true }),
    'recorder.save': () => ({ testCase: { key: 'SHOP-TC-9' }, learned: true, createdVariables: ['search_term'], missingSecrets: [] }),
    ...over,
  };
}

function setup(fake: FakeTrpc, props: Partial<Parameters<typeof RecorderDialog>[0]> = {}) {
  vi.stubGlobal('fetch', fake.fetch);
  const onSaved = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <FakeTrpcProvider fake={fake}>
      <RecorderDialog open onOpenChange={onOpenChange} projectKey="SHOP" pollMs={30} onSaved={onSaved} {...props} />
    </FakeTrpcProvider>,
  );
  return { onSaved, onOpenChange };
}

afterEach(() => vi.unstubAllGlobals());

describe('RecorderDialog', () => {
  it('starts a recording, shows captured steps live, adds an expected result and stops into the review', async () => {
    const user = userEvent.setup();
    const fake = createFakeTrpc(handlers());
    setup(fake, { suiteId: 'su1' });
    await waitFor(() => expect(screen.getByLabelText('Environment')).toHaveValue('e1'));
    await user.click(screen.getByRole('button', { name: 'Start recording' }));
    expect(await screen.findByText(/click 'Search'/)).toBeInTheDocument();
    expect(fake.calls.find((c) => c.path === 'recorder.start')?.input).toEqual({ projectKey: 'SHOP', environmentId: 'e1', suiteId: 'su1' });

    await user.type(screen.getByLabelText('Expected result'), 'Results are listed');
    await user.click(screen.getByRole('button', { name: 'Add expected result' }));
    await waitFor(() => expect(fake.calls.find((c) => c.path === 'recorder.addExpectation')?.input).toEqual({ sessionId: 's1', text: 'Results are listed' }));

    await user.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(fake.calls.some((c) => c.path === 'recorder.pause')).toBe(true));

    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(await screen.findByRole('heading', { name: 'Review recorded steps' })).toBeInTheDocument();
    expect(screen.getByLabelText('Step 1 action')).toHaveValue("Fill 'Search products' with search_term, click 'Search'");
  });

  it('lets the user edit text, remove a step and fill a secret, then saves without caching the secret', async () => {
    const user = userEvent.setup();
    const fake = createFakeTrpc(handlers());
    const { onSaved } = setup(fake);
    await waitFor(() => expect(screen.getByLabelText('Environment')).toHaveValue('e1'));
    await user.click(screen.getByRole('button', { name: 'Start recording' }));
    await user.click(await screen.findByRole('button', { name: 'Stop' }));
    await screen.findByRole('heading', { name: 'Review recorded steps' });

    await user.clear(screen.getByLabelText('Step 1 action'));
    await user.type(screen.getByLabelText('Step 1 action'), 'Search for a t-shirt');
    await user.type(screen.getByLabelText('Step 1 expected result'), 'Results are listed');
    await user.click(screen.getByRole('button', { name: 'Remove step 2' }));
    expect(screen.getByLabelText('Variable search_term')).toHaveValue('t-shirt');
    const secret = screen.getByLabelText('Secret password');
    expect(secret).toHaveAttribute('type', 'password');
    await user.type(secret, 'hunter2');
    await user.type(screen.getByLabelText('Test case title'), 'My recording');
    await user.click(screen.getByRole('button', { name: 'Save steps' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(fake.calls.find((c) => c.path === 'recorder.save')?.input).toEqual({
      sessionId: 's1',
      steps: [{ id: 'a1', action: 'Search for a t-shirt', expected: 'Results are listed' }],
      variables: { password: 'hunter2' },
      title: 'My recording',
    });
    // The secret is sent once and kept out of the query / mutation caches (it does not appear in any other call).
    expect(JSON.stringify(fake.calls.filter((c) => c.path !== 'recorder.save'))).not.toContain('hunter2');
  });

  it('goes to the review when the user presses Stop in the browser toolbar', async () => {
    const user = userEvent.setup();
    const fake = createFakeTrpc(handlers({ 'recorder.status': () => STATUS({ state: 'stopped', stoppedFromBrowser: true }) }));
    setup(fake);
    await waitFor(() => expect(screen.getByLabelText('Environment')).toHaveValue('e1'));
    await user.click(screen.getByRole('button', { name: 'Start recording' }));
    expect(await screen.findByRole('heading', { name: 'Review recorded steps' })).toBeInTheDocument();
  });

  it('warns that recording into an existing case starts paused and cancels on discard', async () => {
    const user = userEvent.setup();
    const fake = createFakeTrpc(handlers());
    const { onOpenChange } = setup(fake, { caseKey: 'SHOP-TC-1', fromStep: 2 });
    expect(screen.getByText(/starts paused/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Environment')).toHaveValue('e1'));
    await user.click(screen.getByRole('button', { name: 'Start recording' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel recording' }));
    await waitFor(() => expect(fake.calls.some((c) => c.path === 'recorder.cancel')).toBe(true));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(fake.calls.find((c) => c.path === 'recorder.start')?.input).toEqual({ projectKey: 'SHOP', environmentId: 'e1', caseKey: 'SHOP-TC-1', fromStep: 2 });
  });

  it('shows start errors', async () => {
    const user = userEvent.setup();
    const fake = createFakeTrpc(
      handlers({
        'recorder.start': () => {
          throw new Error('Recording opens a browser window and is only available in local mode');
        },
      }),
    );
    setup(fake);
    await waitFor(() => expect(screen.getByLabelText('Environment')).toHaveValue('e1'));
    await user.click(screen.getByRole('button', { name: 'Start recording' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('only available in local mode');
  });
});
