import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { AuthGate } from './AuthGate';

import { AuditSection, toAuditQuery } from '@/features/settings/AuditSection';
import { UsersSection } from '@/features/settings/UsersSection';
import { Can } from '@/lib/session';
import { createFakeTrpc, FakeTrpcProvider, type Handler } from '@/test/fake-trpc';

const ME = (role: string, mode = 'team') => ({ id: 'u1', name: 'Una', email: 'una@example.com', role, mode });

function renderWith(handlers: Record<string, Handler>, ui: React.ReactNode) {
  const fake = createFakeTrpc(handlers);
  render(<FakeTrpcProvider fake={fake}>{ui}</FakeTrpcProvider>);
  return fake;
}

describe('AuthGate', () => {
  it('shows the app in local mode', async () => {
    renderWith({ 'session.status': () => ({ mode: 'local', needsSetup: false, authenticated: true, sso: null }) }, <AuthGate>the app</AuthGate>);
    expect(await screen.findByText('the app')).toBeInTheDocument();
  });

  it('shows a single sign-in card in team mode and submits through the login mutation', async () => {
    const user = userEvent.setup();
    const fake = renderWith(
      {
        'session.status': () => ({ mode: 'team', needsSetup: false, authenticated: false, sso: { label: 'Acme SSO' } }),
        'session.login': () => ({ id: 'u1' }),
      },
      <AuthGate>the app</AuthGate>,
    );
    expect(await screen.findByRole('heading', { name: 'Sign in', level: 1 })).toBeInTheDocument();
    expect(screen.queryByText('the app')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Continue with Acme SSO' })).toHaveAttribute('href', '/api/auth/oidc/login');
    await user.type(screen.getByLabelText('Email'), 'una@example.com');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(fake.calls.find((c) => c.path === 'session.login')?.input).toEqual({ email: 'una@example.com', password: 'correct horse battery' }));
  });

  it('offers the first-run admin form while the workspace is empty', async () => {
    renderWith({ 'session.status': () => ({ mode: 'team', needsSetup: true, authenticated: false, sso: null }) }, <AuthGate>the app</AuthGate>);
    expect(await screen.findByRole('heading', { name: 'Create the first admin' })).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
  });
});

describe('Can', () => {
  it('hides edit controls for viewers and shows them for testers', async () => {
    const view = renderWith({ 'session.me': () => ME('viewer') }, <Can permission="content:write"><button>New test case</button></Can>);
    await waitFor(() => expect(view.calls.some((c) => c.path === 'session.me')).toBe(true));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'New test case' })).not.toBeInTheDocument());
  });

  it('renders for a tester, and for sign-offs only leads', async () => {
    renderWith(
      { 'session.me': () => ME('tester') },
      <>
        <Can permission="content:write"><button>Edit</button></Can>
        <Can permission="signoff"><button>Sign off</button></Can>
      </>,
    );
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Sign off' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });
});

describe('UsersSection', () => {
  const users = {
    users: [
      { id: 'u1', email: 'una@example.com', name: 'Una', role: 'admin', status: 'active', hasPassword: true, sso: false, createdAt: '2026-01-01T00:00:00.000Z', lastLoginAt: null },
      { id: 'u2', email: 'tess@example.com', name: 'Tess', role: 'tester', status: 'active', hasPassword: true, sso: false, createdAt: '2026-01-01T00:00:00.000Z', lastLoginAt: null },
    ],
    invites: [],
  };

  it('lists users, changes a role and invites with a one-time link', async () => {
    const user = userEvent.setup();
    const fake = renderWith(
      {
        'session.me': () => ME('admin'),
        'users.list': () => users,
        'users.setRole': () => ({}),
        'users.invite': () => ({ invite: { id: 'i1', email: 'new@example.com', role: 'viewer', expiresAt: '2026-02-01T00:00:00.000Z' }, inviteUrl: 'http://localhost/invite/abc123abc123abc123' }),
      },
      <UsersSection />,
    );
    expect(await screen.findByText('tess@example.com')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deactivate Una' })).toBeDisabled(); // cannot deactivate yourself
    await user.selectOptions(screen.getByLabelText('Role of Tess'), 'viewer');
    await waitFor(() => expect(fake.calls.find((c) => c.path === 'users.setRole')?.input).toEqual({ id: 'u2', role: 'viewer' }));

    await user.click(screen.getByRole('button', { name: 'Invite user' }));
    await user.type(await screen.findByLabelText('Email'), 'new@example.com');
    await user.selectOptions(screen.getByLabelText('Role'), 'viewer');
    await user.click(screen.getByRole('button', { name: 'Create invite link' }));
    expect(await screen.findByText('http://localhost/invite/abc123abc123abc123')).toBeInTheDocument();
  });

  it('explains team mode when the server runs locally', async () => {
    renderWith({ 'session.me': () => ME('admin', 'local') }, <UsersSection />);
    expect(await screen.findByText(/need team mode/)).toBeInTheDocument();
  });
});

describe('AuditSection', () => {
  const entry = (id: string, action: string) => ({
    id, at: '2026-03-01T10:00:00.000Z', actorId: 'u1', actorName: 'Una', action, entityType: 'case', entityId: 'SHOP-TC-1', projectKey: 'SHOP',
    before: { title: 'A' }, after: { title: 'B' }, ip: '10.0.0.1',
  });

  it('builds API filters from the form', () => {
    expect(toAuditQuery({ q: ' una ', action: 'case.*', from: '2026-03-01', to: '2026-03-02' })).toEqual({
      q: 'una', action: 'case.*', from: '2026-03-01T00:00:00.000Z', to: '2026-03-02T23:59:59.999Z',
    });
    expect(toAuditQuery({ q: '', action: '', from: '', to: '' })).toEqual({});
  });

  it('shows a filterable table with changes and exports CSV', async () => {
    const user = userEvent.setup();
    const fake = renderWith(
      {
        'session.me': () => ME('lead'),
        'audit.list': (input) => ((input as { action?: string }).action ? { entries: [entry('e2', 'case.update')], nextBefore: null } : { entries: [entry('e1', 'plan.update'), entry('e2', 'case.update')], nextBefore: null }),
        'audit.exportCsv': () => ({ filename: 'audit.csv', csv: 'time\r\n', rows: 1 }),
      },
      <AuditSection />,
    );
    expect(await screen.findByText('plan.update')).toBeInTheDocument();
    expect(screen.getAllByText('SHOP-TC-1')).toHaveLength(2);
    await user.selectOptions(screen.getByLabelText('Action'), 'case.*');
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    await waitFor(() => expect(screen.queryByText('plan.update')).not.toBeInTheDocument());
    expect(fake.calls.some((c) => c.path === 'audit.list' && (c.input as { action?: string }).action === 'case.*')).toBe(true);
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeEnabled();
  });

  it('tells testers they cannot read the log', async () => {
    renderWith({ 'session.me': () => ME('tester') }, <AuditSection />);
    expect(await screen.findByText(/cannot read the audit log/)).toBeInTheDocument();
  });
});
