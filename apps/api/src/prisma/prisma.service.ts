import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  bumpAccessVersion,
  lockAccessForChange,
  lockAccessShared,
} from '../access-control/access-lock.js';
import { currentRequestAccess, runInTransaction } from '../access-control/request-access.js';
import { APP_ENV, type AppEnv } from '../config/env.js';
import { Prisma, PrismaClient } from '../generated/prisma/client.js';

/** Model operations that write: each one runs under the access_state lock in a request. */
const WRITE_OPERATIONS = [
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
] as const;

type TxOptions = {
  maxWait?: number;
  timeout?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
};

/**
 * The only way the application reaches the database. Inject it into services
 * (never controllers). Branch scoping is applied in the service layer.
 *
 * Every interactive transaction of a signed-in request first locks access_state FOR SHARE and
 * refuses to run (409) when the request's access was computed at another version (plan 03,
 * section 5.4): a write either commits before a change of access, or runs after it with the
 * request refused. A write made outside a transaction (`prisma.x.update(...)`) is run inside one
 * for the same reason, so no write of a request escapes the lock. A change of access goes
 * through `changeAccess` instead.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(APP_ENV) env: AppEnv) {
    super({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }) });
    const plain = this.$transaction.bind(this) as (
      fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
      options?: TxOptions,
    ) => Promise<unknown>;
    this.plainTransaction = plain;
    const guarded = (arg: unknown, options?: TxOptions): Promise<unknown> => {
      const holder = currentRequestAccess();
      if (typeof arg !== 'function') {
        // Batch transactions cannot take the lock first; request code uses the callback form.
        if (holder?.version) throw new Error('Use an interactive transaction in request code');
        return (plain as unknown as (a: unknown, o?: TxOptions) => Promise<unknown>)(arg, options);
      }
      const fn = arg as (tx: Prisma.TransactionClient) => Promise<unknown>;
      const version = holder?.version;
      if (!holder || !version || holder.inTransaction) return plain(fn, options);
      return plain(
        (tx) =>
          runInTransaction(async () => {
            await lockAccessShared(tx, version);
            return fn(tx);
          }),
        options,
      );
    };
    this.$transaction = guarded as PrismaClient['$transaction'];

    // Transaction clients have their own model objects, so this wraps only top-level writes.
    const models = this as unknown as Record<string, Record<string, (args: unknown) => unknown>>;
    for (const name of Object.values(Prisma.ModelName)) {
      const key = name.charAt(0).toLowerCase() + name.slice(1);
      const model = models[key];
      if (!model) throw new Error(`No Prisma model ${key}`);
      for (const operation of WRITE_OPERATIONS) {
        const original = model[operation];
        if (typeof original !== 'function') continue;
        model[operation] = (args: unknown) => {
          const holder = currentRequestAccess();
          if (!holder?.version || holder.inTransaction) return original.call(model, args);
          return guarded((tx: Prisma.TransactionClient) => {
            const inTx = tx as unknown as typeof models;
            return Promise.resolve(inTx[key]![operation]!(args));
          });
        };
      }
    }
  }

  private readonly plainTransaction: (
    fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
    options?: TxOptions,
  ) => Promise<unknown>;

  /**
   * A change of who may do what (plan 03, section 5.4, AccessTx.change): locks access_state FOR
   * UPDATE first (never SHARE then UPDATE), refuses (409) when `actorVersion` is not the current
   * version, runs `fn` (which rechecks the actor's own right under the lock), then raises the
   * version, all in one transaction.
   */
  async changeAccess<R>(
    actorVersion: string,
    fn: (tx: Prisma.TransactionClient) => Promise<R>,
  ): Promise<R> {
    return (await this.plainTransaction((tx) =>
      runInTransaction(async () => {
        await lockAccessForChange(tx, actorVersion);
        const result = await fn(tx);
        await bumpAccessVersion(tx);
        return result;
      }),
    )) as R;
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
