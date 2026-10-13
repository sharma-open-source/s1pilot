import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WizardStep } from './model';
import { ProjectWizard } from './ProjectWizard';

import {
  createFakeTrpc,
  FakeTrpcError,
  FakeTrpcProvider,
  type FakeTrpc,
  type Handler,
} from '@/test/fake-trpc';

const CAPS = {
  maxOptions: 8,
  multiQuestionPerCall: true,
  supportsImages: true,
  maxContextTokens: 32768,
  orderSensitive: false,
};
const probeOk = (over: Record<string, unknown> = {}) => ({
  ok: true,
  adapter: 'systemone',
  model: 'clef-flash',
  capabilities: CAPS,
  latencyMs: { p50: 142, samples: [142] },
  isCloud: false,
  warnings: [],
  ...over,
});

function baseHandlers(): Record<string, Handler> {
  return {
    'projects.create': (i) => ({ key: (i as { key: string }).key }),
    'projects.update': () => ({}),
    'environments.list': () => [{ id: 'e1', name: 'dev', baseUrl: 'http://127.0.0.1:4400/shop' }],
    'environments.create': (i) => ({ id: 'e2', ...(i as object) }),
    'environments.update': () => ({}),
    'environments.delete': () => ({}),
    'models.probe': () => probeOk(),
    'models.updateSettings': () => ({}),
    'models.status': () => ({
      system1: { configured: false, reachable: false },
      system2: { configured: false, reachable: false },
    }),
    'cases.create': () => ({ key: 'SHOP-TC-1' }),
    'runs.create': () => ({ id: 'r1' }),
  };
}

function Host({
  fake,
  initial = 'basics',
  onFinish,
  projectKey,
}: {
  fake: FakeTrpc;
  initial?: WizardStep;
  onFinish?: (to: string) => void;
  projectKey?: string;
}) {
  const [step, setStep] = useState<WizardStep>(initial);
  return (
    <FakeTrpcProvider fake={fake}>
      <ProjectWizard
        {...(projectKey ? { projectKey } : {})}
        step={step}
        onStepChange={setStep}
        onExit={() => undefined}
        onFinish={onFinish ?? (() => undefined)}
      />
    </FakeTrpcProvider>
  );
}

function seedDraft(extra: Record<string, unknown> = {}) {
  window.sessionStorage.setItem(
    's1pilot.wizard.draft',
    JSON.stringify({
      createdKey: 'SHOP',
      basics: {
        name: 'Shop',
        key: 'SHOP',
        baseUrl: 'http://127.0.0.1:4400/shop',
        keyTouched: true,
      },
      ...extra,
    }),
  );
}

const callsTo = (fake: FakeTrpc, path: string) => fake.calls.filter((c) => c.path === path);

