import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Flags } from './flags.js';

/** Mutable state of one running fixture server (resets when the server restarts). */
export interface ServerState {
  settings: { name: string; email: string; notifications: boolean; darkMode: boolean; deleted: boolean };
}

/** Everything a site handler needs for one request. */
export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  /** Path below the site root, always starting with `/` (e.g. `/product/classic-tee`). */
  path: string;
  flags: Flags;
  state: ServerState;
  /** Reads an `application/x-www-form-urlencoded` body. */
  form(): Promise<URLSearchParams>;
  /** Reads a JSON body. */
  json(): Promise<unknown>;
  html(body: string, status?: number): void;
  redirect(location: string, headers?: Record<string, string>): void;
  sendJson(body: unknown, status?: number): void;
  notFound(): void;
}

/** A site handler returns after responding. */
export type SiteHandler = (ctx: Ctx) => Promise<void> | void;
