'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { Radio, Sparkles, User } from 'lucide-react';
import { useAuth } from '@/components/AuthContext';
import { LatencyTelemetryBar } from '@/components/voice/LatencyTelemetryBar';
import { LiveCartSpecsPanel } from '@/components/voice/LiveCartSpecsPanel';
import { LiveTranscriptStream } from '@/components/voice/LiveTranscriptStream';
import { VoiceOrbVisualizer } from '@/components/voice/VoiceOrbVisualizer';
import { useRealtimeVoice } from '@/lib/realtime/useRealtimeVoice';

export default function RealtimeVoicePage() {
  const { token, activeTenantId } = useAuth();
  const [customerName, setCustomerName] = useState('আব্দুল্লাহ আল মাহাদী');
  const [customerPhone, setCustomerPhone] = useState('+8801712345678');
  const [voiceName, setVoiceName] = useState('bn-BD-PradeepNeural');

  const rt = useRealtimeVoice({
    token,
    tenantId: activeTenantId,
    customerName,
    customerPhone,
    voiceName,
  });

  return (
    <div className="space-y-5">
      {/* Header Banner */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-bold uppercase tracking-wider bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
              <Radio className="h-3 w-3 animate-pulse" />
              Phase 3 · Real-Time Full-Duplex Audio
            </span>
            <span className="text-xs text-slate-400">
              WebAudio AEC + Semantic Turn + Instant Barge-In + Speculative RAG
            </span>
          </div>
          <h1 className="text-2xl font-bold text-slate-100 mt-1">
            Real-Time Full-Duplex AI Voice Console
          </h1>
          <p className="text-sm text-slate-400 mt-0.5">
            Speak naturally in Bangla — start talking anytime while the AI is speaking and it immediately pauses to listen, just like ChatGPT Voice Mode.
          </p>
        </div>

        <Link
          href="/live-agent"
          className="text-xs px-3 py-2 rounded-xl border border-slate-700 bg-slate-900 hover:bg-slate-800 text-slate-300 transition"
        >
          Switch to Classic Turn-Based Console
        </Link>
      </div>

      {/* Caller & Voice Config Bar */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
        <label className="space-y-1">
          <span className="flex items-center gap-1.5 text-slate-400 font-medium">
            <User className="h-3.5 w-3.5 text-sky-400" />
            Customer Name
          </span>
          <input
            type="text"
            value={customerName}
            disabled={rt.connected}
            onChange={(e) => setCustomerName(e.target.value)}
            className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-slate-100 disabled:opacity-60"
          />
        </label>

        <label className="space-y-1">
          <span className="text-slate-400 font-medium block">Customer Phone (BD)</span>
          <input
            type="text"
            value={customerPhone}
            disabled={rt.connected}
            onChange={(e) => setCustomerPhone(e.target.value)}
            className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-slate-100 disabled:opacity-60"
          />
        </label>

        <label className="space-y-1">
          <span className="flex items-center gap-1.5 text-slate-400 font-medium">
            <Sparkles className="h-3.5 w-3.5 text-violet-400" />
            Neural Bangla Voice (Streaming Clauses)
          </span>
          <select
            value={voiceName}
            disabled={rt.connected}
            onChange={(e) => setVoiceName(e.target.value)}
            className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-slate-100 disabled:opacity-60"
          >
            <option value="bn-BD-PradeepNeural">Pradeep (Bangladeshi Male Neural)</option>
            <option value="bn-BD-NabanitaNeural">Nabanita (Bangladeshi Female Neural)</option>
          </select>
        </label>
      </div>

      {rt.error && (
        <div className="rounded-xl border border-rose-700/60 bg-rose-950/50 px-4 py-3 text-sm text-rose-200">
          {rt.error}
        </div>
      )}

      {/* Live Millisecond Telemetry Bar */}
      <LatencyTelemetryBar latency={rt.latency} connected={rt.connected} />

      {/* Main 3-Column Full-Duplex Workspace */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        <div className="lg:col-span-4">
          <VoiceOrbVisualizer
            connected={rt.connected}
            agentState={rt.agentState}
            muted={rt.muted}
            bargeInEnabled={rt.bargeInEnabled}
            vadSensitivity={rt.vadSensitivity}
            micLevel={rt.micLevel}
            speakerLevel={rt.speakerLevel}
            bargeInCount={rt.bargeInCount}
            stageBadge={rt.stageBadge}
            onConnect={rt.connect}
            onDisconnect={rt.disconnect}
            onToggleMute={rt.toggleMute}
            onManualInterrupt={rt.triggerManualBargeIn}
            onToggleBargeIn={rt.updateBargeInEnabled}
            onChangeVadSensitivity={rt.updateVadSensitivity}
          />
        </div>

        <div className="lg:col-span-5">
          <LiveTranscriptStream
            messages={rt.messages}
            interimText={rt.interimText}
            connected={rt.connected}
            onSendText={rt.sendFinalUtterance}
          />
        </div>

        <div className="lg:col-span-3">
          <LiveCartSpecsPanel
            speculativeProducts={rt.speculativeProducts}
            draftItems={rt.draftItems}
            guardrailReport={rt.guardrailReport}
            confirmed={rt.confirmed}
          />
        </div>
      </div>
    </div>
  );
}
