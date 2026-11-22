'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, RefreshCw, RotateCcw } from 'lucide-react';
import { useAuth } from '@/components/AuthContext';
import { StatusBadge } from '@/components/StatusBadge';
import { apiFetch, formatTenantDateTime } from '@/lib/api';

interface ErrorMonitorResponse {
  pendingSyncOrders: {
    id: string;
    externalOrderId: string;
    storeProvider: string;
    verificationStatus: string;
    storeSyncStatus: string;
    storeSyncError: string | null;
    updatedAt: string;
  }[];
  failedJobs: {
    id: string;
    orderId: string;
    status: string;
    attemptNo: number;
    maxAttempts: number;
    lastError: string | null;
    updatedAt: string;
  }[];
  errorEvents: {
    id: string;
    orderId: string;
    eventType: string;
    source: string;
    metadata: Record<string, unknown> | null;
    createdAt: string;
  }[];
}

export default function ErrorMonitorPage() {
  const { token, activeTenantId } = useAuth();
  const [data, setData] = useState<ErrorMonitorResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);

  const load = async () => {
    if (!token || !activeTenantId) return;
    setLoading(true);
    try {
      const res = await apiFetch<ErrorMonitorResponse>('/api/dashboard/errors', {
        token,
        tenantId: activeTenantId,
      });
      setData(res);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [token, activeTenantId]);

  const retrySync = async (orderId: string) => {
    if (!token || !activeTenantId) return;
    setMsg(null);
    try {
      await apiFetch(`/api/dashboard/errors/${orderId}/retry-sync`, {
        method: 'POST',
        token,
        tenantId: activeTenantId,
      });
      setMsg('Store synchronization succeeded!');
      await load();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Store sync retry failed');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Error Monitor & Dead-Letter Queue</h1>
          <p className="text-sm text-slate-500">
            Track TTS failures, telephony outages, callback rejections, DLQ jobs, and pending store synchronizations
          </p>
        </div>
        <button
          onClick={load}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white border border-slate-200 hover:bg-slate-50 text-xs font-medium"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {msg && (
        <div className="p-3 rounded-lg bg-blue-50 border border-blue-200 text-xs text-blue-900">{msg}</div>
      )}

      {/* Pending Store Sync */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-500" />
          <h2 className="text-sm font-bold text-slate-900">
            Pending Store-Sync Orders ({data?.pendingSyncOrders.length ?? 0})
          </h2>
        </div>
        <div className="p-4">
          {!data || data.pendingSyncOrders.length === 0 ? (
            <p className="text-xs text-slate-400">All confirmed/cancelled orders are synchronized with stores.</p>
          ) : (
            <div className="space-y-2">
              {data.pendingSyncOrders.map((o) => (
                <div
                  key={o.id}
                  className="p-3 rounded-lg border border-amber-200 bg-amber-50/50 flex items-center justify-between gap-4"
                >
                  <div className="text-xs space-y-0.5">
                    <div className="font-bold text-slate-900">
                      <Link href={`/orders/${o.id}`} className="text-blue-600 hover:underline">
                        {o.externalOrderId}
                      </Link>{' '}
                      <StatusBadge value={o.storeSyncStatus} />
                    </div>
                    <div className="text-amber-900">{o.storeSyncError || 'Store API unreachable'}</div>
                  </div>
                  <button
                    onClick={() => retrySync(o.id)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold"
                  >
                    <RotateCcw className="w-3.5 h-3.5" /> Retry Sync
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Failed / DLQ Call Jobs */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200">
          <h2 className="text-sm font-bold text-slate-900">
            Failed & Dead-Letter Call Jobs ({data?.failedJobs.length ?? 0})
          </h2>
        </div>
        <div className="p-4">
          {!data || data.failedJobs.length === 0 ? (
            <p className="text-xs text-slate-400">Zero failed or dead-letter call jobs.</p>
          ) : (
            <div className="space-y-2">
              {data.failedJobs.map((j) => (
                <div key={j.id} className="p-3 rounded-lg border border-red-200 bg-red-50/50 text-xs flex justify-between">
                  <div>
                    <Link href={`/orders/${j.orderId}`} className="font-semibold text-blue-600 hover:underline">
                      Order {j.orderId.slice(0, 8)}
                    </Link>
                    <span className="ml-2"><StatusBadge value={j.status} /></span>
                    <div className="text-red-800 mt-1">{j.lastError || 'Unknown job error'}</div>
                  </div>
                  <div className="text-slate-500">
                    Attempt {j.attemptNo}/{j.maxAttempts} · {formatTenantDateTime(j.updatedAt)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Error Audit Log */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200">
          <h2 className="text-sm font-bold text-slate-900">
            Recent TTS, Telephony & Callback Errors ({data?.errorEvents.length ?? 0})
          </h2>
        </div>
        <div className="p-4">
          {!data || data.errorEvents.length === 0 ? (
            <p className="text-xs text-slate-400">No error events logged for this tenant.</p>
          ) : (
            <div className="divide-y divide-slate-100">
              {data.errorEvents.map((ev) => (
                <div key={ev.id} className="py-2.5 text-xs flex items-start justify-between gap-4">
                  <div>
                    <span className="font-semibold text-red-700">{ev.eventType}</span>
                    <span className="text-slate-400 ml-2">({ev.source})</span>
                    {ev.metadata && (
                      <pre className="mt-1 text-[11px] bg-slate-50 p-2 rounded border border-slate-200 text-slate-600">
                        {JSON.stringify(ev.metadata)}
                      </pre>
                    )}
                  </div>
                  <div className="text-slate-400 shrink-0">{formatTenantDateTime(ev.createdAt)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
