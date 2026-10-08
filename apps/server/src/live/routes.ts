import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';

import type { LiveClient, LiveHub } from './hub.js';

/** Frames are dropped for clients whose send buffer exceeds this many bytes. */
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

function clientFor(socket: WebSocket): LiveClient {
  return {
    sendText: (text) => {
      if (socket.readyState === socket.OPEN) socket.send(text);
    },
    sendBinary: (data) => {
      if (socket.readyState === socket.OPEN && socket.bufferedAmount < MAX_BUFFERED_BYTES) socket.send(data, { binary: true });
    },
  };
}

/**
 * Registers `GET /ws/runs/:runId` (snapshot, events, screencast frames) and `GET /ws/workspace` (run status and
 * count updates for nav badges and the dashboard). Needs `@fastify/websocket` to be registered first.
 * Client-to-server messages are ignored; TODO(S-037): control messages.
 */
export function registerLiveRoutes(app: FastifyInstance, hub: LiveHub): void {
  app.get<{ Params: { runId: string } }>('/ws/runs/:runId', { websocket: true }, (socket, req) => {
    let unsubscribe: (() => void) | undefined;
    let closed = false;
    socket.on('close', () => {
      closed = true;
      unsubscribe?.();
    });
    socket.on('error', () => socket.close());
    hub.subscribeRun(req.params.runId, clientFor(socket)).then(
      (remove) => {
        if (!remove) {
          socket.close(1008, 'run not found');
        } else if (closed) {
          remove();
        } else {
          unsubscribe = remove;
        }
      },
      (error: unknown) => {
        req.log.error({ err: error }, 'live: subscribe failed');
        socket.close(1011, 'internal error');
      },
    );
  });

  app.get('/ws/workspace', { websocket: true }, (socket, req) => {
    let unsubscribe: (() => void) | undefined;
    let closed = false;
    socket.on('close', () => {
      closed = true;
      unsubscribe?.();
    });
    socket.on('error', () => socket.close());
    hub.subscribeWorkspace(clientFor(socket)).then(
      (remove) => {
        if (closed) remove();
        else unsubscribe = remove;
      },
      (error: unknown) => {
        req.log.error({ err: error }, 'live: workspace subscribe failed');
        socket.close(1011, 'internal error');
      },
    );
  });
}
