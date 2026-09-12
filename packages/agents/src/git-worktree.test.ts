import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { simpleGit } from 'simple-git';
import {
  createGitWorktree,
  sanitizeSlug
} from './git-worktree.js';

describe('Git Worktree Isolation Module', () => {
  let tempRepoPath: string;

  beforeAll(async () => {
    // Create an isolated git fixture repository
    tempRepoPath = path.join(os.tmpdir(), `test-git-repo-${Date.now()}`);
    fs.mkdirSync(tempRepoPath, { recursive: true });

    const git = simpleGit(tempRepoPath);
    await git.init(['-b', 'main']);
    await git.addConfig('user.name', 'AI Dev Test');
    await git.addConfig('user.email', 'test@aidevteam.local');

    // Create an initial commit
    fs.writeFileSync(path.join(tempRepoPath, 'README.md'), '# Test Project\nInitial content\n');
    await git.add('README.md');
    await git.commit('Initial commit');
  });

  afterAll(async () => {
    if (tempRepoPath && fs.existsSync(tempRepoPath)) {
      await fs.promises.rm(tempRepoPath, { recursive: true, force: true }).catch(() => {});
    }
  });

  describe('sanitizeSlug', () => {
    it('cleans special characters and truncates', () => {
      expect(sanitizeSlug('Fix: Null Pointer in auth.ts!')).toBe('fix-null-pointer-in-auth-ts');
      expect(sanitizeSlug('   ---spaces---   ')).toBe('spaces');
      expect(sanitizeSlug('')).toBe('fix');
      expect(sanitizeSlug(undefined)).toBe('fix');
    });
  });

  describe('createGitWorktree & cleanup', () => {
    it('creates an isolated worktree with the fix branch checked out and removes it on cleanup', async () => {
      const ticketId = 't-42';
      const slug = 'null-pointer-fix';

      const session = await createGitWorktree(tempRepoPath, ticketId, { slug });

      expect(session.branchName).toBe('fix/ticket-t-42-null-pointer-fix');
      expect(fs.existsSync(session.worktreePath)).toBe(true);

      // Verify file from main exists in the worktree
      expect(fs.existsSync(path.join(session.worktreePath, 'README.md'))).toBe(true);

      // Verify branch checked out inside the worktree
      const branchSummary = await session.git.branch();
      expect(branchSummary.current).toBe('fix/ticket-t-42-null-pointer-fix');

      // Verify worktree shows up in root git worktree list
      const rootGit = simpleGit(tempRepoPath);
      const worktreeList = await rootGit.raw(['worktree', 'list']);
      expect(worktreeList).toContain(session.worktreePath);

      // Perform cleanup
      await session.cleanup();

      // Confirm worktree directory is removed from disk
      expect(fs.existsSync(session.worktreePath)).toBe(false);

      // Confirm worktree is pruned from git tracking
      const worktreeListAfter = await rootGit.raw(['worktree', 'list']);
      expect(worktreeListAfter).not.toContain(session.worktreePath);
    });

    it('handles retries by reusing the existing branch without error', async () => {
      const ticketId = 'retry-99';
      const slug = 'cache-bug';

      // 1. First run creates the branch
      const session1 = await createGitWorktree(tempRepoPath, ticketId, { slug });
      expect(fs.existsSync(session1.worktreePath)).toBe(true);
      await session1.cleanup();
      expect(fs.existsSync(session1.worktreePath)).toBe(false);

      // 2. Retry run: branch already exists in localBranches
      const session2 = await createGitWorktree(tempRepoPath, ticketId, { slug });
      expect(session2.branchName).toBe('fix/ticket-retry-99-cache-bug');
      expect(fs.existsSync(session2.worktreePath)).toBe(true);

      const branchSummary = await session2.git.branch();
      expect(branchSummary.current).toBe('fix/ticket-retry-99-cache-bug');

      await session2.cleanup();
      expect(fs.existsSync(session2.worktreePath)).toBe(false);
    });

    it('throws when project path is not a git repository', async () => {
      const nonRepo = path.join(os.tmpdir(), `non-repo-${Date.now()}`);
      fs.mkdirSync(nonRepo, { recursive: true });

      try {
        await expect(createGitWorktree(nonRepo, 't-fail')).rejects.toThrow(
          /Path is not a valid git repository/
        );
      } finally {
        fs.rmSync(nonRepo, { recursive: true, force: true });
      }
    });
  });
});
