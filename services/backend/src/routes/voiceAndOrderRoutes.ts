import crypto from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import { AppEnv } from '../config/env';
import { FlowMindRepository } from '../db/repository';
import { buildOrderVerificationPrompt } from '../domain/banglaPrompt';
import { evaluateOrderEligibility } from '../domain/eligibility';
import { CallQueueDriver } from '../queue/callQueue';
import { requireAuth, requireInternalService, requireRoles, resolveScopedTenantId } from '../security/auth';
import { maskPhoneNumber } from '../security/phone';
import { OrderIntakeService } from '../services/orderIntakeService';
import { VoiceCallService } from '../services/voiceCallService';

const createJobSchema = z.object({
  tenantId: z.string().min(1),
  orderId: z.string().min(1),
  cycleTag: z.string().default('manual-internal'),
});

const patchSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  language: z.string().min(2).max(16).optional(),
  voiceName: z.string().min(2).max(80).optional(),
  callWindowStart: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  callWindowEnd: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  retryLimit: z.number().int().min(0).max(5).optional(),
  retryIntervalMinutes: z.number().int().min(1).max(240).optional(),
  menuReplayLimit: z.number().int().min(0).max(3).optional(),
  invalidKeyLimit: z.number().int().min(1).max(5).optional(),
  eligibleStatuses: z.array(z.string().min(1)).optional(),
  whatsappFallbackContact: z.string().min(3).max(120).optional(),
  ttsProvider: z.enum(['local_http', 'mock']).optional(),
  telephonyProvider: z.enum(['simulator', 'asterisk_ari', 'twilio']).optional(),
  whatsappProvider: z.enum(['simulator', 'meta_cloud']).optional(),
});

