export function normalizePhoneE164(raw: string | undefined | null): string | null {
  /**
   * FUNCTION DESCRIPTION: normalizePhoneE164 (Bangladesh-First Phone Normalizer)
   * - CALLED BY: `OrderIntakeService.handleOrderWebhook`, `WhatsAppService.handleInboundMessage`, and `dashboardAndSimulatorRoutes.ts` (`POST /api/dashboard/opt-outs`).
   * - INPUT SOURCE: `raw` phone string from a Shopify/WooCommerce checkout form or WhatsApp webhook (e.g., `"01712-345678"`, `"৮৮০১৭১২৩৪৫৬৭৮"`, `"+8801712345678"`).
   * - PURPOSE: Converts Bengali numerals (`০-৯`) to ASCII (`0-9`), strips spaces/dashes/brackets, and normalizes valid Bangladeshi mobile numbers (`013..019`) and international numbers into strict E.164 format (`+8801XXXXXXXXX`). Returns `null` if the phone number is invalid so the order is marked `ineligible`.
   */
  if (!raw) return null;
  // Step 1: Convert Bengali digits (০-৯) to English digits (0-9) if a customer typed their phone in Bangla
  const bnMap: Record<string, string> = {
    '০': '0', '১': '1', '২': '2', '৩': '3', '৪': '4',
    '৫': '5', '৬': '6', '৭': '7', '৮': '8', '৯': '9',
  };
  const ascii = raw.replace(/[০-৯]/g, (d) => bnMap[d] || d);
  const cleaned = ascii.replace(/[\s\-().]/g, '');

  // Step 2: Bangladesh local mobile format: 01XXXXXXXXX -> +8801XXXXXXXXX
  if (/^01[3-9]\d{8}$/.test(cleaned)) {
    return `+88${cleaned}`;
  }
  // Step 3: Bangladesh without leading plus: 8801XXXXXXXXX -> +8801XXXXXXXXX
  if (/^8801[3-9]\d{8}$/.test(cleaned)) {
    return `+${cleaned}`;
  }
  // Step 4: Standard international E.164: + followed by 8..15 digits
  if (/^\+[1-9]\d{7,14}$/.test(cleaned)) {
    return cleaned;
  }
  // Step 5: 00-prefixed international: 008801... -> +8801...
  if (/^00[1-9]\d{7,14}$/.test(cleaned)) {
    return `+${cleaned.slice(2)}`;
  }
  return null;
}

export function maskPhoneNumber(phoneE164: string): string {
  /**
   * FUNCTION DESCRIPTION: maskPhoneNumber (PII Privacy Masking)
   * - CALLED BY: `OrderIntakeService`, `VoiceCallService`, `WhatsAppService`, `voiceAndOrderRoutes.ts`, and `dashboardAndSimulatorRoutes.ts`.
   * - INPUT SOURCE: Normalized E.164 phone number (e.g., `"+8801712345678"`).
   * - PURPOSE: Masks the middle digits (`"+88017*****678"`) before writing to application logs, audit timelines, or non-privileged dashboard API responses (SRS Section 13 privacy requirement).
   */
  if (!phoneE164) return '***';
  const trimmed = phoneE164.trim();
  if (trimmed.length <= 7) {
    return `${trimmed.slice(0, 2)}***${trimmed.slice(-2)}`;
  }
  // e.g. +8801712345678 -> +88017*****678
  const prefix = trimmed.slice(0, 6);
  const suffix = trimmed.slice(-3);
  const maskedMiddle = '*'.repeat(Math.max(3, trimmed.length - 9));
  return `${prefix}${maskedMiddle}${suffix}`;
}
