# AI Dev Team — Technical Architecture & Implementation Guide

> **Enterprise-grade, autonomous multi-agent software engineering framework.**  
> Built natively in **TypeScript / Node.js** on a local-first, zero-database architecture with tiered memory, two-loop supervisor risk governance, structural AST code summarization, and a 16-skill execution engine.

---

## 1. Executive System Overview

The AI Dev Team architecture operates on five decoupled, high-cohesion layers:

1. **Client / Dashboard Layer**: React + Tailwind real-time control plane and terminal visualizer for inspecting tickets, patches, and execution telemetry graphs.
2. **Supervision & Gating Layer**: Two-Loop Supervisor (`ManagerAgent`) providing pre-dispatch risk assessment (Loop 1) and output verification with human-in-the-loop gates (Loop 2).
3. **Multi-Team Delegation Layer**: Specialized functional teams (`Production`, `Debugging`, `Deployment`) operating bounded delegation loops via LangGraph state machines.
4. **Skill & Tool Execution Layer**: Comprehensive 16-skill catalog with role-based permission boundaries, risk scoring (0–10), sandbox isolation, and standard tool protocol adapters.
5. **Tiered Git-Native Memory Layer**: Zero-database persistent memory backed by the `.aidev/` directory with L0 (in-memory hot cache), L1 (procedural rules), and L2 (salience-filtered episodic history).

```
                                  ┌───────────────────────────┐
                                  │    Target Codebase/Repo   │
                                  └─────────────┬─────────────┘
                                                │
                                                ▼
                                  ┌───────────────────────────┐
                                  │       Scanner Agent       │ (AST + Static Analysis + LLM)
                                  └─────────────┬─────────────┘
                                                │
                                                ▼
                                  ┌───────────────────────────┐
                                  │       Triage Agent        │ (Deduplication, severity ranking)
                                  └─────────────┬─────────────┘
                                                │
                                      [Human Ticket Gate]
                                                │
                                                ▼
                        ┌───────────────────────────────────────────────┐
                        │      Manager Agent (Two-Loop Supervisor)      │
                        │ ┌───────────────────────────────────────────┐ │
                        │ │ Loop 1: Planning & Risk Assessment (0-10) │ │
                        │ └───────────────────────────────────────────┘ │
                        └───────────────────────┬───────────────────────┘
                                                │ Dispatches via Delegation Loops
                      ┌─────────────────────────┼─────────────────────────┐
                      ▼                         ▼                         ▼
           ┌─────────────────────┐   ┌─────────────────────┐   ┌─────────────────────┐
           │   Production Team   │   │   Debugging Team    │   │   Deployment Team   │
           │ (Feature, Fix, Test)│   │(Repro, Trace, Patch)│   │(Branch, CI, Release)│
           └──────────┬──────────┘   └──────────┬──────────┘   └──────────┬──────────┘
                      │                         │                         │
                      └─────────────────────────┼─────────────────────────┘
                                                │
                                                ▼
                        ┌───────────────────────────────────────────────┐
                        │              16-Skill Catalog                 │
                        │ (Sandbox, AST Outlines, Security, Git Ops,    │
                        │  Diagram Gen, Doc Search, Universal Adapter)  │
                        └───────────────────────┬───────────────────────┘
                                                │
                                                ▼
                        ┌───────────────────────────────────────────────┐
                        │            Verification Pipeline              │
                        │  - Test Suite Runner (vitest/jest/pytest)     │
                        │  - Static Analysis & Linter (ESLint/Ruff)     │
                        │  - Security & Secrets Scanner (OWASP/CWE)     │
                        └───────────────────────┬───────────────────────┘
                                                │
                                                ▼
                        ┌───────────────────────────────────────────────┐
                        │           Reviewer Council Agent              │
                        │ (Multi-reviewer consensus + salience filter)  │
                        └───────────────────────┬───────────────────────┘
                                                │
                                       [Human PR Gate]
                                                │
                                                ▼
                        ┌───────────────────────────────────────────────┐
                        │         Git/Sync & Release Agent              │
                        │ (Atomic branch, commit, PR & deployment)      │
                        └───────────────────────┬───────────────────────┘
                                                │
                                                ▼
                        ┌───────────────────────────────────────────────┐
                        │        Zero-Postgres Tiered Memory            │
                        │  - L0: In-Memory Hot Cache (TTL: 60s)         │
                        │  - L1: Procedural Rules (.aidev/rules.md)     │
                        │  - L2: Episodic Log (.aidev/episodes.jsonl)   │
                        └───────────────────────────────────────────────┘
```

