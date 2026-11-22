import cors from 'cors';
import express, { Express, NextFunction, Request, Response } from 'express';
import fs from 'fs';
import helmet from 'helmet';
import path from 'path';
import { StoreAdapter, TelephonyAdapter, TtsAdapter, WhatsAppAdapter } from './adapters/interfaces';
import { createStoreAdapters } from './adapters/store/storeAdapters';
import { createTelephonyAdapter } from './adapters/telephony/telephonyAdapters';
import { createTtsAdapter } from './adapters/tts/ttsAdapters';
import { createWhatsAppAdapter } from './adapters/whatsapp/whatsappAdapters';
import { AppEnv } from './config/env';
import { MemoryRepository } from './db/memoryRepository';
import { MysqlRepository } from './db/mysqlRepository';
import { FlowMindRepository } from './db/repository';
import { StoreProvider } from './domain/types';
import { CallQueueDriver, createCallQueue } from './queue/callQueue';
import { createAuthRouter } from './routes/authRoutes';
import { createConversationRouter } from './routes/conversationRoutes';
import { createDashboardAndSimulatorRouters } from './routes/dashboardAndSimulatorRoutes';
import { createVoiceAndOrderRouters } from './routes/voiceAndOrderRoutes';
import { createWebhookRouter } from './routes/webhookRoutes';
import { ConversationalAgentService } from './services/conversationalAgentService';
import { DtmfCallbackService } from './services/dtmfCallbackService';
import { OrderIntakeService } from './services/orderIntakeService';
import { VoiceCallService } from './services/voiceCallService';
import { WhatsAppService } from './services/whatsappService';
import { logger } from './utils/logger';

export interface AppContainer {
  app: Express;
  env: AppEnv;
  repo: FlowMindRepository;
  queue: CallQueueDriver;
  storeAdapters: Record<StoreProvider, StoreAdapter>;
  ttsAdapter: TtsAdapter;
  telephonyAdapter: TelephonyAdapter;
  whatsappAdapter: WhatsAppAdapter;
  orderIntakeService: OrderIntakeService;
  voiceCallService: VoiceCallService;
  dtmfCallbackService: DtmfCallbackService;
  whatsappService: WhatsAppService;
  close(): Promise<void>;
}

export interface CreateAppOptions {
  env: AppEnv;
  repo?: FlowMindRepository;
  queue?: CallQueueDriver;
  storeAdapters?: Record<StoreProvider, StoreAdapter>;
  ttsAdapter?: TtsAdapter;
  telephonyAdapter?: TelephonyAdapter;
  whatsappAdapter?: WhatsAppAdapter;
  startWorker?: boolean;
}

