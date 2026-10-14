# Security policy

## Reporting a vulnerability

Please do not open a public issue. Report it privately through
[GitHub security advisories](https://github.com/sharma-open-source/s1pilot/security/advisories/new).

Include the affected version, steps to reproduce and the impact you expect. We aim to acknowledge reports within
5 working days.

## Supported versions

Until 1.0, only the latest released `0.x` version receives security fixes.

## Areas we especially care about

- Secret values reaching a model, a log, a trace, a report, a screenshot or a URL.
- Page content being followed as instructions (prompt injection) and leading to an unapproved action.
- Bypasses of read-only production environments or of approval for sensitive actions.
- Authentication, API token scopes and the worker protocol in team deployments.
