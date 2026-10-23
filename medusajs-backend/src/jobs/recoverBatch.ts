import { Logger, ScheduledJobArgs, ScheduledJobConfig } from '@medusajs/medusa';
import { EntityManager } from 'typeorm';

const STALE_AFTER = process.env.BATCH_RECOVER_AFTER ?? '1 hour';
const LOCK_TIMEOUT = process.env.BATCH_RECOVER_LOCK_TIMEOUT ?? '5s';

export default async function handler({ container }: ScheduledJobArgs) {
  const manager: EntityManager = container.resolve('manager');
  const logger: Logger = container.resolve('logger');

  await manager.transaction(async (tx) => {
    await tx.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);

    // Two stuck states, neither of which Medusa retries:
    // - confirmed but never processing: the worker crashed mid-process.
    // - never confirmed (non-dry-run): the batch.created subscriber failed, e.g. a DB
    //   blip. These also block new syncs of the same type via the "Already running" check.
    // Dry-run jobs legitimately wait in pre_processed for a manual confirm, so skip them.
    // UPDATE ... RETURNING through TypeORM's query() resolves to [rows, rowCount].
    const [recovered]: [{ id: string; type: string; code: string }[], number] = await tx.query(
      `UPDATE batch_job
         SET failed_at = NOW(),
             result = COALESCE(result, '{}'::jsonb) || jsonb_build_object(
               'errors', jsonb_build_array(
                 CASE WHEN confirmed_at IS NOT NULL
                   THEN jsonb_build_object(
                     'message', 'Auto-recovered: stuck in confirmed state (worker likely crashed mid-process)',
                     'code', 'STALE_CONFIRMED')
                   ELSE jsonb_build_object(
                     'message', 'Auto-recovered: never confirmed (batch.created handler likely failed)',
                     'code', 'STALE_CREATED')
                 END
               )
             )
       WHERE failed_at IS NULL
         AND completed_at IS NULL
         AND canceled_at IS NULL
         AND processing_at IS NULL
         AND (
           (confirmed_at IS NOT NULL AND confirmed_at < NOW() - INTERVAL '${STALE_AFTER}')
           OR (confirmed_at IS NULL AND dry_run = false AND created_at < NOW() - INTERVAL '${STALE_AFTER}')
         )
       RETURNING id, type, CASE WHEN confirmed_at IS NOT NULL THEN 'STALE_CONFIRMED' ELSE 'STALE_CREATED' END AS code`,
    );

    if (recovered.length === 0) return;

    const byType = recovered.reduce<Record<string, number>>((acc, r) => {
      const key = `${r.type} (${r.code})`;
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
    logger.warn(`recoverBatch: marked ${recovered.length} stale batch jobs as failed: ${JSON.stringify(byType)}`);
  });
}

export const config: ScheduledJobConfig = {
  name: 'recover-stale-batch-jobs',
  schedule: process.env.NODE_ENV === 'development' ? '' : '*/30 * * * *',
};