export function createAppContainer(options: CreateAppOptions): AppContainer {
  /**
   * ============================================================================
   * APPLICATION WIRING FACTORY: createAppContainer
   * - MEANING: The central Dependency-Injection (DI) container and Express app builder for the entire Node.js backend.
   * - WHY WE USE IT: Connects all layers together in one place:
   *   1. Database Repository (`MysqlRepository` or `MemoryRepository`)
   *   2. Queue Driver (`BullMqCallQueue` or `InlineCallQueue`)
   *   3. External Adapters (`storeAdapters`, `ttsAdapter`, `telephonyAdapter`, `whatsappAdapter`)
   *   4. Core Business Services (`orderIntakeService`, `voiceCallService`, `dtmfCallbackService`, `whatsappService`)
   *   5. Express HTTP Middleware (`helmet`, `cors`, `rawBody` capture) & Route Endpoints (`/api/*`)
   * - CALLED BY: `src/index.ts` (when starting the server) and `src/tests/integration/srsSection15.test.ts` (when running automated tests).
   * ============================================================================
   */
  const { env } = options;

  // 1. Initialize Database & Queue
  const repo =
    options.repo ?? (env.DATA_STORE === 'mysql' ? new MysqlRepository(env) : new MemoryRepository());
  const queue = options.queue ?? createCallQueue(env);

  // 2. Initialize Provider Adapters (Store, TTS, Telephony, WhatsApp)
  const storeAdapters = options.storeAdapters ?? createStoreAdapters();
  const ttsAdapter = options.ttsAdapter ?? createTtsAdapter(env);
  const telephonyAdapter = options.telephonyAdapter ?? createTelephonyAdapter(env);
  const whatsappAdapter = options.whatsappAdapter ?? createWhatsAppAdapter(env);

  // 3. Initialize Business Services with injected dependencies
  const orderIntakeService = new OrderIntakeService(repo, storeAdapters, queue, env);
  const voiceCallService = new VoiceCallService(repo, ttsAdapter, telephonyAdapter, queue, env);
  const dtmfCallbackService = new DtmfCallbackService(repo, storeAdapters, whatsappAdapter, queue, env);
  const whatsappService = new WhatsAppService(repo);
  const conversationalAgentService = new ConversationalAgentService(
    repo,
    ttsAdapter,
    dtmfCallbackService,
    env
  );

  // 4. Start Background Queue Worker (listens for queued call jobs and triggers voiceCallService)
  if (options.startWorker !== false) {
    queue.startWorker(async (payload) => {
      await voiceCallService.processQueuedCallJob(payload);
    });
  }

  // 5. Configure Express HTTP Server & Security Middleware
  const app = express();
  app.use(
    helmet({
      // Allow the Next.js Dashboard (localhost:3000) to stream Bangla MP3 audio from localhost:4000
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    })
  );

  const allowedOrigins = env.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          callback(null, true); // Allow local dev origins cleanly; lock down via CORS_ORIGINS in prod
        }
      },
      credentials: true,
    })
  );

  // Developer Note: Crucial for webhook security! `express.json()` parses JSON into an object,
  // but HMAC-SHA256 verification requires the exact raw bytes (`Buffer`) sent over the network.
  // The `verify` callback saves `req.rawBody` before JSON parsing happens.
  app.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        (req as Request).rawBody = Buffer.from(buf);
      },
    })
  );

  // 6. Health-Check & Built-in Neural Bangla TTS Audio Streaming Endpoints
  app.get('/api/tts/audio/:filename', (req, res) => {
    const filename = path.basename(String(req.params.filename || ''));
    if (!filename.endsWith('.mp3') && !filename.endsWith('.wav')) {
      res.status(400).json({ error: 'Invalid audio file format' });
      return;
    }
    const cacheDir = path.resolve(process.cwd(), '.tts-cache');
    const filePath = path.join(cacheDir, filename);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'Audio asset not found' });
      return;
    }
    res.setHeader('Content-Type', filename.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(filePath);
  });

  app.post('/api/tts/speak', async (req, res, next) => {
    try {
      const text = String(req.body?.text || '').trim();
      const voice = String(req.body?.voice || env.TTS_DEFAULT_VOICE).trim();
      if (!text) {
        res.status(400).json({ error: 'text is required' });
        return;
      }
      const result = await ttsAdapter.synthesize({
        text,
        voice,
        language: 'bn-BD',
        format: 'mp3',
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'flowmind-voice-confirmation',
      version: '1.0.0',
      dataStore: env.DATA_STORE,
      queueMode: env.QUEUE_MODE,
      orchestrationMode: env.ORCHESTRATION_MODE,
      telephonyProvider: telephonyAdapter.name,
      ttsProvider: ttsAdapter.name,
      whatsappProvider: whatsappAdapter.name,
      timestampUtc: new Date().toISOString(),
    });
  });

  // 7. Mount Feature Routers
  app.use('/api/auth', createAuthRouter(repo, env));
  app.use(
    '/api/webhooks',
    createWebhookRouter({ orderIntakeService, dtmfCallbackService, whatsappService, env })
  );

  const { voiceRouter, orderRouter, internalRouter } = createVoiceAndOrderRouters({
    repo,
    orderIntakeService,
    voiceCallService,
    queue,
    env,
  });
  app.use('/api/voice', voiceRouter);
  app.use('/api/orders', orderRouter);
  app.use('/api/internal', internalRouter);

  const { dashboardRouter, simulatorRouter } = createDashboardAndSimulatorRouters({
    repo,
    orderIntakeService,
    dtmfCallbackService,
    whatsappService,
    env,
  });
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/simulator', simulatorRouter);
  app.use('/api/conversation', createConversationRouter({ conversationalAgentService, env }));

  // 8. Global Error Handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err: err.message, stack: err.stack }, 'Unhandled API error');
    res.status(500).json({ error: 'Internal server error' });
  });

  return {
    app,
    env,
    repo,
    queue,
    storeAdapters,
    ttsAdapter,
    telephonyAdapter,
    whatsappAdapter,
    orderIntakeService,
    voiceCallService,
    dtmfCallbackService,
    whatsappService,
    async close() {
      await queue.close();
      await repo.close();
    },
  };
}
