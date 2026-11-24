'use client';

import React from 'react';
import { Activity } from 'lucide-react';
import { RealtimeLatencyMetrics } from '@/lib/realtime/dataChannelProtocol';

interface LatencyTelemetryBarProps {
  latency: RealtimeLatencyMetrics;
  connected: boolean;
}

export function LatencyTelemetryBar({ latency, connected }: LatencyTelemetryBarProps) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/70 px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-xs">
      <div className="flex items-center gap-2 text-slate-200 font-semibold">
        <Activity className={`h-4 w-4 ${connected ? 'text-emerald-400' : 'text-slate-500'}`} />
        <span>Real-Time Audio Telemetry</span>
      </div>

      <div className="flex flex-wrap items-center gap-3 font-mono text-[11px]">
        <span className="px-2.5 py-1 rounded-lg bg-slate-950 border border-slate-800 text-sky-300">
          Speculative RAG: <strong>{latency.ragMs.toFixed(1)} ms</strong>
        </span>
        <span className="px-2.5 py-1 rounded-lg bg-slate-950 border border-slate-800 text-violet-300">
          Reasoning: <strong>{latency.reasoningMs.toFixed(1)} ms</strong>
        </span>
        <span className="px-2.5 py-1 rounded-lg bg-slate-950 border border-slate-800 text-emerald-300">
          TTS 1st Clause: <strong>{latency.ttsTtfbMs.toFixed(0)} ms</strong>
        </span>
        <span className="px-2.5 py-1 rounded-lg bg-slate-950 border border-slate-800 text-amber-300">
          Semantic EOT:{' '}
          <strong>
            {latency.recommendedSilenceMs ? `${latency.recommendedSilenceMs} ms` : 'Auto'}
          </strong>
        </span>
      </div>
    </div>
  );
}
