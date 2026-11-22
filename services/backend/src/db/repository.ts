import {
  CallJob,
  CallJobStatus,
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

export interface CreateOrderInput {
  id: string;
  tenantId: string;
  externalOrderId: string;
  storeProvider: Order['storeProvider'];
  phoneE164: string;
  customerName: string;
  totalAmount: number;
  currency: string;
  orderStatus: string;
  verificationStatus: VerificationStatus;
  consentGranted: boolean;
  items: Omit<OrderItem, 'orderId'>[];
}

export interface UsageMetrics {
  totalOrders: number;
  totalAttempts: number;
  answered: number;
  confirmed: number;
  cancellationRequests: number;
  cancelled: number;
  whatsappRequested: number;
  noAnswer: number;
  noResponse: number;
  invalidInput: number;
  failed: number;
  pendingStoreSync: number;
  estimatedVoiceMinutes: number;
  estimatedTelephonyCostBdt: number;
}

export interface FlowMindRepository {
  // Tenants & Users
  upsertTenant(tenant: Tenant): Promise<void>;
  getTenantById(id: string): Promise<Tenant | null>;
  getTenantBySlug(slug: string): Promise<Tenant | null>;
  listTenants(): Promise<Tenant[]>;

  upsertUser(user: User): Promise<void>;
  getUserByEmail(email: string): Promise<User | null>;

  // Voice Settings
  upsertVoiceSettings(settings: VoiceSettings): Promise<VoiceSettings>;
  getVoiceSettings(tenantId: string): Promise<VoiceSettings | null>;

  // Orders & Items (tenant-scoped)
  createOrder(input: CreateOrderInput): Promise<{ order: Order; duplicate: boolean }>;
  getOrderById(tenantId: string, orderId: string): Promise<Order | null>;
  getOrderByIdUnsafe(orderId: string): Promise<Order | null>;
  getOrderByExternalId(tenantId: string, externalOrderId: string): Promise<Order | null>;
  listOrders(tenantId: string, limit?: number): Promise<Order[]>;
  findRecentWhatsAppOrderByPhone(tenantId: string, phoneE164: string): Promise<Order | null>;
  updateOrderState(
    tenantId: string,
    orderId: string,
    patch: {
      orderStatus?: string;
      verificationStatus?: VerificationStatus;
      storeSyncStatus?: StoreSyncStatus;
      storeSyncError?: string | null;
    }
  ): Promise<Order | null>;

  // Call Jobs
  createCallJob(job: CallJob): Promise<{ job: CallJob; duplicate: boolean }>;
  getCallJobById(tenantId: string, jobId: string): Promise<CallJob | null>;
  hasActiveCallJob(tenantId: string, orderId: string): Promise<boolean>;
  listCallJobsByOrder(tenantId: string, orderId: string): Promise<CallJob[]>;
  updateCallJob(
    tenantId: string,
    jobId: string,
    patch: Partial<Pick<CallJob, 'status' | 'scheduledAt' | 'attemptNo' | 'lastError'>>
  ): Promise<CallJob | null>;
  cancelPendingJobsForOrder(tenantId: string, orderId: string, reason: string): Promise<number>;

  // Voice Calls
  createVoiceCall(call: VoiceCall): Promise<VoiceCall>;
  getVoiceCallById(tenantId: string, callId: string): Promise<VoiceCall | null>;
  getVoiceCallByProviderId(providerCallId: string): Promise<VoiceCall | null>;
  listVoiceCalls(tenantId: string, limit?: number): Promise<VoiceCall[]>;
  listVoiceCallsByOrder(tenantId: string, orderId: string): Promise<VoiceCall[]>;
  updateVoiceCall(
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
  ): Promise<VoiceCall | null>;

  // Audit Events
  addOrderEvent(event: OrderEvent): Promise<OrderEvent>;
  listOrderEvents(tenantId: string, orderId: string): Promise<OrderEvent[]>;
  listRecentErrorEvents(tenantId: string, limit?: number): Promise<OrderEvent[]>;

  // Customer Instructions (WhatsApp)
  createCustomerInstruction(instr: CustomerInstruction): Promise<CustomerInstruction>;
  listInstructionsByOrder(tenantId: string, orderId: string): Promise<CustomerInstruction[]>;
  listInstructionsByTenant(tenantId: string, limit?: number): Promise<CustomerInstruction[]>;

  // Provider Credentials (Encrypted)
  upsertProviderCredential(cred: ProviderCredential): Promise<ProviderCredential>;
  getProviderCredential(tenantId: string, provider: string): Promise<ProviderCredential | null>;
  listProviderCredentials(tenantId: string): Promise<ProviderCredential[]>;

  // Callback Deduplication & Opt-Outs
  recordCallbackIfNew(tenantId: string, provider: string, providerEventId: string): Promise<boolean>;
  addOptOut(tenantId: string, phoneE164: string, reason?: string): Promise<void>;
  isPhoneOptedOut(tenantId: string, phoneE164: string): Promise<boolean>;

  // Dashboard Aggregations
  getUsageMetrics(tenantId: string): Promise<UsageMetrics>;
  listPendingSyncOrders(tenantId: string): Promise<Order[]>;
  listFailedCallJobs(tenantId: string): Promise<CallJob[]>;
  close(): Promise<void>;
}
