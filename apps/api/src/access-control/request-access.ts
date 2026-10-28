import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';

/**
 * The access a request was authorized with, for the transactions it runs (plan 03, section 5.4).
 * The middleware opens an empty holder for every request; the auth guard fills it in.
 */
export interface RequestAccess {
  /** access_state.version the request's access was computed at; null until the guard ran. */
  version: string | null;
  /**
   * True inside a transaction this request opened: a transaction started from there (nested)
   * takes no second lock, since the outer one holds it. Transactions run side by side each lock.
   */
  inTransaction: boolean;
}

const storage = new AsyncLocalStorage<RequestAccess>();

/** Express middleware: every request runs inside its own holder. */
export function requestAccessContext(_req: Request, _res: Response, next: NextFunction): void {
  storage.run({ version: null, inTransaction: false }, next);
}

/** The holder of the request running now; undefined outside a request (seeds, timers). */
export function currentRequestAccess(): RequestAccess | undefined {
  return storage.getStore();
}

/** Records the version the guard computed the request's access at. */
export function setRequestAccessVersion(version: string): void {
  const holder = storage.getStore();
  if (holder) holder.version = version;
}

/** Runs `fn` marked as inside one of the request's transactions. */
export function runInTransaction<R>(fn: () => Promise<R>): Promise<R> {
  const holder = storage.getStore();
  if (!holder) return fn();
  return storage.run({ ...holder, inTransaction: true }, fn);
}
