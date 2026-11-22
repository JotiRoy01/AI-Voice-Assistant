'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { RefreshCw, Volume2 } from 'lucide-react';
import { useAuth } from '@/components/AuthContext';
import { StatusBadge } from '@/components/StatusBadge';
import { apiFetch, formatTenantDateTime } from '@/lib/api';

interface CallRecord {
  id: string;
  orderId: string;
  externalOrderId: string | null;
  customerName: string | null;
  maskedPhone: string;
  providerCallId: string | null;
  startedAt: string | null;
  durationSec: number;
  callStatus: string;
  dtmfResult: string;
  replayCount: number;
  invalidAttempts: number;
  promptText: string | null;
  audioUrl: string | null;
  errorMessage: string | null;
}

export default function CallHistoryPage() {
  const { token, activeTenantId } = useAuth();
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const loadCalls = async () => {
    if (!token || !activeTenantId) return;
    setLoading(true);
    try {
      const res = await apiFetch<{ calls: CallRecord[] }>('/api/voice/calls', {
        token,
        tenantId: activeTenantId,
      });
      setCalls(res.calls);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadCalls();
  }, [token, activeTenantId]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Call History</h1>
          <p className="text-sm text-slate-500">
            Outbound verification attempts, masked customer phones, duration, DTMF keypad outcomes, and Bangla audio prompts
          </p>
        </div>
        <button
          onClick={loadCalls}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white border border-slate-200 hover:bg-slate-50 text-xs font-medium"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-[11px] font-semibold uppercase text-slate-500">
                <th className="py-3 px-4">Order</th>
                <th className="py-3 px-4">Customer / Masked Phone</th>
                <th className="py-3 px-4">Time (Asia/Dhaka)</th>
                <th className="py-3 px-4">Duration</th>
                <th className="py-3 px-4">Provider Status</th>
                <th className="py-3 px-4">DTMF Result</th>
                <th className="py-3 px-4">Bangla Audio / Prompt</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-sm">
              {calls.map((c) => (
                <tr key={c.id} className="hover:bg-slate-50/70">
                  <td className="py-3 px-4">
                    <Link
                      href={`/orders/${c.orderId}`}
                      className="font-semibold text-blue-600 hover:underline"
                    >
                      {c.externalOrderId || c.orderId.slice(0, 8)}
                    </Link>
                    <div className="text-[11px] font-mono text-slate-400">
                      {c.providerCallId || 'pending'}
                    </div>
                  </td>
                  <td className="py-3 px-4">
                    <div className="font-medium text-slate-800">{c.customerName || '—'}</div>
                    <div className="text-xs font-mono text-slate-500">{c.maskedPhone}</div>
                  </td>
                  <td className="py-3 px-4 text-xs text-slate-600">
                    {formatTenantDateTime(c.startedAt)}
                  </td>
                  <td className="py-3 px-4 text-xs font-mono text-slate-700">{c.durationSec}s</td>
                  <td className="py-3 px-4">
                    <StatusBadge value={c.callStatus} />
                  </td>
                  <td className="py-3 px-4">
                    <StatusBadge value={c.dtmfResult} />
                    {(c.replayCount > 0 || c.invalidAttempts > 0) && (
                      <div className="text-[11px] text-slate-400 mt-1">
                        replays: {c.replayCount} · invalid: {c.invalidAttempts}
                      </div>
                    )}
                  </td>
                  <td className="py-3 px-4 max-w-xs">
                    {c.audioUrl && (
                      <audio controls preload="none" className="h-7 w-48 mb-1" src={c.audioUrl} />
                    )}
                    {c.promptText && (
                      <div className="text-xs text-slate-600 line-clamp-2 flex items-start gap-1">
                        <Volume2 className="w-3.5 h-3.5 text-blue-500 shrink-0 mt-0.5" />
                        <span>{c.promptText}</span>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {calls.length === 0 && !loading && (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-sm text-slate-400">
                    No voice calls recorded yet for this tenant.
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
