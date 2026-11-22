import crypto from 'crypto';
import { AppEnv } from '../../config/env';
import { OutboundCallRequest, OutboundCallResult, TelephonyAdapter } from '../interfaces';

export class SimulatorTelephonyAdapter implements TelephonyAdapter {
  /**
   * ============================================================================
   * CLASS DESCRIPTION: SimulatorTelephonyAdapter
   * - MEANING: A zero-cost, local virtual phone adapter that simulates placing an outbound call without dialing a real telecom carrier.
   * - WHY WE USE IT: Lets developers, automated tests, and the Dashboard Live Simulator Test Bench test the entire voice confirmation & DTMF 1/2/3 workflow offline for free.
   * - WHERE IT IS USED: Instantiated by `createTelephonyAdapter(env)` in `src/app.ts` when `TELEPHONY_PROVIDER=simulator` (or during automated tests) and injected into `VoiceCallService`.
   * ============================================================================
   */
  readonly name = 'simulator';

  async initiateCall(req: OutboundCallRequest): Promise<OutboundCallResult> {
    /**
     * METHOD DESCRIPTION: initiateCall (Simulator)
     * - CALLED BY: `VoiceCallService.executeOutboundCall` (in `src/services/voiceCallService.ts`).
     * - INPUT SOURCE: `req` (`OutboundCallRequest`) is built by `VoiceCallService` using the order's phone number, generated Bangla prompt text, TTS audio URL, and webhook callback URL.
     * - PURPOSE: Immediately returns a deterministic `providerCallId` (e.g. `sim-1234abcd-...`) with status `'ringing'` so the dashboard simulator or test suite can send virtual keypad presses (`1`, `2`, `3`) for that call ID.
     */
    return {
      providerCallId: `sim-${req.callId.slice(0, 8)}-${crypto.randomBytes(4).toString('hex')}`,
      status: 'ringing',
      provider: this.name,
    };
  }
}

export class AsteriskAriAdapter implements TelephonyAdapter {
  /**
   * ============================================================================
   * CLASS DESCRIPTION: AsteriskAriAdapter
   * - MEANING: Production telephony adapter that connects to an Asterisk PBX server via the Asterisk REST Interface (ARI) to place real SIP/IPTSP phone calls.
   * - WHY WE USE IT: In production, FlowMind dials Bangladeshi customer mobile numbers (`+8801...`) through a licensed SIP trunk and runs the `[flowmind-ivr]` dialplan in Asterisk to play the Bangla TTS audio and capture keypad digits.
   * - WHERE IT IS USED: Instantiated by `createTelephonyAdapter(env)` when `TELEPHONY_PROVIDER=asterisk_ari` and called by `VoiceCallService.executeOutboundCall`.
   * ============================================================================
   */
  readonly name = 'asterisk_ari';

  constructor(private readonly env: AppEnv) {}

