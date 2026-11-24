export type RealtimeAgentState =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'interrupted'
  | 'ended';

export interface SpeculativeProductMatch {
  sku: string;
  product_name: string;
  bangla_name: string;
  category: string;
  unit_price: number;
  required_attributes: string[];
  required_labels: string[];
  attribute_options: Record<string, string[]>;
}

export interface RealtimeDraftItem {
  sku: string;
  product_name: string;
  bangla_name?: string;
  category: string;
  quantity: number;
  quantity_text: string;
  unit_price: number;
  required_attributes: string[];
  collected_attributes: Record<string, string>;
  missing_attributes: string[];
}

export interface RealtimeGuardrailViolation {
  code: string;
  severity: 'low' | 'medium' | 'high';
  field: string;
  message: string;
}

export interface RealtimeGuardrailReport {
  passed: boolean;
  deterministic_total_bdt: number;
  violations: RealtimeGuardrailViolation[];
}

export interface RealtimeLatencyMetrics {
  ragMs: number;
  reasoningMs: number;
  ttsTtfbMs: number;
  totalMouthToEarMs: number;
  semanticTurnReason?: string;
  recommendedSilenceMs?: number;
}

export interface RealtimeTranscriptMessage {
  id: string;
  turnId?: string;
  role: 'user' | 'assistant';
  text: string;
  interrupted?: boolean;
  discardedText?: string;
  timestamp: string;
}

export interface RealtimeTraceSignal {
  key: string;
  value: string;
}

export interface RealtimeTokenResponse {
  transport: 'livekit' | 'websocket-full-duplex';
  wsUrl: string;
  roomName: string;
  livekitUrl: string | null;
  livekitToken: string | null;
  sessionContext: {
    tenantId: string;
    customerName: string;
    customerPhone: string;
    previousOrdersSummary: string;
    savedAddress: string;
    voiceName: string;
  };
}
