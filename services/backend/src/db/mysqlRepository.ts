import crypto from 'crypto';
import mysql, { Pool, RowDataPacket } from 'mysql2/promise';
import { AppEnv } from '../config/env';
import {
  CallJob,
  CustomerInstruction,
  Order,
  OrderEvent,
  OrderItem,
  ProviderCredential,
  StoreSyncStatus,
  Tenant,
  User,
  VerificationStatus,
  VoiceCall,
  VoiceSettings,
} from '../domain/types';
import { CreateOrderInput, FlowMindRepository, UsageMetrics } from './repository';

function toUtcMysql(iso: string | Date): Date {
  return iso instanceof Date ? iso : new Date(iso);
}

function toIso(val: unknown): string {
  if (!val) return new Date().toISOString();
  if (val instanceof Date) return val.toISOString();
  return new Date(String(val)).toISOString();
}

function parseJsonField<T>(val: unknown, fallback: T): T {
  if (val == null) return fallback;
  if (typeof val === 'string') {
    try {
      return JSON.parse(val) as T;
    } catch {
      return fallback;
    }
  }
  return val as T;
}

export class MysqlRepository implements FlowMindRepository {
  private pool: Pool;

  constructor(env: AppEnv) {
    this.pool = mysql.createPool({
      host: env.MYSQL_HOST,
      port: env.MYSQL_PORT,
      database: env.MYSQL_DATABASE,
      user: env.MYSQL_USER,
      password: env.MYSQL_PASSWORD,
      waitForConnections: true,
      connectionLimit: 15,
      timezone: 'Z',
    });
  }

  async upsertTenant(tenant: Tenant): Promise<void> {
    await this.pool.execute(
      `INSERT INTO tenants (id, name, slug, status, timezone)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), status = VALUES(status), timezone = VALUES(timezone)`,
      [tenant.id, tenant.name, tenant.slug, tenant.status, tenant.timezone]
    );
  }

