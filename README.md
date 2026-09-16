# AI Dev Team 🤖

An autonomous, multi-agent software engineering system that scans codebases for defects, deduplicates and prioritizes issues, creates isolated worktrees, generates surgical fixes, runs automated tests, subjects code to multi-model peer review councils, and prepares reviewable GitHub pull requests — with strict human approval gates.

---

## 🌟 Overview

The **AI Dev Team** behaves like a dedicated software engineering squad:

```
                  ┌──────────────────────┐
                  │    Codebase / Repo   │
                  └──────────┬───────────┘
                             │
                             ▼
                  ┌──────────────────────┐
                  │    Scanner Agent     │ (Static analysis + AST Context + LLM)
                  └──────────┬───────────┘
                             │
                             ▼
                  ┌──────────────────────┐
                  │     Triage Agent     │ (Deduplication, severity & confidence)
                  └──────────┬───────────┘
                             │
                    [Human Ticket Gate]
                             │
                             ▼
                  ┌──────────────────────┐
                  │     Fixer Agent      │ (Isolated Git worktree + Memory recall)
                  └──────────┬───────────┘
                             │
                             ▼
                  ┌──────────────────────┐
                  │  Test-Writer Agent   │ (Generates & verifies regression tests)
                  └──────────┬───────────┘
                             │
                             ▼
                  ┌──────────────────────┐
                  │ Reviewer Agent /     │ (Independent verification or multi-model council)
                  │ Reviewer Council     │ ──▶ [Records Episode in Memory]
                  └──────────┬───────────┘
                             │
                     [Human PR Gate]
                             │
                             ▼
                  ┌──────────────────────┐
                  │    Git/Sync Agent    │ (Feature branch, commit & GitHub PR)
                  └──────────────────────┘
```

---

## 🚀 Key Features

- **Multi-Agent Specialization:**
  - **Scanner:** Combines deterministic static analysis (ESLint, AST parser) with LLM root-cause resolution.
  - **Triage:** Groups related symptoms and deduplicates tickets pointing to shared root causes.
  - **Fixer:** Generates surgical diffs in isolated Git worktrees (`fix/ticket-<id>`).
  - **Test-Writer:** Writes regression tests, confirming they fail before the fix and pass after.
  - **Reviewer Council:** For high-severity issues, runs multi-model consensus review.
  - **Git/Sync:** Stages, commits, and opens review-ready GitHub PRs via the GitHub API.

- **Zero-Postgres Git-Native Memory (`MemoryAgent`):**
  - Works with **zero external database dependencies** using fast, pure Node.js file streaming.
  - **Procedural Memory (`.aidev/rules.md`):** Human- and agent-curated coding rules, architectural constraints, and standards. Fully Git-versioned and developer-editable.
  - **Episodic Memory (`.aidev/episodes.jsonl`):** Append-only log of past tickets, diffs, test runs, and reviewer critiques.
  - **Targeted Recall:** Fixers automatically query past failures and rejections on target files to prevent repeated mistake loops.

- **Human in the Loop:**
  - Two mandatory checkpoints: **Ticket Approval** (prevents wasting compute) and **Diff / PR Approval** (human signs off before code merges).

---

## 📁 Repository Structure

```
AI-Dev-Team/
├── apps/
│   ├── api/                   # Fastify REST & WebSocket backend
│   └── dashboard/             # React + Tailwind dashboard for human review
├── packages/
│   ├── agents/                # Core agent implementations & MemoryAgent
│   ├── db/                    # Prisma schema & database utilities
│   ├── dependency-graph/      # AST dependency graph parser & traversal
│   ├── llm-gateway/           # Multi-provider LLM client with structured schemas
│   └── scan-cache/            # Content-hashing & impacted-set calculation
├── .aidev/                    # Local/repo agent memory (rules.md, episodes.jsonl)
├── prompts/                   # Versioned agent prompt templates
└── docker-compose.yml         # Optional containerized infra (Postgres, Redis)
```

---

## ⚡ Quick Start

### 1. Prerequisites
- **Node.js** v20+ (v23+ supported)
- **npm** v9+
- **Git** installed on your system

### 2. Installation

Clone the repository and install workspace dependencies:
```bash
git clone https://github.com/Tattvam21/AI-Dev-Team.git
cd AI-Dev-Team
npm install
```

### 3. Environment Setup

Create a `.env` file from `.env.example`:
```bash
cp .env.example .env
```

Configure your LLM keys and optional GitHub integration:
```env
ANTHROPIC_API_KEY=your-api-key-here
# Optional model overrides:
FIXER_MODEL=claude-3-5-sonnet-latest
REVIEWER_MODEL=claude-3-5-sonnet-latest
```

---

## 🧠 Using Agent Memory (`.aidev`)

The memory layer automatically activates when agents run on a target repository:

```typescript
import { MemoryAgent } from '@ai-dev-team/agents';

const memory = new MemoryAgent(process.cwd());

// Recall rules and past file-specific failures before fixing
const recall = await memory.recall('src/auth/token.ts');
console.log(recall.formattedContext);

// Record an episode when review concludes
await memory.recordEpisode({
  ticketId: 't-123',
  targetFile: 'src/auth/token.ts',
  title: 'Fix token expiry crash',
  verdict: 'pass',
  rationale: 'Added RSA verification fallback'
});

// Add a permanent rule to the repo
await memory.addRule('Never export JWT secrets directly; use ConfigService', 'Security');
```

---

## 🧪 Testing

Run automated tests across workspaces:
```bash
# Test agents package
npm test --workspace=@ai-dev-team/agents

# Run all tests
npm run test
```

---

## 📄 License

MIT © 2026 AI Dev Team Authors and Contributors. See [LICENSE](LICENSE) for details.
