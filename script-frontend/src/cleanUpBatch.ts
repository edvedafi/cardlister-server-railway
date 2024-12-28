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
    boolean: ['w', 'p', 's', 'g'],
    string: ['d'],
    alias: {
      w: 'watch',
      p: 'print',
      d: 'delay',
      g: 'group',
      s: 'sales',
    },
  },
  {
    w: 'Watch the Count',
    p: 'Print all open jobs',
    d: 'Delay between checks',
    g: 'Group output for display by status',
    s: 'Only return sales jobs',
  },
);

const { log } = useSpinners('Sync', chalk.cyanBright);

try {
  const jobs = await getAllBatchJobs(true, !args.status, args.sales);
  log(`Found ${jobs.length} jobs`);
  if (args.print) {
    jobs.forEach((job) => {
      log(`Job ${job.id} - ${job.created_at}: ${job.type} => ${JSON.stringify(job.context)} ${job.status}`);
    });
  }
  if (args.status) {
    const byStatus: { [key: string]: number } = jobs.reduce((acc: { [key: string]: number }, job) => {
      if (!acc[job.status]) {
        acc[job.status] = 0;
      }
      acc[job.status] += 1;
      return acc;
    }, {});
    for (const [key, value] of Object.entries(byStatus)) {
      log(`${key}: ${value}`);
    }
  }
  const start = jobs.length;
  while (args.watch) {
    const current = await getAllBatchJobs(!args.watch);
    console.log(` ${current.length} / ${start}`);
    await sleep(args.delay ? parseInt(args.delay) : 5000);
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
