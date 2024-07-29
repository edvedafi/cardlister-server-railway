import dotenv from 'dotenv';
import 'zx/globals';
import { useSpinners } from './utils/spinners';
import { cancelSync, getAllBatchJobs } from './utils/medusa';
import { ask } from './utils/ask';

$.verbose = false;

dotenv.config();

const { log } = useSpinners('Sync', chalk.cyanBright);

try {
  const jobs = await getAllBatchJobs();
  if (jobs.length > 0) {
    const shouldCancel = await ask(`Cancel all ${jobs.length} jobs?`, false);
    if (shouldCancel) {
      for (const job of jobs) {
        await cancelSync(job.id);
      }
    }
  } else {
    log(`No jobs to cancel`);
  }
} finally {
  process.exit();
}
