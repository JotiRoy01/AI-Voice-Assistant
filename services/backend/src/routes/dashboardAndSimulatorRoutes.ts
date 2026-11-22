import crypto from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import { AppEnv } from '../config/env';
import { FlowMindRepository } from '../db/repository';
import { StoreProvider } from '../domain/types';
import { requireAuth, requireRoles, resolveScopedTenantId } from '../security/auth';
import { computeHmacBase64, computeHmacHex, encryptSecret } from '../security/crypto';
import { maskPhoneNumber, normalizePhoneE164 } from '../security/phone';
import { DtmfCallbackService } from '../services/dtmfCallbackService';
import { OrderIntakeService } from '../services/orderIntakeService';
import { WhatsAppService } from '../services/whatsappService';

const credentialSchema = z.object({
  secret: z.string().min(4),
  config: z.record(z.unknown()).optional(),
  status: z.enum(['active', 'disabled']).default('active'),
});

const optOutSchema = z.object({
  phone: z.string().min(6),
  reason: z.string().max(255).optional(),
});

export function createDashboardAndSimulatorRouters(deps: {
  repo: FlowMindRepository;
  orderIntakeService: OrderIntakeService;
  dtmfCallbackService: DtmfCallbackService;
  whatsappService: WhatsAppService;
  env: AppEnv;
}): { dashboardRouter: Router; simulatorRouter: Router } {
  /**
   * ============================================================================
   * ROUTER FACTORY DESCRIPTION: createDashboardAndSimulatorRouters
   * - MEANING: Builds two Express routers:
   *   1. `dashboardRouter` (`/api/dashboard/*`): Powers the Admin Dashboard pages for Usage & Cost metrics, Error Monitor & Pending Store-Sync recovery, WhatsApp Customer Instructions, Encrypted Store Credentials, and Phone Opt-Outs.
   *   2. `simulatorRouter` (`/api/simulator/*`): Powers the interactive "Live Simulator & Test Bench" tab in the dashboard so you can simulate signed Shopify/WooCommerce webhooks, press virtual DTMF keys (`1`, `2`, `3`), and send simulated WhatsApp replies from the browser.
   * - WHERE IT IS USED: Mounted at `/api/dashboard` and `/api/simulator` in `src/app.ts`.
   * ============================================================================
   */
  const { repo, orderIntakeService, dtmfCallbackService, whatsappService, env } = deps;

  // ==========================================================================
  // 1. DASHBOARD ROUTER (/api/dashboard)
  // ==========================================================================
  const dashboardRouter = Router();
  dashboardRouter.use(requireAuth(env));

  dashboardRouter.get('/usage', async (req, res, next) => {
    /**
     * ENDPOINT DESCRIPTION: GET /api/dashboard/usage (SRS Section 14)
     * - CALLED BY: Next.js Admin Dashboard ("Overview & Usage" tab).
     * - INPUT SOURCE: Tenant context from `resolveScopedTenantId(req)`.
     * - PURPOSE: Aggregates total orders, confirmed/cancelled/WhatsApp counts, total call duration seconds, and estimated BD telecom carrier cost (~0.60 BDT/min).
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
      const [metrics, tenant, settings] = await Promise.all([
        repo.getUsageMetrics(tenantId),
        repo.getTenantById(tenantId),
        repo.getVoiceSettings(tenantId),
      ]);
      res.json({
        tenant,
        metrics,
        costBoundaryNote:
          'Software stack (Node.js, MySQL, Redis, n8n, Asterisk, local TTS) is self-hostable; public mobile outbound calls via SIP trunk/carrier still incur carrier charges (~0.60 BDT/min illustrative estimate).',
        activeProviders: settings
          ? {
              tts: settings.ttsProvider,
              telephony: settings.telephonyProvider,
              whatsapp: settings.whatsappProvider,
            }
          : null,
      });
    } catch (err) {
      next(err);
    }
  });

  dashboardRouter.get('/errors', async (req, res, next) => {
    /**
     * ENDPOINT DESCRIPTION: GET /api/dashboard/errors (SRS Section 14 Error Monitor)
     * - CALLED BY: Next.js Admin Dashboard ("Error Monitor" tab).
     * - INPUT SOURCE: Tenant context from `resolveScopedTenantId(req)`.
     * - PURPOSE: Lists recent error events, orders stuck in `pending_sync` (where the customer confirmed/cancelled on the call, but the store API timed out), and failed/dead-letter call jobs.
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
      const [errorEvents, pendingSyncOrders, failedJobs] = await Promise.all([
        repo.listRecentErrorEvents(tenantId, 100),
        repo.listPendingSyncOrders(tenantId),
        repo.listFailedCallJobs(tenantId),
      ]);
      res.json({
        errorEvents,
        pendingSyncOrders: pendingSyncOrders.map((o) => ({
          ...o,
          phoneE164: undefined,
          maskedPhone: o.phoneE164 ? maskPhoneNumber(o.phoneE164) : '***',
        })),
        failedJobs,
      });
    } catch (err) {
      next(err);
    }
  });

  dashboardRouter.post(
    '/errors/:orderId/retry-sync',
    requireRoles('super_admin', 'business_owner', 'operator'),
    async (req, res, next) => {
      /**
       * ENDPOINT DESCRIPTION: POST /api/dashboard/errors/:orderId/retry-sync
       * - CALLED BY: Next.js Admin Dashboard when an operator clicks "Retry Store Sync" on the Error Monitor page.
       * - INPUT SOURCE: `:orderId` URL parameter and tenant context from `resolveScopedTenantId(req)`.
       * - PURPOSE: Calls `dtmfCallbackService.retryStoreSync(tenantId, orderId)` to re-send the confirmation or cancellation status to Shopify/WooCommerce.
       */
      try {
        const tenantId = resolveScopedTenantId(req);
        if (tenantId === '__FORBIDDEN__' || !tenantId) {
          res.status(403).json({ error: 'Tenant access denied' });
          return;
        }
        const result = await dtmfCallbackService.retryStoreSync(tenantId, String(req.params.orderId));
        res.status(result.success ? 200 : 502).json(result);
      } catch (err) {
        next(err);
      }
    }
  );

  dashboardRouter.get('/instructions', async (req, res, next) => {
    /**
     * ENDPOINT DESCRIPTION: GET /api/dashboard/instructions
     * - CALLED BY: Next.js Admin Dashboard ("WhatsApp Instructions" tab).
     * - INPUT SOURCE: Tenant context from `resolveScopedTenantId(req)`.
     * - PURPOSE: Lists all inbound WhatsApp customer messages linked to orders for this tenant, with sender phone numbers masked.
     */
    try {
      const tenantId = resolveScopedTenantId(req);
      if (tenantId === '__FORBIDDEN__' || !tenantId) {
        res.status(403).json({ error: 'Tenant access denied' });
        return;
      }
      const instructions = await repo.listInstructionsByTenant(tenantId, 100);
      res.json({
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

  dashboardRouter.get('/credentials', async (req, res, next) => {
    /**
     * ENDPOINT DESCRIPTION: GET /api/dashboard/credentials
     * - CALLED BY: Next.js Admin Dashboard ("Settings & Credentials" tab).
     * - INPUT SOURCE: Tenant context from `resolveScopedTenantId(req)`.
     * - PURPOSE: Lists configured store/provider credentials for the tenant. Note: For security, it NEVER returns the decrypted secret—only `hasEncryptedSecret: true`.
     */
    try {
      const tenantId = resolveScopedTenantId(req);
      if (tenantId === '__FORBIDDEN__' || !tenantId) {
        res.status(403).json({ error: 'Tenant access denied' });
        return;
      }
      const creds = await repo.listProviderCredentials(tenantId);
      res.json({
        credentials: creds.map((c) => ({
          id: c.id,
          provider: c.provider,
          config: c.config,
          status: c.status,
          hasEncryptedSecret: Boolean(c.encryptedSecret),
          updatedAt: c.updatedAt,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  dashboardRouter.put(
    '/credentials/:provider',
    requireRoles('super_admin', 'business_owner'),
    async (req, res, next) => {
      /**
       * ENDPOINT DESCRIPTION: PUT /api/dashboard/credentials/:provider (SRS Section 8.1)
       * - CALLED BY: Next.js Admin Dashboard when a `super_admin` or `business_owner` saves a Shopify/WooCommerce/Custom webhook secret.
       * - INPUT SOURCE: `:provider` URL param, `req.body` (`{ secret, config, status }`), and tenant context from `resolveScopedTenantId(req)`.
       * - PURPOSE: Encrypts the plaintext secret with AES-256-GCM (`encryptSecret`) before storing `encryptedSecret`, `iv`, and `authTag` in the `provider_credentials` table.
       */
      try {
        const tenantId = resolveScopedTenantId(req);
        if (tenantId === '__FORBIDDEN__' || !tenantId) {
          res.status(403).json({ error: 'Tenant access denied' });
          return;
        }
        const parsed = credentialSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: 'Invalid credential payload', details: parsed.error.flatten() });
          return;
        }
        const enc = encryptSecret(parsed.data.secret, env.ENCRYPTION_KEY_HEX);
        const saved = await repo.upsertProviderCredential({
          id: crypto.randomUUID(),
          tenantId,
          provider: String(req.params.provider).toLowerCase(),
          config: parsed.data.config ?? null,
          encryptedSecret: enc.encryptedSecret,
          iv: enc.iv,
          authTag: enc.authTag,
          status: parsed.data.status,
          updatedAt: new Date().toISOString(),
        });
        res.json({
          credential: {
            id: saved.id,
            provider: saved.provider,
            config: saved.config,
            status: saved.status,
            hasEncryptedSecret: true,
            updatedAt: saved.updatedAt,
          },
        });
      } catch (err) {
        next(err);
      }
    }
  );

  dashboardRouter.post(
    '/opt-outs',
    requireRoles('super_admin', 'business_owner', 'operator'),
    async (req, res, next) => {
      /**
       * ENDPOINT DESCRIPTION: POST /api/dashboard/opt-outs (SRS Section 11 & 13)
       * - CALLED BY: Next.js Admin Dashboard when an operator adds a customer phone number to the Do-Not-Call / Opt-Out list.
       * - INPUT SOURCE: `req.body` (`{ phone, reason }`) and tenant context from `resolveScopedTenantId(req)`.
       * - PURPOSE: Normalizes the phone number to E.164 (`+8801...`) and saves it in `phone_opt_outs` so future orders from this number are automatically marked `suppressed_opt_out`.
       */
      try {
        const tenantId = resolveScopedTenantId(req);
        if (tenantId === '__FORBIDDEN__' || !tenantId) {
          res.status(403).json({ error: 'Tenant access denied' });
          return;
        }
        const parsed = optOutSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: 'Invalid phone payload' });
          return;
        }
        const normalized = normalizePhoneE164(parsed.data.phone);
        if (!normalized) {
          res.status(400).json({ error: 'Could not normalize phone number to E.164' });
          return;
        }
        await repo.addOptOut(tenantId, normalized, parsed.data.reason);
        res.status(201).json({ suppressed: true, maskedPhone: maskPhoneNumber(normalized) });
      } catch (err) {
        next(err);
      }
    }
  );

  // ==========================================================================
  // 2. SIMULATOR ROUTER (/api/simulator — Interactive Demo Test Bench)
  // ==========================================================================
  const simulatorRouter = Router();
  simulatorRouter.use((_req, res, next) => {
    if (!env.SIMULATOR_ENABLED) {
      res.status(403).json({ error: 'Simulator is disabled in this environment' });
      return;
    }
    next();
  });
  simulatorRouter.use(requireAuth(env));

  simulatorRouter.post('/order-webhook', async (req, res, next) => {
    /**
     * ENDPOINT DESCRIPTION: POST /api/simulator/order-webhook
     * - CALLED BY: Next.js Admin Dashboard ("Live Simulator & Test Bench" tab -> "1. Simulate Store Order Webhook" button).
     * - INPUT SOURCE: `req.body` containing `{ provider, payload, bypassCallingWindow }`.
     * - PURPOSE: Computes a real HMAC-SHA256 signature for the chosen store provider (`shopify`, `woocommerce`, or `custom`) and passes it into `orderIntakeService.handleOrderWebhook(...)` so you can demonstrate the full signed webhook pipeline live in a meeting.
     */
    try {
      const tenantId = resolveScopedTenantId(req);
      if (tenantId === '__FORBIDDEN__' || !tenantId) {
        res.status(403).json({ error: 'Tenant access denied' });
        return;
      }
      const provider = (req.body.provider || 'custom') as StoreProvider;
      const payload = req.body.payload as Record<string, unknown>;
      const rawBody = Buffer.from(JSON.stringify(payload));
      const headers: Record<string, string> = {};

      if (provider === 'shopify') {
        headers['x-shopify-hmac-sha256'] = computeHmacBase64(rawBody, env.DEFAULT_SHOPIFY_WEBHOOK_SECRET);
      } else if (provider === 'woocommerce') {
        headers['x-wc-webhook-signature'] = computeHmacBase64(rawBody, env.DEFAULT_WOOCOMMERCE_WEBHOOK_SECRET);
      } else {
        headers['x-flowmind-signature'] = `sha256=${computeHmacHex(rawBody, env.DEFAULT_CUSTOM_WEBHOOK_SECRET)}`;
      }

      const result = await orderIntakeService.handleOrderWebhook({
        provider,
        tenantSlugOrId: tenantId,
        rawBody,
        body: payload,
        headers,
        bypassCallingWindow: Boolean(req.body.bypassCallingWindow ?? true),
      });

      // Developer Note: Wait 80ms so the background inline queue worker finishes initiating the simulated call,
      // allowing us to return the active `calls` array immediately to the Test Bench UI.
      if (result.order && result.eligible) {
        await new Promise((r) => setTimeout(r, 80));
        const calls = await repo.listVoiceCallsByOrder(tenantId, result.order.id);
        res.status(result.httpStatus).json({ ...result, calls });
        return;
      }
      res.status(result.httpStatus).json(result);
    } catch (err) {
      next(err);
    }
  });

  simulatorRouter.post('/telephony-event', async (req, res, next) => {
    /**
     * ENDPOINT DESCRIPTION: POST /api/simulator/telephony-event
     * - CALLED BY: Next.js Admin Dashboard ("Live Simulator & Test Bench" virtual phone keypad buttons `1`, `2`, `3`, `No Input`, `Invalid Key`, `No Answer`).
     * - INPUT SOURCE: `req.body` containing `{ providerCallId, eventType, digit, durationSec }`.
     * - PURPOSE: Invokes `dtmfCallbackService.handleTelephonyEvent(...)` as if Asterisk just sent a DTMF callback from the customer's phone.
     */
    try {
      const { providerCallId, eventType, digit, durationSec } = req.body as {
        providerCallId: string;
        eventType: 'ringing' | 'answered' | 'dtmf' | 'no_answer' | 'busy' | 'failed' | 'completed';
        digit?: string;
        durationSec?: number;
      };
      const result = await dtmfCallbackService.handleTelephonyEvent({
        providerEventId: `sim-evt-${crypto.randomUUID()}`,
        provider: 'simulator',
        providerCallId,
        eventType,
        digit,
        durationSec,
      });
      res.status(result.httpStatus).json(result);
    } catch (err) {
      next(err);
    }
  });

  simulatorRouter.post('/whatsapp-reply', async (req, res, next) => {
    /**
     * ENDPOINT DESCRIPTION: POST /api/simulator/whatsapp-reply
     * - CALLED BY: Next.js Admin Dashboard ("Live Simulator & Test Bench" -> "Simulate Inbound WhatsApp Customer Reply").
     * - INPUT SOURCE: `req.body` containing `{ senderPhone, messageText, orderRef }`.
     * - PURPOSE: Invokes `whatsappService.handleInboundMessage(...)` to demonstrate how a customer's Bangla WhatsApp reply is automatically matched and attached to the order after pressing Key `3`.
     */
    try {
      const tenantId = resolveScopedTenantId(req);
      if (tenantId === '__FORBIDDEN__' || !tenantId) {
        res.status(403).json({ error: 'Tenant access denied' });
        return;
      }
      const { senderPhone, messageText, orderRef } = req.body as {
        senderPhone: string;
        messageText: string;
        orderRef?: string;
      };
      const result = await whatsappService.handleInboundMessage({
        tenantSlugOrId: tenantId,
        senderPhone,
        messageText,
        providerMessageId: `wamid.sim.${crypto.randomUUID()}`,
        explicitOrderRef: orderRef,
      });
      res.status(result.httpStatus).json(result);
    } catch (err) {
      next(err);
    }
  });

  return { dashboardRouter, simulatorRouter };
}
