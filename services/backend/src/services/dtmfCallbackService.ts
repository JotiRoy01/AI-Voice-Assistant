import crypto from 'crypto';
import { StoreAdapter, WhatsAppAdapter } from '../adapters/interfaces';
import { AppEnv } from '../config/env';
import { FlowMindRepository } from '../db/repository';
import { evaluateDtmfTransition } from '../domain/dtmfMachine';
import { isWithinCallingWindow } from '../domain/eligibility';
import { StoreProvider } from '../domain/types';
import { CallQueueDriver } from '../queue/callQueue';
import { logger } from '../utils/logger';

export interface TelephonyEventPayload {
  providerEventId: string;
  provider?: string;
  providerCallId?: string;
  callId?: string;
  eventType: 'ringing' | 'answered' | 'dtmf' | 'no_answer' | 'busy' | 'failed' | 'completed';
  digit?: string;
  durationSec?: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface TelephonyCallbackResult {
  httpStatus: number;
  duplicate?: boolean;
  action?: string;
  endCall?: boolean;
  spokenPrompt?: string;
  whatsappDeepLink?: string;
  retryScheduledAt?: string;
  error?: string;
}

export class DtmfCallbackService {
  /**
   * ============================================================================
   * CLASS DESCRIPTION: DtmfCallbackService
   * - MEANING: The Phase-4 & Phase-5 call event and DTMF keypad (`1`, `2`, `3`) handler service.
   * - WHY WE USE IT: When Asterisk (or the Simulator UI) reports what happened on the phone call (`ringing`, `answered`, `no_answer`, `busy`, or keypad press `dtmf` with digit `1`, `2`, `3`), this class processes the event idempotently, updates the store via `StoreAdapter`, triggers WhatsApp via `WhatsAppAdapter`, or schedules automatic call retries.
   * - WHERE IT IS USED: Instantiated in `src/app.ts` and called by `webhookRoutes.ts` (`POST /api/webhooks/telephony/events`) and `dashboardAndSimulatorRoutes.ts` (`POST /api/simulator/telephony-event` and `POST /api/dashboard/errors/:orderId/retry-sync`).
   * ============================================================================
   */
  constructor(
    private readonly repo: FlowMindRepository,
    private readonly storeAdapters: Record<StoreProvider, StoreAdapter>,
    private readonly whatsappAdapter: WhatsAppAdapter,
    private readonly queue: CallQueueDriver,
    private readonly env: AppEnv
  ) {}

