import type { ReactNode } from 'react';
import { Line, LineChart, ResponsiveContainer, YAxis } from 'recharts';

import { Skeleton } from '@/components/ui/misc';
import { cn } from '@/lib/cn';

export interface StatTileProps {
  /** 13 px muted label. */
  label: ReactNode;
  /** Mono 30/600 value. */
  value: ReactNode;
  /** `warning` / `danger` colour the value; the label stays muted. */
  tone?: 'default' | 'warning' | 'danger';
  /** Sparkline or sub-line with a link. */
  children?: ReactNode;
  className?: string;
}

const toneClass = { default: '', warning: 'text-warning', danger: 'text-danger' } as const;

/** Metric card: label, big mono value and an optional sparkline or sub-line (design.md 4, `StatTile`). */
export function StatTile({ label, value, tone = 'default', children, className }: StatTileProps) {
  return (
    <div className={cn('flex flex-col gap-2 rounded-card border border-line bg-surface p-[18px]', className)}>
      <div className="text-[13px] text-muted">{label}</div>
      <div className={cn('font-mono text-[30px] font-semibold leading-tight text-fg', toneClass[tone])}>{value}</div>
      {children}
    </div>
  );
}

/** Loading state of a `StatTile`. */
export function StatTileSkeleton({ label }: { label: ReactNode }) {
  return (
    <StatTile label={label} value={<Skeleton className="h-9 w-24" />}>
      <Skeleton className="h-4 w-40" />
    </StatTile>
  );
}

/** Tiny line chart (no axes, 36 px tall). `null` points leave gaps; with no data at all a flat dashed baseline shows. */
export function Sparkline({ values, label }: { values: Array<number | null>; label: string }) {
  const data = values.map((v, i) => ({ i, v }));
  const hasData = values.some((v) => v !== null);
  return (
    <div role="img" aria-label={label} className="h-9 w-full">
      {hasData ? (
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
            <YAxis hide domain={[0, 100]} />
            <Line
              type="monotone"
              dataKey="v"
              stroke="var(--primary)"
              strokeWidth={2}
              dot={{ r: 2, fill: 'var(--primary)', stroke: 'var(--primary)' }}
              connectNulls
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      ) : (
        <div className="mt-[17px] border-t-2 border-dashed border-line-dashed" />
      )}
    </div>
  );
}
