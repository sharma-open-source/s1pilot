# S-064 · Issue trackers (Jira, GitHub Issues, Linear)

**Phase:** P6 · **Depends on:** S-054, S-059 · **Packages:** `@s1pilot/integrations`, `apps/server`, `apps/web` · **Plan refs:** §2.6, §12

## Goal
Push defects to external trackers, sync status back, and trigger re-tests on close.

## Scope
- `IssueTracker` interface: `testConnection`, `createIssue(defect, attachments)`, `getStatus(externalId)`, `mapStatus(external) → DefectStatus`, `addComment`.
- Implementations: Jira Cloud (REST v3, API token/email; project + issue type mapping; attachments upload), GitHub Issues (token; labels), Linear (GraphQL; team).
- Credentials stored via vault; configured per project (Settings › Integrations › Jira card + per-project mapping in project settings).
- Status sync: poll every 10 min (and webhook endpoints for Jira/GitHub when configured) → update local defect → re-test hook (S-054).
- Defects UI: "Push to <tracker>" enabled; tracker column shows link ↗; eyebrow "synced with Jira project SHOP".

## Acceptance criteria
- [ ] With HTTP fixtures, creating a defect pushes issue with title, repro steps, expected/actual, environment and screenshot attachment.
- [ ] External close → local `fixed` → re-test queued.
- [ ] Credentials never returned to UI.

## Tests
- Contract tests per tracker with recorded fixtures.

## Out of scope
- Bidirectional comment sync.
