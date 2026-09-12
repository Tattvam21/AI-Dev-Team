import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Load from root .env and local
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

import { buildApp } from './app.js';
import { closeQueues, initBullMqQueues, startApprovalWorkers } from './queue.js';



export * from './app.js';
export * from './state-machine.js';
export * from './queue.js';
export * from './routes/projects.js';
export * from './routes/tickets.js';
export * from './routes/patches.js';

export const API_SERVICE_NAME = 'ai-dev-team-api';

export async function startServer(port: number = 3000, host: string = '0.0.0.0') {
  const app = buildApp({ logger: true });

  // Initialize BullMQ queues and start background workers
  initBullMqQueues();
  startApprovalWorkers();
  console.log('[API] BullMQ queues & workers initialized');

  const shutdown = async () => {
    console.log('[API] Shutting down...');
    await app.close();
    await closeQueues();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await app.listen({ port, host });
    console.log(`[API] Server listening on http://${host}:${port}`);
    return app;

  } catch (err) {
    console.error('[API] Failed to start server:', err);
    process.exit(1);
  }
}

// Auto-run if started directly or AUTO_START_API is true
const isDirectRun = process.env.AUTO_START_API === 'true' || (process.argv[1] && (process.argv[1].endsWith('/index.ts') || process.argv[1].endsWith('/index.js')));
if (isDirectRun) {
  const port = parseInt(process.env.PORT || '3000', 10);
  startServer(port);
}

