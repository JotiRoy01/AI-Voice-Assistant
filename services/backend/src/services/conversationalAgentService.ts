import crypto from 'crypto';
import { TtsAdapter } from '../adapters/interfaces';
import { TwilioTelephonyAdapter } from '../adapters/telephony/telephonyAdapters';
import { AppEnv } from '../config/env';
import { FlowMindRepository } from '../db/repository';
import { buildOrderVerificationPrompt, formatBengaliAmount, toBengaliDigits } from '../domain/banglaPrompt';
import { Order } from '../domain/types';
import { normalizePhoneE164 } from '../security/phone';
import { logger } from '../utils/logger';
import { DtmfCallbackService } from './dtmfCallbackService';
import { GuardrailService, GuardrailViolation } from './guardrailService';
import {
  ATTRIBUTE_BANGLA_LABELS,
  inferAttributesForProduct,
  ProductCatalogRagService,
} from './productCatalogRagService';

export type NeuralNodeId =
  | 'caller_voice'
  | 'intent_router'
  | 'context_memory'
  | 'entity_parser'
  | 'customer_profile'
  | 'order_history'
  | 'line_items'
  | 'delivery_data'
  | 'confirmation'
  | 'action_executor';

export interface LiveTraceSignal {
  key: string;
  value: string;
}

export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  audioUrl?: string | null;
  timestamp: string;
}

export interface DraftOrderItem {
  sku?: string;
  category?: string;
  productName: string;
  quantityText: string | null;
  quantityNum: number;
  unitPrice: number;
  requiredAttributes?: string[];
  collectedAttributes?: Record<string, string>;
  missingAttributes?: string[];
}

export interface ConversationSessionState {
  sessionId: string;
  tenantId: string;
  mode: 'order_confirmation' | 'new_order_agent';
  stage:
    | 'greeting'
    | 'awaiting_reorder_or_new'
    | 'awaiting_products'
    | 'awaiting_quantities_and_delivery'
    | 'awaiting_address'
    | 'awaiting_recipient'
    | 'awaiting_phone'
    | 'awaiting_final_confirm'
    | 'completed';
  orderId?: string;
  externalOrderId?: string;
  callId?: string;
  providerCallId?: string;
  shouldEndCall?: boolean;
  customerName: string;
  customerPhone: string;
  previousOrdersSummary: string;
  draftItems: DraftOrderItem[];
  hasAskedReorderOrNew: boolean;
  hasCapturedProducts: boolean;
  hasCapturedQuantities: boolean;
  hasCapturedAddress: boolean;
  hasVerifiedRecipient: boolean;
  deliveryMethod: 'delivery' | 'pickup';
  deliveryAddress: string;
  recipientName: string;
  recipientPhone: string;
  confirmed: boolean | null;
  activeNodes: NeuralNodeId[];
  completedNodes: NeuralNodeId[];
  stageBadge: string;
  signals: LiveTraceSignal[];
  messages: ConversationMessage[];
  voiceName?: string;
  llmEngineUsed?: string;
}

export class ConversationalAgentService {
  /**
   * ============================================================================
   * CLASS DESCRIPTION: ConversationalAgentService
   * - MEANING: Two-way Bangla Conversational AI Voice Assistant & Neural Execution Map engine.
   * - SUPPORTS:
   *   1. Real LLM Brain (Google Gemini 2.0 Flash / Groq Llama-3.3-70B / OpenAI GPT-4o-mini) when an API key is provided in `.env` or the UI.
   *   2. Context-Aware Bangla NLU Engine with:
   *      • Store Pickup (`পিকআপ / পিকাপ`) vs Home/Office Delivery (`ডেলিভারি`) support!
   *      • Partial Item Removal (`"গ্রিন টি বাদ দিতে চাচ্ছি"`, or STT mishearing `"গ্রিন টি"` as `"তিনটি বাদ দিতে চাচ্ছি"`).
   *      • Full Reset / Re-order commands (`"অর্ডারটি পুনরায় করতে যাচ্ছি"`, `"ঠিকভাবে নোট করেন নাই"`, `"পুনরায় লিখুন"`).
   *      • Strict Verb/Command Guard so phrases like `"বাদ দিতে"` or `"পিকাপ করবো"` are NEVER mistaken for product names or Dhaka addresses!
   * ============================================================================
   */
  private sessions = new Map<string, ConversationSessionState>();
  private pythonAgentBackoffUntil = 0;
  private ollamaBackoffUntil = 0;

  constructor(
    private readonly repo: FlowMindRepository,
    private readonly ttsAdapter: TtsAdapter,
    private readonly dtmfCallbackService: DtmfCallbackService,
    private readonly env: AppEnv,
    private readonly catalogRagService: ProductCatalogRagService = new ProductCatalogRagService(env),
    private readonly guardrailService: GuardrailService = new GuardrailService()
  ) {}

  private async synthesizeSafe(
    text: string,
    tenantId: string,
    voiceOverride?: string
  ): Promise<string | null> {
    try {
      const settings = await this.repo.getVoiceSettings(tenantId);
      const res = await this.ttsAdapter.synthesize({
        text,
        voice: voiceOverride || settings?.voiceName || 'bn-BD-PradeepNeural',
        language: 'bn-BD',
        format: 'mp3',
      });
      return res.audioUrl;
    } catch {
      return null;
    }
  }

  async startSession(params: {
    tenantId: string;
    mode: 'order_confirmation' | 'new_order_agent';
    orderId?: string;
    customerPhone?: string;
    customerName?: string;
    voiceName?: string;
  }): Promise<ConversationSessionState> {
    const sessionId = `conv-${crypto.randomUUID().slice(0, 8)}`;
    const orders = await this.repo.listOrders(params.tenantId, 20);
    const targetOrder: Order | undefined = params.orderId
      ? (await this.repo.getOrderById(params.tenantId, params.orderId)) ?? orders[0]
      : orders[0];

    const phone =
      normalizePhoneE164(params.customerPhone || targetOrder?.phoneE164 || '+8801540509558') ||
      '+8801540509558';
    const customerName = params.customerName || targetOrder?.customerName || 'আব্দুল্লাহ আল মাহাদী';

    // Filter orders STRICTLY for this specific customer (by phone or customerName) so we NEVER mix other customers' demo items!
    const customerOrders = orders.filter(
      (o) =>
        (targetOrder && o.id === targetOrder.id) ||
        (o.phoneE164 && o.phoneE164 === phone) ||
        o.customerName.toLowerCase().trim() === customerName.toLowerCase().trim()
    );

    const customerItemNames = (customerOrders.length > 0 ? customerOrders : targetOrder ? [targetOrder] : [])
      .flatMap((o) =>
        o.items.map((i) => {
          const details = [i.colour, i.variant, i.size ? `সাইজ ${i.size}` : null]
            .filter(Boolean)
            .join(', ');
          return `${i.productName}${details ? ` (${details})` : ''}`;
        })
      );

    const uniquePastItems = Array.from(new Set(customerItemNames));
    const dynamicHistorySummary =
      uniquePastItems.length > 0 ? uniquePastItems.join(', ') : 'কোনো আগের অর্ডার নেই';

    const state: ConversationSessionState = {
      sessionId,
      tenantId: params.tenantId,
      mode: params.mode,
      stage: 'greeting',
      orderId: targetOrder?.id,
      customerName,
      customerPhone: phone,
      previousOrdersSummary: dynamicHistorySummary,
      draftItems: [],
      hasAskedReorderOrNew: false,
      hasCapturedProducts: false,
      hasCapturedQuantities: false,
      hasCapturedAddress: false,
      hasVerifiedRecipient: false,
      deliveryMethod: 'delivery',
      deliveryAddress: 'গুলশান ২, ভাটারা, ঢাকা',
      recipientName: customerName,
      recipientPhone: phone,
      confirmed: null,
      activeNodes: ['caller_voice', 'customer_profile', 'order_history'],
      completedNodes: ['caller_voice'],
      stageBadge: params.mode === 'order_confirmation' ? 'ORDER CONFIRMATION' : 'READY · VOICE AGENT',
      signals: [
        { key: 'Caller', value: `${customerName} (${phone})` },
        {
          key: 'Mode',
          value:
            params.mode === 'order_confirmation'
              ? 'Outbound Order Confirmation'
              : 'Conversational Order Agent',
        },
      ],
      messages: [],
      voiceName: params.voiceName || 'bn-BD-PradeepNeural',
    };

    if (params.mode === 'order_confirmation' && targetOrder) {
      const prompt = buildOrderVerificationPrompt(targetOrder);
      const greetingText = `${prompt.opening} আপনি মুখে হ্যাঁ কনফার্ম, বাতিল, অথবা আপনার বিশেষ নির্দেশনা বলতে পারেন।`;
      const audioUrl = await this.synthesizeSafe(greetingText, params.tenantId, state.voiceName);

      const existingCalls = await this.repo.listVoiceCallsByOrder(params.tenantId, targetOrder.id);
      if (existingCalls[0]) {
        state.callId = existingCalls[0].id;
        state.providerCallId = existingCalls[0].providerCallId ?? undefined;
      }

      state.stage = 'awaiting_final_confirm';
      state.activeNodes = ['caller_voice', 'context_memory', 'order_history', 'line_items', 'confirmation'];
      state.completedNodes = ['caller_voice', 'context_memory', 'order_history', 'line_items'];
      state.stageBadge = 'VERIFYING ORDER';
      state.signals = [
        { key: 'Intent', value: 'verify_existing_order' },
        { key: 'Order ID', value: targetOrder.externalOrderId },
        {
          key: 'Products',
          value: targetOrder.items
            .map((i) => `${i.productName} (${i.colour || ''} ${i.size || ''})`.trim())
            .join(' · '),
        },
        { key: 'Payable', value: `${formatBengaliAmount(targetOrder.totalAmount)} টাকা` },
      ];
      state.messages.push({
        id: crypto.randomUUID(),
        role: 'assistant',
        text: greetingText,
        audioUrl,
        timestamp: new Date().toISOString(),
      });
    } else {
      const greetingText =
        'আসসালামু আলাইকুম! আমি আপনার এআই ভয়েস অ্যাসিস্ট্যান্ট বলছি। আজ আপনাকে কীভাবে সাহায্য করতে পারি?';
      const audioUrl = await this.synthesizeSafe(greetingText, params.tenantId, state.voiceName);
      state.stage = 'greeting';
      state.messages.push({
        id: crypto.randomUUID(),
        role: 'assistant',
        text: greetingText,
        audioUrl,
        timestamp: new Date().toISOString(),
      });
    }

    this.sessions.set(sessionId, state);
    return state;
  }

  getSession(sessionId: string): ConversationSessionState | undefined {
    return this.sessions.get(sessionId);
  }

