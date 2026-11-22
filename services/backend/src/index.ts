import { createAppContainer } from './app';
import { env } from './config/env';
import { seedInitialData } from './db/seedData';
import { logger } from './utils/logger';

async function bootstrap(): Promise<void> {
  const container = createAppContainer({
    env,
    // In production BullMQ mode, the dedicated worker process handles queue jobs.
    // In inline dev mode, run the worker inside the API process.
    startWorker: env.QUEUE_MODE === 'inline',
  });

  if (env.DATA_STORE === 'memory' || env.NODE_ENV === 'development') {
    await seedInitialData(container.repo, env);
    logger.info('Seeded demo tenants, users, voice settings, and sample orders');
  }

  const server = container.app.listen(env.PORT, () => {
    logger.info(
      {
        port: env.PORT,
        dataStore: env.DATA_STORE,
        queueMode: env.QUEUE_MODE,
        telephony: container.telephonyAdapter.name,
        tts: container.ttsAdapter.name,
      },
      'FlowMind AI Voice Confirmation API started'
    );
  });

  const shutdown = async () => {
    logger.info('Gracefully shutting down FlowMind API...');
    server.close();
    await container.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

bootstrap().catch((err) => {
  logger.fatal({ err }, 'Failed to start FlowMind API');
  process.exit(1);
});
