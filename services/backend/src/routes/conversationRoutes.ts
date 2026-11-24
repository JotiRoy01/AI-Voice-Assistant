import express, { Router } from 'express';
import { AppEnv } from '../config/env';
import { requireAuth, resolveScopedTenantId } from '../security/auth';
import { ConversationalAgentService } from '../services/conversationalAgentService';
import {
  ATTRIBUTE_BANGLA_LABELS,
  ProductCatalogRagService,
} from '../services/productCatalogRagService';
import { DEMO_TENANT_A_ID } from '../db/seedData';

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function createConversationRouter(deps: {
  conversationalAgentService: ConversationalAgentService;
  catalogRagService?: ProductCatalogRagService;
  env: AppEnv;
}): Router {
  /**
   * ============================================================================
   * ROUTER FACTORY DESCRIPTION: createConversationRouter (`/api/conversation`)
   * - MEANING: Provides both the Browser Live Microphone Voice Conversation endpoints AND the Twilio Real Phone Call TwiML Voice Webhooks (`<Gather input="speech dtmf" language="bn-BD">`).
   * - WHY WE USE IT: Lets you talk directly with the Bangla AI Voice Assistant in two ways:
   *   1. Directly from the browser microphone (`/start`, `/turn`, `/session/:id`).
   *   2. By dialing your actual mobile phone number (`/dial-phone`, `/twilio/voice`, `/twilio/gather`).
   * - WHERE IT IS USED: Mounted at `/api/conversation` in `src/app.ts`.
   * ============================================================================
   */
  const router = Router();
  const { conversationalAgentService, env } = deps;
  const catalogRagService = deps.catalogRagService || new ProductCatalogRagService(env);

  // Support Twilio's application/x-www-form-urlencoded webhook payloads
  router.use(express.urlencoded({ extended: false }));

  // ==========================================================================
  // PHASE 2: MULTI-CATEGORY PRODUCT CATALOG & CSV RAG INGESTION ENDPOINTS
  // ==========================================================================
  router.get('/catalog', requireAuth(env), (req, res) => {
    const tenantId = resolveScopedTenantId(req) || DEMO_TENANT_A_ID;
    if (tenantId === '__FORBIDDEN__') {
      res.status(403).json({ error: 'Cross-tenant access denied' });
      return;
    }
    const products = catalogRagService.listCatalog(tenantId);
    res.json({
      tenantId,
      count: products.length,
      attributeLabels: ATTRIBUTE_BANGLA_LABELS,
      products,
    });
  });

  router.get('/catalog/sample-csv', requireAuth(env), (_req, res) => {
    const csv = catalogRagService.getSampleCsvContent();
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="bd_multi_category_products.csv"');
    res.send(csv);
  });

  router.post('/catalog/ingest-csv', requireAuth(env), (req, res) => {
    const tenantId = resolveScopedTenantId(req) || DEMO_TENANT_A_ID;
    if (tenantId === '__FORBIDDEN__') {
      res.status(403).json({ error: 'Cross-tenant access denied' });
      return;
    }
    const csvContent = String(req.body?.csvContent || '').trim();
    const replaceExisting = Boolean(req.body?.replaceExisting);
    if (!csvContent) {
      res.status(400).json({ error: 'csvContent is required' });
      return;
    }
    const products = catalogRagService.ingestCsvForTenant(tenantId, csvContent, replaceExisting);
    // Sync uploaded CSV to the Python Real-Time AI Agent (:8001) asynchronously
    const pyUrl = (process.env.PYTHON_AI_AGENT_URL || 'http://127.0.0.1:8001').replace(/\/$/, '');
    fetch(`${pyUrl}/api/v1/knowledge/ingest-csv`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenant_id: tenantId,
        csv_content: csvContent,
        replace_existing: replaceExisting,
      }),
      signal: AbortSignal.timeout(3000),
    }).catch(() => {});

    res.status(201).json({
      tenantId,
      ingestedCount: products.length,
      attributeLabels: ATTRIBUTE_BANGLA_LABELS,
      products,
    });
  });

  router.post('/start', requireAuth(env), async (req, res, next) => {
    /**
     * ENDPOINT DESCRIPTION: POST /api/conversation/start
     * - CALLED BY: Next.js Dashboard ("Live AI Voice Call" page when you click the "Call" button).
     * - INPUT SOURCE: `req.body` containing `{ mode, orderId, customerPhone, customerName }`.
     * - PURPOSE: Starts a new Bangla conversational voice session, generates the AI's opening Bangla greeting + TTS audio, and returns the initial 10-node Neural Execution Map state.
     */
    try {
      const tenantId = resolveScopedTenantId(req) || DEMO_TENANT_A_ID;
      if (tenantId === '__FORBIDDEN__') {
        res.status(403).json({ error: 'Cross-tenant access denied' });
        return;
      }
      const mode =
        req.body?.mode === 'order_confirmation' ? 'order_confirmation' : 'new_order_agent';
      const session = await conversationalAgentService.startSession({
        tenantId,
        mode,
        orderId: req.body?.orderId,
        customerPhone: req.body?.customerPhone,
        customerName: req.body?.customerName,
        voiceName: req.body?.voiceName,
      });
      res.status(201).json({ session });
    } catch (err) {
      next(err);
    }
  });

  router.post('/turn', requireAuth(env), async (req, res, next) => {
    /**
     * ENDPOINT DESCRIPTION: POST /api/conversation/turn
     * - CALLED BY: Next.js Dashboard ("Live AI Voice Call" page whenever you finish speaking a sentence in Bangla into your microphone or click a quick speech prompt).
     * - INPUT SOURCE: `req.body` containing `{ sessionId, userText, dtmfDigit }`.
     * - PURPOSE: Processes your spoken Bangla utterance, updates the Neural Execution Map nodes & Live Event Trace signals, updates or creates the order in the database, and returns the AI's spoken Bangla reply + audio URL.
     */
    try {
      const { sessionId, userText, dtmfDigit, voiceName, geminiApiKey } = req.body as {
        sessionId: string;
        userText?: string;
        dtmfDigit?: string;
        voiceName?: string;
        geminiApiKey?: string;
      };
      if (!sessionId) {
        res.status(400).json({ error: 'sessionId is required' });
        return;
      }
      const session = await conversationalAgentService.processUserUtterance({
        sessionId,
        userText: userText || '',
        dtmfDigit,
        voiceName,
        geminiApiKey,
      });
      res.json({ session });
    } catch (err) {
      next(err);
    }
  });

  router.get('/session/:id', requireAuth(env), (req, res) => {
    /**
     * ENDPOINT DESCRIPTION: GET /api/conversation/session/:id
     * - CALLED BY: Next.js Dashboard to poll real-time transcript and Neural Execution Map updates while you are talking on a real Twilio mobile phone call!
     */
    const session = conversationalAgentService.getSession(String(req.params.id));
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json({ session });
  });

  router.post('/dial-phone', requireAuth(env), async (req, res, next) => {
    /**
     * ENDPOINT DESCRIPTION: POST /api/conversation/dial-phone
     * - CALLED BY: Next.js Dashboard ("Call My Real Mobile Phone" modal/panel).
     * - INPUT SOURCE: `req.body` containing `{ toPhone, mode, orderId, customerName, accountSid, authToken, fromNumber, publicBaseUrl }`.
     * - PURPOSE: Places a real outbound telephone call to your mobile phone (`+8801...`) via Twilio and links it to a live conversational session so you can talk on your phone while watching the Neural Execution Map update on your screen!
     */
    try {
      const tenantId = resolveScopedTenantId(req) || DEMO_TENANT_A_ID;
      if (tenantId === '__FORBIDDEN__') {
        res.status(403).json({ error: 'Cross-tenant access denied' });
        return;
      }
      const result = await conversationalAgentService.dialRealPhoneWithTwilio({
        tenantId,
        toPhone: String(req.body?.toPhone || ''),
        mode: req.body?.mode === 'order_confirmation' ? 'order_confirmation' : 'new_order_agent',
        orderId: req.body?.orderId,
        customerName: req.body?.customerName,
        accountSid: req.body?.accountSid,
        authToken: req.body?.authToken,
        fromNumber: req.body?.fromNumber,
        publicBaseUrl: req.body?.publicBaseUrl,
      });
      res.status(201).json(result);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to initiate real phone call',
      });
    }
  });

  // ==========================================================================
  // TWILIO REAL PHONE CALL TWIML WEBHOOKS (Bangla Speech + DTMF Gather)
  // ==========================================================================
  router.all('/twilio/voice', async (req, res) => {
    /**
     * ENDPOINT DESCRIPTION: POST/GET /api/conversation/twilio/voice
     * - CALLED BY: Twilio's servers as soon as you answer the phone call on your mobile phone.
     * - PURPOSE: Returns TwiML XML that plays the Bangla TTS audio (or speaks in Bangla) and opens `<Gather input="speech dtmf" language="bn-BD">` so Twilio listens to your voice in Bangla!
     */
    try {
      let sessionId = String(req.query.sessionId || '');
      let session = sessionId ? conversationalAgentService.getSession(sessionId) : undefined;

      if (!session) {
        const tenantId = String(req.query.tenantId || DEMO_TENANT_A_ID);
        const orderId = req.query.orderId ? String(req.query.orderId) : undefined;
        session = await conversationalAgentService.startSession({
          tenantId,
          mode: orderId ? 'order_confirmation' : 'new_order_agent',
          orderId,
        });
        sessionId = session.sessionId;
      }

      const lastAssistantMsg =
        [...session.messages].reverse().find((m) => m.role === 'assistant') || session.messages[0];
      const baseUrl = env.PUBLIC_CALLBACK_BASE_URL.replace(/\/$/, '');
      const gatherAction = `${baseUrl}/api/conversation/twilio/gather?sessionId=${encodeURIComponent(sessionId)}`;

      const promptXml =
        lastAssistantMsg?.audioUrl && lastAssistantMsg.audioUrl.startsWith('http') && !lastAssistantMsg.audioUrl.includes('localhost')
          ? `<Play>${escapeXml(lastAssistantMsg.audioUrl)}</Play>`
          : `<Say language="bn-IN">${escapeXml(lastAssistantMsg?.text || 'আসসালামু আলাইকুম')}</Say>`;

      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech dtmf" language="bn-BD" speechTimeout="auto" timeout="8" action="${escapeXml(gatherAction)}" method="POST">
    ${promptXml}
  </Gather>
  <Say language="bn-IN">আপনার কোনো উত্তর পাওয়া যায়নি। ধন্যবাদ।</Say>
</Response>`;

      res.type('text/xml').send(twiml);
    } catch (err) {
      res
        .type('text/xml')
        .send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>System error</Say></Response>`);
    }
  });

  router.post('/twilio/gather', async (req, res) => {
    /**
     * ENDPOINT DESCRIPTION: POST /api/conversation/twilio/gather
     * - CALLED BY: Twilio's servers every time you finish speaking a sentence in Bangla (or press a digit) on your mobile phone.
     * - INPUT SOURCE: `req.body.SpeechResult` (Twilio's Bangla speech-to-text transcription) or `req.body.Digits` (keypad digit).
     * - PURPOSE: Passes your spoken words to `conversationalAgentService.processUserUtterance(...)` and returns the next TwiML `<Gather>` so the two-way conversation continues until your order is confirmed!
     */
    try {
      const sessionId = String(req.query.sessionId || '');
      const speechResult = String(req.body?.SpeechResult || '').trim();
      const digits = String(req.body?.Digits || '').trim();

      const session = await conversationalAgentService.processUserUtterance({
        sessionId,
        userText: speechResult || digits,
        dtmfDigit: digits || undefined,
      });

      const lastAssistantMsg = [...session.messages].reverse().find((m) => m.role === 'assistant');
      const baseUrl = env.PUBLIC_CALLBACK_BASE_URL.replace(/\/$/, '');
      const gatherAction = `${baseUrl}/api/conversation/twilio/gather?sessionId=${encodeURIComponent(sessionId)}`;

      const promptXml =
        lastAssistantMsg?.audioUrl && lastAssistantMsg.audioUrl.startsWith('http') && !lastAssistantMsg.audioUrl.includes('localhost')
          ? `<Play>${escapeXml(lastAssistantMsg.audioUrl)}</Play>`
          : `<Say language="bn-IN">${escapeXml(lastAssistantMsg?.text || 'ধন্যবাদ')}</Say>`;

      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech dtmf" language="bn-BD" speechTimeout="auto" timeout="8" action="${escapeXml(gatherAction)}" method="POST">
    ${promptXml}
  </Gather>
  <Say language="bn-IN">ধন্যবাদ, ভালো থাকবেন। আসসালামু আলাইকুম।</Say>
</Response>`;

      res.type('text/xml').send(twiml);
    } catch {
      res
        .type('text/xml')
        .send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
    }
  });

  return router;
}
