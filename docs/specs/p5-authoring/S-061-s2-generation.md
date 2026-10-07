# S-061 · System 2 test generation

**Phase:** P5 · **Depends on:** S-010, S-047 · **Packages:** `apps/server`, `apps/web`, `@s1pilot/runner` · **Plan refs:** §2.1 AI generation, §8.1 "Generate from story", crawl suggestions

## Goal
Draft test cases from a user story / acceptance criteria, or from exploring a URL; drafts always go to review.

## Scope
- `generate.fromStory({ projectKey, storyText, requirementKey?, count? })`: S2 JSON-mode prompt → `TestCaseFile[]` validated by zod; steps as action/expected, tags, priority guess; created as `status: draft`, `generatedBy: 's2'`, linked requirement.
- `generate.fromCrawl({ projectKey, environment, maxPages: 20 })`: crawl same-origin links (BFS, respects allowDomains, read-only), summarise each page's forms/main actions → S2 suggests smoke tests → drafts.
- Review queue "Generated drafts" tab: list drafts with preview (steps grid read-only), Accept (status → ready) / Edit (opens editor) / Discard; track acceptance metrics (accepted as-is, edited, discarded) for the P5 exit criterion.
- UI: "Generate from story · S2" dialog in Test cases (textarea + requirement select + count); disabled with tooltip when no S2 configured. Wizard step 5 option "Suggest tests by exploring the site".

## Acceptance criteria
- [ ] With a fake S2 returning fixture JSON, 3 drafts are created and appear in review.
- [ ] Invalid S2 output is repaired once or reported, never partially saved.
- [ ] Crawl never submits forms and stays within allowed domains.

## Tests
- API tests with fake S2; crawl test on fixture sites.

## Out of scope
- Fine-tuning prompts per model.
