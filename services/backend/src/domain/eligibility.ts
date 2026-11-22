import { Order, Tenant, VoiceSettings } from './types';

export const NON_CANCELLABLE_ORDER_STATUSES = new Set([
  'packed',
  'shipped',
  'in_transit',
  'delivered',
  'fulfilled',
  'completed',
]);

export const TERMINAL_ORDER_STATUSES = new Set([
  'cancelled',
  'refunded',
  'fulfilled',
  'delivered',
  'completed',
]);

export interface EligibilityResult {
  eligible: boolean;
  reason?: string;
  suppressedOptOut?: boolean;
  deferUntilUtc?: string;
}

/**
 * Helper: Converts an `"HH:MM"` string (like `"09:00"` or `"21:00"`) into minutes since midnight (`540` or `1260`).
 * - CALLED BY: `isWithinCallingWindow`.
 */
function parseHhMm(hhmm: string): number {
  const [hStr, mStr] = hhmm.split(':');
  const h = Number(hStr);
  const m = Number(mStr);
  if (Number.isNaN(h) || Number.isNaN(m)) return 0;
  return h * 60 + m;
}

export function getMinutesInTimezone(date: Date, timeZone: string): number {
  /**
   * FUNCTION DESCRIPTION: getMinutesInTimezone
   * - CALLED BY: `isWithinCallingWindow`.
   * - INPUT SOURCE: `date` (current UTC `Date`) and `timeZone` (e.g., `'Asia/Dhaka'` from the `Tenant` record).
   * - PURPOSE: Converts a UTC timestamp into local minutes-since-midnight in the merchant's timezone (`Asia/Dhaka`) so calling window checks work accurately regardless of the server's OS timezone.
   */
  try {
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const parts = formatter.formatToParts(date);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
    return hour * 60 + minute;
  } catch {
    return date.getUTCHours() * 60 + date.getUTCMinutes();
  }
}

export function isWithinCallingWindow(
  now: Date,
  timeZone: string,
  windowStart: string,
  windowEnd: string
): { within: boolean; nextWindowUtc?: string } {
  /**
   * FUNCTION DESCRIPTION: isWithinCallingWindow
   * - CALLED BY: `evaluateOrderEligibility` (in this file) and `DtmfCallbackService.handleUnansweredOrFailed` (when scheduling no-answer retries).
   * - INPUT SOURCE: `now` (`Date`), `timeZone` (`'Asia/Dhaka'`), `windowStart` (`'09:00'`), and `windowEnd` (`'21:00'`).
   * - PURPOSE: Checks if the current local time in Bangladesh is inside the allowed calling hours. If outside (e.g., 11:30 PM), calculates the exact UTC timestamp (`nextWindowUtc`) when the window next opens (09:00 AM the next day).
   */
  const nowMin = getMinutesInTimezone(now, timeZone);
  const startMin = parseHhMm(windowStart);
  const endMin = parseHhMm(windowEnd);

  if (startMin === endMin) {
    return { within: true };
  }
  if (startMin < endMin) {
    if (nowMin >= startMin && nowMin < endMin) {
      return { within: true };
    }
    const deltaMin = nowMin < startMin ? startMin - nowMin : 24 * 60 - nowMin + startMin;
    return {
      within: false,
      nextWindowUtc: new Date(now.getTime() + deltaMin * 60_000).toISOString(),
    };
  }
  // Overnight window (e.g., 20:00 -> 08:00)
  if (nowMin >= startMin || nowMin < endMin) {
    return { within: true };
  }
  const deltaMin = startMin - nowMin;
  return {
    within: false,
    nextWindowUtc: new Date(now.getTime() + deltaMin * 60_000).toISOString(),
  };
}

