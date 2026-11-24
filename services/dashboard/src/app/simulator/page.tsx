'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  CheckCircle2,
  Database,
  MessageSquare,
  PhoneCall,
  Plus,
  Send,
  Trash2,
  Volume2,
  XCircle,
} from 'lucide-react';
import { useAuth } from '@/components/AuthContext';
import { StatusBadge } from '@/components/StatusBadge';
import { apiFetch } from '@/lib/api';

interface ProductCatalogEntry {
  id: string;
  sku: string;
  productName: string;
  banglaName: string;
  category: string;
  unitPrice: number;
  currency: string;
  requiredAttributes: string[];
  attributeOptions: Record<string, string[]>;
}

interface OrderCartRow {
  rowId: string;
  sku: string;
  productName: string;
  category: string;
  unitPrice: number;
  quantity: number;
  requiredAttributes: string[];
  attributeOptions: Record<string, string[]>;
  attributes: Record<string, string>;
}

interface SimOrderResponse {
  accepted: boolean;
  eligible: boolean;
  duplicate?: boolean;
  reason?: string;
  order?: { id: string; externalOrderId: string; verificationStatus: string };
  calls?: {
    id: string;
    providerCallId: string;
    promptText: string;
    audioUrl: string | null;
    callStatus: string;
    dtmfResult: string;
  }[];
}

interface SimTelephonyResponse {
  action?: string;
  endCall?: boolean;
  spokenPrompt?: string;
  whatsappDeepLink?: string;
  retryScheduledAt?: string;
}

