import { RunControlMessageSchema, S1PilotError, can } from '@s1pilot/domain';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';

import type { ServerConfig } from '../config.js';

import type { HumanControl } from './control.js';
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
 * Client-to-server messages on the run socket are `RunControlMessageSchema` control messages (S-037, handled by
 * `control`); each is answered with `{type:'control.ack'}` or `{type:'control.error', code, message}`.
 * Workspace socket messages are ignored.
 */
export function registerLiveRoutes(app: FastifyInstance, hub: LiveHub, control?: HumanControl, config?: ServerConfig): void {
  app.get<{ Params: { runId: string } }>('/ws/runs/:runId', { websocket: true }, (socket, req) => {
    let unsubscribe: (() => void) | undefined;
    let closed = false;
    socket.on('close', () => {
      closed = true;
      unsubscribe?.();
    });
    socket.on('error', () => socket.close());
    socket.on('message', (data) => {
      const reply = (body: Record<string, unknown>): void => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(body));
      };
      let json: unknown;
      try {
        json = JSON.parse(String(data));
      } catch {
        reply({ type: 'control.error', code: 'INVALID_MESSAGE', message: 'Messages must be JSON' });
        return;
      }
      const parsed = RunControlMessageSchema.safeParse(json);
      if (!parsed.success || !control) {
        reply({ type: 'control.error', code: 'INVALID_MESSAGE', message: parsed.success ? 'Control is not available' : parsed.error.message });
        return;
      }
      // Team mode: the session user (the cookie is sent with the upgrade request); viewers cannot control runs.
      if (config?.mode === 'team' && !(req.sessionUser && can(req.sessionUser.role, 'runs:execute'))) {
        reply({ type: 'control.error', control: parsed.data.type, code: 'FORBIDDEN', message: 'Your role cannot control runs' });
        return;
      }
      control.handle(req.params.runId, req.sessionUser?.id ?? 'local', parsed.data).then(
        () => reply({ type: 'control.ack', control: parsed.data.type }),
        (error: unknown) => {
          if (!(error instanceof S1PilotError)) req.log.error({ err: error }, 'live: control failed');
          reply({
            type: 'control.error',
            control: parsed.data.type,
            code: error instanceof S1PilotError ? error.code : 'INTERNAL_ERROR',
            message: error instanceof Error ? error.message : String(error),
          });
        },
      );
    });
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
