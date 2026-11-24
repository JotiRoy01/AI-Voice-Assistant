'use client';

import React from 'react';
import { Hand, Mic, MicOff, PhoneCall, PhoneOff, ShieldCheck, Sliders } from 'lucide-react';
import { RealtimeAgentState } from '@/lib/realtime/dataChannelProtocol';

interface VoiceOrbVisualizerProps {
  connected: boolean;
  agentState: RealtimeAgentState;
  muted: boolean;
  bargeInEnabled: boolean;
  vadSensitivity: number;
  micLevel: number;
  speakerLevel: number;
  bargeInCount: number;
  stageBadge: string;
  onConnect: () => void;
  onDisconnect: () => void;
  onToggleMute: () => void;
  onManualInterrupt: () => void;
  onToggleBargeIn: (enabled: boolean) => void;
  onChangeVadSensitivity: (val: number) => void;
}

const STATE_CONFIG: Record<
  RealtimeAgentState,
  { label: string; sublabel: string; ringClass: string; coreClass: string; badgeClass: string }
> = {
  idle: {
    label: 'Standby',
    sublabel: 'Click Start Real-Time Call to open Full-Duplex Audio',
    ringClass: 'border-slate-700/60',
    coreClass: 'from-slate-700 to-slate-800',
    badgeClass: 'bg-slate-800 text-slate-300 border-slate-700',
  },
  connecting: {
    label: 'Connecting...',
    sublabel: 'Opening 16kHz AEC Mic + Full-Duplex WebSocket',
    ringClass: 'border-amber-500/60 animate-pulse',
    coreClass: 'from-amber-500 to-orange-600',
    badgeClass: 'bg-amber-950/60 text-amber-300 border-amber-700/60',
  },
  listening: {
    label: 'Listening to You',
    sublabel: 'Always-On Mic · Speak naturally in Bangla',
    ringClass: 'border-emerald-400/70 shadow-[0_0_50px_rgba(16,185,129,0.35)]',
    coreClass: 'from-emerald-400 via-teal-500 to-cyan-600',
    badgeClass: 'bg-emerald-950/70 text-emerald-300 border-emerald-700/60',
  },
  thinking: {
    label: 'Reasoning + Guardrails',
    sublabel: 'Running RAG + Anti-Hallucination Fact Check',
    ringClass: 'border-violet-400/70 shadow-[0_0_50px_rgba(139,92,246,0.35)]',
    coreClass: 'from-violet-500 via-purple-600 to-indigo-600',
    badgeClass: 'bg-violet-950/70 text-violet-300 border-violet-700/60',
  },
  speaking: {
    label: 'AI Speaking',
    sublabel: 'Start talking anytime — AI will pause immediately (Barge-In)',
    ringClass: 'border-sky-400/80 shadow-[0_0_60px_rgba(56,189,248,0.45)]',
    coreClass: 'from-sky-400 via-blue-500 to-indigo-600',
    badgeClass: 'bg-sky-950/70 text-sky-300 border-sky-700/60',
  },
  interrupted: {
    label: 'Paused for You (Barge-In)',
    sublabel: 'Audio flushed in <50ms · Keep speaking!',
    ringClass: 'border-amber-400/90 shadow-[0_0_55px_rgba(251,191,36,0.45)]',
    coreClass: 'from-amber-400 via-orange-500 to-rose-500',
    badgeClass: 'bg-amber-950/70 text-amber-300 border-amber-700/60',
  },
  ended: {
    label: 'Call Completed',
    sublabel: 'Order session ended cleanly',
    ringClass: 'border-slate-700',
    coreClass: 'from-slate-700 to-slate-800',
    badgeClass: 'bg-slate-800 text-slate-300 border-slate-700',
  },
};

