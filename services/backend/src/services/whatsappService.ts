import crypto from 'crypto';
import { FlowMindRepository } from '../db/repository';
import { CustomerInstruction, Order } from '../domain/types';
import { maskPhoneNumber, normalizePhoneE164 } from '../security/phone';

export interface InboundWhatsAppMessage {
  tenantSlugOrId: string;
  senderPhone: string;
  messageText: string;
  providerMessageId: string;
  explicitOrderRef?: string;
}

export interface WhatsAppInboundResult {
  httpStatus: number;
  linked: boolean;
  duplicate?: boolean;
  orderId?: string;
  instruction?: CustomerInstruction;
  reason?: string;
}

/**
 * Helper: Extracts an order reference such as `"Order DF-1002"`, `"#1002"`, or `"DF-1002"` from a WhatsApp message.
 * - WHO CALLS THIS: `WhatsAppService.handleInboundMessage`.
 * - WHERE INPUT COMES FROM: `text` is the customer's WhatsApp reply message text (`input.messageText`).
 * - PURPOSE: Since our WhatsApp deep-link pre-fills `"Order <ExternalOrderId>: ..."`, this regex pulls out `<ExternalOrderId>` so we can match the customer's reply to the exact order in our database.
 */
function extractOrderReference(text: string): string | null {
  const match = text.match(/(?:order\s*#?\s*|#)([A-Za-z0-9_-]{3,40})/i);
  return match ? match[1] : null;
}

export class WhatsAppService {
  /**
   * ============================================================================
   * CLASS DESCRIPTION: WhatsAppService
   * - MEANING: The Phase-5 inbound WhatsApp customer instruction processor.
   * - WHY WE USE IT: When a customer presses Key `3` during the voice call, they receive a WhatsApp link and reply with special instructions (e.g., *"ভাই, সন্ধ্যা ৬টার পরে ডেলিভারি দিবেন"*). This service receives that inbound WhatsApp message, links it to the customer's order, and stores it in `customer_instructions` so operators see it on the dashboard.
   * - WHERE IT IS USED: Instantiated in `src/app.ts` and called by `webhookRoutes.ts` (`POST /api/webhooks/whatsapp/messages`) and `dashboardAndSimulatorRoutes.ts` (`POST /api/simulator/whatsapp-reply`).
   * ============================================================================
   */
  constructor(private readonly repo: FlowMindRepository) {}

  async handleInboundMessage(input: InboundWhatsAppMessage): Promise<WhatsAppInboundResult> {
    /**
     * METHOD DESCRIPTION: handleInboundMessage
     * - CALLED BY: `webhookRoutes.ts` (`POST /api/webhooks/whatsapp/messages`) and `dashboardAndSimulatorRoutes.ts` (`POST /api/simulator/whatsapp-reply`).
     * - INPUT SOURCE: `input` (`InboundWhatsAppMessage`) is extracted from the Meta Cloud API webhook payload (or Simulator Test Bench request) containing `senderPhone`, `messageText`, `providerMessageId`, and `tenantSlugOrId`.
     * - PURPOSE:
     *   1. Verifies the tenant and deduplicates the message by `providerMessageId`.
     *   2. Normalizes the sender's phone number to E.164 (`+8801...`).
     *   3. Matches the message to an `Order` (first by order reference in the text like `Order #1002`, or fallback to the most recent order for that phone number that pressed Key `3`).
     *   4. Saves the instruction in `customer_instructions` and logs an `order_events` audit entry.
     */
    const tenant =
      (await this.repo.getTenantById(input.tenantSlugOrId)) ||
      (await this.repo.getTenantBySlug(input.tenantSlugOrId));
    if (!tenant) {
      return { httpStatus: 404, linked: false, reason: 'tenant_not_found' };
    }

    // Deduplicate repeated Meta webhook deliveries using `providerMessageId`
    const isNew = await this.repo.recordCallbackIfNew(tenant.id, 'whatsapp', input.providerMessageId);
    if (!isNew) {
      return { httpStatus: 200, linked: true, duplicate: true };
    }

    const senderE164 = normalizePhoneE164(input.senderPhone);
    if (!senderE164) {
      return { httpStatus: 400, linked: false, reason: 'invalid_sender_phone' };
    }

    // Matching Strategy 1: Look for an explicit order reference in the text (e.g., "Order DF-1002")
    let matchedOrder: Order | null = null;
    const candidateRef = input.explicitOrderRef || extractOrderReference(input.messageText);
    if (candidateRef) {
      matchedOrder =
        (await this.repo.getOrderByExternalId(tenant.id, candidateRef)) ||
        (await this.repo.getOrderById(tenant.id, candidateRef));
    }

    // Matching Strategy 2 (Fallback): If the customer deleted the "Order #..." prefix before sending,
    // match the most recent order from this phone number that requested WhatsApp (Key 3).
    if (!matchedOrder) {
      matchedOrder = await this.repo.findRecentWhatsAppOrderByPhone(tenant.id, senderE164);
    }

    if (!matchedOrder) {
      return { httpStatus: 202, linked: false, reason: 'no_matching_order_found' };
    }

    const now = new Date().toISOString();
    const instruction = await this.repo.createCustomerInstruction({
      id: crypto.randomUUID(),
      tenantId: tenant.id,
      orderId: matchedOrder.id,
      channel: 'whatsapp',
      senderPhoneE164: senderE164,
      messageText: input.messageText,
      providerMessageId: input.providerMessageId,
      receivedAt: now,
      status: 'received',
      createdAt: now,
    });

    await this.repo.addOrderEvent({
      id: crypto.randomUUID(),
      tenantId: tenant.id,
      orderId: matchedOrder.id,
      callId: null,
      eventType: 'whatsapp_instruction_received',
      source: 'whatsapp_webhook',
      metadata: {
        instructionId: instruction.id,
        maskedSender: maskPhoneNumber(senderE164),
        providerMessageId: input.providerMessageId,
      },
      createdAt: now,
    });

    return {
      httpStatus: 200,
      linked: true,
      orderId: matchedOrder.id,
      instruction,
    };
  }
}
