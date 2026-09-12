# AI Dev Team — Project Specification

An agent-based tool that behaves like a small software team: agents scan a project (local or GitHub-hosted) for bugs, propose fixes, get human approval, and push the result to GitHub as a reviewable PR.

---

## 1. Problem & Goal

Manual bug-finding and fixing is slow and repetitive. The goal is a tool where specialized LLM-powered agents handle each stage of that work — finding issues, prioritizing them, fixing them, reviewing the fix, and shipping it — while a human stays in control at the approval gates. The system should work on:
- A **local project folder** on the user's machine, and
- A **GitHub repository**, with the ability to push fixes back as a PR.

---

## 2. Core Principles

1. **Human approves, agents execute.** No agent merges to `main` or pushes without explicit human sign-off (configurable later for low-risk auto-fixes).
2. **Structured data over freeform text.** Every agent produces a schema-based output (ticket, patch, review verdict) — not paragraphs the human has to parse.
3. **One agent proposes, another checks.** Fixer and Reviewer are separate agents/prompts so mistakes get caught before a human sees them.
4. **Sandbox everything.** Agents never touch the working branch directly — all work happens in an isolated branch/worktree.
5. **Start narrow.** MVP supports one language/stack, not "any project."

---

## 3. Agent Roster

| Agent | Input | Output | LLM needed? |
|---|---|---|---|
| **Scanner** | Codebase / changed files | List of Tickets | Yes |
| **Triage** | Raw tickets | Deduped, prioritized tickets | Yes (light) |
| **Fixer** | Approved ticket | Code diff + rationale | Yes |
| **Reviewer/Critic** | Diff + ticket | Pass/fail + notes | Yes |
| **Test-Writer** | Diff + ticket | New/updated test files | Yes |
| **Git/Sync** | Approved diff | Branch, commit, push, PR | No (API/CLI only) |
| **Orchestrator** | All ticket state | Routes work, enforces gates | No (logic only) |

### 3.1 Scanner Agent
- Runs static analysis tools first (ESLint, Semgrep, Pylint, etc. depending on stack) — cheap and deterministic.
- Sends ambiguous/logic-level code to the LLM for deeper review (e.g. "this function's return type doesn't match its usage").
- Triggers: on-demand ("scan now"), on file save (local), or on push/PR (GitHub mode).
- **Cross-file/root-cause resolution** (see §6): before writing a ticket, it pulls in directly connected files — anything the flagged file imports, and anything that imports the flagged file — so it can tell whether the real problem lives elsewhere (e.g. a bad value coming in from a caller, not the function itself).
- **Scan memory** (see §7): skips re-analyzing files that haven't changed since the last scan, using the dependency graph + content hashing.
- Output: **Ticket** objects (see §5), now including `root_cause_file` when it differs from the file where the symptom appeared.

### 3.2 Triage Agent
- Deduplicates tickets that point to the same root cause.
- Scores severity/confidence (e.g. `critical | high | medium | low`, `confidence: 0-1`).
- Groups related tickets (e.g. one bad function used in 5 places = 1 ticket, not 5).

### 3.3 Fixer Agent
- Only acts on **approved** tickets.
- Works in an isolated git worktree/branch.
- Produces a diff plus a short rationale ("changed X because Y").
- Re-runs the existing test suite locally before handing off.

### 3.4 Reviewer/Critic Agent
- Independent pass over the Fixer's diff — ideally a different prompt/context so it isn't just agreeing with itself.
- Checks: does this actually fix the ticket? Does it break anything else? Is the diff minimal and safe?
- Can reject and bounce back to the Fixer with specific feedback (bounded retry loop, e.g. max 2 retries).

### 3.5 Test-Writer Agent
- Writes/updates tests covering the fixed code path.
- Confirms (by running them) that the new test fails on the pre-fix code and passes on the post-fix code — this proves the test is meaningful, not just decorative.

### 3.6 Git/Sync Agent (no LLM needed for the mechanics)
- Creates a feature branch per ticket (e.g. `fix/ticket-042-null-check`).
- Stages, commits (LLM writes the commit message), pushes to GitHub.
- Opens a PR via the GitHub REST/GraphQL API, with an LLM-written PR description summarizing the ticket + fix + tests added.
- Detects merge conflicts before pushing and flags them back to the Orchestrator instead of force-pushing.

