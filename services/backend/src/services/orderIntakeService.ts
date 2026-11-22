import crypto from 'crypto';
import { StoreAdapter } from '../adapters/interfaces';
import { AppEnv } from '../config/env';
import { FlowMindRepository } from '../db/repository';
import { evaluateOrderEligibility } from '../domain/eligibility';
import { CallJob, Order, StoreProvider } from '../domain/types';
import { CallQueueDriver } from '../queue/callQueue';
import { decryptSecret } from '../security/crypto';
import { maskPhoneNumber, normalizePhoneE164 } from '../security/phone';
import { logger } from '../utils/logger';

export interface WebhookIntakeResult {
  httpStatus: number;
  accepted: boolean;
  duplicate?: boolean;
  eligible?: boolean;
  reason?: string;
  order?: Order;
  callJob?: CallJob;
}

export class OrderIntakeService {
  /**
   * ============================================================================
   * CLASS DESCRIPTION: OrderIntakeService
   * - MEANING: The authoritative Phase-1 entry brain for incoming e-commerce orders.
   * - WHY WE USE IT: Coordinates every step required when a new order arrives: looking up the tenant, decrypting the tenant's webhook secret, asking `storeAdapters.ts` to verify the signature and normalize the JSON, deduplicating repeated webhooks, checking calling eligibility (opt-out list, calling hours 09:00-21:00), saving to MySQL, and pushing a call job to Redis/BullMQ.
   * - WHERE IT IS USED: Instantiated once in `src/app.ts` and called by `webhookRoutes.ts` (`POST /api/webhooks/orders/:provider`), `voiceAndOrderRoutes.ts` (manual retry), and `dashboardAndSimulatorRoutes.ts` (Simulator Test Bench).
   * ============================================================================
   */
  constructor(
    private readonly repo: FlowMindRepository,
    private readonly storeAdapters: Record<StoreProvider, StoreAdapter>,
    private readonly queue: CallQueueDriver,
    private readonly env: AppEnv
  ) {}

  private async resolveWebhookSecret(tenantId: string, provider: StoreProvider): Promise<string> {
    /**
     * METHOD DESCRIPTION: resolveWebhookSecret
     * - CALLED BY: `this.handleOrderWebhook` (internal helper method inside `OrderIntakeService`).
     * - INPUT SOURCE: `tenantId` comes from the resolved `Tenant` database object; `provider` (`'shopify' | 'woocommerce' | 'custom'`) comes from the webhook URL parameter.
     * - PURPOSE: Fetches the tenant's AES-256-GCM encrypted webhook secret from `provider_credentials` in the database and decrypts it. If the tenant hasn't configured a custom secret yet, falls back to the default secret in `.env`.
     */
    const cred = await this.repo.getProviderCredential(tenantId, provider);
    if (cred && cred.status === 'active') {
      try {
        return decryptSecret(
          { encryptedSecret: cred.encryptedSecret, iv: cred.iv, authTag: cred.authTag },
          this.env.ENCRYPTION_KEY_HEX
        );
      } catch (err) {
        logger.error({ tenantId, provider, err }, 'Failed to decrypt tenant webhook secret');
      }
    }
    if (provider === 'shopify') return this.env.DEFAULT_SHOPIFY_WEBHOOK_SECRET;
    if (provider === 'woocommerce') return this.env.DEFAULT_WOOCOMMERCE_WEBHOOK_SECRET;
    return this.env.DEFAULT_CUSTOM_WEBHOOK_SECRET;
  }

