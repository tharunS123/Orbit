import { AppError, type ErrorCode } from '@orbit/shared';
import { asUser, mapDbError, type Sql, type Tx } from '@orbit/database';
import type { PlanId } from '@orbit/core';
import { isMutatorName, mutatorArgs, type MutatorName } from '../mutators';
import type { MutationResult, PushRequest, PushResponse } from '../protocol';
import { serverMutators, type ServerCtx } from './mutators';

export interface Job {
  name: string;
  data: Record<string, unknown>;
  opts?: { singletonKey?: string; startAfter?: Date };
}

/** Sends jobs after the originating transaction commits. Worker sweeps cover crashes in between. */
export interface JobQueue {
  send(jobs: Job[]): Promise<void>;
}

export interface PushDeps {
  sql: Sql;
  queue?: JobQueue;
  log?: (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void;
}

/** Errors that will never succeed on retry — the mutation is rejected and reported to the user. */
const PERMANENT: ReadonlySet<ErrorCode> = new Set([
  'forbidden',
  'not_found',
  'deleted',
  'validation',
  'conflict',
  'quota_exceeded',
  'plan_required',
]);

export async function planFor(tx: Tx, userId: string): Promise<PlanId> {
  const [row] = await tx<{ plan: PlanId }[]>`select app.user_plan(${userId}) as plan`;
  return row?.plan ?? 'free';
}

/** Run a single mutator in its own RLS transaction. Exposed for MCP/API reuse. */
export async function runMutation<N extends MutatorName>(
  deps: PushDeps,
  userId: string,
  name: N,
  rawArgs: unknown,
  opts: { mutationId?: string; clientId?: string } = {},
): Promise<{ status: 'applied' | 'duplicate' }> {
  const parsed = mutatorArgs[name].safeParse(rawArgs);
  if (!parsed.success) {
    throw new AppError('validation', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  const jobs: Job[] = [];
  const result = await asUser(deps.sql, { userId }, async (tx) => {
    if (opts.mutationId) {
      await tx`select pg_advisory_xact_lock(hashtextextended(${opts.mutationId}, 0))`;
      const [seen] = await tx<{ status: string }[]>`select status from sync_mutations where id = ${opts.mutationId}`;
      if (seen) return { status: 'duplicate' as const };
    }
    let plan: PlanId | undefined;
    const ctx: ServerCtx = {
      tx,
      userId,
      now: new Date(),
      plan: async () => (plan ??= await planFor(tx, userId)),
      enqueue: async (jobName, data, jobOpts) => {
        jobs.push({ name: jobName, data, opts: jobOpts });
      },
    };
    await (serverMutators[name] as (c: ServerCtx, a: unknown) => Promise<void>)(ctx, parsed.data);
    if (opts.mutationId) {
      await tx`insert into sync_mutations (id, user_id, client_id, name, status)
               values (${opts.mutationId}, ${userId}, ${opts.clientId ?? opts.mutationId}, ${name}, 'applied')`;
    }
    return { status: 'applied' as const };
  });
  if (jobs.length && deps.queue) {
    await deps.queue.send(jobs).catch((error) => deps.log?.('error', 'job enqueue failed (sweeps will retry)', { error: String(error) }));
  }
  return result;
}

export async function handlePush(deps: PushDeps, userId: string, req: PushRequest): Promise<PushResponse> {
  const results: MutationResult[] = [];
  let incomplete = false;

  for (const m of req.mutations) {
    if (!isMutatorName(m.name)) {
      results.push(await reject(deps, userId, req.clientId, m.id, m.name, new AppError('validation', `Unknown mutation "${m.name}".`)));
      continue;
    }
    try {
      const res = await runMutation(deps, userId, m.name, m.args, { mutationId: m.id, clientId: req.clientId });
      if (res.status === 'applied') {
        results.push({ id: m.id, status: 'applied' });
      } else {
        // Already decided earlier (client retry): report the original outcome.
        const [row] = await asUser(deps.sql, { userId }, (tx) => tx<{ status: 'applied' | 'rejected'; error: { code: string; message: string } | null }[]>`
          select status, error from sync_mutations where id = ${m.id}`);
        results.push(row?.status === 'rejected' ? { id: m.id, status: 'rejected', error: row.error ?? undefined } : { id: m.id, status: 'applied' });
      }
    } catch (error) {
      const err = AppError.from(mapDbError(error));
      if (PERMANENT.has(err.code)) {
        results.push(await reject(deps, userId, req.clientId, m.id, m.name, err));
        continue;
      }
      deps.log?.('error', 'mutation failed transiently', { mutation: m.name, id: m.id, code: err.code, error: String((error as Error)?.message ?? error) });
      incomplete = true;
      break; // keep order: stop here, client retries from this mutation
    }
  }

  await asUser(deps.sql, { userId }, (tx) => tx`
    insert into sync_devices (id, user_id, last_push_at) values (${req.clientId}, ${userId}, now())
    on conflict (id) do update set last_push_at = now()`).catch(() => undefined);

  return { results, incomplete };
}

async function reject(deps: PushDeps, userId: string, clientId: string, id: string, name: string, err: AppError): Promise<MutationResult> {
  const error = { code: err.code, message: err.message };
  await asUser(deps.sql, { userId }, (tx) => tx`
    insert into sync_mutations (id, user_id, client_id, name, status, error)
    values (${id}, ${userId}, ${clientId}, ${name.slice(0, 64)}, 'rejected', ${tx.json(error as never)})
    on conflict (id) do nothing`);
  deps.log?.('warn', 'mutation rejected', { mutation: name, id, code: err.code });
  return { id, status: 'rejected', error };
}
