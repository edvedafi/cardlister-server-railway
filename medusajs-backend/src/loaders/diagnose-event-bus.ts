import { AwilixContainer } from 'awilix';
import fs from 'fs';
import path from 'path';

const fmtUptime = (): string => process.uptime().toFixed(2) + 's';

const listDistSubscribers = (): string[] => {
  try {
    const distSubsDir = path.join(__dirname, '..', 'subscribers');
    return fs.readdirSync(distSubsDir);
  } catch (e) {
    return ['<readdir failed: ' + (e instanceof Error ? e.message : String(e)) + '>'];
  }
};

const listCoreMedusaSubscribers = (): string[] => {
  try {
    const corePath = require.resolve('@medusajs/medusa/dist/loaders/subscribers');
    const coreSubsDir = path.join(path.dirname(corePath), '..', 'subscribers');
    return fs.readdirSync(coreSubsDir).filter((f) => f.endsWith('.js'));
  } catch (e) {
    return ['<readdir failed: ' + (e instanceof Error ? e.message : String(e)) + '>'];
  }
};

const cradleKeys = (container: AwilixContainer): string[] => {
  try {
    const reg = (container as unknown as { registrations?: Record<string, unknown> }).registrations;
    if (reg) return Object.keys(reg).sort();
    const cradle = (container as unknown as { cradle?: Record<string, unknown> }).cradle;
    return cradle ? Object.keys(cradle).sort() : [];
  } catch (e) {
    return ['<cradle failed: ' + (e instanceof Error ? e.message : String(e)) + '>'];
  }
};

