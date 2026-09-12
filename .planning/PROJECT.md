# AI Dev Team (Local LLM / Ollama Edition)

## What this is
An autonomous, multi-agent software engineering squad that monitors codebases, discovers bugs, diagnoses root causes via AST dependency graphs, crafts fixes with regression tests, reviews patches critically, and delivers clean PRs with human approval gates.

## Core Value
High-confidence automated bug detection and remediation powered by local Ollama models with zero code merging without human sign-off.

## Key Requirements
- Local Ollama model integration with tiered model assignment (Scanner: Qwen 8B, Fixer: Qwen-Coder 30B, Reviewer: Devstral 24B).
- Monorepo structure: `apps/api`, `apps/dashboard`, `packages/llm-gateway`, `packages/agents`, `packages/dependency-graph`, `packages/scan-cache`, `packages/db`.
- Two mandatory human checkpoints (Ticket approval, Diff/Patch approval).
- Dependency-graph based 1-hop context limiting and content-hash caching.
- Isolated Git worktrees and sandboxed test execution.

## Architecture
- Backend: Node.js + TypeScript + Fastify
- Frontend: React + Vite + TypeScript
- Storage: SQLite (Prisma)
- Job Queues: BullMQ / Redis
- AI: Local Ollama (`http://localhost:11434`)
