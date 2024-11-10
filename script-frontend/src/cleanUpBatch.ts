import dotenv from 'dotenv';
import 'zx/globals';
import { useSpinners } from './utils/spinners';
import { cancelSync, getAllBatchJobs } from './utils/medusa';
import { ask } from './utils/ask';
import { parseArgs } from './utils/parseArgs';
import { sleep } from 'zx';

$.verbose = false;

dotenv.config();
const args = parseArgs(
  {
    boolean: ['w', 'p'],
    alias: {
      w: 'watch',
      p: 'print',
    },
  },
  {
    w: 'Watch the Count',
    p: 'Print all open jobs',
  },
);

const { log } = useSpinners('Sync', chalk.cyanBright);

try {
  const jobs = await getAllBatchJobs();
  if (args.print) {
    jobs.forEach((job) => {
      log(`Job ${job.id} - ${job.created_at}: ${job.type} => ${JSON.stringify(job.context)} ${job.status}`);
    });
  }
  const start = jobs.length;
  while (args.watch) {
    const current = await getAllBatchJobs(!args.watch);
    console.log(` ${current.length} / ${start}`);
    await sleep(5000);
  }
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
