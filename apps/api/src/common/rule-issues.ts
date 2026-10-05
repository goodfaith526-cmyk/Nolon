import { BadRequestException, ConflictException } from '@nestjs/common';
import type { ImportRowError } from '@nolon/shared';

/**
 * A broken business rule on one field. Services collect them with their rule checkers: a single
 * create or update throws the first (400), the Excel import reports every one per row and column.
 */
export interface RuleIssue {
  field: string;
  code: ImportRowError;
  message: string;
}

/** 400 with the first issue's message, when there is one. */
export function throwFirstIssue(issues: readonly RuleIssue[]): void {
  const [first] = issues;
  if (first) throw new BadRequestException(first.message);
}

/** 409 with the first issue's message, when there is one: the record would duplicate another. */
export function throwFirstConflict(issues: readonly (readonly RuleIssue[])[]): void {
  const first = issues.flat()[0];
  if (first) throw new ConflictException(first.message);
}

/**
 * Runs a master-data `require...` check: null when it passes, its message when it refuses with a
 * 400. Any other failure propagates.
 */
export async function refusal(check: () => Promise<unknown>): Promise<string | null> {
  try {
    await check();
    return null;
  } catch (error) {
    if (error instanceof BadRequestException) return error.message;
    throw error;
  }
}

/** Caches an async lookup by key, so a checker asks the database once per distinct value. */
export function memoAsync<R>(lookup: (key: string) => Promise<R>): (key: string) => Promise<R> {
  const cache = new Map<string, Promise<R>>();
  return (key) => {
    let hit = cache.get(key);
    if (!hit) {
      hit = lookup(key);
      cache.set(key, hit);
    }
    return hit;
  };
}
