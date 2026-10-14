# s1pilot · UI Design Guide

> Source of truth for every UI spec (`docs/specs/**`, phase P3 onward).
> Derived from the wireframe canvas **"s1pilot Wireframes"** (https://claude.ai/artifact/7JqTPxRmPXkBATqh5opk6u).
> **Local copy for agents:** [`docs/wireframes/`](wireframes/index.html) — one standalone HTML file per screen (open in a browser; links between screens work).
> When this document and a spec disagree, the spec's functional requirements win and this document's visual rules win.

---

## 1. Design principles

1. **Quiet, instrument-like UI.** Warm greys, one blue action colour, colour reserved for status. No gradients, no shadows beyond a 1px border, no emoji, no decorative illustration.
2. **Numbers and identifiers in mono.** Case keys (`SHOP-TC-42`), probabilities (`0.62`), URLs, locators, cron, counts, model names, durations → IBM Plex Mono. Prose and labels → IBM Plex Sans.
3. **Show the model's reasoning.** Wherever System 1 decided something, show the options and probabilities (probability bars), the threshold, and who/what confirmed it (S2, human, replay).
4. **Status is always text + colour.** Never colour alone: every pill carries a word (`Passed`, `Failed`, `Review`…).
5. **Every screen is a page in an app shell**: left nav (240 px) + fluid main area. Pages work down to 400 px wide (nav stacks above content, tables scroll horizontally inside their card).
6. **Real controls.** Buttons are `<button>`, links are `<a>`, inputs have `<label>`. Touch/click targets ≥ 44 px tall for primary controls, ≥ 36 px for in-card secondary controls.

---

## 2. Design tokens

Implement as CSS variables in `apps/web/src/styles/tokens.css` and map them in `tailwind.config.ts` (`theme.extend.colors`, etc.). Never hard-code hex values in components; use the token names.

### 2.1 Colour

| Token | Hex | Use |
|---|---|---|
| `--bg-app` | `#F4F4F1` | Page background behind cards |
| `--surface` | `#FFFFFF` | Cards, panels, inputs, nav |
| `--surface-subtle` | `#F7F7F5` | Inset boxes inside cards (capability grid, login items, browser chrome, expected box) |
| `--surface-muted` | `#EFEFEC` | Neutral pill bg (`Blocked`), disabled fills |
| `--surface-hatch-a` / `-b` | `#F4F4F1` / `#ECECE8` | 45° hatch for media placeholders (screencast loading, screenshot missing) |
| `--surface-selected` | `#F5F8FE` | Selected table row / selected list item |
| `--border` | `#D9D9D4` | Card borders, nav right border, tab bar bottom border |
| `--border-input` | `#CFCFCA` | Inputs, selects, secondary buttons |
| `--divider` | `#E4E4E0` | Card header bottom border, inner boxes |
| `--divider-row` | `#EDEDE9` | Table row separators, list item separators |
| `--border-dashed` | `#BDBDB7` | Dashed placeholders (future wizard step, model status box) |
| `--border-dashed-strong` | `#9A9A94` | Dashed "+ Add" buttons, `Draft` pill |
| `--text` | `#1C1C1A` | Primary text, headings |
| `--text-strong-2` | `#2E2E2B` | Nav idle items, neutral pill text |
| `--text-secondary` | `#4A4A45` | Body secondary, descriptions, meta lines |
| `--text-muted` | `#5A5A55` | Labels, table headers, breadcrumbs, captions |
| `--ink` | `#1C1C1A` | "Dark" button fill (wizard Continue, current wizard step), logo tile, console bg |
| `--ink-text` | `#E8E8E3` | Text on console / code blocks |
| `--primary` | `#1F4FC4` | Primary buttons, selected probability bar, running dot, focus ring |
| `--primary-soft` | `#E8EEFB` | Active nav item bg, `Running` pill bg, chosen element box fill |
| `--primary-text` | `#1A3F9E` | Links, active nav text, `Running` pill text |
| `--primary-text-hover` | `#122C70` | Link hover |
| `--ai` / `--ai-soft` | `#2A3A86` / `#EEF0FA` | "AI check" tag, hybrid-mode info callout (`--ai-strong` `#1F2C6B` for callout text) |
| `--success` / `--success-soft` | `#1F6B45` / `#E3F1E8` | Passed, Valid, Connected, ✓ marks; `--success-strong` `#154D31` (diff "+" line); `--success-dot` `#1F7A4D` |
| `--danger` / `--danger-soft` | `#A0281C` / `#FBE7E4` | Failed, Abort, read-only, secrets; `--danger-strong` `#7A1F15`, `--danger-ink` `#4A160F`, `--danger-border` `#E2B8B2`, `--danger-hatch` `#F6D6D1` |
| `--warning` / `--warning-soft` | `#8A4B0A` / `#FBEFD9` | Review / needs-review, Expired, heal in progress, threshold callouts; `--warning-strong` `#6E3C08`, `--warning-ink` `#4A2806`, `--warning-bar` `#C27A1A`, `--warning-log` `#F2C98A` |
| `--flaky` / `--flaky-soft` | `#4E3889` / `#EEEAF8` | Flaky pill |
| `--chart-1` / `-2` / `-3` | `#3A3A36` / `#8C8C86` / `#D4D4CF` | Neutral series (Replay / Heal / Explore mode mix; unselected probability bars use `-2`) |
| `--track` | `#EDEDE9` | Probability bar track |

Light theme only in v1. Keep every colour behind a token so a dark theme can be added by redefining variables.

### 2.2 Status → pill mapping (single source: `StatusPill` component)

| Status value(s) | Label | Background | Text | Notes |
|---|---|---|---|---|
| `running`, `in-progress` | Running / In progress | `--primary-soft` | `--primary-text` | |
| `passed`, `valid`, `connected` | Passed / Valid / Connected | `--success-soft` | `--success` | |
| `failed`, `abort`, `critical` | Failed | `--danger-soft` | `--danger` | |
| `needs-review`, `heal-pending`, `expired` | Review | `--warning-soft` | `--warning` | |
| `flaky` | Flaky | `--flaky-soft` | `--flaky` | |
| `blocked`, `skipped`, `not-run` | Blocked / Skipped | `--surface-muted` | `--text-strong-2` | |
| `draft` | Draft | transparent, 1px dashed `--border-dashed-strong` | `--text-secondary` | |
| `queued`, `to-do` | Queued / To do | transparent, 1px `--border-input` | `--text-secondary` | |

Severity tags (`S1 · Critical` danger, `S2 · Major` warning, `S3 · Minor` neutral) use the same palettes with radius 6 px (tag), not 999 px (pill).

### 2.3 Typography

Fonts (Google Fonts, self-host in production build via `@fontsource/ibm-plex-sans` and `@fontsource/ibm-plex-mono`, weights 400/500/600):

- Sans: `'IBM Plex Sans', 'Segoe UI', system-ui, sans-serif`
- Mono: `'IBM Plex Mono', ui-monospace, monospace`

| Role | Size / weight | Font |
|---|---|---|
| Page title (h1) | 28 px / 600 (Live run header: 20 px / 600; Manual run case title: 24 px / 600) | Sans |
| Card title (h2) | 16–18 px / 600 (use 16 for list cards, 17–18 for form sections, 15 for sidebar cards) | Sans |
| Body | 14 px / 400 | Sans |
| Secondary / meta | 13 px / 400, `--text-secondary` or `--text-muted` | Sans |
| Field label | 13 px / 500 | Sans |
| Table header | 12 px / 500, uppercase, letter-spacing 0.05em, `--text-muted` | Sans |
| Eyebrow (section label in nav/card) | 11 px / 400–500, uppercase, letter-spacing 0.06em, `--text-muted` | Sans |
| Pill / tag | 12 px / 600 | Sans |
| Stat value | 30 px / 600 (report summary 26 px) | Mono |
| Identifiers, numbers, code | 12–14 px / 400–600 | Mono |

Line-height: 1.4 body, 1.2 headings.

### 2.4 Spacing, radius, borders

- Spacing scale (px): 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 28, 36. Prefer 8/12/16/20/24.
- Page main padding: `28px 36px` (Live run: `24px 32px`). Vertical gap between page sections: 24 px (20 px on dense pages, 16 px on Live run).
- Card inner padding: 18–22 px; card header row: `16px 18px` with bottom `--divider` border.
- Table cells: `14px 18px` first/last column, `14px 12px` middle; dense tables `12px`.
- Radius: 10 px cards/panels · 8 px buttons, inputs, inner boxes · 6 px tags, small buttons, nav items · 999 px pills, progress bars · 4 px placeholder blocks.
- Borders: 1 px solid; no box-shadows anywhere. Focus: 2 px `--primary` outline, 2 px offset.

---

## 3. Layout

### 3.1 App shell (wireframe [`00-side-navigation.html`](wireframes/00-side-navigation.html))

```
┌──────────────┬───────────────────────────────────────────────┐
│ Nav 240px    │ <main> padding 28/36, flex column, gap 24      │
│ (white,      │  header: eyebrow/breadcrumb + h1  | actions    │
│  border-r)   │  …sections (cards)                             │
└──────────────┴───────────────────────────────────────────────┘
```

- Shell is `display:flex; flex-wrap:wrap`; nav `flex: 1 1 220px; max-width: 260px`; main `flex: 999 1 560px; min-width:0`. At narrow widths the nav wraps above main.
- **Nav** (top → bottom, gap 22 px, padding `20px 14px`):
  1. Logo: 28 px ink tile with mono "S1" + mono "s1pilot" 16/600.
  2. Project switcher button: `--surface-subtle` bg, 1px border, eyebrow "Project", bold `SHOP · Storefront`, chevron. Opens a popover listing projects + "New project".
  3. Nav items (40 px tall, radius 6, 14 px): Dashboard, Project setup, Environments, Test cases, Test plans, Runs, Manual testing, Reports, Review queue, Defects, Analytics, Settings. Active: `--primary-soft` bg, `--primary-text`, 600, `aria-current="page"`. Right-aligned mono 12 px badge (e.g. `1 live`, review count) in `--warning` when idle.
  4. Bottom (margin-top:auto): dashed box "Models" with S1 / S2 status rows (8 px dot `--success-dot` when reachable, `--danger` when not; `S1 clef-flash · localhost:8000`).
- **Page header**: left = eyebrow (project name or breadcrumb, 13 px muted, links in `--primary-text`) above h1; right = actions (wrap). Primary action rightmost.

### 3.2 Grids & responsive

- Use flex-wrap with flex-basis, or `grid-template-columns: repeat(auto-fit, minmax(Npx, 1fr))` — never fixed column counts.
- Two-column pages: main `flex: 3 1 520px` / side `flex: 2 1 320px` (or `999 1 560px` / `1 1 300px` for an aside).
- Three-column (Live run): steps `1 1 220px, max 270px` · browser `999 1 480px` · decision `1 1 300px, max 380px`.
- Tables live inside `overflow-x:auto` and set a `min-width` (640 px typical) so the page body never scrolls horizontally.
- Target desktop 1280–1440 px; must not break at 400 px.

---

## 4. Components

Build on shadcn/ui primitives (Radix) restyled with the tokens. Put shared components in `apps/web/src/components/ui/` (primitives) and `apps/web/src/components/app/` (domain components). Names below are the component names specs refer to.

### 4.1 Primitives

| Component | Spec |
|---|---|
| `Button` variant `primary` | `--primary` bg, white text, 600, h 44, px 16–18, radius 8, no border |
| `Button` variant `secondary` | white bg, 1px `--border-input`, `--text`, 500, h 44 |
| `Button` variant `ink` | `--ink` bg, white, 600 — used for wizard "Continue…" and "Save plan"-type confirmations on dark-accent flows |
| `Button` variant `danger-outline` | white bg, 1px `--danger-border`, `--danger` text (Abort, Reject & create defect) |
| `Button` variant `dashed` | transparent, 1px dashed `--border-dashed-strong`, h 36, radius 6 ("+ Add", "+ Add step", "+ Add check") |
| `Button` size `sm` | h 36–40, radius 6, 13 px |
| `LinkButton` | `<a>` styled as Button (navigation actions like "Run now", "New test case") |
| `Input` / `Select` / `Textarea` | h 44, px 12, 1px `--border-input`, radius 8, 14 px; mono font when the value is a URL, key, cron, query or model id |
| `Field` | `<label>` column: 13/500 label, 6 px gap, control below |
| `Checkbox` | 18 px native-size box, 8–10 px gap to label text, 14 px |
| `Range` | native-style slider + mono value readout on the right (`0.80`) |
| `Card` | white, 1px `--border`, radius 10; optional `CardHeader` (title left, link/button right, bottom divider) |
| `InsetBox` | `--surface-subtle` bg, 1px `--divider`, radius 8, padding 12–16 |
| `Tabs` (underline) | row of links, 14 px, padding `10px 14px`; active: 2px bottom border `--ink`, 600, `aria-current="page"`; container has 1px bottom `--border` |
| `Segmented` | `role="group"` of buttons with `aria-pressed`; pressed = `--ink` bg white text, others white |
| `Pill` | radius 999, padding `3px 10px`, 12/600 (see §2.2) |
| `Tag` | radius 6, padding `2px 8px`, 12 px; neutral = `--surface-subtle` + border; mono when it's a tag/key |
| `Callout` | radius 8, padding `10px 12px`, 13 px; tones `warning` (amber), `info-ai` (indigo), `danger`, `success` |
| `Breadcrumb` | 13 px muted, `/` separators, links `--primary-text` |
| `EmptyState` | dashed `--border-dashed` box, 14 px secondary text + one action |
| `Skeleton` | `--surface-muted` blocks, radius 4 |

### 4.2 Domain components

| Component | Where | Spec |
|---|---|---|
| `StatTile` | Dashboard, Run report, Analytics | Card, 13 px muted label, mono 30/600 value (tone colour for warning/danger), optional sparkline or sub-line with link |
| `StatusPill` | everywhere | Maps domain status → §2.2 |
| `ProbabilityBar` | Live run, Review, Run report | Row: label left (mono `e3 · Checkout as guest`), mono value right; 8 px track `--track`, fill `--primary` for the chosen/top option, `--chart-2` for others; top row bold |
| `DecisionPanel` | Live run, Result detail | Title "Decision · step N", model + latency (mono 12), question text, list of `ProbabilityBar`s, threshold `Callout`, action buttons |
| `ModeMixBar` | Dashboard, Analytics | 28 px stacked bar, radius 6, segments Replay `--chart-1` / Heal `--chart-2` / Explore `--chart-3` with inline labels; caption explains the three modes |
| `RunProgressBar` | Live run header | 10 px pill track; segments passed `--success`, failed `--danger`, review `--warning-bar`; legend row 12 px |
| `StepStatusList` | Live run left column | rows with icon (✓ success, ● warning current, ✗ danger, ○ muted pending), "N · Short title", mode suffix (`· replay`, `heal · locator changed`); current row bg `--warning-soft` |
| `BrowserFrame` | Live run, Result detail | Card w/o padding: chrome row (`--surface-subtle`, 3 grey dots, mono URL field, "Live · screencast" label), viewport (image/canvas; hatch while loading), toolbar row of `sm` secondary buttons |
| `ElementBoxOverlay` | inside BrowserFrame | Numbered boxes over the screencast: candidate = 2px dashed `--text-muted` with `eN Label` 12 px; chosen = 3px solid `--primary`, `--primary-soft` fill, 600; footer chip on ink bg "[n] interactive elements · numbered boxes shown" |
| `EventLog` | Live run, Result detail | `--ink` bg, `--ink-text`, mono 12 px, radius 10, padding `14px 16px`, one line per event with `[hh:mm:ss]` prefix; escalations/awaiting lines in `--warning-log`; auto-scroll, max-height with overflow |
| `CodeBlock` | Settings CLI, YAML view | `--ink` bg, `--ink-text`, mono 13, radius 8, `overflow-x:auto` |
| `DiffLine` | Review queue | `code` blocks: removed = `--danger-soft` / `--danger-ink` with `−`; added = `--success-soft` / `--success-strong` with `+` |
| `ExpectedActual` | Run report, Defects | Two boxes side by side: Expected `--surface-subtle`, Actual `--danger-soft` with eyebrow `--danger-strong` |
| `ScreenshotTimeline` | Run report | Horizontal row of `figure`s: 96 px thumbnail radius 6 + caption "N · Title · ✓ replay"; failing step has 2px `--danger` border |
| `WizardStepper` | Project wizard | `ol` of pills: done = white + border + ✓ (success mono); current = `--ink` bg, white, `aria-current="step"`; upcoming = dashed `--border-dashed` |
| `CapabilityGrid` | Wizard models step, Settings models | `InsetBox` with auto-fit grid of label (12 muted) / mono value pairs |
| `SuiteTree` | Test cases | Aside list of links with ▸/▾ disclosure, indented children, mono count on right, active = `--primary-soft`; "Library" eyebrow then Shared steps / Test data / Requirements |
| `StepGrid` | Case editor | Table `#` · Action · Expected · Checks; inline-editable cells; parameters rendered as mono `{param}` chips (`--primary-soft`); checks as tags: `AI check` (`--ai` palette), deterministic assertion (mono neutral tag), guard (danger tag) |
| `MatrixTable` | Plan builder | Environments × browsers checkbox grid; prod row labelled `read-only` (danger 12 px) and disabled cells |
| `QueryInput` | Test cases, Plan builder, Defects | mono input with label "Filter"/"Query", parses `key:value AND …`; shows match count chips below |
| `ResultListItem` | Run report, Review queue | Link row: mono key, bold title, 12 px meta; pill right; selected = `--surface-selected` + `aria-current="true"` |
| `IntegrationCard` | Settings | Card with title + status pill, description, one button; disabled "Coming soon" |
| `ModelStatusBox` | Nav footer | see §3.1 |

### 4.3 Icons

Inline stroke SVG (24 viewBox, stroke-width 2, `currentColor`) — use `lucide-react`. Text glyphs used in the wireframe are acceptable where shown: ✓ ✗ ● ○ ▸ ▾ ↗ ⊇ ~. No emoji. Icon-only buttons need `aria-label`.

### 4.4 Charts

Use Recharts with token colours only. Pass-rate line: one line per environment, neutral palette + `--primary` for the selected environment. Stacked suite bars: passed `--chart-1`, review `--warning-bar`, failed `--danger`. Always add a legend with text labels. Charts must render an empty state (dashed box, "No runs in this period").

---

## 5. Screens

Route prefix `p/:projectKey` = project-scoped. Wireframe = file in `docs/wireframes/`.

| # | Screen | Route | Wireframe | Layout | Key components |
|---|---|---|---|---|---|
| 01 | Workspace dashboard | `/` | [`01-dashboard`](wireframes/01-dashboard.html) | header (search, New project, **Run a plan**) → 4 `StatTile`s (pass rate 7d + sparkline, runs today + "watch" link, needs review (warning), flaky + quarantined) → row: Projects table (flex 3) + Recent runs list (flex 2) → `ModeMixBar` card | StatTile, StatusPill, ModeMixBar |
| 02 | New project wizard | `/projects/new?step=` | [`02-project-wizard`](wireframes/02-project-wizard.html) | breadcrumb → `WizardStepper` (Basics, Environments, Models, Login setup, First tests) → step body → footer Back (secondary) / Continue (ink) | Models step: S1 card (adapter select, base URL, model, API key, **Test connection**, result line, `CapabilityGrid`, Confidence policy fieldset with 2 ranges + dual-order checkbox) + side column: S2 card ("Optional" outline pill) and "Data sent to models" checkboxes + warning callout when a cloud endpoint is detected |
| 09 | Environments | `p/:key/environments/:env` | [`09-environments`](wireframes/09-environments.html) | header (+ Add environment, **Save changes**) → env `Tabs` (prod shows `read-only` danger label) → main column: General (base URL, allowed domains, default browser, locale) · Variables & secrets table (Key / Value / Type / Sent to models; secrets masked with Reveal, danger tag, "Key name only" in danger) · Test data sets grid · aside: Login setup items (Valid/Expired + Record a login / Refresh now) · Test mailbox · Safeguards checkboxes | Tabs, Table, Tag, InsetBox |
| 03 | Test cases | `p/:key/cases?suite=&q=` | [`03-test-cases`](wireframes/03-test-cases.html) | header (Import, Generate from story · S2, Record in browser, **New test case**) → `SuiteTree` aside + list card: filter row (`QueryInput` + Priority/Last result/Owner/Status dropdown buttons) → selection bar ("2 selected · Add to plan · Move · Tag · Run now" + git sync status mono tag) → table (checkbox, Key mono, Title link + tags line, Priority, Learned script, Last result pill, Owner) → pagination | SuiteTree, QueryInput, StatusPill |
| 04 | Test case editor | `p/:key/cases/:caseKey/:tab?` | [`04-case-editor`](wireframes/04-case-editor.html) | breadcrumb with mono key + `v3` → inline title input → right: "Run on" select, **Run now**, Save → `Tabs` (Steps, Parameters · n, Learned script, YAML, History, Results) → Steps: precondition strip (tags: `flow: clear-cart`, `auth: none`) + `StepGrid` + row of dashed buttons (+ Add step, + Insert shared step, Record steps from here) · aside: Details (priority/type/status selects, tags, requirement link) · Parameters mini-table · Learned script per env (Ready · 4/4 steps / Not learned) + explainer | StepGrid, Tabs, CodeBlock (YAML tab, Monaco) |
| 05 | Test plan builder | `p/:key/plans/:planId` | [`05-plan-builder`](wireframes/05-plan-builder.html) | header (Save plan, **Run plan now**) → numbered sections "1 · Which cases" (`Segmented` Saved query / Pick manually, `QueryInput`, match chips: matched / learned · replay / not learned · explore / quarantined · excluded) · "2 · Where to run" `MatrixTable` · "3 · How to run" (Mode, Retries, Parallel workers, Unattended escalations + check toggles) · aside: Triggers (cron, deploy webhook, CI, notify) · Exit criteria list + "+ Add criterion" · Estimate | MatrixTable, Segmented |
| 06 | Live run | `p/:key/runs/:runId/live` | [`06-live-run`](wireframes/06-live-run.html) | header card (blue dot + title, meta line, `RunProgressBar`, Pause / Abort) → 3 columns: `StepStatusList` + "Up next" · `BrowserFrame` + `ElementBoxOverlay` + toolbar (Take over browser, Toggle element boxes, Console · Network) · `DecisionPanel` (Approve eN primary, Pick another, Skip step; "Save approved choice into learned script" checkbox) → `EventLog` | all live components |
| 10 | Manual / hybrid execution | `p/:key/manual/:sessionId` | [`10-manual-run`](wireframes/10-manual-run.html) | breadcrumb ("assigned to you · case x of n") → h1 `KEY · Title` (24 px) → meta (env · device · mono timer) → actions (Previous case, Skip, **Finish & next case**) → `info-ai` callout for hybrid pre-run → step `article`s: done (collapsed, success pill), AI pre-run (warning "confirm?" pill), current (expanded: Pass/Fail/Blocked/N/A `Segmented` — Fail pressed = danger fill, Actual result textarea, screenshot thumb, + Attach, "Create defect from this step" link), pending (muted) · aside: My queue list with pills · Session notes textarea + "Turn note into test case draft" | Segmented, StatusPill |
| 07 | Run report & result detail | `p/:key/runs/:runId?result=` | [`07-run-report`](wireframes/07-run-report.html) | breadcrumb with mono build sha → header (Export ▾ JUnit · HTML · PDF, **Rerun failed**) → summary row of 5 `StatTile`s (Passed, Failed, Needs review, Flaky / Blocked, Exit criteria "2 of 4 not met") → master/detail: results list (`Segmented` Failed/Review/All + `ResultListItem`s) · detail card (title, Create defect / Override verdict / Edit case, `ExpectedActual`, assertion rows (deterministic + AI check with mono P value, model, "dual-order agreed"), `ScreenshotTimeline`, evidence `Tabs` (Decisions, Video, Playwright trace, Console · n, Network, Accessibility · n), decision log lines in mono) | ResultListItem, ExpectedActual, ScreenshotTimeline |
| 08 | Review queue | `p/:key/review?tab=` | [`08-review-queue`](wireframes/08-review-queue.html) | header + explainer ("Every decision you make here … recalibrate …") → `Tabs` (Uncertain verdicts · n, Heal proposals · n, Generated drafts · n, Visual changes · n) → list (`ResultListItem`) + detail: before/after columns each with eyebrow, rendered element snippet and `DiffLine`; facts row (S1 confidence, Impact, "Is this a bug?" warning box); Note textarea; actions **Approve for all N cases** (primary), Approve for this case only, Reject & create defect (danger-outline) | DiffLine, ProbabilityBar (uncertain verdicts) |
| 11 | Defects | `p/:key/defects` | [`11-defects`](wireframes/11-defects.html) | eyebrow "synced with Jira project SHOP" → header (Filter `QueryInput`, **New defect**) → table (ID mono, Title + source line, Severity tag, Failing results, Tracker link ↗ / "Not pushed", Status) · aside "New defect" form pre-filled from a result (title, severity, auto steps-to-reproduce inset, `ExpectedActual`, attachments line, Push to tracker checkbox, Re-test automatically when closed, **Create defect**) | Table, Tag |
| 12 | Analytics | `p/:key/analytics/:view` | [`12-analytics`](wireframes/12-analytics.html) | header filters (Last 30 days ▾, All environments ▾, All suites ▾, Export) → `Tabs` (Quality, Release readiness, Coverage, AI model quality) → grid: Pass rate over time (line) · Results by suite (stacked bars + legend) · Most flaky (key · title + mono %) + "Quarantine list" link · Slowest cases (mono duration · mode) → AI model quality card: 6 `StatTile`s (Escalated, Needs review, Overridden, ECE, latency p50/p95, Heal success) + "Recalibrate from n reviewed decisions" button + last-tuned date | Recharts, StatTile |
| 13 | Settings | `/settings/:section` | [`13-settings`](wireframes/13-settings.html) | eyebrow "Workspace" + h1 → vertical section nav (General, Models & endpoints, Integrations, Notifications, Users & roles `team mode`, Data & retention, Workers, API tokens & CLI, Audit log) + content: Integrations grid of `IntegrationCard`s · "Run from CI or terminal" `CodeBlock` + Create API token · Users & roles 4 role boxes | IntegrationCard, CodeBlock |

Screens in plan.md without a wireframe (Shared steps, Requirements, Test data page, Visual baselines, Run launcher modal, Run list) reuse the patterns above: list pages copy **Test cases** (table card + filter row), detail pages copy **Case editor** (tabs + aside), modals use shadcn `Dialog` with the Card styling and a footer of secondary + primary buttons.

### 5.1 States every screen must handle

- **Loading**: `Skeleton` blocks shaped like the final layout (no spinners on full pages).
- **Empty**: `EmptyState` with one clear action (e.g. "No test cases yet · New test case").
- **Error**: `Callout` tone danger at the top of the affected card with retry.
- **Placeholders** in the wireframe (`[ n ]`, `[ owner ]`, `[sha]`, hatched boxes) are slots for real data — never ship bracketed text.

---

## 6. Interaction & behaviour rules

- Primary action per page is unique and rightmost in the header.
- Destructive actions (Abort run, Reject, Delete) require a confirm `Dialog` stating the consequence.
- Long-running actions (Test connection, Run now) show inline progress text next to the button and then a result line (`Connected · decision returned in 142 ms` in success tone, or the error in danger tone).
- Live data (runs, review counts, nav badges, model status dots) updates via WebSocket/TanStack Query invalidation; no manual refresh buttons except where the wireframe shows one.
- Secrets: masked by default (`••••••••••`), Reveal is per-row and re-masks on blur/navigation; secret values never appear in logs, URLs or query cache keys.
- Keyboard: every list supports ↑/↓ + Enter; Live run decision panel: `A` approve, `P` pick another, `S` skip (scoped to the panel, shown as hints in button titles). No global key handlers that hijack typing in inputs.
- Tables: sticky header inside the scroll box; row click opens detail only when the row has exactly one primary link (use the link itself, not a row `onClick`).
- Copy voice: plain, short, sentence case. Name the model and the mode ("replay", "heal", "explore"). Use "S1"/"S2" abbreviations after first mention on a page.

## 7. Accessibility

- Text contrast ≥ 4.5:1 (all token pairs above pass on white/`--bg-app`).
- Landmarks: `nav aria-label="Main"`, `main`, `section aria-label=…` per card (as in the wireframe).
- `aria-current` for active nav/tab/step/selected item; `aria-pressed` for segmented/toggle buttons.
- Live run: decision panel is an `aria-live="polite"` region; event log is `role="log"`.
- Charts include a visually hidden data table or `aria-label` summary.

## 8. Implementation notes for agents

- Stack: React + Vite, TanStack Router + Query, Tailwind + shadcn/ui, react-hook-form + zod, Monaco for YAML, Recharts, lucide-react.
- Before building a screen, **read its file in `docs/wireframes/`** (the HTML source — inline styles show exact sizes, paddings and colours) and match structure, section order, copy and component choice. The wireframes are mid-fidelity: `[ n ]`-style placeholders and hatched boxes stand for real data; colours must come from tokens in this file, never copied as hex.
- Compare your built screen against the wireframe file side by side at 1440 px and 400 px before finishing.
- Add every new shared component to `apps/web/src/components/**` with a Storybook-free demo route `/_dev/components` (dev builds only) so later agents can reuse rather than recreate.