export default (container: AwilixContainer, _config: Record<string, unknown>): void => {
  const logger = (() => {
    try {
      return container.resolve('logger') as {
        info: (m: string) => void;
        warn: (m: string) => void;
        error: (m: string) => void;
      };
    } catch {
      return { info: console.log, warn: console.warn, error: console.error };
    }
  })();

  const tryResolve = <T = unknown>(name: string): { ok: true; value: T } | { ok: false; err: string } => {
    try {
      return { ok: true, value: container.resolve(name) as T };
    } catch (e) {
      return { ok: false, err: e instanceof Error ? e.message : String(e) };
    }
  };

  const describe = (val: unknown): string => {
    if (val == null) return String(val);
    const ctor = (val as { constructor?: { name?: string } })?.constructor?.name ?? 'unknown';
    return `${ctor}`;
  };

  const mapInfo = (svc: unknown): { size: number; events: string[] } => {
    const map = (svc as { eventToSubscribersMap?: Map<string, unknown[]> })?.eventToSubscribersMap;
    if (!map || typeof map.size !== 'number') return { size: -1, events: [] };
    return { size: map.size, events: Array.from(map.keys()) };
  };

  logger.info('[DIAG] ===== event-bus diagnostic loader uptime=' + fmtUptime() + ' =====');
  logger.info(
    '[DIAG] env node=' +
      process.versions.node +
      ' NODE_ENV=' +
      (process.env.NODE_ENV ?? 'unset') +
      ' pid=' +
      process.pid,
  );
  logger.info('[DIAG] dist/subscribers/ contents: ' + JSON.stringify(listDistSubscribers()));
  logger.info('[DIAG] core medusa subscribers (filesystem): ' + JSON.stringify(listCoreMedusaSubscribers()));
  logger.info('[DIAG] cradle keys (count=' + cradleKeys(container).length + '): ' + JSON.stringify(cradleKeys(container)));

  const eb = tryResolve('eventBusService');
  const em = tryResolve('eventBusModuleService');

  if (eb.ok === false) logger.error(`[DIAG] container.resolve('eventBusService') FAILED: ${eb.err}`);
  if (em.ok === false) logger.error(`[DIAG] container.resolve('eventBusModuleService') FAILED: ${em.err}`);

  if (eb.ok) logger.info(`[DIAG] eventBusService is a ${describe(eb.value)}`);
  if (em.ok) logger.info(`[DIAG] eventBusModuleService is a ${describe(em.value)}`);

  if (eb.ok && em.ok) {
    const inner = (eb.value as { eventBusModuleService_?: unknown }).eventBusModuleService_;
    const same = inner === em.value;
    logger.info(
      `[DIAG] eventBusService.eventBusModuleService_ === container.eventBusModuleService -> ${same} (innerCtor=${describe(
        inner,
      )})`,
    );

    const before = mapInfo(em.value);
    logger.info(`[DIAG] modular map size BEFORE test-subscribe: ${before.size}; events=${JSON.stringify(before.events)}`);

    try {
      (eb.value as { subscribe: (e: string, fn: (...a: unknown[]) => void) => void }).subscribe(
        'diag.test',
        () => {},
      );
      const after = mapInfo(em.value);
      logger.info(
        `[DIAG] modular map size AFTER test-subscribe via legacy: ${after.size} (delta=${after.size - before.size}); events=${JSON.stringify(
          after.events,
        )}`,
      );
    } catch (e) {
      logger.error(`[DIAG] test-subscribe via legacy FAILED: ${e instanceof Error ? e.message : String(e)}`);
    }

    try {
      (em.value as { subscribe: (e: string, fn: (...a: unknown[]) => void) => void }).subscribe(
        'diag.test.modular',
        () => {},
      );
      const after2 = mapInfo(em.value);
      logger.info(
        `[DIAG] modular map size AFTER test-subscribe via modular: ${after2.size}; events=${JSON.stringify(after2.events)}`,
      );
    } catch (e) {
      logger.error(`[DIAG] test-subscribe via modular FAILED: ${e instanceof Error ? e.message : String(e)}`);
    }

    const snapshot = (label: string): void => {
      const m = mapInfo(em.value);
      logger.info(
        `[DIAG] ${label} uptime=${fmtUptime()}: modular map size=${m.size}; events=${JSON.stringify(m.events)}`,
      );
      const rawMap = (em.value as { eventToSubscribersMap?: Map<string, unknown[]> }).eventToSubscribersMap;
      if (rawMap) {
        for (const [event, subs] of rawMap.entries()) {
          logger.info(`[DIAG] ${label}: event=${event} subscribers=${subs.length}`);
        }
      }
      // Re-confirm legacy === modular identity at this snapshot time
      const inner2 = (eb.value as { eventBusModuleService_?: unknown }).eventBusModuleService_;
      logger.info(
        `[DIAG] ${label}: legacy.eventBusModuleService_ === modular -> ${inner2 === em.value} (legacyInnerCtor=${describe(
          inner2,
        )})`,
      );
    };
    setTimeout(() => snapshot('T+2s'), 2_000);
    setTimeout(() => snapshot('T+10s'), 10_000);
    setTimeout(() => snapshot('T+45s'), 45_000);

    setTimeout(() => {
      const echoId = `diag-${Date.now()}`;
      try {
        (em.value as { subscribe: (e: string, fn: (data: unknown, eventName?: string) => void) => void }).subscribe(
          'diag.echo',
          (data, eventName) => {
            logger.info(`[DIAG] ROUND-TRIP OK: received ${eventName} id=${(data as { id?: string })?.id ?? 'n/a'}`);
          },
        );
        const emitter = em.value as { emit: (e: string, data: unknown) => Promise<void> };
        emitter
          .emit('diag.echo', { id: echoId })
          .then(() => logger.info(`[DIAG] emit('diag.echo', id=${echoId}) accepted by queue`))
          .catch((err: unknown) =>
            logger.error(`[DIAG] emit('diag.echo') REJECTED: ${err instanceof Error ? err.message : String(err)}`),
          );
      } catch (e) {
        logger.error(`[DIAG] round-trip setup FAILED: ${e instanceof Error ? e.message : String(e)}`);
      }
    }, 12_000);
  }

  logger.info('[DIAG] ===== end event-bus diagnostic loader =====');
};
