import { Logger, ScheduledJobArgs, ScheduledJobConfig } from '@medusajs/medusa';
import { EntityManager } from 'typeorm';

const STALE_AFTER = process.env.BATCH_RECOVER_AFTER ?? '1 hour';
const LOCK_TIMEOUT = process.env.BATCH_RECOVER_LOCK_TIMEOUT ?? '5s';

export default async function handler({ container }: ScheduledJobArgs) {
  const manager: EntityManager = container.resolve('manager');
  const logger: Logger = container.resolve('logger');

  await manager.transaction(async (tx) => {
    await tx.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);

    const recovered: { id: string; type: string }[] = await tx.query(
      `UPDATE batch_job
         SET failed_at = NOW(),
             result = COALESCE(result, '{}'::jsonb) || jsonb_build_object(
               'errors', jsonb_build_array(jsonb_build_object(
                 'message', 'Auto-recovered: stuck in confirmed state (worker likely crashed mid-process)',
                 'code', 'STALE_CONFIRMED'
               ))
             )
       WHERE failed_at IS NULL
         AND completed_at IS NULL
         AND canceled_at IS NULL
         AND confirmed_at IS NOT NULL
         AND processing_at IS NULL
         AND confirmed_at < NOW() - INTERVAL '${STALE_AFTER}'
       RETURNING id, type`,
    );

    if (recovered.length === 0) return;

    const byType = recovered.reduce<Record<string, number>>((acc, r) => {
      acc[r.type] = (acc[r.type] ?? 0) + 1;
      return acc;
    }, {});
    logger.warn(
      `recoverBatch: marked ${recovered.length} stale-confirmed batch jobs as failed: ${JSON.stringify(byType)}`,
    );
  });
}

export const config: ScheduledJobConfig = {
  name: 'recover-stale-batch-jobs',
  schedule: process.env.NODE_ENV === 'development' ? '' : '*/30 * * * *',
};
