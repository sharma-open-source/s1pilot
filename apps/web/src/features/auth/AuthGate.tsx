import { Navigate } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { AcceptInvitePage } from './AcceptInvitePage';
import { AuthFrame, LoginPage } from './LoginPage';

import { Skeleton } from '@/components/ui';
import { trpc } from '@/lib/trpc';

const INVITE_PATH = /^\/invite\/([^/]+)\/?$/;

/**
 * Team mode (S-067): until the user is signed in only the sign-in, first-run and invite screens render.
 * Local mode, and any failure to read the status, render the app as before (the server still enforces access).
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const status = trpc.session.status.useQuery(undefined, { staleTime: 30_000 });
  const path = typeof window === 'undefined' ? '/' : window.location.pathname;
  if (status.isLoading) {
    return (
      <AuthFrame title="s1pilot">
        <div aria-busy="true" className="flex flex-col gap-2">
          <Skeleton className="h-11 w-full" />
        </div>
      </AuthFrame>
    );
  }
  const s = status.data;
  if (!s || s.mode !== 'team') return <>{children}</>;
  if (!s.authenticated) {
    const invite = INVITE_PATH.exec(path);
    if (invite?.[1] !== undefined && !s.needsSetup) return <AcceptInvitePage token={decodeURIComponent(invite[1])} />;
    return <LoginPage needsSetup={s.needsSetup} sso={s.sso} />;
  }
  if (path === '/login' || INVITE_PATH.test(path)) return <Navigate to="/" replace />;
  return <>{children}</>;
}
