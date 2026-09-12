# AI Dev Team — Technical Architecture & Build Guide

A deep technical companion to the project spec: what components exist, what tech powers each one, how data flows end-to-end, the database schema, the API surface, and every feature the system should have.

---

## 1. System Overview

The system has five layers:

1. **Client layer** — a web dashboard (and optionally a CLI) the human uses to trigger scans and approve/reject work.
2. **API/Orchestrator layer** — a backend service that owns state (the ticket lifecycle) and exposes REST + WebSocket endpoints.
3. **Job queue layer** — decouples "a ticket needs work" from "an agent is currently doing that work," so agents run asynchronously and can retry/scale independently.
4. **Agent worker layer** — the actual LLM-powered workers (Scanner, Triage, Fixer, Reviewer, Test-Writer) plus non-LLM workers (Git/Sync).
5. **Data layer** — a relational database for tickets/patches/reviews, plus a dependency graph and scan cache.

```
┌─────────────┐      REST/WS      ┌──────────────────┐
│  Dashboard  │◄─────────────────►│   Orchestrator    │
│  (React)    │                   │   (API + State    │
└─────────────┘                   │    Machine)       │
                                   └─────────┬─────────┘
                                             │ enqueues jobs
                                   ┌─────────▼─────────┐
                                   │   Job Queue        │
                                   │ (Redis + BullMQ/   │
                                   │  Celery)            │
                                   └─────────┬─────────┘
                     ┌───────────────────────┼───────────────────────┐
             ┌───────▼──────┐        ┌───────▼──────┐        ┌───────▼──────┐
             │   Scanner    │        │    Fixer     │        │  Git/Sync    │
             │   Worker     │        │   Worker     │        │   Worker     │
             └───────┬──────┘        └───────┬──────┘        └───────┬──────┘
                     │                       │                       │
             ┌───────▼───────────────────────▼───────┐       ┌───────▼──────┐
             │           LLM Gateway                  │       │  Git / GitHub │
             │     (Anthropic API wrapper)            │       │      API      │
             └─────────────────────────────────────────┘      └──────────────┘
                     │
             ┌───────▼───────────────────────────────┐
             │   Dependency Graph + Scan Cache         │
             │   (Postgres/SQLite tables)               │
             └─────────────────────────────────────────┘
                     │
             ┌───────▼───────────────────────────────┐
             │   Tickets / Patches / Reviews DB         │
             └─────────────────────────────────────────┘
```

---

## 2. Tech Stack (with rationale)

| Layer | Recommended | Why | Alternative |
|---|---|---|---|
| Backend language | **Node.js + TypeScript** | Same language as frontend, huge ecosystem for git tooling and GitHub SDKs | Python + FastAPI (better if your static analysis tooling is Python-heavy) |
| API framework | **Fastify** or Express | Lightweight, fast, good WebSocket support | FastAPI (Python) |
| Job queue | **BullMQ + Redis** | Battle-tested, retries/backoff/priorities built in | Celery + Redis (Python) |
| Database | **PostgreSQL** (SQLite for local single-user mode) | Relational data (tickets, patches, graph edges) fits SQL well; JSON columns handle flexible fields | SQLite everywhere for MVP simplicity |
| ORM | **Prisma** (Node) | Type-safe schema, migrations built in | SQLAlchemy (Python) |
| LLM | **Anthropic API (Claude)** | Structured output via tool use, strong code reasoning | — |
| Git (local) | **simple-git** | Thin wrapper over the `git` CLI, reliable | isomorphic-git (pure JS, no CLI dependency) |
| GitHub API | **Octokit** (`@octokit/rest`) | Official SDK, handles auth/pagination | PyGithub (Python) |
| Static analysis | **ESLint + Semgrep** (JS/TS), **Ruff + Pylint** (Python) | Deterministic, cheap, catches the "obvious" bugs before burning LLM calls | Language-specific linters as needed |
| Dependency graph parsing | **TypeScript Compiler API** or `@babel/parser` (JS/TS), Python `ast` module | AST-accurate import resolution, not regex guessing | `madge` / `dependency-cruiser` (JS/TS), `pydeps` (Python) as prebuilt CLI tools |
| Multi-language parsing (future) | **tree-sitter** | One parsing library, many language grammars — useful once you support multiple stacks | — |
| File watching | **chokidar** | Reliable cross-platform file-change detection | `watchdog` (Python) |
| Sandbox/test execution | **Docker** | Full isolation, reproducible environment per project | subprocess + `ulimit`/resource limits (lighter weight, less safe) |
| Frontend | **React + TypeScript + TailwindCSS** | Fast to build a ticket-queue/dashboard UI | Vue/Svelte if you prefer |
| Diff viewer | **Monaco Editor** (diff mode) or `react-diff-viewer` | Shows the Fixer's patch in a readable side-by-side view | — |
| Real-time updates | **WebSocket (Socket.io or native `ws`)** | Push ticket status changes to the dashboard live | Polling (simpler, less real-time) |
| Auth (GitHub) | **GitHub App** with installation tokens | Scoped, revocable, no personal token floating around | Personal Access Token (simpler for solo MVP use) |
| Secrets | `.env` locally + OS keychain (`keytar`) | Keeps API keys out of source control and plaintext files | — |

