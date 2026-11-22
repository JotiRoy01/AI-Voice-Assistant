'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, MessageSquare, PhoneForwarded, RotateCcw, Volume2 } from 'lucide-react';
import { useAuth } from '@/components/AuthContext';
import { StatusBadge } from '@/components/StatusBadge';
import { apiFetch, formatTenantDateTime } from '@/lib/api';

interface OrderHistoryResponse {
  order: {
    id: string;
    externalOrderId: string;
    storeProvider: string;
    customerName: string;
    maskedPhone: string;
    totalAmount: number;
    currency: string;
    orderStatus: string;
    verificationStatus: string;
    storeSyncStatus: string;
    storeSyncError: string | null;
    createdAt: string;
    items: {
      id: string;
      productName: string;
      variant: string | null;
      colour: string | null;
      size: string | null;
      quantity: number;
      unitPrice: number;
    }[];
  };
  promptPreview: { opening: string; menu: string; fullScript: string };
  calls: {
    id: string;
    providerCallId: string | null;
    callStatus: string;
    dtmfResult: string;
    durationSec: number;
    audioUrl: string | null;
    startedAt: string | null;
  }[];
  timeline: {
    id: string;
    eventType: string;
    source: string;
    metadata: Record<string, unknown> | null;
    createdAt: string;
  }[];
  instructions: {
    id: string;
    channel: string;
    maskedSender: string;
    messageText: string;
    receivedAt: string;
    status: string;
  }[];
}