  async handleTelephonyEvent(payload: TelephonyEventPayload): Promise<TelephonyCallbackResult> {
    /**
     * METHOD DESCRIPTION: handleTelephonyEvent
     * - CALLED BY: `webhookRoutes.ts` (`POST /api/webhooks/telephony/events`) and `dashboardAndSimulatorRoutes.ts` (`POST /api/simulator/telephony-event`).
     * - INPUT SOURCE: `payload` (`TelephonyEventPayload`) comes from the signed JSON callback sent by Asterisk AGI (`asterisk/agi/flowmind-callback.sh`) or the Dashboard Simulator keypad.
     * - PURPOSE:
     *   1. Finds the active `VoiceCall` record by `providerCallId`.
     *   2. Deduplicates repeated callbacks using `providerEventId`.
     *   3. Routes lifecycle events (`ringing`, `answered`, `no_answer`, `busy`, `failed`, `completed`).
     *   4. Evaluates keypad digits (`1`, `2`, `3`, timeout, invalid key) via `evaluateDtmfTransition` and executes the resulting store confirmation, cancellation, or WhatsApp link dispatch.
     */

    // Step 1: Look up the active VoiceCall record by the provider's call ID
    const call = payload.providerCallId
      ? await this.repo.getVoiceCallByProviderId(payload.providerCallId)
      : null;

    if (!call) {
      return { httpStatus: 404, error: 'voice_call_not_found' };
    }

    // Step 2: Callback Idempotency — ensure we never process the same telephony event twice
    const provider = payload.provider || 'telephony';
    const isNew = await this.repo.recordCallbackIfNew(call.tenantId, provider, payload.providerEventId);
    if (!isNew) {
      logger.info(
        { tenantId: call.tenantId, callId: call.id, providerEventId: payload.providerEventId },
        'Deduplicated duplicate telephony provider callback'
      );
      return { httpStatus: 200, duplicate: true, action: 'deduplicated' };
    }

    const now = new Date().toISOString();

    // Step 3A: Call is ringing or customer picked up the phone
    if (payload.eventType === 'ringing' || payload.eventType === 'answered') {
      await this.repo.updateVoiceCall(call.tenantId, call.id, {
        callStatus: payload.eventType,
        startedAt: call.startedAt ?? now,
      });
      await this.repo.addOrderEvent({
        id: crypto.randomUUID(),
        tenantId: call.tenantId,
        orderId: call.orderId,
        callId: call.id,
        eventType: `call_${payload.eventType}`,
        source: 'telephony_webhook',
        metadata: { providerEventId: payload.providerEventId },
        createdAt: now,
      });
      return { httpStatus: 200, action: payload.eventType, endCall: false };
    }

    // Step 3B: Customer didn't answer, line was busy, or network call failed -> check retry policy
    if (
      payload.eventType === 'no_answer' ||
      payload.eventType === 'busy' ||
      payload.eventType === 'failed'
    ) {
      return this.handleUnansweredOrFailed(call.tenantId, call.id, call.callJobId, call.orderId, {
        ...payload,
        eventType: payload.eventType,
      });
    }

    // Step 3C: Call hung up normally
    if (payload.eventType === 'completed') {
      await this.repo.updateVoiceCall(call.tenantId, call.id, {
        callStatus: 'completed',
        endedAt: now,
        durationSec: payload.durationSec ?? call.durationSec,
      });
      await this.repo.updateCallJob(call.tenantId, call.callJobId, { status: 'completed' });
      return { httpStatus: 200, action: 'completed', endCall: true };
    }

    // Step 4: Handle DTMF keypad input ('1', '2', '3', 'no_input', or invalid key like '9')
    const order = await this.repo.getOrderById(call.tenantId, call.orderId);
    const settings = await this.repo.getVoiceSettings(call.tenantId);
    if (!order || !settings) {
      return { httpStatus: 404, error: 'order_or_settings_not_found' };
    }

    // Ask the pure DTMF state machine (`src/domain/dtmfMachine.ts`) what action to take
    const decision = evaluateDtmfTransition({
      digit: payload.digit ?? 'no_input',
      order,
      call,
      settings,
    });

    await this.repo.updateVoiceCall(call.tenantId, call.id, {
      dtmfResult: decision.dtmfResult,
      replayCount: decision.nextReplayCount,
      invalidAttempts: decision.nextInvalidAttempts,
      callStatus: decision.endCall ? 'completed' : 'answered',
      endedAt: decision.endCall ? now : null,
      durationSec: payload.durationSec ?? Math.max(call.durationSec, decision.endCall ? 25 : 10),
    });

    await this.repo.addOrderEvent({
      id: crypto.randomUUID(),
      tenantId: call.tenantId,
      orderId: order.id,
      callId: call.id,
      eventType: decision.eventType,
      source: 'telephony_webhook',
      metadata: {
        digit: payload.digit ?? 'no_input',
        action: decision.action,
        reason: decision.reason,
        replayCount: decision.nextReplayCount,
        invalidAttempts: decision.nextInvalidAttempts,
      },
      createdAt: now,
    });

    // If the customer pressed a wrong key or timed out (within replay limits), tell Asterisk to replay the menu
    if (decision.action === 'replay_menu') {
      return {
        httpStatus: 200,
        action: 'replay_menu',
        endCall: false,
        spokenPrompt: decision.spokenPrompt,
      };
    }

    // Complete job for terminal DTMF outcomes
    await this.repo.updateCallJob(call.tenantId, call.callJobId, { status: 'completed' });

    if (decision.action === 'reject_stale_order') {
      return {
        httpStatus: 200,
        action: decision.action,
        endCall: true,
        spokenPrompt: decision.spokenPrompt,
      };
    }

    let whatsappDeepLink: string | undefined;

    // Outcome A: Customer pressed '1' -> Confirm Order and sync with Shopify/WooCommerce/Custom Store
    if (decision.action === 'confirm_order') {
      const storeAdapter = this.storeAdapters[order.storeProvider];
      const cred = await this.repo.getProviderCredential(order.tenantId, order.storeProvider);
      const sync = await storeAdapter.confirmOrder(order, cred?.config);
      if (sync.success) {
        await this.repo.updateOrderState(order.tenantId, order.id, {
          orderStatus: 'confirmed',
          verificationStatus: 'confirmed',
          storeSyncStatus: 'synced',
          storeSyncError: null,
        });
      } else {
        // Developer Note (SRS Section 12): If the customer pressed 1, their confirmation is saved,
        // but if the store's API timed out, we mark `storeSyncStatus: 'pending_sync'` so an admin can retry from the dashboard.
        await this.repo.updateOrderState(order.tenantId, order.id, {
          verificationStatus: 'confirmed',
          storeSyncStatus: 'pending_sync',
          storeSyncError: sync.error || 'Store confirmation sync failed',
        });
        await this.repo.addOrderEvent({
          id: crypto.randomUUID(),
          tenantId: order.tenantId,
          orderId: order.id,
          callId: call.id,
          eventType: 'store_sync_pending_sync',
          source: `store_${order.storeProvider}`,
          metadata: { action: 'confirm', error: sync.error },
          createdAt: new Date().toISOString(),
        });
      }
    } else if (decision.action === 'cancel_order_permitted') {
      // Outcome B1: Customer pressed '2' and order is still pending/unshipped -> Cancel in store
      const storeAdapter = this.storeAdapters[order.storeProvider];
      const cred = await this.repo.getProviderCredential(order.tenantId, order.storeProvider);
      const sync = await storeAdapter.cancelOrder(order, 'Customer pressed 2 during IVR confirmation', cred?.config);
      if (sync.success) {
        await this.repo.updateOrderState(order.tenantId, order.id, {
          orderStatus: 'cancelled',
          verificationStatus: 'cancelled',
          storeSyncStatus: 'synced',
          storeSyncError: null,
        });
      } else {
        await this.repo.updateOrderState(order.tenantId, order.id, {
          verificationStatus: 'cancellation_requested',
          storeSyncStatus: 'pending_sync',
          storeSyncError: sync.error || 'Store cancellation sync failed',
        });
        await this.repo.addOrderEvent({
          id: crypto.randomUUID(),
          tenantId: order.tenantId,
          orderId: order.id,
          callId: call.id,
          eventType: 'store_sync_pending_sync',
          source: `store_${order.storeProvider}`,
          metadata: { action: 'cancel', error: sync.error },
          createdAt: new Date().toISOString(),
        });
      }
    } else if (decision.action === 'cancel_request_only') {
      // Outcome B2: Customer pressed '2' but order is already packed/shipped -> Record request for human agent
      await this.repo.updateOrderState(order.tenantId, order.id, {
        verificationStatus: 'cancellation_requested',
        storeSyncStatus: 'not_required',
      });
    } else if (decision.action === 'trigger_whatsapp') {
      // Outcome C: Customer pressed '3' -> Send WhatsApp instruction link via WhatsAppAdapter
      await this.repo.updateOrderState(order.tenantId, order.id, {
        verificationStatus: 'whatsapp_requested',
      });
      const waResult = await this.whatsappAdapter.sendOrderInstructionLink({
        tenantId: order.tenantId,
        orderId: order.id,
        externalOrderId: order.externalOrderId,
        toPhoneE164: order.phoneE164,
        customerName: order.customerName,
        businessWhatsAppNumber: settings.whatsappFallbackContact || this.env.WHATSAPP_BUSINESS_NUMBER,
      });
      whatsappDeepLink = waResult.deepLinkUrl;
      await this.repo.addOrderEvent({
        id: crypto.randomUUID(),
        tenantId: order.tenantId,
        orderId: order.id,
        callId: call.id,
        eventType: waResult.success ? 'whatsapp_link_dispatched' : 'whatsapp_delivery_failed',
        source: `whatsapp_${this.whatsappAdapter.name}`,
        metadata: {
          deepLinkUrl: waResult.deepLinkUrl,
          providerMessageId: waResult.providerMessageId,
          error: waResult.error,
          fallbackContact: settings.whatsappFallbackContact,
        },
        createdAt: new Date().toISOString(),
      });
    } else if (decision.nextVerificationStatus) {
      await this.repo.updateOrderState(order.tenantId, order.id, {
        verificationStatus: decision.nextVerificationStatus,
      });
    }

    return {
      httpStatus: 200,
      action: decision.action,
      endCall: decision.endCall,
      spokenPrompt: decision.spokenPrompt,
      whatsappDeepLink,
    };
  }

