import { cn } from '@/lib/cn';

/** Shares of executed steps in percent (as the API returns them); all zero means "no data". */
export interface ModeMix {
  replay: number;
  heal: number;
  explore: number;
}

const SEGMENTS = [
  { key: 'replay', label: 'Replay', className: 'bg-chart-1 text-white' },
  { key: 'heal', label: 'Heal', className: 'bg-chart-2 text-white' },
  { key: 'explore', label: 'Explore', className: 'bg-chart-3 text-fg' },
] as const;

/** 28 px stacked bar of Replay / Heal / Explore; each segment's width is exactly its percentage. */
export function ModeMixBar({ mix, className }: { mix: ModeMix; className?: string }) {
  const total = mix.replay + mix.heal + mix.explore;
  return (
    <div
      role="img"
      aria-label={
        total === 0
          ? 'No steps executed yet'
          : `Replay ${mix.replay}%, Heal ${mix.heal}%, Explore ${mix.explore}%`
      }
      className={cn('flex h-7 overflow-hidden rounded-tag border border-line', className)}
    >
      {SEGMENTS.map(({ key, label, className: seg }) =>
        mix[key] > 0 ? (
          <div
            key={key}
            data-segment={key}
            style={{ width: `${mix[key]}%` }}
            className={cn('flex min-w-0 items-center overflow-hidden whitespace-nowrap pl-2.5 text-xs', seg)}
          >
            {label} {mix[key]}%
          </div>
        ) : null,
      )}
    </div>
  );
}
