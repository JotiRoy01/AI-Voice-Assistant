export type TenantStatus = 'active' | 'suspended' | 'inactive';
export type UserRole = 'super_admin' | 'business_owner' | 'operator';
export type StoreProvider = 'shopify' | 'woocommerce' | 'custom';

export type VerificationStatus =
  | 'pending'
  | 'ineligible'
  | 'queued'
  | 'calling'
  | 'confirmed'
  | 'cancellation_requested'
  | 'cancelled'
  | 'whatsapp_requested'
  | 'no_response'
  | 'invalid_input'
  | 'no_answer'
  | 'failed'
  | 'suppressed_opt_out';

export type StoreSyncStatus = 'not_required' | 'synced' | 'pending_sync' | 'failed';

export type CallJobStatus =
  | 'queued'
  | 'scheduled'
  | 'in_progress'
  | 'completed'
  | 'retry_scheduled'
  | 'failed'
  | 'dead_letter'
  | 'cancelled';

export type VoiceCallStatus =
  | 'initiated'
  | 'ringing'
  | 'answered'
  | 'completed'
  | 'no_answer'
  | 'busy'
  | 'failed'
  | 'cancelled';

export type DtmfResult =
  | '1_confirm'
  | '2_cancel'
  | '3_whatsapp'
  | 'no_input'
  | 'invalid_key'
  | 'none';

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  timezone: string;
  createdAt: string;
  updatedAt: string;
}

export interface User {
  id: string;
  tenantId: string | null;
  email: string;
  passwordHash: string;
  name: string;
  role: UserRole;
  createdAt: string;
}

export interface VoiceSettings {
  tenantId: string;
  enabled: boolean;
  language: string;
  voiceName: string;
  callWindowStart: string; // HH:mm in tenant timezone
  callWindowEnd: string;   // HH:mm in tenant timezone
  retryLimit: number;
  retryIntervalMinutes: number;
  menuReplayLimit: number;
  invalidKeyLimit: number;
  eligibleStatuses: string[];
  whatsappFallbackContact: string;
  ttsProvider: 'local_http' | 'mock';
  telephonyProvider: 'simulator' | 'asterisk_ari' | 'twilio';
  whatsappProvider: 'simulator' | 'meta_cloud';
  updatedAt: string;
}

export interface OrderItem {
  id: string;
  orderId: string;
  productName: string;
  variant: string | null;
  colour: string | null;
  size: string | null;
  quantity: number;
  unitPrice: number;
  sku?: string | null;
  category?: string | null;
  attributes?: Record<string, string | number | null> | null;
}

export interface ProductCatalogEntry {
  id: string;
  tenantId: string;
  sku: string;
  productName: string;
  banglaName: string;
  aliases: string[];
  category: string;
  unitPrice: number;
  currency: string;
  stockQty: number;
  requiredAttributes: string[];
  attributeOptions: Record<string, string[]>;
  description: string;
}

export interface Order {
  id: string;
  tenantId: string;
  externalOrderId: string;
  storeProvider: StoreProvider;
  phoneE164: string;
  customerName: string;
  totalAmount: number;
  currency: string;
  orderStatus: string;
  verificationStatus: VerificationStatus;
  consentGranted: boolean;
  storeSyncStatus: StoreSyncStatus;
  storeSyncError: string | null;
  items: OrderItem[];
  createdAt: string;
  updatedAt: string;
}

export interface CallJob {
  id: string;
  tenantId: string;
  orderId: string;
  status: CallJobStatus;
  scheduledAt: string;
  attemptNo: number;
  maxAttempts: number;
  idempotencyKey: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VoiceCall {
  id: string;
  tenantId: string;
  callJobId: string;
  orderId: string;
  providerCallId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationSec: number;
  callStatus: VoiceCallStatus;
  dtmfResult: DtmfResult;
  replayCount: number;
  invalidAttempts: number;
  promptText: string | null;
  audioUrl: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrderEvent {
  id: string;
  tenantId: string;
  orderId: string;
  callId: string | null;
  eventType: string;
  source: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface CustomerInstruction {
  id: string;
  tenantId: string;
  orderId: string;
  channel: 'whatsapp' | 'manual';
  senderPhoneE164: string;
  messageText: string;
  providerMessageId: string | null;
  receivedAt: string;
  status: 'received' | 'reviewed' | 'applied' | 'delivery_failed';
  createdAt: string;
}

export interface ProviderCredential {
  id: string;
  tenantId: string;
  provider: string;
  config: Record<string, unknown> | null;
  encryptedSecret: string;
  iv: string;
  authTag: string;
  status: 'active' | 'disabled';
  updatedAt: string;
}

export interface AuthContext {
  userId: string;
  tenantId: string | null;
  role: UserRole;
  email: string;
  isInternalService?: boolean;
}