  async getTenantById(id: string): Promise<Tenant | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>('SELECT * FROM tenants WHERE id = ?', [id]);
    return rows[0] ? this.mapTenant(rows[0]) : null;
  }

  async getTenantBySlug(slug: string): Promise<Tenant | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>('SELECT * FROM tenants WHERE slug = ?', [slug]);
    return rows[0] ? this.mapTenant(rows[0]) : null;
  }

  async listTenants(): Promise<Tenant[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>('SELECT * FROM tenants ORDER BY created_at ASC');
    return rows.map((r) => this.mapTenant(r));
  }

  async upsertUser(user: User): Promise<void> {
    await this.pool.execute(
      `INSERT INTO users (id, tenant_id, email, password_hash, name, role)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), role = VALUES(role), password_hash = VALUES(password_hash)`,
      [user.id, user.tenantId, user.email.toLowerCase(), user.passwordHash, user.name, user.role]
    );
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
    if (!rows[0]) return null;
    const r = rows[0];
    return {
      id: r.id,
      tenantId: r.tenant_id,
      email: r.email,
      passwordHash: r.password_hash,
      name: r.name,
      role: r.role,
      createdAt: toIso(r.created_at),
    };
  }

  async upsertVoiceSettings(settings: VoiceSettings): Promise<VoiceSettings> {
    await this.pool.execute(
      `INSERT INTO voice_settings
       (tenant_id, enabled, language, voice_name, call_window_start, call_window_end, retry_limit,
        retry_interval_minutes, menu_replay_limit, invalid_key_limit, eligible_statuses_json,
        whatsapp_fallback_contact, tts_provider, telephony_provider, whatsapp_provider)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
        enabled = VALUES(enabled), language = VALUES(language), voice_name = VALUES(voice_name),
        call_window_start = VALUES(call_window_start), call_window_end = VALUES(call_window_end),
        retry_limit = VALUES(retry_limit), retry_interval_minutes = VALUES(retry_interval_minutes),
        menu_replay_limit = VALUES(menu_replay_limit), invalid_key_limit = VALUES(invalid_key_limit),
        eligible_statuses_json = VALUES(eligible_statuses_json),
        whatsapp_fallback_contact = VALUES(whatsapp_fallback_contact),
        tts_provider = VALUES(tts_provider), telephony_provider = VALUES(telephony_provider),
        whatsapp_provider = VALUES(whatsapp_provider)`,
      [
        settings.tenantId,
        settings.enabled ? 1 : 0,
        settings.language,
        settings.voiceName,
        settings.callWindowStart,
        settings.callWindowEnd,
        settings.retryLimit,
        settings.retryIntervalMinutes,
        settings.menuReplayLimit,
        settings.invalidKeyLimit,
        JSON.stringify(settings.eligibleStatuses),
        settings.whatsappFallbackContact,
        settings.ttsProvider,
        settings.telephonyProvider,
        settings.whatsappProvider,
      ]
    );
    return (await this.getVoiceSettings(settings.tenantId))!;
  }

  async getVoiceSettings(tenantId: string): Promise<VoiceSettings | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>('SELECT * FROM voice_settings WHERE tenant_id = ?', [tenantId]);
    if (!rows[0]) return null;
    const r = rows[0];
    return {
      tenantId: r.tenant_id,
      enabled: Boolean(r.enabled),
      language: r.language,
      voiceName: r.voice_name,
      callWindowStart: r.call_window_start,
      callWindowEnd: r.call_window_end,
      retryLimit: Number(r.retry_limit),
      retryIntervalMinutes: Number(r.retry_interval_minutes),
      menuReplayLimit: Number(r.menu_replay_limit),
      invalidKeyLimit: Number(r.invalid_key_limit),
      eligibleStatuses: parseJsonField<string[]>(r.eligible_statuses_json, ['pending']),
      whatsappFallbackContact: r.whatsapp_fallback_contact,
      ttsProvider: r.tts_provider,
      telephonyProvider: r.telephony_provider,
      whatsappProvider: r.whatsapp_provider,
      updatedAt: toIso(r.updated_at),
    };
  }

  async createOrder(input: CreateOrderInput): Promise<{ order: Order; duplicate: boolean }> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      try {
        await conn.execute(
          `INSERT INTO orders
           (id, tenant_id, external_order_id, store_provider, phone_e164, customer_name,
            total_amount, currency, order_status, verification_status, consent_granted)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            input.id,
            input.tenantId,
            input.externalOrderId,
            input.storeProvider,
            input.phoneE164,
            input.customerName,
            input.totalAmount,
            input.currency,
            input.orderStatus,
            input.verificationStatus,
            input.consentGranted ? 1 : 0,
          ]
        );
      } catch (err: unknown) {
        const mysqlErr = err as { code?: string };
        if (mysqlErr.code === 'ER_DUP_ENTRY') {
          await conn.rollback();
          const existing = await this.getOrderByExternalId(input.tenantId, input.externalOrderId);
          return { order: existing!, duplicate: true };
        }
        throw err;
      }

      for (const item of input.items) {
        await conn.execute(
          `INSERT INTO order_items (id, order_id, product_name, sku, category, variant, colour, size, attributes_json, quantity, unit_price)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            item.id,
            input.id,
            item.productName,
            item.sku ?? null,
            item.category ?? null,
            item.variant,
            item.colour,
            item.size,
            item.attributes ? JSON.stringify(item.attributes) : null,
            item.quantity,
            item.unitPrice,
          ]
        );
      }
      await conn.commit();
      const created = await this.getOrderById(input.tenantId, input.id);
      return { order: created!, duplicate: false };
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }

  async getOrderById(tenantId: string, orderId: string): Promise<Order | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT * FROM orders WHERE id = ? AND tenant_id = ?',
      [orderId, tenantId]
    );
    if (!rows[0]) return null;
    const items = await this.getItemsForOrder(orderId);
    return this.mapOrder(rows[0], items);
  }

  async getOrderByIdUnsafe(orderId: string): Promise<Order | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>('SELECT * FROM orders WHERE id = ?', [orderId]);
    if (!rows[0]) return null;
    const items = await this.getItemsForOrder(orderId);
    return this.mapOrder(rows[0], items);
  }

  async getOrderByExternalId(tenantId: string, externalOrderId: string): Promise<Order | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT * FROM orders WHERE tenant_id = ? AND external_order_id = ?',
      [tenantId, externalOrderId]
    );
    if (!rows[0]) return null;
    const items = await this.getItemsForOrder(rows[0].id);
    return this.mapOrder(rows[0], items);
  }

  async listOrders(tenantId: string, limit = 100): Promise<Order[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM orders WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ${Math.min(500, Math.max(1, Number(limit)))}`,
      [tenantId]
    );
    const result: Order[] = [];
    for (const r of rows) {
      result.push(this.mapOrder(r, await this.getItemsForOrder(r.id)));
    }
    return result;
  }

  async findRecentWhatsAppOrderByPhone(tenantId: string, phoneE164: string): Promise<Order | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM orders
       WHERE tenant_id = ? AND phone_e164 = ?
       ORDER BY (verification_status = 'whatsapp_requested') DESC, updated_at DESC
       LIMIT 1`,
      [tenantId, phoneE164]
    );
    if (!rows[0]) return null;
    return this.mapOrder(rows[0], await this.getItemsForOrder(rows[0].id));
  }

  async updateOrderState(
    tenantId: string,
    orderId: string,
    patch: {
      orderStatus?: string;
      verificationStatus?: VerificationStatus;
      storeSyncStatus?: StoreSyncStatus;
      storeSyncError?: string | null;
    }
  ): Promise<Order | null> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.orderStatus !== undefined) {
      sets.push('order_status = ?');
      params.push(patch.orderStatus);
    }
    if (patch.verificationStatus !== undefined) {
      sets.push('verification_status = ?');
      params.push(patch.verificationStatus);
    }
    if (patch.storeSyncStatus !== undefined) {
      sets.push('store_sync_status = ?');
      params.push(patch.storeSyncStatus);
    }
    if (patch.storeSyncError !== undefined) {
      sets.push('store_sync_error = ?');
      params.push(patch.storeSyncError);
    }
    if (sets.length === 0) return this.getOrderById(tenantId, orderId);
    params.push(orderId, tenantId);
    await this.pool.execute(
      `UPDATE orders SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`,
      params as (string | number | Date | null)[]
    );
    return this.getOrderById(tenantId, orderId);
  }

  async createCallJob(job: CallJob): Promise<{ job: CallJob; duplicate: boolean }> {
    try {
      await this.pool.execute(
        `INSERT INTO call_jobs (id, tenant_id, order_id, status, scheduled_at, attempt_no, max_attempts, idempotency_key, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          job.id,
          job.tenantId,
          job.orderId,
          job.status,
          toUtcMysql(job.scheduledAt),
          job.attemptNo,
          job.maxAttempts,
          job.idempotencyKey,
          job.lastError,
        ]
      );
      return { job, duplicate: false };
    } catch (err: unknown) {
      const mysqlErr = err as { code?: string };
      if (mysqlErr.code === 'ER_DUP_ENTRY') {
        const [rows] = await this.pool.execute<RowDataPacket[]>(
          'SELECT * FROM call_jobs WHERE idempotency_key = ?',
          [job.idempotencyKey]
        );
        return { job: this.mapCallJob(rows[0]), duplicate: true };
      }
      throw err;
    }
  }

  async getCallJobById(tenantId: string, jobId: string): Promise<CallJob | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT * FROM call_jobs WHERE id = ? AND tenant_id = ?',
      [jobId, tenantId]
    );
    return rows[0] ? this.mapCallJob(rows[0]) : null;
  }

  async hasActiveCallJob(tenantId: string, orderId: string): Promise<boolean> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS cnt FROM call_jobs
       WHERE tenant_id = ? AND order_id = ? AND status IN ('queued','scheduled','in_progress','retry_scheduled')`,
      [tenantId, orderId]
    );
    return Number(rows[0]?.cnt ?? 0) > 0;
  }

  async listCallJobsByOrder(tenantId: string, orderId: string): Promise<CallJob[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT * FROM call_jobs WHERE tenant_id = ? AND order_id = ? ORDER BY created_at ASC',
      [tenantId, orderId]
    );
    return rows.map((r) => this.mapCallJob(r));
  }

  async updateCallJob(
    tenantId: string,
    jobId: string,
    patch: Partial<Pick<CallJob, 'status' | 'scheduledAt' | 'attemptNo' | 'lastError'>>
  ): Promise<CallJob | null> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.status !== undefined) { sets.push('status = ?'); params.push(patch.status); }
    if (patch.scheduledAt !== undefined) { sets.push('scheduled_at = ?'); params.push(toUtcMysql(patch.scheduledAt)); }
    if (patch.attemptNo !== undefined) { sets.push('attempt_no = ?'); params.push(patch.attemptNo); }
    if (patch.lastError !== undefined) { sets.push('last_error = ?'); params.push(patch.lastError); }
    if (sets.length === 0) return this.getCallJobById(tenantId, jobId);
    params.push(jobId, tenantId);
    await this.pool.execute(
      `UPDATE call_jobs SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`,
      params as (string | number | Date | null)[]
    );
    return this.getCallJobById(tenantId, jobId);
  }

  async cancelPendingJobsForOrder(tenantId: string, orderId: string, reason: string): Promise<number> {
    const [res] = await this.pool.execute<mysql.ResultSetHeader>(
      `UPDATE call_jobs SET status = 'cancelled', last_error = ?
       WHERE tenant_id = ? AND order_id = ? AND status IN ('queued','scheduled','in_progress','retry_scheduled')`,
      [reason, tenantId, orderId]
    );
    return res.affectedRows;
  }

  async createVoiceCall(call: VoiceCall): Promise<VoiceCall> {
    await this.pool.execute(
      `INSERT INTO voice_calls
       (id, tenant_id, call_job_id, order_id, provider_call_id, started_at, ended_at, duration_sec,
        call_status, dtmf_result, replay_count, invalid_attempts, prompt_text, audio_url, error_code, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        call.id,
        call.tenantId,
        call.callJobId,
        call.orderId,
        call.providerCallId,
        call.startedAt ? toUtcMysql(call.startedAt) : null,
        call.endedAt ? toUtcMysql(call.endedAt) : null,
        call.durationSec,
        call.callStatus,
        call.dtmfResult,
        call.replayCount,
        call.invalidAttempts,
        call.promptText,
        call.audioUrl,
        call.errorCode,
        call.errorMessage,
      ]
    );
    return (await this.getVoiceCallById(call.tenantId, call.id))!;
  }

  async getVoiceCallById(tenantId: string, callId: string): Promise<VoiceCall | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT * FROM voice_calls WHERE id = ? AND tenant_id = ?',
      [callId, tenantId]
    );
    return rows[0] ? this.mapVoiceCall(rows[0]) : null;
  }

  async getVoiceCallByProviderId(providerCallId: string): Promise<VoiceCall | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT * FROM voice_calls WHERE provider_call_id = ? LIMIT 1',
      [providerCallId]
    );
    return rows[0] ? this.mapVoiceCall(rows[0]) : null;
  }

  async listVoiceCalls(tenantId: string, limit = 100): Promise<VoiceCall[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM voice_calls WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ${Math.min(500, Math.max(1, Number(limit)))}`,
      [tenantId]
    );
    return rows.map((r) => this.mapVoiceCall(r));
  }

  async listVoiceCallsByOrder(tenantId: string, orderId: string): Promise<VoiceCall[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT * FROM voice_calls WHERE tenant_id = ? AND order_id = ? ORDER BY created_at ASC',
      [tenantId, orderId]
    );
    return rows.map((r) => this.mapVoiceCall(r));
  }

  async updateVoiceCall(
    tenantId: string,
    callId: string,
    patch: Partial<
      Pick<
        VoiceCall,
        | 'providerCallId'
        | 'startedAt'
        | 'endedAt'
        | 'durationSec'
        | 'callStatus'
        | 'dtmfResult'
        | 'replayCount'
        | 'invalidAttempts'
        | 'promptText'
        | 'audioUrl'
        | 'errorCode'
        | 'errorMessage'
      >
    >
  ): Promise<VoiceCall | null> {
    const map: Record<string, string> = {
      providerCallId: 'provider_call_id',
      startedAt: 'started_at',
      endedAt: 'ended_at',
      durationSec: 'duration_sec',
      callStatus: 'call_status',
      dtmfResult: 'dtmf_result',
      replayCount: 'replay_count',
      invalidAttempts: 'invalid_attempts',
      promptText: 'prompt_text',
      audioUrl: 'audio_url',
      errorCode: 'error_code',
      errorMessage: 'error_message',
    };
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [k, col] of Object.entries(map)) {
      const val = (patch as Record<string, unknown>)[k];
      if (val !== undefined) {
        sets.push(`${col} = ?`);
        params.push((k === 'startedAt' || k === 'endedAt') && val ? toUtcMysql(String(val)) : val);
      }
    }
    if (sets.length === 0) return this.getVoiceCallById(tenantId, callId);
    params.push(callId, tenantId);
    await this.pool.execute(
      `UPDATE voice_calls SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`,
      params as (string | number | Date | null)[]
    );
    return this.getVoiceCallById(tenantId, callId);
  }

  async addOrderEvent(event: OrderEvent): Promise<OrderEvent> {
    const id = event.id || crypto.randomUUID();
    await this.pool.execute(
      `INSERT INTO order_events (id, tenant_id, order_id, call_id, event_type, source, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        event.tenantId,
        event.orderId,
        event.callId,
        event.eventType,
        event.source,
        event.metadata ? JSON.stringify(event.metadata) : null,
        toUtcMysql(event.createdAt || new Date()),
      ]
    );
    return { ...event, id };
  }

  async listOrderEvents(tenantId: string, orderId: string): Promise<OrderEvent[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT * FROM order_events WHERE tenant_id = ? AND order_id = ? ORDER BY created_at ASC',
      [tenantId, orderId]
    );
    return rows.map((r) => this.mapOrderEvent(r));
  }

  async listRecentErrorEvents(tenantId: string, limit = 100): Promise<OrderEvent[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM order_events
       WHERE tenant_id = ? AND (event_type LIKE '%error%' OR event_type LIKE '%failed%' OR event_type LIKE '%dlq%' OR event_type LIKE '%rejected%' OR event_type LIKE '%pending_sync%')
       ORDER BY created_at DESC LIMIT ${Math.min(500, Math.max(1, Number(limit)))}`,
      [tenantId]
    );
    return rows.map((r) => this.mapOrderEvent(r));
  }

  async createCustomerInstruction(instr: CustomerInstruction): Promise<CustomerInstruction> {
    await this.pool.execute(
      `INSERT INTO customer_instructions
       (id, tenant_id, order_id, channel, sender_phone_e164, message_text, provider_message_id, received_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        instr.id,
        instr.tenantId,
        instr.orderId,
        instr.channel,
        instr.senderPhoneE164,
        instr.messageText,
        instr.providerMessageId,
        toUtcMysql(instr.receivedAt),
        instr.status,
      ]
    );
    return instr;
  }

  async listInstructionsByOrder(tenantId: string, orderId: string): Promise<CustomerInstruction[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT * FROM customer_instructions WHERE tenant_id = ? AND order_id = ? ORDER BY received_at DESC',
      [tenantId, orderId]
    );
    return rows.map((r) => this.mapInstruction(r));
  }

  async listInstructionsByTenant(tenantId: string, limit = 100): Promise<CustomerInstruction[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM customer_instructions WHERE tenant_id = ? ORDER BY received_at DESC LIMIT ${Math.min(500, Math.max(1, Number(limit)))}`,
      [tenantId]
    );
    return rows.map((r) => this.mapInstruction(r));
  }

  async upsertProviderCredential(cred: ProviderCredential): Promise<ProviderCredential> {
    await this.pool.execute(
      `INSERT INTO provider_credentials (id, tenant_id, provider, config_json, encrypted_secret, iv, auth_tag, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         config_json = VALUES(config_json), encrypted_secret = VALUES(encrypted_secret),
         iv = VALUES(iv), auth_tag = VALUES(auth_tag), status = VALUES(status)`,
      [
        cred.id,
        cred.tenantId,
        cred.provider,
        cred.config ? JSON.stringify(cred.config) : null,
        cred.encryptedSecret,
        cred.iv,
        cred.authTag,
        cred.status,
      ]
    );
    return (await this.getProviderCredential(cred.tenantId, cred.provider))!;
  }

  async getProviderCredential(tenantId: string, provider: string): Promise<ProviderCredential | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT * FROM provider_credentials WHERE tenant_id = ? AND provider = ?',
      [tenantId, provider]
    );
    return rows[0] ? this.mapCredential(rows[0]) : null;
  }

  async listProviderCredentials(tenantId: string): Promise<ProviderCredential[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT * FROM provider_credentials WHERE tenant_id = ? ORDER BY provider ASC',
      [tenantId]
    );
    return rows.map((r) => this.mapCredential(r));
  }

  async recordCallbackIfNew(tenantId: string, provider: string, providerEventId: string): Promise<boolean> {
    try {
      await this.pool.execute(
        'INSERT INTO provider_callback_dedup (id, tenant_id, provider, provider_event_id) VALUES (?, ?, ?, ?)',
        [crypto.randomUUID(), tenantId, provider, providerEventId]
      );
      return true;
    } catch (err: unknown) {
      const mysqlErr = err as { code?: string };
      if (mysqlErr.code === 'ER_DUP_ENTRY') return false;
      throw err;
    }
  }

  async addOptOut(tenantId: string, phoneE164: string, reason?: string): Promise<void> {
    await this.pool.execute(
      `INSERT IGNORE INTO customer_opt_outs (id, tenant_id, phone_e164, reason) VALUES (?, ?, ?, ?)`,
      [crypto.randomUUID(), tenantId, phoneE164, reason ?? null]
    );
  }

  async isPhoneOptedOut(tenantId: string, phoneE164: string): Promise<boolean> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT COUNT(*) AS cnt FROM customer_opt_outs WHERE tenant_id = ? AND phone_e164 = ?',
      [tenantId, phoneE164]
    );
    return Number(rows[0]?.cnt ?? 0) > 0;
  }

  async getUsageMetrics(tenantId: string): Promise<UsageMetrics> {
    const [orderRows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT
        COUNT(*) AS totalOrders,
        SUM(verification_status = 'confirmed') AS confirmed,
        SUM(verification_status = 'cancellation_requested') AS cancellationRequests,
        SUM(verification_status = 'cancelled') AS cancelled,
        SUM(verification_status = 'whatsapp_requested') AS whatsappRequested,
        SUM(verification_status = 'no_response') AS noResponse,
        SUM(verification_status = 'invalid_input') AS invalidInput,
        SUM(store_sync_status IN ('pending_sync', 'failed')) AS pendingStoreSync
       FROM orders WHERE tenant_id = ?`,
      [tenantId]
    );
    const [callRows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT
        COUNT(*) AS totalAttempts,
        SUM(call_status IN ('answered', 'completed')) AS answered,
        SUM(call_status IN ('no_answer', 'busy')) AS noAnswer,
        SUM(call_status = 'failed') AS failed,
        COALESCE(SUM(duration_sec), 0) AS totalSeconds
       FROM voice_calls WHERE tenant_id = ?`,
      [tenantId]
    );
    const o = orderRows[0] || {};
    const c = callRows[0] || {};
    const estimatedVoiceMinutes = Number((Number(c.totalSeconds || 0) / 60).toFixed(2));
    return {
      totalOrders: Number(o.totalOrders || 0),
      totalAttempts: Number(c.totalAttempts || 0),
      answered: Number(c.answered || 0),
      confirmed: Number(o.confirmed || 0),
      cancellationRequests: Number(o.cancellationRequests || 0),
      cancelled: Number(o.cancelled || 0),
      whatsappRequested: Number(o.whatsappRequested || 0),
      noAnswer: Number(c.noAnswer || 0),
      noResponse: Number(o.noResponse || 0),
      invalidInput: Number(o.invalidInput || 0),
      failed: Number(c.failed || 0),
      pendingStoreSync: Number(o.pendingStoreSync || 0),
      estimatedVoiceMinutes,
      estimatedTelephonyCostBdt: Number((estimatedVoiceMinutes * 0.6).toFixed(2)),
    };
  }

  async listPendingSyncOrders(tenantId: string): Promise<Order[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM orders WHERE tenant_id = ? AND store_sync_status IN ('pending_sync', 'failed') ORDER BY updated_at DESC`,
      [tenantId]
    );
    const result: Order[] = [];
    for (const r of rows) {
      result.push(this.mapOrder(r, await this.getItemsForOrder(r.id)));
    }
    return result;
  }

  async listFailedCallJobs(tenantId: string): Promise<CallJob[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM call_jobs WHERE tenant_id = ? AND status IN ('failed', 'dead_letter') ORDER BY updated_at DESC`,
      [tenantId]
    );
    return rows.map((r) => this.mapCallJob(r));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async getItemsForOrder(orderId: string): Promise<OrderItem[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>('SELECT * FROM order_items WHERE order_id = ?', [orderId]);
    return rows.map((r) => ({
      id: r.id,
      orderId: r.order_id,
      productName: r.product_name,
      sku: r.sku ?? null,
      category: r.category ?? null,
      variant: r.variant,
      colour: r.colour,
      size: r.size,
      attributes: parseJsonField<Record<string, string | number | null> | null>(r.attributes_json, null),
      quantity: Number(r.quantity),
      unitPrice: Number(r.unit_price),
    }));
  }

  private mapTenant(r: RowDataPacket): Tenant {
    return {
      id: r.id,
      name: r.name,
      slug: r.slug,
      status: r.status,
      timezone: r.timezone,
      createdAt: toIso(r.created_at),
      updatedAt: toIso(r.updated_at),
    };
  }

  private mapOrder(r: RowDataPacket, items: OrderItem[]): Order {
    return {
      id: r.id,
      tenantId: r.tenant_id,
      externalOrderId: r.external_order_id,
      storeProvider: r.store_provider,
      phoneE164: r.phone_e164,
      customerName: r.customer_name,
      totalAmount: Number(r.total_amount),
      currency: r.currency,
      orderStatus: r.order_status,
      verificationStatus: r.verification_status,
      consentGranted: Boolean(r.consent_granted),
      storeSyncStatus: r.store_sync_status,
      storeSyncError: r.store_sync_error,
      items,
      createdAt: toIso(r.created_at),
      updatedAt: toIso(r.updated_at),
    };
  }

  private mapCallJob(r: RowDataPacket): CallJob {
    return {
      id: r.id,
      tenantId: r.tenant_id,
      orderId: r.order_id,
      status: r.status,
      scheduledAt: toIso(r.scheduled_at),
      attemptNo: Number(r.attempt_no),
      maxAttempts: Number(r.max_attempts),
      idempotencyKey: r.idempotency_key,
      lastError: r.last_error,
      createdAt: toIso(r.created_at),
      updatedAt: toIso(r.updated_at),
    };
  }

  private mapVoiceCall(r: RowDataPacket): VoiceCall {
    return {
      id: r.id,
      tenantId: r.tenant_id,
      callJobId: r.call_job_id,
      orderId: r.order_id,
      providerCallId: r.provider_call_id,
      startedAt: r.started_at ? toIso(r.started_at) : null,
      endedAt: r.ended_at ? toIso(r.ended_at) : null,
      durationSec: Number(r.duration_sec || 0),
      callStatus: r.call_status,
      dtmfResult: r.dtmf_result,
      replayCount: Number(r.replay_count || 0),
      invalidAttempts: Number(r.invalid_attempts || 0),
      promptText: r.prompt_text,
      audioUrl: r.audio_url,
      errorCode: r.error_code,
      errorMessage: r.error_message,
      createdAt: toIso(r.created_at),
      updatedAt: toIso(r.updated_at),
    };
  }

  private mapOrderEvent(r: RowDataPacket): OrderEvent {
    return {
      id: r.id,
      tenantId: r.tenant_id,
      orderId: r.order_id,
      callId: r.call_id,
      eventType: r.event_type,
      source: r.source,
      metadata: parseJsonField<Record<string, unknown> | null>(r.metadata_json, null),
      createdAt: toIso(r.created_at),
    };
  }

  private mapInstruction(r: RowDataPacket): CustomerInstruction {
    return {
      id: r.id,
      tenantId: r.tenant_id,
      orderId: r.order_id,
      channel: r.channel,
      senderPhoneE164: r.sender_phone_e164,
      messageText: r.message_text,
      providerMessageId: r.provider_message_id,
      receivedAt: toIso(r.received_at),
      status: r.status,
      createdAt: toIso(r.created_at),
    };
  }

  private mapCredential(r: RowDataPacket): ProviderCredential {
    return {
      id: r.id,
      tenantId: r.tenant_id,
      provider: r.provider,
      config: parseJsonField<Record<string, unknown> | null>(r.config_json, null),
      encryptedSecret: r.encrypted_secret,
      iv: r.iv,
      authTag: r.auth_tag,
      status: r.status,
      updatedAt: toIso(r.updated_at),
    };
  }
}
