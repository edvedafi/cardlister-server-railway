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
    boolean: ['w', 'p', 's', 'g', 'c'],
    string: ['d', 'r'],
    alias: {
      w: 'watch',
      p: 'print',
      d: 'delay',
      g: 'group',
      s: 'sales',
      r: 'recent',
      c: 'category',
    },
  },
  {
    w: 'Watch the Count',
    p: 'Print all open jobs',
    d: 'Delay between checks',
    g: 'Group output for display by status',
    s: 'Only return sales jobs',
    r: 'Only return jobs created within N days (e.g. -r 5)',
    c: 'Group syncs by category ID (spot duplicates)',
  },
);

const { log } = useSpinners('Sync', chalk.cyanBright);

try {
  const recentDays = args.recent ? parseInt(args.recent) : undefined;
  const jobs = await getAllBatchJobs(true, !args.status, args.sales, recentDays);
  log(`Found ${jobs.length} jobs`);
  if (args.print) {
    jobs.forEach((job) => {
      log(`Job ${job.id} - ${job.created_at}: ${job.type} => ${JSON.stringify(job.context)} ${job.status}`);
    });
  }
  function groupByType(jobList: typeof jobs): { [type: string]: number } {
    return jobList.reduce((acc: { [type: string]: number }, job) => {
      acc[job.type] = (acc[job.type] || 0) + 1;
      return acc;
    }, {});
  }

  function groupByCategory(jobList: typeof jobs): { [categoryId: string]: { types: string[]; count: number } } {
    return jobList.reduce((acc: { [categoryId: string]: { types: string[]; count: number } }, job) => {
      const catId = (job.context?.category as string) ?? 'unknown';
      if (!acc[catId]) {
        acc[catId] = { types: [], count: 0 };
      }
      acc[catId].types.push(job.type);
      acc[catId].count++;
      return acc;
    }, {});
  }

  function printCategoryGroups(catGroups: ReturnType<typeof groupByCategory>) {
    const sorted = Object.entries(catGroups).sort((a, b) => b[1].count - a[1].count);
    for (const [catId, { types, count }] of sorted) {
      const typeCounts = types.reduce((acc: { [t: string]: number }, t) => {
        acc[t] = (acc[t] || 0) + 1;
        return acc;
      }, {});
      const dupes = Object.entries(typeCounts).filter(([, c]) => c > 1);
      const dupWarn = dupes.length > 0
        ? chalk.redBright(` ⚠ DUPLICATE: ${dupes.map(([t, c]) => `${t}×${c}`).join(', ')}`)
        : '';
      const typeList = Object.entries(typeCounts).map(([t, c]) => c > 1 ? `${t}×${c}` : t).join(', ');
      log(`${chalk.yellow(catId)} (${count} jobs): ${typeList}${dupWarn}`);
    }
  }

  const startByType = groupByType(jobs);

  if (args.group) {
    for (const [type, count] of Object.entries(startByType)) {
      log(`${count} ${type}`);
    }
  }

  if (args.category) {
    const catGroups = groupByCategory(jobs);
    log(`\n${chalk.bold('Syncs by Category:')}`);
    printCategoryGroups(catGroups);
    log(`\n${Object.keys(catGroups).length} categories, ${jobs.length} total jobs`);
  }

  const start = jobs.length;
  if (args.watch) {
    if (args.category) {
      // Category watch mode: clear and redraw each tick
      while (args.watch) {
        await sleep(args.delay ? parseInt(args.delay) : 5000);
        const current = await getAllBatchJobs(false, true, false, recentDays);
        console.clear();
        log(`${chalk.bold('Syncs by Category:')} (${current.length} jobs)`);
        printCategoryGroups(groupByCategory(current));
      }
    } else {
      const typeKeys = Object.keys(startByType);
      const lineCount = args.group ? typeKeys.length + 1 : 1;

      if (args.group) {
        for (const type of typeKeys) {
          process.stdout.write(` ${startByType[type]}/${startByType[type]} ${type}\n`);
        }
        process.stdout.write(` ${start}/${start} total\n`);
      } else {
        process.stdout.write(` ${start} / ${start}`);
      }

      while (args.watch) {
        await sleep(args.delay ? parseInt(args.delay) : 5000);
        const current = await getAllBatchJobs(false, true, false, recentDays);

        // Move cursor up to overwrite previous lines
        process.stdout.write(`\x1b[${lineCount}A\r`);

        if (args.group) {
          const currentByType = groupByType(current);
          for (const type of typeKeys) {
            const cur = currentByType[type] || 0;
            const line = ` ${cur}/${startByType[type]} ${type}`;
            process.stdout.write(`${line}\x1b[K\n`);
          }
          process.stdout.write(` ${current.length}/${start} total\x1b[K\n`);
        } else {
          process.stdout.write(` ${current.length} / ${start}\x1b[K`);
        }
      }
    }
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
