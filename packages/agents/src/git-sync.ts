import fs from 'fs';
import path from 'path';
import { simpleGit, SimpleGit } from 'simple-git';
import { Octokit } from 'octokit';
import { z } from 'zod';
import { prisma as defaultPrisma, PrismaClient, Patch } from '@ai-dev-team/db';
import { generateStructured, loadPrompt } from '@ai-dev-team/llm-gateway';

export const PrSummarySchema = z.object({
  title: z
    .string()
    .describe('Concise PR title formatted with conventional commit style e.g. fix: ...'),
  body: z
    .string()
    .describe('Detailed PR description with summary of problem, fix applied, and tests added')
});

export type PrSummary = z.infer<typeof PrSummarySchema>;

export interface GitSyncOptions {
  prisma?: PrismaClient;
  projectPath?: string;
  baseBranch?: string;
}

export interface RemoteSyncOptions extends GitSyncOptions {
  githubToken?: string;
  remoteName?: string;
  octokitClient?: any;
  llmClient?: any;
  model?: string;
  promptVersion?: string;
  timeoutMs?: number;
}

export interface BranchVerificationResult {
  valid: boolean;
  reason?: string;
  commits: Array<{ hash: string; message: string }>;
  hasFixCommit: boolean;
  hasTestCommit: boolean;
}

export interface GitSyncResult {
  patchId: string;
  status: 'ready_to_push';
  branchName: string;
  isLocalOnly: boolean;
  commitCount: number;
  commits: Array<{ hash: string; message: string }>;
  diff: string;
  manualApplyInstructions?: string;
}

export interface RemoteSyncResult {
  success: boolean;
  status: 'pushed' | 'failed_conflict';
  patchId: string;
  branchName: string;
  prUrl?: string;
  prNumber?: number;
  prTitle?: string;
  prBody?: string;
  error?: string;
}

/**
 * Parses owner and repo name from GitHub repo configuration.
 * Supported formats:
 * - "owner/repo"
 * - "https://github.com/owner/repo"
 * - "https://github.com/owner/repo.git"
 * - "git@github.com:owner/repo.git"
 */
export function parseGitHubRepo(repoStr: string): { owner: string; repo: string } {
  const clean = repoStr
    .trim()
    .replace(/\.git$/, '')
    .replace(/^git@github\.com:/, '')
    .replace(/^https?:\/\/github\.com\//, '');
  const parts = clean.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid githubRepo format: '${repoStr}'. Expected 'owner/repo'.`);
  }
  return { owner: parts[0], repo: parts[1] };
}

/**
 * Verifies that a branch in a git repository contains both Fixer and Test-Writer commits.
 */
export async function verifyBranchCommits(
  repoPath: string,
  branchName: string,
  baseBranch?: string
): Promise<BranchVerificationResult> {
  const git = simpleGit(repoPath);
  const isRepo = await git.checkIsRepo();
  if (!isRepo) {
    throw new Error(`Path is not a valid git repository: ${repoPath}`);
  }

  // Determine base branch
  const localBranches = await git.branchLocal();
  const base =
    baseBranch ??
    (localBranches.all.includes('main')
      ? 'main'
      : localBranches.all.includes('master')
      ? 'master'
      : localBranches.current);

  let commits: Array<{ hash: string; message: string }> = [];

  try {
    // Attempt git log between base and target branch
    const logResult = await git.log([`${base}..${branchName}`]);
    commits = logResult.all.map((c) => ({ hash: c.hash, message: c.message }));
  } catch {
    // Fallback: log for branch directly
    try {
      const logResult = await git.log([branchName, '-n', '20']);
      commits = logResult.all.map((c) => ({ hash: c.hash, message: c.message }));
    } catch {
      const logResult = await git.log({ maxCount: 20 });
      commits = logResult.all.map((c) => ({ hash: c.hash, message: c.message }));
    }
  }

  // Check commit patterns:
  // Fixer commits typically start with "fix(" or "fix:" or contain "fix"
  const hasFixCommit = commits.some(
    (c) => /^(fix|feat|chore)(\(.*\))?:/i.test(c.message) || /fix/i.test(c.message)
  );

  // Test-Writer commits typically start with "test(" or "test:" or contain "test"
  const hasTestCommit = commits.some(
    (c) => /^test(\(.*\))?:/i.test(c.message) || /test/i.test(c.message)
  );

  const hasEnoughCommits = commits.length >= 2;

  let reason: string | undefined;
  if (commits.length === 0) {
    reason = `No commits found on branch '${branchName}' relative to '${base}'.`;
  } else if (!hasFixCommit) {
    reason = `Branch '${branchName}' is missing a Fixer commit.`;
  } else if (!hasTestCommit) {
    reason = `Branch '${branchName}' is missing a Test-Writer commit.`;
  } else if (!hasEnoughCommits) {
    reason = `Branch '${branchName}' requires both Fixer and Test-Writer commits (found ${commits.length}).`;
  }

  const valid = Boolean(hasFixCommit && hasTestCommit && hasEnoughCommits);

  return {
    valid,
    reason,
    commits,
    hasFixCommit,
    hasTestCommit
  };
}

/**
 * Generates human-friendly command-line instructions for applying the patch manually.
 */
export function generateManualApplyInstructions(
  branchName: string,
  diff: string
): string {
  return [
    `# === Local-Only Manual Apply Instructions ===`,
    `# This project has no GitHub remote repository configured.`,
    `# You can apply this patch directly using one of the following methods:`,
    ``,
    `# Option 1: Merge the verified fix branch into main`,
    `git checkout main`,
    `git merge ${branchName}`,
    ``,
    `# Option 2: Apply the unified diff manually`,
    `git checkout main`,
    `git apply << 'EOF'`,
    diff.trim(),
    `EOF`,
    ``,
    `# Option 3: Cherry-pick the branch commits`,
    `git checkout main`,
    `git log ${branchName} -n 2 --oneline`,
    `# git cherry-pick <fix-commit-hash> <test-commit-hash>`
  ].join('\n');
}

