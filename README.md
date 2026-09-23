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
                                  │      Manager Agent      │ (Two-Loop Supervisor + Risk Gatekeeper)
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
                                  │ Reviewer Council Agent  │ (Consensus + Salience-filtered logging)
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

### 1. Two-Loop Supervisor & Multi-Team Delegation
- **Two-Loop Supervisor (`ManagerAgent`):**
  - **Loop 1 (Planning & Risk Gate):** Evaluates task intent and assigns risk ratings (0–10). High-risk operations (deployments, destructive actions) trigger validation gates.
  - **Loop 2 (Execution & Verification):** Coordinates specialized teams (`Production`, `Debugging`, `Deployment`) through bounded delegation loops:
    $$\text{Receive Task} \longrightarrow \text{Decide Action} \longrightarrow \text{Execute Scoped Skill} \longrightarrow \text{Validate} \longrightarrow \text{Loop or Complete}$$
- **100% Native TypeScript:** Built on top of `@langchain/langgraph` and `@langchain/core` — requiring zero Python dual-runtime setups.

### 2. Tiered Zero-Postgres Memory (`MemoryAgent`)
- **No Database Daemon Required:** Operates entirely on pure Node.js streaming file I/O within a version-controlled `.aidev/` directory in the repository root.
- **3-Tier Context Hierarchy:**
  - **L0 (In-Memory Hot Cache):** Instant sub-millisecond retrieval of recent queries within the active execution session.
  - **L1 (Procedural Rules):** Reads `.aidev/rules.md` for active coding guidelines and architectural constraints.
  - **L2 (Lazy-Streamed Episodic History):** Append-only stream in `.aidev/episodes.jsonl` containing past failure notes and patch rationales.
- **Salience-Driven Episode Filtering:** Intelligently evaluates new records to filter out low-signal noise and prevent duplicate failure logs.
- **Structural Code AST Outline Extractor:** Generates concise structural signatures (types, interfaces, class methods, exports) to supply rich context while minimizing token consumption.

### 3. Comprehensive 16-Skill Catalog (`SkillRegistry`)
Every agent has role-based permission boundaries and risk scores strictly enforced:

| # | Skill | Authorized Teams | Risk Level | Functionality |
| :--- | :--- | :--- | :--- | :--- |
| 1 | `memory_recall` | All Teams | Low (0) | Tiered L0/L1/L2 recall + AST code outlines from `.aidev/` |
| 2 | `memory_record` | All Teams | Low (1) | Salience-filtered episodic logging to `.aidev/episodes.jsonl` |
| 3 | `code_exec` | Production, Debugging | Medium (5) | Safe sandboxed command and code execution |
| 4 | `test_runner` | Production, Debugging | Medium (4) | Automated test suite execution (vitest/jest/pytest) |
| 5 | `linter` | Production, Debugging | Low (1) | Static analysis & code style check (ESLint / Ruff) |
| 6 | `git_ops` | Production, Deployment | High (8) | Git operations: status, diff, local branching, and commit |
| 7 | `log_query` | Debugging | Low (0) | High-speed regex filtering on logs and execution history |
| 8 | `bug_reproduction` | Debugging | Medium (4) | Automatic generation of minimal repro scripts |
| 9 | `deploy_api` | Deployment | High (9) | Target platform deployment trigger (Vercel/Fly.io/Webhook) |
| 10 | `ci_trigger` | Deployment | High (8) | Dispatches & monitors CI pipeline runs (GitHub Actions) |
| 11 | `infra_provision` | Deployment | High (9) | Manages environment infrastructure (`docker compose up/down`) |
| 12 | `health_check` | Deployment, Monitor | Low (0) | Service ping, HTTP latency & status code monitor |
| 13 | `security_scan` | Production, Debugging | Medium (3) | Secret pattern detection & static vulnerability scanner |
| 14 | `diagram_gen` | Production | Low (2) | Editorial architecture diagrams (SVG & Mermaid) in `docs/architecture/` |
| 15 | `doc_search` | Production, Debugging | Low (0) | Live documentation & npm package registry reference lookup |
| 16 | `universal_tool_adapter` | All Teams | Medium (5) | Standard JSON-schema tool execution protocol adapter |

### 4. Autonomous Issue Resolver Pipeline
- **End-to-End Orchestration (`IssueResolverPipeline`):**
  1. **Intake & Triage:** Ingests issue descriptions, extracts affected components, and classifies task intent.
  2. **Tiered Memory & Outline Retrieval:** Loads relevant rules, past rejection episodes, and structural code signatures.
  3. **Supervised Delegation:** Manager assigns sub-tasks to functional teams.
  4. **Multi-Gate Verification:** Runs test suites, static analysis, and security vulnerability scans.
  5. **Review & Telemetry:** Records salience-filtered outcomes and outputs structured execution traces.

### 5. Execution Telemetry & Workflow Visualizer
- **Telemetry Visualizer (`TelemetryVisualizer`):** Formats execution graph states (nodes, transitions, durations, statuses) into structured JSON snapshots for dashboards and terminal ASCII trees.

---

## 🚀 Quick Start

### Prerequisites
- Node.js **>= 20.0.0** (Node 22 or 23 recommended)
- Docker Desktop / Engine running locally (for isolated sandboxes)
- Ollama running locally (`ollama serve`)

### Installation

```bash
# 1. Clone repository
git clone https://github.com/Tattvam21/AI-Dev-Team.git
cd AI-Dev-Team

# 2. Install dependencies
npm install

# 3. Pull default local models
ollama pull qwen3-coder:30b
ollama pull devstral:24b
```

### Running the Verification Suite

```bash
node --experimental-strip-types packages/agents/test-all-enhancements.mjs
```

---

## 📖 Programmatic Usage

### Autonomous Issue Resolver

```typescript
import { IssueResolverPipeline } from '@ai-dev-team/agents';

const pipeline = new IssueResolverPipeline({ projectRoot: process.cwd() });

const result = await pipeline.resolveIssue({
  issueId: '101',
  title: 'Fix unhandled promise rejection in auth handler',
  body: 'When JWT expires, request handler crashes without returning 401.',
  targetFile: 'src/auth/jwt.ts',
  labels: ['bug', 'auth']
});

console.log('Status:', result.status);
console.log('Telemetry:\n', result.telemetry);
```

### Two-Loop Manager & Skill Registry

```typescript
import { ManagerAgent, SkillRegistry } from '@ai-dev-team/agents';

const registry = new SkillRegistry();
const manager = new ManagerAgent({ projectRoot: process.cwd(), skillRegistry: registry });

const result = await manager.dispatch({
  taskId: 'task-sec-1',
  assignedTeam: 'debugging',
  taskType: 'security',
  expectedOutput: 'Scan repository for hardcoded secrets and unsafe eval patterns',
  context: { targetFile: 'src/index.ts' },
  status: 'pending'
});
```

---

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

Copyright (c) 2026 AI Dev Team Authors and Contributors.