---

## 2. Technology Stack & Design Decisions

| Subsystem | Technology Choice | Architectural Rationale |
|---|---|---|
| **Runtime** | **Node.js (ESM) + TypeScript** | Unified language across agents, tools, frontend, and build scripts. Single-runtime simplicity without dual Python interop. |
| **Agent Orchestration** | **LangGraph (`@langchain/langgraph`)** | Explicit state machines with bounded loop guarantees, conditional routing, and deterministic sub-delegation. |
| **Local LLM Engine** | **Ollama** (`qwen3-coder:30b`, `devstral:24b`) | Complete data privacy, zero API costs, high code reasoning throughput, and native local offline execution. |
| **Structured Output** | **Zod Schema Enforcers + LLM Gateway** | Converts Zod schemas into JSON specifications, guaranteeing validated typed outputs with automated retries. |
| **Memory Engine** | **Git-Native Flat Files (`.aidev/`)** | Zero database installation. Version-controllable, human-editable rules and append-only streaming JSONL episodes. |
| **Context Optimizer** | **Structural AST Outline Extractor** | Parses types, interfaces, and function signatures without full method bodies, saving up to 80% context tokens. |
| **Isolation Sandbox** | **Docker Containers / Temp Worktrees** | Isolates arbitrary code execution and test execution from host filesystem and host dependencies. |
| **Safety Governance** | **Two-Loop Supervisor + Risk Gate** | Real-time action risk scoring (0–10) preventing destructive or high-risk state changes without verification. |

---

## 3. Core Engine Subsystems

### 3.1 Tiered Context Engine (`MemoryAgent`)
Memory operates across three latency and scope tiers:
- **Tier L0 (Hot Session Cache):** In-memory map of recent target file queries. Instant resolution with a 60-second TTL.
- **Tier L1 (Procedural Rules):** Persistent guidelines located in `.aidev/rules.md`. Injected into prompt headers across all agent turns.
- **Tier L2 (Episodic Stream):** Append-only event store in `.aidev/episodes.jsonl`. Matched against the active target file to retrieve previous rejection rationales and avoid duplicate regression attempts.
- **Salience Scoring Filter:** Calculates an informational value score ($0.0 \le S \le 1.0$) based on presence of failure rationales, reviewer notes, and diff summaries. Events with $S < 0.5$ are dropped to keep context clean.

### 3.2 Structural Code AST Outline Extractor (`extractCodeOutline`)
- Generates high-level structural blueprints of source files:
  - Exported interfaces and types
  - Class definitions and method declarations
  - Standalone and arrow functions
  - Top-level imports and exports
- Injected alongside L1/L2 memory to give agents complete API awareness without bloating context windows.

### 3.3 Two-Loop Supervisor & Risk Gatekeeper (`ManagerAgent`)
- **Loop 1: Planning & Risk Assessment**
  - Scores task risk ($0 \le R \le 10$) based on operation type, target files, and environment sensitivity.
  - Classifies tasks into `low`, `medium`, or `high` risk.
  - High-risk operations (e.g. deployments, branch pushes, infrastructure changes) require explicit approval or verification pass gates.
- **Loop 2: Execution & Output Verification**
  - Manages delegation cycles with team agents.
  - Records salience-scored episodes upon task completion or failure.

---

## 4. Comprehensive 16-Skill Execution Catalog

