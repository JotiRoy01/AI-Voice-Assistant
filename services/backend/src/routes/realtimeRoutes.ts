import crypto from 'crypto';
import { Router } from 'express';
import { StoreAdapter } from '../adapters/interfaces';
import { AppEnv } from '../config/env';
import { FlowMindRepository } from '../db/repository';
import { DEMO_TENANT_A_ID } from '../db/seedData';
import { StoreProvider } from '../domain/types';
import { requireAuth, requireInternalService, resolveScopedTenantId } from '../security/auth';
import { normalizePhoneE164 } from '../security/phone';
import { logger } from '../utils/logger';

function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/**
 * Generates a standard LiveKit-compatible HS256 room access JWT without requiring an external SDK.
 */
function createLiveKitRoomJwt(params: {
  apiKey: string;
  apiSecret: string;
  roomName: string;
  identity: string;
  metadata?: string;
}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64UrlEncode(
    JSON.stringify({
      iss: params.apiKey,
      sub: params.identity,
      nbf: now,
      exp: now + 3600,
      metadata: params.metadata,
      video: {
        roomJoin: true,
        room: params.roomName,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
      },
    })
  );
  const sig = base64UrlEncode(
    crypto.createHmac('sha256', params.apiSecret).update(`${header}.${payload}`).digest()
  );
  return `${header}.${payload}.${sig}`;
}