---

## 3. Component-by-Component Detail

### 3.1 Orchestrator (the core service)
- Implements the **ticket state machine**. States: `found → triaged → approved → fixing → in_review → approved_by_reviewer → awaiting_human → pushed → merged` (plus `rejected` and `failed` branches at any stage).
- A state machine library (e.g. **XState** in Node, or a hand-rolled enum + transition-table in either language) keeps this from turning into scattered `if` statements as you add agents.
- Every state transition is written to an **audit log** table — this matters both for debugging agent behavior and for the human to trust what happened.
- Exposes:
  - REST endpoints for CRUD on projects/tickets/patches (see §6).
  - A WebSocket channel that pushes ticket-state-change events to the dashboard in real time.

### 3.2 Job Queue
- Every agent invocation is a **job**, not a direct function call — this is what lets you retry a failed Fixer run, rate-limit LLM calls, and run multiple agents concurrently without them stepping on each other.
- Queue design: one queue per agent type (`scanner-queue`, `fixer-queue`, `reviewer-queue`, `git-queue`) so you can control concurrency per stage independently (e.g. only 1 Git/Sync job at a time to avoid branch conflicts, but 5 Scanner jobs in parallel).
- Jobs carry a `ticket_id` and enough context to be re-run idempotently.

### 3.3 LLM Gateway
A thin internal service every agent calls through — don't let agents call the Anthropic API directly. It centralizes:
- **Prompt templates**, versioned per agent role (stored as files, e.g. `prompts/scanner.md`, `prompts/fixer.md`) so you can iterate on prompts without redeploying agent logic.
- **Structured output enforcement** — use Claude's tool-use/function-calling to force each agent's response into a JSON schema (ticket, patch, review) instead of parsing freeform text. This is the single biggest reliability lever you have.
- **Retry/backoff** on rate limits or transient errors.
- **Context budgeting** — decides how much code/context to include per call (this is where the dependency graph earns its keep: only include the flagged file + its 1-hop neighbors, not the whole repo).
- **Cost/token logging** per ticket, so you can see which tickets are expensive to process.

### 3.4 Dependency Graph Engine
- Parses each file's imports using a real AST parser (TypeScript Compiler API, Babel, or Python's `ast` module) — regex-based import detection breaks on edge cases (dynamic imports, aliased paths, re-exports).
- Produces a directed graph: `file_edges(from_file, to_file, edge_type)` where `edge_type` is `imports`, `calls`, or `same_module`.
- Rebuilt incrementally: file-watcher detects a change → re-parse only that file's edges → update the graph, not the whole thing.
- Exposes a simple traversal API internally: `getNeighbors(file, hops=1)` used by both the Scanner (root-cause context) and the Scan Cache (impacted-set calculation).

### 3.5 Scan Cache Engine
- SHA-256 content hash per file, stored with the last scan's results.
- On each scan run: compute current hashes → diff against stored hashes → any changed file, plus anything reachable from it in the dependency graph, becomes the **impacted set**.
- Only the impacted set goes through static analysis + LLM review; everything else reuses cached ticket results.
- This is what makes file-save-triggered local scanning fast enough to be usable continuously rather than run-on-demand only.

