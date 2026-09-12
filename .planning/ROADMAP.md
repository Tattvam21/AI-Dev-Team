# Roadmap

## Phase 0: Environment & Skeleton
- [x] Prompt 0.1: Install Ollama and pull models <!-- completed -->
- [x] Prompt 0.2: Initialize repo skeleton <!-- completed -->
- [x] Prompt 0.3: Docker Compose for Postgres + Redis <!-- completed -->

## Phase 1: MVP Core (Local Scan & Fix)
- [x] Prompt 1.1: Ollama client wrapper with structured output + retry <!-- completed -->
- [x] Prompt 1.2: Prompt template system with versioning <!-- completed -->
- [x] Prompt 2.1: PostgreSQL Prisma schema, migrations, and seed <!-- completed -->
- [x] Prompt 4.1: Static analysis wrapper (ESLint programmatic API) <!-- completed -->
- [x] Prompt 4.2: Scanner agent (static analysis + LLM pass) <!-- completed -->
- [x] Prompt 4.3: Triage agent (deduplication & scoring) <!-- completed -->
- [x] Prompt 7.2: Fixer agent (isolated worktree diff generation) <!-- completed -->
- [x] Prompt 6.1: Basic dashboard UI (Kanban ticket queue + approve/reject) <!-- completed -->

## Phase 2: Intelligence & Verification
- [x] Prompt 3.1: AST-based import parser (relative, path aliases, dynamic imports) <!-- completed -->
- [x] Prompt 3.2: Graph builder and traversal API <!-- completed -->
- [x] Prompt 3.3: Scan cache and impacted-set calculation <!-- completed -->
- [x] Prompt 8.1: Reviewer / Critic agent <!-- completed -->
- [x] Prompt 7.4: Test-Writer agent <!-- completed -->
- [x] Prompt 7.3: Sandboxed test execution <!-- completed -->

## Phase 9: Git/Sync & GitHub Integration
- [x] Prompt 9.1: Local commit finalization (diff export & ready_to_push) <!-- completed -->
- [x] Prompt 9.2: GitHub push + PR creation (Octokit PR, rebase, and conflict handling) <!-- completed -->

## Phase 10: Hardening & Observability
- [x] Prompt 10.1: Audit log + WebSocket live updates (centralized transitions & live board) <!-- completed -->
- [x] Prompt 10.2: Error handling and timeouts pass (Ollama timeouts, distinct statuses, GET /health) <!-- completed -->
- [ ] Prompt 10.3 / Phase 11: Prompt injection defense, security & performance benchmarking