| # | Skill Name | Authorized Teams | Risk (0-10) | Description |
|---|---|---|---|---|
| 1 | `memory_recall` | All Teams | Low (0) | Recalls L0/L1/L2 memory + AST code outlines from `.aidev/` |
| 2 | `memory_record` | All Teams | Low (1) | Records salience-filtered episodes to `.aidev/episodes.jsonl` |
| 3 | `code_exec` | Production, Debugging | Medium (5) | Executes code or commands inside isolated sandbox |
| 4 | `test_runner` | Production, Debugging | Medium (4) | Runs test suite (vitest/jest/pytest) and captures outputs |
| 5 | `linter` | Production, Debugging | Low (1) | Executes static analysis & lint checks (ESLint/Ruff) |
| 6 | `git_ops` | Production, Deployment | High (8) | Performs git status, diff, local branch, and atomic commits |
| 7 | `log_query` | Debugging | Low (0) | High-speed regex filtering on logs and execution traces |
| 8 | `bug_reproduction` | Debugging | Medium (4) | Constructs minimal reproduction test scripts and asserts failure |
| 9 | `deploy_api` | Deployment | High (9) | Dispatches deployment payloads to staging/production webhooks |
| 10 | `ci_trigger` | Deployment | High (8) | Dispatches and monitors CI workflow runs (GitHub Actions) |
| 11 | `infra_provision` | Deployment | High (9) | Manages container environments (`docker compose up/down`) |
| 12 | `health_check` | Deployment, Monitor | Low (0) | Pings endpoints and measures HTTP latency and status codes |
| 13 | `security_scan` | Production, Debugging | Medium (3) | Scans workspace for leaked secrets and unsafe code patterns |
| 14 | `diagram_gen` | Production | Low (2) | Generates SVG & Mermaid architecture diagrams in `docs/architecture/` |
| 15 | `doc_search` | Production, Debugging | Low (0) | Fetches package registry metadata and documentation specs |
| 16 | `universal_tool_adapter` | All Teams | Medium (5) | Dynamically executes standard JSON-schema tool definitions |

---

## 5. Autonomous Workflows & Execution Pipelines

### 5.1 Autonomous Issue Resolver Pipeline (`IssueResolverPipeline`)
1. **Intake**: Ingests issue metadata (ID, title, description, target files, labels).
2. **Triage & Context Extraction**: Classifies issue intent, queries L1/L2 memory, and extracts AST code outlines.
3. **Delegation**: Manager assigns task to the appropriate team (`Production` or `Debugging`).
4. **Execution Loop**: Team agent executes iterative skill calls (`memory_recall` $\rightarrow$ patch generation $\rightarrow$ `test_runner`).
5. **Multi-Gate Verification**:
   - `test_runner`: Unit & regression test pass.
   - `linter`: Static analysis and style verification.
   - `security_scan`: Zero critical/high secrets or vulnerabilities.
6. **Telemetry & Memory Sync**: Emits execution graph telemetry and saves salience-filtered episode to `.aidev/`.

### 5.2 Real-Time Execution Telemetry (`TelemetryVisualizer`)
- Records node states (`pending`, `running`, `completed`, `failed`), execution timestamps, and transition edges.
- Exports structured snapshots for the React dashboard and renders terminal ASCII workflow trees.

---

## 6. Directory Structure & Layout

```
AI-Dev-Team/
├── .aidev/                                # Git-native memory store
│   ├── rules.md                          # L1 procedural rules
│   └── episodes.jsonl                    # L2 episodic failure/success log
├── docs/
│   └── architecture/                     # Auto-generated SVG/Mermaid diagrams
│       ├── system_architecture.mmd
│       └── system_architecture.svg
├── packages/
│   ├── agents/                           # Multi-agent orchestrators & skills
│   │   └── src/
│   │       ├── memory/                   # Tiered memory & AST outline engine
│   │       │   └── code-ast-outline.ts
│   │       ├── security/                 # Static vulnerability & secret scanner
│   │       │   └── security-scanner.ts
│   │       ├── visual/                   # Editorial SVG/Mermaid diagram generator
│   │       │   └── diagram-generator.ts
│   │       ├── tools/                    # Tool protocol adapters & doc search
│   │       │   ├── doc-search-client.ts
│   │       │   └── tool-protocol-adapter.ts
│   │       ├── teams/                    # LangGraph multi-team delegation system
│   │       │   ├── manager-agent.ts
│   │       │   ├── team-agent.ts
│   │       │   ├── skill-registry.ts
│   │       │   └── task-schemas.ts
│   │       ├── workflows/                # Autonomous issue resolution & telemetry
│   │       │   ├── issue-resolver-pipeline.ts
│   │       │   └── telemetry-visualizer.ts
│   │       ├── fixer.ts
│   │       ├── reviewer.ts
│   │       ├── scanner.ts
│   │       ├── triage.ts
│   │       ├── sandbox.ts
│   │       └── index.ts
│   ├── llm-gateway/                      # Ollama client with Zod structured output
│   └── db/                               # Database schemas & client
├── prompts/                              # Versioned markdown prompts
├── README.md                             # Project overview & quick start
└── LICENSE                               # MIT License
```