export function evaluateOrderEligibility(params: {
  tenant: Tenant;
  settings: VoiceSettings;
  order: Order;
  isOptedOut: boolean;
  hasActiveCallJob: boolean;
  now?: Date;
  bypassCallingWindow?: boolean;
}): EligibilityResult {
  /**
   * FUNCTION DESCRIPTION: evaluateOrderEligibility
   * - CALLED BY: `OrderIntakeService.handleOrderWebhook` (when an order arrives) and `voiceAndOrderRoutes.ts` (`POST /api/voice/orders/:id/retry` and `GET /api/internal/orders/:id`).
   * - INPUT SOURCE: Loaded `Tenant`, `VoiceSettings`, `Order`, `isOptedOut` (from `repo.isPhoneOptedOut`), and `hasActiveCallJob` (from `repo.hasActiveCallJob`).
   * - PURPOSE: Runs an 8-point safety check before allowing an outbound phone call:
   *   1. Is the tenant active?
   *   2. Is voice verification enabled for this tenant?
   *   3. Does the order have a valid E.164 phone number?
   *   4. Did the customer grant call consent?
   *   5. Is the customer's phone number on the Opt-Out / Do-Not-Call list?
   *   6. Is the order already in a terminal state (`cancelled`, `delivered`, etc.)?
   *   7. Is the order status in `settings.eligibleStatuses` (`pending`, `unverified`, etc.)?
   *   8. Is there already an active call job for this order, or is it outside the 09:00-21:00 calling window?
   */
  const { tenant, settings, order, isOptedOut, hasActiveCallJob, bypassCallingWindow } = params;
  const now = params.now ?? new Date();

  if (tenant.status !== 'active') {
    return { eligible: false, reason: 'tenant_inactive' };
  }
  if (!settings.enabled) {
    return { eligible: false, reason: 'voice_verification_disabled' };
  }
  if (!order.phoneE164) {
    return { eligible: false, reason: 'invalid_or_missing_phone' };
  }
  if (!order.consentGranted) {
    return { eligible: false, reason: 'missing_customer_consent' };
  }
  if (isOptedOut) {
    return { eligible: false, reason: 'customer_opted_out', suppressedOptOut: true };
  }
  if (TERMINAL_ORDER_STATUSES.has(order.orderStatus.toLowerCase())) {
    return { eligible: false, reason: `order_already_${order.orderStatus.toLowerCase()}` };
  }
  const eligibleSet = new Set(settings.eligibleStatuses.map((s) => s.toLowerCase()));
  if (eligibleSet.size > 0 && !eligibleSet.has(order.orderStatus.toLowerCase())) {
    return { eligible: false, reason: `order_status_not_eligible:${order.orderStatus}` };
  }
  if (hasActiveCallJob) {
    return { eligible: false, reason: 'duplicate_active_call_job' };
  }

  if (!bypassCallingWindow) {
    const win = isWithinCallingWindow(
      now,
      tenant.timezone,
      settings.callWindowStart,
      settings.callWindowEnd
    );
    if (!win.within) {
      return {
        eligible: true,
        reason: 'deferred_outside_calling_window',
        deferUntilUtc: win.nextWindowUtc,
      };
    }
  }

  return { eligible: true };
}

export function canExecuteStoreCancellation(orderStatus: string): boolean {
  /**
   * FUNCTION DESCRIPTION: canExecuteStoreCancellation
   * - CALLED BY: `evaluateDtmfTransition` in `src/domain/dtmfMachine.ts` when the customer presses Key `2`.
   * - INPUT SOURCE: `order.orderStatus` (e.g., `'pending'` vs `'shipped'`).
   * - PURPOSE: Returns `false` if the order is already `'packed'`, `'shipped'`, `'delivered'`, etc., preventing automated cancellation of orders that have already left the warehouse.
   */
  return !NON_CANCELLABLE_ORDER_STATUSES.has(orderStatus.toLowerCase());
}

export function isOrderStaleForConfirmation(orderStatus: string): boolean {
  /**
   * FUNCTION DESCRIPTION: isOrderStaleForConfirmation
   * - CALLED BY: `VoiceCallService.processQueuedCallJob` (before dialing) and `evaluateDtmfTransition` (during the call).
   * - INPUT SOURCE: `order.orderStatus`.
   * - PURPOSE: Returns `true` if the order is already `'cancelled'`, `'refunded'`, `'fulfilled'`, or `'delivered'`.
   */
  return TERMINAL_ORDER_STATUSES.has(orderStatus.toLowerCase());
}
