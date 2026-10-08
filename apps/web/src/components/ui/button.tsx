import { Link } from '@tanstack/react-router';
import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef, type AnchorHTMLAttributes, type ButtonHTMLAttributes } from 'react';

import { cn } from '@/lib/cn';

/** Shared look of `Button` and `LinkButton` (design.md 4.1). */
export const buttonStyles = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap font-sans no-underline disabled:cursor-not-allowed disabled:opacity-60 aria-disabled:cursor-not-allowed aria-disabled:opacity-60',
  {
    variants: {
      variant: {
        primary: 'rounded-control border-0 bg-primary font-semibold text-white',
        secondary: 'rounded-control border border-line-input bg-surface font-medium text-fg',
        ink: 'rounded-control border-0 bg-ink font-semibold text-white',
        'danger-outline': 'rounded-control border border-danger-border bg-surface font-medium text-danger',
        dashed: 'rounded-tag border border-dashed border-line-dashed-strong bg-transparent font-medium text-secondary',
      },
      size: {
        md: 'min-h-[44px] px-4 text-sm',
        sm: 'min-h-[36px] rounded-tag px-3 text-[13px]',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export type ButtonVariant = NonNullable<VariantProps<typeof buttonStyles>['variant']>;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonStyles> {}

/** A real `<button>`; defaults to `type="button"`. The `dashed` variant is always 36 px tall. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, size, className, type = 'button', ...rest },
  ref,
) {
  const effectiveSize = variant === 'dashed' ? 'sm' : size;
  return <button ref={ref} type={type} className={cn(buttonStyles({ variant, size: effectiveSize }), className)} {...rest} />;
});

export interface LinkButtonProps
  extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>,
    VariantProps<typeof buttonStyles> {
  /** In-app route (rendered with the router `Link`). */
  to?: string;
  /** External or plain URL. */
  href?: string;
}

/** `<a>` styled as a Button, for navigation actions ("Run now", "New test case"). */
export function LinkButton({ variant, size, className, to, href, ...rest }: LinkButtonProps) {
  const cls = cn(buttonStyles({ variant, size: variant === 'dashed' ? 'sm' : size }), className);
  if (to !== undefined) {
    // `to` is a runtime string; the generated route union is too narrow for shared components.
    return <Link to={to as never} className={cls} {...rest} />;
  }
  return <a href={href} className={cls} {...rest} />;
}