/**
 * Finalizes local commits for an approved patch:
 * 1. Checks that the branch has all commits (Fixer + Test-Writer).
 * 2. Sets Patch status to 'ready_to_push'.
 * 3. Records an audit log entry.
 * 4. If project has no githubRepo configured, stops here (local-only manual apply path).
 * 5. Returns sync result including diff and manual instructions if local-only.
 */
export async function finalizeLocalCommits(
  patchId: string,
  options: GitSyncOptions = {}
): Promise<GitSyncResult> {
  const prisma = options.prisma ?? defaultPrisma;

  const patch = await prisma.patch.findUnique({
    where: { id: patchId },
    include: {
      ticket: {
        include: {
          project: true
        }
      }
    }
  });

  if (!patch) {
    throw new Error(`Patch with id '${patchId}' not found`);
  }

  // Ensure patch is in an approvable/finalizable state
  if (patch.status !== 'approved' && patch.status !== 'ready_to_push') {
    throw new Error(
      `Cannot finalize patch in status '${patch.status}'. Patch must be 'approved' before local commit finalization.`
    );
  }

  const projectPath =
    options.projectPath || patch.ticket.project.localPath;

  if (!projectPath || !fs.existsSync(projectPath)) {
    throw new Error(
      `Project local path '${projectPath}' does not exist or is not specified.`
    );
  }

  // 1. Confirm the worktree's branch has all commits (Fixer + Test-Writer)
  const verification = await verifyBranchCommits(
    projectPath,
    patch.branchName,
    options.baseBranch
  );

  if (!verification.valid) {
    throw new Error(
      `Cannot finalize patch '${patchId}': ${verification.reason}`
    );
  }

  // Generate full combined diff from git or fallback to patch.diff
  let combinedDiff = patch.diff;
  try {
    const git = simpleGit(projectPath);
    const localBranches = await git.branchLocal();
    const base =
      options.baseBranch ??
      (localBranches.all.includes('main')
        ? 'main'
        : localBranches.all.includes('master')
        ? 'master'
        : localBranches.current);

    const diffOutput = await git.diff([`${base}...${patch.branchName}`]);
    if (diffOutput && diffOutput.trim().length > 0) {
      combinedDiff = diffOutput;
    }
  } catch {
    // Keep patch.diff as fallback
  }

  // 2. Mark the Patch status 'ready_to_push'
  await prisma.patch.update({
    where: { id: patchId },
    data: { status: 'ready_to_push' }
  });

  // Record audit log
  await prisma.auditLog.create({
    data: {
      ticketId: patch.ticketId,
      actor: 'git-sync',
      action: 'patch_ready_to_push',
      details: {
        patchId: patch.id,
        branchName: patch.branchName,
        commitCount: verification.commits.length,
        isLocalOnly: !patch.ticket.project.githubRepo
      }
    }
  });

  const isLocalOnly = !patch.ticket.project.githubRepo;
  const manualApplyInstructions = isLocalOnly
    ? generateManualApplyInstructions(patch.branchName, combinedDiff)
    : undefined;

  return {
    patchId: patch.id,
    status: 'ready_to_push',
    branchName: patch.branchName,
    isLocalOnly,
    commitCount: verification.commits.length,
    commits: verification.commits,
    diff: combinedDiff,
    manualApplyInstructions
  };
}

