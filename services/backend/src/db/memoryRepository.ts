import crypto from 'crypto';
import {
  CallJob,
  CustomerInstruction,
  Order,
  OrderEvent,
  ProviderCredential,
  StoreSyncStatus,
  Tenant,
  User,
  VerificationStatus,
  VoiceCall,
  VoiceSettings,
} from '../domain/types';
import { CreateOrderInput, FlowMindRepository, UsageMetrics } from './repository';

const ACTIVE_JOB_STATUSES = new Set(['queued', 'scheduled', 'in_progress', 'retry_scheduled']);

export class MemoryRepository implements FlowMindRepository {
  private tenants = new Map<string, Tenant>();
  private users = new Map<string, User>();
  private settings = new Map<string, VoiceSettings>();
  private orders = new Map<string, Order>();
  private orderExternalIndex = new Map<string, string>(); // `${tenantId}:${externalOrderId}` -> orderId
  private callJobs = new Map<string, CallJob>();
  private idempotencyIndex = new Map<string, string>(); // idempotencyKey -> jobId
  private voiceCalls = new Map<string, VoiceCall>();
  private orderEvents: OrderEvent[] = [];
  private instructions: CustomerInstruction[] = [];
  private credentials = new Map<string, ProviderCredential>(); // `${tenantId}:${provider}`
  private callbackDedup = new Set<string>(); // `${provider}:${providerEventId}`
  private optOuts = new Set<string>(); // `${tenantId}:${phoneE164}`

  async upsertTenant(tenant: Tenant): Promise<void> {
    this.tenants.set(tenant.id, { ...tenant });
  }

  async getTenantById(id: string): Promise<Tenant | null> {
    return this.tenants.get(id) ? { ...this.tenants.get(id)! } : null;
  }

  async getTenantBySlug(slug: string): Promise<Tenant | null> {
    for (const t of this.tenants.values()) {
      if (t.slug === slug) return { ...t };
    }
    return null;
  }

  async listTenants(): Promise<Tenant[]> {
    return Array.from(this.tenants.values()).map((t) => ({ ...t }));
  }

  async upsertUser(user: User): Promise<void> {
    this.users.set(user.email.toLowerCase(), { ...user });
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const u = this.users.get(email.toLowerCase());
    return u ? { ...u } : null;
  }

  async upsertVoiceSettings(settings: VoiceSettings): Promise<VoiceSettings> {
    const saved = { ...settings, eligibleStatuses: [...settings.eligibleStatuses], updatedAt: new Date().toISOString() };
    this.settings.set(settings.tenantId, saved);
    return { ...saved };
  }

  async getVoiceSettings(tenantId: string): Promise<VoiceSettings | null> {
    const s = this.settings.get(tenantId);
    return s ? { ...s, eligibleStatuses: [...s.eligibleStatuses] } : null;
  }

  async createOrder(input: CreateOrderInput): Promise<{ order: Order; duplicate: boolean }> {
    const idxKey = `${input.tenantId}:${input.externalOrderId}`;
    const existingId = this.orderExternalIndex.get(idxKey);
    if (existingId) {
      return { order: this.cloneOrder(this.orders.get(existingId)!), duplicate: true };
    }
    const now = new Date().toISOString();
    const order: Order = {
      id: input.id,
      tenantId: input.tenantId,
      externalOrderId: input.externalOrderId,
      storeProvider: input.storeProvider,
      phoneE164: input.phoneE164,
      customerName: input.customerName,
      totalAmount: input.totalAmount,
      currency: input.currency,
      orderStatus: input.orderStatus,
      verificationStatus: input.verificationStatus,
      consentGranted: input.consentGranted,
      storeSyncStatus: 'not_required',
      storeSyncError: null,
      items: input.items.map((i) => ({ ...i, orderId: input.id })),
      createdAt: now,
      updatedAt: now,
    };
    this.orders.set(order.id, order);
    this.orderExternalIndex.set(idxKey, order.id);
    return { order: this.cloneOrder(order), duplicate: false };
  }

  async getOrderById(tenantId: string, orderId: string): Promise<Order | null> {
    const o = this.orders.get(orderId);
    if (!o || o.tenantId !== tenantId) return null;
    return this.cloneOrder(o);
  }

  async getOrderByIdUnsafe(orderId: string): Promise<Order | null> {
    const o = this.orders.get(orderId);
    return o ? this.cloneOrder(o) : null;
  }

  async getOrderByExternalId(tenantId: string, externalOrderId: string): Promise<Order | null> {
    const id = this.orderExternalIndex.get(`${tenantId}:${externalOrderId}`);
    if (!id) return null;
    return this.cloneOrder(this.orders.get(id)!);
  }

