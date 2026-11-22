import crypto from 'crypto';
import { TelephonyAdapter, TtsAdapter } from '../adapters/interfaces';
import { AppEnv } from '../config/env';
import { FlowMindRepository } from '../db/repository';
import { buildOrderVerificationPrompt } from '../domain/banglaPrompt';
import { isOrderStaleForConfirmation } from '../domain/eligibility';
import { VoiceCall } from '../domain/types';
import { CallQueueDriver, CallQueuePayload } from '../queue/callQueue';
import { maskPhoneNumber } from '../security/phone';
import { logger } from '../utils/logger';

export class VoiceCallService {
  /**
   * ============================================================================
   * CLASS DESCRIPTION: VoiceCallService
   * - MEANING: The Phase-2 & Phase-3 outbound voice call execution engine.
   * - WHY WE USE IT: Picks up queued call jobs from Redis/BullMQ, verifies that the order hasn't been cancelled in the meantime, generates the Bangla voice script (`buildOrderVerificationPrompt`), requests `.mp3` synthesis from `TtsAdapter`, and dials the customer's phone via `TelephonyAdapter` (or delegates orchestration to n8n).
   * - WHERE IT IS USED: Instantiated in `src/app.ts` and invoked by the queue worker (`queue.startWorker` in `app.ts` and `worker.ts`) as well as the internal n8n dial endpoint (`POST /api/internal/telephony/dial` in `voiceAndOrderRoutes.ts`).
   * ============================================================================
   */
  constructor(
    private readonly repo: FlowMindRepository,
    private readonly ttsAdapter: TtsAdapter,
    private readonly telephonyAdapter: TelephonyAdapter,
    private readonly queue: CallQueueDriver,
    private readonly env: AppEnv
  ) {}

  async processQueuedCallJob(payload: CallQueuePayload): Promise<VoiceCall | null> {
    /**
     * METHOD DESCRIPTION: processQueuedCallJob
     * - CALLED BY: The background queue worker (`queue.startWorker` callback in `src/app.ts` and `src/worker.ts`) whenever a job in Redis/BullMQ or InlineCallQueue is ready to run.
     * - INPUT SOURCE: `payload` (`{ tenantId, orderId, callJobId, attemptNo }`) comes directly from the dequeued job in `BullMqCallQueue` or `InlineCallQueue`.
     * - PURPOSE: Re-validates the order state right before dialing (to make sure the merchant didn't cancel or ship the order while the job was waiting in the queue), and then either triggers the self-hosted n8n workflow or directly calls `this.executeOutboundCall`.
     */
    const { tenantId, orderId, callJobId } = payload;
    const job = await this.repo.getCallJobById(tenantId, callJobId);
    if (!job || job.status === 'cancelled' || job.status === 'completed') {
      return null;
    }

    const order = await this.repo.getOrderById(tenantId, orderId);
    if (!order) {
      await this.repo.updateCallJob(tenantId, callJobId, {
        status: 'failed',
        lastError: 'order_not_found',
      });
      return null;
    }

    // Developer Note: Stale-order guard (SRS Section 11). If the order was cancelled or fulfilled while waiting
    // in the queue (for example, waiting overnight until 09:00 AM), we abort the call so we don't bother the customer.
    if (isOrderStaleForConfirmation(order.orderStatus)) {
      await this.repo.cancelPendingJobsForOrder(
        tenantId,
        orderId,
        `Order moved to terminal state (${order.orderStatus}) prior to call`
      );
      await this.repo.addOrderEvent({
        id: crypto.randomUUID(),
        tenantId,
        orderId,
        callId: null,
        eventType: 'call_cancelled_order_terminal',
        source: 'voice_worker',
        metadata: { orderStatus: order.orderStatus },
        createdAt: new Date().toISOString(),
      });
      return null;
    }

    if (this.env.ORCHESTRATION_MODE === 'n8n' && this.env.NODE_ENV !== 'test') {
      await this.triggerN8nWorkflow(payload);
      return null;
    }

    return this.executeOutboundCall({ tenantId, orderId, callJobId });
  }

  private async triggerN8nWorkflow(payload: CallQueuePayload): Promise<void> {
    /**
     * METHOD DESCRIPTION: triggerN8nWorkflow
     * - CALLED BY: `this.processQueuedCallJob` when `ORCHESTRATION_MODE=n8n`.
     * - INPUT SOURCE: `payload` (`CallQueuePayload`) from the queue worker; `N8N_WEBHOOK_URL` and `INTERNAL_SERVICE_TOKEN` from `this.env`.
     * - PURPOSE: Sends an authenticated HTTP POST request to self-hosted n8n so n8n orchestrates the TTS generation and calls back `/api/internal/telephony/dial`.
     */
    await this.repo.updateCallJob(payload.tenantId, payload.callJobId, { status: 'in_progress' });
    const res = await fetch(this.env.N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': this.env.INTERNAL_SERVICE_TOKEN,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`n8n workflow trigger failed (${res.status}): ${body}`);
    }
    await this.repo.addOrderEvent({
      id: crypto.randomUUID(),
      tenantId: payload.tenantId,
      orderId: payload.orderId,
      callId: null,
      eventType: 'n8n_workflow_triggered',
      source: 'voice_worker',
      metadata: { callJobId: payload.callJobId },
      createdAt: new Date().toISOString(),
    });
  }

