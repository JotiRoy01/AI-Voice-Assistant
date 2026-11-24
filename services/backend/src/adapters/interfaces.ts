import { Order, StoreProvider } from '../domain/types';

export interface NormalizedStoreOrder {
  externalOrderId: string;
  storeProvider: StoreProvider;
  phoneRaw: string | null;
  customerName: string;
  totalAmount: number;
  currency: string;
  orderStatus: string;
  consentGranted: boolean;
  items: {
    productName: string;
    variant: string | null;
    colour: string | null;
    size: string | null;
    quantity: number;
    unitPrice: number;
    sku?: string | null;
    category?: string | null;
    attributes?: Record<string, string | number | null> | null;
  }[];
}

export interface StoreSyncResult {
  success: boolean;
  providerStatus?: string;
  error?: string;
}

export interface StoreAdapter {
  readonly provider: StoreProvider;
  verifyWebhookSignature(rawBody: Buffer, headers: Record<string, string | string[] | undefined>, secret: string): boolean;
  normalizeOrderPayload(body: Record<string, unknown>): NormalizedStoreOrder;
  confirmOrder(order: Order, config?: Record<string, unknown> | null): Promise<StoreSyncResult>;
  cancelOrder(order: Order, reason: string, config?: Record<string, unknown> | null): Promise<StoreSyncResult>;
}

export interface TtsSynthesisRequest {
  text: string;
  voice: string;
  language: string;
  format?: 'mp3' | 'wav';
}

export interface TtsSynthesisResult {
  audioUrl: string;
  cacheKey: string;
  cached: boolean;
  provider: string;
}

export interface TtsAdapter {
  readonly name: string;
  synthesize(req: TtsSynthesisRequest): Promise<TtsSynthesisResult>;
}

export interface OutboundCallRequest {
  callId: string;
  tenantId: string;
  orderId: string;
  toPhoneE164: string;
  promptText: string;
  audioUrl: string;
  callbackUrl: string;
  menuReplayLimit: number;
  invalidKeyLimit: number;
}

export interface OutboundCallResult {
  providerCallId: string;
  status: 'initiated' | 'ringing';
  provider: string;
}

export interface TelephonyAdapter {
  readonly name: string;
  initiateCall(req: OutboundCallRequest): Promise<OutboundCallResult>;
}

export interface WhatsAppRedirectRequest {
  tenantId: string;
  orderId: string;
  externalOrderId: string;
  toPhoneE164: string;
  customerName: string;
  businessWhatsAppNumber: string;
}

export interface WhatsAppSendResult {
  success: boolean;
  providerMessageId?: string;
  deepLinkUrl: string;
  error?: string;
}

export interface WhatsAppAdapter {
  readonly name: string;
  sendOrderInstructionLink(req: WhatsAppRedirectRequest): Promise<WhatsAppSendResult>;
}
