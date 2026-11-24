'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { FullDuplexAudioPipeline } from './audioPipeline';
import {
  RealtimeAgentState,
  RealtimeDraftItem,
  RealtimeGuardrailReport,
  RealtimeLatencyMetrics,
  RealtimeTokenResponse,
  RealtimeTraceSignal,
  RealtimeTranscriptMessage,
  SpeculativeProductMatch,
} from './dataChannelProtocol';

function normalizeBanglaStt(raw: string): string {
  return raw
    .replace(
      /(?:শেষ|ছায়াছবি|ছায়াছবি|চাইজ|সাইস|সাইট)\s*([০-৯0-9]{2}|এম|এল|এক্সএল|m|l|xl)\b/gi,
      'সাইজ $1'
    )
    .replace(/কালার\s*(?:নিয়ে|নিয়ে)/gi, 'কালার')
    .replace(/করছে\s*আর|কুরসি\s*আর/gi, 'কর্সেয়ার')
    .replace(/দিদি\s*আর|ডি\s*ডি\s*আর|ভিডিও\s*আর/gi, 'DDR')
    .trim();
}

export interface UseRealtimeVoiceOptions {
  token: string | null;
  tenantId: string | null;
  customerName: string;
  customerPhone: string;
  voiceName: string;
  orderId?: string;
  apiKeyOverride?: string;
}

