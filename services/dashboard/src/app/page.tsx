'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  CheckCircle2,
  Clock,
  Info,
  MessageSquare,
  PhoneCall,
  RefreshCw,
  XCircle,
} from 'lucide-react';
import { useAuth } from '@/components/AuthContext';
import { StatusBadge } from '@/components/StatusBadge';
import { apiFetch, formatTenantDateTime } from '@/lib/api';

interface UsageResponse {
  tenant: { id: string; name: string; timezone: string };
  metrics: {
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
  };
  costBoundaryNote: string;
  activeProviders: { tts: string; telephony: string; whatsapp: string } | null;
}

interface OrderListItem {
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
  createdAt: string;
  items: { productName: string; colour: string | null; size: string | null; quantity: number }[];
}

export default function DashboardOverviewPage() {
  const { token, activeTenantId } = useAuth();
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [orders, setOrders] = useState<OrderListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = async () => {
    if (!token || !activeTenantId) return;
    setLoading(true);
    setError(null);
    try {
      const [u, o] = await Promise.all([
        apiFetch<UsageResponse>('/api/dashboard/usage', { token, tenantId: activeTenantId }),
        apiFetch<{ orders: OrderListItem[] }>('/api/orders', { token, tenantId: activeTenantId }),
      ]);
      setUsage(u);
      setOrders(o.orders);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dashboard');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [token, activeTenantId]);

  const m = usage?.metrics;
  const tz = usage?.tenant?.timezone || 'Asia/Dhaka';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Usage & Verification Overview</h1>
          <p className="text-sm text-slate-500">
            Real-time Bangla IVR/DTMF order verification metrics and tenant order queue
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/live-agent"
            className="px-3.5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold"
          >
            🎙️ Talk with Live AI Voice Assistant
          </Link>
          <Link
            href="/simulator"
            className="px-3.5 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold"
          >
            + Simulate New Order Call
          </Link>
          <button
            onClick={loadData}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white border border-slate-200 hover:bg-slate-50 text-xs font-medium text-slate-700"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">{error}</div>
      )}

      {/* KPI Grid (SRS Section 14 — Usage) */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between text-xs font-medium text-slate-500">
            <span>Call Attempts / Answered</span>
            <PhoneCall className="w-4 h-4 text-blue-500" />
          </div>
          <div className="mt-2 text-2xl font-bold text-slate-900">
            {m?.totalAttempts ?? 0}{' '}
            <span className="text-sm font-normal text-slate-500">/ {m?.answered ?? 0} ans</span>
          </div>
          <div className="mt-1 text-xs text-slate-500">Total orders tracked: {m?.totalOrders ?? 0}</div>
        </div>

        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between text-xs font-medium text-slate-500">
            <span>Confirmed (Key 1)</span>
            <CheckCircle2 className="w-4 h-4 text-emerald-500" />
          </div>
          <div className="mt-2 text-2xl font-bold text-emerald-700">{m?.confirmed ?? 0}</div>
          <div className="mt-1 text-xs text-slate-500">
            Pending store sync: {m?.pendingStoreSync ?? 0}
          </div>
        </div>

        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between text-xs font-medium text-slate-500">
            <span>Cancel Req / Cancelled (Key 2)</span>
            <XCircle className="w-4 h-4 text-rose-500" />
          </div>
          <div className="mt-2 text-2xl font-bold text-rose-700">
            {(m?.cancellationRequests ?? 0) + (m?.cancelled ?? 0)}
          </div>
          <div className="mt-1 text-xs text-slate-500">
            {m?.cancelled ?? 0} auto-cancelled · {m?.cancellationRequests ?? 0} review
          </div>
        </div>

        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between text-xs font-medium text-slate-500">
            <span>WhatsApp (Key 3) / No Ans</span>
            <MessageSquare className="w-4 h-4 text-teal-500" />
          </div>
          <div className="mt-2 text-2xl font-bold text-teal-700">
            {m?.whatsappRequested ?? 0}{' '}
            <span className="text-sm font-normal text-slate-500">/ {m?.noAnswer ?? 0} no-ans</span>
          </div>
          <div className="mt-1 text-xs text-slate-500">
            Est. {m?.estimatedVoiceMinutes ?? 0} min (~৳{m?.estimatedTelephonyCostBdt ?? 0} carrier)
          </div>
        </div>
      </div>

      {/* Zero-Cost Boundary & Active Adapter Banner (SRS Section 7 & 16) */}
      {usage && (
        <div className="bg-blue-50/70 border border-blue-200 rounded-xl p-4 flex items-start gap-3">
          <Info className="w-4 h-4 text-blue-600 mt-0.5 shrink-0" />
          <div className="text-xs text-blue-950 space-y-1">
            <div className="font-semibold">
              Active Adapters: TTS = <code className="bg-white px-1.5 py-0.5 rounded">{usage.activeProviders?.tts}</code>{' '}
              · Telephony = <code className="bg-white px-1.5 py-0.5 rounded">{usage.activeProviders?.telephony}</code>{' '}
              · WhatsApp = <code className="bg-white px-1.5 py-0.5 rounded">{usage.activeProviders?.whatsapp}</code>
            </div>
            <p className="text-blue-800">{usage.costBoundaryNote}</p>
          </div>
        </div>
      )}

      {/* Orders Table */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <h2 className="text-sm font-bold text-slate-900">Recent Orders & Verification Status</h2>
          <span className="text-xs text-slate-500">Timezone: {tz}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-[11px] font-semibold uppercase text-slate-500">
                <th className="py-3 px-4">Order</th>
                <th className="py-3 px-4">Customer & Masked Phone</th>
                <th className="py-3 px-4">Product Summary</th>
                <th className="py-3 px-4">Amount</th>
                <th className="py-3 px-4">Verification</th>
                <th className="py-3 px-4">Store Sync</th>
                <th className="py-3 px-4">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-sm">
              {orders.map((o) => {
                const firstItem = o.items[0];
                return (
                  <tr key={o.id} className="hover:bg-slate-50/80 transition">
                    <td className="py-3 px-4">
                      <Link
                        href={`/orders/${o.id}`}
                        className="font-semibold text-blue-600 hover:underline"
                      >
                        {o.externalOrderId}
                      </Link>
                      <div className="text-[11px] text-slate-400 uppercase">{o.storeProvider}</div>
                    </td>
                    <td className="py-3 px-4">
                      <div className="font-medium text-slate-800">{o.customerName}</div>
                      <div className="text-xs font-mono text-slate-500">{o.maskedPhone}</div>
                    </td>
                    <td className="py-3 px-4 text-xs text-slate-700">
                      {firstItem ? (
                        <span>
                          {firstItem.productName}
                          {firstItem.colour ? ` · ${firstItem.colour}` : ''}
                          {firstItem.size ? ` · Size ${firstItem.size}` : ''}
                          {o.items.length > 1 ? ` (+${o.items.length - 1})` : ''}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="py-3 px-4 font-semibold text-slate-800">
                      {o.totalAmount.toLocaleString()} {o.currency}
                    </td>
                    <td className="py-3 px-4">
                      <StatusBadge value={o.verificationStatus} />
                    </td>
                    <td className="py-3 px-4">
                      <StatusBadge value={o.storeSyncStatus} />
                    </td>
                    <td className="py-3 px-4 text-xs text-slate-500">
                      <span className="inline-flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {formatTenantDateTime(o.createdAt, tz)}
                      </span>
                    </td>
                  </tr>
                );
              })}
              {orders.length === 0 && !loading && (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-sm text-slate-400">
                    No orders yet for this tenant. Use the Webhook & IVR Test Bench to create one.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
