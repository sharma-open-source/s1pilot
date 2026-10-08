import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';

/** Subset of the probe result's `capabilities`. */
export interface CapabilityValues {
  maxOptions: number;
  multiQuestionPerCall: boolean;
  supportsImages: boolean;
  maxContextTokens: number;
}

function Cell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="m-0 font-mono text-sm text-fg">{children}</dd>
    </div>
  );
}

/** Detected model capabilities after a successful probe; shows a dash for every value before that. */
export function CapabilityGrid({
  adapter,
  capabilities,
  className,
}: {
  adapter?: string | undefined;
  capabilities?: CapabilityValues | undefined;
  className?: string;
}) {
  const dash = <span aria-label="not detected yet">—</span>;
  return (
    <dl
      aria-label="Detected capabilities"
      className={cn(
        'm-0 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3.5 rounded-control border border-divider bg-surface-subtle p-4',
        className,
      )}
    >
      <Cell label="Detected adapter">{adapter ?? dash}</Cell>
      <Cell label="Max options / question">{capabilities ? capabilities.maxOptions : dash}</Cell>
      <Cell label="Questions per call">{capabilities ? (capabilities.multiQuestionPerCall ? 'many' : '1') : dash}</Cell>
      <Cell label="Images">{capabilities ? (capabilities.supportsImages ? 'supported' : 'not supported') : dash}</Cell>
      <Cell label="Context">
        {capabilities ? `${capabilities.maxContextTokens.toLocaleString('en-US')} tokens` : dash}
      </Cell>
    </dl>
  );
}
