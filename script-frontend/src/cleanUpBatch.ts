import dotenv from 'dotenv';
import 'zx/globals';
import { useSpinners } from './utils/spinners';
import { cancelSync, getAllBatchJobs } from './utils/medusa';
import type { BatchJob } from '@medusajs/client-types';
import { ask } from './utils/ask';
import { parseArgs } from './utils/parseArgs';
import { sleep } from 'zx';

$.verbose = false;

dotenv.config();
const args = parseArgs(
  {
    boolean: ['w', 'p', 's', 'g', 'c', 'x'],
    string: ['d', 'r'],
    alias: {
      w: 'watch',
      p: 'print',
      d: 'delay',
      g: 'group',
      s: 'sales',
      r: 'recent',
      c: 'category',
      x: 'purge',
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
    x: 'Purge empty-context syncs and sales batches; keep jobs with a category_id',
  },
);

const { log } = useSpinners('Sync', chalk.cyanBright);

function hasCategoryId(job: BatchJob): boolean {
  const ctx = (job.context ?? {}) as Record<string, unknown>;
  return Boolean(ctx.category_id || ctx.category);
}

function isPurgeTarget(job: BatchJob): boolean {
  if (hasCategoryId(job)) return false;
  const ctx = (job.context ?? {}) as Record<string, unknown>;
  return job.type.indexOf('sale') > -1 || Object.keys(ctx).length === 0;
}

try {
  const recentDays = args.recent ? parseInt(args.recent) : undefined;
  let jobs = await getAllBatchJobs(true, !args.status, args.sales, recentDays);
  log(`Found ${jobs.length} jobs`);

  if (args.purge) {
    const before = jobs.length;
    const kept = jobs.filter((j) => !isPurgeTarget(j));
    jobs = jobs.filter(isPurgeTarget);
    log(
      `Purge filter: ${chalk.redBright(jobs.length)} to cancel (empty/sales), ${chalk.green(kept.length)} kept (have category_id), of ${before} total`,
    );
  }
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
      const CANCEL_TIMEOUT_MS = 10_000;
      const CONCURRENCY = 5;

      const timedOut: BatchJob[] = [];
      const failed: { job: BatchJob; err: unknown }[] = [];
      let done = 0;

      const queue = [...jobs];
      async function worker() {
        while (queue.length) {
          const job = queue.shift();
          if (!job) return;
          try {
            await Promise.race([
              cancelSync(job.id),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error('cancel-timeout')), CANCEL_TIMEOUT_MS),
              ),
            ]);
          } catch (e) {
            if ((e as Error).message === 'cancel-timeout') {
              timedOut.push(job);
              log(chalk.yellow(`Timed out cancelling ${job.id} (${job.type}) — likely row-locked`));
            } else {
              failed.push({ job, err: e });
              log(chalk.red(`Failed to cancel ${job.id} (${job.type}): ${(e as Error).message}`));
            }
          } finally {
            done++;
            if (done % 10 === 0) log(`${done}/${jobs.length} processed`);
          }
        }
      }

      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));

      log(`Cancel sweep done: ${done - timedOut.length - failed.length} cancelled, ${timedOut.length} timed out, ${failed.length} errored`);
      if (timedOut.length > 0) {
        log(chalk.yellow(`The following are likely stuck (worker still holds the row lock); recover via SQL:`));
        const ids = timedOut.map((j) => `'${j.id}'`).join(',\n  ');
        log(`UPDATE batch_job SET canceled_at = NOW() WHERE id IN (\n  ${ids}\n) AND canceled_at IS NULL;`);
      }
    }
  } else {
    log(`No jobs to cancel`);
  }
} finally {
  process.exit();
}
