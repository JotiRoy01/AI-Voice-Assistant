import crypto from 'crypto';
import { AppEnv } from '../config/env';
import { buildOrderVerificationPrompt } from '../domain/banglaPrompt';
import { encryptSecret, hashPassword } from '../security/crypto';
import { FlowMindRepository } from './repository';

export const DEMO_TENANT_A_ID = 'tenant-desh-fashion';
export const DEMO_TENANT_B_ID = 'tenant-dhaka-organic';

export async function seedInitialData(repo: FlowMindRepository, env: AppEnv): Promise<void> {
  const now = new Date().toISOString();

  await repo.upsertTenant({
    id: DEMO_TENANT_A_ID,
    name: 'Desh Fashion BD',
    slug: 'desh-fashion',
    status: 'active',
    timezone: 'Asia/Dhaka',
    createdAt: now,
    updatedAt: now,
  });

  await repo.upsertTenant({
    id: DEMO_TENANT_B_ID,
    name: 'Dhaka Organic Store',
    slug: 'dhaka-organic',
    status: 'active',
    timezone: 'Asia/Dhaka',
    createdAt: now,
    updatedAt: now,
  });

  await repo.upsertUser({
    id: 'user-super-admin',
    tenantId: DEMO_TENANT_A_ID,
    email: 'admin@flowmind.ai',
    passwordHash: hashPassword('FlowMind@2026'),
    name: 'FlowMind Super Admin',
    role: 'super_admin',
    createdAt: now,
  });

  await repo.upsertUser({
    id: 'user-owner-a',
    tenantId: DEMO_TENANT_A_ID,
    email: 'owner@deshfashion.bd',
    passwordHash: hashPassword('DeshFashion@2026'),
    name: 'Tariqul Islam (Desh Fashion)',
    role: 'business_owner',
    createdAt: now,
  });

  await repo.upsertUser({
    id: 'user-owner-b',
    tenantId: DEMO_TENANT_B_ID,
    email: 'owner@dhakaorganic.bd',
    passwordHash: hashPassword('DhakaOrganic@2026'),
    name: 'Nusrat Jahan (Dhaka Organic)',
    role: 'business_owner',
    createdAt: now,
  });

  for (const tenantId of [DEMO_TENANT_A_ID, DEMO_TENANT_B_ID]) {
    const existingSettings = await repo.getVoiceSettings(tenantId);
    if (!existingSettings) {
      await repo.upsertVoiceSettings({
        tenantId,
        enabled: true,
        language: 'bn-BD',
        voiceName: env.TTS_DEFAULT_VOICE,
        callWindowStart: '00:00',
        callWindowEnd: '23:59',
        retryLimit: 2,
        retryIntervalMinutes: 15,
        menuReplayLimit: 1,
        invalidKeyLimit: 2,
        eligibleStatuses: ['pending', 'cod_unverified', 'processing'],
        whatsappFallbackContact: '+8801700000000',
        ttsProvider: env.TTS_PROVIDER,
        telephonyProvider: env.TELEPHONY_PROVIDER,
        whatsappProvider: env.WHATSAPP_PROVIDER,
        updatedAt: now,
      });
    }

    const encShopify = encryptSecret(env.DEFAULT_SHOPIFY_WEBHOOK_SECRET, env.ENCRYPTION_KEY_HEX);
    await repo.upsertProviderCredential({
      id: `cred-${tenantId}-shopify`,
      tenantId,
      provider: 'shopify',
      config: { shopDomain: `${tenantId}.myshopify.com` },
      encryptedSecret: encShopify.encryptedSecret,
      iv: encShopify.iv,
      authTag: encShopify.authTag,
      status: 'active',
      updatedAt: now,
    });

    const encWoo = encryptSecret(env.DEFAULT_WOOCOMMERCE_WEBHOOK_SECRET, env.ENCRYPTION_KEY_HEX);
    await repo.upsertProviderCredential({
      id: `cred-${tenantId}-woocommerce`,
      tenantId,
      provider: 'woocommerce',
      config: { storeUrl: `https://${tenantId}.example.com` },
      encryptedSecret: encWoo.encryptedSecret,
      iv: encWoo.iv,
      authTag: encWoo.authTag,
      status: 'active',
      updatedAt: now,
    });

    const encCustom = encryptSecret(env.DEFAULT_CUSTOM_WEBHOOK_SECRET, env.ENCRYPTION_KEY_HEX);
    await repo.upsertProviderCredential({
      id: `cred-${tenantId}-custom`,
      tenantId,
      provider: 'custom',
      config: { label: 'Custom Store Webhook' },
      encryptedSecret: encCustom.encryptedSecret,
      iv: encCustom.iv,
      authTag: encCustom.authTag,
      status: 'active',
      updatedAt: now,
    });
  }

  // Seed realistic sample orders for Desh Fashion BD (skip if already seeded)
  const existingOrders = await repo.listOrders(DEMO_TENANT_A_ID, 5);
  if (existingOrders.length === 0) {
    // Sample 1: Exact SRS Section 3.1 Bangla example (Confirmed via DTMF 1)
    const { order: o1 } = await repo.createOrder({
      id: 'ord-demo-1001',
      tenantId: DEMO_TENANT_A_ID,
      externalOrderId: 'DF-1001',
      storeProvider: 'shopify',
      phoneE164: '+8801711223344',
      customerName: 'Mahmudul Hasan',
      totalAmount: 1500,
      currency: 'BDT',
      orderStatus: 'confirmed',
      verificationStatus: 'confirmed',
      consentGranted: true,
      items: [
        {
          id: crypto.randomUUID(),
          productName: 'প্যান্ট',
          variant: 'স্লিম ফিট',
          colour: 'কালো',
          size: '36',
          quantity: 1,
          unitPrice: 1500,
        },
      ],
    });
    await repo.updateOrderState(DEMO_TENANT_A_ID, o1.id, { storeSyncStatus: 'synced' });
    const prompt1 = buildOrderVerificationPrompt(o1);
    const { job: j1 } = await repo.createCallJob({
      id: 'job-demo-1001',
      tenantId: DEMO_TENANT_A_ID,
      orderId: o1.id,
      status: 'completed',
      scheduledAt: now,
      attemptNo: 1,
      maxAttempts: 3,
      idempotencyKey: `${DEMO_TENANT_A_ID}:${o1.id}:cycle-1`,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    });
    const c1 = await repo.createVoiceCall({
      id: 'call-demo-1001',
      tenantId: DEMO_TENANT_A_ID,
      callJobId: j1.id,
      orderId: o1.id,
      providerCallId: 'sim-call-1001',
      startedAt: now,
      endedAt: now,
      durationSec: 28,
      callStatus: 'completed',
      dtmfResult: '1_confirm',
      replayCount: 0,
      invalidAttempts: 0,
      promptText: prompt1.fullScript,
      audioUrl: null,
      errorCode: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    });
    await repo.addOrderEvent({
      id: crypto.randomUUID(),
      tenantId: DEMO_TENANT_A_ID,
      orderId: o1.id,
      callId: c1.id,
      eventType: 'order_confirmed_via_dtmf',
      source: 'telephony_webhook',
      metadata: { digit: '1', storeSync: 'synced' },
      createdAt: now,
    });

    // Sample 2: Key 3 WhatsApp custom instruction received
    const { order: o2 } = await repo.createOrder({
      id: 'ord-demo-1002',
      tenantId: DEMO_TENANT_A_ID,
      externalOrderId: 'DF-1002',
      storeProvider: 'woocommerce',
      phoneE164: '+8801819556677',
      customerName: 'Farhana Akter',
      totalAmount: 2450,
      currency: 'BDT',
      orderStatus: 'pending',
      verificationStatus: 'whatsapp_requested',
      consentGranted: true,
      items: [
        {
          id: crypto.randomUUID(),
          productName: 'কটন পাঞ্জাবি',
          variant: 'প্রিমিয়াম',
          colour: 'নেভি ব্লু',
          size: '42',
          quantity: 1,
          unitPrice: 2450,
        },
      ],
    });
    const prompt2 = buildOrderVerificationPrompt(o2);
    const { job: j2 } = await repo.createCallJob({
      id: 'job-demo-1002',
      tenantId: DEMO_TENANT_A_ID,
      orderId: o2.id,
      status: 'completed',
      scheduledAt: now,
      attemptNo: 1,
      maxAttempts: 3,
      idempotencyKey: `${DEMO_TENANT_A_ID}:${o2.id}:cycle-1`,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    });
    const c2 = await repo.createVoiceCall({
      id: 'call-demo-1002',
      tenantId: DEMO_TENANT_A_ID,
      callJobId: j2.id,
      orderId: o2.id,
      providerCallId: 'sim-call-1002',
      startedAt: now,
      endedAt: now,
      durationSec: 34,
      callStatus: 'completed',
      dtmfResult: '3_whatsapp',
      replayCount: 0,
      invalidAttempts: 0,
      promptText: prompt2.fullScript,
      audioUrl: null,
      errorCode: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    });
    await repo.createCustomerInstruction({
      id: 'instr-demo-1002',
      tenantId: DEMO_TENANT_A_ID,
      orderId: o2.id,
      channel: 'whatsapp',
      senderPhoneE164: o2.phoneE164,
      messageText: 'Order DF-1002: বিকেল ৫টার পর বাড্ডা লিংক রোড অফিসে ডেলিভারি দিবেন প্লিজ।',
      providerMessageId: 'wamid.demo.1002',
      receivedAt: now,
      status: 'received',
      createdAt: now,
    });
    await repo.addOrderEvent({
      id: crypto.randomUUID(),
      tenantId: DEMO_TENANT_A_ID,
      orderId: o2.id,
      callId: c2.id,
      eventType: 'whatsapp_instruction_received',
      source: 'whatsapp_webhook',
      metadata: { messagePreview: 'বিকেল ৫টার পর ডেলিভারি' },
      createdAt: now,
    });

    // Sample 3: Cancellation requested (Key 2)
    const { order: o3 } = await repo.createOrder({
      id: 'ord-demo-1003',
      tenantId: DEMO_TENANT_A_ID,
      externalOrderId: 'DF-1003',
      storeProvider: 'custom',
      phoneE164: '+8801911889900',
      customerName: 'Rakibul Alam',
      totalAmount: 980,
      currency: 'BDT',
      orderStatus: 'cancelled',
      verificationStatus: 'cancelled',
      consentGranted: true,
      items: [
        {
          id: crypto.randomUUID(),
          productName: 'পোলো টি-শার্ট',
          variant: null,
          colour: 'সাদা',
          size: 'L',
          quantity: 1,
          unitPrice: 980,
        },
      ],
    });
    await repo.updateOrderState(DEMO_TENANT_A_ID, o3.id, { storeSyncStatus: 'synced' });
    const prompt3 = buildOrderVerificationPrompt(o3);
    const { job: j3 } = await repo.createCallJob({
      id: 'job-demo-1003',
      tenantId: DEMO_TENANT_A_ID,
      orderId: o3.id,
      status: 'completed',
      scheduledAt: now,
      attemptNo: 1,
      maxAttempts: 3,
      idempotencyKey: `${DEMO_TENANT_A_ID}:${o3.id}:cycle-1`,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    });
    await repo.createVoiceCall({
      id: 'call-demo-1003',
      tenantId: DEMO_TENANT_A_ID,
      callJobId: j3.id,
      orderId: o3.id,
      providerCallId: 'sim-call-1003',
      startedAt: now,
      endedAt: now,
      durationSec: 21,
      callStatus: 'completed',
      dtmfResult: '2_cancel',
      replayCount: 0,
      invalidAttempts: 0,
      promptText: prompt3.fullScript,
      audioUrl: null,
      errorCode: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    });
  }
}