beforeEach(() => {
  window.sessionStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe('Basics step', () => {
  it('derives the key from the name, validates, and creates the project', async () => {
    const user = userEvent.setup();
    const fake = createFakeTrpc(baseHandlers());
    render(<Host fake={fake} />);

    await user.type(screen.getByLabelText('Project name'), 'Storefront');
    expect(screen.getByLabelText('Project key')).toHaveValue('STOREFRONT');
    await user.clear(screen.getByLabelText('Project key'));
    await user.type(screen.getByLabelText('Project key'), 'shop');
    expect(screen.getByLabelText('Project key')).toHaveValue('SHOP');

    await user.click(screen.getByRole('button', { name: 'Continue to environments' }));
    expect(
      await screen.findByText('Enter a full URL, for example https://shop.example.com'),
    ).toBeInTheDocument();
    expect(callsTo(fake, 'projects.create')).toHaveLength(0);

    await user.type(screen.getByLabelText('Base URL'), 'http://127.0.0.1:4400/shop');
    await user.click(screen.getByRole('button', { name: 'Continue to environments' }));
    expect(await screen.findByRole('heading', { name: 'Environments' })).toBeInTheDocument();
    expect(callsTo(fake, 'projects.create')[0]?.input).toEqual({
      name: 'Storefront',
      key: 'SHOP',
      baseUrl: 'http://127.0.0.1:4400/shop',
    });
    expect(
      JSON.parse(window.sessionStorage.getItem('s1pilot.wizard.draft') ?? '{}').createdKey,
    ).toBe('SHOP');
  });

  it('shows an error when the key already exists', async () => {
    const user = userEvent.setup();
    const fake = createFakeTrpc({
      ...baseHandlers(),
      'projects.create': () => {
        throw new FakeTrpcError('exists', 'CONFLICT');
      },
    });
    render(<Host fake={fake} />);
    await user.type(screen.getByLabelText('Project name'), 'Shop');
    await user.type(screen.getByLabelText('Base URL'), 'http://x.test');
    await user.click(screen.getByRole('button', { name: 'Continue to environments' }));
    expect(await screen.findByText('A project with key SHOP already exists')).toBeInTheDocument();
  });

  it('marks the stepper position', () => {
    render(<Host fake={createFakeTrpc(baseHandlers())} />);
    const current = screen
      .getByRole('list', { name: 'Wizard steps' })
      .querySelector('[aria-current="step"]');
    expect(current?.textContent).toContain('Basics');
  });
});

describe('Environments step', () => {
  it('defaults to the saved dev environment, creates added rows and rejects duplicates', async () => {
    seedDraft();
    const user = userEvent.setup();
    const fake = createFakeTrpc(baseHandlers());
    render(<Host fake={fake} initial="environments" />);

    expect(await screen.findByLabelText('Environment 1 name')).toHaveValue('dev');
    await user.click(screen.getByRole('button', { name: '+ Add environment' }));
    await user.type(screen.getByLabelText('Environment 2 name'), 'dev');
    await user.type(screen.getByLabelText('Environment 2 base URL'), 'http://staging.test');
    await user.click(screen.getByRole('button', { name: 'Continue to models' }));
    expect(await screen.findByText('Names must be unique')).toBeInTheDocument();

    await user.clear(screen.getByLabelText('Environment 2 name'));
    await user.type(screen.getByLabelText('Environment 2 name'), 'staging');
    await user.click(screen.getByRole('button', { name: 'Continue to models' }));
    expect(
      await screen.findByRole('heading', { name: 'System 1 · decision model' }),
    ).toBeInTheDocument();
    expect(callsTo(fake, 'environments.create')[0]?.input).toEqual({
      projectKey: 'SHOP',
      name: 'staging',
      baseUrl: 'http://staging.test',
    });
  });

  it('redirects to the first step when no project was created', async () => {
    render(<Host fake={createFakeTrpc(baseHandlers())} initial="models" />);
    expect(await screen.findByLabelText('Project name')).toBeInTheDocument();
  });
});

function s1Card() {
  return screen.getByRole('region', { name: 'System 1 decision model' });
}

async function fillS1(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('region', { name: 'System 1 decision model' });
  await user.type(within(s1Card()).getByLabelText('Base URL'), 'http://localhost:8000');
}

describe('Models step', () => {
  it('renders a successful probe with capabilities', async () => {
    seedDraft();
    const user = userEvent.setup();
    const fake = createFakeTrpc(baseHandlers());
    render(<Host fake={fake} initial="models" />);
    await fillS1(user);
    await user.type(within(s1Card()).getByLabelText('Model'), 'clef-flash');
    await user.type(within(s1Card()).getByLabelText('API key (optional)'), 'sk-secret');
    await user.click(within(s1Card()).getByRole('button', { name: 'Test connection' }));

    expect(await screen.findByText('Connected · decision returned in 142 ms')).toBeInTheDocument();
    const caps = within(s1Card()).getByLabelText('Detected capabilities');
    expect(caps).toHaveTextContent('systemone');
    expect(caps).toHaveTextContent('many');
    expect(caps).toHaveTextContent('supported');
    expect(caps).toHaveTextContent('32,768 tokens');
    expect(callsTo(fake, 'models.probe')[0]?.input).toMatchObject({
      baseUrl: 'http://localhost:8000',
      adapter: 'systemone',
      model: 'clef-flash',
      apiKey: 'sk-secret',
    });
  });

  it('renders probe failure in danger tone', async () => {
    seedDraft();
    const user = userEvent.setup();
    const fake = createFakeTrpc({
      ...baseHandlers(),
      'models.probe': () => ({
        ok: false,
        latencyMs: { p50: 0, samples: [] },
        isCloud: false,
        warnings: [],
        error: 'connect ECONNREFUSED 127.0.0.1:8000',
      }),
    });
    render(<Host fake={fake} initial="models" />);
    await fillS1(user);
    await user.click(within(s1Card()).getByRole('button', { name: 'Test connection' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('connect ECONNREFUSED 127.0.0.1:8000');
    expect(alert.className).toContain('text-danger');
    expect(within(s1Card()).getByLabelText('Detected capabilities')).toHaveTextContent('—');
  });

  it('asks for a URL before probing', async () => {
    seedDraft();
    const user = userEvent.setup();
    const fake = createFakeTrpc(baseHandlers());
    render(<Host fake={fake} initial="models" />);
    await screen.findByRole('region', { name: 'System 1 decision model' });
    await user.click(within(s1Card()).getByRole('button', { name: 'Test connection' }));
    expect(
      await screen.findByText('Enter the endpoint URL, for example http://localhost:8000'),
    ).toBeInTheDocument();
    expect(callsTo(fake, 'models.probe')).toHaveLength(0);
  });

  it('keeps escalate below act on both sliders', async () => {
    seedDraft();
    render(<Host fake={createFakeTrpc(baseHandlers())} initial="models" />);
    const act = (await screen.findByLabelText('Act / pass automatically at ≥')) as HTMLInputElement;
    const esc = screen.getByLabelText('Escalate to human below') as HTMLInputElement;
    expect(act.value).toBe('0.8');
    expect(esc.value).toBe('0.5');
    expect(Number(esc.max)).toBeCloseTo(0.79);
    expect(Number(act.min)).toBeCloseTo(0.51);

    fireEvent.change(act, { target: { value: '0.6' } });
    expect(act.value).toBe('0.6');
    expect(Number(esc.max)).toBeCloseTo(0.59);

    fireEvent.change(esc, { target: { value: '0.59' } });
    fireEvent.change(act, { target: { value: '0.52' } });
    expect(Number(esc.value)).toBeLessThan(Number(act.value));
    expect(Number(act.value)).toBeGreaterThanOrEqual(0.5);
  });

  it('warns when the System 2 endpoint is a cloud endpoint, then saves the pasted key apart from the settings', async () => {
    seedDraft();
    const user = userEvent.setup();
    const fake = createFakeTrpc({
      ...baseHandlers(),
      'models.probe': (i) =>
        (i as { adapter: string }).adapter === 'openai-chat'
          ? probeOk({ adapter: 'openai-chat', isCloud: true })
          : probeOk(),
    });
    render(<Host fake={fake} initial="models" />);
    await fillS1(user);
    const s1 = s1Card();
    await user.type(within(s1).getByLabelText('Model'), 'clef-flash');
    await user.type(within(s1).getByLabelText('API key (optional)'), 'sk-secret');

    const s2 = screen.getByRole('region', { name: 'System 2 fallback model' });
    expect(within(s2).getByText('Optional')).toBeInTheDocument();
    expect(screen.queryByText(/Cloud endpoint detected/)).not.toBeInTheDocument();
    await user.type(within(s2).getByLabelText('Base URL'), 'https://api.openai.com/v1');
    await user.type(within(s2).getByLabelText('Model'), 'gpt-4o-mini');
    await user.type(within(s2).getByLabelText('API key (optional)'), 'env:OPENAI_KEY');
    await user.click(within(s2).getByRole('button', { name: 'Test connection' }));
    expect(
      await screen.findByText(
        'Cloud endpoint detected for System 2 — page data leaves this machine.',
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Continue to login setup' }));
    expect(await screen.findByRole('heading', { name: 'Login setup' })).toBeInTheDocument();

    const saved = callsTo(fake, 'models.updateSettings')[0]?.input as {
      target: string;
      settings: Record<string, unknown>;
      apiKeys: unknown;
    };
    expect(saved.apiKeys).toEqual({ s1: 'sk-secret' });
    expect(saved.target).toBe('SHOP');
    expect(saved.settings).toMatchObject({
      system1: { adapter: 'systemone', baseUrl: 'http://localhost:8000', model: 'clef-flash' },
      system2: {
        adapter: 'openai-chat',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
        apiKeyRef: 'env:OPENAI_KEY',
      },
      thresholds: { act: 0.8, pass: 0.8, escalate: 0.5 },
      dualOrderSensitive: true,
    });
    expect(JSON.stringify(saved.settings)).not.toContain('sk-secret');
    expect(window.sessionStorage.getItem('s1pilot.wizard.draft')).not.toContain('sk-secret');
    expect(callsTo(fake, 'projects.update')[0]?.input).toEqual({
      key: 'SHOP',
      dataPolicy: { sendPageText: true, sendScreenshots: 'never' },
    });
  });
});

describe('Login step', () => {
  it('skip moves on to first tests', async () => {
    seedDraft();
    const user = userEvent.setup();
    render(<Host fake={createFakeTrpc(baseHandlers())} initial="login" />);
    await user.click(screen.getByRole('button', { name: 'Skip' }));
    expect(await screen.findByLabelText('Describe a test in plain language')).toBeInTheDocument();
  });

  it('shows an error when recording is unavailable', async () => {
    seedDraft();
    const user = userEvent.setup();
    vi.stubGlobal('fetch', createFakeTrpc(baseHandlers()).fetch);
    render(<Host fake={createFakeTrpc(baseHandlers())} initial="login" />);
    await user.click(screen.getByRole('button', { name: 'Record a login' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No procedure auth.record');
  });

  it('records, then saves on Done', async () => {
    seedDraft();
    const user = userEvent.setup();
    const fake = createFakeTrpc({
      ...baseHandlers(),
      'auth.record': () => ({ id: 'auth00000000000000001', recording: true }),
      'auth.finishRecording': () => ({ id: 'auth00000000000000001', status: 'valid' }),
    });
    vi.stubGlobal('fetch', fake.fetch);
    render(<Host fake={fake} initial="login" />);
    await user.click(screen.getByRole('button', { name: 'Record a login' }));
    await user.click(await screen.findByRole('button', { name: 'Done' }));
    expect(await screen.findByText('Login saved for the dev environment')).toBeInTheDocument();
    const [record] = callsTo(fake, 'auth.record');
    expect(record?.input).toMatchObject({ projectKey: 'SHOP', name: 'login-as-customer' });
    expect(callsTo(fake, 'auth.finishRecording')[0]?.input).toMatchObject({
      projectKey: 'SHOP',
      name: 'login-as-customer',
    });
  });

  it('registers a flow login under the login name when continuing', async () => {
    seedDraft();
    const user = userEvent.setup();
    const fake = createFakeTrpc({
      ...baseHandlers(),
      'auth.saveFlow': () => ({ id: 'auth00000000000000002', kind: 'flow' }),
    });
    vi.stubGlobal('fetch', fake.fetch);
    render(<Host fake={fake} initial="login" />);
    await user.click(screen.getByRole('button', { name: 'Use a flow' }));
    await user.type(screen.getByLabelText('Shared step or flow name'), 'login-flow');
    await user.click(screen.getByRole('button', { name: 'Continue to first tests' }));
    expect(await screen.findByLabelText('Describe a test in plain language')).toBeInTheDocument();
    expect(callsTo(fake, 'auth.saveFlow')[0]?.input).toMatchObject({
      projectKey: 'SHOP',
      name: 'login-as-customer',
      flowId: 'login-flow',
    });
  });
});

describe('First tests step', () => {
  it('creates a draft case and starts an explore run', async () => {
    seedDraft();
    const user = userEvent.setup();
    const fake = createFakeTrpc(baseHandlers());
    vi.stubGlobal('fetch', fake.fetch);
    const onFinish = vi.fn();
    render(<Host fake={fake} initial="first-tests" onFinish={onFinish} />);

    expect(screen.getByRole('button', { name: 'Run now (explore)' })).toBeDisabled();
    await user.type(
      screen.getByLabelText('Describe a test in plain language'),
      'Add a product to the cart and check the badge',
    );
    await user.click(screen.getByRole('button', { name: 'Run now (explore)' }));

    await waitFor(() => expect(onFinish).toHaveBeenCalledWith('/p/SHOP/runs/r1/live'));
    expect(callsTo(fake, 'cases.create')[0]?.input).toMatchObject({
      projectKey: 'SHOP',
      status: 'draft',
      title: 'Add a product to the cart and check the badge',
    });
    expect(callsTo(fake, 'runs.create')[0]?.input).toEqual({
      projectKey: 'SHOP',
      caseKeys: ['SHOP-TC-1'],
      environment: 'dev',
      mode: 'explore',
      attended: true,
    });
    expect(window.sessionStorage.getItem('s1pilot.wizard.draft')).toBeNull();
  });

  it('suggests tests by exploring the site when System 2 is configured', async () => {
    seedDraft();
    const user = userEvent.setup();
    const onFinish = vi.fn();
    const fake = createFakeTrpc({
      ...baseHandlers(),
      'generate.status': () => ({ s2Configured: true, model: 'm' }),
      'generate.fromCrawl': () => ({ cases: [{ key: 'SHOP-TC-2' }, { key: 'SHOP-TC-3' }], pagesVisited: 4, skipped: 0 }),
    });
    render(<Host fake={fake} initial="first-tests" onFinish={onFinish} />);
    const button = await screen.findByRole('button', { name: 'Suggest tests' });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    expect(await screen.findByText('2 draft tests from 4 pages')).toBeInTheDocument();
    expect(callsTo(fake, 'generate.fromCrawl')[0]?.input).toEqual({ projectKey: 'SHOP', maxPages: 20 });
    await user.click(screen.getByRole('button', { name: 'Review drafts' }));
    expect(onFinish).toHaveBeenCalledWith('/p/SHOP/review?tab=drafts');
  });

  it('disables site exploration without System 2', async () => {
    seedDraft();
    render(<Host fake={createFakeTrpc(baseHandlers())} initial="first-tests" />);
    expect(await screen.findByRole('button', { name: 'Suggest tests' })).toBeDisabled();
  });

  it('Finish goes to the cases list', async () => {
    seedDraft();
    const user = userEvent.setup();
    const onFinish = vi.fn();
    render(
      <Host fake={createFakeTrpc(baseHandlers())} initial="first-tests" onFinish={onFinish} />,
    );
    await user.click(screen.getByRole('button', { name: 'Finish' }));
    expect(onFinish).toHaveBeenCalledWith('/p/SHOP/cases');
  });
});

describe('Editing an existing project', () => {
  it('loads the saved project instead of asking for the details again, and leaves no draft behind', async () => {
    const fake = createFakeTrpc({
      ...baseHandlers(),
      'projects.get': () => ({
        key: 'SHOP',
        name: 'Shop',
        defaultEnvironmentId: 'e1',
        dataPolicy: { sendPageText: false, sendScreenshots: 'never' },
      }),
      'models.getSettings': () => ({
        settings: {
          system1: { adapter: 'systemone', baseUrl: 'http://127.0.0.1:9000', model: 'clef-flash' },
          thresholds: { act: 0.9, pass: 0.9, fail: 0.2, escalate: 0.4 },
        },
      }),
    });
    const user = userEvent.setup();
    render(<Host fake={fake} projectKey="SHOP" />);
    expect(await screen.findByDisplayValue('Shop')).toBeInTheDocument();
    expect(screen.getByDisplayValue('SHOP')).toBeInTheDocument();
    expect(screen.getByDisplayValue('http://127.0.0.1:4400/shop')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continue to environments' }));
    expect(callsTo(fake, 'projects.create')).toHaveLength(0);
    expect(window.sessionStorage.getItem('s1pilot.wizard.draft')).toBeNull();
  });
});