/**
 * Remote Path:
 * Given a project with a githubRepo configured and a GitHub App installation token,
 * fetches and rebases the worktree branch onto the remote default branch, pushes it via simple-git,
 * and uses Octokit to open a PR with an LLM-generated title/description.
 *
 * On rebase or push conflict: sets Patch status 'failed_conflict' and does NOT force-push.
 * On success: sets Ticket and Patch status to 'pushed', and stores the prUrl on the Patch row.
 */
export async function pushAndCreatePullRequest(
  patchId: string,
  options: RemoteSyncOptions = {}
): Promise<RemoteSyncResult> {
  const prisma = options.prisma ?? defaultPrisma;

  const patch = await prisma.patch.findUnique({
    where: { id: patchId },
    include: {
      ticket: {
        include: {
          project: true
        }
      }
    }
  });

  if (!patch) {
    throw new Error(`Patch with id '${patchId}' not found`);
  }

  const project = patch.ticket.project;
  if (!project.githubRepo) {
    throw new Error(
      `Project '${project.name}' has no githubRepo configured. Remote sync cannot proceed.`
    );
  }

  const projectPath = options.projectPath || project.localPath;
  if (!projectPath || !fs.existsSync(projectPath)) {
    throw new Error(
      `Project local path '${projectPath}' does not exist or is not specified.`
    );
  }

  // Ensure local commits are finalized before remote push
  if (patch.status === 'approved') {
    await finalizeLocalCommits(patchId, options);
  } else if (patch.status !== 'ready_to_push') {
    throw new Error(
      `Cannot push patch in status '${patch.status}'. Patch must be 'ready_to_push' or 'approved'.`
    );
  }

  const { owner, repo } = parseGitHubRepo(project.githubRepo);
  const token =
    options.githubToken ??
    process.env.GITHUB_APP_TOKEN ??
    process.env.GITHUB_TOKEN;

  const git = simpleGit(projectPath);
  const remoteName = options.remoteName || 'origin';

  // Check existing remotes
  const remotes = await git.getRemotes(true);
  const existingRemote = remotes.find((r) => r.name === remoteName);

  // If remote doesn't exist, or needs authentication configured
  if (!existingRemote) {
    const remoteUrl = token
      ? `https://x-access-token:${token}@github.com/${owner}/${repo}.git`
      : `https://github.com/${owner}/${repo}.git`;
    await git.addRemote(remoteName, remoteUrl);
  } else if (
    token &&
    !existingRemote.refs.push?.startsWith('/') &&
    !existingRemote.refs.push?.startsWith('file://') &&
    !existingRemote.refs.push?.includes('@')
  ) {
    // Only update remote URL to include token if not a local filesystem repository
    const authUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
    await git.remote(['set-url', remoteName, authUrl]);
  }

  const defaultBranch = options.baseBranch ?? 'main';

  // 1. Fetch remote default branch
  try {
    await git.fetch(remoteName, defaultBranch);
  } catch (fetchErr: any) {
    throw new Error(
      `Failed to fetch '${remoteName}/${defaultBranch}': ${fetchErr.message}`
    );
  }

  // 2. Checkout branch and attempt rebase onto remote default branch
  await git.checkout(patch.branchName);

  try {
    await git.rebase([`${remoteName}/${defaultBranch}`]);
  } catch (rebaseErr: any) {
    // Rebase conflict encountered! Abort rebase and mark failed_conflict.
    try {
      await git.rebase(['--abort']);
    } catch {
      // ignore abort error
    }

    await prisma.patch.update({
      where: { id: patchId },
      data: { status: 'failed_conflict' }
    });

    await prisma.auditLog.create({
      data: {
        ticketId: patch.ticketId,
        actor: 'git-sync',
        action: 'rebase_conflict',
        details: {
          patchId: patch.id,
          branchName: patch.branchName,
          baseBranch: defaultBranch,
          error: rebaseErr.message
        }
      }
    });

    return {
      success: false,
      status: 'failed_conflict',
      patchId: patch.id,
      branchName: patch.branchName,
      error: `Rebase conflict detected on branch '${patch.branchName}' against '${remoteName}/${defaultBranch}': ${rebaseErr.message}. Force-push aborted.`
    };
  }

  // 3. Push via simple-git (NO force push)
  try {
    await git.push(remoteName, patch.branchName, ['--set-upstream']);
  } catch (pushErr: any) {
    await prisma.patch.update({
      where: { id: patchId },
      data: { status: 'failed_conflict' }
    });

    await prisma.auditLog.create({
      data: {
        ticketId: patch.ticketId,
        actor: 'git-sync',
        action: 'push_conflict',
        details: {
          patchId: patch.id,
          branchName: patch.branchName,
          error: pushErr.message
        }
      }
    });

    return {
      success: false,
      status: 'failed_conflict',
      patchId: patch.id,
      branchName: patch.branchName,
      error: `Push failed: ${pushErr.message}. Will not force-push.`
    };
  }

  // 4. Generate PR title and description using LLM
  let prSummary: PrSummary;
  try {
    const systemPrompt = loadPrompt(
      'git-sync',
      options.promptVersion ?? 'latest',
      {
        ticketTitle: patch.ticket.title,
        ticketDescription: patch.ticket.description,
        rationale: patch.rationale || 'Bug fix applied.',
        diff: patch.diff,
        testsAdded: 'Regression tests added to branch.'
      }
    );

    const userPrompt = `Generate a PR title and description for ticket "${patch.ticket.title}".`;

    const gitSyncTimeout =
      options.timeoutMs ??
      (process.env.GITSYNC_TIMEOUT_MS ? parseInt(process.env.GITSYNC_TIMEOUT_MS, 10) : 60000);

    prSummary = await generateStructured<PrSummary>({
      model: options.model ?? process.env.GITSYNC_MODEL ?? 'llama3:latest',
      systemPrompt,
      userPrompt,
      schema: PrSummarySchema,
      client: options.llmClient,
      promptVersion: options.promptVersion ?? 'git-sync/v1',
      timeoutMs: gitSyncTimeout
    });
  } catch {
    prSummary = {
      title: `fix: ${patch.ticket.title}`,
      body: `## Summary\n${patch.ticket.description}\n\n## Rationale\n${patch.rationale || 'Bug fix applied.'}\n\n## Verification\nRegression tests included in branch.`
    };
  }

  // 5. Open PR with Octokit
  const octokit = options.octokitClient ?? new Octokit({ auth: token });
  const prResponse = await octokit.rest.pulls.create({
    owner,
    repo,
    title: prSummary.title,
    body: prSummary.body,
    head: patch.branchName,
    base: defaultBranch
  });

  const prUrl = prResponse.data.html_url;
  const prNumber = prResponse.data.number;

  // 6. Update Patch and Ticket status in DB
  await prisma.patch.update({
    where: { id: patchId },
    data: {
      status: 'pushed',
      prUrl
    }
  });

  await prisma.ticket.update({
    where: { id: patch.ticketId },
    data: {
      status: 'pushed'
    }
  });

  await prisma.auditLog.create({
    data: {
      ticketId: patch.ticketId,
      actor: 'git-sync',
      action: 'pr_created',
      details: {
        patchId: patch.id,
        branchName: patch.branchName,
        prUrl,
        prNumber,
        prTitle: prSummary.title
      }
    }
  });

  return {
    success: true,
    status: 'pushed',
    patchId: patch.id,
    branchName: patch.branchName,
    prUrl,
    prNumber,
    prTitle: prSummary.title,
    prBody: prSummary.body
  };
}

