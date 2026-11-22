import { createAppContainer } from './app';
import { env } from './config/env';
import { logger } from './utils/logger';

async function startWorker(): Promise<void> {
  const container = createAppContainer({
    env,
    startWorker: true,
  });

  logger.info(
    {
      queueMode: env.QUEUE_MODE,
      orchestrationMode: env.ORCHESTRATION_MODE,
      concurrency: env.CALL_WORKER_CONCURRENCY,
    },
    'FlowMind AI BullMQ Voice Call Worker running'
  );

  const shutdown = async () => {
    logger.info('Shutting down FlowMind Worker...');
    await container.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

startWorker().catch((err) => {
  logger.fatal({ err }, 'Failed to start FlowMind Worker');
  process.exit(1);
});