### 3.6 Agent Workers (general pattern)
Every agent worker follows the same shape:
1. Pull a job off its queue.
2. Fetch relevant context from the DB (ticket, file contents, dependency graph neighbors).
3. Build a prompt from its template + context.
4. Call the LLM Gateway, requesting structured output.
5. **Validate** the response against a schema (Zod in TypeScript, Pydantic in Python) — reject and retry once if the LLM returns malformed output.
6. Write the result to the DB.
7. Emit an event so the Orchestrator advances the ticket's state.

### 3.7 Git/Sync Worker (no LLM for the mechanical parts)
- Local: `simple-git` creates an isolated **git worktree** per ticket (not just a branch — a worktree gives the Fixer a fully separate working directory, so it can't accidentally touch files the human is currently editing).
- Commits with an LLM-generated message (short call to the LLM Gateway, cheap).
- Remote: pushes the branch, then calls the **GitHub REST API** (via Octokit) to open a PR with an LLM-written description (ticket summary + what changed + tests added).
- Before pushing: fetches latest `main`/`origin` and checks for conflicts; on conflict, flags the ticket as `failed` with a note rather than force-pushing.

### 3.8 Sandbox / Execution Engine
- Runs the project's test suite inside a **Docker container** built from the project's own dependency manifest (detects `package.json` → Node image, `requirements.txt`/`pyproject.toml` → Python image).
- Enforces a timeout and memory/CPU limits so a runaway test (or an infinite loop the Fixer accidentally introduced) can't hang the pipeline.
- Captures stdout/stderr and exit code, returns structured pass/fail + logs to the Fixer and Reviewer agents.
- For a lighter-weight MVP: a subprocess with `ulimit`/resource constraints instead of full Docker — faster to build, less isolation.

### 3.9 Dashboard (frontend)
- **Ticket queue view**: kanban-style columns (Found → Triaged → In Progress → Awaiting Approval → Done), updated live via WebSocket.
- **Diff viewer**: Monaco Editor's diff mode (same engine VS Code uses) to show the Fixer's patch clearly, with syntax highlighting.
- **Approve/Reject controls** at both checkpoints (ticket approval, final patch approval), calling the REST API.
- **Audit trail view**: per-ticket timeline of every agent action, useful for trust and debugging.

---

## 4. Database Schema (PostgreSQL/SQLite)

```sql
CREATE TABLE projects (
  id            UUID PRIMARY KEY,
  name          TEXT NOT NULL,
  local_path    TEXT,
  github_repo   TEXT,          -- e.g. "owner/repo", null for local-only
  created_at    TIMESTAMP DEFAULT now()
);

CREATE TABLE files (
  id            UUID PRIMARY KEY,
  project_id    UUID REFERENCES projects(id),
  path          TEXT NOT NULL,
  content_hash  TEXT,
  last_scanned_at TIMESTAMP
);

CREATE TABLE file_edges (
  from_file_id  UUID REFERENCES files(id),
  to_file_id    UUID REFERENCES files(id),
  edge_type     TEXT CHECK (edge_type IN ('imports','calls','same_module')),
  PRIMARY KEY (from_file_id, to_file_id, edge_type)
);

CREATE TABLE scan_cache (
  file_id           UUID REFERENCES files(id) PRIMARY KEY,
  content_hash      TEXT NOT NULL,
  dependency_hashes JSONB,        -- { "other_file_id": "hash" }
  cached_ticket_ids UUID[],
  last_scanned_at   TIMESTAMP
);

CREATE TABLE tickets (
  id              UUID PRIMARY KEY,
  project_id      UUID REFERENCES projects(id),
  symptom_file_id UUID REFERENCES files(id),
  root_cause_file_id UUID REFERENCES files(id),  -- nullable, set if different from symptom
  line_start      INT,
  line_end        INT,
  title           TEXT NOT NULL,
  description     TEXT NOT NULL,
  severity        TEXT CHECK (severity IN ('critical','high','medium','low')),
  confidence      FLOAT,
  status          TEXT NOT NULL DEFAULT 'found',
  created_at      TIMESTAMP DEFAULT now(),
  updated_at      TIMESTAMP DEFAULT now()
);

CREATE TABLE patches (
  id              UUID PRIMARY KEY,
  ticket_id       UUID REFERENCES tickets(id),
  branch_name     TEXT NOT NULL,
  diff            TEXT NOT NULL,
  rationale       TEXT,
  status          TEXT NOT NULL DEFAULT 'awaiting_review',
  created_at      TIMESTAMP DEFAULT now()
);

CREATE TABLE reviews (
  id              UUID PRIMARY KEY,
  patch_id        UUID REFERENCES patches(id),
  verdict         TEXT CHECK (verdict IN ('pass','fail')),
  notes           TEXT,
  reviewed_at     TIMESTAMP DEFAULT now()
);

CREATE TABLE test_runs (
  id              UUID PRIMARY KEY,
  patch_id        UUID REFERENCES patches(id),
  passed          BOOLEAN,
  logs            TEXT,
  duration_ms     INT,
  ran_at          TIMESTAMP DEFAULT now()
);

CREATE TABLE audit_log (
  id              UUID PRIMARY KEY,
  ticket_id       UUID REFERENCES tickets(id),
  actor           TEXT NOT NULL,      -- 'scanner' | 'fixer' | 'human' | etc.
  action          TEXT NOT NULL,      -- 'created' | 'approved' | 'rejected' | 'state_change'
  details         JSONB,
  created_at      TIMESTAMP DEFAULT now()
);
```

---

## 5. API Design (REST + WebSocket)

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/projects` | Register a new project (local path or GitHub repo) |
| `POST` | `/projects/:id/scan` | Trigger a scan (full or incremental) |
| `GET` | `/projects/:id/tickets` | List tickets, filterable by status/severity |
| `GET` | `/tickets/:id` | Ticket detail, including root-cause file if set |
| `POST` | `/tickets/:id/approve` | Human approves a ticket → enqueues Fixer job |
| `POST` | `/tickets/:id/reject` | Human rejects a ticket → closes it |
| `GET` | `/tickets/:id/patch` | Get the current patch/diff for a ticket |
| `POST` | `/patches/:id/approve` | Human approves the diff → enqueues Git/Sync job |
| `POST` | `/patches/:id/reject` | Sends ticket back to Fixer with human notes |
| `GET` | `/tickets/:id/audit` | Full timeline of agent actions on this ticket |
| `WS` | `/ws/projects/:id` | Live ticket state updates for the dashboard |

Auth: a simple API key/session for the dashboard-to-backend calls; a separate GitHub App installation token for backend-to-GitHub calls (never expose the GitHub token to the frontend).

---

## 6. End-to-End Working (concrete walkthrough)

1. **Trigger**: User clicks "Scan" in the dashboard, or saves a file locally (chokidar fires a change event).
2. **Impacted-set calculation**: Scan Cache Engine hashes changed files, walks the dependency graph to find dependents, builds the impacted set.
3. **Static pass**: ESLint/Semgrep (or language equivalent) run against the impacted set — fast, deterministic findings go straight into tickets.
4. **LLM pass**: For files still ambiguous after static analysis, the Scanner worker pulls the file + its 1-hop dependency-graph neighbors, sends it to the LLM Gateway with the Scanner prompt template, and gets back structured findings (with `root_cause_file` if different from the symptom file).
5. **Ticket creation**: Findings are written to the `tickets` table, status `found`.
6. **Triage**: A Triage job dedupes/scores tickets, updates `severity`/`confidence`, status → `triaged`. Dashboard shows the queue live via WebSocket.
7. **Human approval #1**: User reviews the ticket queue, clicks Approve on a ticket. Status → `approved`, a Fixer job is enqueued.
8. **Fix**: Fixer worker creates an isolated git worktree, generates a diff via the LLM Gateway, writes it to the `patches` table. Test-Writer worker (separate job) adds/updates tests in the same worktree.
9. **Sandbox test run**: The Sandbox Engine runs the test suite in a container against the worktree; results go to `test_runs`.
10. **Review**: Reviewer worker checks the diff + test results independently, writes a verdict to `reviews`. On `fail`, ticket loops back to step 8 (capped retries) with the Reviewer's notes as extra context.
11. **Human approval #2**: On `pass`, the patch surfaces in the dashboard's diff viewer. User approves.
12. **Ship**: Git/Sync worker commits, pushes the branch, opens a GitHub PR with an LLM-written description. Ticket status → `pushed`.
13. **Merge**: Human merges the PR on GitHub through normal review (outside the tool). Optionally, a GitHub webhook flips the ticket to `merged` when that happens.

---

## 7. Full Feature List

**Core (MVP)**
- Local project scanning (on-demand + file-watcher triggered)
- Static analysis integration (ESLint/Semgrep or language equivalent)
- LLM-based deeper bug detection for logic-level issues
- Ticket queue UI with approve/reject
- Fixer-generated diffs, shown to human before any git action
- Manual patch application (copy diff, no auto-git yet)

**Phase 2+**
- Dependency graph-based root-cause tracing (`root_cause_file` vs `symptom_file`)
- Scan memory / incremental scanning via content-hash caching
- Automated git branch/commit/local push
- Reviewer/Critic second-opinion agent before human sees the diff
- Test-Writer agent (auto-generates regression tests)
- Sandboxed test execution (Docker)

**Phase 3+**
- GitHub App auth + remote repo support
- Auto branch push + PR creation with LLM-written description
- Webhook-triggered scans on push/PR
- Audit log / full action history per ticket

**Phase 4+ (scale-out)**
- Additional agent types: security scanner, performance scanner, dependency-upgrade agent
- Multi-project/multi-repo dashboard
- Auto-approve rules for high-confidence, low-risk fixes (e.g. lint-only changes)
- Cost/token usage dashboard per project
- Multi-language support via tree-sitter-based parsing

---

## 8. Security & Safety Considerations

- **No agent ever merges or force-pushes** — every write to `main`/remote requires explicit human approval at the patch-approval checkpoint.
- **Sandboxed execution** — Fixer's code never runs against the user's live working directory; it's always an isolated worktree/container.
- **Scoped GitHub auth** — prefer a GitHub App with minimal repo permissions (contents + pull-requests) over a broad personal access token.
- **Secrets never touch the LLM context** — strip `.env` files, API keys, and credentials from anything sent to the LLM Gateway; a simple denylist on file patterns (`.env`, `*.pem`, `secrets/*`) before context assembly.
- **Audit log is append-only** — every agent action and human decision is recorded, so any fix that reaches production is traceable back to the ticket, the diff, the reviewer verdict, and who approved it.
- **Rate/cost limits** — cap LLM calls per project per hour to avoid runaway spend from a misbehaving file-watcher loop.

---

## 9. Suggested Repo Structure

```
ai-dev-team/
├── apps/
│   ├── dashboard/          # React frontend
│   └── api/                # Orchestrator (Fastify/Express)
├── packages/
│   ├── agents/
│   │   ├── scanner/
│   │   ├── triage/
│   │   ├── fixer/
│   │   ├── reviewer/
│   │   ├── test-writer/
│   │   └── git-sync/
│   ├── llm-gateway/        # Anthropic API wrapper, prompt templates
│   ├── dependency-graph/   # AST parsing + graph traversal
│   ├── scan-cache/         # hashing + impacted-set logic
│   └── db/                 # Prisma schema + migrations
├── prompts/                # versioned prompt templates per agent
├── docker/                 # sandbox container definitions
└── docker-compose.yml      # local dev: postgres, redis, api, dashboard
```

---

## 10. Local Dev Setup (order of operations)

1. `docker-compose up` for Postgres + Redis.
2. Run Prisma (or Alembic) migrations to create the schema in §4.
3. Start the API/Orchestrator service.
4. Start one worker process per agent queue (can run in the same process for MVP, split later for scale).
5. Start the dashboard, point it at the API's REST + WebSocket URLs.
6. Register a project (local path) via the dashboard or a `POST /projects` call.
7. Trigger a scan and watch tickets populate in real time.
