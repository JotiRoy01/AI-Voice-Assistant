import { Queue, Worker, Job } from 'bullmq';
import { AppEnv } from '../config/env';
import { logger } from '../utils/logger';

export interface CallQueuePayload {
  tenantId: string;
  orderId: string;
  callJobId: string;
  attemptNo: number;
}

export interface CallQueueDriver {
  enqueueCallJob(payload: CallQueuePayload, delayMs?: number): Promise<void>;
  enqueueDeadLetter(payload: CallQueuePayload, errorMessage: string): Promise<void>;
  startWorker(handler: (payload: CallQueuePayload) => Promise<void>): void;
  close(): Promise<void>;
}

export class BullMqCallQueue implements CallQueueDriver {
  /**
   * ============================================================================
   * CLASS DESCRIPTION: BullMqCallQueue
   * - MEANING: Production Redis-backed durable job queue using BullMQ.
   * - WHY WE USE IT: When hundreds of orders arrive simultaneously from Shopify/WooCommerce, we cannot dial 500 phone calls in the same millisecond or block the webhook HTTP response. BullMQ stores call jobs durably in Redis, enforces concurrency & rate limits, supports delayed jobs (for overnight orders deferred to 09:00 AM and 15-minute no-answer retries), and moves permanently failed jobs to a Dead-Letter Queue (DLQ).
   * - WHERE IT IS USED: Created by `createCallQueue(env)` in `src/app.ts` and `src/worker.ts` when `QUEUE_MODE=bullmq`, and injected into `OrderIntakeService`, `VoiceCallService`, and `DtmfCallbackService`.
   * ============================================================================
   */
  private mainQueue: Queue<CallQueuePayload>;
  private dlq: Queue<CallQueuePayload & { errorMessage: string }>;
  private worker: Worker<CallQueuePayload> | null = null;
  private connection: { host: string; port: number; password?: string; maxRetriesPerRequest: null };

