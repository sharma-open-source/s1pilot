# S-039 · Web scaffold, tokens & app shell

**Phase:** P3 · **Depends on:** S-031 · **Packages:** `apps/web` · **Plan refs:** §8, §10 Web UI
**UI:** wireframe [`docs/wireframes/00-side-navigation.html`](../../wireframes/00-side-navigation.html) · design.md §2, §3, §4.1

## Goal
React app with design tokens, primitives and the app shell (left nav + main) so every screen spec only builds page content.

## Scope
- Vite + React + TS, TanStack Router (file-based routes), TanStack Query + tRPC client (`@trpc/react-query`) using `AppRouter` type, Tailwind + shadcn/ui init, `lucide-react`, `@fontsource/ibm-plex-sans` & `-mono`.
- `src/styles/tokens.css` with **every** token in design.md §2.1; Tailwind theme maps colours/radii/fonts to tokens (`bg-app`, `text-muted`, `rounded-card` …).
- Primitives in `src/components/ui/` per design.md §4.1: Button (primary, secondary, ink, danger-outline, dashed; sizes), LinkButton, Input, Select, Textarea, Field, Checkbox, Range, Card/CardHeader, InsetBox, Tabs (underline, router-aware), Segmented, Pill/StatusPill (§2.2 mapping), Tag, Callout, Breadcrumb, EmptyState, Skeleton, Dialog (confirm variant).
- `src/components/app/AppShell.tsx` + `Nav.tsx` exactly as the `Nav` artboard: logo, project switcher (popover listing projects from `projects.list` + "New project"), 12 nav items with routes from design.md §5, active state, badges (live runs, review count — from `/ws/workspace`, stub 0 if absent), Models status box (from `models.status`).
- Route skeletons (placeholder page with h1) for every screen route in design.md §5 so later specs fill them.
- `/_dev/components` route rendering all primitives (dev only).
- Vite dev proxy `/trpc`, `/api`, `/ws` → server 5317; production build served by server (S-031 static).

## Acceptance criteria
- [ ] `pnpm --filter @s1pilot/web dev` shows the shell; nav matches the artboard (order, labels, active style, model box).
- [ ] At 400 px width the nav stacks above content and nothing scrolls horizontally.
- [ ] `/_dev/components` shows every primitive; StatusPill renders all statuses in §2.2.
- [ ] No hex colours in component code (lint rule or grep test).

## Tests
- Vitest + Testing Library for StatusPill mapping, Nav active state; Playwright smoke opening each route.

## Out of scope
- Page content (S-040+).