export function createRealtimeRouter(deps: {
  repo: FlowMindRepository;
  storeAdapters: Record<StoreProvider, StoreAdapter>;
  env: AppEnv;
}): Router {
  /**
   * ============================================================================
   * ROUTER FACTORY: createRealtimeRouter (`/api/realtime`)
   * - POST /api/realtime/token: Issues tenant-scoped real-time session context, WebSocket URL
   *   (`ws://127.0.0.1:8001/ws/realtime`), and optional LiveKit WebRTC room JWT.
   * - POST /api/realtime/commit-order: Internal endpoint called by `services/ai-agent/app/realtime/worker.py`
   *   when a customer confirms a voice order in real time -> persists via `storeAdapters.ts` -> DB!
   * ============================================================================
   */
  const router = Router();
  const { repo, storeAdapters, env } = deps;

  router.post('/token', requireAuth(env), async (req, res, next) => {
    try {
      const tenantId = resolveScopedTenantId(req) || DEMO_TENANT_A_ID;
      if (tenantId === '__FORBIDDEN__') {
        res.status(403).json({ error: 'Cross-tenant access denied' });
        return;
      }

      const orders = await repo.listOrders(tenantId, 20);
      const requestedOrderId = req.body?.orderId ? String(req.body.orderId) : undefined;
      const targetOrder = requestedOrderId
        ? (await repo.getOrderById(tenantId, requestedOrderId)) ?? orders[0]
        : orders[0];

      const phone =
        normalizePhoneE164(req.body?.customerPhone || targetOrder?.phoneE164 || '+8801540509558') ||
        '+8801540509558';
      const customerName = String(
        req.body?.customerName || targetOrder?.customerName || 'আব্দুল্লাহ আল মাহাদী'
      );

      // Strictly filter past orders to ONLY this customer
      const customerOrders = orders.filter(
        (o) =>
          (targetOrder && o.id === targetOrder.id) ||
          (o.phoneE164 && o.phoneE164 === phone) ||
          o.customerName.toLowerCase().trim() === customerName.toLowerCase().trim()
      );
      const uniquePastItems = Array.from(
        new Set(
          (customerOrders.length > 0 ? customerOrders : targetOrder ? [targetOrder] : []).flatMap(
            (o) =>
              o.items.map((i) => {
                const details = [i.colour, i.variant, i.size ? `সাইজ ${i.size}` : null]
                  .filter(Boolean)
                  .join(', ');
                return `${i.productName}${details ? ` (${details})` : ''}`;
              })
          )
        )
      );
      const previousOrdersSummary =
        uniquePastItems.length > 0 ? uniquePastItems.join(', ') : 'কোনো আগের অর্ডার নেই';

      const settings = await repo.getVoiceSettings(tenantId);
      const voiceName = String(
        req.body?.voiceName || settings?.voiceName || env.TTS_DEFAULT_VOICE || 'bn-BD-PradeepNeural'
      );

      const roomName = `flowmind-${tenantId}-${crypto.randomUUID().slice(0, 8)}`;
      const pythonHttpBase = (process.env.PYTHON_AI_AGENT_URL || 'http://127.0.0.1:8001').replace(
        /\/$/,
        ''
      );
      const wsUrl =
        process.env.PYTHON_AI_AGENT_WS_URL ||
        `${pythonHttpBase.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:')}/ws/realtime`;

      const livekitUrl = process.env.LIVEKIT_URL || null;
      const livekitApiKey = process.env.LIVEKIT_API_KEY || '';
      const livekitApiSecret = process.env.LIVEKIT_API_SECRET || '';
      const livekitToken =
        livekitUrl && livekitApiKey && livekitApiSecret
          ? createLiveKitRoomJwt({
              apiKey: livekitApiKey,
              apiSecret: livekitApiSecret,
              roomName,
              identity: `caller-${crypto.randomUUID().slice(0, 6)}`,
              metadata: JSON.stringify({ tenantId, customerName, customerPhone: phone }),
            })
          : null;

      res.json({
        transport: livekitToken ? 'livekit' : 'websocket-full-duplex',
        wsUrl,
        roomName,
        livekitUrl,
        livekitToken,
        sessionContext: {
          tenantId,
          customerName,
          customerPhone: phone,
          previousOrdersSummary,
          savedAddress: 'গুলশান ২, ভাটারা, ঢাকা',
          voiceName,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/commit-order', requireInternalService(env), async (req, res, next) => {
    try {
      const tenantId = String(req.body?.tenantId || req.header('x-tenant-id') || DEMO_TENANT_A_ID);
      const rawPayload = (req.body?.orderPayload || {}) as Record<string, unknown>;
      const adapter = storeAdapters.custom;
      const normalized = adapter.normalizeOrderPayload(rawPayload);
      const phoneE164 = normalizePhoneE164(normalized.phoneRaw) || '+8801712345678';
      const now = new Date().toISOString();

      const { order, duplicate } = await repo.createOrder({
        id: crypto.randomUUID(),
        tenantId,
        externalOrderId: normalized.externalOrderId || `RT-${crypto.randomUUID().slice(0, 6).toUpperCase()}`,
        storeProvider: 'custom',
        customerName: normalized.customerName,
        phoneRaw: normalized.phoneRaw,
        phoneE164,
        totalAmount: normalized.totalAmount,
        currency: normalized.currency || 'BDT',
        orderStatus: 'confirmed',
        verificationStatus: 'confirmed',
        syncStatus: 'synced',
        consentGranted: true,
        items: normalized.items,
        rawPayload: {
          ...rawPayload,
          source: 'phase3_realtime_full_duplex_agent',
        },
        createdAt: now,
        updatedAt: now,
      });

      await repo.addOrderEvent({
        id: crypto.randomUUID(),
        tenantId,
        orderId: order.id,
        callId: null,
        eventType: 'realtime_voice_order_confirmed',
        source: 'realtime_voice_agent',
        metadata: {
          externalOrderId: order.externalOrderId,
          itemCount: order.items.length,
          totalAmount: order.totalAmount,
        },
        createdAt: now,
      });

      logger.info(
        { tenantId, orderId: order.id, externalOrderId: order.externalOrderId },
        'Committed real-time voice order via storeAdapters.ts'
      );

      res.status(duplicate ? 200 : 201).json({
        saved: true,
        duplicate,
        orderId: order.id,
        externalOrderId: order.externalOrderId,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