  async handleOrderWebhook(params: {
    provider: StoreProvider;
    tenantSlugOrId: string;
    rawBody: Buffer;
    body: Record<string, unknown>;
    headers: Record<string, string | string[] | undefined>;
    bypassCallingWindow?: boolean;
  }): Promise<WebhookIntakeResult> {
    /**
     * METHOD DESCRIPTION: handleOrderWebhook
     * - CALLED BY: `webhookRoutes.ts` (`POST /api/webhooks/orders/:provider`) and `dashboardAndSimulatorRoutes.ts` (`POST /api/simulator/order-webhook`).
     * - INPUT SOURCE: `params.provider` comes from `req.params.provider`, `params.tenantSlugOrId` comes from the `X-Tenant-Id` header or `?tenant=` query string, `params.rawBody` is the raw HTTP Buffer captured in `app.ts`, and `params.body` / `params.headers` come from the Express `req` object.
     * - PURPOSE: Executes the complete 7-step intake pipeline:
     *   1. Pick the right `StoreAdapter` (`shopify`, `woocommerce`, or `custom`).
     *   2. Verify the tenant exists.
     *   3. Verify the HMAC-SHA256 webhook signature.
     *   4. Normalize the store payload into a clean `NormalizedStoreOrder`.
     *   5. Normalize the Bangladeshi phone number to E.164 (`+8801...`) and save the order idempotently.
     *   6. Evaluate eligibility (voice enabled, consent, opt-out check, calling window 09:00-21:00).
     *   7. Create and enqueue the outbound call job in Redis/BullMQ.
     */

    // Step 1: Select the store adapter for Shopify, WooCommerce, or Custom store
    const adapter = this.storeAdapters[params.provider];
    if (!adapter) {
      return { httpStatus: 400, accepted: false, reason: 'unsupported_store_provider' };
    }

    // Step 2: Find the merchant tenant by ID or slug (e.g. "desh-fashion")
    const tenant =
      (await this.repo.getTenantById(params.tenantSlugOrId)) ||
      (await this.repo.getTenantBySlug(params.tenantSlugOrId));
    if (!tenant) {
      return { httpStatus: 404, accepted: false, reason: 'tenant_not_found' };
    }

    // Step 3: Decrypt tenant webhook secret and verify HMAC signature using storeAdapters.ts
    const secret = await this.resolveWebhookSecret(tenant.id, params.provider);
    const sigValid = adapter.verifyWebhookSignature(params.rawBody, params.headers, secret);
    if (!sigValid) {
      logger.warn(
        { tenantId: tenant.id, provider: params.provider },
        'Rejected order webhook due to invalid HMAC signature'
      );
      return { httpStatus: 401, accepted: false, reason: 'invalid_webhook_signature' };
    }

    // Step 4: Translate store-specific JSON into FlowMind's standard NormalizedStoreOrder format
    const normalized = adapter.normalizeOrderPayload(params.body);
    if (!normalized.externalOrderId) {
      return { httpStatus: 400, accepted: false, reason: 'missing_external_order_id' };
    }

    // Step 5: Normalize BD phone number (e.g. "01712345678" -> "+8801712345678") and save to DB
    const phoneE164 = normalizePhoneE164(normalized.phoneRaw);
    const { order, duplicate } = await this.repo.createOrder({
      id: crypto.randomUUID(),
      tenantId: tenant.id,
      externalOrderId: normalized.externalOrderId,
      storeProvider: params.provider,
      phoneE164: phoneE164 ?? '',
      customerName: normalized.customerName,
      totalAmount: normalized.totalAmount,
      currency: normalized.currency,
      orderStatus: normalized.orderStatus,
      verificationStatus: phoneE164 ? 'pending' : 'ineligible',
      consentGranted: normalized.consentGranted,
      items: normalized.items.map((item) => ({
        id: crypto.randomUUID(),
        ...item,
      })),
    });

    // Developer Note: Idempotency check! E-commerce stores often send the same webhook 2-3 times if network is slow.
    // If `(tenantId, externalOrderId)` already exists in DB, `duplicate` is true and we return 200 without calling twice.
    if (duplicate) {
      logger.info(
        { tenantId: tenant.id, orderId: order.id, externalOrderId: order.externalOrderId },
        'Deduplicated repeated order-created webhook'
      );
      return {
        httpStatus: 200,
        accepted: true,
        duplicate: true,
        eligible: false,
        reason: 'duplicate_order_webhook',
        order,
      };
    }

    // Record audit event in order_events table (phone number is masked for privacy)
    await this.repo.addOrderEvent({
      id: crypto.randomUUID(),
      tenantId: tenant.id,
      orderId: order.id,
      callId: null,
      eventType: 'order_webhook_received',
      source: `store_${params.provider}`,
      metadata: {
        externalOrderId: order.externalOrderId,
        maskedPhone: phoneE164 ? maskPhoneNumber(phoneE164) : null,
        totalAmount: order.totalAmount,
        currency: order.currency,
      },
      createdAt: new Date().toISOString(),
    });

    const settings = await this.repo.getVoiceSettings(tenant.id);
    if (!settings) {
      await this.repo.updateOrderState(tenant.id, order.id, { verificationStatus: 'ineligible' });
      return { httpStatus: 202, accepted: true, eligible: false, reason: 'missing_voice_settings', order };
    }

    // Step 6: Check if customer phone is on the Opt-Out (Do-Not-Call) list or already has an active call job
    const isOptedOut = phoneE164 ? await this.repo.isPhoneOptedOut(tenant.id, phoneE164) : false;
    const hasActiveJob = await this.repo.hasActiveCallJob(tenant.id, order.id);

    const eligibility = evaluateOrderEligibility({
      tenant,
      settings,
      order,
      isOptedOut,
      hasActiveCallJob: hasActiveJob,
      bypassCallingWindow: params.bypassCallingWindow,
    });

    if (!eligibility.eligible) {
      const status = eligibility.suppressedOptOut ? 'suppressed_opt_out' : 'ineligible';
      const updated = (await this.repo.updateOrderState(tenant.id, order.id, {
        verificationStatus: status,
      }))!;
      await this.repo.addOrderEvent({
        id: crypto.randomUUID(),
        tenantId: tenant.id,
        orderId: order.id,
        callId: null,
        eventType: eligibility.suppressedOptOut ? 'call_suppressed_opt_out' : 'order_marked_ineligible',
        source: 'eligibility_engine',
        metadata: { reason: eligibility.reason },
        createdAt: new Date().toISOString(),
      });
      return {
        httpStatus: 202,
        accepted: true,
        eligible: false,
        reason: eligibility.reason,
        order: updated,
      };
    }

    // Step 7: If order arrived outside calling hours (e.g. 2:00 AM), `deferUntilUtc` delays the job until 09:00 AM.
    const scheduledAt = eligibility.deferUntilUtc ?? new Date().toISOString();
    const delayMs = eligibility.deferUntilUtc
      ? Math.max(0, new Date(eligibility.deferUntilUtc).getTime() - Date.now())
      : 0;

    const jobResult = await this.createAndEnqueueJob({
      tenantId: tenant.id,
      orderId: order.id,
      cycleTag: 'cycle-1',
      maxAttempts: settings.retryLimit + 1,
      scheduledAt,
      delayMs,
    });

    const updatedOrder = (await this.repo.updateOrderState(tenant.id, order.id, {
      verificationStatus: 'queued',
    }))!;

    return {
      httpStatus: 202,
      accepted: true,
      duplicate: jobResult.duplicate,
      eligible: true,
      reason: eligibility.reason,
      order: updatedOrder,
      callJob: jobResult.job,
    };
  }

