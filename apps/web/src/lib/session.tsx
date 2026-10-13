import { can, type Permission, type Role } from '@s1pilot/domain';
import type { ReactNode } from 'react';

import { trpc } from './trpc';

/** Signed-in user as the UI needs it. */
export interface SessionUser {
  id: string;
  name: string;
  email: string | null;
  role: Role;
  mode: 'local' | 'team';
}

/**
 * The signed-in user (`session.me`). While it loads, or when it cannot be read, the UI is permissive: hiding
 * controls is a convenience only, the server enforces every permission (403).
 */
export function useSessionUser(): SessionUser | null {
  const q = trpc.session.me.useQuery(undefined, { staleTime: 60_000 });
  return q.data ?? null;
}

/** Whether the current user holds `permission`. True until the user is known (see {@link useSessionUser}). */
export function useCan(permission: Permission): boolean {
  const user = useSessionUser();
  return user === null ? true : can(user.role, permission);
}

/** Renders `children` only for users who hold `permission` (edit controls are absent for viewers, not just disabled). */
export function Can({ permission, children, fallback = null }: { permission: Permission; children: ReactNode; fallback?: ReactNode }) {
  return useCan(permission) ? <>{children}</> : <>{fallback}</>;
}