/**
 * Unified sync entrypoint:
 * - If project has no githubRepo: finalizes local commits and returns manual apply instructions.
 * - If project has githubRepo: finalizes local commits, rebases, pushes, and creates PR.
 */
export async function finalizeAndSync(
  patchId: string,
  options: RemoteSyncOptions = {}
): Promise<GitSyncResult | RemoteSyncResult> {
  const prisma = options.prisma ?? defaultPrisma;

  const patch = await prisma.patch.findUnique({
    where: { id: patchId },
    include: {
      ticket: {
        include: {
          project: true
        }
      }
    }
  });

  if (!patch) {
    throw new Error(`Patch with id '${patchId}' not found`);
  }

  if (!patch.ticket.project.githubRepo) {
    return finalizeLocalCommits(patchId, options);
  }

  return pushAndCreatePullRequest(patchId, options);
}

/**
 * Exports/retrieves the diff for a patch (from git branch or database fallback).
 */
export async function exportPatchDiff(
  patchId: string,
  options: GitSyncOptions = {}
): Promise<string> {
  const prisma = options.prisma ?? defaultPrisma;

  const patch = await prisma.patch.findUnique({
    where: { id: patchId },
    include: {
      ticket: {
        include: {
          project: true
        }
      }
    }
  });

  if (!patch) {
    throw new Error(`Patch with id '${patchId}' not found`);
  }

  const projectPath =
    options.projectPath || patch.ticket.project.localPath;

  if (projectPath && fs.existsSync(projectPath)) {
    try {
      const git = simpleGit(projectPath);
      const localBranches = await git.branchLocal();
      const base =
        options.baseBranch ??
        (localBranches.all.includes('main')
          ? 'main'
          : localBranches.all.includes('master')
          ? 'master'
          : localBranches.current);

      const diffOutput = await git.diff([`${base}...${patch.branchName}`]);
      if (diffOutput && diffOutput.trim().length > 0) {
        return diffOutput;
      }
    } catch {
      // Fall through to patch.diff
    }
  }

  return patch.diff;
}