export function createVoiceAndOrderRouters(deps: {
  repo: FlowMindRepository;
  orderIntakeService: OrderIntakeService;
  voiceCallService: VoiceCallService;
  queue: CallQueueDriver;
  env: AppEnv;
}): { voiceRouter: Router; orderRouter: Router; internalRouter: Router } {
  /**
   * ============================================================================
   * ROUTER FACTORY DESCRIPTION: createVoiceAndOrderRouters
   * - MEANING: Builds three Express routers:
   *   1. `voiceRouter` (`/api/voice/*`): Call history, voice settings management, internal job creation, and manual call retries.
   *   2. `orderRouter` (`/api/orders/*`): Tenant-scoped order list and full order voice verification timeline/history.
   *   3. `internalRouter` (`/api/internal/*`): Service-to-service endpoints called exclusively by self-hosted n8n using `X-Internal-Token`.
   * - WHY WE USE IT: Separates tenant-authenticated dashboard APIs (`requireAuth`) from internal n8n orchestration APIs (`requireInternalService`) while enforcing strict tenant isolation (`resolveScopedTenantId`) and phone number masking (`maskPhoneNumber`).
   * - WHERE IT IS USED: Mounted at `/api/voice`, `/api/orders`, and `/api/internal` in `src/app.ts`.
   * ============================================================================
   */
  const { repo, orderIntakeService, voiceCallService, queue, env } = deps;

  // ==========================================================================
  // 1. VOICE ROUTER (/api/voice)
  // ==========================================================================
  const voiceRouter = Router();

  voiceRouter.post('/jobs', requireInternalService(env), async (req, res, next) => {
    /**
     * ENDPOINT DESCRIPTION: POST /api/voice/jobs (SRS Section 9)
     * - CALLED BY: Internal services or n8n (authenticated via `X-Internal-Token` header).
     * - INPUT SOURCE: `req.body` validated by `createJobSchema` (`{ tenantId, orderId, cycleTag }`).
     * - PURPOSE: Creates and enqueues an idempotent outbound call job for an existing order via `orderIntakeService.createAndEnqueueJob`.
     */
    try {
      const parsed = createJobSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid job payload', details: parsed.error.flatten() });
        return;
      }
      const { tenantId, orderId, cycleTag } = parsed.data;
      const order = await repo.getOrderById(tenantId, orderId);
      const settings = await repo.getVoiceSettings(tenantId);
      if (!order || !settings) {
        res.status(404).json({ error: 'Order or tenant voice settings not found' });
        return;
      }
      const created = await orderIntakeService.createAndEnqueueJob({
        tenantId,
        orderId,
        cycleTag,
        maxAttempts: settings.retryLimit + 1,
      });
      res.status(created.duplicate ? 200 : 201).json(created);
    } catch (err) {
      next(err);
    }
  });

  voiceRouter.get('/calls', requireAuth(env), async (req, res, next) => {
    /**
     * ENDPOINT DESCRIPTION: GET /api/voice/calls
     * - CALLED BY: Next.js Admin Dashboard ("Call History" tab).
     * - INPUT SOURCE: Logged-in user's JWT (`req.auth`) and optional `X-Tenant-Id` header resolved by `resolveScopedTenantId(req)`.
     * - PURPOSE: Lists recent voice calls for the active tenant enriched with order details and masked customer phone numbers (`+88017*****678`).
     */
    try {
      const tenantId = resolveScopedTenantId(req);
      if (tenantId === '__FORBIDDEN__') {
        res.status(403).json({ error: 'Cross-tenant access denied' });
        return;
      }
      if (!tenantId) {
        res.status(400).json({ error: 'Tenant context required' });
        return;
      }
      const calls = await repo.listVoiceCalls(tenantId, 100);
      const orders = await repo.listOrders(tenantId, 200);
      const orderMap = new Map(orders.map((o) => [o.id, o]));

      const enriched = calls.map((c) => {
        const order = orderMap.get(c.orderId);
        return {
          ...c,
          externalOrderId: order?.externalOrderId ?? null,
          customerName: order?.customerName ?? null,
          maskedPhone: order?.phoneE164 ? maskPhoneNumber(order.phoneE164) : '***',
          totalAmount: order?.totalAmount ?? null,
          currency: order?.currency ?? 'BDT',
        };
      });
      res.json({ calls: enriched });
    } catch (err) {
      next(err);
    }
  });

  voiceRouter.get('/calls/:id', requireAuth(env), async (req, res, next) => {
    /**
     * ENDPOINT DESCRIPTION: GET /api/voice/calls/:id (SRS Section 9)
     * - CALLED BY: Next.js Admin Dashboard or API clients inspecting a specific call attempt.
     * - INPUT SOURCE: `:id` URL parameter (`callId`) and tenant ID from `resolveScopedTenantId(req)`.
     * - PURPOSE: Returns the single `VoiceCall` record if it belongs to the user's tenant (returns 404/403 if another tenant tries to access it).
     */
    try {
      const tenantId = resolveScopedTenantId(req);
      if (tenantId === '__FORBIDDEN__') {
        res.status(403).json({ error: 'Cross-tenant access denied' });
        return;
      }
      if (!tenantId) {
        res.status(400).json({ error: 'Tenant context required' });
        return;
      }
      const call = await repo.getVoiceCallById(tenantId, String(req.params.id));
      if (!call) {
        res.status(404).json({ error: 'Call not found' });
        return;
      }
      res.json({ call });
    } catch (err) {
      next(err);
    }
  });

  voiceRouter.get('/settings', requireAuth(env), async (req, res, next) => {
    /**
     * ENDPOINT DESCRIPTION: GET /api/voice/settings
     * - CALLED BY: Next.js Admin Dashboard ("Voice Settings" tab).
     * - INPUT SOURCE: Tenant context from `resolveScopedTenantId(req)`.
     * - PURPOSE: Retrieves the tenant's current voice configuration (Bangla voice name, 09:00-21:00 calling window, retry limits, WhatsApp contact number).
     */
    try {
      const tenantId = resolveScopedTenantId(req);
      if (tenantId === '__FORBIDDEN__') {
        res.status(403).json({ error: 'Cross-tenant access denied' });
        return;
      }
      if (!tenantId) {
        res.status(400).json({ error: 'Tenant context required' });
        return;
      }
      const settings = await repo.getVoiceSettings(tenantId);
      const tenant = await repo.getTenantById(tenantId);
      if (!settings) {
        res.status(404).json({ error: 'Settings not found' });
        return;
      }
      res.json({ settings, tenant });
    } catch (err) {
      next(err);
    }
  });

  voiceRouter.patch(
    '/settings',
    requireAuth(env),
    requireRoles('super_admin', 'business_owner'),
    async (req, res, next) => {
      /**
       * ENDPOINT DESCRIPTION: PATCH /api/voice/settings (SRS Section 9, FR-19)
       * - CALLED BY: Next.js Admin Dashboard when a `super_admin` or `business_owner` saves updated voice settings.
       * - INPUT SOURCE: `req.body` validated against `patchSettingsSchema`; tenant context from `resolveScopedTenantId(req)`.
       * - PURPOSE: Updates the tenant's `voice_settings` row in the database (operators and support viewers are blocked by `requireRoles`).
       */
      try {
        const tenantId = resolveScopedTenantId(req);
        if (tenantId === '__FORBIDDEN__') {
          res.status(403).json({ error: 'Cross-tenant access denied' });
          return;
        }
        if (!tenantId) {
          res.status(400).json({ error: 'Tenant context required' });
          return;
        }
        const parsed = patchSettingsSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: 'Invalid settings update', details: parsed.error.flatten() });
          return;
        }
        const current = await repo.getVoiceSettings(tenantId);
        if (!current) {
          res.status(404).json({ error: 'Settings not found' });
          return;
        }
        const updated = await repo.upsertVoiceSettings({
          ...current,
          ...parsed.data,
          tenantId,
          updatedAt: new Date().toISOString(),
        });
        res.json({ settings: updated });
      } catch (err) {
        next(err);
      }
    }
  );

  voiceRouter.post(
    '/orders/:id/retry',
    requireAuth(env),
    requireRoles('super_admin', 'business_owner', 'operator'),
    async (req, res, next) => {
      /**
       * ENDPOINT DESCRIPTION: POST /api/voice/orders/:id/retry (SRS Section 9)
       * - CALLED BY: Next.js Admin Dashboard when an operator clicks "Retry Call" on an unanswered or failed order.
       * - INPUT SOURCE: `:id` URL parameter (`orderId`), tenant ID from `resolveScopedTenantId(req)`, and optional `req.body.bypassCallingWindow`.
       * - PURPOSE: Re-runs `evaluateOrderEligibility` (checking opt-out status, terminal order state, and active call jobs) and, if permitted, enqueues a new call job cycle.
       */
      try {
        const tenantId = resolveScopedTenantId(req);
        if (tenantId === '__FORBIDDEN__') {
          res.status(403).json({ error: 'Cross-tenant access denied' });
          return;
        }
        if (!tenantId) {
          res.status(400).json({ error: 'Tenant context required' });
          return;
        }
        const orderId = String(req.params.id);
        const order = await repo.getOrderById(tenantId, orderId);
        const tenant = await repo.getTenantById(tenantId);
        const settings = await repo.getVoiceSettings(tenantId);
        if (!order || !tenant || !settings) {
          res.status(404).json({ error: 'Order not found' });
          return;
        }

        const isOptedOut = await repo.isPhoneOptedOut(tenantId, order.phoneE164);
        const hasActiveJob = await repo.hasActiveCallJob(tenantId, orderId);
        const check = evaluateOrderEligibility({
          tenant,
          settings,
          order,
          isOptedOut,
          hasActiveCallJob: hasActiveJob,
          bypassCallingWindow: Boolean(req.body?.bypassCallingWindow),
        });

        if (!check.eligible) {
          res.status(409).json({ error: 'Retry not permitted', reason: check.reason });
          return;
        }

        const cycleTag = `manual-retry-${Date.now()}`;
        const created = await orderIntakeService.createAndEnqueueJob({
          tenantId,
          orderId,
          cycleTag,
          maxAttempts: settings.retryLimit + 1,
        });
        await repo.updateOrderState(tenantId, orderId, { verificationStatus: 'queued' });
        res.status(202).json({ accepted: true, callJob: created.job });
      } catch (err) {
        next(err);
      }
    }
  );

  // ==========================================================================
  // 2. ORDER ROUTER (/api/orders)
  // ==========================================================================
  const orderRouter = Router();

  orderRouter.get('/', requireAuth(env), async (req, res, next) => {
    /**
     * ENDPOINT DESCRIPTION: GET /api/orders
     * - CALLED BY: Next.js Admin Dashboard ("Orders" tab).
     * - INPUT SOURCE: Tenant context from `resolveScopedTenantId(req)`.
     * - PURPOSE: Returns the list of orders for the active tenant with raw `phoneE164` removed and replaced by `maskedPhone` for privacy compliance (SRS Section 13).
     */
    try {
      const tenantId = resolveScopedTenantId(req);
      if (tenantId === '__FORBIDDEN__') {
        res.status(403).json({ error: 'Cross-tenant access denied' });
        return;
      }
      if (!tenantId) {
        res.status(400).json({ error: 'Tenant context required' });
        return;
      }
      const orders = await repo.listOrders(tenantId, 100);
      res.json({
        orders: orders.map((o) => ({
          ...o,
          phoneE164: undefined,
          maskedPhone: o.phoneE164 ? maskPhoneNumber(o.phoneE164) : 'Invalid/Missing',
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  orderRouter.get('/:id/voice-history', requireAuth(env), async (req, res, next) => {
    /**
     * ENDPOINT DESCRIPTION: GET /api/orders/:id/voice-history (SRS Section 9)
     * - CALLED BY: Next.js Admin Dashboard when a user clicks on an order row to inspect its full details.
     * - INPUT SOURCE: `:id` URL parameter (`orderId`) and tenant context from `resolveScopedTenantId(req)`.
     * - PURPOSE: Loads the order, its generated Bangla TTS script preview, all call jobs, all voice call attempts, the step-by-step audit event timeline (`order_events`), and any linked WhatsApp customer instructions.
     */
    try {
      const tenantId = resolveScopedTenantId(req);
      if (tenantId === '__FORBIDDEN__') {
        res.status(403).json({ error: 'Cross-tenant access denied' });
        return;
      }
      if (!tenantId) {
        res.status(400).json({ error: 'Tenant context required' });
        return;
      }
      const orderId = String(req.params.id);
      const order = await repo.getOrderById(tenantId, orderId);
      if (!order) {
        res.status(404).json({ error: 'Order not found' });
        return;
      }

      const [jobs, calls, events, instructions] = await Promise.all([
        repo.listCallJobsByOrder(tenantId, orderId),
        repo.listVoiceCallsByOrder(tenantId, orderId),
        repo.listOrderEvents(tenantId, orderId),
        repo.listInstructionsByOrder(tenantId, orderId),
      ]);

      res.json({
        order: {
          ...order,
          phoneE164: undefined,
          maskedPhone: order.phoneE164 ? maskPhoneNumber(order.phoneE164) : 'Invalid/Missing',
        },
        promptPreview: buildOrderVerificationPrompt(order),
        callJobs: jobs,
        calls,
        timeline: events,
        instructions: instructions.map((i) => ({
          ...i,
          senderPhoneE164: undefined,
          maskedSender: maskPhoneNumber(i.senderPhoneE164),
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  // ==========================================================================
  // 3. INTERNAL ROUTER (/api/internal — Used by Self-Hosted n8n per SRS Section 10)
  // ==========================================================================
  const internalRouter = Router();
  internalRouter.use(requireInternalService(env));

  internalRouter.get('/orders/:id', async (req, res, next) => {
    /**
     * ENDPOINT DESCRIPTION: GET /api/internal/orders/:id (n8n Step 2)
     * - CALLED BY: Self-hosted n8n workflow (`n8n/workflows/flowmind-voice-confirmation.json`) using `X-Internal-Token`.
     * - INPUT SOURCE: `:id` URL parameter (`orderId`).
     * - PURPOSE: Gives n8n the authoritative order state, eligibility check result, and Bangla TTS script from Node.js so n8n never queries MySQL directly.
     */
    try {
      const orderId = String(req.params.id);
      const order = await repo.getOrderByIdUnsafe(orderId);
      if (!order) {
        res.status(404).json({ error: 'Order not found' });
        return;
      }
      const tenant = await repo.getTenantById(order.tenantId);
      const settings = await repo.getVoiceSettings(order.tenantId);
      if (!tenant || !settings) {
        res.status(404).json({ error: 'Tenant or settings not found' });
        return;
      }
      const isOptedOut = await repo.isPhoneOptedOut(order.tenantId, order.phoneE164);
      const eligibility = evaluateOrderEligibility({
        tenant,
        settings,
        order,
        isOptedOut,
        hasActiveCallJob: false,
      });
      res.json({
        order,
        tenant,
        settings,
        eligibility,
        prompt: buildOrderVerificationPrompt(order),
      });
    } catch (err) {
      next(err);
    }
  });

  internalRouter.post('/telephony/dial', async (req, res, next) => {
    /**
     * ENDPOINT DESCRIPTION: POST /api/internal/telephony/dial (n8n Step 5)
     * - CALLED BY: Self-hosted n8n workflow after n8n has obtained the Bangla TTS audio URL.
     * - INPUT SOURCE: `req.body` containing `{ tenantId, orderId, callJobId, audioUrl }`.
     * - PURPOSE: Calls `voiceCallService.executeOutboundCall(...)` to dial the customer's phone via Asterisk ARI or the Simulator.
     */
    try {
      const { tenantId, orderId, callJobId, audioUrl } = req.body as {
        tenantId: string;
        orderId: string;
        callJobId: string;
        audioUrl?: string;
      };
      const call = await voiceCallService.executeOutboundCall({
        tenantId,
        orderId,
        callJobId,
        preGeneratedAudioUrl: audioUrl,
      });
      res.status(201).json({ call });
    } catch (err) {
      next(err);
    }
  });

  internalRouter.post('/jobs/dlq', async (req, res, next) => {
    /**
     * ENDPOINT DESCRIPTION: POST /api/internal/jobs/dlq (n8n Step 9)
     * - CALLED BY: Self-hosted n8n error branch if TTS or telephony origination fails inside n8n.
     * - INPUT SOURCE: `req.body` containing `{ tenantId, orderId, callJobId, attemptNo, errorMessage }`.
     * - PURPOSE: Marks the call job as `dead_letter` in the database and pushes it into the Dead-Letter Queue (`queue.enqueueDeadLetter`).
     */
    try {
      const { tenantId, orderId, callJobId, attemptNo, errorMessage } = req.body as {
        tenantId: string;
        orderId: string;
        callJobId: string;
        attemptNo?: number;
        errorMessage?: string;
      };
      await repo.updateCallJob(tenantId, callJobId, {
        status: 'dead_letter',
        lastError: errorMessage || 'n8n workflow dead-lettered',
      });
      await repo.addOrderEvent({
        id: crypto.randomUUID(),
        tenantId,
        orderId,
        callId: null,
        eventType: 'n8n_workflow_dlq',
        source: 'n8n',
        metadata: { callJobId, errorMessage },
        createdAt: new Date().toISOString(),
      });
      await queue.enqueueDeadLetter(
        { tenantId, orderId, callJobId, attemptNo: attemptNo ?? 1 },
        errorMessage || 'n8n dead-letter'
      );
      res.json({ recorded: true });
    } catch (err) {
      next(err);
    }
  });

  return { voiceRouter, orderRouter, internalRouter };
}
