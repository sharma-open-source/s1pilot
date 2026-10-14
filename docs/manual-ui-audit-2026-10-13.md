# Manual UI Audit

**Date:** 2026-10-13
**Target:** `http://127.0.0.1:5317`
**Project inspected:** `PLAY2`

## Summary

The dashboard, case authoring, run reports, plan configuration, and most settings pages load with populated project data. Two functional defects were reproducible: plan query previews return incorrect zero counts, and the Analytics Quality view cannot transform several server responses. The environment screen also exposes a password-named entry as an ordinary, model-shareable variable, which is a data-classification risk.

This was an exploratory, read-only browser audit. No project records were saved, no runs were started, no files were imported or exported, no credentials were entered, and no purge/delete/send actions were triggered.

## Findings

### P1 — Plan query preview disagrees with the case list

In `/p/PLAY2/plans/new`, entering `priority<=P2` reports **0 cases match**. The case list at `/p/PLAY2/cases?q=priority%3C%3DP2` returns **10 cases**, all shown with priority P2. The preview can therefore tell users that a valid plan selects nothing even when matching cases exist.

### P1 — Analytics Quality sections fail to load

At `/p/PLAY2/analytics/quality`, Pass rate over time, Results by suite, and AI model quality display “Could not load this section: Unable to transform response from server.” Retrying the pass-rate section reproduces the error. The separate Readiness, Coverage, and AI model quality routes rendered data successfully.

### P1 — Password-named environment variable is visible and marked shareable

The `dev` environment lists a password-named entry as type **Variable**, shows its value in clear text, and marks it **Key + value** for model sharing. No value is reproduced here. Treat this as a security/data-classification risk: real credentials should be stored as secrets and excluded from model context; consider warning or blocking password-like keys in ordinary variables.

### P2 — Test data upload controls lead to an unavailable API

The Environment page displays CSV/JSON upload controls, but its Test data sets card reports that datasets are unavailable from the server (HTTP 404). The UI affordance suggests a capability that cannot currently complete.

### P2 — Domain-safeguard toggle is disabled

The environment editor exposes an editable Allowed domains field, but the separate “Block navigation outside allowed domains” toggle is disabled. The page says non-empty allowed domains are enforced, so enforcement is controlled indirectly through the list and cannot be switched independently from this toggle.

### P2 — Retry attempts are not distinguishable in the report list

The latest failed run summarizes one failed case, but the result list shows three repeated rows for `PLAY2-TC-16` without a visible attempt number. This makes retry history look like duplicate failures rather than separate attempts.

### P2 — Manual execution is not reachable from the plan builder

Manual testing opens, but the personal queue says nothing is assigned. The plan builder inspected has no manual/hybrid assignment controls, so the UI does not provide a visible path to populate that queue. Manual session completion could not be exercised with the current project data.

## Available but Limited or Unverified

- Visual comparison is labelled “later” and disabled in the plan builder; the review queue’s Visual changes tab has no items.
- Users and roles, and the Audit log, explicitly report that they are available only in team mode.
- The issue-tracker integrations are disconnected. Notifications has a channel but no rules, so a new delivery rule was not verified.
- The MCP integration is marked Coming soon.
- Import opens a four-step flow for supported formats; Preview stays disabled until a file is selected. No file was uploaded.
- Export links are present for JUnit, HTML, JSON, and PDF, but downloads were not triggered.
- The case list reports 13 unsynced `.s1pilot/` changes. This project state was left untouched.

## Observed Working

- Dashboard metrics, project navigation, and current model reachability after page load.
- Case list, priority query filtering, case editor sections, and import dialog.
- Plan list and configuration controls for query/manual selection, environment/browser/device matrix, execution mode, retries, workers, checks, schedule, and exit criteria. Query preview is covered by the defect above.
- Runs list and run report with summary, result details, step timeline/screenshots, decision evidence, console/network/accessibility tabs, and export links.
- Defect list/form, review queue, manual queue page, Shared steps and Requirements library pages.
- Analytics Readiness, Coverage, and the separate AI-quality view.
- Workspace general/model settings, notification history, retention controls, worker status, API-token list, and CI command display.

The latest report showed 9 passed and 1 failed. Its failed result was attributed to a console check (`querySelector('#')` is an invalid selector) in the tested target page; this is test-target evidence, not a defect in the S1-Pilot UI itself.

## Audit Limits

No destructive actions, state-changing saves, model probes, live runs, notification sends, tracker connections, token creation, or real integration calls were exercised. The report describes the instance served on port 5317 only; the repository already contained staged source changes during the audit, and they were not modified.

## Recheck: 2026-10-14

The following statuses reflect the current `127.0.0.1:5317` instance. The original findings above are retained as the initial audit record.

- **Plan query preview: fixed.** `priority<=P2` previews 13 cases; the case list shows 13 cases, each at P2. Typing the query emitted one transient HTTP 400 before the valid preview settled.
- **Analytics Quality: fixed.** Pass-rate trend, results by suite, flaky cases, slowest cases, execution-mode mix, and AI-quality metrics all rendered.
- **Password-named environment value: partially fixed.** The row is now marked secret-related and model exposure is shown as key-only/not-sent. The populated value is still held in a `text` input, so it remains visible in the environment editor.
- **Test data endpoint: fixed at page level.** The unavailable-server/HTTP 404 message is gone and the CSV/JSON upload control is visible. Upload/commit was not exercised.
- **Domain-safeguard toggle: still disabled.** Allowed domains remain editable, but the independent “Block navigation outside allowed domains” checkbox is disabled.
- **Retry reporting: fixed.** Result rows now identify attempts (for example, attempt 1 of 2 and 2 of 2) and show per-attempt durations.
- **Checkout target warning: still present, but not the verdict cause.** The latest `PLAY2-TC-16` result still flags `querySelector('#')` as a console warning; the report says the verdict is unchanged. The run was blocked at step 7 while filling the UPI ID. This remains a target/test-data issue to clean up before using the case as a benchmark.
- **Manual/hybrid plan setup: UI gap fixed.** The plan builder now offers per-case Automated, Manual, and Hybrid choices. No plan was saved or run, so queue creation and session completion were not retested.
- **Audit log: fixed for local mode.** The page now shows local-admin events, filter controls, and CSV export. User administration remains team-mode-only; clicking Invite user displays that local mode uses a single local admin.
- **External integrations: still unconnected.** Jira, GitHub Issues, Linear, CI, and chat/webhook integrations show Not connected. Notifications still has a channel but no rules. MCP remains marked Coming soon; visual comparison remains disabled as “later.”

The case list currently reports 16 unsynced `.s1pilot/` changes. No project data was changed during this recheck.