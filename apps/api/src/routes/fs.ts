import { FastifyPluginAsync } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export const fsRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /fs/quick-dirs - Common starting directories
  fastify.get('/fs/quick-dirs', async () => {
    const home = os.homedir();
    const common = [
      { name: 'Home', path: home },
      { name: 'Documents', path: path.join(home, 'Documents') },
      { name: 'Desktop', path: path.join(home, 'Desktop') },
      { name: 'Downloads', path: path.join(home, 'Downloads') },
      { name: 'Current Workspace', path: process.cwd() }
    ];

    const validDirs = [];
    for (const item of common) {
      try {
        const stat = await fs.stat(item.path);
        if (stat.isDirectory()) {
          validDirs.push(item);
        }
      } catch {
        // ignore missing
      }
    }

    return { quickDirs: validDirs };
  });

  // GET /fs/browse - List subdirectories of a given directory
  fastify.get('/fs/browse', async (request, reply) => {
    const query = request.query as { path?: string };
    let targetPath = query.path ? path.resolve(query.path) : os.homedir();

    try {
      const stat = await fs.stat(targetPath);
      if (!stat.isDirectory()) {
        targetPath = path.dirname(targetPath);
      }

      const entries = await fs.readdir(targetPath, { withFileTypes: true });
      const directories: { name: string; path: string }[] = [];

      for (const entry of entries) {
        // Skip hidden folders like .git, .Trash, etc. unless explicitly desired
        if (entry.name.startsWith('.')) continue;
        if (entry.isDirectory()) {
          directories.push({
            name: entry.name,
            path: path.join(targetPath, entry.name)
          });
        }
      }

      directories.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

      const parentPath = path.dirname(targetPath) !== targetPath ? path.dirname(targetPath) : null;

      return reply.send({
        currentPath: targetPath,
        parentPath,
        directories
      });
    } catch (err: any) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: `Unable to read directory: ${err.message}`
      });
    }
  });

  // POST /fs/pick-folder - Open native macOS folder dialog via AppleScript
  fastify.post('/fs/pick-folder', async (request, reply) => {
    if (process.platform !== 'darwin') {
      return reply.status(400).send({
        error: 'Not Supported',
        message: 'Native folder dialog is only supported on macOS'
      });
    }

    try {
      // osascript prompt to select folder
      const script = `osascript -e 'set chosenFolder to choose folder with prompt "Select Project Folder:"' -e 'POSIX path of chosenFolder'`;
      const { stdout } = await execAsync(script, { timeout: 30000 });
      const selectedPath = stdout.trim();

      if (!selectedPath) {
        return reply.send({ cancelled: true });
      }

      return reply.send({ path: selectedPath, cancelled: false });
    } catch (err: any) {
      // User cancelled dialog
      if (err.message && (err.message.includes('User canceled') || err.code === 1)) {
        return reply.send({ cancelled: true });
      }
      return reply.status(500).send({
        error: 'NativeDialogError',
        message: err.message || 'Failed to open folder picker'
      });
    }
  });
};