  constructor(private readonly env: AppEnv) {
    this.connection = {
      host: env.REDIS_HOST,
      port: env.REDIS_PORT,
      password: env.REDIS_PASSWORD || undefined,
      maxRetriesPerRequest: null,
    };
    this.mainQueue = new Queue<CallQueuePayload>('flowmind-voice-calls', {
      connection: this.connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 500,
        removeOnFail: 1000,
      },
    });
    this.dlq = new Queue<CallQueuePayload & { errorMessage: string }>('flowmind-voice-calls-dlq', {
      connection: this.connection,
      defaultJobOptions: { removeOnComplete: 1000 },
    });
  }

  async enqueueCallJob(payload: CallQueuePayload, delayMs = 0): Promise<void> {
    /**
     * METHOD DESCRIPTION: enqueueCallJob (BullMQ)
     * - CALLED BY: `OrderIntakeService.createAndEnqueueJob` (when a new order arrives) and `DtmfCallbackService.handleUnansweredOrFailed` (when scheduling a retry after `no_answer` or `busy`).
     * - INPUT SOURCE: `payload` (`{ tenantId, orderId, callJobId, attemptNo }`) and `delayMs` (milliseconds to wait before dialing, e.g., `0` for immediate calls or `900000` for a 15-minute retry).
     * - PURPOSE: Pushes the call job into the Redis `flowmind-voice-calls` queue with a deterministic `jobId` (`<callJobId>-att-<attemptNo>`) so Redis never queues duplicate attempts.
     */
    await this.mainQueue.add(`call-${payload.callJobId}-att-${payload.attemptNo}`, payload, {
      jobId: `${payload.callJobId}-att-${payload.attemptNo}`,
      delay: Math.max(0, delayMs),
    });
  }

  async enqueueDeadLetter(payload: CallQueuePayload, errorMessage: string): Promise<void> {
    /**
     * METHOD DESCRIPTION: enqueueDeadLetter (BullMQ)
     * - CALLED BY: `VoiceCallService.executeOutboundCall` (on fatal TTS failure), `DtmfCallbackService.handleUnansweredOrFailed` (after max retries fail), `voiceAndOrderRoutes.ts` (`POST /api/internal/jobs/dlq`), and BullMQ's own `worker.on('failed')` listener.
     * - INPUT SOURCE: `payload` (`CallQueuePayload`) and `errorMessage` describing why the call job permanently failed.
     * - PURPOSE: Moves the failed job into the Redis `flowmind-voice-calls-dlq` Dead-Letter Queue so operators can inspect and recover it from the Admin Dashboard Error Monitor.
     */
    await this.dlq.add(`dlq-${payload.callJobId}`, { ...payload, errorMessage });
  }

  startWorker(handler: (payload: CallQueuePayload) => Promise<void>): void {
    /**
     * METHOD DESCRIPTION: startWorker (BullMQ)
     * - CALLED BY: `createAppContainer` in `src/app.ts` (or standalone worker in `src/worker.ts`).
     * - INPUT SOURCE: `handler` is an async callback function (`(payload) => voiceCallService.processQueuedCallJob(payload)`).
     * - PURPOSE: Starts a background BullMQ Redis consumer worker that pulls ready jobs from `flowmind-voice-calls` (respecting `CALL_WORKER_CONCURRENCY` and rate limits) and passes them to `VoiceCallService`.
     */
    if (this.worker) return;
    this.worker = new Worker<CallQueuePayload>(
      'flowmind-voice-calls',
      async (job: Job<CallQueuePayload>) => {
        await handler(job.data);
      },
      {
        connection: this.connection,
        concurrency: this.env.CALL_WORKER_CONCURRENCY,
        limiter: {
          max: this.env.CALL_RATE_LIMIT_MAX,
          duration: this.env.CALL_RATE_LIMIT_DURATION_MS,
        },
      }
    );

    this.worker.on('failed', async (job, err) => {
      logger.error({ jobId: job?.id, err: err.message }, 'BullMQ voice call job failed');
      if (job && job.attemptsMade >= (job.opts.attempts ?? 3)) {
        await this.enqueueDeadLetter(job.data, err.message);
      }
    });
  }

  async close(): Promise<void> {
    /**
     * METHOD DESCRIPTION: close (BullMQ)
     * - CALLED BY: `appContainer.close()` during graceful server shutdown (`SIGINT` / `SIGTERM`).
     * - PURPOSE: Cleanly closes the BullMQ worker and Redis queue connections so no in-flight job is corrupted.
     */
    await this.worker?.close();
    await this.mainQueue.close();
    await this.dlq.close();
  }
}

export class InlineCallQueue implements CallQueueDriver {
  /**
   * ============================================================================
   * CLASS DESCRIPTION: InlineCallQueue
   * - MEANING: An in-memory, zero-Redis asynchronous job queue for fast local development and automated integration testing.
   * - WHY WE USE IT: Lets developers run `npm run dev:backend` and `npm test` on any laptop without installing or starting Redis, while keeping the exact same `CallQueueDriver` interface as `BullMqCallQueue`.
   * - WHERE IT IS USED: Instantiated by `createCallQueue(env)` when `QUEUE_MODE=inline` or `NODE_ENV=test`.
   * ============================================================================
   */
  private handler: ((payload: CallQueuePayload) => Promise<void>) | null = null;
  private timers = new Set<NodeJS.Timeout>();
  public readonly deadLetters: Array<CallQueuePayload & { errorMessage: string }> = [];
  public readonly pendingDelayed: Array<{ payload: CallQueuePayload; delayMs: number }> = [];

  constructor(private readonly executeImmediatelyInTest = false) {}