  async listOrders(tenantId: string, limit = 100): Promise<Order[]> {
    return Array.from(this.orders.values())
      .filter((o) => o.tenantId === tenantId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((o) => this.cloneOrder(o));
  }

  async findRecentWhatsAppOrderByPhone(tenantId: string, phoneE164: string): Promise<Order | null> {
    const matches = Array.from(this.orders.values())
      .filter((o) => o.tenantId === tenantId && o.phoneE164 === phoneE164)
      .sort((a, b) => {
        const aScore = a.verificationStatus === 'whatsapp_requested' ? 1 : 0;
        const bScore = b.verificationStatus === 'whatsapp_requested' ? 1 : 0;
        if (aScore !== bScore) return bScore - aScore;
        return b.updatedAt.localeCompare(a.updatedAt);
      });
    return matches[0] ? this.cloneOrder(matches[0]) : null;
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
    const o = this.orders.get(orderId);
    if (!o || o.tenantId !== tenantId) return null;
    if (patch.orderStatus !== undefined) o.orderStatus = patch.orderStatus;
    if (patch.verificationStatus !== undefined) o.verificationStatus = patch.verificationStatus;
    if (patch.storeSyncStatus !== undefined) o.storeSyncStatus = patch.storeSyncStatus;
    if (patch.storeSyncError !== undefined) o.storeSyncError = patch.storeSyncError;
    o.updatedAt = new Date().toISOString();
    return this.cloneOrder(o);
  }

  async createCallJob(job: CallJob): Promise<{ job: CallJob; duplicate: boolean }> {
    const existingId = this.idempotencyIndex.get(job.idempotencyKey);
    if (existingId) {
      return { job: { ...this.callJobs.get(existingId)! }, duplicate: true };
    }
    const copy = { ...job };
    this.callJobs.set(copy.id, copy);
    this.idempotencyIndex.set(copy.idempotencyKey, copy.id);
    return { job: { ...copy }, duplicate: false };
  }

  async getCallJobById(tenantId: string, jobId: string): Promise<CallJob | null> {
    const j = this.callJobs.get(jobId);
    if (!j || j.tenantId !== tenantId) return null;
    return { ...j };
  }

  async hasActiveCallJob(tenantId: string, orderId: string): Promise<boolean> {
    for (const j of this.callJobs.values()) {
      if (j.tenantId === tenantId && j.orderId === orderId && ACTIVE_JOB_STATUSES.has(j.status)) {
        return true;
      }
    }
    return false;
  }

  async listCallJobsByOrder(tenantId: string, orderId: string): Promise<CallJob[]> {
    return Array.from(this.callJobs.values())
      .filter((j) => j.tenantId === tenantId && j.orderId === orderId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((j) => ({ ...j }));
  }

  async updateCallJob(
    tenantId: string,
    jobId: string,
    patch: Partial<Pick<CallJob, 'status' | 'scheduledAt' | 'attemptNo' | 'lastError'>>
  ): Promise<CallJob | null> {
    const j = this.callJobs.get(jobId);
    if (!j || j.tenantId !== tenantId) return null;
    Object.assign(j, patch, { updatedAt: new Date().toISOString() });
    return { ...j };
  }

  async cancelPendingJobsForOrder(tenantId: string, orderId: string, reason: string): Promise<number> {
    let count = 0;
    for (const j of this.callJobs.values()) {
      if (j.tenantId === tenantId && j.orderId === orderId && ACTIVE_JOB_STATUSES.has(j.status)) {
        j.status = 'cancelled';
        j.lastError = reason;
        j.updatedAt = new Date().toISOString();
        count += 1;
      }
    }
    return count;
  }

  async createVoiceCall(call: VoiceCall): Promise<VoiceCall> {
    const copy = { ...call };
    this.voiceCalls.set(copy.id, copy);
    return { ...copy };
  }

  async getVoiceCallById(tenantId: string, callId: string): Promise<VoiceCall | null> {
    const c = this.voiceCalls.get(callId);
    if (!c || c.tenantId !== tenantId) return null;
    return { ...c };
  }

  async getVoiceCallByProviderId(providerCallId: string): Promise<VoiceCall | null> {
    for (const c of this.voiceCalls.values()) {
      if (c.providerCallId === providerCallId) return { ...c };
    }
    return null;
  }

  async listVoiceCalls(tenantId: string, limit = 100): Promise<VoiceCall[]> {
    return Array.from(this.voiceCalls.values())
      .filter((c) => c.tenantId === tenantId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((c) => ({ ...c }));
  }

  async listVoiceCallsByOrder(tenantId: string, orderId: string): Promise<VoiceCall[]> {
    return Array.from(this.voiceCalls.values())
      .filter((c) => c.tenantId === tenantId && c.orderId === orderId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((c) => ({ ...c }));
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
    const c = this.voiceCalls.get(callId);
    if (!c || c.tenantId !== tenantId) return null;
    Object.assign(c, patch, { updatedAt: new Date().toISOString() });
    return { ...c };
  }

  async addOrderEvent(event: OrderEvent): Promise<OrderEvent> {
    const copy = { ...event, id: event.id || crypto.randomUUID() };
    this.orderEvents.push(copy);
    return { ...copy };
  }

  async listOrderEvents(tenantId: string, orderId: string): Promise<OrderEvent[]> {
    return this.orderEvents
      .filter((e) => e.tenantId === tenantId && e.orderId === orderId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((e) => ({ ...e }));
  }

  async listRecentErrorEvents(tenantId: string, limit = 100): Promise<OrderEvent[]> {
    return this.orderEvents
      .filter(
        (e) =>
          e.tenantId === tenantId &&
          (e.eventType.includes('error') ||
            e.eventType.includes('failed') ||
            e.eventType.includes('dlq') ||
            e.eventType.includes('rejected') ||
            e.eventType.includes('pending_sync'))
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((e) => ({ ...e }));
  }

  async createCustomerInstruction(instr: CustomerInstruction): Promise<CustomerInstruction> {
    const copy = { ...instr };
    this.instructions.push(copy);
    return { ...copy };
  }

  async listInstructionsByOrder(tenantId: string, orderId: string): Promise<CustomerInstruction[]> {
    return this.instructions
      .filter((i) => i.tenantId === tenantId && i.orderId === orderId)
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
      .map((i) => ({ ...i }));
  }

  async listInstructionsByTenant(tenantId: string, limit = 100): Promise<CustomerInstruction[]> {
    return this.instructions
      .filter((i) => i.tenantId === tenantId)
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
      .slice(0, limit)
      .map((i) => ({ ...i }));
  }

  async upsertProviderCredential(cred: ProviderCredential): Promise<ProviderCredential> {
    const key = `${cred.tenantId}:${cred.provider}`;
    const copy = { ...cred, updatedAt: new Date().toISOString() };
    this.credentials.set(key, copy);
    return { ...copy };
  }

  async getProviderCredential(tenantId: string, provider: string): Promise<ProviderCredential | null> {
    const c = this.credentials.get(`${tenantId}:${provider}`);
    return c ? { ...c } : null;
  }

  async listProviderCredentials(tenantId: string): Promise<ProviderCredential[]> {
    return Array.from(this.credentials.values())
      .filter((c) => c.tenantId === tenantId)
      .map((c) => ({ ...c }));
  }

  async recordCallbackIfNew(_tenantId: string, provider: string, providerEventId: string): Promise<boolean> {
    const key = `${provider}:${providerEventId}`;
    if (this.callbackDedup.has(key)) return false;
    this.callbackDedup.add(key);
    return true;
  }

  async addOptOut(tenantId: string, phoneE164: string): Promise<void> {
    this.optOuts.add(`${tenantId}:${phoneE164}`);
  }

  async isPhoneOptedOut(tenantId: string, phoneE164: string): Promise<boolean> {
    return this.optOuts.has(`${tenantId}:${phoneE164}`);
  }

  async getUsageMetrics(tenantId: string): Promise<UsageMetrics> {
    const tenantOrders = Array.from(this.orders.values()).filter((o) => o.tenantId === tenantId);
    const tenantCalls = Array.from(this.voiceCalls.values()).filter((c) => c.tenantId === tenantId);
    const totalSeconds = tenantCalls.reduce((sum, c) => sum + (c.durationSec || 0), 0);
    const estimatedVoiceMinutes = Number((totalSeconds / 60).toFixed(2));
    // Transparent BD SIP trunk estimate (~0.60 BDT/min illustrative carrier cost)
    const estimatedTelephonyCostBdt = Number((estimatedVoiceMinutes * 0.6).toFixed(2));

    return {
      totalOrders: tenantOrders.length,
      totalAttempts: tenantCalls.length,
      answered: tenantCalls.filter((c) => c.callStatus === 'answered' || c.callStatus === 'completed').length,
      confirmed: tenantOrders.filter((o) => o.verificationStatus === 'confirmed').length,
      cancellationRequests: tenantOrders.filter((o) => o.verificationStatus === 'cancellation_requested').length,
      cancelled: tenantOrders.filter((o) => o.verificationStatus === 'cancelled').length,
      whatsappRequested: tenantOrders.filter((o) => o.verificationStatus === 'whatsapp_requested').length,
      noAnswer: tenantCalls.filter((c) => c.callStatus === 'no_answer' || c.callStatus === 'busy').length,
      noResponse: tenantOrders.filter((o) => o.verificationStatus === 'no_response').length,
      invalidInput: tenantOrders.filter((o) => o.verificationStatus === 'invalid_input').length,
      failed: tenantCalls.filter((c) => c.callStatus === 'failed').length,
      pendingStoreSync: tenantOrders.filter((o) => o.storeSyncStatus === 'pending_sync' || o.storeSyncStatus === 'failed').length,
      estimatedVoiceMinutes,
      estimatedTelephonyCostBdt,
    };
  }

  async listPendingSyncOrders(tenantId: string): Promise<Order[]> {
    return Array.from(this.orders.values())
      .filter((o) => o.tenantId === tenantId && (o.storeSyncStatus === 'pending_sync' || o.storeSyncStatus === 'failed'))
      .map((o) => this.cloneOrder(o));
  }

  async listFailedCallJobs(tenantId: string): Promise<CallJob[]> {
    return Array.from(this.callJobs.values())
      .filter((j) => j.tenantId === tenantId && (j.status === 'failed' || j.status === 'dead_letter'))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((j) => ({ ...j }));
  }

  async close(): Promise<void> {
    // No-op for memory store
  }

  private cloneOrder(o: Order): Order {
    return { ...o, items: o.items.map((i) => ({ ...i })) };
  }
}
