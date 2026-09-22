import { asService } from '@orbit/database';
import type { WorkerDeps } from '../deps';

/**
 * Hourly housekeeping: bounded retention for bookkeeping tables so they never grow without
 * limit, and removal of private AI inputs/outputs once they are no longer needed.
 */
export async function runMaintenance(deps: WorkerDeps): Promise<Record<string, number>> {
  const day = 86_400_000;
  const ago = (days: number) => new Date(deps.now().getTime() - days * day);
  return asService(deps.sql, async (tx) => {
    const counts: Record<string, number> = {};
    const run = async (key: string, q: Promise<{ count: number }>) => {
      counts[key] = (await q).count;
    };
    await run('syncMutations', tx`delete from sync_mutations where applied_at < ${ago(30)}`);
    await run('rateLimits', tx`delete from rate_limits where window_start < ${ago(2)}`);
    await run('reminderDeliveries', tx`delete from reminder_deliveries where created_at < ${ago(90)}`);
    await run('notifications', tx`delete from notifications where (read_at is not null and created_at < ${ago(180)}) or (deleted_at is not null and deleted_at < ${ago(30)})`);
    await run('aiJobs', tx`delete from ai_jobs where finished_at < ${ago(30)} or (status in ('queued', 'running') and created_at < ${ago(7)})`);
    await run('snapshots', tx`delete from document_snapshots where (reason = 'periodic' and created_at < ${ago(30)}) or created_at < ${ago(180)}`);
    await run('pushTokens', tx`delete from push_tokens where failed_at < ${ago(30)}`);
    await run('webhookEvents', tx`delete from integration_webhook_events where received_at < ${ago(30)}`);
    await run('invitations', tx`update workspace_invitations set status = 'expired' where status = 'pending' and expires_at < now()`);
    return counts;
  });
}

/**
 * Delete meeting audio past its retention date (set from the owner's "keep audio" setting when
 * the meeting finishes). Transcripts and notes stay; only the recording is removed.
 */
export async function applyMeetingRetention(deps: WorkerDeps): Promise<{ meetings: number }> {
  const due = await asService(deps.sql, (tx) => tx<{ id: string; paths: string[] }[]>`
    select s.id, array_remove(array_agg(c.storage_path) || array[s.audio_path], null) as paths
      from meeting_sessions s left join meeting_audio_chunks c on c.meeting_id = s.id
     where s.retention_until < ${deps.now()} and s.audio_deleted_at is null
     group by s.id limit 200`);
  for (const m of due) {
    for (let i = 0; i < m.paths.length; i += 100) {
      try {
        await deps.storage.remove(m.paths.slice(i, i + 100));
      } catch (error) {
        if ((error as { code?: string }).code !== 'not_found') throw error;
      }
    }
    await asService(deps.sql, async (tx) => {
      await tx`delete from meeting_audio_chunks where meeting_id = ${m.id}`;
      await tx`update meeting_sessions set audio_path = null, audio_deleted_at = ${deps.now()} where id = ${m.id}`;
    });
  }
  return { meetings: due.length };
}