  async enqueueCallJob(payload: CallQueuePayload, delayMs = 0): Promise<void> {
    /**
     * METHOD DESCRIPTION: enqueueCallJob (InlineCallQueue)
     * - CALLED BY: `OrderIntakeService.createAndEnqueueJob` and `DtmfCallbackService.handleUnansweredOrFailed`.
     * - INPUT SOURCE: `payload` (`CallQueuePayload`) and `delayMs`.
     * - PURPOSE: In test mode (`executeImmediatelyInTest = true`), immediately executes 0-delay jobs and records delayed jobs in `this.pendingDelayed` (so tests don't hang waiting 15 minutes). In local dev mode, uses `setTimeout` to run the job asynchronously in the background.
     */
    if (!this.handler) return;
    if (delayMs > 0) {
      this.pendingDelayed.push({ payload, delayMs });
      if (this.executeImmediatelyInTest) {
        return;
      }
      const t = setTimeout(() => {
        this.timers.delete(t);
        this.runSafe(payload);
      }, delayMs);
      t.unref();
      this.timers.add(t);
      return;
    }

    if (this.executeImmediatelyInTest) {
      await this.runSafe(payload);
      return;
    }

    const t = setTimeout(() => {
      this.timers.delete(t);
      this.runSafe(payload);
    }, 10);
    t.unref();
    this.timers.add(t);
  }

  async enqueueDeadLetter(payload: CallQueuePayload, errorMessage: string): Promise<void> {
    /**
     * METHOD DESCRIPTION: enqueueDeadLetter (InlineCallQueue)
     * - CALLED BY: `VoiceCallService`, `DtmfCallbackService`, `voiceAndOrderRoutes.ts`, or `this.runSafe`.
     * - INPUT SOURCE: `payload` (`CallQueuePayload`) and `errorMessage`.
     * - PURPOSE: Appends failed jobs to the in-memory `this.deadLetters` array for inspection in tests and local dev.
     */
    this.deadLetters.push({ ...payload, errorMessage });
  }

  startWorker(handler: (payload: CallQueuePayload) => Promise<void>): void {
    /**
     * METHOD DESCRIPTION: startWorker (InlineCallQueue)
     * - CALLED BY: `createAppContainer` in `src/app.ts`.
     * - INPUT SOURCE: `handler` callback (`(payload) => voiceCallService.processQueuedCallJob(payload)`).
     * - PURPOSE: Registers the worker callback function that `enqueueCallJob` will invoke.
     */
    this.handler = handler;
  }

  async close(): Promise<void> {
    /**
     * METHOD DESCRIPTION: close (InlineCallQueue)
     * - CALLED BY: `appContainer.close()` during shutdown or at the end of a test suite.
     * - PURPOSE: Cancels any pending `setTimeout` timers.
     */
    for (const t of this.timers) {
      clearTimeout(t);
    }
    this.timers.clear();
  }

  private async runSafe(payload: CallQueuePayload): Promise<void> {
    /**
     * METHOD DESCRIPTION: runSafe
     * - CALLED BY: `this.enqueueCallJob` inside `InlineCallQueue`.
     * - INPUT SOURCE: `payload` (`CallQueuePayload`).
     * - PURPOSE: Wraps `this.handler(payload)` in a `try/catch` block so any unhandled exception is logged and routed to `this.enqueueDeadLetter` instead of crashing the Node.js process.
     */
    if (!this.handler) return;
    try {
      await this.handler(payload);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ callJobId: payload.callJobId, err: msg }, 'Inline worker failed');
      await this.enqueueDeadLetter(payload, msg);
    }
  }
}

/**
 * Factory Function: createCallQueue
 * - CALLED BY: `createAppContainer` in `src/app.ts` and `src/worker.ts`.
 * - PURPOSE: Returns `BullMqCallQueue` when connected to Redis (`QUEUE_MODE=bullmq`) or `InlineCallQueue` for zero-dependency local dev and testing.
 */
export function createCallQueue(env: AppEnv): CallQueueDriver {
  if (env.QUEUE_MODE === 'bullmq' && env.NODE_ENV !== 'test') {
    return new BullMqCallQueue(env);
  }
  return new InlineCallQueue(env.NODE_ENV === 'test');
}
