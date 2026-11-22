import { Order } from './types';

const BENGALI_DIGITS = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];

export function toBengaliDigits(value: string | number): string {
  /**
   * FUNCTION DESCRIPTION: toBengaliDigits
   * - CALLED BY: `formatBengaliAmount` and `buildOrderVerificationPrompt` in this file.
   * - INPUT SOURCE: Any English number or string containing digits (e.g., `1500` or `"XL"`).
   * - PURPOSE: Replaces ASCII digits `0-9` with Bengali Unicode digits `০-৯` so the Bangla TTS engine pronounces numbers naturally in Bangla.
   */
  return String(value).replace(/\d/g, (d) => BENGALI_DIGITS[Number(d)]);
}

export function formatBengaliAmount(amount: number): string {
  /**
   * FUNCTION DESCRIPTION: formatBengaliAmount
   * - CALLED BY: `buildOrderVerificationPrompt`.
   * - INPUT SOURCE: `order.totalAmount` from the `Order` record (e.g., `1500` or `125000`).
   * - PURPOSE: Formats a number using South Asian / Bangladeshi comma grouping (lakh/thousand grouping: `1,25,000`) and converts the digits to Bangla (`১,২৫,০০০`).
   */
  const rounded = Number.isInteger(amount) ? amount.toFixed(0) : amount.toFixed(2);
  const [intPart, decPart] = rounded.split('.');
  // Developer Note: Bangladeshi/South Asian comma grouping places a comma before the last 3 digits, then every 2 digits.
  const lastThree = intPart.slice(-3);
  const otherNumbers = intPart.slice(0, -3);
  const formattedInt =
    otherNumbers.length > 0
      ? otherNumbers.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + lastThree
      : lastThree;
  const combined = decPart ? `${formattedInt}.${decPart}` : formattedInt;
  return toBengaliDigits(combined);
}

export function currencyToBangla(currency: string): string {
  /**
   * FUNCTION DESCRIPTION: currencyToBangla
   * - CALLED BY: `buildOrderVerificationPrompt`.
   * - INPUT SOURCE: `order.currency` (e.g., `'BDT'`, `'TK'`, `'USD'`).
   * - PURPOSE: Translates currency codes into spoken Bangla words (`'BDT'` -> `'টাকায়'`, `'USD'` -> `'ডলারে'`).
   */
  const normalized = currency.trim().toUpperCase();
  if (normalized === 'BDT' || normalized === 'TAKA' || normalized === 'TK') {
    return 'টাকায়';
  }
  if (normalized === 'USD') return 'ডলারে';
  return `${normalized} মূল্যে`;
}

/**
 * Constant: BANGLA_PROMPTS
 * - MEANING: Authoritative dictionary of fixed Bangla IVR menu and response phrases (SRS Section 3.1 & Appendix A).
 * - USED BY: `buildOrderVerificationPrompt` (for initial call greeting) and `evaluateDtmfTransition` in `dtmfMachine.ts` (for keypad response audio).
 */
export const BANGLA_PROMPTS = {
  menu: 'অর্ডারটি নিশ্চিত করতে ১ চাপুন। অর্ডারটি বাতিলের অনুরোধ জানাতে ২ চাপুন। অন্য কোনো বিশেষ নির্দেশনা থাকলে ৩ চাপুন।',
  key1Confirmed: 'ধন্যবাদ। আপনার অর্ডার নিশ্চিত করার অনুরোধ গ্রহণ করা হয়েছে।',
  key2CancelRequested: 'আপনার অর্ডার বাতিলের অনুরোধ গ্রহণ করা হয়েছে।',
  key2CancelBlocked:
    'দুঃখিত, আপনার অর্ডারটি ইতিমধ্যে প্রসেস বা ডেলিভারির পর্যায়ে রয়েছে। আমাদের প্রতিনিধি আপনার সাথে যোগাযোগ করবেন।',
  key3WhatsApp:
    'আপনার বিশেষ নির্দেশনা জানাতে অনুগ্রহ করে আমাদের WhatsApp-এ যোগাযোগ করুন। আপনার নম্বরে WhatsApp যোগাযোগের লিংক পাঠানো হবে।',
  noInputReplay: 'আপনার কোনো উত্তর পাওয়া যায়নি। আবার শুনতে লাইনে থাকুন।',
  invalidKeyReplay: 'দুঃখিত, আপনি ভুল বোতাম চেপেছেন। অনুগ্রহ করে আবার চেষ্টা করুন।',
  goodbyeNoResponse: 'কোনো উত্তর না পাওয়ায় কলটি বিচ্ছিন্ন করা হচ্ছে। ধন্যবাদ।',
} as const;

export function buildOrderVerificationPrompt(order: Order): {
  opening: string;
  menu: string;
  fullScript: string;
} {
  /**
   * FUNCTION DESCRIPTION: buildOrderVerificationPrompt
   * - CALLED BY: `VoiceCallService.executeOutboundCall` (before calling TTS) and `voiceAndOrderRoutes.ts` (`GET /api/orders/:id/voice-history` and `GET /api/internal/orders/:id`).
   * - INPUT SOURCE: `order` (`Order` object loaded from the database containing `items`, `totalAmount`, and `currency`).
   * - PURPOSE: Dynamically composes the complete Bangla voice script strictly from the normalized order items (including colour, product name, variant, size, quantity, additional item count, and total Taka amount) followed by the 1/2/3 keypad menu.
   */
  const primary = order.items[0];
  let itemDescription = 'একটি পণ্য';

  if (primary) {
    const parts: string[] = [];
    if (primary.colour) {
      parts.push(`${primary.colour} রঙের ${primary.productName}`);
    } else {
      parts.push(primary.productName);
    }
    if (primary.variant) {
      parts.push(primary.variant);
    }
    if (primary.size) {
      parts.push(`${toBengaliDigits(primary.size)} সাইজ`);
    }
    if (primary.quantity > 1) {
      parts.push(`${toBengaliDigits(primary.quantity)}টি`);
    }
    itemDescription = parts.join(', ');
    // Developer Note: If the customer ordered multiple different products, summarize the first item and say "এবং আরও Xটি পণ্য".
    if (order.items.length > 1) {
      const extraCount = order.items.length - 1;
      itemDescription += ` এবং আরও ${toBengaliDigits(extraCount)}টি পণ্য`;
    }
  }

  const amountText = formatBengaliAmount(order.totalAmount);
  const currencyText = currencyToBangla(order.currency);

  const opening = `আসসালামু আলাইকুম। আপনি কি আমাদের কাছ থেকে ${itemDescription}, মোট ${amountText} ${currencyText} অর্ডার করেছেন?`;
  const menu = BANGLA_PROMPTS.menu;
  return {
    opening,
    menu,
    fullScript: `${opening} ${menu}`,
  };
}
