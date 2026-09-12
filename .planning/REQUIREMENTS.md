# Requirements

## Functional Requirements
- **FR-1**: Monorepo using npm workspaces connecting `apps/` and `packages/`.
- **FR-2**: LLM Gateway routing requests to local Ollama with JSON schema validation.
- **FR-3**: Scanner agent combining static analysis (ESLint) with LLM logic bug detection.
- **FR-4**: Triage agent to deduplicate and rank tickets.
- **FR-5**: Fixer agent executing in isolated git worktrees.
- **FR-6**: Reviewer agent offering an independent second opinion.
- **FR-7**: Test-Writer creating verifiable red-to-green regression tests.
- **FR-8**: Git/Sync agent managing branches, rebases, and GitHub PRs without force-pushing.
- **FR-9**: Web dashboard with Kanban queue and Monaco diff viewer.

## Non-Functional Requirements
- **NFR-1**: Fast local inference using tiered models (8B for high-frequency scan, 24B-30B for fix/review).
- **NFR-2**: Zero unapproved changes merged to `main` (2 human checkpoints).
- **NFR-3**: Subprocess/Docker sandboxing with timeout and resource limits.
