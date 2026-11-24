'use client';

import React, { useEffect, useRef, useState } from 'react';
import { MessageSquare, Send, Sparkles } from 'lucide-react';
import { RealtimeTranscriptMessage } from '@/lib/realtime/dataChannelProtocol';

interface LiveTranscriptStreamProps {
  messages: RealtimeTranscriptMessage[];
  interimText: string;
  connected: boolean;
  onSendText: (text: string) => void;
}

export function LiveTranscriptStream(props: LiveTranscriptStreamProps) {
  const [draft, setDraft] = useState('');
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [props.messages, props.interimText]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.trim() || !props.connected) return;
    props.onSendText(draft.trim());
    setDraft('');
  };

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-950/90 flex flex-col h-[480px] overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between bg-slate-900/60">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-sky-400" />
          <h3 className="text-sm font-semibold text-slate-100">
            Full-Duplex Live Transcript
          </h3>
        </div>
        <span className="text-[11px] text-slate-400">
          Spoken-Context Truncation Active
        </span>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {props.messages.length === 0 && !props.interimText && (
          <div className="h-full flex flex-col items-center justify-center text-center text-slate-500 px-6">
            <Sparkles className="h-8 w-8 mb-2 text-slate-600" />
            <p className="text-sm font-medium text-slate-400">
              Start the Full-Duplex Call and speak naturally in Bangla.
            </p>
            <p className="text-xs mt-1 text-slate-500">
              You can interrupt the AI mid-sentence anytime — playback flushes in &lt;50ms and the AI pauses to listen!
            </p>
          </div>
        )}

        {props.messages.map((m) => (
          <div
            key={m.id}
            className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}
          >
            <div
              className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                m.role === 'user'
                  ? 'bg-emerald-600/20 border border-emerald-500/40 text-emerald-100'
                  : m.interrupted
                  ? 'bg-amber-950/40 border border-amber-600/50 text-amber-100'
                  : 'bg-slate-900 border border-slate-800 text-slate-100'
              }`}
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] font-bold uppercase tracking-wider opacity-70">
                  {m.role === 'user' ? 'Customer' : 'FlowMind AI'}
                </span>
                {m.interrupted && (
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/40">
                    Interrupted by Caller
                  </span>
                )}
              </div>
              <p>{m.text}</p>
              {m.interrupted && m.discardedText && (
                <p className="mt-1.5 text-xs line-through text-slate-500">
                  (Unspoken — truncated from AI memory: {m.discardedText})
                </p>
              )}
            </div>
          </div>
        ))}

        {/* Live partial speech appearing WHILE the customer is still speaking */}
        {props.interimText && (
          <div className="flex flex-col items-end">
            <div className="max-w-[85%] rounded-2xl px-4 py-2.5 text-sm bg-sky-950/50 border border-sky-500/50 text-sky-100 animate-pulse">
              <span className="block text-[10px] font-bold uppercase tracking-wider text-sky-300 mb-0.5">
                Speaking Live (Speculative RAG Active)...
              </span>
              <p>{props.interimText}</p>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      <form
        onSubmit={handleSubmit}
        className="p-3 border-t border-slate-800 bg-slate-900/50 flex items-center gap-2"
      >
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={!props.connected}
          placeholder={
            props.connected
              ? 'Type Bangla/English message (or speak into mic)...'
              : 'Connect call first to speak or type...'
          }
          className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-sky-500 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={!props.connected || !draft.trim()}
          className="px-3.5 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-white transition"
        >
          <Send className="h-4 w-4" />
        </button>
      </form>
    </div>
  );
}
