import crypto from 'crypto';
import { AppEnv } from '../../config/env';
import { WhatsAppAdapter, WhatsAppRedirectRequest, WhatsAppSendResult } from '../interfaces';

/**
 * Helper: Constructs a clickable `https://wa.me/...` deep-link pre-filled with the customer's Order ID in Bangla.
 * - WHO CALLS THIS: `SimulatorWhatsAppAdapter.sendOrderInstructionLink` and `MetaCloudWhatsAppAdapter.sendOrderInstructionLink`.
 * - WHERE INPUT COMES FROM: `businessNumber` comes from the tenant's `VoiceSettings.whatsappFallbackContact` (or `.env`), and `externalOrderId` comes from the `Order` record.
 * - PURPOSE: When the customer taps the link on their phone, WhatsApp opens with `"Order #1042: আমার অর্ডার সম্পর্কে বিশেষ নির্দেশনা — "` already typed so our inbound webhook can automatically match their reply to the right order!
 */
export function buildWhatsAppDeepLink(businessNumber: string, externalOrderId: string): string {
  const digits = businessNumber.replace(/\D/g, '');
  const prefill = encodeURIComponent(
    `Order ${externalOrderId}: আমার অর্ডার সম্পর্কে বিশেষ নির্দেশনা — `
  );
  return `https://wa.me/${digits}?text=${prefill}`;
}

export class SimulatorWhatsAppAdapter implements WhatsAppAdapter {
  /**
   * ============================================================================
   * CLASS DESCRIPTION: SimulatorWhatsAppAdapter
   * - MEANING: Local simulator for outbound WhatsApp notifications when a customer presses Key `3` during the voice call.
   * - WHY WE USE IT: Allows full end-to-end testing of the Key `3` (Special Instructions via WhatsApp) flow without requiring a live Meta Business Cloud API token.
   * - WHERE IT IS USED: Created by `createWhatsAppAdapter(env)` in `src/app.ts` when `WHATSAPP_PROVIDER=simulator` and called by `DtmfCallbackService`.
   * ============================================================================
   */
  readonly name = 'simulator';

  async sendOrderInstructionLink(req: WhatsAppRedirectRequest): Promise<WhatsAppSendResult> {
    /**
     * METHOD DESCRIPTION: sendOrderInstructionLink (Simulator)
     * - CALLED BY: `DtmfCallbackService.handleTelephonyEvent` (in `src/services/dtmfCallbackService.ts`) when `decision.action === 'trigger_whatsapp'` (Key `3`).
     * - INPUT SOURCE: `req` is assembled by `DtmfCallbackService` from the `Order` and `VoiceSettings` database records.
     * - PURPOSE: Generates the pre-filled WhatsApp `wa.me` deep link and returns a simulated message ID (`wamid.sim...`) so the event timeline and UI Test Bench can display the link immediately.
     */
    const deepLinkUrl = buildWhatsAppDeepLink(req.businessWhatsAppNumber, req.externalOrderId);
    return {
      success: true,
      providerMessageId: `wamid.sim.${crypto.randomBytes(6).toString('hex')}`,
      deepLinkUrl,
    };
  }
}

export class MetaCloudWhatsAppAdapter implements WhatsAppAdapter {
  /**
   * ============================================================================
   * CLASS DESCRIPTION: MetaCloudWhatsAppAdapter
   * - MEANING: Production adapter for Meta's Official WhatsApp Business Cloud API (Graph API v21.0).
   * - WHY WE USE IT: Sends an approved Bangla WhatsApp template message (`order_custom_instruction_bn`) to the customer's mobile number as soon as they press Key `3` on the voice call.
   * - WHERE IT IS USED: Instantiated by `createWhatsAppAdapter(env)` when `WHATSAPP_PROVIDER=meta_cloud` and used by `DtmfCallbackService`.
   * ============================================================================
   */
  readonly name = 'meta_cloud';

  constructor(private readonly env: AppEnv) {}

  async sendOrderInstructionLink(req: WhatsAppRedirectRequest): Promise<WhatsAppSendResult> {
    /**
     * METHOD DESCRIPTION: sendOrderInstructionLink (Meta Cloud API)
     * - CALLED BY: `DtmfCallbackService.handleTelephonyEvent` when the customer presses Key `3`.
     * - INPUT SOURCE: `req` (`toPhoneE164`, `customerName`, `externalOrderId`) comes from `DtmfCallbackService`; API credentials (`WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`) come from `this.env`.
     * - PURPOSE: Makes an authenticated `POST` request to `https://graph.facebook.com/.../messages` to deliver the WhatsApp template message to the customer.
     */
    const deepLinkUrl = buildWhatsAppDeepLink(
      req.businessWhatsAppNumber || this.env.WHATSAPP_BUSINESS_NUMBER,
      req.externalOrderId
    );
    if (!this.env.WHATSAPP_PHONE_NUMBER_ID || !this.env.WHATSAPP_ACCESS_TOKEN) {
      return {
        success: false,
        deepLinkUrl,
        error: 'Meta WhatsApp credentials (WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN) not configured',
      };
    }

    const endpoint = `https://graph.facebook.com/${this.env.WHATSAPP_API_VERSION}/${this.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.env.WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: req.toPhoneE164.replace(/^\+/, ''),
        type: 'template',
        template: {
          name: 'order_custom_instruction_bn',
          language: { code: 'bn' },
          components: [
            {
              type: 'body',
              parameters: [
                { type: 'text', text: req.customerName },
                { type: 'text', text: req.externalOrderId },
              ],
            },
          ],
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      return { success: false, deepLinkUrl, error: `Meta WhatsApp API error (${res.status}): ${body}` };
    }
    const json = (await res.json()) as { messages?: { id: string }[] };
    return {
      success: true,
      providerMessageId: json.messages?.[0]?.id,
      deepLinkUrl,
    };
  }
}

/**
 * Factory Function: createWhatsAppAdapter
 * - CALLED BY: `createAppContainer` in `src/app.ts` at startup.
 * - PURPOSE: Selects `MetaCloudWhatsAppAdapter` in production or `SimulatorWhatsAppAdapter` in local dev/testing.
 */
export function createWhatsAppAdapter(env: AppEnv): WhatsAppAdapter {
  if (env.WHATSAPP_PROVIDER === 'meta_cloud' && env.NODE_ENV !== 'test') {
    return new MetaCloudWhatsAppAdapter(env);
  }
  return new SimulatorWhatsAppAdapter();
}