  private async handleUnansweredOrFailed(
    tenantId: string,
    callId: string,
    callJobId: string,
    orderId: string,
    payload: TelephonyEventPayload & { eventType: 'no_answer' | 'busy' | 'failed' }
  ): Promise<TelephonyCallbackResult> {
    /**
     * METHOD DESCRIPTION: handleUnansweredOrFailed
     * - CALLED BY: `this.handleTelephonyEvent` when `eventType` is `'no_answer'`, `'busy'`, or `'failed'`.
     * - INPUT SOURCE: `tenantId`, `callId`, `callJobId`, `orderId` from the active `VoiceCall` record, and `payload` from the telephony callback.
     * - PURPOSE: Checks if the call job has remaining retry attempts (`job.attemptNo < job.maxAttempts`). If yes, schedules the next attempt after `settings.retryIntervalMinutes` (respecting the tenant's 09:00-21:00 calling window). If retries are exhausted, marks the job as `failed` or moves it to the Dead-Letter Queue (`dead_letter`).
     */
    const now = new Date();
    await this.repo.updateVoiceCall(tenantId, callId, {
      callStatus: payload.eventType,
      endedAt: now.toISOString(),
      durationSec: payload.durationSec ?? 0,
      errorCode: payload.errorCode ?? null,
      errorMessage: payload.errorMessage ?? null,
    });

    const job = await this.repo.getCallJobById(tenantId, callJobId);
    const settings = await this.repo.getVoiceSettings(tenantId);
    const tenant = await this.repo.getTenantById(tenantId);

    if (!job || !settings || !tenant) {
      return { httpStatus: 200, action: payload.eventType, endCall: true };
    }

    const canRetry = job.attemptNo < job.maxAttempts;
    if (canRetry) {
      const nextAttempt = job.attemptNo + 1;
      const delayMinutes = Math.max(1, settings.retryIntervalMinutes);
      const proposedDate = new Date(now.getTime() + delayMinutes * 60_000);
      // Developer Note: Ensure the retry doesn't ring the customer at night! If `proposedDate` falls after 21:00,
      // `isWithinCallingWindow` returns `nextWindowUtc` (09:00 AM the next morning).
      const windowCheck = isWithinCallingWindow(
        proposedDate,
        tenant.timezone,
        settings.callWindowStart,
        settings.callWindowEnd
      );
      const scheduledUtc = windowCheck.within ? proposedDate.toISOString() : windowCheck.nextWindowUtc!;
      const delayMs = Math.max(1000, new Date(scheduledUtc).getTime() - now.getTime());

      await this.repo.updateCallJob(tenantId, callJobId, {
        status: 'retry_scheduled',
        attemptNo: nextAttempt,
        scheduledAt: scheduledUtc,
        lastError: payload.errorMessage || payload.eventType,
      });
      await this.repo.updateOrderState(tenantId, orderId, { verificationStatus: 'no_answer' });

      await this.queue.enqueueCallJob(
        { tenantId, orderId, callJobId, attemptNo: nextAttempt },
        delayMs
      );

      await this.repo.addOrderEvent({
        id: crypto.randomUUID(),
        tenantId,
        orderId,
        callId,
        eventType: 'call_retry_scheduled',
        source: 'retry_policy',
        metadata: {
          reason: payload.eventType,
          nextAttempt,
          maxAttempts: job.maxAttempts,
          scheduledAt: scheduledUtc,
        },
        createdAt: now.toISOString(),
      });

      return {
        httpStatus: 200,
        action: 'retry_scheduled',
        endCall: true,
        retryScheduledAt: scheduledUtc,
      };
    }

    // Retry limit exhausted
    const finalJobStatus = payload.eventType === 'failed' ? 'dead_letter' : 'failed';
    await this.repo.updateCallJob(tenantId, callJobId, {
      status: finalJobStatus,
      lastError: payload.errorMessage || `${payload.eventType}: max retries reached`,
    });
    await this.repo.updateOrderState(tenantId, orderId, {
      verificationStatus: payload.eventType === 'failed' ? 'failed' : 'no_answer',
    });
    if (finalJobStatus === 'dead_letter') {
      await this.queue.enqueueDeadLetter(
        { tenantId, orderId, callJobId, attemptNo: job.attemptNo },
        payload.errorMessage || 'Call failed after max attempts'
      );
    }
    await this.repo.addOrderEvent({
      id: crypto.randomUUID(),
      tenantId,
      orderId,
      callId,
      eventType: finalJobStatus === 'dead_letter' ? 'call_job_moved_to_dlq' : 'call_retries_exhausted',
      source: 'retry_policy',
      metadata: { reason: payload.eventType, attempts: job.attemptNo },
      createdAt: now.toISOString(),
    });

    return { httpStatus: 200, action: finalJobStatus, endCall: true };
  }