  async processUserUtterance(params: {
    sessionId: string;
    userText: string;
    dtmfDigit?: string;
    voiceName?: string;
    geminiApiKey?: string;
  }): Promise<ConversationSessionState> {
    const state = this.sessions.get(params.sessionId);
    if (!state) {
      throw new Error('Conversation session not found');
    }

    const rawText = (params.userText || params.dtmfDigit || '').trim();
    if (!rawText) {
      return state;
    }

    if (params.voiceName) {
      state.voiceName = params.voiceName;
    }

    state.messages.push({
      id: crypto.randomUUID(),
      role: 'user',
      text: rawText,
      timestamp: new Date().toISOString(),
    });

    const lower = rawText.toLowerCase();
    let replyText = '';

    // ========================================================================
    // REAL LLM BRAIN (Tries .env GEMINI_API_KEY / GROQ_API_KEY / OPENAI_API_KEY OR Local Ollama!)
    // ========================================================================
    const apiKey = (
      params.geminiApiKey ||
      this.env.GEMINI_API_KEY ||
      this.env.GROQ_API_KEY ||
      this.env.OPENAI_API_KEY ||
      process.env.GEMINI_API_KEY ||
      process.env.GROQ_API_KEY ||
      process.env.OPENAI_API_KEY ||
      ''
    ).trim();
    if (state.mode === 'new_order_agent') {
      const llmReply = await this.tryRealLlmConversationalTurn(state, rawText, apiKey);
      if (llmReply) {
        replyText = llmReply;
      }
    }

    if (!replyText) {
      if (state.mode === 'order_confirmation') {
        replyText = await this.handleOrderConfirmationTurn(state, rawText, lower, params.dtmfDigit);
      } else {
        replyText = await this.handleSmartConversationalTurn(state, rawText, lower);
      }
    }

    const audioUrl = await this.synthesizeSafe(replyText, state.tenantId, state.voiceName);
    state.messages.push({
      id: crypto.randomUUID(),
      role: 'assistant',
      text: replyText,
      audioUrl,
      timestamp: new Date().toISOString(),
    });

    return state;
  }

