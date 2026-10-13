import { useQueryClient } from '@tanstack/react-query';

import { Button, Tag } from '@/components/ui';
import { useSessionUser } from '@/lib/session';
import { trpc } from '@/lib/trpc';

/** Team mode only: who is signed in, their role, and Sign out. Renders nothing in local mode. */
export function UserMenu() {
  const user = useSessionUser();
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();
  if (user === null || user.mode !== 'team') return null;
  const signOut = async () => {
    await utils.client.session.logout.mutate();
    queryClient.clear();
    window.location.assign('/');
  };
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-divider-row px-4 py-3 text-sm" aria-label="Signed in user">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium text-fg">{user.name}</span>
        {user.email !== null && <span className="truncate font-mono text-xs text-secondary">{user.email}</span>}
      </div>
      <Tag>{user.role}</Tag>
      <Button size="sm" onClick={() => void signOut()}>
        Sign out
      </Button>
    </div>
  );
}