export default function SimulatorTestBenchPage() {
  const { token, activeTenantId } = useAuth();

  const [catalog, setCatalog] = useState<ProductCatalogEntry[]>([]);
  const [attributeLabels, setAttributeLabels] = useState<Record<string, string>>({});

  const [provider, setProvider] = useState<'custom' | 'shopify' | 'woocommerce'>('custom');
  const [externalOrderId, setExternalOrderId] = useState(`DF-${Math.floor(2000 + Math.random() * 7000)}`);
  const [customerName, setCustomerName] = useState('Joti Roy');
  const [phone, setPhone] = useState('01712345678');

  // Dynamic Multi-Product Shopping Cart (Each row renders its own product-specific required attributes!)
  const [cartRows, setCartRows] = useState<OrderCartRow[]>([]);

  const [activeOrderId, setActiveOrderId] = useState<string | null>(null);
  const [activeCall, setActiveCall] = useState<
    SimOrderResponse['calls'] extends (infer U)[] | undefined ? U | null : never
  >(null);
  const [lastDtmfResponse, setLastDtmfResponse] = useState<SimTelephonyResponse | null>(null);
  const [waMessage, setWaMessage] = useState('অনুগ্রহ করে সন্ধ্যা ৬টার পর বাড্ডা লিংক রোডে ডেলিভারি দিবেন।');
  const [waResult, setWaResult] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const appendLog = (entry: string) =>
    setLog((prev) => [`[${new Date().toLocaleTimeString()}] ${entry}`, ...prev]);

  const buildCartRowFromCatalogItem = (item: ProductCatalogEntry): OrderCartRow => {
    const initialAttrs: Record<string, string> = {};
    for (const reqAttr of item.requiredAttributes) {
      const opts = item.attributeOptions?.[reqAttr];
      initialAttrs[reqAttr] = opts && opts.length > 0 ? opts[0].split(' (')[0] : '';
    }
    return {
      rowId: `row-${Math.random().toString(36).slice(2, 8)}`,
      sku: item.sku,
      productName: item.banglaName || item.productName,
      category: item.category,
      unitPrice: item.unitPrice,
      quantity: 1,
      requiredAttributes: item.requiredAttributes,
      attributeOptions: item.attributeOptions || {},
      attributes: initialAttrs,
    };
  };

  useEffect(() => {
    if (!token || !activeTenantId) return;
    apiFetch<{
      attributeLabels: Record<string, string>;
      products: ProductCatalogEntry[];
    }>('/api/conversation/catalog', { token, tenantId: activeTenantId })
      .then((res) => {
        setCatalog(res.products);
        setAttributeLabels(res.attributeLabels || {});
        if (res.products.length > 0 && cartRows.length === 0) {
          setCartRows([buildCartRowFromCatalogItem(res.products[0])]);
        }
      })
      .catch(() => {});
  }, [token, activeTenantId]);

  const handleSelectProductForRow = (rowId: string, sku: string) => {
    const found = catalog.find((c) => c.sku === sku);
    if (!found) return;
    const replacement = buildCartRowFromCatalogItem(found);
    setCartRows((prev) =>
      prev.map((r) => (r.rowId === rowId ? { ...replacement, rowId } : r))
    );
  };

  const handleAttributeChange = (rowId: string, attrKey: string, val: string) => {
    setCartRows((prev) =>
      prev.map((r) =>
        r.rowId === rowId
          ? { ...r, attributes: { ...r.attributes, [attrKey]: val } }
          : r
      )
    );
  };

  const handleQuantityChange = (rowId: string, qty: number) => {
    setCartRows((prev) =>
      prev.map((r) => (r.rowId === rowId ? { ...r, quantity: Math.max(1, qty) } : r))
    );
  };

  const handleUnitPriceChange = (rowId: string, price: number) => {
    setCartRows((prev) =>
      prev.map((r) => (r.rowId === rowId ? { ...r, unitPrice: Math.max(0, price) } : r))
    );
  };

  const addAnotherProductRow = () => {
    if (catalog.length === 0) return;
    const nextCat = catalog[cartRows.length % catalog.length];
    setCartRows((prev) => [...prev, buildCartRowFromCatalogItem(nextCat)]);
  };

  const removeProductRow = (rowId: string) => {
    if (cartRows.length <= 1) return;
    setCartRows((prev) => prev.filter((r) => r.rowId !== rowId));
  };

  const computedTotalAmount = cartRows.reduce(
    (sum, r) => sum + r.quantity * r.unitPrice,
    0
  );

  const fireOrderWebhook = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !activeTenantId || cartRows.length === 0) return;
    setBusy(true);
    setLastDtmfResponse(null);
    setWaResult(null);
    try {
      let payload: Record<string, unknown>;
      if (provider === 'shopify') {
        payload = {
          name: externalOrderId,
          total_price: String(computedTotalAmount),
          currency: 'BDT',
          customer: { first_name: customerName, phone },
          line_items: cartRows.map((r) => ({
            sku: r.sku,
            product_type: r.category,
            title: r.productName,
            variant_title: `${r.attributes.colour || ''} / ${r.attributes.size || ''}`.replace(/^[\s/]+|[\s/]+$/g, '') || null,
            quantity: r.quantity,
            price: String(r.unitPrice),
            properties: Object.entries(r.attributes).map(([name, value]) => ({ name, value })),
          })),
        };
      } else if (provider === 'woocommerce') {
        payload = {
          number: externalOrderId,
          total: String(computedTotalAmount),
          currency: 'BDT',
          status: 'pending',
          billing: { first_name: customerName, phone },
          line_items: cartRows.map((r) => ({
            sku: r.sku,
            name: r.productName,
            quantity: r.quantity,
            price: r.unitPrice,
            meta_data: Object.entries(r.attributes).map(([key, value]) => ({ key, value })),
          })),
        };
      } else {
        payload = {
          externalOrderId,
          customerName,
          phone,
          totalAmount: computedTotalAmount,
          currency: 'BDT',
          orderStatus: 'pending',
          consentGranted: true,
          items: cartRows.map((r) => ({
            sku: r.sku,
            category: r.category,
            productName: r.productName,
            colour: r.attributes.colour || null,
            size: r.attributes.size || r.attributes.screen_size_inch || r.attributes.capacity_gb || null,
            quantity: Number(r.quantity),
            unitPrice: Number(r.unitPrice),
            attributes: r.attributes,
          })),
        };
      }

      const res = await apiFetch<SimOrderResponse>('/api/simulator/order-webhook', {
        method: 'POST',
        token,
        tenantId: activeTenantId,
        body: JSON.stringify({ provider, payload, bypassCallingWindow: true }),
      });

      if (res.order) {
        setActiveOrderId(res.order.id);
      }
      const call = res.calls?.[0] || null;
      setActiveCall(call);
      appendLog(
        `Signed ${provider.toUpperCase()} multi-item webhook (${cartRows.length} products) accepted via storeAdapters.ts → Call ID: ${call?.providerCallId || 'none'}`
      );
      setExternalOrderId(`DF-${Math.floor(2000 + Math.random() * 7000)}`);
    } catch (err) {
      appendLog(`ERROR: ${err instanceof Error ? err.message : 'Webhook failed'}`);
    } finally {
      setBusy(false);
    }
  };

  const sendDtmfOrEvent = async (
    eventType: 'dtmf' | 'no_answer' | 'answered',
    digit?: string
  ) => {
    if (!token || !activeTenantId || !activeCall?.providerCallId) return;
    setBusy(true);
    try {
      const res = await apiFetch<SimTelephonyResponse>('/api/simulator/telephony-event', {
        method: 'POST',
        token,
        tenantId: activeTenantId,
        body: JSON.stringify({
          providerCallId: activeCall.providerCallId,
          eventType,
          digit,
          durationSec: eventType === 'no_answer' ? 0 : 27,
        }),
      });
      setLastDtmfResponse(res);
      appendLog(
        `Telephony event '${eventType}${digit ? ` (digit=${digit})` : ''}' → Backend action: ${res.action}`
      );
    } catch (err) {
      appendLog(`ERROR: ${err instanceof Error ? err.message : 'Callback failed'}`);
    } finally {
      setBusy(false);
    }
  };

  const sendWhatsAppReply = async () => {
    if (!token || !activeTenantId) return;
    setBusy(true);
    try {
      const res = await apiFetch<{ linked: boolean; orderId?: string; reason?: string }>(
        '/api/simulator/whatsapp-reply',
        {
          method: 'POST',
          token,
          tenantId: activeTenantId,
          body: JSON.stringify({ senderPhone: phone, messageText: waMessage }),
        }
      );
      const summary = res.linked
        ? `Linked WhatsApp reply to order ${res.orderId?.slice(0, 8)}`
        : `Not linked (${res.reason})`;
      setWaResult(summary);
      appendLog(`Inbound WhatsApp webhook → ${summary}`);
    } catch (err) {
      appendLog(`ERROR: ${err instanceof Error ? err.message : 'WhatsApp failed'}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">
            Multi-Category Order Webhook &amp; IVR DTMF Test Bench
          </h1>
          <p className="text-sm text-slate-500">
            Select any product type (Shirt, Pant, RAM, Monitor, Keyboard, Mouse, Phone, Grocery) — the form dynamically renders that product&apos;s required purchase attributes and sends them through <code>storeAdapters.ts</code>!
          </p>
        </div>
        <Link
          href="/catalog"
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-indigo-50 border border-indigo-200 hover:bg-indigo-100 text-xs font-semibold text-indigo-800"
        >
          <Database className="w-3.5 h-3.5" />
          Manage Product Catalog &amp; Upload CSV →
        </Link>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
        {/* Step 1: Fire Signed Multi-Product Order-Created Webhook */}
        <form
          onSubmit={fireOrderWebhook}
          className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm space-y-4"
        >
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-slate-900">
              1. Simulate Signed Multi-Product E-commerce Order
            </h2>
            <span className="text-[11px] font-mono bg-slate-100 px-2 py-0.5 rounded text-slate-600">
              storeAdapters.ts
            </span>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Store Provider</label>
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value as 'custom' | 'shopify' | 'woocommerce')}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
              >
                <option value="custom">Custom Store (HMAC Hex)</option>
                <option value="shopify">Shopify (HMAC Base64)</option>
                <option value="woocommerce">WooCommerce (HMAC Base64)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">External Order ID</label>
              <input
                value={externalOrderId}
                onChange={(e) => setExternalOrderId(e.target.value)}
                required
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Customer Name</label>
              <input
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                required
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">BD Phone (auto E.164)</label>
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                required
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
          </div>

          {/* Dynamic Multi-Product Cart Items */}
          <div className="space-y-3 pt-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
                Order Line Items ({cartRows.length} {cartRows.length === 1 ? 'Product' : 'Products'})
              </span>
              <button
                type="button"
                onClick={addAnotherProductRow}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 text-xs font-semibold"
              >
                <Plus className="w-3.5 h-3.5" /> Add Another Product
              </button>
            </div>

            {cartRows.map((row, idx) => (
              <div
                key={row.rowId}
                className="p-3.5 rounded-xl bg-slate-50 border border-slate-200/90 space-y-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-0.5 rounded bg-indigo-600 text-white text-[10px] font-bold">
                      Item #{idx + 1}
                    </span>
                    <span className="text-[11px] font-semibold text-slate-500">
                      Category: {row.category} · SKU: {row.sku}
                    </span>
                  </div>
                  {cartRows.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeProductRow(row.rowId)}
                      className="text-rose-600 hover:text-rose-800 p-1"
                      title="Remove item"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                {/* Product Selector + Qty + Unit Price */}
                <div className="grid grid-cols-1 md:grid-cols-4 gap-2.5">
                  <div className="md:col-span-2">
                    <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                      Select Product from Company Catalog
                    </label>
                    <select
                      value={row.sku}
                      onChange={(e) => handleSelectProductForRow(row.rowId, e.target.value)}
                      className="w-full px-2.5 py-1.5 text-xs font-semibold border border-slate-300 rounded-lg bg-white"
                    >
                      {catalog.map((c) => (
                        <option key={c.sku} value={c.sku}>
                          {c.banglaName} — {c.productName} (৳{c.unitPrice})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                      Quantity
                    </label>
                    <input
                      type="number"
                      min={1}
                      value={row.quantity}
                      onChange={(e) => handleQuantityChange(row.rowId, Number(e.target.value))}
                      className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                      Unit Price (BDT)
                    </label>
                    <input
                      type="number"
                      value={row.unitPrice}
                      onChange={(e) => handleUnitPriceChange(row.rowId, Number(e.target.value))}
                      className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
                    />
                  </div>
                </div>

                {/* Product-Specific Required Attributes Rendered Dynamically! */}
                <div className="pt-1 border-t border-slate-200/70">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-indigo-600 mb-2">
                    Required Purchase Specifications for {row.productName}:
                  </div>
                  <div className="grid grid-cols-2 gap-2.5">
                    {row.requiredAttributes.map((attrKey) => {
                      const opts = row.attributeOptions?.[attrKey] || [];
                      return (
                        <div key={attrKey}>
                          <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                            {attributeLabels[attrKey] || attrKey}
                          </label>
                          {opts.length > 0 ? (
                            <select
                              value={row.attributes[attrKey] || ''}
                              onChange={(e) =>
                                handleAttributeChange(row.rowId, attrKey, e.target.value)
                              }
                              className="w-full px-2.5 py-1.5 text-xs border border-indigo-200 rounded-lg bg-white"
                            >
                              {opts.map((opt) => {
                                const cleanVal = opt.split(' (')[0];
                                return (
                                  <option key={opt} value={cleanVal}>
                                    {opt}
                                  </option>
                                );
                              })}
                            </select>
                          ) : (
                            <input
                              value={row.attributes[attrKey] || ''}
                              onChange={(e) =>
                                handleAttributeChange(row.rowId, attrKey, e.target.value)
                              }
                              required
                              className="w-full px-2.5 py-1.5 text-xs border border-indigo-200 rounded-lg bg-white"
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between px-3.5 py-2.5 rounded-xl bg-slate-100 text-xs font-bold text-slate-800">
            <span>Total Payable Order Amount ({cartRows.length} items):</span>
            <span className="text-base text-blue-700">
              ৳{computedTotalAmount.toLocaleString()} BDT
            </span>
          </div>

          <button
            type="submit"
            disabled={busy}
            className="w-full inline-flex items-center justify-center gap-2 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-semibold"
          >
            <PhoneCall className="w-4 h-4" />
            Send Signed Order Webhook &amp; Initiate Call
          </button>
        </form>

        {/* Step 2: Listen to Bangla IVR Prompt & Press DTMF 1/2/3 */}
        <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-slate-900">
              2. Simulated Customer Phone &amp; DTMF Keypad
            </h2>
            {activeOrderId && (
              <div className="flex items-center gap-3">
                <Link
                  href={`/live-agent?orderId=${activeOrderId}&mode=new_order_agent`}
                  className="px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold shadow-sm"
                >
                  🎙️ Talk with Live AI about This Order →
                </Link>
                <Link
                  href={`/orders/${activeOrderId}`}
                  className="text-xs font-semibold text-blue-600 hover:underline"
                >
                  View Audit Trail →
                </Link>
              </div>
            )}
          </div>

          {!activeCall ? (
            <div className="p-8 text-center rounded-xl bg-slate-50 border border-dashed border-slate-300 text-xs text-slate-500">
              Trigger an order webhook on the left to generate the Bangla voice prompt and activate the keypad.
            </div>
          ) : (
            <div className="space-y-4">
              <div className="p-3.5 rounded-lg bg-slate-900 text-slate-100 space-y-2">
                <div className="flex items-center justify-between text-xs text-blue-300">
                  <span className="inline-flex items-center gap-1.5 font-semibold">
                    <Volume2 className="w-4 h-4" /> Playing Authoritative Bangla Prompt
                  </span>
                  <code className="text-[11px]">{activeCall.providerCallId}</code>
                </div>
                <p className="text-sm leading-relaxed text-white">{activeCall.promptText}</p>
                {activeCall.audioUrl && (
                  <audio controls className="w-full h-9 mt-2" src={activeCall.audioUrl} />
                )}
              </div>

              <div className="grid grid-cols-3 gap-2.5">
                <button
                  onClick={() => sendDtmfOrEvent('dtmf', '1')}
                  disabled={busy}
                  className="p-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-center transition"
                >
                  <div className="text-lg font-bold">1</div>
                  <div className="text-[11px] flex items-center justify-center gap-1">
                    <CheckCircle2 className="w-3 h-3" /> Confirm
                  </div>
                </button>
                <button
                  onClick={() => sendDtmfOrEvent('dtmf', '2')}
                  disabled={busy}
                  className="p-3 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-center transition"
                >
                  <div className="text-lg font-bold">2</div>
                  <div className="text-[11px] flex items-center justify-center gap-1">
                    <XCircle className="w-3 h-3" /> Cancel
                  </div>
                </button>
                <button
                  onClick={() => sendDtmfOrEvent('dtmf', '3')}
                  disabled={busy}
                  className="p-3 rounded-xl bg-teal-600 hover:bg-teal-700 text-white text-center transition"
                >
                  <div className="text-lg font-bold">3</div>
                  <div className="text-[11px] flex items-center justify-center gap-1">
                    <MessageSquare className="w-3 h-3" /> WhatsApp
                  </div>
                </button>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <button
                  onClick={() => sendDtmfOrEvent('dtmf', 'no_input')}
                  disabled={busy}
                  className="py-2 rounded-lg border border-slate-300 hover:bg-slate-50 text-xs font-medium text-slate-700"
                >
                  No Input (Replay)
                </button>
                <button
                  onClick={() => sendDtmfOrEvent('dtmf', '9')}
                  disabled={busy}
                  className="py-2 rounded-lg border border-slate-300 hover:bg-slate-50 text-xs font-medium text-slate-700"
                >
                  Invalid Key (9)
                </button>
                <button
                  onClick={() => sendDtmfOrEvent('no_answer')}
                  disabled={busy}
                  className="py-2 rounded-lg border border-orange-300 bg-orange-50 hover:bg-orange-100 text-xs font-medium text-orange-800"
                >
                  No Answer (Retry)
                </button>
              </div>

              {lastDtmfResponse && (
                <div className="p-3.5 rounded-lg bg-blue-50 border border-blue-200 text-xs space-y-1.5">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-blue-950">Backend Action:</span>
                    <StatusBadge value={lastDtmfResponse.action} />
                  </div>
                  {lastDtmfResponse.spokenPrompt && (
                    <p className="text-slate-800">IVR Response: “{lastDtmfResponse.spokenPrompt}”</p>
                  )}
                  {lastDtmfResponse.whatsappDeepLink && (
                    <p className="text-teal-800 break-all">
                      WhatsApp Deep Link:{' '}
                      <a
                        href={lastDtmfResponse.whatsappDeepLink}
                        target="_blank"
                        rel="noreferrer"
                        className="underline font-mono"
                      >
                        {lastDtmfResponse.whatsappDeepLink}
                      </a>
                    </p>
                  )}
                  {lastDtmfResponse.retryScheduledAt && (
                    <p className="text-orange-800">
                      Next Retry Scheduled (UTC): <code>{lastDtmfResponse.retryScheduledAt}</code>
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Step 3: Inbound WhatsApp Customer Instruction */}
          <div className="pt-4 border-t border-slate-100 space-y-2.5">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">
              3. Simulate Inbound WhatsApp Reply (After Key 3)
            </h3>
            <div className="flex gap-2">
              <input
                value={waMessage}
                onChange={(e) => setWaMessage(e.target.value)}
                className="flex-1 px-3 py-2 text-xs border border-slate-300 rounded-lg"
                placeholder="Customer custom instruction in Bangla..."
              />
              <button
                onClick={sendWhatsAppReply}
                disabled={busy}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-xs font-semibold"
              >
                <Send className="w-3.5 h-3.5" /> Send WA
              </button>
            </div>
            {waResult && <p className="text-xs font-medium text-teal-800">{waResult}</p>}
          </div>
        </div>
      </div>

      {/* Live Execution Log */}
      {log.length > 0 && (
        <div className="bg-slate-950 text-slate-200 rounded-xl p-4 font-mono text-xs space-y-1">
          <div className="text-[11px] uppercase tracking-wider text-slate-400 mb-2">
            Live Workbench Event Log
          </div>
          {log.map((line, idx) => (
            <div key={idx}>{line}</div>
          ))}
        </div>
      )}
    </div>
  );
}
