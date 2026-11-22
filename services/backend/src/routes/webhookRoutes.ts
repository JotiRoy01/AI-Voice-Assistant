import crypto from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import { AppEnv } from '../config/env';
import { StoreProvider } from '../domain/types';
import { verifyHmacSignature } from '../security/crypto';
import { DtmfCallbackService } from '../services/dtmfCallbackService';
import { OrderIntakeService } from '../services/orderIntakeService';
import { WhatsAppService } from '../services/whatsappService';
import { logger } from '../utils/logger';

/**
 * Zod Validation Schema: telephonyEventSchema
 * - PURPOSE: Validates the JSON body sent by Asterisk AGI (`flowmind-callback.sh`) or the Telephony Simulator when reporting call events (`ringing`, `answered`, `dtmf`, `no_answer`, `busy`, `failed`, `completed`).
 */
const telephonyEventSchema = z.object({
  providerEventId: z.string().min(1),
  provider: z.string().optional(),
  providerCallId: z.string().min(1),
  eventType: z.enum(['ringing', 'answered', 'dtmf', 'no_answer', 'busy', 'failed', 'completed']),
  digit: z.string().optional(),
  durationSec: z.coerce.number().int().min(0).optional(),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
});

export function createWebhookRouter(deps: {
  orderIntakeService: OrderIntakeService;
  dtmfCallbackService: DtmfCallbackService;
  whatsappService: WhatsAppService;
  env: AppEnv;
}): Router {
  /**
   * ============================================================================
   * ROUTER FACTORY DESCRIPTION: createWebhookRouter (`/api/webhooks`)
   * - MEANING: The public-facing HTTP entry door for all external webhooks arriving from e-commerce stores (Shopify/WooCommerce/Custom), Asterisk Telephony, and Meta WhatsApp Cloud API.
   * - WHY WE USE IT: External providers push events to our server via HTTP requests. Because external providers don't log in with user JWTs, every endpoint in this router authenticates requests using cryptographic HMAC-SHA256 signatures (`verifyHmacSignature`).
   * - WHERE IT IS USED: Mounted at `/api/webhooks` in `src/app.ts`.
   * ============================================================================
   */
  const router = Router();
  const { orderIntakeService, dtmfCallbackService, whatsappService, env } = deps;

  router.post('/orders/:provider', async (req, res, next) => {
    /**
     *ENDPOINT DESCRIPTION: POST /api/webhooks/orders/:provider (SRS Section 9)
     * - CALLED BY: External e-commerce stores (Shopify, WooCommerce, or Custom merchant store) whenever a customer places a new order.
     * - INPUT SOURCE:
     *   • `:provider` URL parameter (`'shopify' | 'woocommerce' | 'custom'`).
     *   • Tenant ID from `X-Tenant-Id` header or `?tenant=<slug>` query string.
     *   • `req.rawBody` (raw unparsed Buffer) & `req.headers` (containing the store's HMAC signature).
     *   • `req.body` (the store's order JSON payload).
     * - PURPOSE: Validates the URL parameters and delegates to `orderIntakeService.handleOrderWebhook(...)` (which calls `storeAdapters.ts` to verify the HMAC signature and normalize the order).
     */
    try {
      const provider = String(req.params.provider || '').toLowerCase() as StoreProvider;
      if (!['shopify', 'woocommerce', 'custom'].includes(provider)) {
        res.status(400).json({ error: `Unsupported store provider: ${provider}` });
        return;
      }

      const tenantSlugOrId =
        String(req.header('x-tenant-id') || req.query.tenant || '').trim();
      if (!tenantSlugOrId) {
        res.status(400).json({ error: 'Missing tenant identifier (X-Tenant-Id header or ?tenant= query)' });
        return;
      }

      const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
      const result = await orderIntakeService.handleOrderWebhook({
        provider,
        tenantSlugOrId,
        rawBody,
        body: (req.body as Record<string, unknown>) || {},
        headers: req.headers,
      });

      res.status(result.httpStatus).json({
        accepted: result.accepted,
        duplicate: result.duplicate ?? false,
        eligible: result.eligible ?? false,
        reason: result.reason,
        orderId: result.order?.id,
        externalOrderId: result.order?.externalOrderId,
        callJobId: result.callJob?.id,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/telephony/events', async (req, res, next) => {
    /**
     * ENDPOINT DESCRIPTION: POST /api/webhooks/telephony/events (SRS Section 9)
     * - CALLED BY: Asterisk PBX callback script (`asterisk/agi/flowmind-callback.sh`) during a live phone call whenever the call state changes (`ringing`, `answered`, `no_answer`, `busy`) or the customer presses a keypad button (`dtmf` `1`, `2`, `3`).
     * - INPUT SOURCE:
     *   • `x-telephony-signature` HTTP header (`sha256=<hex_hmac>` signed with `TELEPHONY_WEBHOOK_SECRET`).
     *   • `req.body` validated against `telephonyEventSchema` (`providerEventId`, `providerCallId`, `eventType`, `digit`).
     * - PURPOSE: Verifies the telephony HMAC signature and passes the validated event to `dtmfCallbackService.handleTelephonyEvent(...)`.
     */
    try {
      const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
      const sig = req.header('x-telephony-signature');
      if (!verifyHmacSignature(rawBody, sig, env.TELEPHONY_WEBHOOK_SECRET, 'hex', 'sha256=')) {
        logger.warn('Rejected telephony callback with invalid HMAC signature');
        res.status(401).json({ error: 'Invalid telephony callback signature' });
        return;
      }

      const parsed = telephonyEventSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid telephony event payload', details: parsed.error.flatten() });
        return;
      }

      const result = await dtmfCallbackService.handleTelephonyEvent(parsed.data);
      res.status(result.httpStatus).json(result);
    } catch (err) {
      next(err);
    }
  });

  router.get('/whatsapp/messages', (req, res) => {
    /**
     * ENDPOINT DESCRIPTION: GET /api/webhooks/whatsapp/messages
     * - CALLED BY: Meta's servers when configuring the WhatsApp Cloud API Webhook URL in the Meta Developer Portal.
     * - INPUT SOURCE: Query parameters `hub.mode`, `hub.verify_token`, and `hub.challenge`.
     * - PURPOSE: Echoes back `hub.challenge` if `hub.verify_token` matches `env.WHATSAPP_VERIFY_TOKEN`, completing Meta's webhook verification handshake.
     */
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === env.WHATSAPP_VERIFY_TOKEN) {
      res.status(200).send(String(challenge || ''));
      return;
    }
    res.status(403).json({ error: 'WhatsApp webhook verification failed' });
  });

  router.post('/whatsapp/messages', async (req, res, next) => {
    /**
     * ENDPOINT DESCRIPTION: POST /api/webhooks/whatsapp/messages (SRS Section 9, FR-14)
     * - CALLED BY: Meta WhatsApp Cloud API whenever a customer replies to our WhatsApp message with their custom order instructions (after pressing Key `3`).
     * - INPUT SOURCE:
     *   • `x-hub-signature-256` HTTP header (`sha256=<hex_hmac>` signed with `WHATSAPP_APP_SECRET`).
     *   • `req.body` (supports both Meta's deeply nested `entry[0].changes[0].value.messages[0]` structure and a flat JSON structure).
     * - PURPOSE: Verifies Meta's HMAC signature, extracts the sender's phone number and message text, and calls `whatsappService.handleInboundMessage(...)` to link the instruction to the customer's order.
     */
    try {
      const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
      const sig = req.header('x-hub-signature-256');
      if (!verifyHmacSignature(rawBody, sig, env.WHATSAPP_APP_SECRET, 'hex', 'sha256=')) {
        logger.warn('Rejected WhatsApp webhook with invalid X-Hub-Signature-256');
        res.status(401).json({ error: 'Invalid WhatsApp webhook signature' });
        return;
      }

      const tenantSlugOrId = String(req.header('x-tenant-id') || req.query.tenant || 'desh-fashion').trim();
      const body = req.body as Record<string, unknown>;

      // Developer Note: Meta Cloud API wraps messages inside `entry[0].changes[0].value.messages[0]`.
      // We parse both Meta's nested format and a simplified `{ from, text }` format for easy testing.
      let senderPhone = '';
      let messageText = '';
      let providerMessageId = '';
      let explicitOrderRef: string | undefined;

      if (Array.isArray(body.entry)) {
        const entry = body.entry[0] as Record<string, unknown> | undefined;
        const changes = Array.isArray(entry?.changes) ? (entry.changes[0] as Record<string, unknown>) : undefined;
        const value = (changes?.value as Record<string, unknown>) || {};
        const messages = Array.isArray(value.messages) ? (value.messages as Record<string, unknown>[]) : [];
        const msg = messages[0];
        if (!msg) {
          res.status(200).json({ received: true, ignored: 'status_update_without_message' });
          return;
        }
        senderPhone = String(msg.from ?? '');
        const textObj = (msg.text as Record<string, unknown>) || {};
        messageText = String(textObj.body ?? '');
        providerMessageId = String(msg.id ?? crypto.randomUUID());
      } else {
        senderPhone = String(body.from ?? body.senderPhone ?? '');
        messageText = String(body.text ?? body.messageText ?? '');
        providerMessageId = String(body.messageId ?? body.providerMessageId ?? crypto.randomUUID());
        explicitOrderRef = body.orderRef ? String(body.orderRef) : undefined;
      }

      if (!senderPhone || !messageText) {
        res.status(400).json({ error: 'Missing sender phone or message text' });
        return;
      }

      const result = await whatsappService.handleInboundMessage({
        tenantSlugOrId,
        senderPhone,
        messageText,
        providerMessageId,
        explicitOrderRef,
      });

      res.status(result.httpStatus).json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
