import { ROLES } from './model';

import { Card, EmptyState } from '@/components/ui';

/** Notifications: placeholder until S-065. */
export function NotificationsSection() {
  return (
    <Card aria-label="Notifications" className="flex flex-col gap-3 p-5">
      <h2 className="text-[17px] font-semibold text-fg">Notifications</h2>
      <EmptyState>Run finished, approval needed and review queue notifications arrive with the integrations. Not connected yet.</EmptyState>
    </Card>
  );
}

/** Audit log: placeholder until S-067. */
export function AuditSection() {
  return (
    <Card aria-label="Audit log" className="flex flex-col gap-3 p-5">
      <h2 className="text-[17px] font-semibold text-fg">Audit log</h2>
      <EmptyState>The audit log is available in team mode.</EmptyState>
    </Card>
  );
}

/** Users & roles: read-only role descriptions. */
export function UsersSection() {
  return (
    <Card aria-label="Users and roles" className="flex flex-col gap-2.5 border-dashed border-line-dashed-strong p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[17px] font-semibold text-fg">Users &amp; roles</h2>
        <span className="text-[13px] text-secondary">Available in team mode (Postgres + SSO)</span>
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
