# S-044 · UI: test case editor

**Phase:** P3 · **Depends on:** S-043 · **Packages:** `apps/web` · **Plan refs:** §2.1 Manual authoring, §8.1 Test case editor
**UI:** wireframe [`docs/wireframes/04-case-editor.html`](../../wireframes/04-case-editor.html) · design.md §5 row 04

## Goal
Author and edit a test case: steps, checks, parameters, details; view learned script, YAML and history.

## Scope
- Route `/p/:key/cases/:caseKey/:tab?` tabs: Steps, Parameters · n, Learned script, YAML, History, Results.
- Header: breadcrumb (`Test cases / Suite / Sub · KEY · vN`), inline title input, "Run on" select (env · browser), **Run now** (saves first if dirty, then `runs.create` attended → live view), Save (Ctrl/Cmd+S).
- Steps tab:
  - Precondition strip with tags (`flow: clear-cart`, `auth: none (guest)`), editable via popover.
  - `StepGrid`: # · Action (plain language, textarea autosize; `{param}` rendered as chips; autocomplete on `{` for params and `@` for shared steps, inputs) · Expected result · Checks (tags: `AI check` (default when expected text present), deterministic assertion summary tags, guard tags; "+ Add check" opens assertion builder dialog with type select and fields per S-021 type).
  - Row reorder (drag handle + keyboard), delete, duplicate; inputs line "Inputs: shipping_name, shipping_zip".
  - Buttons: + Add step, + Insert shared step (picker dialog with usage counts), Record steps from here (disabled until S-060).
- Aside: Details (Priority, Type, Status selects, tags editor, linked requirements), Parameters mini-table (edit in Parameters tab), Learned script per env (status + "Next run replays without model calls; S1 heals only changed steps.").
- Parameters tab: editable grid (columns = param names), dataset link option.
- Learned script tab: per env list of resolved actions (locator mono, action, valueRef), health, "Forget script" (confirm).
- YAML tab: Monaco editor (yaml mode) with validate + apply (`updateFromYaml`), conflict banner on version mismatch.
- History tab: versions list + side-by-side step diff.
- Results tab: last 20 results for this case (link to report).
- Unsaved-changes guard on navigation.

## Acceptance criteria
- [ ] Editing and saving bumps version shown in breadcrumb.
- [ ] Assertion builder produces summaries identical to S-021 `summary()`.
- [ ] YAML edits round-trip into the Steps tab.
- [ ] Stale save shows conflict dialog with diff and "Reload" / "Overwrite" options.

## Tests
- Component tests for StepGrid editing, assertion builder; e2e create→edit→run.

## Out of scope
- Recorder (S-060), AI generation (S-061).