### 3.7 Orchestrator (not an LLM agent — your app's core logic)
- Owns the ticket state machine: `found → triaged → approved → fixing → in_review → approved_by_reviewer → awaiting_human → pushed → merged`.
- Enforces the human-approval gates (after Triage, after Reviewer).
- Decides which agent runs next based on current state.
- This is the piece you'll spend the most real engineering time on — it's a queue + state machine, not a prompt.

---

## 4. Workflow

```
1. Scanner runs (on trigger) → creates Tickets
2. Triage groups/prioritizes → Ticket queue shown to human
3. Human approves/rejects/edits tickets in the queue UI
4. Orchestrator dispatches approved ticket → Fixer
5. Fixer produces diff (in isolated branch) → Test-Writer adds/updates tests
6. Reviewer checks diff + tests → pass or reject-with-feedback (loop to step 5, capped retries)
7. On reviewer pass → surfaced to human for final approval
8. Human approves → Git/Sync agent commits, pushes, opens PR
9. Human merges PR on GitHub (outside the tool, normal review process)
```

Two human checkpoints by design: **ticket approval** (don't waste compute fixing things nobody wants fixed) and **final diff approval** (don't push code nobody's seen). You can later make checkpoint 2 optional for very high-confidence, low-risk fixes (e.g. lint-only changes).

---

## 5. Data Schemas (draft)

**Ticket**
```json
{
  "id": "ticket-042",
  "source": "scanner",
  "file": "src/utils/parse.js",
  "line_range": [112, 118],
  "title": "Missing null check before .map()",
  "description": "parseItems() will throw if `items` is undefined, seen when API returns 204.",
  "severity": "high",
  "confidence": 0.82,
  "status": "found",
  "created_at": "2026-09-01T10:00:00Z"
}
```

**Patch**
```json
{
  "ticket_id": "ticket-042",
  "branch": "fix/ticket-042-null-check",
  "diff": "<unified diff>",
  "rationale": "Added a guard clause; returns [] instead of throwing on undefined items.",
  "tests_added": ["test/utils/parse.test.js"],
  "status": "awaiting_review"
}
```

**Review**
```json
{
  "ticket_id": "ticket-042",
  "verdict": "pass",
  "notes": "Fix is minimal and correct. Test covers the undefined case.",
  "reviewed_at": "2026-09-01T10:04:00Z"
}
```

Store these in a simple database (SQLite is enough for local/MVP; Postgres if you go multi-user/hosted later). This store is the shared memory between agents — each agent reads/writes tickets, it doesn't need the full conversation history of other agents.

---

## 6. Cross-File Root-Cause Analysis

A bug rarely lives entirely in the file where it *shows up*. A `.map()` crash in `parse.js` might actually be caused by an API client in `api.js` returning `undefined` instead of `[]`. To catch this, the Scanner needs a map of how files relate before it writes a ticket.

**6.1 Build a dependency graph (once, then keep updated)**
- Parse `import`/`require`/`from ... import` statements (AST-based, not regex) to build a directed graph: `fileA → fileB` means A imports/uses B.
- Tools to lean on instead of writing a parser from scratch: `madge` or `dependency-cruiser` for JS/TS, `pydeps` or a simple `ast`-based walker for Python.
- Store as an adjacency list, e.g. `{ "src/parse.js": { imports: ["src/api.js"], imported_by: ["src/index.js"] } }`.
- Rebuild incrementally: when a file changes, only that file's edges need re-parsing, not the whole graph.

**6.2 Use the graph when a flagged file is analyzed**
- When the Scanner's LLM pass looks at a suspicious file, include as context: the file itself, its direct imports (1 hop), and its direct importers/callers (1 hop) — not the whole codebase, that's too expensive and noisy.
- If the LLM determines the actual root cause is in a connected file (e.g. "the issue is `api.js` can return undefined, not `parse.js`'s logic"), the ticket records `root_cause_file` separately from `symptom_file`, so the Fixer later knows where to actually make the change.
- Cap the hop distance (start with 1, allow 2 for high-severity findings) — going further usually adds cost without much extra signal, and you can always let the Fixer request more context on demand if it gets stuck.

---

## 7. Scan Memory (Incremental Scanning)

Re-scanning the whole project every run is slow and burns API calls on unchanged code. Give the Scanner memory so repeat runs are fast.

**7.1 What to cache**
- A content hash (SHA-1/256) per file, from the last successful scan.
- The findings (tickets) produced for that file at that hash.
- The dependency graph itself (so it doesn't need rebuilding from scratch each run).

**7.2 What triggers a re-scan of a file**
- The file's own content hash changed, **or**
- One of the files it depends on changed (its context changed, even if it didn't) — this is why the dependency graph matters for caching too, not just for root-cause analysis.
- Otherwise: reuse the cached findings for that file instead of calling the LLM again.

**7.3 Cache schema (draft)**
```json
{
  "file": "src/utils/parse.js",
  "content_hash": "a1b2c3...",
  "last_scanned_at": "2026-09-01T10:00:00Z",
  "dependency_hashes": {
    "src/api.js": "d4e5f6..."
  },
  "cached_findings": ["ticket-042"]
}
```
- Store this alongside the Ticket table (SQLite is fine — one `scan_cache` table keyed by file path).
- On each scan run: compute current hashes for all files → diff against cache → build the "impacted set" (changed files + files that depend on them) → only that set goes through static analysis + LLM review → everything else reuses cached results.
- This turns a full-project scan into effectively a diff-scan after the first run, which is also exactly the mode you want for the file-save-triggered local workflow.

---

## 8. Local vs. GitHub Mode

| | Local Project | GitHub Repo |
|---|---|---|
| **Source** | Folder on disk | Cloned repo |
| **Trigger** | File watcher / manual scan | Webhook on push, or manual/scheduled scan |
| **Fix branch** | Local git branch | Branch on the remote |
| **Delivery** | Local commit (user pushes manually), or auto-push if configured | Git/Sync agent pushes + opens PR automatically |
| **Auth** | None needed for scanning | GitHub OAuth token / GitHub App install for API access |

Practically: build **local-first**. A local git repo is just a GitHub repo without the remote — so once local mode's Git/Sync agent works (branch, commit), adding "push to origin + open PR via GitHub API" is a small extension, not a rebuild.

---

## 9. Suggested Tech Stack

- **Orchestrator/backend**: Node.js or Python — whichever you're more comfortable in; this is mostly queue/state-machine logic plus API calls.
- **LLM calls**: Anthropic API (Claude) — use tool calling / structured output (JSON mode via prompting) for tickets, patches, and reviews so parsing is reliable.
- **Git operations**: `simple-git` (Node) or `GitPython` (Python) for local; GitHub REST API (`octokit` or `PyGithub`) for remote push/PR.
- **Static analysis**: ESLint/Semgrep (JS/TS), Pylint/Ruff (Python) — run these first, feed only ambiguous findings to the LLM.
- **Storage**: SQLite for MVP.
- **UI**: A simple local web dashboard (even a single-page app) showing the ticket queue with approve/reject buttons — this is your main UI surface, keep it minimal.
- **Sandboxing**: run Fixer's test execution in a subprocess with a timeout, or a lightweight container (Docker) if you want stronger isolation.

---

## 10. Build Roadmap

**Phase 1 — MVP (single language, local only)**
- Scanner (static analysis + LLM) → Ticket queue UI → manual approval
- Basic dependency graph (1-hop imports/importers) so tickets include root-cause context, even before caching is optimized
- Fixer produces a diff, shown to human, human applies manually (no auto-git yet)
- Prove the "find issue → generate correct fix" loop works before automating anything else

**Phase 1.5 — Add scan memory**
- Content-hash caching so re-scans only touch changed files + their dependents
- This is what makes file-save-triggered scanning actually usable day-to-day; do it right after Phase 1, before piling on more agents

**Phase 2 — Automate the git flow (still local)**
- Add Git/Sync agent: branch, commit, local push
- Add Reviewer agent as a second check before showing diff to human
- Add Test-Writer agent

**Phase 3 — GitHub integration**
- GitHub auth (OAuth or GitHub App)
- Push branch to remote, open PR via API
- Optional: webhook-triggered scans on every push

**Phase 4 — Scale out**
- More agent types (security scanner, performance scanner, dependency-upgrade agent)
- Multi-repo/multi-project support
- Auto-approve rules for high-confidence low-risk fixes (e.g. lint-only)

---

## 11. Open Questions to Decide Before Building

- Which language/stack for the MVP target project (this determines which static analysis tools you integrate first)?
- Node.js or Python for the orchestrator itself?
- Local-only desktop app, or a local server + web dashboard?
- How many retries before a rejected fix gets escalated to a human instead of looping back to the Fixer?