export function VoiceOrbVisualizer(props: VoiceOrbVisualizerProps) {
  const cfg = STATE_CONFIG[props.agentState] || STATE_CONFIG.idle;
  const activeEnergy =
    props.agentState === 'speaking'
      ? Math.max(0.15, props.speakerLevel)
      : props.connected
      ? Math.max(0.06, props.micLevel)
      : 0;
  const orbScale = 1 + activeEnergy * 0.28;
  const outerRingScale = 1.12 + activeEnergy * 0.45;

  return (
    <div className="rounded-2xl border border-slate-800 bg-gradient-to-b from-slate-900 via-slate-950 to-slate-950 p-6 flex flex-col items-center justify-between gap-6">
      <div className="w-full flex items-center justify-between gap-2">
        <span className={`px-3 py-1 rounded-full text-xs font-semibold border ${cfg.badgeClass}`}>
          {cfg.label}
        </span>
        <span className="px-2.5 py-1 rounded-full text-[11px] font-mono bg-slate-900 border border-slate-800 text-slate-300">
          {props.stageBadge}
        </span>
      </div>

      {/* Reactive ChatGPT-style Voice Orb */}
      <div className="relative flex items-center justify-center h-52 w-52 my-2">
        <div
          className={`absolute inset-0 rounded-full border-2 transition-transform duration-75 ${cfg.ringClass}`}
          style={{ transform: `scale(${outerRingScale})`, opacity: props.connected ? 0.5 : 0.2 }}
        />
        <div
          className={`relative h-36 w-36 rounded-full bg-gradient-to-br ${cfg.coreClass} transition-transform duration-75 flex flex-col items-center justify-center shadow-2xl`}
          style={{ transform: `scale(${orbScale})` }}
        >
          {props.muted ? (
            <MicOff className="h-10 w-10 text-white/90" />
          ) : (
            <Mic className="h-10 w-10 text-white/95 drop-shadow" />
          )}
          <span className="mt-1.5 text-[10px] font-semibold uppercase tracking-widest text-white/85">
            {props.connected ? 'LIVE PCM' : 'READY'}
          </span>
        </div>
      </div>

      <div className="text-center space-y-1">
        <p className="text-sm font-medium text-slate-200">{cfg.sublabel}</p>
        <div className="flex items-center justify-center gap-4 text-[11px] text-slate-400">
          <span>Mic Level: {Math.round(props.micLevel * 100)}%</span>
          <span>·</span>
          <span>AI Audio: {Math.round(props.speakerLevel * 100)}%</span>
          <span>·</span>
          <span>Barge-Ins: {props.bargeInCount}</span>
        </div>
      </div>

      {/* Primary Call Controls */}
      <div className="flex flex-wrap items-center justify-center gap-3 w-full">
        {!props.connected ? (
          <button
            onClick={props.onConnect}
            className="flex items-center gap-2 px-6 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold shadow-lg shadow-emerald-950/50 transition"
          >
            <PhoneCall className="h-4 w-4" />
            Start Full-Duplex Call
          </button>
        ) : (
          <>
            <button
              onClick={props.onToggleMute}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-xl font-medium border transition ${
                props.muted
                  ? 'bg-amber-950/70 border-amber-700 text-amber-200'
                  : 'bg-slate-800/90 border-slate-700 text-slate-200 hover:bg-slate-700'
              }`}
            >
              {props.muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
              {props.muted ? 'Unmute Mic' : 'Mute Mic'}
            </button>

            {props.agentState === 'speaking' && (
              <button
                onClick={props.onManualInterrupt}
                className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold transition"
              >
                <Hand className="h-4 w-4" />
                Interrupt AI
              </button>
            )}

            <button
              onClick={props.onDisconnect}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-semibold transition"
            >
              <PhoneOff className="h-4 w-4" />
              End Call
            </button>
          </>
        )}
      </div>

      {/* Real-Time Barge-In & VAD Controls */}
      <div className="w-full pt-4 border-t border-slate-800/80 grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
        <label className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-slate-900/80 border border-slate-800 cursor-pointer">
          <span className="flex items-center gap-1.5 text-slate-300 font-medium">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
            Auto Barge-In (Pause AI)
          </span>
          <input
            type="checkbox"
            checked={props.bargeInEnabled}
            onChange={(e) => props.onToggleBargeIn(e.target.checked)}
            className="h-4 w-4 accent-emerald-500"
          />
        </label>

        <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-slate-900/80 border border-slate-800">
          <span className="flex items-center gap-1.5 text-slate-300 font-medium whitespace-nowrap">
            <Sliders className="h-3.5 w-3.5 text-sky-400" />
            VAD ({props.vadSensitivity.toFixed(3)})
          </span>
          <input
            type="range"
            min={0.02}
            max={0.14}
            step={0.005}
            value={props.vadSensitivity}
            onChange={(e) => props.onChangeVadSensitivity(Number(e.target.value))}
            className="w-24 accent-sky-400"
          />
        </div>
      </div>
    </div>
  );
}