export function useRealtimeVoice(opts: UseRealtimeVoiceOptions) {
  const [connected, setConnected] = useState(false);
  const [agentState, setAgentState] = useState<RealtimeAgentState>('idle');
  const [muted, setMuted] = useState(false);
  const [bargeInEnabled, setBargeInEnabled] = useState(true);
  const [vadSensitivity, setVadSensitivity] = useState(0.055);
  const [micLevel, setMicLevel] = useState(0);
  const [speakerLevel, setSpeakerLevel] = useState(0);

  const [interimText, setInterimText] = useState('');
  const [messages, setMessages] = useState<RealtimeTranscriptMessage[]>([]);
  const [speculativeProducts, setSpeculativeProducts] = useState<SpeculativeProductMatch[]>([]);
  const [draftItems, setDraftItems] = useState<RealtimeDraftItem[]>([]);
  const [stageBadge, setStageBadge] = useState('REAL-TIME STANDBY');
  const [activeNodes, setActiveNodes] = useState<string[]>(['caller_voice']);
  const [signals, setSignals] = useState<RealtimeTraceSignal[]>([]);
  const [guardrailReport, setGuardrailReport] = useState<RealtimeGuardrailReport>({
    passed: true,
    deterministic_total_bdt: 0,
    violations: [],
  });
  const [latency, setLatency] = useState<RealtimeLatencyMetrics>({
    ragMs: 0,
    reasoningMs: 0,
    ttsTtfbMs: 0,
    totalMouthToEarMs: 0,
  });
  const [error, setError] = useState<string | null>(null);
  const [bargeInCount, setBargeInCount] = useState(0);
  const [confirmed, setConfirmed] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const audioRef = useRef<FullDuplexAudioPipeline | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recognitionRef = useRef<any>(null);
  const callActiveRef = useRef(false);
  const mutedRef = useRef(false);
  const bargeInEnabledRef = useRef(true);
  const interimTextRef = useRef('');
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dynamicSilenceMsRef = useRef(1300);
  const activeTurnIdRef = useRef<string | null>(null);

  const sendJson = useCallback((payload: Record<string, unknown>) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(payload));
    }
  }, []);

  const stopSpeechRec = useCallback(() => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    try {
      if (recognitionRef.current) {
        recognitionRef.current.onend = null;
        recognitionRef.current.stop();
      }
    } catch {
      // ignore
    }
    recognitionRef.current = null;
  }, []);

  const triggerManualBargeIn = useCallback(() => {
    if (!audioRef.current) return;
    const playedIdx = audioRef.current.getCurrentClauseIndex();
    audioRef.current.flushPlayback();
    sendJson({ type: 'barge_in_client', played_clause_index: playedIdx });
    setAgentState('interrupted');
    setBargeInCount((c) => c + 1);
  }, [sendJson]);

  const sendFinalUtterance = useCallback(
    (text: string) => {
      const cleaned = normalizeBanglaStt(text);
      if (!cleaned) return;
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
      }
      interimTextRef.current = '';
      setInterimText('');
      setSpeculativeProducts([]);

      setMessages((prev) => [
        ...prev,
        {
          id: `u-${Date.now()}`,
          role: 'user',
          text: cleaned,
          timestamp: new Date().toISOString(),
        },
      ]);
      sendJson({ type: 'transcript_final', text: cleaned });
    },
    [sendJson]
  );

  /**
   * Always-On Continuous Bangla STT Streamer:
   * Unlike Phase 2 (which muted the mic while AI talked), this stays LIVE continuously so:
   *  1. Interim words stream to Python for Speculative RAG while you are still speaking!
   *  2. Speaking while the AI is talking triggers instant Barge-In (<20ms audio flush)!
   *  3. Pause duration adapts dynamically using `BanglaSemanticTurnDetector` (650ms vs 2100ms)!
   */
  const startAlwaysOnSpeechRec = useCallback(() => {
    if (typeof window === 'undefined' || !callActiveRef.current) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SpeechRec = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRec) return;

    stopSpeechRec();
    const recognition = new SpeechRec();
    recognition.lang = 'bn-BD';
    recognition.interimResults = true;
    recognition.continuous = true;
    recognition.maxAlternatives = 5;

    let finalOffsetIndex = 0;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recognition.onresult = (event: any) => {
      if (mutedRef.current || !callActiveRef.current) return;

      const domainKeywordRegex =
        /সাইজ|কালার|রঙ|পাঞ্জাবি|শার্ট|প্যান্ট|র‍্যাম|র্যাম|মনিটর|কিবোর্ড|মাউস|জিবি|কনফার্ম|ঠিকানা|নেভি|কালো|সাদা|মেরুন|কর্সেয়ার|কিংস্টন|ডেলিভারি|পিকআপ|অর্ডার/i;

      let assembled = '';
      for (let i = finalOffsetIndex; i < event.results.length; i++) {
        const resItem = event.results[i];
        let best = resItem[0]?.transcript || '';
        for (let alt = 0; alt < resItem.length; alt++) {
          const cand = resItem[alt]?.transcript || '';
          if (domainKeywordRegex.test(cand) && !domainKeywordRegex.test(best)) {
            best = cand;
            break;
          }
        }
        assembled += best + ' ';
      }

      const cleaned = normalizeBanglaStt(assembled);
      if (!cleaned) return;

      // Instant Barge-In if AI is currently talking and user speaks words!
      if (bargeInEnabledRef.current && audioRef.current?.getIsPlaying() && cleaned.length >= 3) {
        const playedIdx = audioRef.current.getCurrentClauseIndex();
        audioRef.current.flushPlayback();
        sendJson({ type: 'barge_in_client', played_clause_index: playedIdx });
        setAgentState('interrupted');
        setBargeInCount((c) => c + 1);
      }

      interimTextRef.current = cleaned;
      setInterimText(cleaned);

      // Stream partial transcript to Python immediately for Speculative RAG + Smart Semantic Turn timing
      sendJson({
        type: 'transcript_interim',
        text: cleaned,
        played_clause_index: audioRef.current?.getCurrentClauseIndex() ?? -1,
      });

      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      const waitMs = dynamicSilenceMsRef.current;
      silenceTimerRef.current = setTimeout(() => {
        if (interimTextRef.current.trim()) {
          finalOffsetIndex = event.results.length;
          sendFinalUtterance(interimTextRef.current);
        }
      }, waitMs);
    };

    recognition.onend = () => {
      if (!callActiveRef.current) return;
      if (interimTextRef.current.trim()) {
        sendFinalUtterance(interimTextRef.current);
      }
      // Keep always-on speech stream running seamlessly
      setTimeout(() => {
        if (callActiveRef.current) {
          startAlwaysOnSpeechRec();
        }
      }, 180);
    };

    recognition.onerror = () => {
      // handled cleanly by onend auto-restart
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      // ignore
    }
  }, [sendFinalUtterance, sendJson, stopSpeechRec]);

  const disconnect = useCallback(() => {
    callActiveRef.current = false;
    stopSpeechRec();
    audioRef.current?.stop();
    audioRef.current = null;
    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch {
        // ignore
      }
      wsRef.current = null;
    }
    setConnected(false);
    setAgentState('idle');
    setMicLevel(0);
    setSpeakerLevel(0);
    setInterimText('');
  }, [stopSpeechRec]);

  const connect = useCallback(async () => {
    if (!opts.token || !opts.tenantId) {
      setError('Please sign in first.');
      return;
    }
    setError(null);
    setAgentState('connecting');
    setMessages([]);
    setDraftItems([]);
    setSpeculativeProducts([]);
    setConfirmed(false);
    setBargeInCount(0);

    try {
      // 1. Get tenant-scoped session context & WS/LiveKit URL from Node.js backend
      const tokenRes = await apiFetch<RealtimeTokenResponse>('/api/realtime/token', {
        method: 'POST',
        token: opts.token,
        tenantId: opts.tenantId,
        body: JSON.stringify({
          customerName: opts.customerName,
          customerPhone: opts.customerPhone,
          voiceName: opts.voiceName,
          orderId: opts.orderId,
        }),
      });

      // 2. Start Always-On WebAudio Mic (AEC/NS/AGC) + Streaming Speaker Pipeline
      const pipeline = new FullDuplexAudioPipeline({
        onPcmFrame: (pcmBuf) => {
          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(pcmBuf);
          }
        },
        onLocalBargeInDetected: (playedIdx) => {
          sendJson({ type: 'barge_in_client', played_clause_index: playedIdx });
          setAgentState('interrupted');
          setBargeInCount((c) => c + 1);
        },
        onClausePlayed: (turnId, clauseIdx, turnCompleted) => {
          sendJson({
            type: 'audio_playback_ack',
            turn_id: turnId,
            clause_index: clauseIdx,
            turn_completed: turnCompleted,
          });
          if (turnCompleted) {
            setAgentState('listening');
          }
        },
        onLevels: (mLvl, sLvl) => {
          setMicLevel(mLvl);
          setSpeakerLevel(sLvl);
        },
      });
      pipeline.setBargeInConfig(bargeInEnabledRef.current, vadSensitivity);
      await pipeline.start();
      audioRef.current = pipeline;

      // 3. Connect Full-Duplex WebSocket to Python Real-Time Voice Server (:8001/ws/realtime)
      const ws = new WebSocket(tokenRes.wsUrl);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        callActiveRef.current = true;
        setConnected(true);
        setAgentState('listening');
        ws.send(
          JSON.stringify({
            type: 'session_init',
            tenant_id: tokenRes.sessionContext.tenantId,
            customer_name: tokenRes.sessionContext.customerName,
            customer_phone: tokenRes.sessionContext.customerPhone,
            previous_orders_summary: tokenRes.sessionContext.previousOrdersSummary,
            saved_address: tokenRes.sessionContext.savedAddress,
            voice_name: opts.voiceName || tokenRes.sessionContext.voiceName,
            barge_in_enabled: bargeInEnabledRef.current,
            vad_threshold: vadSensitivity,
            api_key: opts.apiKeyOverride || undefined,
          })
        );
        startAlwaysOnSpeechRec();
      };

      ws.onmessage = async (event) => {
        if (typeof event.data !== 'string') return;
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(event.data);
        } catch {
          return;
        }

        const evtType = String(data.type || '');

        if (evtType === 'agent_state') {
          setAgentState((data.state as RealtimeAgentState) || 'listening');
        } else if (evtType === 'speculative_update') {
          const matches = (data.matched_products as SpeculativeProductMatch[]) || [];
          if (matches.length > 0) setSpeculativeProducts(matches);
          const sem = data.semantic_turn as {
            is_complete: boolean;
            recommended_silence_ms: number;
            reason: string;
          } | null;
          if (sem?.recommended_silence_ms) {
            dynamicSilenceMsRef.current = sem.recommended_silence_ms;
          }
          setLatency((prev) => ({
            ...prev,
            ragMs: Number(data.rag_ms || prev.ragMs),
            semanticTurnReason: sem?.reason,
            recommendedSilenceMs: sem?.recommended_silence_ms,
          }));
        } else if (evtType === 'barge_in') {
          // Server-triggered barge-in: immediately flush speaker & mark interrupted bubble!
          audioRef.current?.flushPlayback();
          const spoken = String(data.spoken_text || '');
          const discarded = String(data.discarded_text || '');
          setBargeInCount((c) => c + 1);
          setAgentState('interrupted');
          setMessages((prev) => {
            if (prev.length === 0) return prev;
            const last = prev[prev.length - 1];
            if (last.role !== 'assistant') return prev;
            return [
              ...prev.slice(0, -1),
              {
                ...last,
                text: spoken || last.text,
                interrupted: true,
                discardedText: discarded,
              },
            ];
          });
        } else if (evtType === 'assistant_turn_start') {
          const turnId = String(data.turn_id || '');
          activeTurnIdRef.current = turnId;
          setStageBadge(String(data.stage_badge || 'REAL-TIME ACTIVE'));
          setActiveNodes((data.active_nodes as string[]) || ['caller_voice']);
          setSignals((data.signals as RealtimeTraceSignal[]) || []);
          setDraftItems((data.draft_items as RealtimeDraftItem[]) || []);
          setConfirmed(Boolean(data.confirmed));
          if (data.guardrail_report) {
            setGuardrailReport(data.guardrail_report as RealtimeGuardrailReport);
          }
          const lat = data.latency_ms as { rag?: number; reasoning?: number } | undefined;
          if (lat) {
            setLatency((prev) => ({
              ...prev,
              ragMs: lat.rag ?? prev.ragMs,
              reasoningMs: lat.reasoning ?? prev.reasoningMs,
            }));
          }
          setMessages((prev) => [
            ...prev,
            {
              id: turnId || `a-${Date.now()}`,
              turnId,
              role: 'assistant',
              text: String(data.reply_bangla || ''),
              timestamp: new Date().toISOString(),
            },
          ]);
        } else if (evtType === 'audio_chunk') {
          const turnId = String(data.turn_id || '');
          // Ignore stale audio chunks from a turn that was already interrupted!
          if (activeTurnIdRef.current && turnId !== activeTurnIdRef.current) return;

          if (data.ttfb_ms != null) {
            setLatency((prev) => ({
              ...prev,
              ttsTtfbMs: Number(data.ttfb_ms),
              totalMouthToEarMs: Number(data.total_mouth_to_ear_ms || prev.totalMouthToEarMs),
            }));
          }
          await audioRef.current?.enqueueClauseAudio({
            turnId,
            clauseIndex: Number(data.clause_index || 0),
            totalClauses: Number(data.total_clauses || 1),
            audioBase64: String(data.audio_base64 || ''),
          });
        } else if (evtType === 'assistant_turn_audio_done') {
          if (data.should_end_call) {
            setTimeout(() => disconnect(), 2500);
          }
        }
      };

      ws.onerror = () => {
        setError(
          'Could not connect to Python Real-Time Voice Server (ws://127.0.0.1:8001/ws/realtime). Make sure Terminal 3 (`npm run dev:ai-agent`) is running.'
        );
        disconnect();
      };

      ws.onclose = () => {
        if (callActiveRef.current) {
          disconnect();
        }
      };
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start real-time voice call');
      disconnect();
    }
  }, [disconnect, opts, sendJson, startAlwaysOnSpeechRec, vadSensitivity]);

  const toggleMute = useCallback(() => {
    setMuted((prev) => {
      const next = !prev;
      mutedRef.current = next;
      audioRef.current?.setMuted(next);
      return next;
    });
  }, []);

  const updateBargeInEnabled = useCallback(
    (enabled: boolean) => {
      setBargeInEnabled(enabled);
      bargeInEnabledRef.current = enabled;
      audioRef.current?.setBargeInConfig(enabled, vadSensitivity);
      sendJson({ type: 'update_config', barge_in_enabled: enabled });
    },
    [sendJson, vadSensitivity]
  );

  const updateVadSensitivity = useCallback(
    (threshold: number) => {
      setVadSensitivity(threshold);
      audioRef.current?.setBargeInConfig(bargeInEnabledRef.current, threshold);
      sendJson({ type: 'update_config', vad_threshold: threshold });
    },
    [sendJson]
  );

  useEffect(() => {
    return () => {
      disconnect();
    };
  }, [disconnect]);

  return {
    connected,
    agentState,
    muted,
    bargeInEnabled,
    vadSensitivity,
    micLevel,
    speakerLevel,
    interimText,
    messages,
    speculativeProducts,
    draftItems,
    stageBadge,
    activeNodes,
    signals,
    guardrailReport,
    latency,
    bargeInCount,
    confirmed,
    error,
    connect,
    disconnect,
    toggleMute,
    triggerManualBargeIn,
    sendFinalUtterance,
    updateBargeInEnabled,
    updateVadSensitivity,
  };
}
