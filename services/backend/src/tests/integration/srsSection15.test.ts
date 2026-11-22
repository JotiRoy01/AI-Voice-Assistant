import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppContainer, createAppContainer } from '../../app';
import { loadEnv } from '../../config/env';
import { DEMO_TENANT_A_ID, DEMO_TENANT_B_ID, seedInitialData } from '../../db/seedData';
import { InlineCallQueue } from '../../queue/callQueue';
import { signAccessToken } from '../../security/auth';
import { computeHmacBase64, computeHmacHex } from '../../security/crypto';

describe('SRS Section 15 — End-to-End Testing & QA Acceptance Suite', () => {
  let container: AppContainer;
  let inlineQueue: InlineCallQueue;
  let ownerAToken: string;
  let ownerBToken: string;

  const env = loadEnv({
    NODE_ENV: 'test',
    DATA_STORE: 'memory',
    QUEUE_MODE: 'inline',
    TTS_PROVIDER: 'mock',
    TELEPHONY_PROVIDER: 'simulator',
    WHATSAPP_PROVIDER: 'simulator',
  });

  beforeEach(async () => {
    inlineQueue = new InlineCallQueue(true);
    container = createAppContainer({ env, queue: inlineQueue });
    await seedInitialData(container.repo, env);

    ownerAToken = signAccessToken(
      { userId: 'user-owner-a', tenantId: DEMO_TENANT_A_ID, role: 'business_owner', email: 'owner@deshfashion.bd' },
      env.JWT_SECRET
    );
    ownerBToken = signAccessToken(
      { userId: 'user-owner-b', tenantId: DEMO_TENANT_B_ID, role: 'business_owner', email: 'owner@dhakaorganic.bd' },
      env.JWT_SECRET
    );
  });

  afterEach(async () => {
    await container.close();
  });

  async function sendSignedCustomOrder(externalOrderId: string, overrides: Record<string, unknown> = {}) {
    const payload = {
      externalOrderId,
      customerName: 'Tanvir Ahmed',
      phone: '01712345678',
      totalAmount: 1500,
      currency: 'BDT',
      orderStatus: 'pending',
      consentGranted: true,
      items: [{ productName: 'প্যান্ট', colour: 'কালো', size: '36', quantity: 1, unitPrice: 1500 }],
      ...overrides,
    };
    const raw = JSON.stringify(payload);
    const sig = `sha256=${computeHmacHex(raw, env.DEFAULT_CUSTOM_WEBHOOK_SECRET)}`;

    return request(container.app)
      .post('/api/webhooks/orders/custom')
      .set('X-Tenant-Id', DEMO_TENANT_A_ID)
      .set('X-FlowMind-Signature', sig)
      .set('Content-Type', 'application/json')
      .send(raw);
  }

  async function sendSignedTelephonyEvent(body: Record<string, unknown>) {
    const raw = JSON.stringify(body);
    const sig = `sha256=${computeHmacHex(raw, env.TELEPHONY_WEBHOOK_SECRET)}`;
    return request(container.app)
      .post('/api/webhooks/telephony/events')
      .set('X-Telephony-Signature', sig)
      .set('Content-Type', 'application/json')
      .send(raw);
  }

  // Test 1: Valid order webhook -> One eligible call job created
  it('T01: valid signed Shopify/Custom order webhook creates exactly one eligible call job & initiates call', async () => {
    const shopifyPayload = {
      name: '#SHP-5001',
      total_price: '1500.00',
      currency: 'BDT',
      customer: { first_name: 'Karim', last_name: 'Uddin', phone: '01755667788' },
      line_items: [{ title: 'প্যান্ট', variant_title: 'কালো / 36', quantity: 1, price: '1500.00' }],
    };
    const raw = JSON.stringify(shopifyPayload);
    const hmac = computeHmacBase64(raw, env.DEFAULT_SHOPIFY_WEBHOOK_SECRET);

    const res = await request(container.app)
      .post('/api/webhooks/orders/shopify')
      .set('X-Tenant-Id', 'desh-fashion')
      .set('X-Shopify-Hmac-Sha256', hmac)
      .set('Content-Type', 'application/json')
      .send(raw);

    expect(res.status).toBe(202);
    expect(res.body.eligible).toBe(true);
    expect(res.body.callJobId).toBeTruthy();

    const jobs = await container.repo.listCallJobsByOrder(DEMO_TENANT_A_ID, res.body.orderId);
    expect(jobs).toHaveLength(1);
    const calls = await container.repo.listVoiceCallsByOrder(DEMO_TENANT_A_ID, res.body.orderId);
    expect(calls).toHaveLength(1);
    expect(calls[0].promptText).toContain('১,৫০০ টাকায়');
  });

  // Test 2: Duplicate webhook -> No duplicate job/call
  it('T02: duplicate order webhook is deduplicated with no duplicate call job or call', async () => {
    const first = await sendSignedCustomOrder('ORD-DUP-01');
    const second = await sendSignedCustomOrder('ORD-DUP-01');

    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);

    const jobs = await container.repo.listCallJobsByOrder(DEMO_TENANT_A_ID, first.body.orderId);
    const calls = await container.repo.listVoiceCallsByOrder(DEMO_TENANT_A_ID, first.body.orderId);
    expect(jobs).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  // Test 3: Press 1 -> Confirmation saved; store updated once
  it('T03: DTMF key 1 confirms order and updates store exactly once', async () => {
    const confirmSpy = vi.spyOn(container.storeAdapters.custom, 'confirmOrder');
    const created = await sendSignedCustomOrder('ORD-KEY1-01');
    const [call] = await container.repo.listVoiceCallsByOrder(DEMO_TENANT_A_ID, created.body.orderId);

    const cb = await sendSignedTelephonyEvent({
      providerEventId: 'evt-key1-1',
      providerCallId: call.providerCallId!,
      eventType: 'dtmf',
      digit: '1',
      durationSec: 26,
    });

    expect(cb.status).toBe(200);
    expect(cb.body.action).toBe('confirm_order');
    expect(confirmSpy).toHaveBeenCalledTimes(1);

    const updated = await container.repo.getOrderById(DEMO_TENANT_A_ID, created.body.orderId);
    expect(updated?.verificationStatus).toBe('confirmed');
    expect(updated?.orderStatus).toBe('confirmed');
    expect(updated?.storeSyncStatus).toBe('synced');
  });

  // Test 4: Press 2 -> Cancellation request saved; store fulfillment rules respected
  it('T04: DTMF key 2 cancels eligible pending order AND blocks auto-cancel for shipped order', async () => {
    // 4a: Pending order -> cancellation permitted
    const pendingRes = await sendSignedCustomOrder('ORD-KEY2-PENDING');
    const [callA] = await container.repo.listVoiceCallsByOrder(DEMO_TENANT_A_ID, pendingRes.body.orderId);

    const cbA = await sendSignedTelephonyEvent({
      providerEventId: 'evt-key2-a',
      providerCallId: callA.providerCallId!,
      eventType: 'dtmf',
      digit: '2',
    });
    expect(cbA.body.action).toBe('cancel_order_permitted');
    const ordA = await container.repo.getOrderById(DEMO_TENANT_A_ID, pendingRes.body.orderId);
    expect(ordA?.verificationStatus).toBe('cancelled');
    expect(ordA?.orderStatus).toBe('cancelled');

    // 4b: Order moves to 'shipped' mid-call -> key 2 records cancellation_requested without cancelling store
    const shippedRes = await sendSignedCustomOrder('ORD-KEY2-SHIPPED');
    const [callB] = await container.repo.listVoiceCallsByOrder(DEMO_TENANT_A_ID, shippedRes.body.orderId);
    await container.repo.updateOrderState(DEMO_TENANT_A_ID, shippedRes.body.orderId, {
      orderStatus: 'shipped',
    });

    const cbB = await sendSignedTelephonyEvent({
      providerEventId: 'evt-key2-b',
      providerCallId: callB.providerCallId!,
      eventType: 'dtmf',
      digit: '2',
    });
    expect(cbB.body.action).toBe('cancel_request_only');
    const ordB = await container.repo.getOrderById(DEMO_TENANT_A_ID, shippedRes.body.orderId);
    expect(ordB?.verificationStatus).toBe('cancellation_requested');
    expect(ordB?.orderStatus).toBe('shipped');
  });

  // Test 5: Press 3 -> WhatsApp instructions played & deep link dispatched
  it('T05: DTMF key 3 triggers WhatsApp instruction prompt and deep link flow', async () => {
    const created = await sendSignedCustomOrder('ORD-KEY3-01');
    const [call] = await container.repo.listVoiceCallsByOrder(DEMO_TENANT_A_ID, created.body.orderId);

    const cb = await sendSignedTelephonyEvent({
      providerEventId: 'evt-key3-1',
      providerCallId: call.providerCallId!,
      eventType: 'dtmf',
      digit: '3',
    });

    expect(cb.status).toBe(200);
    expect(cb.body.action).toBe('trigger_whatsapp');
    expect(cb.body.spokenPrompt).toContain('WhatsApp');
    expect(cb.body.whatsappDeepLink).toContain('https://wa.me/');

    const ord = await container.repo.getOrderById(DEMO_TENANT_A_ID, created.body.orderId);
    expect(ord?.verificationStatus).toBe('whatsapp_requested');
  });

  // Test 6: No input -> Menu replay once, then no_response status
  it('T06: no-input replays menu within configured limit, then marks no_response', async () => {
    const created = await sendSignedCustomOrder('ORD-NOINPUT-01');
    const [call] = await container.repo.listVoiceCallsByOrder(DEMO_TENANT_A_ID, created.body.orderId);

    // 1st no_input -> replay menu (menuReplayLimit = 1)
    const first = await sendSignedTelephonyEvent({
      providerEventId: 'evt-noin-1',
      providerCallId: call.providerCallId!,
      eventType: 'dtmf',
      digit: 'no_input',
    });
    expect(first.body.action).toBe('replay_menu');
    expect(first.body.endCall).toBe(false);

    // 2nd no_input -> exceeds replay limit -> ends call with no_response
    const second = await sendSignedTelephonyEvent({
      providerEventId: 'evt-noin-2',
      providerCallId: call.providerCallId!,
      eventType: 'dtmf',
      digit: 'no_input',
    });
    expect(second.body.action).toBe('end_no_response');
    expect(second.body.endCall).toBe(true);

    const ord = await container.repo.getOrderById(DEMO_TENANT_A_ID, created.body.orderId);
    expect(ord?.verificationStatus).toBe('no_response');
  });

  // Test 7: Invalid key -> Menu replay and limit enforced
  it('T07: invalid keypad inputs replay menu and end call once invalid limit is reached', async () => {
    const created = await sendSignedCustomOrder('ORD-INVALID-01');
    const [call] = await container.repo.listVoiceCallsByOrder(DEMO_TENANT_A_ID, created.body.orderId);

    // 1st invalid key ('9') -> replay menu (invalidKeyLimit = 2)
    const first = await sendSignedTelephonyEvent({
      providerEventId: 'evt-inv-1',
      providerCallId: call.providerCallId!,
      eventType: 'dtmf',
      digit: '9',
    });
    expect(first.body.action).toBe('replay_menu');
    expect(first.body.endCall).toBe(false);

    // 2nd invalid key ('*') -> reaches limit -> ends call
    const second = await sendSignedTelephonyEvent({
      providerEventId: 'evt-inv-2',
      providerCallId: call.providerCallId!,
      eventType: 'dtmf',
      digit: '*',
    });
    expect(second.body.action).toBe('end_invalid_input');
    expect(second.body.endCall).toBe(true);

    const ord = await container.repo.getOrderById(DEMO_TENANT_A_ID, created.body.orderId);
    expect(ord?.verificationStatus).toBe('invalid_input');
  });

  // Test 8: No answer -> Call logged; retry policy applied
  it('T08: unanswered call logs attempt and schedules bounded retry per tenant policy', async () => {
    const created = await sendSignedCustomOrder('ORD-NOANS-01');
    const [call] = await container.repo.listVoiceCallsByOrder(DEMO_TENANT_A_ID, created.body.orderId);

    const cb = await sendSignedTelephonyEvent({
      providerEventId: 'evt-noans-1',
      providerCallId: call.providerCallId!,
      eventType: 'no_answer',
    });

    expect(cb.status).toBe(200);
    expect(cb.body.action).toBe('retry_scheduled');
    expect(cb.body.retryScheduledAt).toBeTruthy();
    expect(inlineQueue.pendingDelayed.length).toBeGreaterThanOrEqual(1);

    const [job] = await container.repo.listCallJobsByOrder(DEMO_TENANT_A_ID, created.body.orderId);
    expect(job.status).toBe('retry_scheduled');
    expect(job.attemptNo).toBe(2);
  });

  // Test 9: Order cancelled before callback -> Late input cannot incorrectly confirm
  it('T09: late DTMF 1 callback is rejected when order was already cancelled before callback', async () => {
    const created = await sendSignedCustomOrder('ORD-STALE-01');
    const [call] = await container.repo.listVoiceCallsByOrder(DEMO_TENANT_A_ID, created.body.orderId);

    // Order cancelled externally before customer presses 1
    await container.repo.updateOrderState(DEMO_TENANT_A_ID, created.body.orderId, {
      orderStatus: 'cancelled',
      verificationStatus: 'cancelled',
    });

    const cb = await sendSignedTelephonyEvent({
      providerEventId: 'evt-stale-1',
      providerCallId: call.providerCallId!,
      eventType: 'dtmf',
      digit: '1',
    });

    expect(cb.status).toBe(200);
    expect(cb.body.action).toBe('reject_stale_order');
    const ord = await container.repo.getOrderById(DEMO_TENANT_A_ID, created.body.orderId);
    expect(ord?.orderStatus).toBe('cancelled');
    expect(ord?.verificationStatus).toBe('cancelled');
  });

  // Test 10: Duplicate provider callback -> Only one state transition
  it('T10: duplicate telephony callback with same providerEventId produces only one state transition', async () => {
    const confirmSpy = vi.spyOn(container.storeAdapters.custom, 'confirmOrder');
    const created = await sendSignedCustomOrder('ORD-DUPCB-01');
    const [call] = await container.repo.listVoiceCallsByOrder(DEMO_TENANT_A_ID, created.body.orderId);

    const first = await sendSignedTelephonyEvent({
      providerEventId: 'evt-same-id-999',
      providerCallId: call.providerCallId!,
      eventType: 'dtmf',
      digit: '1',
    });
    const second = await sendSignedTelephonyEvent({
      providerEventId: 'evt-same-id-999',
      providerCallId: call.providerCallId!,
      eventType: 'dtmf',
      digit: '1',
    });

    expect(first.body.action).toBe('confirm_order');
    expect(second.body.duplicate).toBe(true);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
  });

  // Test 11: WhatsApp reply received -> Message linked to correct tenant/order
  it('T11: signed inbound WhatsApp reply is linked to the exact tenant and order', async () => {
    const created = await sendSignedCustomOrder('ORD-WA-777', { phone: '01811998877' });
    const [call] = await container.repo.listVoiceCallsByOrder(DEMO_TENANT_A_ID, created.body.orderId);

    await sendSignedTelephonyEvent({
      providerEventId: 'evt-wa-key3',
      providerCallId: call.providerCallId!,
      eventType: 'dtmf',
      digit: '3',
    });

    const waBody = JSON.stringify({
      from: '+8801811998877',
      text: 'সাইজ ৩৬ এর পরিবর্তে ৩৮ পাঠাবেন প্লিজ।',
      messageId: 'wamid.inbound.777',
    });
    const waSig = `sha256=${computeHmacHex(waBody, env.WHATSAPP_APP_SECRET)}`;

    const waRes = await request(container.app)
      .post('/api/webhooks/whatsapp/messages')
      .set('X-Tenant-Id', DEMO_TENANT_A_ID)
      .set('X-Hub-Signature-256', waSig)
      .set('Content-Type', 'application/json')
      .send(waBody);

    expect(waRes.status).toBe(200);
    expect(waRes.body.linked).toBe(true);
    expect(waRes.body.orderId).toBe(created.body.orderId);

    const instructions = await container.repo.listInstructionsByOrder(DEMO_TENANT_A_ID, created.body.orderId);
    expect(instructions).toHaveLength(1);
    expect(instructions[0].messageText).toContain('৩৮');
  });

  // Test 12: Cross-tenant access attempt -> Denied and logged
  it('T12: cross-tenant access attempt is denied (403 on header override, 404 on foreign order ID)', async () => {
    const createdA = await sendSignedCustomOrder('ORD-TENANT-A-ONLY');

    // Tenant B tries to spoof X-Tenant-Id header to read Tenant A's orders
    const spoofRes = await request(container.app)
      .get('/api/orders')
      .set('Authorization', `Bearer ${ownerBToken}`)
      .set('X-Tenant-Id', DEMO_TENANT_A_ID);
    expect(spoofRes.status).toBe(403);

    // Tenant B tries to fetch Tenant A's order history directly by orderId
    const directRes = await request(container.app)
      .get(`/api/orders/${createdA.body.orderId}/voice-history`)
      .set('Authorization', `Bearer ${ownerBToken}`);
    expect(directRes.status).toBe(404);

    // Tenant A can access its own order cleanly
    const ownRes = await request(container.app)
      .get(`/api/orders/${createdA.body.orderId}/voice-history`)
      .set('Authorization', `Bearer ${ownerAToken}`);
    expect(ownRes.status).toBe(200);
    expect(ownRes.body.order.externalOrderId).toBe('ORD-TENANT-A-ONLY');
  });

  // Extra Security & Reliability Guards (SRS Section 12 & 13)
  it('T13: rejects invalid webhook signature and creates zero call jobs', async () => {
    const res = await request(container.app)
      .post('/api/webhooks/orders/custom')
      .set('X-Tenant-Id', DEMO_TENANT_A_ID)
      .set('X-FlowMind-Signature', 'sha256=badbadbad')
      .send({ externalOrderId: 'ORD-FORGED', phone: '01711112222', totalAmount: 500 });

    expect(res.status).toBe(401);
    const ord = await container.repo.getOrderByExternalId(DEMO_TENANT_A_ID, 'ORD-FORGED');
    expect(ord).toBeNull();
  });

  it('T14: suppresses outbound calls for opted-out customer phone numbers', async () => {
    await container.repo.addOptOut(DEMO_TENANT_A_ID, '+8801799001122', 'Customer requested DND');
    const res = await sendSignedCustomOrder('ORD-OPTOUT-1', { phone: '01799001122' });

    expect(res.status).toBe(202);
    expect(res.body.eligible).toBe(false);
    expect(res.body.reason).toBe('customer_opted_out');
    const jobs = await container.repo.listCallJobsByOrder(DEMO_TENANT_A_ID, res.body.orderId);
    expect(jobs).toHaveLength(0);
  });

  it('T15: marks order pending_sync when store update fails and recovers cleanly on retry', async () => {
    const created = await sendSignedCustomOrder('ORD-SYNCFAIL-1');
    const [call] = await container.repo.listVoiceCallsByOrder(DEMO_TENANT_A_ID, created.body.orderId);

    const spy = vi
      .spyOn(container.storeAdapters.custom, 'confirmOrder')
      .mockResolvedValueOnce({ success: false, error: 'Store 503 Unavailable' });

    await sendSignedTelephonyEvent({
      providerEventId: 'evt-syncfail-1',
      providerCallId: call.providerCallId!,
      eventType: 'dtmf',
      digit: '1',
    });

    const failedSyncOrder = await container.repo.getOrderById(DEMO_TENANT_A_ID, created.body.orderId);
    expect(failedSyncOrder?.storeSyncStatus).toBe('pending_sync');
    expect(failedSyncOrder?.orderStatus).toBe('pending'); // Did NOT claim store sync success!

    // Now retry store sync from Error Monitor endpoint
    spy.mockResolvedValueOnce({ success: true, providerStatus: 'confirmed:ORD-SYNCFAIL-1' });
    const retryRes = await request(container.app)
      .post(`/api/dashboard/errors/${created.body.orderId}/retry-sync`)
      .set('Authorization', `Bearer ${ownerAToken}`);

    expect(retryRes.status).toBe(200);
    expect(retryRes.body.success).toBe(true);
    const recovered = await container.repo.getOrderById(DEMO_TENANT_A_ID, created.body.orderId);
    expect(recovered?.storeSyncStatus).toBe('synced');
    expect(recovered?.orderStatus).toBe('confirmed');
  });
});
