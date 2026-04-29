import { Logger } from '@medusajs/medusa';
import { IEventBusService } from '@medusajs/types';

class DiagnoseAllSubscriber {
  protected readonly logger_: Logger;

  constructor({ eventBusService, logger }: { eventBusService: IEventBusService; logger: Logger }) {
    this.logger_ = logger;
    logger.info('[DIAG] DiagnoseAllSubscriber constructed; subscribing to batch.* and *');

    try {
      eventBusService.subscribe('batch.created', this.onBatchCreated);
      logger.info('[DIAG] subscribed batch.created OK');
    } catch (e) {
      logger.error(`[DIAG] subscribe batch.created FAILED: ${e instanceof Error ? e.message : String(e)}`);
    }

    try {
      eventBusService.subscribe('batch.confirmed', this.onBatchConfirmed);
      logger.info('[DIAG] subscribed batch.confirmed OK');
    } catch (e) {
      logger.error(`[DIAG] subscribe batch.confirmed FAILED: ${e instanceof Error ? e.message : String(e)}`);
    }

    try {
      eventBusService.subscribe('*', this.onAny);
      logger.info('[DIAG] subscribed * OK');
    } catch (e) {
      logger.error(`[DIAG] subscribe * FAILED: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  onBatchCreated = async (data: { id?: string }): Promise<void> => {
    this.logger_.info(`[DIAG] received batch.created id=${data?.id ?? 'n/a'}`);
  };

  onBatchConfirmed = async (data: { id?: string }): Promise<void> => {
    this.logger_.info(`[DIAG] received batch.confirmed id=${data?.id ?? 'n/a'}`);
  };

  onAny = async (data: unknown, eventName?: string): Promise<void> => {
    const id = (data as { id?: string })?.id;
    this.logger_.info(`[DIAG] wildcard received ${eventName ?? '?'} id=${id ?? 'n/a'}`);
  };
}

export default DiagnoseAllSubscriber;