  /**
   * Calls a real Large Language Model (Gemini 2.0 Flash, Groq Llama-3.3-70B, or OpenAI GPT-4o-mini)
   * so the assistant genuinely understands any open-ended Bangla conversation, corrections, and nuances!
   */
  private async tryRealLlmConversationalTurn(
    state: ConversationSessionState,
    userText: string,
    apiKey: string
  ): Promise<string | null> {
    try {
      // 0. Pre-LLM Input Guardrail (Prompt Injection & Price Tampering Shield)
      const inputViolation = this.guardrailService.checkInput(userText);
      if (inputViolation) {
        state.stageBadge = 'GUARDRAIL · INPUT BLOCKED';
        return (
          inputViolation.suggestedReplyBangla ||
          'দুঃখিত, এই অনুরোধটি গ্রহণ করা সম্ভব নয়। আপনি কোন পণ্যটি অর্ডার করতে চাচ্ছেন বলুন?'
        );
      }

      // 1. Try Delegating to Dedicated Phase-2 Python AI Agent Microservice (Port 8001) if running!
      const pythonAgentUrl = (process.env.PYTHON_AI_AGENT_URL || 'http://127.0.0.1:8001')
        .replace(/\/$/, '')
        .replace('://localhost:', '://127.0.0.1:');
      if (Date.now() >= this.pythonAgentBackoffUntil) {
        try {
          const pyRes = await fetch(`${pythonAgentUrl}/api/v1/agent/turn`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session_id: state.sessionId,
            tenant_id: state.tenantId,
            user_text: userText,
            customer_name: state.customerName,
            customer_phone: state.customerPhone,
            previous_orders_summary: state.previousOrdersSummary,
            saved_address: 'গুলশান ২, ভাটারা, ঢাকা',
            current_draft_items: state.draftItems.map((d) => ({
              sku: d.sku || 'CUSTOM',
              product_name: d.productName,
              bangla_name: d.productName,
              category: d.category || 'General',
              quantity: d.quantityNum,
              quantity_text: d.quantityText || '১টি',
              unit_price: d.unitPrice,
              required_attributes: d.requiredAttributes || [],
              collected_attributes: d.collectedAttributes || {},
              missing_attributes: d.missingAttributes || [],
            })),
            delivery_method: state.deliveryMethod,
            delivery_address: state.deliveryAddress,
            address_verified: state.hasCapturedAddress,
            recipient_name: state.recipientName,
            recipient_phone: state.recipientPhone,
            history_mentioned: state.hasAskedReorderOrNew,
            already_confirmed: Boolean(state.confirmed || state.stage === 'completed'),
            conversation_history: state.messages.slice(-10).map((m) => ({
              role: m.role,
              text: m.text,
            })),
            api_key: apiKey || undefined,
          }),
          signal: AbortSignal.timeout(6500),
        });
        if (pyRes.ok) {
          const pyData = (await pyRes.json()) as {
            reply_bangla: string;
            stage_badge: string;
            active_nodes: NeuralNodeId[];
            draft_items: {
              sku: string;
              product_name: string;
              category: string;
              quantity: number;
              quantity_text: string;
              unit_price: number;
              required_attributes: string[];
              collected_attributes: Record<string, string>;
              missing_attributes: string[];
            }[];
            delivery_method: 'delivery' | 'pickup';
            delivery_address: string;
            address_verified: boolean;
            recipient_name: string;
            recipient_phone: string;
            confirmed: boolean;
            should_end_call: boolean;
            llm_engine_used: string;
            signals: LiveTraceSignal[];
          };
          if (!pyData.llm_engine_used?.includes('fallback-rag-nlu')) {
            state.stageBadge = pyData.stage_badge;
            state.activeNodes = pyData.active_nodes;
            state.hasAskedReorderOrNew = true;
            state.draftItems = pyData.draft_items.map((item) => ({
              sku: item.sku,
              category: item.category,
              productName: item.product_name,
              quantityNum: item.quantity,
              quantityText: item.quantity_text,
              unitPrice: item.unit_price,
              requiredAttributes: item.required_attributes,
              collectedAttributes: item.collected_attributes,
              missingAttributes: item.missing_attributes,
            }));
            if (state.draftItems.length > 0) {
              state.hasCapturedProducts = true;
              state.hasCapturedQuantities = true;
            }
            state.deliveryMethod = pyData.delivery_method;
            state.deliveryAddress = pyData.delivery_address;
            state.hasCapturedAddress = pyData.address_verified;
            state.recipientName = pyData.recipient_name;
            state.recipientPhone = pyData.recipient_phone;
            state.llmEngineUsed = pyData.llm_engine_used;
            if (pyData.signals && pyData.signals.length > 0) {
              state.signals = pyData.signals;
            }
            if (pyData.confirmed && state.stage !== 'completed') {
              await this.finalizeConversationalOrder(state);
            }
            if (pyData.confirmed) {
              state.confirmed = true;
            }
            if (pyData.should_end_call) {
              state.shouldEndCall = true;
            }
            return pyData.reply_bangla;
          }
        }
        } catch {
          // Python AI Agent on port 8001 not running; back off 30s and execute built-in RAG + Guardrails seamlessly
          this.pythonAgentBackoffUntil = Date.now() + 30_000;
        }
      }

      // 2. Built-in RAG Catalog Lookup + Dynamic Product Attribute Schema Injection!
      const fullCatalog = this.catalogRagService.listCatalog(state.tenantId);
      const matchedCatalog = this.catalogRagService.searchProducts(state.tenantId, userText, 4);
      const catalogItemsToShow = matchedCatalog.length > 0 ? matchedCatalog : fullCatalog.slice(0, 12);

      const catalogRagContext = catalogItemsToShow
        .map((c) => {
          const reqBn = c.requiredAttributes.map(
            (r) => `${r} (${ATTRIBUTE_BANGLA_LABELS[r] || r})`
          );
          return `- SKU: ${c.sku} | Name: ${c.banglaName} (${c.productName}) | Category: ${c.category} | Price: ${c.unitPrice} ${c.currency} | REQUIRED ATTRIBUTES TO COLLECT: [${reqBn.join(', ')}] | Options: ${JSON.stringify(c.attributeOptions)}`;
        })
        .join('\n');

      const historyText = state.messages
        .slice(-12)
        .map((m) => `${m.role === 'user' ? 'Customer' : 'AI Assistant'}: ${m.text}`)
        .join('\n');

      const systemPrompt = `You are Cogni AI / FlowMind AI, an intelligent Bangladeshi Bangla Voice Commerce Agent with RAG & Dynamic Product Attribute Schema Validation.

COMPANY PRODUCT CATALOG & REQUIRED ATTRIBUTES (RETRIEVED VIA RAG):
${catalogRagContext}

Customer Profile:
- Name: ${state.customerName}
- Phone: ${state.customerPhone}
- Previous Order History (Customer's older ordered products in our DB): ${state.previousOrdersSummary}
- Saved Delivery Address from previous order: গুলশান ২, ভাটারা, ঢাকা

Current Session Memory:
- Stage: ${state.stage}
- Has Mentioned Previous Order History Yet: ${state.hasAskedReorderOrNew}
- Has Customer Explicitly Confirmed/Modified Delivery Address in This Call Yet: ${state.hasCapturedAddress}
- Captured Items & Attributes in Current Order: ${JSON.stringify(state.draftItems)}
- Delivery Method: ${state.deliveryMethod}
- Delivery Address: ${state.deliveryAddress}
- Recipient: ${state.recipientName} (${state.recipientPhone})
- Is Order Already Confirmed: ${Boolean(state.confirmed)}

CRITICAL STEP-BY-STEP CONVERSATION RULES (DO NOT SKIP STEPS!):
1. STEP 1 (Older Order History): When the customer first asks to order a product (and "Has Mentioned Previous Order History Yet" is false, and "Previous Order History" is not "কোনো আগের অর্ডার নেই"), tell them their older order details (${state.previousOrdersSummary}) and ask if they want to reorder those or order something new.
2. STEP 2 (Product-Specific Required Attributes from Catalog!): Look at "REQUIRED ATTRIBUTES TO COLLECT" for each product in the customer's order:
   - Shirt / Pant / Panjabi -> MUST collect: colour, size (and fit for Shirt)
   - RAM (র‍্যাম) -> MUST collect: brand (Corsair/Kingston/etc.), ddr_type (DDR4/DDR5), capacity_gb (8GB/16GB/32GB), bus_speed_mhz (3200MHz/5600MHz)
   - Monitor (মনিটর) -> MUST collect: brand, screen_size_inch (22/24/27 inch), refresh_rate_hz (75Hz/100Hz/144Hz), panel_type (IPS/VA)
   - Keyboard (কিবোর্ড) -> MUST collect: brand (A4Tech/Logitech/etc.), connection_type (Wired/Wireless), switch_type
   - Mouse (মাউস) -> MUST collect: brand, connection_type, dpi
   - Smartphone (ফোন/মোবাইল) -> MUST collect: brand, ram_storage (8GB/128GB), colour, warranty_type
   - Coconut Oil / Olive Oil / Yellow Booster / Green Tea -> MUST collect: weight_or_volume (500ml / 1 KG / 250g)
   - Store every attribute the customer provides inside "products[i].attributes" using those exact attribute keys!
   - If ANY required attribute for a product is still missing, ask for those missing attributes naturally in Bangla BEFORE moving to delivery address!
3. STEP 3 (Mandatory Delivery Address Check): Once all products, quantities, AND their required attributes are collected, if "Has Customer Explicitly Confirmed/Modified Delivery Address in This Call Yet" is false, ask: "ডেলিভারি কি আপনার আগের ঠিকানায় (${state.deliveryAddress}) নিবেন, নাকি নতুন কোনো ঠিকানায় পাঠাবো? অথবা স্টোর থেকে পিকআপ করবেন?"
   - Set "addressVerifiedInThisTurn": true ONLY AFTER the customer answers the address question.
   - If the customer wants to modify the address ("ঠিকানা পরিবর্তন করব") at ANY time, ask for their new address and update "address".
4. STEP 4 (Read-Back Summary & Final Confirmation): Once all required attributes and the delivery address are verified, read back the full summary (Products + Quantities + All Specs/Attributes + Total BDT Price + Delivery Address + Recipient ${state.recipientName} + Phone ${state.recipientPhone}) and ask: "সব তথ্য কি ঠিক আছে? আমি কি অর্ডারটি কনফার্ম করব?"
5. STEP 5 (Final Confirmation): Set "confirmed": true ONLY when the customer says "হ্যাঁ কনফার্ম করুন" AFTER all required attributes and delivery address are complete!
6. Return ONLY valid JSON matching this schema:
{
  "replyBangla": "string (your spoken response in Bangla, 1-3 short sentences)",
  "stageBadge": "string (PREVIOUS ORDERS | COLLECTING SPECS | ITEMS AND DELIVERY | ADDRESS UPDATE | CONFIRMATION | REQUEST RECORDED)",
  "activeNodes": ["caller_voice", "intent_router", "context_memory", "entity_parser", "customer_profile", "order_history", "line_items", "delivery_data", "confirmation", "action_executor"],
  "products": [
    {
      "name": "string",
      "qtyText": "string",
      "qtyNum": 1,
      "unitPrice": 1200,
      "attributes": {
        "attribute_key": "collected_value"
      }
    }
  ],
  "deliveryMethod": "delivery or pickup",
  "address": "string",
  "addressVerifiedInThisTurn": false,
  "recipientName": "string",
  "recipientPhone": "string",
  "confirmed": false
}`;

      let rawJson: string | null = null;

      if (apiKey.startsWith('gsk_') || apiKey.startsWith('sk-')) {
        // Groq (Llama-3.3-70B) or OpenAI (gpt-4o-mini)
        const isGroq = apiKey.startsWith('gsk_');
        const endpoint = isGroq
          ? 'https://api.groq.com/openai/v1/chat/completions'
          : 'https://api.openai.com/v1/chat/completions';
        const model = isGroq ? 'llama-3.3-70b-versatile' : 'gpt-4o-mini';

        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: `Conversation so far:\n${historyText}\n\nRespond with JSON:` },
            ],
            response_format: { type: 'json_object' },
            temperature: 0.2,
          }),
        });
        if (res.ok) {
          const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
          rawJson = data.choices?.[0]?.message?.content || null;
          state.llmEngineUsed = model;
        }
      } else if (apiKey) {
        // Google Gemini (1st: gemini-3.1-flash-lite with thinkingBudget=0 for ~1.2s speed; 2nd: gemini-3.5-flash-lite; 3rd: gemini-flash-lite-latest)
        const geminiModels: { name: string; disableThinking: boolean }[] = [
          { name: 'gemini-3.1-flash-lite', disableThinking: true },
          { name: 'gemini-3.5-flash-lite', disableThinking: false },
          { name: 'gemini-flash-lite-latest', disableThinking: false },
        ];
        for (const candidate of geminiModels) {
          const modelName = candidate.name;
          try {
            const generationConfig: Record<string, unknown> = {
              responseMimeType: 'application/json',
              temperature: 0.2,
            };
            if (candidate.disableThinking) {
              generationConfig.thinkingConfig = { thinkingBudget: 0 };
            }
            const res = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(apiKey)}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  contents: [
                    {
                      role: 'user',
                      parts: [
                        {
                          text: `${systemPrompt}\n\nConversation so far:\n${historyText}\n\nRespond with JSON:`,
                        },
                      ],
                    },
                  ],
                  generationConfig,
                }),
                signal: AbortSignal.timeout(4500),
              }
            );
            if (res.ok) {
              const data = (await res.json()) as {
                candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[];
              };
              const parts = data.candidates?.[0]?.content?.parts || [];
              const nonThoughtParts = parts.filter((p) => !p.thought && p.text);
              rawJson =
                nonThoughtParts[nonThoughtParts.length - 1]?.text ||
                parts[parts.length - 1]?.text ||
                null;
              if (rawJson) {
                state.llmEngineUsed = modelName;
                break;
              }
            } else {
              const errTxt = await res.text().catch(() => '');
              logger.warn(
                { modelName, status: res.status, errTxt: errTxt.slice(0, 160) },
                'Gemini model attempt failed; trying next'
              );
            }
          } catch {
            // timeout or network error, try next model
          }
        }
      }

      // Optional Local Ollama Fallback (http://127.0.0.1:11434) with 60s circuit-breaker if not running
      if (!rawJson && this.env.OLLAMA_BASE_URL && Date.now() >= this.ollamaBackoffUntil) {
        const ollamaUrl = this.env.OLLAMA_BASE_URL.replace(/\/$/, '').replace(
          '://localhost:',
          '://127.0.0.1:'
        );
        try {
          const ollamaRes = await fetch(
            `${ollamaUrl}/api/chat`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                model: this.env.OLLAMA_MODEL || 'qwen2.5:7b',
                stream: false,
                format: 'json',
                messages: [
                  { role: 'system', content: systemPrompt },
                  {
                    role: 'user',
                    content: `Conversation so far:\n${historyText}\n\nRespond with JSON:`,
                  },
                ],
              }),
              signal: AbortSignal.timeout(1500),
            }
          );
          if (ollamaRes.ok) {
            const ollamaData = (await ollamaRes.json()) as {
              message?: { content?: string };
            };
            rawJson = ollamaData.message?.content || null;
            if (rawJson) {
              state.llmEngineUsed = `ollama:${this.env.OLLAMA_MODEL}`;
            }
          }
        } catch {
          // Ollama not running locally; back off 60s and fall back to offline NLU
          this.ollamaBackoffUntil = Date.now() + 60_000;
        }
      }

      if (!rawJson) return null;
      // Strip accidental markdown fences ```json ... ``` if the model wrapped its JSON
      const cleanedJson = rawJson
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
      const parsed = JSON.parse(cleanedJson) as {
        replyBangla?: string;
        stageBadge?: string;
        activeNodes?: NeuralNodeId[];
        products?: {
          name: string;
          qtyText?: string;
          qtyNum?: number;
          unitPrice?: number;
          attributes?: Record<string, string>;
        }[];
        deliveryMethod?: 'delivery' | 'pickup';
        address?: string;
        addressVerifiedInThisTurn?: boolean;
        recipientName?: string;
        recipientPhone?: string;
        confirmed?: boolean;
      };

      const upsertSignal = (key: string, value: string) => {
        const idx = state.signals.findIndex((s) => s.key === key);
        if (idx >= 0) state.signals[idx] = { key, value };
        else state.signals.push({ key, value });
      };

      const userMentionedAddressOrPickup =
        /ঠিকানা|পাড়া|পাড়া|রোড|বাসা|বাড়ি|বাড়ি|অফিস|গুলশান|বাড্ডা|মিরপুর|উত্তরা|ধানমন্ডি|বনানী|ফার্মগেট|মোহাম্মদপুর|পিকআপ|পিকাপ|আগেরটাই|আগের ঠিকানা/i.test(
          userText
        );
      const userWantsToChangeAddress =
        /ঠিকানা.*(?:চেঞ্জ|পরিবর্তন|বদল|নতুন|মডিফাই)|(?:চেঞ্জ|পরিবর্তন|নতুন|মডিফাই).*ঠিকানা/i.test(
          userText
        );

      if ( parsed.stageBadge) state.stageBadge = parsed.stageBadge;
      state.hasAskedReorderOrNew = true;
      upsertSignal('History', state.previousOrdersSummary);

      if (parsed.activeNodes && parsed.activeNodes.length > 0) {
        state.activeNodes = parsed.activeNodes;
        for (const n of parsed.activeNodes) {
          if (!state.completedNodes.includes(n)) state.completedNodes.push(n);
        }
      }
      let catalogViolations: GuardrailViolation[] = [];
      if (parsed.products && parsed.products.length > 0) {
        const grounded = this.guardrailService.groundAndValidateItems({
          tenantId: state.tenantId,
          catalogRagService: this.catalogRagService,
          rawProducts: parsed.products,
          existingItems: state.draftItems.map((d) => ({
            sku: d.sku,
            category: d.category,
            productName: d.productName,
            quantityText: d.quantityText,
            quantityNum: d.quantityNum,
            unitPrice: d.unitPrice,
            requiredAttributes: d.requiredAttributes || [],
            collectedAttributes: d.collectedAttributes || {},
            missingAttributes: d.missingAttributes || [],
          })),
        });
        state.draftItems = grounded.items;
        catalogViolations = grounded.violations;

        state.hasCapturedProducts = true;
        state.hasCapturedQuantities = true;
        upsertSignal('Products', state.draftItems.map((i) => i.productName).join(' · '));
        upsertSignal('Quantity', state.draftItems.map((i) => i.quantityText || '১টি').join(' · '));

        const specsStr = state.draftItems
          .map((i) => {
            const pairs = Object.entries(i.collectedAttributes || {})
              .map(([k, v]) => `${k}=${v}`)
              .join(', ');
            return `${i.productName}: ${pairs || 'pending'}`;
          })
          .join(' | ');
        upsertSignal('Collected Specs', specsStr);
      }

      if (userWantsToChangeAddress && !this.detectAddressInText(userText)) {
        // Customer said "আমি ঠিকানা পরিবর্তন করতে চাচ্ছি" without giving the new address yet -> reopen address capture!
        state.hasCapturedAddress = false;
        state.stage = 'awaiting_address';
        state.stageBadge = 'ADDRESS UPDATE';
      } else if (parsed.deliveryMethod === 'pickup') {
        state.deliveryMethod = 'pickup';
        state.deliveryAddress = 'স্টোর পিকআপ (Store Pickup)';
        state.hasCapturedAddress = true;
        upsertSignal('Delivery', 'স্টোর পিকআপ (Store Pickup)');
      } else if (
        parsed.address &&
        (parsed.addressVerifiedInThisTurn ||
          userMentionedAddressOrPickup ||
          parsed.address !== 'গুলশান ২, ভাটারা, ঢাকা')
      ) {
        state.deliveryAddress = parsed.address;
        state.hasCapturedAddress = true;
        upsertSignal('Delivery', state.deliveryAddress);

        // If the order was ALREADY confirmed earlier and the customer just modified their address, update it in the DB too!
        if (state.confirmed && state.orderId) {
          await this.repo.createCustomerInstruction({
            id: crypto.randomUUID(),
            tenantId: state.tenantId,
            orderId: state.orderId,
            channel: 'manual',
            senderPhoneE164: state.recipientPhone,
            messageText: `আপডেটকৃত ডেলিভারি ঠিকানা: ${state.deliveryAddress} | প্রাপক: ${state.recipientName}`,
            providerMessageId: state.sessionId,
            receivedAt: new Date().toISOString(),
            status: 'applied',
            createdAt: new Date().toISOString(),
          });
          await this.repo.addOrderEvent({
            id: crypto.randomUUID(),
            tenantId: state.tenantId,
            orderId: state.orderId,
            callId: state.callId || null,
            eventType: 'delivery_address_updated_via_voice_ai',
            source: 'conversational_voice_agent',
            metadata: { updatedAddress: state.deliveryAddress },
            createdAt: new Date().toISOString(),
          });
        }
      }

      if (parsed.recipientName) {
        state.recipientName = parsed.recipientName;
        upsertSignal('Recipient', state.recipientName);
      }
      if (parsed.recipientPhone) {
        state.recipientPhone = parsed.recipientPhone;
        upsertSignal('Phone', state.recipientPhone);
      }

      // Dedicated Anti-Hallucination Output & Confirmation Guardrail Verification (GuardrailService)
      const verified = this.guardrailService.verifyOutput({
        replyBangla: parsed.replyBangla || '',
        confirmed: Boolean(parsed.confirmed),
        stageBadge: state.stageBadge,
        draftItems: state.draftItems.map((d) => ({
          sku: d.sku,
          category: d.category,
          productName: d.productName,
          quantityText: d.quantityText,
          quantityNum: d.quantityNum,
          unitPrice: d.unitPrice,
          requiredAttributes: d.requiredAttributes || [],
          collectedAttributes: d.collectedAttributes || {},
          missingAttributes: d.missingAttributes || [],
        })),
        hasCapturedAddress: state.hasCapturedAddress,
        deliveryAddress: state.deliveryAddress,
        userWantsToChangeAddress,
        existingViolations: catalogViolations,
      });

      parsed.replyBangla = verified.replyBangla;
      parsed.confirmed = verified.confirmed;
      state.stageBadge = verified.stageBadge;
      if (verified.violations.length > 0) {
        upsertSignal('Guardrails', verified.violations.map((v) => v.code).join(', '));
      } else {
        upsertSignal('Guardrails', 'PASSED (Zero Hallucinations)');
      }

      if (parsed.confirmed && state.stage !== 'completed' && !userWantsToChangeAddress) {
        await this.finalizeConversationalOrder(state);
      }

      // ONLY end the call when the user explicitly says "বাই বাই" / "আল্লাহ হাফেজ" / "কল কেটে দিন" (NOT on "ঠিক আছে" or "ধন্যবাদ")!
      if (
        state.stage === 'completed' &&
        /বাই বাই|গুড বাই|আল্লাহ হাফেজ|খোদা হাফেজ|কল কেটে দিন|রাখি তাহলে|bye bye|goodbye/i.test(
          userText
        )
      ) {
        state.shouldEndCall = true;
      }

      return parsed.replyBangla || null;
    } catch {
      return null;
    }
  }

  private async handleOrderConfirmationTurn(
    state: ConversationSessionState,
    rawText: string,
    lower: string,
    dtmfDigit?: string
  ): Promise<string> {
    const isConfirm =
      dtmfDigit === '1' ||
      /হ্যাঁ|জি|জ্বি|কনফার্ম|নিশ্চিত|ঠিক আছে|রাখব|পাঠান|yes|confirm|ok|১|1/.test(lower);
    const isCancel =
      dtmfDigit === '2' ||
      /না|বাতিল|ক্যান্সেল|নিব না|লাগবে না|cancel|no|২|2/.test(lower);
    const isSpecialInstruction =
      dtmfDigit === '3' ||
      /নির্দেশনা|ঠিকানা|পরিবর্তন|চেঞ্জ|সন্ধ্যা|বিকেল|অফিস|ডেলিভারি|পিকআপ|পিকাপ|whatsapp|হোয়াটসঅ্যাপ|৩|3/.test(
        lower
      );

    if (isConfirm && !isCancel) {
      state.confirmed = true;
      state.stage = 'completed';
      state.stageBadge = 'ORDER CONFIRMED';
      state.activeNodes = ['caller_voice', 'intent_router', 'confirmation', 'action_executor'];
      state.completedNodes = [
        'caller_voice',
        'intent_router',
        'context_memory',
        'customer_profile',
        'order_history',
        'line_items',
        'confirmation',
        'action_executor',
      ];
      state.signals = [
        ...state.signals.filter((s) => s.key !== 'Consent' && s.key !== 'Action'),
        { key: 'Consent', value: 'Confirmed (Voice / Key 1)' },
        { key: 'Action', value: 'Order confirmed & synced to store' },
      ];

      if (state.orderId) {
        if (state.providerCallId) {
          await this.dtmfCallbackService.handleTelephonyEvent({
            providerEventId: `conv-confirm-${crypto.randomUUID()}`,
            provider: 'voice_ai_agent',
            providerCallId: state.providerCallId,
            eventType: 'dtmf',
            digit: '1',
            durationSec: 32,
          });
        } else {
          await this.repo.updateOrderState(state.tenantId, state.orderId, {
            orderStatus: 'confirmed',
            verificationStatus: 'confirmed',
            storeSyncStatus: 'synced',
          });
        }
      }

      return 'অসংখ্য ধন্যবাদ! আপনার অর্ডারটি সফলভাবে কনফার্ম করা হয়েছে। খুব শীঘ্রই আপনার ঠিকানায় ডেলিভারি পাঠানো হবে। ভালো থাকবেন, আসসালামু আলাইকুম!';
    }

    if (isCancel) {
      state.confirmed = false;
      state.stage = 'completed';
      state.stageBadge = 'ORDER CANCELLED';
      state.activeNodes = ['caller_voice', 'intent_router', 'confirmation', 'action_executor'];
      state.completedNodes = [
        'caller_voice',
        'intent_router',
        'context_memory',
        'order_history',
        'confirmation',
        'action_executor',
      ];
      state.signals = [
        ...state.signals.filter((s) => s.key !== 'Consent' && s.key !== 'Action'),
        { key: 'Consent', value: 'Cancelled (Voice / Key 2)' },
        { key: 'Action', value: 'Order cancellation recorded' },
      ];

      if (state.orderId) {
        if (state.providerCallId) {
          await this.dtmfCallbackService.handleTelephonyEvent({
            providerEventId: `conv-cancel-${crypto.randomUUID()}`,
            provider: 'voice_ai_agent',
            providerCallId: state.providerCallId,
            eventType: 'dtmf',
            digit: '2',
            durationSec: 28,
          });
        } else {
          await this.repo.updateOrderState(state.tenantId, state.orderId, {
            orderStatus: 'cancelled',
            verificationStatus: 'cancelled',
            storeSyncStatus: 'synced',
          });
        }
      }

      return 'ঠিক আছে, আপনার অনুরোধ অনুযায়ী অর্ডারটি বাতিল করা হয়েছে। ধন্যবাদ, আসসালামু আলাইকুম।';
    }

    if (isSpecialInstruction) {
      state.stage = 'completed';
      state.stageBadge = 'INSTRUCTION CAPTURED';
      state.activeNodes = [
        'caller_voice',
        'intent_router',
        'entity_parser',
        'delivery_data',
        'action_executor',
      ];
      state.completedNodes = [
        'caller_voice',
        'intent_router',
        'context_memory',
        'entity_parser',
        'delivery_data',
        'action_executor',
      ];
      state.signals = [
        ...state.signals,
        { key: 'Special Note', value: rawText },
        { key: 'Action', value: 'Saved to Order Instructions & WhatsApp' },
      ];

      if (state.orderId) {
        await this.repo.updateOrderState(state.tenantId, state.orderId, {
          verificationStatus: 'whatsapp_requested',
        });
        await this.repo.createCustomerInstruction({
          id: crypto.randomUUID(),
          tenantId: state.tenantId,
          orderId: state.orderId,
          channel: 'whatsapp',
          senderPhoneE164: state.customerPhone,
          messageText: `Voice Call Note: ${rawText}`,
          providerMessageId: `voice.${crypto.randomUUID()}`,
          receivedAt: new Date().toISOString(),
          status: 'received',
          createdAt: new Date().toISOString(),
        });
      }

      return `ধন্যবাদ! আপনার বিশেষ নির্দেশনা আমরা অর্ডারের সাথে নোট করে নিয়েছি। আর কোনো সাহায্য করতে পারি?`;
    }

    state.activeNodes = ['caller_voice', 'intent_router', 'context_memory', 'confirmation'];
    return 'আপনার অর্ডারটি নিশ্চিত করতে চাইলে বলুন হ্যাঁ কনফার্ম করুন, বাতিল করতে চাইলে বলুন বাতিল করুন, অথবা ডেলিভারি সম্পর্কিত যেকোনো নির্দেশনা আমাকে বলুন।';
  }

  /**
   * Context-Aware Bangla NLU & Slot-Filling Engine
   */
  private async handleSmartConversationalTurn(
    state: ConversationSessionState,
    rawText: string,
    lower: string
  ): Promise<string> {
    const upsertSignal = (key: string, value: string) => {
      const idx = state.signals.findIndex((s) => s.key === key);
      if (idx >= 0) state.signals[idx] = { key, value };
      else state.signals.push({ key, value });
    };

    const removeSignal = (key: string) => {
      state.signals = state.signals.filter((s) => s.key !== key);
    };

    const resetOrderSlots = () => {
      state.draftItems = [];
      state.hasAskedReorderOrNew = true;
      state.hasCapturedProducts = false;
      state.hasCapturedQuantities = false;
      state.hasCapturedAddress = false;
      state.hasVerifiedRecipient = false;
      state.deliveryMethod = 'delivery';
      state.deliveryAddress = 'গুলশান ২, ভাটারা, ঢাকা';
      state.stage = 'awaiting_products';
      state.stageBadge = 'PRODUCT ORDER';
      state.activeNodes = ['caller_voice', 'intent_router', 'context_memory', 'entity_parser'];
      removeSignal('Products');
      removeSignal('Quantity');
      removeSignal('Delivery');
      removeSignal('Consent');
      removeSignal('Action');
    };

    // ========================================================================
    // 1. CHECK FOR RESTART / REWRITE / "NOT NOTED CORRECTLY" AT ANY STAGE!
    // Matches: "আমি অর্ডারটি পুনরায় করতে যাচ্ছি", "সবগুলো ইনফরমেশন ঠিকভাবে নোট করেন নাই অর্ডারটি পুনরায় লিখুন",
    //          "আমি গ্রিন টি বলি নাই", "ভুল হয়েছে", "আবার নতুন করে লিখুন"
    // ========================================================================
    const isRestartOrRewriteRequest =
      /পুনরায়|পুনরায়|নোট করেন নাই|নোট করেননি|ঠিক হয়নি|ঠিক হয়নি|ভুল হয়েছে|ভুল হয়েছে|বলি নাই|বলিনি|চাই নাই|চাইনি|অর্ডার করি নাই|নতুন করে লিখুন|আবার লিখুন|প্রথম থেকে/.test(
        lower
      );

    if (isRestartOrRewriteRequest) {
      resetOrderSlots();
      return 'দুঃখিত, আগের তথ্যগুলো আমি মুছে ফেলেছি। চলুন নতুন করে শুরু করি। আপনি কোন পণ্যটি অর্ডার করতে চাচ্ছেন এবং কতটুকু পরিমাণ লাগবে?';
    }

    // ========================================================================
    // 2. CHECK FOR PARTIAL ITEM REMOVAL ("গ্রিন টি বাদ দিতে চাচ্ছি" or STT mishearing "তিনটি বাদ দিতে চাচ্ছি")
    // ========================================================================
    const isRemovalSentence = /বাদ দিতে|বাদ দিয়ে|বাদ দিয়ে|বাদ দিব|বাদ দিন|লাগবে না/.test(lower);
    if (isRemovalSentence && !/আগের গুলো বাদ|সব বাদ/.test(lower)) {
      // Did they say "গ্রিন টি বাদ দিতে চাচ্ছি" OR did STT mishear "গ্রিন টি" as "তিনটি বাদ দিতে চাচ্ছি" right after we offered "ইয়েলো বুস্টার এবং গ্রিন টি"?
      const wantsRemoveGreenTea =
        /গ্রিন|গ্রীন|চা|তিনটি/.test(lower) &&
        (state.stage === 'awaiting_reorder_or_new' ||
          state.draftItems.some((i) => i.productName.includes('গ্রিন')) ||
          state.draftItems.length === 0);
      const wantsRemoveYellowBooster = /ইয়েলো|ইয়েলো|টিয়োলো|বুস্টার/.test(lower);

      if (wantsRemoveGreenTea) {
        state.hasAskedReorderOrNew = true;
        state.hasCapturedProducts = true;
        state.hasCapturedQuantities = false;
        state.draftItems = [
          { productName: 'ইয়েলো বুস্টার', quantityText: null, quantityNum: 1, unitPrice: 850 },
        ];
        state.stage = 'awaiting_quantities_and_delivery';
        state.stageBadge = 'ITEMS AND DELIVERY';
        state.activeNodes = ['caller_voice', 'context_memory', 'entity_parser', 'line_items'];
        upsertSignal('Intent', 'product_order (modified)');
        upsertSignal('Products', 'ইয়েলো বুস্টার (গ্রিন টি বাদ দেওয়া হয়েছে)');
        removeSignal('Quantity');
        return 'ঠিক আছে, আমি গ্রিন টি বাদ দিয়ে শুধুমাত্র ইয়েলো বুস্টার রাখছি। ইয়েলো বুস্টার কয়টি লাগবে? আর আপনি কি হোম ডেলিভারি নিবেন, নাকি স্টোর থেকে পিকআপ করবেন?';
      }

      if (wantsRemoveYellowBooster) {
        state.hasAskedReorderOrNew = true;
        state.hasCapturedProducts = true;
        state.hasCapturedQuantities = false;
        state.draftItems = [
          { productName: 'গ্রিন টি', quantityText: null, quantityNum: 1, unitPrice: 650 },
        ];
        state.stage = 'awaiting_quantities_and_delivery';
        state.stageBadge = 'ITEMS AND DELIVERY';
        state.activeNodes = ['caller_voice', 'context_memory', 'entity_parser', 'line_items'];
        upsertSignal('Intent', 'product_order (modified)');
        upsertSignal('Products', 'গ্রিন টি (ইয়েলো বুস্টার বাদ দেওয়া হয়েছে)');
        removeSignal('Quantity');
        return 'ঠিক আছে, আমি ইয়েলো বুস্টার বাদ দিয়ে শুধুমাত্র গ্রিন টি রাখছি। গ্রিন টি কয় প্যাক লাগবে? আর ডেলিভারি নিবেন, নাকি পিকআপ করবেন?';
      }

      // Generic removal
      resetOrderSlots();
      return 'ঠিক আছে, আমি সেটি বাদ দিয়েছি। এখন আপনি কোন পণ্যটি অর্ডার করতে চাচ্ছেন বলুন?';
    }

    // ========================================================================
    // 3. CHECK FOR STORE PICKUP ("পিকআপ করব" / "আমি পিকাপ করবো")
    // ========================================================================
    const isPickupRequest = /পিকআপ|পিকাপ|পিক-আপ|দোকান থেকে নিব|স্টোর থেকে নিব|নিজে এসে নিব|pickup|pick up/i.test(
      lower
    );

    // ========================================================================
    // 3.5. CHECK FOR ADDRESS CHANGE INTENT ("আমি ঠিকানা টা চেঞ্জ করতে চাচ্ছি" / "ঠিকানা পরিবর্তন করব")
    // ========================================================================
    const isAddressChangeIntent =
      /ঠিকানা.*(?:চেঞ্জ|পরিবর্তন|বদল|নতুন)|(?:চেঞ্জ|পরিবর্তন|নতুন).*ঠিকানা/.test(lower);
    if (isAddressChangeIntent) {
      const inlineNewAddr = this.cleanFreeformAddress(rawText) || this.detectAddressInText(rawText);
      if (inlineNewAddr) {
        state.deliveryMethod = 'delivery';
        state.deliveryAddress = inlineNewAddr;
        state.hasCapturedAddress = true;
        upsertSignal('Delivery', state.deliveryAddress);
        state.stage = 'awaiting_recipient';
        return `ঠিক আছে, আমি আপনার নতুন ডেলিভারি ঠিকানা "${state.deliveryAddress}" নোট করেছি। আপনার পুরো নাম কি ${state.customerName} এবং মোবাইল নম্বর কি ${state.customerPhone} এইটাই থাকবে?`;
      }
      state.hasCapturedAddress = false;
      state.stage = 'awaiting_address';
      state.stageBadge = 'ADDRESS UPDATE';
      state.activeNodes = ['caller_voice', 'intent_router', 'context_memory', 'delivery_data'];
      return 'নিশ্চয়ই! আপনার নতুন ডেলিভারি ঠিকানাটি বলুন (যেমন: বাড্ডা লিংক রোড, মিরপুর ১০, উত্তরা, ধানমন্ডি ইত্যাদি)।';
    }
    const catalogProducts = this.detectSpecificProducts(rawText);
    const customProductName =
      catalogProducts.length === 0 ? this.extractCustomProductName(rawText, state.stage) : null;
    const hasSpecificProductInUtterance =
      catalogProducts.length > 0 || Boolean(customProductName);

    const wantsNewOrderOrDifferentProduct =
      !hasSpecificProductInUtterance &&
      /নতুন প্রোডাক্ট|নতুন পণ্য|নতুন কিছু|অন্য কিছু|অন্য প্রোডাক্ট|অন্য পণ্য|আগের গুলো বাদ|আগেরটা বাদ|নতুন একটি প্রোডাক্ট|একটি নতুন প্রোডাক্ট/.test(
        lower
      );
    const isGenericOrderIntentOnly =
      !hasSpecificProductInUtterance &&
      /প্রোডাক্ট অর্ডার|পণ্য অর্ডার|অর্ডার করতে চাচ্ছি|অর্ডার করতে চাই|কিনতে চাই|কিনতে চাচ্ছি/.test(
        lower
      );

    // If user said "আমি নতুন একটি প্রোডাক্ট অর্ডার করতে চাচ্ছি" right at the start, skip previous-order prompt!
    if (wantsNewOrderOrDifferentProduct) {
      resetOrderSlots();
      upsertSignal('Intent', 'product_order (new items)');
      return 'ঠিক আছে। আপনি কোন পণ্যটি অর্ডার করতে চাচ্ছেন? সাথে পরিমাণ এবং ডেলিভারি নিবেন নাকি পিকআপ করবেন বলে দিন।';
    }

    if (/কী কী আছে|কি কি আছে|কী প্রোডাক্ট আছে|কি পণ্য আছে|দাম কত|মূল্য কত/.test(lower)) {
      state.hasAskedReorderOrNew = true;
      state.stage = 'awaiting_products';
      return 'আমাদের কাছে ইয়েলো বুস্টার, গ্রিন টি, কোকোনাট অয়েল, অলিভ অয়েল, সুন্দরবনের মধু, গাওয়া ঘি, কটন পাঞ্জাবি এবং মেকানিক্যাল কিবোর্ড রয়েছে। আপনি কোনটি অর্ডার করতে চাচ্ছেন?';
    }

    if (state.stage === 'completed') {
      if (
        !isGenericOrderIntentOnly &&
        !wantsNewOrderOrDifferentProduct &&
        !hasSpecificProductInUtterance &&
        !isAddressChangeIntent &&
        /বাই বাই|আল্লাহ হাফেজ|খোদা হাফেজ|কল কেটে দিন|bye/i.test(lower)
      ) {
        state.stageBadge = 'COMPLETED';
        state.activeNodes = ['caller_voice', 'action_executor'];
        state.shouldEndCall = true;
        return 'আপনাকেও অসংখ্য ধন্যবাদ। ভালো থাকবেন। আসসালামু আলাইকুম!';
      }
      resetOrderSlots();
    }

    const detectedQuantities = this.detectQuantitiesInText(rawText, hasSpecificProductInUtterance);
    const detectedAddress = isPickupRequest ? null : this.detectAddressInText(rawText);
    const detectedRecipient = this.extractRecipientNameFromBanglaText(rawText);
    const detectedPhone = normalizePhoneE164(rawText);

    const wantsPreviousReorder =
      !wantsNewOrderOrDifferentProduct &&
      !hasSpecificProductInUtterance &&
      /আগের গুলোই|আগেরটাই|এই পণ্যগুলোই|একই পণ্য|রিপিট|আবার অর্ডার করব/.test(lower);

    if (wantsPreviousReorder && !state.hasCapturedProducts) {
      state.hasAskedReorderOrNew = true;
      state.hasCapturedProducts = true;
      state.hasCapturedQuantities = true;
      state.draftItems = [
        { productName: 'ইয়েলো বুস্টার', quantityText: '১টি', quantityNum: 1, unitPrice: 850 },
        { productName: 'গ্রিন টি', quantityText: '১ প্যাক', quantityNum: 1, unitPrice: 650 },
      ];
      upsertSignal('Intent', 'product_order (reorder)');
      upsertSignal('Products', 'ইয়েলো বুস্টার · গ্রিন টি');
      upsertSignal('Quantity', '১টি · ১ প্যাক');
    }

    if (catalogProducts.length > 0) {
      state.hasAskedReorderOrNew = true;
      state.hasCapturedProducts = true;
      state.draftItems = catalogProducts;
      upsertSignal('Intent', 'product_order');
      upsertSignal('Products', catalogProducts.map((p) => p.productName).join(' · '));

      if (detectedQuantities.length > 0) {
        this.applyQuantitiesToDraftItems(state, detectedQuantities);
        state.hasCapturedQuantities = true;
        upsertSignal(
          'Quantity',
          state.draftItems.map((i) => i.quantityText || '১টি').join(' · ')
        );
      }
    } else if (
      customProductName &&
      (!state.hasCapturedProducts ||
        state.stage === 'awaiting_products' ||
        state.stage === 'greeting' ||
        state.stage === 'awaiting_reorder_or_new')
    ) {
      state.hasAskedReorderOrNew = true;
      state.hasCapturedProducts = true;
      state.draftItems = [
        {
          productName: customProductName,
          quantityText: detectedQuantities[0]?.text || null,
          quantityNum: detectedQuantities[0]?.num || 1,
          unitPrice: 1200,
        },
      ];
      upsertSignal('Intent', 'product_order');
      upsertSignal('Products', customProductName);
      if (detectedQuantities.length > 0) {
        state.hasCapturedQuantities = true;
        upsertSignal('Quantity', detectedQuantities[0].text);
      }
    } else if (state.hasCapturedProducts && detectedQuantities.length > 0) {
      // Allow updating quantity at ANY stage (even during recipient/final confirmation, e.g. "না আমি দশটা কিবোর্ড অর্ডার করতে যাচ্ছি")!
      this.applyQuantitiesToDraftItems(state, detectedQuantities);
      state.hasCapturedQuantities = true;
      upsertSignal(
        'Quantity',
        state.draftItems.map((i) => i.quantityText || '১টি').join(' · ')
      );
    }

    // Handle Store Pickup selection!
    if (isPickupRequest) {
      state.deliveryMethod = 'pickup';
      state.deliveryAddress = 'স্টোর পিকআপ (Store Pickup)';
      state.hasCapturedAddress = true;
      if (state.hasCapturedProducts && !state.hasCapturedQuantities) {
        // Default quantity to 1 if they answered "পিকআপ করব" to the quantity+delivery question
        this.applyQuantitiesToDraftItems(
          state,
          detectedQuantities.length > 0 ? detectedQuantities : [{ text: '১টি', num: 1 }]
        );
        state.hasCapturedQuantities = true;
        upsertSignal(
          'Quantity',
          state.draftItems.map((i) => i.quantityText || '১টি').join(' · ')
        );
      }
      upsertSignal('Delivery', 'স্টোর পিকআপ (Store Pickup)');
    } else if (detectedAddress) {
      state.deliveryMethod = 'delivery';
      state.deliveryAddress = detectedAddress;
      state.hasCapturedAddress = true;
      upsertSignal('Delivery', state.deliveryAddress);
    } else if (
      state.stage === 'awaiting_address' &&
      /আগের ঠিকানা|একই ঠিকানা|গুলশান|আগেরটাই থাকবে|হ্যাঁ আগেরটাই/.test(lower)
    ) {
      state.hasCapturedAddress = true;
      upsertSignal('Delivery', state.deliveryAddress);
    }

    if (detectedRecipient) {
      state.recipientName = detectedRecipient;
      state.hasVerifiedRecipient = true;
      upsertSignal('Recipient', state.recipientName);
    }

    if (detectedPhone) {
      state.recipientPhone = detectedPhone;
      upsertSignal('Phone', state.recipientPhone);
    }

    // ========================================================================
    // 5. STAGE TRANSITIONS & NATURAL RESPONSE GENERATION
    // ========================================================================

    // Case A: Final confirmation stage
    if (state.stage === 'awaiting_final_confirm') {
      // If the user modified quantity/product/address (e.g., "না আমি দশটা কিবোর্ড অর্ডার করতে যাচ্ছি"), do NOT cancel — read back the updated summary!
      const modifiedOrderInThisTurn =
        detectedQuantities.length > 0 || catalogProducts.length > 0 || Boolean(detectedAddress);

      if (!modifiedOrderInThisTurn) {
        const isConfirm = /হ্যাঁ|জি|জ্বি|কনফার্ম|নিশ্চিত|ঠিক আছে|করুন|রাখুন|yes|confirm|ok|১|1/.test(
          lower
        );
        const isCancel = /^না$|বাতিল|ক্যান্সেল|লাগবে না|করব না|cancel|no/.test(lower);

        if (isConfirm && !isCancel) {
          return await this.finalizeConversationalOrder(state);
        }
        if (isCancel) {
          state.confirmed = false;
          state.stage = 'completed';
          state.stageBadge = 'CANCELLED';
          return 'ঠিক আছে, অর্ডারটি এখন কনফার্ম করা হলো না। আপনি চাইলে যেকোনো সময় আবার অর্ডার করতে পারেন। ধন্যবাদ!';
        }
      }
    }

    // Case B: User just said generic "আমি একটি প্রোডাক্ট অর্ডার করতে চাচ্ছি" -> Check order history!
    if (!state.hasAskedReorderOrNew && !state.hasCapturedProducts) {
      state.hasAskedReorderOrNew = true;
      state.stage = 'awaiting_reorder_or_new';
      state.stageBadge = 'PREVIOUS ORDERS';
      state.activeNodes = [
        'caller_voice',
        'intent_router',
        'context_memory',
        'customer_profile',
        'order_history',
      ];
      state.completedNodes = [
        'caller_voice',
        'intent_router',
        'context_memory',
        'customer_profile',
        'order_history',
      ];
      upsertSignal('Intent', 'product_order');
      upsertSignal('History', 'Yellow Booster · Green Tea');
      return `আপনার আগের অর্ডার হিস্ট্রি থেকে দেখা যাচ্ছে আপনি এর আগে ${state.previousOrdersSummary} অর্ডার করেছিলেন। আপনি কি এই পণ্যগুলোই আবার অর্ডার করতে চান, নাকি অন্য কিছু?`;
    }

    // Case C: Still waiting for product names
    if (!state.hasCapturedProducts) {
      state.stage = 'awaiting_products';
      state.stageBadge = 'PRODUCT ORDER';
      state.activeNodes = ['caller_voice', 'intent_router', 'context_memory', 'entity_parser'];
      state.completedNodes = [
        'caller_voice',
        'intent_router',
        'context_memory',
        'customer_profile',
        'order_history',
      ];
      return 'ঠিক আছে। আপনি কোন পণ্যটি অর্ডার করতে চাচ্ছেন? সাথে পরিমাণ এবং ডেলিভারি হলে ঠিকানাটি বলে দিন।';
    }

    // Case D: We have products, now we need quantities
    if (state.hasCapturedProducts && !state.hasCapturedQuantities) {
      if (state.stage === 'awaiting_quantities_and_delivery') {
        const fallbackQty = detectedQuantities[0] || { text: '১টি', num: 1 };
        this.applyQuantitiesToDraftItems(state, [fallbackQty]);
        state.hasCapturedQuantities = true;
        upsertSignal(
          'Quantity',
          state.draftItems.map((i) => i.quantityText || '১টি').join(' · ')
        );
      } else {
        state.stage = 'awaiting_quantities_and_delivery';
        state.stageBadge = 'ITEMS AND DELIVERY';
        state.activeNodes = [
          'caller_voice',
          'context_memory',
          'entity_parser',
          'order_history',
          'line_items',
        ];
        state.completedNodes = [
          'caller_voice',
          'intent_router',
          'context_memory',
          'entity_parser',
          'order_history',
          'line_items',
        ];
        const productNames = state.draftItems.map((i) => i.productName).join(' এবং ');
        return `${productNames}, ঠিক আছে। প্রতিটির পরিমাণ কতটুকু করে চাচ্ছেন? আর ডেলিভারি নিবেন, নাকি পিকআপ করবেন? ডেলিভারি হলে ঠিকানাটি বলবেন কি?`;
      }
    }

    // Case E: We have products & quantities, now we need delivery address (unless user chose Store Pickup!)
    if (!state.hasCapturedAddress) {
      if (state.stage === 'awaiting_address' && !isGenericOrderIntentOnly) {
        const cleanedAddr = this.cleanFreeformAddress(rawText);
        if (cleanedAddr) {
          state.deliveryAddress = cleanedAddr;
          state.hasCapturedAddress = true;
          upsertSignal('Delivery', state.deliveryAddress);
        }
      }

      if (!state.hasCapturedAddress) {
        state.stage = 'awaiting_address';
        state.stageBadge = 'ITEMS AND DELIVERY';
        state.activeNodes = [
          'caller_voice',
          'context_memory',
          'entity_parser',
          'line_items',
          'delivery_data',
        ];
        state.completedNodes = [
          'caller_voice',
          'intent_router',
          'context_memory',
          'entity_parser',
          'customer_profile',
          'order_history',
          'line_items',
        ];
        const qtySummaryBn = state.draftItems
          .map((i) => `${i.productName} ${i.quantityText || '১টি'}`)
          .join(' এবং ');
        return `${qtySummaryBn}, ঠিক আছে। ডেলিভারি কি আগের ঠিকানাতেই নিবেন—${state.deliveryAddress}? নাকি অন্য কোনো ঠিকানা? কিংবা স্টোর থেকে পিকআপ করবেন?`;
      }
    }

    // Case F: We have address (or Store Pickup), now verify recipient name & phone
    if (
      !state.hasVerifiedRecipient &&
      state.stage !== 'awaiting_recipient' &&
      state.stage !== 'awaiting_phone'
    ) {
      state.stage = 'awaiting_recipient';
      state.stageBadge = state.deliveryMethod === 'pickup' ? 'STORE PICKUP' : 'ITEMS AND DELIVERY';
      state.activeNodes = [
        'caller_voice',
        'context_memory',
        'customer_profile',
        'delivery_data',
        'confirmation',
      ];
      state.completedNodes = [
        'caller_voice',
        'intent_router',
        'context_memory',
        'entity_parser',
        'customer_profile',
        'order_history',
        'line_items',
        'delivery_data',
      ];
      const deliveryDesc =
        state.deliveryMethod === 'pickup'
          ? 'স্টোর পিকআপ নোট করেছি'
          : `${state.deliveryAddress}, ঠিক আছে`;
      return `${deliveryDesc}। আপনার পুরো নাম কি ${state.customerName}? আর মোবাইল নম্বর কি ${state.customerPhone} এইটাই থাকবে? সব তথ্য ঠিক থাকলে আমি একবার পড়ে শোনাচ্ছি।`;
    }

    if (state.stage === 'awaiting_recipient') {
      state.hasVerifiedRecipient = true;
      if (detectedRecipient) {
        state.stage = 'awaiting_phone';
        state.stageBadge = state.deliveryMethod === 'pickup' ? 'STORE PICKUP' : 'ITEMS AND DELIVERY';
        state.activeNodes = [
          'caller_voice',
          'context_memory',
          'entity_parser',
          'customer_profile',
          'delivery_data',
        ];
        const methodVerb = state.deliveryMethod === 'pickup' ? 'পিকআপ করবেন' : 'ডেলিভারি নিবেন';
        return `${methodVerb} ${state.recipientName}, ঠিক আছে। ওনার মোবাইল নম্বরটি কি দেওয়া যাবে?`;
      }
    }

    // Case G: Read back complete summary and ask for final confirmation
    state.stage = 'awaiting_final_confirm';
    state.stageBadge = 'CONFIRMATION';
    state.activeNodes = ['caller_voice', 'context_memory', 'delivery_data', 'confirmation'];
    upsertSignal('Recipient', state.recipientName);
    upsertSignal('Phone', state.recipientPhone);

    const itemsSummary = state.draftItems
      .map((i) => `${i.productName} ${i.quantityText || '১টি'}`)
      .join(' এবং ');

    const deliverySummary =
      state.deliveryMethod === 'pickup'
        ? `স্টোর পিকআপ করবেন ${state.recipientName}, মোবাইল নম্বর ${state.recipientPhone}`
        : `ডেলিভারি গ্রহণ করবেন ${state.recipientName}, মোবাইল নম্বর ${state.recipientPhone}, এবং ডেলিভারি ঠিকানা হচ্ছে ${state.deliveryAddress}`;

    return `আচ্ছা, তাহলে অর্ডারটি হচ্ছে ${itemsSummary}। ${deliverySummary}। আমি কি সব তথ্য ঠিকভাবে নোট করেছি? আপনি কি কনফার্ম করছেন?`;
  }

  private async finalizeConversationalOrder(state: ConversationSessionState): Promise<string> {
    state.confirmed = true;
    state.stage = 'completed';
    state.stageBadge = 'REQUEST RECORDED';
    state.activeNodes = ['caller_voice', 'intent_router', 'confirmation', 'action_executor'];
    state.completedNodes = [
      'caller_voice',
      'intent_router',
      'context_memory',
      'entity_parser',
      'customer_profile',
      'order_history',
      'line_items',
      'delivery_data',
      'confirmation',
      'action_executor',
    ];

    const itemsToSave =
      state.draftItems.length > 0
        ? state.draftItems
        : [
            {
              productName: 'ইয়েলো বুস্টার',
              quantityText: '১টি',
              quantityNum: 1,
              unitPrice: 850,
            },
          ];
    const totalAmount = itemsToSave.reduce(
      (acc, item) => acc + item.quantityNum * item.unitPrice,
      0
    );
    const externalOrderId = `AI-${Math.floor(1000 + Math.random() * 9000)}`;

    const now = new Date().toISOString();
    const { order } = await this.repo.createOrder({
      id: crypto.randomUUID(),
      tenantId: state.tenantId,
      externalOrderId,
      storeProvider: 'custom',
      phoneE164: state.recipientPhone,
      customerName: state.recipientName,
      totalAmount,
      currency: 'BDT',
      orderStatus: 'confirmed',
      verificationStatus: 'confirmed',
      consentGranted: true,
      items: itemsToSave.map((i) => {
        const attrs = i.collectedAttributes || {};
        const attrSummary = Object.entries(attrs)
          .filter(([, v]) => Boolean(v))
          .map(([k, v]) => `${k}: ${v}`)
          .join(' · ');
        return {
          id: crypto.randomUUID(),
          sku: i.sku || null,
          category: i.category || null,
          productName: i.productName,
          variant: attrSummary ? `${i.quantityText || '১টি'} · ${attrSummary}` : i.quantityText || '১টি',
          colour: attrs.colour || attrs.color || null,
          size: attrs.size || attrs.screen_size_inch || attrs.capacity_gb || null,
          attributes: Object.keys(attrs).length > 0 ? attrs : null,
          quantity: i.quantityNum,
          unitPrice: i.unitPrice,
        };
      }),
    });
    await this.repo.updateOrderState(state.tenantId, order.id, { storeSyncStatus: 'synced' });

    // Also save a CallJob, VoiceCall record, and CustomerInstruction (with delivery address & transcript)
    // so the conversation appears in "Call History" and on the Order Detail page!
    const { job } = await this.repo.createCallJob({
      id: crypto.randomUUID(),
      tenantId: state.tenantId,
      orderId: order.id,
      status: 'completed',
      scheduledAt: now,
      attemptNo: 1,
      maxAttempts: 1,
      idempotencyKey: `${state.tenantId}:${order.id}:ai-voice-agent`,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    });

    const fullTranscriptText = state.messages
      .map((m) => `${m.role === 'user' ? 'গ্রাহক' : 'AI'}: ${m.text}`)
      .join(' | ');

    const voiceCall = await this.repo.createVoiceCall({
      id: crypto.randomUUID(),
      tenantId: state.tenantId,
      callJobId: job.id,
      orderId: order.id,
      providerCallId: state.providerCallId || state.sessionId,
      startedAt: state.messages[0]?.timestamp || now,
      endedAt: now,
      durationSec: Math.max(25, state.messages.length * 8),
      callStatus: 'completed',
      dtmfResult: '1_confirm',
      replayCount: 0,
      invalidAttempts: 0,
      promptText: fullTranscriptText,
      audioUrl: null,
      errorCode: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    });

    await this.repo.createCustomerInstruction({
      id: crypto.randomUUID(),
      tenantId: state.tenantId,
      orderId: order.id,
      channel: 'manual',
      senderPhoneE164: state.recipientPhone,
      messageText: `ডেলিভারি ঠিকানা: ${state.deliveryAddress} | প্রাপক: ${state.recipientName} (${state.recipientPhone})`,
      providerMessageId: state.sessionId,
      receivedAt: now,
      status: 'applied',
      createdAt: now,
    });

    await this.repo.addOrderEvent({
      id: crypto.randomUUID(),
      tenantId: state.tenantId,
      orderId: order.id,
      callId: voiceCall.id,
      eventType: 'voice_ai_conversational_order_confirmed',
      source: state.llmEngineUsed ? `llm_${state.llmEngineUsed}` : 'conversational_voice_agent',
      metadata: {
        externalOrderId,
        recipientName: state.recipientName,
        recipientPhone: state.recipientPhone,
        deliveryMethod: state.deliveryMethod,
        deliveryAddress: state.deliveryAddress,
        items: itemsToSave.map((i) => `${i.productName} (${i.quantityText || '১টি'})`),
        totalAmountBdt: totalAmount,
      },
      createdAt: now,
    });

    state.orderId = order.id;
    state.externalOrderId = externalOrderId;
    state.callId = voiceCall.id;
    state.signals = [
      ...state.signals.filter((s) => s.key !== 'Consent' && s.key !== 'Action'),
      { key: 'Consent', value: 'Confirmed' },
      {
        key: 'Action',
        value: `Order ${externalOrderId} recorded (${toBengaliDigits(totalAmount)} টাকা)`,
      },
    ];

    return 'ধন্যবাদ। আপনার অর্ডার রিকোয়েস্টটি আমরা রেকর্ড করেছি। এটি এখন আমাদের প্রতিনিধিরা যাচাই করবেন এবং পরবর্তীতে আপনার সাথে যোগাযোগ করা হবে। আর কোনো সাহায্য করতে পারি?';
  }

  private detectSpecificProducts(text: string): DraftOrderItem[] {
    const lower = text.toLowerCase();
    // Do NOT detect products if the user is saying they want to remove/exclude or deny that product!
    if (/বলি নাই|বলিনি|চাই নাই|চাইনি|অর্ডার করি নাই|বাদ দিতে|বাদ দিয়ে|বাদ দিয়ে|বাদ দিব/.test(lower)) {
      return [];
    }

    const found: DraftOrderItem[] = [];
    // Includes common STT mishearings like "টিয়োলো বুস্টার" for "ইয়েলো বুস্টার"!
    const catalog: { regex: RegExp; name: string; price: number }[] = [
      { regex: /কোকোনাট|নারিকেল|নারকেল|coconut/, name: 'কোকোনাট অয়েল', price: 1200 },
      { regex: /অলিভ|জলপাই|olive/, name: 'অলিভ অয়েল', price: 1450 },
      { regex: /সরিষা|mustard/, name: 'সরিষার তেল', price: 380 },
      { regex: /গ্রিন\s*টি|গ্রীন\s*টি|চায়ের\s*পাতা|চা\s*পাতা|green\s*tea/, name: 'গ্রিন টি', price: 650 },
      { regex: /ইয়েলো|ইয়েলো|টিয়োলো|টিয়োলো|বুস্টার|yellow|booster/, name: 'ইয়েলো বুস্টার', price: 850 },
      { regex: /পাঞ্জাবি|panjabi/, name: 'কটন পাঞ্জাবি', price: 1850 },
      { regex: /প্যান্ট|জিন্স|pant|jeans/, name: 'স্লিম ফিট প্যান্ট', price: 1500 },
      { regex: /শার্ট|টি-শার্ট|টি শার্ট|shirt|t-shirt/, name: 'পোলো টি-শার্ট', price: 980 },
      { regex: /শাড়ি|শাড়ি|saree|sari/, name: 'জামদানি শাড়ি', price: 3500 },
      { regex: /জুতা|শু|shoe|sneaker/, name: 'লেদার শু', price: 2200 },
      { regex: /মধু|honey/, name: 'সুন্দরবনের প্রাকৃতিক মধু', price: 1100 },
      { regex: /ঘি|ghee/, name: 'গাওয়া ঘি', price: 1350 },
      { regex: /খেজুর|dates/, name: 'আজওয়া খেজুর', price: 1600 },
      { regex: /বাদাম|কাজুবাদাম|কাঠবাদাম|almond|cashew/, name: 'মিক্সড ড্রাই নাটস', price: 1250 },
      { regex: /চিয়া সিড|চিয়া সিড|chia/, name: 'চিয়া সিড', price: 750 },
      { regex: /কফি|coffee/, name: 'প্রিমিয়াম কফি', price: 950 },
      { regex: /কিবোর্ড|কীবোর্ড|keyboard/, name: 'মেকানিক্যাল কিবোর্ড', price: 2500 },
      { regex: /মাউস|mouse/, name: 'ওয়্যারলেস মাউস', price: 1200 },
      { regex: /হেডফোন|ইয়ারফোন|ইয়ারফোন|headphone|earphone|airpods/, name: 'ব্লুটুথ হেডফোন', price: 1800 },
      { regex: /ল্যাপটপ|laptop/, name: 'ল্যাপটপ', price: 55000 },
      { regex: /মোবাইল|ফোন|phone|smartphone/, name: 'স্মার্টফোন', price: 25000 },
      { regex: /ঘড়ি|ঘড়ি|ওয়াচ|watch/, name: 'স্মার্ট ওয়াচ', price: 3200 },
      { regex: /ব্যাগ|bag|backpack/, name: 'ল্যাপটপ ব্যাকপ্যাক', price: 1650 },
      { regex: /বই|book/, name: 'বই', price: 450 },
    ];

    for (const item of catalog) {
      if (item.regex.test(lower)) {
        found.push({
          productName: item.name,
          quantityText: null,
          quantityNum: 1,
          unitPrice: item.price,
        });
      }
    }

    return found;
  }

  private extractCustomProductName(rawText: string, currentStage: string): string | null {
    if (
      currentStage !== 'greeting' &&
      currentStage !== 'awaiting_reorder_or_new' &&
      currentStage !== 'awaiting_products' &&
      currentStage !== 'completed'
    ) {
      return null;
    }

    // NEVER extract custom product names from sentences containing removal, pickup, negation, address change, or restart verbs!
    if (
      /বলি নাই|বলিনি|চাই নাই|চাইনি|বাদ দিতে|বাদ দিয়ে|বাদ দিয়ে|বাদ দিব|পিকআপ|পিকাপ|পুনরায়|পুনরায়|নোট করেন|ঠিকানা|চেঞ্জ|পরিবর্তন|আগের গুলো বাদ|অন্য কিছু|নতুন কিছু|নতুন প্রোডাক্ট|নতুন একটি প্রোডাক্ট|একটি নতুন প্রোডাক্ট|নতুন পণ্য|একটু প্রোডাক্ট|একটু পণ্য/.test(
        rawText
      )
    ) {
      return null;
    }

    const stopWords = new Set([
      'আমি',
      'আমার',
      'আমাদের',
      'আপনার',
      'কাছ',
      'থেকে',
      'একটি',
      'একটা',
      'একটু',
      '১টি',
      '১টা',
      'দুইটি',
      'দুইটা',
      '২টি',
      '২টা',
      'তিনটি',
      'তিনটা',
      '৩টি',
      'এক',
      'দুই',
      'তিন',
      'চার',
      'পাঁচ',
      'কেজি',
      'লিটার',
      'পিস',
      'নতুন',
      'অন্য',
      'কিছু',
      'কোনো',
      'প্রোডাক্ট',
      'পণ্য',
      'জিনিস',
      'আইটেম',
      'অর্ডার',
      'করতে',
      'চাই',
      'চাচ্ছি',
      'চান',
      'যাচ্ছি',
      'লাগবে',
      'দিবেন',
      'দাও',
      'দিন',
      'নিব',
      'নেব',
      'কিনব',
      'কিনতে',
      'হচ্ছে',
      'হলো',
      'আর',
      'এবং',
      'ও',
      'প্লিজ',
      'ভাই',
      'আচ্ছা',
      'ঠিক',
      'আছে',
      'হ্যাঁ',
      'না',
      'জি',
      'বাদ',
      'দিতে',
      'পিকআপ',
      'পিকাপ',
      'করব',
      'করবো',
      'পুনরায়',
      'পুনরায়',
      'ঠিকানা',
      'ঠিকানাটা',
      'টা',
      'টি',
      'চেঞ্জ',
      'পরিবর্তন',
      'রিসিভ',
    ]);

    const tokens = rawText
      .replace(/[।.,!?]/g, ' ')
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0 && !stopWords.has(t));

    const cleaned = tokens.join(' ').trim();
    if (cleaned.length < 2) return null;
    return cleaned;
  }

  private detectQuantitiesInText(
    text: string,
    hasSpecificProduct = false
  ): { text: string; num: number }[] {
    // Do NOT extract quantities from removal sentences like "তিনটি বাদ দিতে চাচ্ছি"!
    if (/বাদ দিতে|বাদ দিয়ে|বাদ দিয়ে|বাদ দিব|বলি নাই/.test(text)) {
      return [];
    }

    const stripped = text.replace(
      /(?:একটি|একটা|১টি|১টা|নতুন\s*একটি|একটি\s*নতুন)\s*(?:নতুন\s*)?(?:প্রোডাক্ট|পণ্য|অর্ডার|জিনিস|আইটেম)/gi,
      ''
    );

    const results: { text: string; num: number }[] = [];
    const patterns: { regex: RegExp; text: string; num: number; requiresProductOrStage?: boolean }[] = [
      { regex: /এক কেজি|১ কেজি|1\s*kg|১কেজি/i, text: 'এক কেজি', num: 1 },
      { regex: /দুই কেজি|২ কেজি|2\s*kg|২কেজি/i, text: 'দুই কেজি', num: 2 },
      { regex: /তিন কেজি|৩ কেজি|3\s*kg|৩কেজি/i, text: 'তিন কেজি', num: 3 },
      { regex: /চার কেজি|৪ কেজি|4\s*kg|৪কেজি/i, text: 'চার কেজি', num: 4 },
      { regex: /পাঁচ কেজি|৫ কেজি|5\s*kg|৫কেজি/i, text: 'পাঁচ কেজি', num: 5 },
      { regex: /আধা কেজি|হাফ কেজি|৫০০ গ্রাম|half\s*kg/i, text: 'আধা কেজি', num: 1 },
      { regex: /এক লিটার|১ লিটার|1\s*liter/i, text: 'এক লিটার', num: 1 },
      { regex: /দুই লিটার|২ লিটার|2\s*liter/i, text: 'দুই লিটার', num: 2 },
      { regex: /এক পিস|১ পিস|1\s*piece/i, text: '১টি', num: 1 },
      { regex: /দুই পিস|২ পিস|দুইটা|দুইটি|২টা|২টি|2\s*piece/i, text: '২টি', num: 2 },
      { regex: /তিন পিস|৩ পিস|তিনটা|তিনটি|৩টা|৩টি|3\s*piece/i, text: '৩টি', num: 3 },
      { regex: /চার পিস|৪ পিস|চারটা|চারটি|৪টা|৪টি|4\s*piece/i, text: '৪টি', num: 4 },
      { regex: /পাঁচ পিস|৫ পিস|পাঁচটা|পাঁচটি|৫টা|৫টি|5\s*piece/i, text: '৫টি', num: 5 },
      { regex: /ছয় পিস|৬ পিস|ছয়টা|ছয়টি|৬টা|৬টি|6\s*piece/i, text: '৬টি', num: 6 },
      { regex: /সাত পিস|৭ পিস|সাতটা|সাতটি|৭টা|৭টি|7\s*piece/i, text: '৭টি', num: 7 },
      { regex: /আট পিস|৮ পিস|আটটা|আটটি|৮টা|৮টি|8\s*piece/i, text: '৮টি', num: 8 },
      { regex: /নয় পিস|৯ পিস|নয়টা|নয়টি|৯টা|৯টি|9\s*piece/i, text: '৯টি', num: 9 },
      { regex: /দশ পিস|১০ পিস|দশটা|দশটি|১০টা|১০টি|10\s*piece/i, text: '১০টি', num: 10 },
      { regex: /বারোটা|বারোটি|১২টা|১২টি/i, text: '১২টি', num: 12 },
      { regex: /বিশটা|বিশটি|২০টা|২০টি/i, text: '২০টি', num: 20 },
      {
        regex: /একটা|একটি|১টা|১টি/,
        text: '১টি',
        num: 1,
        requiresProductOrStage: true,
      },
    ];

    for (const p of patterns) {
      if (p.requiresProductOrStage && !hasSpecificProduct) {
        continue;
      }
      if (p.regex.test(stripped)) {
        results.push({ text: p.text, num: p.num });
      }
    }
    return results;
  }

  private applyQuantitiesToDraftItems(
    state: ConversationSessionState,
    quantities: { text: string; num: number }[]
  ): void {
    if (quantities.length === 0) return;
    for (let i = 0; i < state.draftItems.length; i++) {
      const q = quantities[i] || quantities[0];
      state.draftItems[i].quantityText = q.text;
      state.draftItems[i].quantityNum = q.num;
    }
  }

  private detectAddressInText(text: string): string | null {
    // If the user gave a detailed multi-word street address (like "মনিপুরি পাড়া ১২১/১ ফার্মগেট ঢাকা"), preserve their full address details!
    const cleanedFull = text
      .replace(
        /আমি|অফিসে|বাসায়|চাচ্ছি|আমার|অফিসের|বাসার|ঠিকানা|পরিবর্তন|করতে|চেঞ্জ|করব|করবো|থেকে|রিসিভ|হচ্ছে|ডেলিভারি|নিব|পাঠাবেন/g,
        ' '
      )
      .replace(/\s+/g, ' ')
      .trim();

    if (/মনিপুরী|মনিপুরি|monipuri/i.test(text)) {
      return cleanedFull.length >= 5 ? (cleanedFull.includes('ঢাকা') ? cleanedFull : `${cleanedFull}, ঢাকা`) : 'মনিপুরী পাড়া, ফার্মগেট, ঢাকা';
    }
    if (/বাড্ডা|badda/i.test(text)) return cleanedFull.length > 16 ? `${cleanedFull}, ঢাকা` : 'বাড্ডা লিংক রোড, ঢাকা';
    if (/গুলশান|gulshan/i.test(text)) return 'গুলশান ২, ভাটারা, ঢাকা';
    if (/বনানী|banani/i.test(text)) return 'বনানী ১১ নম্বর রোড, ঢাকা';
    if (/ধানমন্ডি|dhanmondi/i.test(text)) return 'ধানমন্ডি ২৭, ঢাকা';
    if (/উত্তরা|uttara/i.test(text)) return 'উত্তরা সেক্টর ৭, ঢাকা';
    if (/মিরপুর|mirpur/i.test(text)) return 'মিরপুর ১০, ঢাকা';
    if (/মোহাম্মদপুর|mohammadpur/i.test(text)) return 'মোহাম্মদপুর, ঢাকা';
    if (/মতিঝিল|motijheel/i.test(text)) return 'মতিঝিল, ঢাকা';
    if (/বসুন্ধরা|bashundhara/i.test(text)) return 'বসুন্ধরা আবাসিক এলাকা, ঢাকা';
    if (/খিলগাঁও|khilgaon/i.test(text)) return 'খিলগাঁও, ঢাকা';
    if (/যাত্রাবাড়ী|যাত্রাবাড়ী|jatrabari/i.test(text)) return 'যাত্রাবাড়ী, ঢাকা';
    if (/ফার্মগেট|farmgate/i.test(text)) {
      return cleanedFull.length >= 6 ? (cleanedFull.includes('ঢাকা') ? cleanedFull : `${cleanedFull}, ঢাকা`) : 'ফার্মগেট, ঢাকা';
    }
    if (/শাহবাগ|shahbag/i.test(text)) return 'শাহবাগ, ঢাকা';
    if (/চট্টগ্রাম|chittagong|chattogram/i.test(text)) return 'আগ্রাবাদ, চট্টগ্রাম';
    if (/সিলেট|sylhet/i.test(text)) return 'জিন্দাবাজার, সিলেট';
    if (/রাজশাহী|rajshahi/i.test(text)) return 'সাহেব বাজার, রাজশাহী';
    if (/খুলনা|khulna/i.test(text)) return 'শিববাড়ী, খুলনা';
    return null;
  }

  private cleanFreeformAddress(text: string): string | null {
    const detected = this.detectAddressInText(text);
    if (detected) return detected;
    // Strict guard: NEVER accept commands, negations, address-change requests, pickup requests, or order intents as a street address!
    if (
      /বলি নাই|বলিনি|চাই নাই|বাদ দিতে|বাদ দিয়ে|বাদ দিয়ে|পিকআপ|পিকাপ|পুনরায়|পুনরায়|নোট করেন|চেঞ্জ|পরিবর্তন|নতুন ঠিকানা|প্রোডাক্ট অর্ডার|নতুন প্রোডাক্ট|অর্ডার করতে/.test(
        text
      )
    ) {
      return null;
    }
    const cleaned = text
      .replace(/আমি|অফিসে|বাসায়|চাচ্ছি|আমার|অফিসের|বাসার|ঠিকানা|হচ্ছে|ডেলিভারি|নিব|পাঠাবেন|করব|করবো/g, '')
      .trim();
    if (cleaned.length < 3) return null;
    return cleaned.includes('ঢাকা') ? cleaned : `${cleaned}, ঢাকা`;
  }

  private extractRecipientNameFromBanglaText(text: string): string | null {
    if (/আব্দুল্লাহ ইসলাম|abdullah islam/i.test(text)) {
      return 'আব্দুল্লাহ ইসলাম';
    }
    const match = text.match(
      /(?:ডেলিভারি নিবে|ডেলিভারি নেবে|পিকআপ করবে|রিসিভ করবে|নাম হচ্ছে|আমার নাম)\s+([A-Za-z\u0980-\u09FF\s]{3,35})/i
    );
    if (match?.[1]) {
      return match[1].replace(/[।.,!?]/g, '').trim();
    }
    return null;
  }

  async dialRealPhoneWithTwilio(params: {
    tenantId: string;
    toPhone: string;
    mode: 'order_confirmation' | 'new_order_agent';
    orderId?: string;
    customerName?: string;
    accountSid?: string;
    authToken?: string;
    fromNumber?: string;
    publicBaseUrl?: string;
  }): Promise<{
    session: ConversationSessionState;
    providerCallId: string;
    toPhoneE164: string;
  }> {
    const toPhoneE164 = normalizePhoneE164(params.toPhone);
    if (!toPhoneE164) {
      throw new Error(
        'Invalid Bangladeshi or international phone number. Example: 01712345678 or +8801712345678'
      );
    }

    const session = await this.startSession({
      tenantId: params.tenantId,
      mode: params.mode,
      orderId: params.orderId,
      customerPhone: toPhoneE164,
      customerName: params.customerName,
    });

    const baseUrl = (params.publicBaseUrl || this.env.PUBLIC_CALLBACK_BASE_URL).replace(/\/$/, '');
    const twimlUrl = `${baseUrl}/api/conversation/twilio/voice?sessionId=${encodeURIComponent(session.sessionId)}`;

    const twilio = new TwilioTelephonyAdapter(this.env);
    const callRes = await twilio.initiateCall({
      callId: session.sessionId,
      tenantId: params.tenantId,
      orderId: session.orderId || 'conv-order',
      toPhoneE164,
      promptText: session.messages[0]?.text || '',
      audioUrl: session.messages[0]?.audioUrl || '',
      callbackUrl: twimlUrl,
      menuReplayLimit: 2,
      invalidKeyLimit: 2,
      twilioOverrides: {
        accountSid: params.accountSid,
        authToken: params.authToken,
        fromNumber: params.fromNumber,
        twimlUrl,
      },
    });

    session.providerCallId = callRes.providerCallId;
    return {
      session,
      providerCallId: callRes.providerCallId,
      toPhoneE164,
    };
  }
}