  async retryStoreSync(tenantId: string, orderId: string): Promise<{ success: boolean; error?: string }> {
    /**
     * METHOD DESCRIPTION: retryStoreSync
     * - CALLED BY: `dashboardAndSimulatorRoutes.ts` (`POST /api/dashboard/errors/:orderId/retry-sync`) when an admin clicks "Retry Store Sync" on the Error Monitor page.
     * - INPUT SOURCE: `tenantId` comes from the authenticated user's JWT (`resolveScopedTenantId`), and `orderId` comes from `req.params.orderId`.
     * - PURPOSE: Re-runs `storeAdapter.confirmOrder` or `storeAdapter.cancelOrder` for an order whose previous store API call failed (`pending_sync`), transitioning it to `synced` upon recovery.
     */
    const order = await this.repo.getOrderById(tenantId, orderId);
    if (!order) return { success: false, error: 'Order not found' };
    const adapter = this.storeAdapters[order.storeProvider];
    const cred = await this.repo.getProviderCredential(tenantId, order.storeProvider);

    const res =
      order.verificationStatus === 'confirmed'
        ? await adapter.confirmOrder(order, cred?.config)
        : await adapter.cancelOrder(order, 'Retry store cancellation sync', cred?.config);

    if (res.success) {
      await this.repo.updateOrderState(tenantId, orderId, {
        orderStatus: order.verificationStatus === 'confirmed' ? 'confirmed' : 'cancelled',
        storeSyncStatus: 'synced',
        storeSyncError: null,
      });
      await this.repo.addOrderEvent({
        id: crypto.randomUUID(),
        tenantId,
        orderId,
        callId: null,
        eventType: 'store_sync_recovered',
        source: 'dashboard_retry',
        metadata: { providerStatus: res.providerStatus },
        createdAt: new Date().toISOString(),
      });
      return { success: true };
    }

    await this.repo.updateOrderState(tenantId, orderId, {
      storeSyncStatus: 'failed',
      storeSyncError: res.error || 'Store sync retry failed',
    });
    return { success: false, error: res.error };
  }
}
