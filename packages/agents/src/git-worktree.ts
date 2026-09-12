import fs from 'fs';
import path from 'path';
import os from 'os';
import { simpleGit, SimpleGit } from 'simple-git';

export interface WorktreeOptions {
  slug?: string;
  baseBranch?: string;
  tempBaseDir?: string;
}

export interface WorktreeSession {
  worktreePath: string;
  branchName: string;
  projectPath: string;
  git: SimpleGit;
  cleanup: () => Promise<void>;
}

/**
 * Sanitizes a string to be safely used as part of a git branch name and path.
 */
export function sanitizeSlug(input?: string): string {
  if (!input) return 'fix';
  const clean = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return clean.slice(0, 30) || 'fix';
}

/**
 * Creates an isolated git worktree for a ticket on a dedicated fix branch:
 * Branch: fix/ticket-<ticketId>-<slug>
 *
 * Handles retries gracefully:
 * - If the branch already exists, reuses it with `git worktree add <path> <branch>`
 * - If the branch does not exist, creates it with `git worktree add -b <branch> <path>`
 *
 * Returns the worktree path, branch name, a worktree-scoped simple-git instance,
 * and a cleanup() function to safely remove the worktree.
 */
export async function createGitWorktree(
  projectPath: string,
  ticketId: string,
  options: WorktreeOptions = {}
): Promise<WorktreeSession> {
  const resolvedProjectPath = path.resolve(projectPath);
  if (!fs.existsSync(resolvedProjectPath)) {
    throw new Error(`Project path does not exist: ${resolvedProjectPath}`);
  }

  const rootGit = simpleGit(resolvedProjectPath);
  const isRepo = await rootGit.checkIsRepo();
  if (!isRepo) {
    throw new Error(`Path is not a valid git repository: ${resolvedProjectPath}`);
  }

  // Prune any stale worktree references
  await rootGit.raw(['worktree', 'prune']).catch(() => {});

  const cleanSlug = sanitizeSlug(options.slug);
  const branchName = `fix/ticket-${ticketId}-${cleanSlug}`;

  // If a previous worktree already checked out this branch, remove that worktree first
  try {
    const listOutput = await rootGit.raw(['worktree', 'list']);
    for (const line of listOutput.split('\n')) {
      if (line.includes(`[${branchName}]`)) {
        const stalePath = line.trim().split(/\s+/)[0];
        if (stalePath && stalePath !== resolvedProjectPath) {
          await rootGit.raw(['worktree', 'remove', '--force', stalePath]).catch(() => {});
        }
      }
    }
    await rootGit.raw(['worktree', 'prune']).catch(() => {});
  } catch {
    // ignore
  }

  // Unique worktree directory in temp folder
  const baseDir =
    options.tempBaseDir ?? path.join(os.tmpdir(), 'ai-dev-team-worktrees');
  if (!fs.existsSync(baseDir)) {
    fs.mkdirSync(baseDir, { recursive: true });
  }

  const worktreePath = path.join(baseDir, `wt-${ticketId}-${Date.now()}`);

  // Check if branch already exists (e.g. retry)
  const localBranches = await rootGit.branchLocal();
  const branchExists = localBranches.all.includes(branchName);

  if (branchExists) {
    // Reuse existing branch
    await rootGit.raw(['worktree', 'add', worktreePath, branchName]);
  } else {
    // Create new branch from base branch or current HEAD
    const args = ['worktree', 'add', '-b', branchName, worktreePath];
    if (options.baseBranch) {
      args.push(options.baseBranch);
    }
    await rootGit.raw(args);
  }

  const worktreeGit = simpleGit(worktreePath);

  // Define cleanup function
  const cleanup = async (): Promise<void> => {
    try {
      // Force remove worktree from git tracking
      await rootGit.raw(['worktree', 'remove', '--force', worktreePath]).catch(() => {});
      await rootGit.raw(['worktree', 'prune']).catch(() => {});
    } catch {
      // Ignore git errors during cleanup
    }

    // Ensure directory is deleted from disk
    if (fs.existsSync(worktreePath)) {
      try {
        await fs.promises.rm(worktreePath, { recursive: true, force: true });
      } catch {
        // ignore disk deletion failure if already unlinked
      }
    }
  };

  return {
    worktreePath,
    branchName,
    projectPath: resolvedProjectPath,
    git: worktreeGit,
    cleanup
  };
}
