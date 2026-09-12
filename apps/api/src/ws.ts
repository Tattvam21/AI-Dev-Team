import { FastifyPluginAsync } from 'fastify';
import websocket from '@fastify/websocket';

export interface TicketWebSocketEvent {
  type: 'ticket_updated' | 'ticket_created' | 'ticket_deleted';
  ticketId: string;
  projectId: string;
  status: string;
  actor: string;
  ticket?: any;
  audit?: any;
  timestamp: string;
}

// Active connections indexed by projectId
const projectSockets = new Map<string, Set<any>>();

/**
 * Broadcasts an event to all WebSocket clients subscribed to a given projectId.
 */
export function broadcastTicketEvent(
  projectId: string,
  event: TicketWebSocketEvent
): void {
  const subscribers = projectSockets.get(projectId);
  if (!subscribers || subscribers.size === 0) return;

  const payload = JSON.stringify(event);

  for (const socket of subscribers) {
    try {
      // WebSocket.OPEN === 1
      if (socket.readyState === 1) {
        socket.send(payload);
      }
    } catch {
      subscribers.delete(socket);
    }
  }
}

/**
 * Returns the number of active WebSocket subscribers for a project (useful for testing/diagnostics).
 */
export function getSubscriberCount(projectId: string): number {
  return projectSockets.get(projectId)?.size ?? 0;
}

/**
 * Clears all active subscribers (useful for testing cleanup).
 */
export function clearSubscribers(): void {
  for (const set of projectSockets.values()) {
    for (const socket of set) {
      try {
        socket.close();
      } catch {}
    }
  }
  projectSockets.clear();
}

export const wsRoutes: FastifyPluginAsync = async (fastify) => {
  // Register fastify websocket plugin if not already registered
  if (!fastify.hasPlugin('@fastify/websocket')) {
    await fastify.register(websocket);
  }

  // WebSocket endpoint: /ws/projects/:id
  fastify.get(
    '/ws/projects/:id',
    { websocket: true },
    (socket /* WebSocket */, req) => {
      const { id: projectId } = req.params as { id: string };

      if (!projectId) {
        socket.close(1008, 'Project ID required');
        return;
      }

      if (!projectSockets.has(projectId)) {
        projectSockets.set(projectId, new Set());
      }
      const clientSet = projectSockets.get(projectId)!;
      clientSet.add(socket);

      // Send connection acknowledgement
      socket.send(
        JSON.stringify({
          type: 'connected',
          projectId,
          timestamp: new Date().toISOString()
        })
      );

      socket.on('close', () => {
        clientSet.delete(socket);
        if (clientSet.size === 0) {
          projectSockets.delete(projectId);
        }
      });

      socket.on('error', () => {
        clientSet.delete(socket);
        if (clientSet.size === 0) {
          projectSockets.delete(projectId);
        }
      });

      // Respond to client ping with pong
      socket.on('message', (data: any) => {
        try {
          const parsed = JSON.parse(data.toString());
          if (parsed.type === 'ping') {
            socket.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
          }
        } catch {
          // Ignore non-JSON messages
        }
      });
    }
  );
};
