import os from 'os';

const installed = (process as unknown as { __bootTrapInstalled?: boolean }).__bootTrapInstalled;
if (!installed) {
  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
    console.error('[BOOT-TRAP] unhandledRejection: ' + msg);
  });
  process.on('uncaughtException', (err, origin) => {
    console.error('[BOOT-TRAP] uncaughtException origin=' + origin + ': ' + (err.stack ?? err.message));
  });
  (process as unknown as { __bootTrapInstalled?: boolean }).__bootTrapInstalled = true;
  console.log(
    '[BOOT-TRAP] handlers installed at ' +
      new Date().toISOString() +
      ' node=' +
      process.versions.node +
      ' env=' +
      (process.env.NODE_ENV ?? 'unset') +
      ' platform=' +
      os.platform() +
      ' arch=' +
      os.arch() +
      ' pid=' +
      process.pid +
      ' uptime=' +
      process.uptime().toFixed(2) +
      's',
  );
}

export default (): void => {
  console.log('[BOOT-TRAP] loader invoked uptime=' + process.uptime().toFixed(2) + 's');
};
