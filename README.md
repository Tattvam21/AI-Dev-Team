# AI Dev Team

> **Enterprise-grade, autonomous multi-agent software engineering framework.**  
> Scans codebases for defects, deduplicates and prioritizes tickets, isolates work in git worktrees, implements surgical fixes with zero-database memory recall, verifies with regression tests, subjects code to peer review councils, and opens GitHub pull requests under strict human approval gates.

---

## 🏗️ System Architecture & Workflow

The platform operates as a coordinated software engineering organization with clear human checkpoints and autonomous worker delegation:

```
                                  ┌─────────────────────────┐
                                  │   Target Repository     │
                                  └────────────┬────────────┘
                                               │
                                               ▼
                                  ┌─────────────────────────┐
                                  │      Scanner Agent      │ (Static analysis + AST Context + LLM)
                                  └────────────┬────────────┘
                                               │
                                               ▼
                                  ┌─────────────────────────┐
                                  │       Triage Agent      │ (Deduplication, severity & confidence)
                                  └────────────┬────────────┘
                                               │
                                      [Human Ticket Gate]
                                               │
                                               ▼
                                  ┌─────────────────────────┐
                                  │      Manager Agent      │
                                  └────────────┬────────────┘
                                               │ Dispatches via Delegation Loop
                      ┌────────────────────────┼────────────────────────┐
                      ▼                        ▼                        ▼
           ┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────────┐
           │   Production Team   │  │   Debugging Team    │  │   Deployment Team   │
           │ (Feature, Fix, Test)│  │(Repro, Trace, Patch)│  │(Branch, CI, Release)│
           └──────────┬──────────┘  └──────────┬──────────┘  └──────────┬──────────┘
                      │                        │                        │
                      └────────────────────────┼────────────────────────┘
                                               │
                                               ▼
                                  ┌─────────────────────────┐
                                  │    Test-Writer Agent    │ (Generates & verifies regression tests)
                                  └────────────┬────────────┘
                                               │
                                               ▼
                                  ┌─────────────────────────┐
                                  │ Reviewer Council Agent  │ (Independent verification & consensus)
                                  │   (Records Episode)     │ ──▶ [.aidev/episodes.jsonl]
                                  └────────────┬────────────┘
                                               │
                                      [Human PR Gate]
                                               │
                                               ▼
                                  ┌─────────────────────────┐
                                  │      Git/Sync Agent     │ (Creates branch, commits & opens PR)
                                  └─────────────────────────┘
```

---

## ⚡ Key Capabilities

### 1. Multi-Team Delegation System
- **Manager Coordination (`ManagerAgent`):** Translates high-level project goals into typed task specifications and delegates across specialized functional teams (`Production`, `Debugging`, `Deployment`).
- **Bounded Delegation Loop (`TeamAgent`):** Executes task cycles:
  $$\text{Receive Task} \longrightarrow \text{Decide Action} \longrightarrow \text{Execute Scoped Skill} \longrightarrow \text{Validate} \longrightarrow \text{Loop or Complete}$$
- **100% Native TypeScript:** Built on top of `@langchain/langgraph` and `@langchain/core` — requiring zero Python dual-runtime setups.

### 2. Zero-Postgres Git-Native Memory (`MemoryAgent`)
- **No Database Daemon Required:** Operates entirely on pure Node.js streaming file I/O within a version-controlled `.aidev/` directory in the repository root.
- **Procedural Memory (`.aidev/rules.md`):** Human- and agent-curated coding guidelines and architectural rules automatically injected into prompts.
- **Episodic Memory (`.aidev/episodes.jsonl`):** Append-only event stream of past ticket attempts, diff rationales, and reviewer critique notes.
- **Targeted File Recall:** Agents query past failures on target files prior to generating diffs, eliminating repetitive failure loops.

### 3. Comprehensive 12-Skill Catalog (`SkillRegistry`)
Every agent has role-based permission boundaries strictly enforced:

| Skill | Authorized Teams | Functionality |
| :--- | :--- | :--- |
| `code_exec` | Production, Debugging | Safe sandboxed command and code execution |
| `test_runner` | Production, Debugging | Automated test suite execution (vitest/jest/pytest) |
| `linter` | Production, Debugging | Static analysis & code style check (ESLint / Ruff) |
| `git_ops` | Production, Deployment | Git operations: status, diff, local branching, and commit |
| `log_query` | Debugging | High-speed regex filtering on logs and execution history |
| `bug_reproduction` | Debugging | Automatic generation of minimal repro scripts |
| `deploy_api` | Deployment | Target platform deployment trigger (Vercel/Fly.io/Webhook) |
| `ci_trigger` | Deployment | Dispatches & monitors CI pipeline runs (GitHub Actions) |
| `infra_provision` | Deployment | Manages environment infrastructure (`docker compose up/down`) |
| `health_check` | Deployment, Monitor | Service ping, HTTP latency & status code monitor |
| `memory_recall` | All Teams | Retrieves rules and past episodes for specific files from `.aidev/` |
| `memory_record` | All Teams | Appends task results & reviewer verdicts to `.aidev/episodes.jsonl` |

### 4. Human-in-the-Loop Safeguards
- **Gate 1: Ticket Approval:** Humans review and prioritize triaged tickets before fixes are initiated.
- **Gate 2: Diff / PR Sign-Off:** Humans review code diffs, reviewer council notes, and test coverage before changes are pushed to remote branches.

---

## 📁 Repository Structure

```
AI-Dev-Team/
├── apps/
│   ├── api/                   # Fastify backend (REST & real-time WebSocket)
│   └── dashboard/             # React + Tailwind review dashboard
├── packages/
│   ├── agents/                # Core agents, Team delegation & MemoryAgent
│   │   └── src/
│   │       ├── teams/         # Manager, TeamAgent & 12-Skill Registry
│   │       ├── memory-agent.ts# Zero-database procedural & episodic memory
│   │       ├── fixer.ts       # Surgical diff generator
│   │       ├── reviewer.ts    # Single & council peer reviewer
│   │       └── sandbox.ts     # Sandboxed container executor
│   ├── db/                    # Prisma client & data models
│   ├── dependency-graph/      # AST dependency graph parser & traversal
│   ├── llm-gateway/           # Multi-provider LLM client with Zod validation
│   └── scan-cache/            # Content-hashing & impacted-set calculation
├── .aidev/                    # Local/repo agent memory (rules.md, episodes.jsonl)
├── prompts/                   # Versioned prompt templates
└── docker-compose.yml         # Containerized infrastructure (optional)
```

---

## 🚀 Quick Start

### 1. Prerequisites
- **Node.js** v20+ (v23+ supported)
- **npm** v9+
- **Git**

### 2. Installation
```bash
git clone https://github.com/Tattvam21/AI-Dev-Team.git
cd AI-Dev-Team
npm install
```

### 3. Environment Configuration
```bash
cp .env.example .env
```

Set your model configuration in `.env`:
```env
# Cloud providers (Anthropic / OpenAI)
ANTHROPIC_API_KEY=your-api-key-here

# Local Ollama providers (Optional)
OLLAMA_BASE_URL=http://localhost:11434
FIXER_MODEL=qwen3-coder:30b
REVIEWER_MODEL=devstral:24b
TEAM_MODEL=qwen3-coder:30b
```

---

## 💻 Programmatic Usage

### Dispatching Tasks via Multi-Team Delegation

```typescript
import { ManagerAgent, Task } from '@ai-dev-team/agents';

const manager = new ManagerAgent({ projectRoot: process.cwd() });

const task: Task = {
  taskId: 'task-auth-01',
  assignedTeam: ManagerAgent.resolveTeam('fix token signature validation error'),
  taskType: 'bugfix',
  context: { targetFile: 'src/auth/jwt.ts' },
  expectedOutput: 'Handle expired token edge cases gracefully',
  maxIterations: 4,
  status: 'pending'
};

const result = await manager.dispatch(task);
console.log(`Task status: ${result.status}, Iterations: ${result.iterationsUsed}`);
```

### Interacting with Zero-Postgres Memory

```typescript
import { MemoryAgent } from '@ai-dev-team/agents';

const memory = new MemoryAgent(process.cwd());

// Recall relevant rules and past rejection critiques
const context = await memory.recall('src/auth/jwt.ts');
console.log(context.formattedContext);

// Append permanent architectural rules
await memory.addRule('Always use crypto.randomUUID for nonces', 'Security');
```

---

## 🧪 Testing

```bash
# Run tests across workspaces
npm run test

# Run agents package test suite
npm test --workspace=@ai-dev-team/agents
```

---

## 📄 License

MIT © 2026 AI Dev Team Authors and Contributors. See [LICENSE](LICENSE) for details.