export default function OrderDetailsPage() {
  const params = useParams();
  const orderId = String(params.id || '');
  const { token, activeTenantId } = useAuth();
  const [data, setData] = useState<OrderHistoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryMsg, setRetryMsg] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  const loadOrder = async () => {
    if (!token || !activeTenantId || !orderId) return;
    setError(null);
    try {
      const res = await apiFetch<OrderHistoryResponse>(`/api/orders/${orderId}/voice-history`, {
        token,
        tenantId: activeTenantId,
      });
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load order details');
    }
  };

  useEffect(() => {
    loadOrder();
  }, [token, activeTenantId, orderId]);

  const handleManualRetry = async () => {
    if (!token || !activeTenantId) return;
    setRetrying(true);
    setRetryMsg(null);
    try {
      await apiFetch(`/api/voice/orders/${orderId}/retry`, {
        method: 'POST',
        token,
        tenantId: activeTenantId,
        body: JSON.stringify({ bypassCallingWindow: true }),
      });
      setRetryMsg('Manual verification retry call enqueued.');
      setTimeout(loadOrder, 300);
    } catch (err) {
      setRetryMsg(err instanceof Error ? err.message : 'Retry rejected');
    } finally {
      setRetrying(false);
    }
  };

  if (error) {
    return (
      <div className="space-y-4">
        <Link href="/" className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:underline">
          <ArrowLeft className="w-4 h-4" /> Back to Overview
        </Link>
        <div className="p-4 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm">{error}</div>
      </div>
    );
  }

  if (!data) {
    return <div className="text-sm text-slate-500">Loading order verification details...</div>;
  }

  const { order, promptPreview, calls, timeline, instructions } = data;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/" className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-blue-600 mb-1">
            <ArrowLeft className="w-3.5 h-3.5" /> Back to Orders
          </Link>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-slate-900">Order {order.externalOrderId}</h1>
            <StatusBadge value={order.verificationStatus} />
            <StatusBadge value={order.storeSyncStatus} />
          </div>
          <p className="text-sm text-slate-500 mt-0.5">
            {order.customerName} · {order.maskedPhone} · {order.totalAmount.toLocaleString()} {order.currency} ({order.storeProvider})
          </p>
        </div>

        <button
          onClick={handleManualRetry}
          disabled={retrying}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white text-xs font-semibold"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          {retrying ? 'Requesting Retry...' : 'Permitted Manual Retry'}
        </button>
      </div>

      {retryMsg && (
        <div className="p-3 rounded-lg bg-blue-50 border border-blue-200 text-xs text-blue-900">
          {retryMsg}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left 2 cols: Prompt + Line Items + Calls */}
        <div className="lg:col-span-2 space-y-6">
          <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm space-y-3">
            <div className="flex items-center gap-2 text-sm font-bold text-slate-900">
              <Volume2 className="w-4 h-4 text-blue-600" />
              Authoritative Bangla IVR Script (Generated from DB Order)
            </div>
            <div className="p-4 rounded-lg bg-slate-50 border border-slate-200 text-sm leading-relaxed text-slate-800">
              <p className="font-medium">{promptPreview.opening}</p>
              <p className="mt-2 text-slate-600">{promptPreview.menu}</p>
            </div>
            <div className="pt-2">
              <div className="text-xs font-semibold text-slate-500 uppercase mb-2">Line Items</div>
              <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
                {order.items.map((item) => (
                  <div key={item.id} className="px-3.5 py-2.5 flex items-center justify-between text-xs">
                    <div>
                      <span className="font-semibold text-slate-800">{item.productName}</span>
                      {item.colour && <span className="text-slate-500 ml-2">Colour: {item.colour}</span>}
                      {item.size && <span className="text-slate-500 ml-2">Size: {item.size}</span>}
                      <span className="text-slate-500 ml-2">Qty: {item.quantity}</span>
                    </div>
                    <span className="font-mono font-semibold text-slate-700">
                      {item.unitPrice.toLocaleString()} {order.currency}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Call Attempts */}
          <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm space-y-3">
            <div className="flex items-center gap-2 text-sm font-bold text-slate-900">
              <PhoneForwarded className="w-4 h-4 text-blue-600" />
              Voice Call Attempts ({calls.length})
            </div>
            {calls.length === 0 ? (
              <p className="text-xs text-slate-400">No calls initiated yet.</p>
            ) : (
              <div className="space-y-3">
                {calls.map((c) => (
                  <div
                    key={c.id}
                    className="p-3.5 rounded-lg border border-slate-200 flex flex-wrap items-center justify-between gap-3"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <StatusBadge value={c.callStatus} />
                        <StatusBadge value={c.dtmfResult} />
                        <span className="text-xs font-mono text-slate-500">{c.durationSec}s</span>
                      </div>
                      <div className="text-xs text-slate-500">
                        Provider Call ID: <code>{c.providerCallId || '—'}</code> ·{' '}
                        {formatTenantDateTime(c.startedAt)}
                      </div>
                    </div>
                    {c.audioUrl && <audio controls preload="none" className="h-8" src={c.audioUrl} />}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* WhatsApp Custom Instructions (Key 3) */}
          <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm space-y-3">
            <div className="flex items-center gap-2 text-sm font-bold text-slate-900">
              <MessageSquare className="w-4 h-4 text-teal-600" />
              WhatsApp Custom Instructions ({instructions.length})
            </div>
            {instructions.length === 0 ? (
              <p className="text-xs text-slate-400">
                No WhatsApp custom requirements received for this order.
              </p>
            ) : (
              <div className="space-y-2.5">
                {instructions.map((ins) => (
                  <div key={ins.id} className="p-3.5 rounded-lg bg-teal-50/70 border border-teal-200">
                    <div className="flex items-center justify-between text-xs text-teal-900 mb-1">
                      <span className="font-semibold">From {ins.maskedSender} ({ins.channel})</span>
                      <span>{formatTenantDateTime(ins.receivedAt)}</span>
                    </div>
                    <p className="text-sm text-slate-800">{ins.messageText}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right col: Auditable Order Events Timeline */}
        <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
          <h2 className="text-sm font-bold text-slate-900 mb-4">Audit Trail & State Timeline</h2>
          <ol className="relative border-l border-slate-200 ml-2 space-y-4">
            {timeline.map((ev) => (
              <li key={ev.id} className="pl-4 relative">
                <span className="w-2.5 h-2.5 rounded-full bg-blue-500 absolute -left-[5.5px] top-1.5 ring-4 ring-white" />
                <div className="text-xs font-semibold text-slate-900">
                  {ev.eventType.replace(/_/g, ' ')}
                </div>
                <div className="text-[11px] text-slate-400">
                  {ev.source} · {formatTenantDateTime(ev.createdAt)}
                </div>
                {ev.metadata && Object.keys(ev.metadata).length > 0 && (
                  <pre className="mt-1 text-[11px] bg-slate-50 border border-slate-200 rounded p-2 overflow-x-auto text-slate-600">
                    {JSON.stringify(ev.metadata, null, 2)}
                  </pre>
                )}
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}
