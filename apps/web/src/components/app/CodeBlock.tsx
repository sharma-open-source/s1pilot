import { useState } from 'react';

import { Button } from '@/components/ui';
import { cn } from '@/lib/cn';

/** Copies text with the async clipboard API; resolves false when it is unavailable or denied. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Small "Copy" button that flips to "Copied" for 2 s. `label` names the thing copied for screen readers. */
export function CopyButton({ text, label, className }: { text: string; label: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <Button
      className={className}
      aria-label={`Copy ${label}`}
      onClick={() => {
        void copyText(text).then((ok) => {
          setState(ok ? 'copied' : 'failed');
          window.setTimeout(() => setState('idle'), 2000);
        });
      }}
    >
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy'}
    </Button>
  );
}

/** Dark mono block (`--ink`) with a copy button; scrolls horizontally instead of wrapping. */
export function CodeBlock({ code, label = 'command', className }: { code: string; label?: string; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <pre
        tabIndex={0}
        role="region"
        aria-label={label}
        className="m-0 overflow-x-auto rounded-control bg-ink px-4 py-3.5 font-mono text-[13px] text-ink-text"
      >
        {code}
      </pre>
      <div className="flex justify-end">
        <CopyButton text={code} label={label} />
      </div>
    </div>
  );
}
