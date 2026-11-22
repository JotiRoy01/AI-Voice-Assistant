import { BANGLA_PROMPTS } from './banglaPrompt';
import { canExecuteStoreCancellation, isOrderStaleForConfirmation } from './eligibility';
import { DtmfResult, Order, VerificationStatus, VoiceCall, VoiceSettings } from './types';

export type DtmfInput = '1' | '2' | '3' | 'no_input' | string;

export interface DtmfTransitionDecision {
  action:
    | 'confirm_order'
    | 'cancel_order_permitted'
    | 'cancel_request_only'
    | 'trigger_whatsapp'
    | 'replay_menu'
    | 'end_no_response'
    | 'end_invalid_input'
    | 'reject_stale_order';
  dtmfResult: DtmfResult;
  nextVerificationStatus?: VerificationStatus;
  endCall: boolean;
  nextReplayCount: number;
  nextInvalidAttempts: number;
  spokenPrompt: string;
  eventType: string;
  reason?: string;
}

export function evaluateDtmfTransition(params: {
  digit: DtmfInput;
  order: Order;
  call: VoiceCall;
  settings: VoiceSettings;
}): DtmfTransitionDecision {
  /**
   * ============================================================================
   * FUNCTION DESCRIPTION: evaluateDtmfTransition (Pure DTMF State Machine)
   * - CALLED BY: `DtmfCallbackService.handleTelephonyEvent` (in `src/services/dtmfCallbackService.ts`).
   * - INPUT SOURCE:
   *   • `digit`: The keypad button pressed by the customer (`'1'`, `'2'`, `'3'`, `'no_input'`, or any other key like `'9'`).
   *   • `order`: The fresh `Order` record from the database.
   *   • `call`: The active `VoiceCall` record (tracks `replayCount` and `invalidAttempts`).
   *   • `settings`: The tenant's `VoiceSettings` (defines `menuReplayLimit` and `invalidKeyLimit`).
   * - PURPOSE: Decides the exact business action, next verification status, whether to hang up (`endCall`), and which Bangla voice response (`spokenPrompt`) to play back to the customer.
   * ============================================================================
   */
  const { digit, order, call, settings } = params;
  const trimmed = digit.trim();

  // Guard 1: Check if the order was already cancelled/fulfilled while the phone call was happening
  if (isOrderStaleForConfirmation(order.orderStatus)) {
    return {
      action: 'reject_stale_order',
      dtmfResult: call.dtmfResult,
      endCall: true,
      nextReplayCount: call.replayCount,
      nextInvalidAttempts: call.invalidAttempts,
      spokenPrompt: BANGLA_PROMPTS.key2CancelBlocked,
      eventType: 'dtmf_rejected_stale_order',
      reason: `Order is already in terminal state: ${order.orderStatus}`,
    };
  }

  // Case 1: Customer pressed Key 1 -> Confirm Order
  if (trimmed === '1') {
    return {
      action: 'confirm_order',
      dtmfResult: '1_confirm',
      nextVerificationStatus: 'confirmed',
      endCall: true,
      nextReplayCount: call.replayCount,
      nextInvalidAttempts: call.invalidAttempts,
      spokenPrompt: BANGLA_PROMPTS.key1Confirmed,
      eventType: 'dtmf_confirm_received',
    };
  }

  // Case 2: Customer pressed Key 2 -> Request Order Cancellation
  if (trimmed === '2') {
    // Developer Note: Only auto-cancel if the order hasn't been packed/shipped yet (`canExecuteStoreCancellation`).
    if (canExecuteStoreCancellation(order.orderStatus)) {
      return {
        action: 'cancel_order_permitted',
        dtmfResult: '2_cancel',
        nextVerificationStatus: 'cancelled',
        endCall: true,
        nextReplayCount: call.replayCount,
        nextInvalidAttempts: call.invalidAttempts,
        spokenPrompt: BANGLA_PROMPTS.key2CancelRequested,
        eventType: 'dtmf_cancel_executed',
      };
    }
    // If already packed or shipped, record `cancellation_requested` for a human operator without breaking fulfillment.
    return {
      action: 'cancel_request_only',
      dtmfResult: '2_cancel',
      nextVerificationStatus: 'cancellation_requested',
      endCall: true,
      nextReplayCount: call.replayCount,
      nextInvalidAttempts: call.invalidAttempts,
      spokenPrompt: BANGLA_PROMPTS.key2CancelBlocked,
      eventType: 'dtmf_cancel_request_blocked_by_fulfillment',
      reason: `Order status '${order.orderStatus}' does not allow automated cancellation`,
    };
  }

  // Case 3: Customer pressed Key 3 -> Send WhatsApp Deep-Link for Special Instructions
  if (trimmed === '3') {
    return {
      action: 'trigger_whatsapp',
      dtmfResult: '3_whatsapp',
      nextVerificationStatus: 'whatsapp_requested',
      endCall: true,
      nextReplayCount: call.replayCount,
      nextInvalidAttempts: call.invalidAttempts,
      spokenPrompt: BANGLA_PROMPTS.key3WhatsApp,
      eventType: 'dtmf_whatsapp_requested',
    };
  }

  // Case 4: Customer did not press any key before timeout ('no_input')
  if (trimmed === '' || trimmed === 'no_input' || trimmed === 'timeout') {
    const nextReplay = call.replayCount + 1;
    if (nextReplay <= settings.menuReplayLimit) {
      return {
        action: 'replay_menu',
        dtmfResult: 'no_input',
        endCall: false,
        nextReplayCount: nextReplay,
        nextInvalidAttempts: call.invalidAttempts,
        spokenPrompt: `${BANGLA_PROMPTS.noInputReplay} ${BANGLA_PROMPTS.menu}`,
        eventType: 'dtmf_no_input_replay',
      };
    }
    return {
      action: 'end_no_response',
      dtmfResult: 'no_input',
      nextVerificationStatus: 'no_response',
      endCall: true,
      nextReplayCount: nextReplay,
      nextInvalidAttempts: call.invalidAttempts,
      spokenPrompt: BANGLA_PROMPTS.goodbyeNoResponse,
      eventType: 'dtmf_no_response_timeout',
    };
  }

  // Case 5: Customer pressed an invalid keypad button (e.g. 4, 9, *, #)
  const nextInvalid = call.invalidAttempts + 1;
  if (nextInvalid < settings.invalidKeyLimit) {
    return {
      action: 'replay_menu',
      dtmfResult: 'invalid_key',
      endCall: false,
      nextReplayCount: call.replayCount,
      nextInvalidAttempts: nextInvalid,
      spokenPrompt: `${BANGLA_PROMPTS.invalidKeyReplay} ${BANGLA_PROMPTS.menu}`,
      eventType: 'dtmf_invalid_key_replay',
      reason: `Invalid digit pressed: ${trimmed}`,
    };
  }

  return {
    action: 'end_invalid_input',
    dtmfResult: 'invalid_key',
    nextVerificationStatus: 'invalid_input',
    endCall: true,
    nextReplayCount: call.replayCount,
    nextInvalidAttempts: nextInvalid,
    spokenPrompt: BANGLA_PROMPTS.goodbyeNoResponse,
    eventType: 'dtmf_invalid_key_limit_reached',
    reason: `Invalid key limit (${settings.invalidKeyLimit}) reached with digit: ${trimmed}`,
  };
}
