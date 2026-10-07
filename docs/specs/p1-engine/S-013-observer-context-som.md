# S-013 · Observer: page context, history & Set-of-Marks

**Phase:** P1 · **Depends on:** S-012 · **Packages:** `@s1pilot/engine` · **Plan refs:** §6 Observer

## Goal
A complete `Observation` = elements + page context + recent actions + optional numbered screenshot, serialised compactly for models.

## Scope
- `src/observer/context.ts`: URL, title, h1–h3 headings (max 10), visible alerts/toasts (`role=alert|status`), open dialogs, form validation messages (`aria-invalid` + described-by text).
- `src/observer/history.ts`: ring buffer of last K (default 5) actions `{stepIndex, action, target name, result}`.
- `src/observer/som.ts`: Set-of-Marks screenshot — overlay numbered boxes (`e1…`) via injected CSS overlay, screenshot, remove overlay; downscale to ≤ 448 px longest side (sharp or Playwright `scale:'css'` + canvas); returns `{ png: Buffer, width, height }`. Only when model `supportsImages` and data policy allows.
- `src/observer/index.ts`: `observer.capture(page, opts) → Observation`; `serializeObservation(obs, { maxElements, redactor }) → string` (compact text: one element per line `e3 [button] "Checkout as guest" @order summary`).
- `pageFingerprint(obs) → string` (hash of URL path pattern + sorted role/name pairs of landmarks + headings) for learned scripts.

## Acceptance criteria
- [ ] Serialised observation for `/shop` cart is < 4 KB and contains every interactive element line.
- [ ] Redactor is applied to all text before serialisation (test with a secret in page text).
- [ ] SoM PNG ≤ 448 px and overlay is removed afterwards (DOM unchanged).
- [ ] Fingerprint is equal across two loads of the same page and differs when variant `shop.guest-button-renamed` is on.

## Tests
- Fixture-site tests; serialisation snapshots.

## Out of scope
- Choosing which elements to send (S-014).
