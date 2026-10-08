import * as DM from '@radix-ui/react-dropdown-menu';
import type { ComponentPropsWithoutRef } from 'react';

import { cn } from '@/lib/cn';

/** Radix DropdownMenu root; compose with `DropdownTrigger`, `DropdownContent` and the item components. */
export const DropdownMenu = DM.Root;
/** Wrap a real `<button>` (`asChild`) so the trigger keeps its 44/40 px target. */
export const DropdownTrigger = DM.Trigger;
export const DropdownRadioGroup = DM.RadioGroup;

const itemBase =
  'flex min-h-[40px] cursor-pointer select-none items-center gap-2 rounded-tag px-3 text-sm text-fg outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-60 data-[highlighted]:bg-surface-muted';

/** Popover panel for a menu (Card styling, portalled). */
export function DropdownContent({ className, align = 'start', ...rest }: ComponentPropsWithoutRef<typeof DM.Content>) {
  return (
    <DM.Portal>
      <DM.Content
        align={align}
        sideOffset={4}
        className={cn('z-50 min-w-[180px] max-w-[calc(100vw-32px)] rounded-control border border-line bg-surface p-1', className)}
        {...rest}
      />
    </DM.Portal>
  );
}

/** Plain menu item. */
export function DropdownItem({ className, ...rest }: ComponentPropsWithoutRef<typeof DM.Item>) {
  return <DM.Item className={cn(itemBase, className)} {...rest} />;
}

/** Single-choice item inside a `DropdownRadioGroup`; shows a check when selected. */
export function DropdownRadioItem({ className, children, ...rest }: ComponentPropsWithoutRef<typeof DM.RadioItem>) {
  return (
    <DM.RadioItem className={cn(itemBase, 'relative pl-7', className)} {...rest}>
      <DM.ItemIndicator className="absolute left-2.5">✓</DM.ItemIndicator>
      {children}
    </DM.RadioItem>
  );
}

/** Thin divider between menu groups. */
export function DropdownSeparator() {
  return <DM.Separator className="my-1 h-px bg-divider" />;
}
