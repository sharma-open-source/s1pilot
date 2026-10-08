import type { Config } from 'tailwindcss';

const v = (name: string): string => `var(--${name})`;

/** Every colour, radius and font maps to a CSS variable from src/styles/tokens.css. */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        app: v('bg-app'),
        surface: {
          DEFAULT: v('surface'),
          subtle: v('surface-subtle'),
          muted: v('surface-muted'),
          selected: v('surface-selected'),
          'hatch-a': v('surface-hatch-a'),
          'hatch-b': v('surface-hatch-b'),
        },
        line: {
          DEFAULT: v('border'),
          input: v('border-input'),
          dashed: v('border-dashed'),
          'dashed-strong': v('border-dashed-strong'),
        },
        divider: { DEFAULT: v('divider'), row: v('divider-row') },
        fg: v('text'),
        'strong-2': v('text-strong-2'),
        secondary: v('text-secondary'),
        muted: v('text-muted'),
        ink: { DEFAULT: v('ink'), text: v('ink-text') },
        primary: {
          DEFAULT: v('primary'),
          soft: v('primary-soft'),
          text: v('primary-text'),
          'text-hover': v('primary-text-hover'),
        },
        ai: { DEFAULT: v('ai'), soft: v('ai-soft'), strong: v('ai-strong') },
        success: { DEFAULT: v('success'), soft: v('success-soft'), strong: v('success-strong'), dot: v('success-dot') },
        danger: {
          DEFAULT: v('danger'),
          soft: v('danger-soft'),
          strong: v('danger-strong'),
          ink: v('danger-ink'),
          border: v('danger-border'),
          hatch: v('danger-hatch'),
        },
        warning: {
          DEFAULT: v('warning'),
          soft: v('warning-soft'),
          strong: v('warning-strong'),
          ink: v('warning-ink'),
          bar: v('warning-bar'),
          log: v('warning-log'),
        },
        flaky: { DEFAULT: v('flaky'), soft: v('flaky-soft') },
        chart: { 1: v('chart-1'), 2: v('chart-2'), 3: v('chart-3') },
        track: v('track'),
        white: v('surface'),
      },
      borderRadius: {
        card: v('radius-card'),
        control: v('radius-control'),
        tag: v('radius-tag'),
        pill: v('radius-pill'),
        block: v('radius-block'),
      },
      fontFamily: { sans: [v('font-sans')], mono: [v('font-mono')] },
    },
  },
  plugins: [],
} satisfies Config;