  async executeOutboundCall(params: {
    tenantId: string;
    orderId: string;
    callJobId: string;
    preGeneratedAudioUrl?: string;
  }): Promise<VoiceCall> {
    /**
     * METHOD DESCRIPTION: executeOutboundCall
     * - CALLED BY: `this.processQueuedCallJob` (in direct worker mode) OR `voiceAndOrderRoutes.ts` (`POST /api/internal/telephony/dial` when triggered by n8n).
     * - INPUT SOURCE: `tenantId`, `orderId`, `callJobId`, and optional `preGeneratedAudioUrl` (if n8n already called the TTS microservice).
     * - PURPOSE:
     *   1. Builds the Bangla order script (`buildOrderVerificationPrompt(order)`).
     *   2. Calls `this.ttsAdapter.synthesize(...)` to get the cached Bangla `.mp3` URL.
     *   3. Creates a `voice_calls` record in the database.
     *   4. Calls `this.telephonyAdapter.initiateCall(...)` (Asterisk ARI or Simulator) to ring the customer's phone.
     */
    const { tenantId, orderId, callJobId } = params;
    const order = await this.repo.getOrderById(tenantId, orderId);
    const settings = await this.repo.getVoiceSettings(tenantId);
    const job = await this.repo.getCallJobById(tenantId, callJobId);

    if (!order || !settings || !job) {
      throw new Error('Cannot execute call: order, settings, or job missing');
    }

    await this.repo.updateCallJob(tenantId, callJobId, { status: 'in_progress' });
    await this.repo.updateOrderState(tenantId, orderId, { verificationStatus: 'calling' });

    // Step 1: Build the Bangla script from the order items and total amount (SRS Appendix A)
    const prompt = buildOrderVerificationPrompt(order);
    const now = new Date().toISOString();

    // Step 2: Synthesize Bangla speech audio (or reuse SHA-256 cached audio file)
    let audioUrl = params.preGeneratedAudioUrl || null;
    if (!audioUrl) {
      try {
        const ttsResult = await this.ttsAdapter.synthesize({
          text: prompt.fullScript,
          voice: settings.voiceName,
          language: settings.language,
          format: 'mp3',
        });
        audioUrl = ttsResult.audioUrl;
        await this.repo.addOrderEvent({
          id: crypto.randomUUID(),
          tenantId,
          orderId,
          callId: null,
          eventType: 'tts_audio_ready',
          source: `tts_${ttsResult.provider}`,
          metadata: { cached: ttsResult.cached, cacheKey: ttsResult.cacheKey },
          createdAt: new Date().toISOString(),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ tenantId, orderId, err: msg }, 'TTS service unavailable; recording error');
        await this.repo.addOrderEvent({
          id: crypto.randomUUID(),
          tenantId,
          orderId,
          callId: null,
          eventType: 'tts_generation_error',
          source: 'tts_adapter',
          metadata: { error: msg, fallbackMode: this.env.TELEPHONY_PROVIDER === 'simulator' },
          createdAt: new Date().toISOString(),
        });
        // Developer Note: In production (`asterisk_ari`), we cannot place a silent phone call if TTS failed,
        // so we move the job to the Dead-Letter Queue (DLQ). In local `simulator` mode, we allow the UI test bench to continue.
        if (this.env.TELEPHONY_PROVIDER !== 'simulator') {
          await this.repo.updateCallJob(tenantId, callJobId, { status: 'failed', lastError: msg });
          await this.queue.enqueueDeadLetter(
            { tenantId, orderId, callJobId, attemptNo: job.attemptNo },
            `TTS error: ${msg}`
          );
          throw err;
        }
      }
    }

    // Step 3: Create the `voice_calls` attempt record in DB before dialing
    const callId = crypto.randomUUID();
    const voiceCall = await this.repo.createVoiceCall({
      id: callId,
      tenantId,
      callJobId,
      orderId,
      providerCallId: null,
      startedAt: now,
      endedAt: null,
      durationSec: 0,
      callStatus: 'initiated',
      dtmfResult: 'none',
      replayCount: 0,
      invalidAttempts: 0,
      promptText: prompt.fullScript,
      audioUrl,
      errorCode: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    });

    // Step 4: Originate the outbound call via TelephonyAdapter (Asterisk ARI or Simulator)
    try {
      const callbackUrl = `${this.env.PUBLIC_CALLBACK_BASE_URL.replace(/\/$/, '')}/api/webhooks/telephony/events`;
      const callResult = await this.telephonyAdapter.initiateCall({
        callId: voiceCall.id,
        tenantId,
        orderId,
        toPhoneE164: order.phoneE164,
        promptText: prompt.fullScript,
        audioUrl: audioUrl ?? '',
        callbackUrl,
        menuReplayLimit: settings.menuReplayLimit,
        invalidKeyLimit: settings.invalidKeyLimit,
      });

      const updatedCall = (await this.repo.updateVoiceCall(tenantId, voiceCall.id, {
        providerCallId: callResult.providerCallId,
        callStatus: callResult.status,
      }))!;

      await this.repo.addOrderEvent({
        id: crypto.randomUUID(),
        tenantId,
        orderId,
        callId: updatedCall.id,
        eventType: 'outbound_call_initiated',
        source: `telephony_${callResult.provider}`,
        metadata: {
          providerCallId: callResult.providerCallId,
          attemptNo: job.attemptNo,
          maskedPhone: maskPhoneNumber(order.phoneE164),
        },
        createdAt: new Date().toISOString(),
      });

      return updatedCall;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.repo.updateVoiceCall(tenantId, voiceCall.id, {
        callStatus: 'failed',
        endedAt: new Date().toISOString(),
        errorCode: 'TELEPHONY_ORIGINATE_FAILED',
        errorMessage: msg,
      });
      await this.repo.updateCallJob(tenantId, callJobId, { status: 'failed', lastError: msg });
      await this.repo.addOrderEvent({
        id: crypto.randomUUID(),
        tenantId,
        orderId,
        callId: voiceCall.id,
        eventType: 'telephony_originate_failed',
        source: 'telephony_adapter',
        metadata: { error: msg },
        createdAt: new Date().toISOString(),
      });
      throw err;
    }
  }
}
