import { ROLES } from './model';

import { Card } from '@/components/ui';
import { useSessionUser } from '@/lib/session';

/** The four roles as read-only boxes (wireframe 13, shown on Integrations). Management lives in Users & roles. */
export function RolesOverview() {
  const user = useSessionUser();
  const team = user?.mode === 'team';
  return (
    <Card aria-label="Users and roles" className="flex flex-col gap-2.5 border-dashed border-line-dashed-strong p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[17px] font-semibold text-fg">Users &amp; roles</h2>
        <span className="text-[13px] text-secondary">{team ? 'Manage under Users & roles' : 'Available in team mode (Postgres + SSO)'}</span>
      </div>
      <ul className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-2.5 p-0 text-[13px]">
        {ROLES.map((r) => (
          <li key={r.name} className="rounded-control bg-surface-subtle p-2.5">
            <strong className="text-fg">{r.name}</strong>
            <br />
            <span className="text-secondary">{r.can}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