  async initiateCall(req: OutboundCallRequest): Promise<OutboundCallResult> {
    /**
     * METHOD DESCRIPTION: initiateCall (Asterisk ARI)
     * - CALLED BY: `VoiceCallService.executeOutboundCall` (in `src/services/voiceCallService.ts`).
     * - INPUT SOURCE: `req` comes from `VoiceCallService` containing `callId`, `toPhoneE164`, `audioUrl`, `callbackUrl`, and retry limits; SIP trunk credentials come from `this.env`.
     * - PURPOSE: Sends an authenticated HTTP `POST /ari/channels` request to Asterisk to originate an outbound PJSIP call and passes channel variables (`FLOWMIND_AUDIO_URL`, `FLOWMIND_CALLBACK_URL`, etc.) into the Asterisk dialplan.
     */
    const channelId = `fm-${req.callId}`;
    const endpoint = `PJSIP/${req.toPhoneE164.replace(/^\+/, '')}@${this.env.ASTERISK_SIP_TRUNK}`;
    const authHeader =
      'Basic ' +
      Buffer.from(`${this.env.ASTERISK_ARI_USER}:${this.env.ASTERISK_ARI_PASSWORD}`).toString('base64');

    const url = `${this.env.ASTERISK_ARI_URL.replace(/\/$/, '')}/channels`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        endpoint,
        channelId,
        context: 'flowmind-ivr',
        extension: 's',
        priority: 1,
        callerId: this.env.ASTERISK_CALLER_ID,
        timeout: 35,
        variables: {
          FLOWMIND_CALL_ID: req.callId,
          FLOWMIND_TENANT_ID: req.tenantId,
          FLOWMIND_ORDER_ID: req.orderId,
          FLOWMIND_AUDIO_URL: req.audioUrl,
          FLOWMIND_CALLBACK_URL: req.callbackUrl,
          FLOWMIND_REPLAY_LIMIT: String(req.menuReplayLimit),
          FLOWMIND_INVALID_LIMIT: String(req.invalidKeyLimit),
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Asterisk ARI originate failed (${response.status}): ${errText}`);
    }

    const data = (await response.json()) as { id?: string };
    return {
      providerCallId: data.id || channelId,
      status: 'initiated',
      provider: this.name,
    };
  }
}

export class TwilioTelephonyAdapter implements TelephonyAdapter {
  /**
   * ============================================================================
   * CLASS DESCRIPTION: TwilioTelephonyAdapter
   * - MEANING: Cloud telephony adapter that calls real mobile phone numbers (`+8801...`) via Twilio Programmable Voice REST API.
   * - WHY WE USE IT: Lets you dial your real mobile phone number immediately using a free Twilio account without waiting for a physical Bangladeshi SIP trunk or running Asterisk. Supports both conversational Bangla speech (`<Gather input="speech dtmf" language="bn-BD">`) and keypad 1/2/3!
   * - WHERE IT IS USED: Instantiated by `createTelephonyAdapter(env)` when `TELEPHONY_PROVIDER=twilio` or called directly by the Live Voice AI Phone Dialer (`/api/conversation/dial-phone`).
   * ============================================================================
   */
  readonly name = 'twilio';

  constructor(private readonly env: AppEnv) {}

  async initiateCall(
    req: OutboundCallRequest & {
      twilioOverrides?: {
        accountSid?: string;
        authToken?: string;
        fromNumber?: string;
        twimlUrl?: string;
      };
    }
  ): Promise<OutboundCallResult> {
    /**
     * METHOD DESCRIPTION: initiateCall (Twilio Programmable Voice)
     * - CALLED BY: `VoiceCallService.executeOutboundCall` or `conversationRoutes.ts` (`POST /api/conversation/dial-phone`).
     * - INPUT SOURCE: `req.toPhoneE164` (your mobile phone number e.g. `+8801...`) and Twilio credentials from `.env` or the Dashboard Dialer UI.
     * - PURPOSE: Calls `POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Calls.json` to ring the customer's real mobile phone and connect the call to our Bangla AI Voice TwiML webhook.
     */
    const accountSid = req.twilioOverrides?.accountSid || this.env.TWILIO_ACCOUNT_SID;
    const authToken = req.twilioOverrides?.authToken || this.env.TWILIO_AUTH_TOKEN;
    const fromNumber = req.twilioOverrides?.fromNumber || this.env.TWILIO_FROM_NUMBER;

    if (!accountSid || !authToken || !fromNumber) {
      throw new Error(
        'Twilio credentials (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER) are required to dial a real phone number.'
      );
    }

    const baseUrl = this.env.PUBLIC_CALLBACK_BASE_URL.replace(/\/$/, '');
    const twimlUrl =
      req.twilioOverrides?.twimlUrl ||
      `${baseUrl}/api/conversation/twilio/voice?callId=${encodeURIComponent(req.callId)}&orderId=${encodeURIComponent(req.orderId)}&tenantId=${encodeURIComponent(req.tenantId)}`;

    const authHeader = 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    const form = new URLSearchParams();
    form.set('To', req.toPhoneE164);
    form.set('From', fromNumber);
    form.set('Url', twimlUrl);
    form.set('Method', 'POST');

    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Calls.json`,
      {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Twilio outbound call failed (${response.status}): ${errText}`);
    }

    const data = (await response.json()) as { sid?: string };
    return {
      providerCallId: data.sid || `tw-${req.callId}`,
      status: 'initiated',
      provider: this.name,
    };
  }
}

export function createTelephonyAdapter(env: AppEnv): TelephonyAdapter {
  if (env.NODE_ENV !== 'test') {
    if (env.TELEPHONY_PROVIDER === 'asterisk_ari') {
      return new AsteriskAriAdapter(env);
    }
    if (env.TELEPHONY_PROVIDER === 'twilio') {
      return new TwilioTelephonyAdapter(env);
    }
  }
  return new SimulatorTelephonyAdapter();
}