  async createAndEnqueueJob(params: {
    tenantId: string;
    orderId: string;
    cycleTag: string;
    maxAttempts: number;
    scheduledAt?: string;
    delayMs?: number;
    attemptNo?: number;
  }): Promise<{ job: CallJob; duplicate: boolean }> {
    /**
     * METHOD DESCRIPTION: createAndEnqueueJob
     * - CALLED BY: `this.handleOrderWebhook` (automatic intake) and `voiceAndOrderRoutes.ts` (`POST /api/voice/jobs` and `POST /api/voice/orders/:id/retry`).
     * - INPUT SOURCE: `tenantId`, `orderId`, `cycleTag` (used to build the unique `idempotencyKey`), `maxAttempts` (from tenant voice settings), and optional `delayMs` (if deferred to next calling window).
     * - PURPOSE: Creates a durable `call_jobs` record in MySQL and pushes the job payload into `this.queue` (Redis BullMQ or InlineQueue) so the background worker will dial the customer.
     */
    const now = new Date().toISOString();
    const scheduledAt = params.scheduledAt ?? now;
    // Developer Note: `idempotencyKey` prevents two identical call jobs from being created for the same order cycle.
    const idempotencyKey = `${params.tenantId}:${params.orderId}:${params.cycleTag}`;
    const job: CallJob = {
      id: crypto.randomUUID(),
      tenantId: params.tenantId,
      orderId: params.orderId,
      status: (params.delayMs ?? 0) > 0 ? 'scheduled' : 'queued',
      scheduledAt,
      attemptNo: params.attemptNo ?? 1,
      maxAttempts: params.maxAttempts,
      idempotencyKey,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };

    const created = await this.repo.createCallJob(job);
    if (!created.duplicate) {
      await this.repo.addOrderEvent({
        id: crypto.randomUUID(),
        tenantId: params.tenantId,
        orderId: params.orderId,
        callId: null,
        eventType: 'call_job_enqueued',
        source: 'queue_manager',
        metadata: {
          callJobId: created.job.id,
          attemptNo: created.job.attemptNo,
          scheduledAt,
          delayMs: params.delayMs ?? 0,
        },
        createdAt: now,
      });

      await this.queue.enqueueCallJob(
        {
          tenantId: params.tenantId,
          orderId: params.orderId,
          callJobId: created.job.id,
          attemptNo: created.job.attemptNo,
        },
        params.delayMs ?? 0
      );
    }
    return created;
  }
}
