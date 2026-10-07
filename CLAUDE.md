# CLAUDE.md

All project instructions for agents live in **[AGENTS.md](AGENTS.md)** — read it first and follow it.

@AGENTS.md

## Claude Code specifics

- **Orchestrating sub-agents:** run specs from `docs/specs/README.md` in numeric order, one sub-agent per spec. Specs marked ∥ in the sequence table may run in parallel with the previous one. Give each sub-agent the prompt template from `docs/specs/README.md` and the spec path; for UI specs also name `docs/design.md` and the wireframe file from the spec's **UI:** line.
- After each sub-agent finishes, review its summary against the spec's acceptance criteria before starting the next spec.
- Use `isolation: "worktree"` for parallel (∥) sub-agents so they don't edit the same working tree.
- The original wireframe canvas is https://claude.ai/artifact/7JqTPxRmPXkBATqh5opk6u; `docs/wireframes/` is the local export. If the canvas changes, re-export before UI work continues.
