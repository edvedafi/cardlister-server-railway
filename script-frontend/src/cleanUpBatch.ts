import dotenv from 'dotenv';
import 'zx/globals';
import { useSpinners } from './utils/spinners';
import { cancelSync, getAllBatchJobs } from './utils/medusa';

$.verbose = false;

dotenv.config();

const { log } = useSpinners('Sync', chalk.cyanBright);

try {
  const jobs = await getAllBatchJobs();
  log(`Found ${jobs.length} jobs to cancel`);
  for (const job of jobs) {
    await cancelSync(job.id);
  }
} finally {
  process.exit();
}
