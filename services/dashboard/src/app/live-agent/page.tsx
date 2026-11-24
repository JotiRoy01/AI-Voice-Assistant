'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  CheckCircle2,
  Cpu,
  MessageSquare,
  Mic,
  MicOff,
  Phone,
  PhoneCall,
  PhoneOff,
  Send,
  Sparkles,
  Volume2,
} from 'lucide-react';
import { useAuth } from '@/components/AuthContext';
import { API_BASE_URL, apiFetch } from '@/lib/api';

type NeuralNodeId =
  | 'caller_voice'
  | 'intent_router'
  | 'context_memory'
  | 'entity_parser'
  | 'customer_profile'
  | 'order_history'
  | 'line_items'
  | 'delivery_data'
  | 'confirmation'
  | 'action_executor';

interface LiveTraceSignal {
  key: string;
  value: string;
}

interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  audioUrl?: string | null;
  timestamp: string;
}

interface ConversationSessionState {
  sessionId: string;
  tenantId: string;
  mode: 'order_confirmation' | 'new_order_agent';
  stage: string;
  orderId?: string;
  externalOrderId?: string;
  providerCallId?: string;
  shouldEndCall?: boolean;
  customerName: string;
  customerPhone: string;
  deliveryAddress?: string;
  recipientName?: string;
  recipientPhone?: string;
  confirmed?: boolean | null;
  llmEngineUsed?: string;
  activeNodes: NeuralNodeId[];
  completedNodes: NeuralNodeId[];
  stageBadge: string;
  signals: LiveTraceSignal[];
  messages: ConversationMessage[];
}

interface OrderListItem {
  id: string;
  externalOrderId: string;
  customerName: string;
  totalAmount: number;
  currency: string;
  verificationStatus: string;
  items?: { productName: string; colour: string | null; size: string | null; quantity: number }[];
}

const NEURAL_NODES: {
  id: NeuralNodeId;
  title: string;
  subtitle: string;
  row: number;
  col: number;
}[] = [
    { id: 'caller_voice', title: 'Caller voice', subtitle: 'Audio stream', row: 1, col: 1 },
    { id: 'intent_router', title: 'Intent router', subtitle: 'product_order', row: 1, col: 3 },
    { id: 'context_memory', title: 'Context memory', subtitle: 'Session state', row: 2, col: 1 },
    { id: 'entity_parser', title: 'Entity parser', subtitle: 'Products', row: 2, col: 3 },
    { id: 'customer_profile', title: 'Customer profile', subtitle: 'Known caller', row: 3, col: 1 },
    { id: 'order_history', title: 'Order history', subtitle: '2 prior items', row: 3, col: 2 },
    { id: 'line_items', title: 'Line items', subtitle: 'Qty + variant', row: 3, col: 3 },
    { id: 'delivery_data', title: 'Delivery data', subtitle: 'Address + contact', row: 4, col: 1 },
    { id: 'confirmation', title: 'Confirmation', subtitle: 'Consent captured', row: 4, col: 3 },
    { id: 'action_executor', title: 'Action executor', subtitle: 'Submit form', row: 5, col: 2 },
  ];

const QUICK_BANGLA_UTTERANCES: { label: string; text: string }[] = [
  { label: '১. আমি একটা প্রোডাক্ট অর্ডার করতে চাচ্ছি', text: 'আমি একটা প্রোডাক্ট অর্ডার করতে চাচ্ছি।' },
  { label: '২. না, আগের গুলো বাদ দিয়ে নতুন কিছু অর্ডার করতে চাই', text: 'না আগের গুলো বাদ দিয়ে নতুন কিছু অর্ডার করতে চাই।' },
  {
    label: '৩. কোকোনাট অয়েল আর অলিভ অয়েল লাগবে',
    text: 'কোকোনাট অয়েল আর অলিভ অয়েল লাগবে আমার।',
  },
  {
    label: '৪. এক কেজি কোকোনাট অয়েল আর দুই কেজি অলিভ অয়েল',
    text: 'এক কেজি কোকোনাট অয়েল আর দুই কেজি অলিভ অয়েল লাগবে।',
  },
  {
    label: '৫. আমি অফিসে চাচ্ছি, বাড্ডা লিংক রোড',
    text: 'আমি অফিসে চাচ্ছি। আমার অফিসের ঠিকানা বাড্ডা লিংক রোড।',
  },
  {
    label: '৬. না, ডেলিভারি নিবে আব্দুল্লাহ ইসলাম',
    text: 'না, ডেলিভারি নিবে আব্দুল্লাহ ইসলাম।',
  },
  {
    label: '৭. এই নাম্বারে ফোন দিলেই পাবেন ওনাকে',
    text: 'এই নাম্বারে ফোন দিলেই পাবেন ওনাকে।',
  },
  { label: '৮. হ্যাঁ, কনফার্ম করুন', text: 'হ্যাঁ, কনফার্ম করুন।' },
  { label: '৯. ঠিক আছে, ধন্যবাদ', text: 'ঠিক আছে। ধন্যবাদ।' },
];

export default function LiveVoiceAgentPage() {
  const { token, activeTenantId } = useAuth();

  const [mode, setMode] = useState<'new_order_agent' | 'order_confirmation'>('new_order_agent');
  const [voiceName, setVoiceName] = useState<'bn-BD-PradeepNeural' | 'bn-BD-NabanitaNeural'>(
    'bn-BD-PradeepNeural'
  );
  const [orders, setOrders] = useState<OrderListItem[]>([]);
  const [selectedOrderId, setSelectedOrderId] = useState<string>('');
  const [session, setSession] = useState<ConversationSessionState | null>(null);
  const [callActive, setCallActive] = useState(false);
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState('');
  const [textInput, setTextInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [micStatusNote, setMicStatusNote] = useState<string | null>(null);
  const [llmApiKey, setLlmApiKey] = useState<string>('');
  const [showLlmConfig, setShowLlmConfig] = useState<boolean>(false);

  // Real Mobile Phone Dialer (Twilio) state
  const [showPhoneDialer, setShowPhoneDialer] = useState(false);
  const [myPhoneNumber, setMyPhoneNumber] = useState('+8801');
  const [twilioSid, setTwilioSid] = useState('');
  const [twilioToken, setTwilioToken] = useState('');
  const [twilioFrom, setTwilioFrom] = useState('');
  const [publicWebhookUrl, setPublicWebhookUrl] = useState('');
  const [phoneCallStatus, setPhoneCallStatus] = useState<string | null>(null);

  const chatBottomRef = useRef<HTMLDivElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recognitionRef = useRef<any>(null);

  // CRITICAL REFS: Avoid React closure stale-state bugs inside SpeechRecognition & Audio callbacks!
  const sessionRef = useRef<ConversationSessionState | null>(null);
  const callActiveRef = useRef(false);
  const speakingRef = useRef(false);
  const busyRef = useRef(false);
  const interimTextRef = useRef('');
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceNameRef = useRef<'bn-BD-PradeepNeural' | 'bn-BD-NabanitaNeural'>('bn-BD-PradeepNeural');
  const modeRef = useRef<'new_order_agent' | 'order_confirmation'>('new_order_agent');
  const selectedOrderIdRef = useRef<string>('');
  const llmApiKeyRef = useRef<string>('');

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const savedKey = window.localStorage.getItem('flowmind_llm_api_key') || '';
      if (savedKey) {
        setLlmApiKey(savedKey);
        llmApiKeyRef.current = savedKey;
      }
    }
  }, []);

  useEffect(() => {
    llmApiKeyRef.current = llmApiKey;
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('flowmind_llm_api_key', llmApiKey);
    }
  }, [llmApiKey]);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    callActiveRef.current = callActive;
  }, [callActive]);

  useEffect(() => {
    speakingRef.current = speaking;
  }, [speaking]);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    voiceNameRef.current = voiceName;
  }, [voiceName]);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    selectedOrderIdRef.current = selectedOrderId;
  }, [selectedOrderId]);

  useEffect(() => {
    if (!token || !activeTenantId) return;
    const urlOrderId =
      typeof window !== 'undefined'
        ? new URLSearchParams(window.location.search).get('orderId')
        : null;
    const urlMode =
      typeof window !== 'undefined'
        ? new URLSearchParams(window.location.search).get('mode')
        : null;
    if (urlMode === 'order_confirmation' || urlMode === 'new_order_agent') {
      setMode(urlMode);
      modeRef.current = urlMode;
    }

    apiFetch<{ orders: OrderListItem[] }>('/api/orders', { token, tenantId: activeTenantId })
      .then((res) => {
        setOrders(res.orders);
        if (urlOrderId && res.orders.some((o) => o.id === urlOrderId)) {
          setSelectedOrderId(urlOrderId);
          selectedOrderIdRef.current = urlOrderId;
        } else if (res.orders[0] && !selectedOrderId) {
          setSelectedOrderId(res.orders[0].id);
          selectedOrderIdRef.current = res.orders[0].id;
        }
      })
      .catch(() => { });
  }, [token, activeTenantId]);

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [session?.messages, interimTranscript]);

  // Poll session state if a real Twilio phone call is active
  useEffect(() => {
    if (!session?.providerCallId || !token || !activeTenantId) return;
    const timer = setInterval(async () => {
      try {
        const res = await apiFetch<{ session: ConversationSessionState }>(
          `/api/conversation/session/${session.sessionId}`,
          { token, tenantId: activeTenantId }
        );
        setSession(res.session);
        sessionRef.current = res.session;
      } catch {
        // ignore poll error
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [session?.providerCallId, session?.sessionId, token, activeTenantId]);

  const stopMicrophoneListening = () => {
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
    setListening(false);
  };

  const speakBanglaResponse = async (text: string, audioUrl?: string | null) => {
    stopMicrophoneListening();
    setSpeaking(true);
    speakingRef.current = true;

    const finishSpeaking = () => {
      setSpeaking(false);
      speakingRef.current = false;
      // Automatically turn microphone ON as soon as AI finishes speaking!
      if (callActiveRef.current) {
        setTimeout(() => {
          if (callActiveRef.current && !speakingRef.current && !busyRef.current) {
            startMicrophoneListening();
          }
        }, 250);
      }
    };

    let resolvedAudioUrl = audioUrl;
    if (!resolvedAudioUrl || resolvedAudioUrl.includes('mock')) {
      try {
        const ttsRes = await apiFetch<{ audioUrl: string }>('/api/tts/speak', {
          method: 'POST',
          token,
          tenantId: activeTenantId,
          body: JSON.stringify({ text, voice: voiceNameRef.current }),
        });
        resolvedAudioUrl = ttsRes.audioUrl;
      } catch {
        // ignore
      }
    }

    if (resolvedAudioUrl) {
      const fullUrl = resolvedAudioUrl.startsWith('http')
        ? resolvedAudioUrl
        : `${API_BASE_URL}${resolvedAudioUrl}`;
      try {
        if (audioRef.current) {
          audioRef.current.pause();
        }
        const audio = new Audio(fullUrl);
        audioRef.current = audio;
        audio.onended = finishSpeaking;
        audio.onerror = () => fallbackBrowserBanglaTts(text, finishSpeaking);
        await audio.play();
        return;
      } catch {
        // If autoplay blocked, fall back cleanly
      }
    }

    fallbackBrowserBanglaTts(text, finishSpeaking);
  };

  const fallbackBrowserBanglaTts = (text: string, onEnd: () => void) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      onEnd();
      return;
    }
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    const voices = window.speechSynthesis.getVoices();
    const banglaVoice =
      voices.find((v) => v.lang.toLowerCase().includes('bn')) ||
      voices.find((v) => v.name.toLowerCase().includes('bangla') || v.name.toLowerCase().includes('bengali'));
    if (banglaVoice) {
      utter.voice = banglaVoice;
    }
    utter.lang = 'bn-BD';
    utter.rate = 1.0;
    utter.onend = onEnd;
    utter.onerror = onEnd;
    window.speechSynthesis.speak(utter);
  };

  const startMicrophoneListening = () => {
    if (typeof window === 'undefined') return;
    if (speakingRef.current || busyRef.current) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SpeechRec = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRec) {
      setMicStatusNote('Please open in Google Chrome or Microsoft Edge for live Bangla voice recognition.');
      return;
    }

    stopMicrophoneListening();
    interimTextRef.current = '';
    setInterimTranscript('');

    const recognition = new SpeechRec();
    recognition.lang = 'bn-BD';
    recognition.interimResults = true;
    recognition.continuous = true;
    recognition.maxAlternatives = 5;

    let DispatchedInThisCycle = false;
    let accumulatedFinalTranscript = '';

    // Repairs common Chrome `bn-BD` SpeechRecognition phonetic mishearings for e-commerce words
    const normalizeBanglaSttTranscript = (raw: string): string => {
      return raw
        .replace(
          /(?:শেষ|ছায়াছবি|ছায়াছবি|চাইজ|সাইস|সাইট)\s*([০-৯0-9]{2}|এম|এল|এক্সএল|m|l|xl)\b/gi,
          'সাইজ $1'
        )
        .replace(/কালার\s*(?:নিয়ে|নিয়ে)/gi, 'কালার')
        .replace(/করছে\s*আর|কুরসি\s*আর/gi, 'কর্সেয়ার')
        .replace(/দিদি\s*আর|ডি\s*ডি\s*আর|ভিডিও\s*আর/gi, 'DDR')
        .trim();
    };

    const pickBestRecognitionAlternative = (resultItem: {
      length: number;
      [idx: number]: { transcript: string };
    }): string => {
      const domainKeywordRegex =
        /সাইজ|কালার|রঙ|পাঞ্জাবি|শার্ট|প্যান্ট|র‍্যাম|র্যাম|মনিটর|কিবোর্ড|মাউস|জিবি|কনফার্ম|ঠিকানা|নেভি|কালো|সাদা|মেরুন|কর্সেয়ার|কিংস্টন|ডেলিভারি|পিকআপ|অর্ডার/i;
      let bestText = resultItem[0]?.transcript || '';
      for (let altIdx = 0; altIdx < resultItem.length; altIdx++) {
        const candidate = resultItem[altIdx]?.transcript || '';
        if (domainKeywordRegex.test(candidate) && !domainKeywordRegex.test(bestText)) {
          bestText = candidate;
          break;
        }
      }
      return normalizeBanglaSttTranscript(bestText);
    };

    const dispatchCapturedSpeech = (textToSend: string) => {
      if (DispatchedInThisCycle) return;
      const cleaned = normalizeBanglaSttTranscript(textToSend);
      if (!cleaned) return;
      DispatchedInThisCycle = true;
      accumulatedFinalTranscript = '';
      interimTextRef.current = '';
      setInterimTranscript('');
      stopMicrophoneListening();
      sendUserUtterance(cleaned);
    };

    recognition.onstart = () => {
      setListening(true);
      setMicStatusNote(
        '🎙️ মাইক্রোফোন চালু আছে — বাংলায় কথা বলুন (বলতে থাকুন, কথা শেষ হলে ৩ সেকেন্ড পর অটো সেন্ড হবে অথবা সবুজ মাইক বাটনে চাপুন)'
      );
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recognition.onresult = (event: any) => {
      if (speakingRef.current || busyRef.current) return;

      let currentInterim = '';
      let fullFinal = '';
      for (let i = 0; i < event.results.length; i++) {
        const transcript = pickBestRecognitionAlternative(event.results[i]);
        if (event.results[i].isFinal) {
          fullFinal += transcript + ' ';
        } else {
          currentInterim += transcript;
        }
      }

      if (fullFinal.trim()) {
        accumulatedFinalTranscript = fullFinal.trim();
      }

      const fullSpokenSoFar = `${accumulatedFinalTranscript} ${currentInterim}`.trim();
      if (fullSpokenSoFar) {
        interimTextRef.current = fullSpokenSoFar;
        setInterimTranscript(fullSpokenSoFar);
      }

      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
      }

      // Give the user 3.2 full seconds of pause after speaking before auto-sending so they are NEVER cut off mid-sentence!
      if (fullSpokenSoFar) {
        silenceTimerRef.current = setTimeout(() => {
          if (interimTextRef.current.trim()) {
            dispatchCapturedSpeech(interimTextRef.current);
          }
        }, 4200);
      }
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recognition.onerror = (event: any) => {
      const errCode = event?.error;
      if (errCode === 'not-allowed' || errCode === 'service-not-allowed') {
        setListening(false);
        setMicStatusNote('⚠️ Microphone permission denied by browser. Click the lock icon in the URL bar to allow Microphone.');
        return;
      }
      setListening(false);
    };

    recognition.onend = () => {
      setListening(false);
      // If the user spoke something and the browser stopped recognition before firing isFinal, send what we captured!
      if (!DispatchedInThisCycle && interimTextRef.current.trim()) {
        dispatchCapturedSpeech(interimTextRef.current);
        return;
      }
      // Keep listening continuously while the call is active and the AI is not currently speaking!
      if (callActiveRef.current && !speakingRef.current && !busyRef.current && !DispatchedInThisCycle) {
        setTimeout(() => {
          if (callActiveRef.current && !speakingRef.current && !busyRef.current) {
            try {
              recognition.start();
            } catch {
              // ignore
            }
          }
        }, 300);
      }
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      setListening(false);
    }
  };

  const startLiveCall = async () => {
    if (!token || !activeTenantId) return;
    stopMicrophoneListening();
    setBusy(true);
    busyRef.current = true;
    setError(null);
    try {
      const res = await apiFetch<{ session: ConversationSessionState }>('/api/conversation/start', {
        method: 'POST',
        token,
        tenantId: activeTenantId,
        body: JSON.stringify({
          mode: modeRef.current,
          orderId: selectedOrderIdRef.current || undefined,
          voiceName: voiceNameRef.current,
        }),
      });
      setSession(res.session);
      sessionRef.current = res.session;
      setCallActive(true);
      callActiveRef.current = true;
      setBusy(false);
      busyRef.current = false;

      const firstMsg = res.session.messages[0];
      if (firstMsg) {
        await speakBanglaResponse(firstMsg.text, firstMsg.audioUrl);
      }
    } catch (err) {
      setBusy(false);
      busyRef.current = false;
      setError(err instanceof Error ? err.message : 'Failed to start AI call');
    }
  };

  const endLiveCall = () => {
    setCallActive(false);
    callActiveRef.current = false;
    stopMicrophoneListening();
    setSpeaking(false);
    speakingRef.current = false;
    setMicStatusNote(null);
    if (audioRef.current) {
      audioRef.current.pause();
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  };

  const sendUserUtterance = async (utteranceText: string) => {
    if (!token || !activeTenantId || !utteranceText.trim()) return;
    stopMicrophoneListening();

    // ALWAYS read from `sessionRef.current` so microphone callbacks never use a stale null session!
    let activeSession = sessionRef.current;
    setBusy(true);
    busyRef.current = true;
    setError(null);
    try {
      if (!activeSession) {
        const started = await apiFetch<{ session: ConversationSessionState }>('/api/conversation/start', {
          method: 'POST',
          token,
          tenantId: activeTenantId,
          body: JSON.stringify({
            mode: modeRef.current,
            orderId: selectedOrderIdRef.current || undefined,
            voiceName: voiceNameRef.current,
          }),
        });
        activeSession = started.session;
        setSession(started.session);
        sessionRef.current = started.session;
        setCallActive(true);
        callActiveRef.current = true;
      }

      const res = await apiFetch<{ session: ConversationSessionState }>('/api/conversation/turn', {
        method: 'POST',
        token,
        tenantId: activeTenantId,
        body: JSON.stringify({
          sessionId: activeSession.sessionId,
          userText: utteranceText,
          voiceName: voiceNameRef.current,
          geminiApiKey: llmApiKeyRef.current || undefined,
        }),
      });
      setSession(res.session);
      sessionRef.current = res.session;
      setTextInput('');
      setBusy(false);
      busyRef.current = false;

      const lastMsg = [...res.session.messages].reverse().find((m) => m.role === 'assistant');
      if (res.session.shouldEndCall) {
        // Automatically hang up the call after the AI finishes speaking its goodbye message!
        callActiveRef.current = false;
        setCallActive(false);
      }
      if (lastMsg) {
        await speakBanglaResponse(lastMsg.text, lastMsg.audioUrl);
      }
    } catch (err) {
      setBusy(false);
      busyRef.current = false;
      setError(err instanceof Error ? err.message : 'Failed to process voice turn');
    }
  };

  const dialRealMobilePhone = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !activeTenantId) return;
    setBusy(true);
    setPhoneCallStatus(null);
    setError(null);
    try {
      const res = await apiFetch<{
        session: ConversationSessionState;
        providerCallId: string;
        toPhoneE164: string;
      }>('/api/conversation/dial-phone', {
        method: 'POST',
        token,
        tenantId: activeTenantId,
        body: JSON.stringify({
          toPhone: myPhoneNumber,
          mode,
          orderId: mode === 'order_confirmation' ? selectedOrderId : undefined,
          accountSid: twilioSid || undefined,
          authToken: twilioToken || undefined,
          fromNumber: twilioFrom || undefined,
          publicBaseUrl: publicWebhookUrl || undefined,
        }),
      });
      setSession(res.session);
      sessionRef.current = res.session;
      setCallActive(true);
      callActiveRef.current = true;
      setPhoneCallStatus(
        `Ringing ${res.toPhoneE164}! (Call SID: ${res.providerCallId}) — Answer your phone and speak in Bangla!`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to dial mobile number');
    } finally {
      setBusy(false);
    }
  };

  const activeSet = new Set<NeuralNodeId>(session?.activeNodes || ['caller_voice']);
  const completedSet = new Set<NeuralNodeId>(session?.completedNodes || []);

  return (
    <div className="space-y-5">
      {/* Top Bar: Mode Selector & Real Mobile Phone Dialer Button */}
      <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-600 to-blue-600 flex items-center justify-center text-white shadow">
            <Sparkles className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-slate-900">
              Live Bangla AI Voice Assistant & Neural Execution Map
            </h1>
            <p className="text-xs text-slate-500">
              Natural Bangladeshi Neural Voice (Pradeep / Nabanita) · Two-Way Bangla Voice Conversation
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <select
            value={voiceName}
            onChange={(e) =>
              setVoiceName(e.target.value as 'bn-BD-PradeepNeural' | 'bn-BD-NabanitaNeural')
            }
            className="px-3 py-2 text-xs font-semibold rounded-xl border border-indigo-300 bg-indigo-50 text-indigo-900"
          >
            <option value="bn-BD-PradeepNeural">
              🇧🇩 Bangla Voice: Pradeep (Male Neural — Video Voice)
            </option>
            <option value="bn-BD-NabanitaNeural">
              🇧🇩 Bangla Voice: Nabanita (Female Neural)
            </option>
          </select>

          <select
            value={mode}
            onChange={(e) => {
              endLiveCall();
              setSession(null);
              sessionRef.current = null;
              setMode(e.target.value as 'new_order_agent' | 'order_confirmation');
            }}
            className="px-3 py-2 text-xs font-semibold rounded-xl border border-slate-300 bg-slate-50 text-slate-800"
          >
            <option value="new_order_agent">
              Mode 1: Conversational AI Order Agent (CogniFlow Video Flow)
            </option>
            <option value="order_confirmation">
              Mode 2: Outbound Order Confirmation Call (SRS Order Verify)
            </option>
          </select>

          <select
            value={selectedOrderId}
            onChange={(e) => {
              endLiveCall();
              setSession(null);
              sessionRef.current = null;
              setSelectedOrderId(e.target.value);
              selectedOrderIdRef.current = e.target.value;
            }}
            className="px-3 py-2 text-xs font-semibold rounded-xl border border-blue-300 bg-blue-50 text-blue-900"
            title="Select which Customer & Order context the AI Assistant should use"
          >
            {orders.map((o) => {
              const itemSummary = o.items?.map((i) => i.productName).join(', ') || '';
              return (
                <option key={o.id} value={o.id}>
                  Customer: {o.customerName} ({o.externalOrderId}: {itemSummary || `${o.totalAmount} ${o.currency}`})
                </option>
              );
            })}
          </select>

          <button
            type="button"
            onClick={() => setShowPhoneDialer(!showPhoneDialer)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold shadow-sm transition"
          >
            <PhoneCall className="w-3.5 h-3.5" />
            {showPhoneDialer ? 'Hide Real Phone Dialer' : 'Call My Real Mobile Number (+880)'}
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3.5 rounded-xl bg-red-50 border border-red-200 text-xs font-medium text-red-700">
          {error}
        </div>
      )}

      {phoneCallStatus && (
        <div className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-xs font-semibold text-emerald-800 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-600" />
          {phoneCallStatus}
        </div>
      )}

      {/* Confirmed Order Database Notification Banner */}
      {session?.confirmed && session?.orderId && (
        <div className="p-4 rounded-2xl bg-emerald-950 text-white border border-emerald-500/60 shadow-lg flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/20 border border-emerald-400/50 flex items-center justify-center text-emerald-300">
              <CheckCircle2 className="w-6 h-6" />
            </div>
            <div>
              <div className="text-sm font-bold text-white flex items-center gap-2">
                <span>Order {session.externalOrderId || ''} Automatically Saved & Confirmed in Database!</span>
                {session.llmEngineUsed && (
                  <span className="px-2 py-0.5 rounded bg-emerald-800 text-[10px] font-mono text-emerald-200">
                    Brain: {session.llmEngineUsed}
                  </span>
                )}
              </div>
              <div className="text-xs text-emerald-200 mt-0.5">
                Recipient: <strong>{session.recipientName || session.customerName}</strong> ({session.recipientPhone || session.customerPhone}) · Delivery Address: <strong>{session.deliveryAddress}</strong>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href={`/orders/${session.orderId}`}
              className="px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs shadow transition"
            >
              View Confirmed Order & Full Audit Trail →
            </Link>
            <Link
              href="/"
              className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold text-xs border border-slate-700 transition"
            >
              All Orders Table
            </Link>
          </div>
        </div>
      )}

      {/* Optional Real Mobile Phone Number Dialer (Twilio Programmable Voice) */}
      {showPhoneDialer && (
        <form
          onSubmit={dialRealMobilePhone}
          className="bg-gradient-to-r from-slate-900 to-indigo-950 text-white rounded-2xl p-5 shadow-lg border border-indigo-800/60 space-y-4"
        >
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-bold text-white flex items-center gap-2">
                <Phone className="w-4 h-4 text-emerald-400" />
                Dial Your Real Mobile Phone Number (+8801...) via Twilio Voice
              </h2>
              <p className="text-xs text-indigo-200 mt-0.5">
                Enter your mobile number and free Twilio credentials (or configure them in <code>.env</code>). When you click Dial, your mobile phone will ring and you can talk with the Bangla AI Assistant over the phone!
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
            <div>
              <label className="block text-[11px] font-semibold text-indigo-200 mb-1">
                Your Mobile Number (BD E.164)
              </label>
              <input
                value={myPhoneNumber}
                onChange={(e) => setMyPhoneNumber(e.target.value)}
                placeholder="+8801712345678"
                required
                className="w-full px-3 py-2 rounded-lg bg-slate-800/90 border border-indigo-500/40 text-xs text-white"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-indigo-200 mb-1">
                Twilio Account SID
              </label>
              <input
                value={twilioSid}
                onChange={(e) => setTwilioSid(e.target.value)}
                placeholder="ACxxxxxxxxxxxxxxxx"
                className="w-full px-3 py-2 rounded-lg bg-slate-800/90 border border-indigo-500/40 text-xs text-white"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-indigo-200 mb-1">
                Twilio Auth Token
              </label>
              <input
                type="password"
                value={twilioToken}
                onChange={(e) => setTwilioToken(e.target.value)}
                placeholder="Your Twilio Auth Token"
                className="w-full px-3 py-2 rounded-lg bg-slate-800/90 border border-indigo-500/40 text-xs text-white"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-indigo-200 mb-1">
                Twilio From Number
              </label>
              <input
                value={twilioFrom}
                onChange={(e) => setTwilioFrom(e.target.value)}
                placeholder="+1234567890"
                className="w-full px-3 py-2 rounded-lg bg-slate-800/90 border border-indigo-500/40 text-xs text-white"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-indigo-200 mb-1">
                Public Tunnel URL (ngrok/cloudflared)
              </label>
              <input
                value={publicWebhookUrl}
                onChange={(e) => setPublicWebhookUrl(e.target.value)}
                placeholder="https://xxxx.ngrok-free.app"
                className="w-full px-3 py-2 rounded-lg bg-slate-800/90 border border-indigo-500/40 text-xs text-white"
              />
            </div>
          </div>

          <div className="flex items-center justify-between pt-1">
            <span className="text-[11px] text-indigo-300">
              Don&apos;t have Twilio set up yet? Close this panel and click the blue <strong>&ldquo;Call&rdquo;</strong> button below to talk directly using your laptop/phone microphone right now!
            </span>
            <button
              type="submit"
              disabled={busy}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-slate-950 font-bold text-xs shadow transition"
            >
              <PhoneCall className="w-4 h-4" />
              Ring My Mobile Phone Now
            </button>
          </div>
        </form>
      )}

      {/* Main Split-Screen Layout Matching the Video: Left Phone UI + Right Neural Execution Map */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        {/* LEFT PANEL: Mobile Phone Call & Bangla Voice Chat UI (5 Columns) */}
        <div className="lg:col-span-5 bg-gradient-to-b from-slate-100 to-indigo-50/50 rounded-3xl p-4 border border-slate-200/90 shadow-inner flex flex-col">
          <div className="bg-white rounded-3xl border border-slate-200/80 shadow-xl flex-1 flex flex-col overflow-hidden min-h-[640px]">
            {/* Phone Header */}
            <div className="px-5 pt-5 pb-3 border-b border-slate-100">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-indigo-500 via-blue-500 to-purple-500 flex items-center justify-center text-white shadow-md">
                    <Cpu className="w-6 h-6" />
                  </div>
                  <div>
                    <div className="text-base font-bold text-slate-900">FlowMind · Cogni AI</div>
                    <div className="text-xs text-slate-400 flex items-center gap-1.5">
                      <span>CogniFlow Bangla Voice</span>
                      <span
                        className={`w-2 h-2 rounded-full ${callActive ? 'bg-emerald-500 animate-ping' : 'bg-slate-300'
                          }`}
                      />
                    </div>
                  </div>
                </div>

                {callActive && (
                  <span
                    className={`px-2.5 py-1 rounded-full text-[11px] font-semibold border ${speaking
                        ? 'bg-blue-50 text-blue-700 border-blue-200'
                        : listening
                          ? 'bg-emerald-50 text-emerald-700 border-emerald-300 animate-pulse'
                          : 'bg-slate-100 text-slate-700 border-slate-200'
                      }`}
                  >
                    {speaking ? '🔊 AI Speaking...' : listening ? '🎙️ আপনার কথা শুনছি...' : '● In Call'}
                  </span>
                )}
              </div>

              {/* Message / Call Toggle Bar from Video */}
              <div className="grid grid-cols-2 gap-2 mt-4 bg-slate-100 p-1 rounded-xl">
                <button
                  type="button"
                  onClick={() => {
                    if (!callActive) startLiveCall();
                  }}
                  className={`flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-semibold transition ${!callActive
                      ? 'bg-white text-slate-700 shadow-sm'
                      : 'text-slate-500 hover:text-slate-800'
                    }`}
                >
                  <MessageSquare className="w-3.5 h-3.5" />
                  Message
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (callActive) {
                      endLiveCall();
                    } else {
                      startLiveCall();
                    }
                  }}
                  disabled={busy}
                  className={`flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-semibold transition ${callActive
                      ? 'bg-white text-indigo-600 border border-indigo-300 shadow-sm'
                      : 'bg-indigo-600 text-white shadow-sm hover:bg-indigo-700'
                    }`}
                >
                  <Phone className="w-3.5 h-3.5" />
                  {callActive ? 'Call Active' : 'Call'}
                </button>
              </div>
            </div>

            {/* Live Conversation Messages Stream */}
            <div className="flex-1 p-4 overflow-y-auto space-y-3.5 bg-gradient-to-b from-white via-slate-50/50 to-indigo-50/30">
              {(!session || session.messages.length === 0) && (
                <div className="h-full flex flex-col items-center justify-center text-center p-6 space-y-3">
                  <div className="w-16 h-16 rounded-full bg-indigo-50 border border-indigo-100 flex items-center justify-center text-indigo-600">
                    <PhoneCall className="w-7 h-7" />
                  </div>
                  <div className="space-y-1">
                    <h3 className="text-sm font-bold text-slate-800">
                      Ready to Talk with the Bangla AI Voice Assistant
                    </h3>
                    <p className="text-xs text-slate-500 max-w-xs">
                      Click the <strong>&ldquo;Call&rdquo;</strong> button below. Once the AI finishes greeting you, the microphone turns green automatically so you can talk naturally in Bangla!
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={startLiveCall}
                    disabled={busy}
                    className="px-5 py-2.5 rounded-full bg-gradient-to-r from-indigo-600 to-blue-600 hover:from-indigo-700 hover:to-blue-700 text-white text-xs font-bold shadow-md transition"
                  >
                    📞 Start Live Bangla Voice Call
                  </button>
                </div>
              )}

              {session?.messages.map((msg) => {
                const isUser = msg.role === 'user';
                return (
                  <div
                    key={msg.id}
                    className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}
                  >
                    <div
                      className={`max-w-[85%] rounded-2xl px-4 py-3 text-xs leading-relaxed shadow-sm ${isUser
                          ? 'bg-gradient-to-r from-indigo-600 to-purple-600 text-white rounded-br-none'
                          : 'bg-white border border-slate-200/90 text-slate-800 rounded-bl-none'
                        }`}
                    >
                      <p>{msg.text}</p>
                      {!isUser && (
                        <button
                          type="button"
                          onClick={() => speakBanglaResponse(msg.text, msg.audioUrl)}
                          className="mt-2 inline-flex items-center gap-1 text-[10px] font-semibold text-indigo-600 hover:underline"
                        >
                          <Volume2 className="w-3 h-3" /> Replay Bangla Audio
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}

              {interimTranscript && (
                <div className="flex justify-end">
                  <div className="max-w-[85%] rounded-2xl px-4 py-2.5 text-xs bg-emerald-600 text-white font-medium shadow space-y-2">
                    <div>🎙️ {interimTranscript}...</div>
                    <button
                      type="button"
                      onClick={() => {
                        const toSend = interimTextRef.current.trim() || interimTranscript.trim();
                        if (toSend) {
                          interimTextRef.current = '';
                          setInterimTranscript('');
                          stopMicrophoneListening();
                          sendUserUtterance(toSend);
                        }
                      }}
                      className="px-2.5 py-1 rounded-full bg-white text-emerald-800 font-bold text-[10px] shadow-sm hover:bg-emerald-50"
                    >
                      ✓ কথা শেষ — পাঠান (Send Now)
                    </button>
                  </div>
                </div>
              )}

              <div ref={chatBottomRef} />
            </div>

            {micStatusNote && (
              <div className="px-4 py-1.5 bg-emerald-50 border-t border-emerald-200 text-[11px] font-medium text-emerald-800 text-center">
                {micStatusNote}
              </div>
            )}

            {/* Quick Bangla Voice Prompts (One-click test or speak via Mic) */}
            <div className="px-4 py-2.5 bg-slate-50 border-t border-slate-200/70">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1.5">
                Speak via Mic OR Tap a Bangla Phrase to Test Step-by-Step:
              </div>
              <div className="flex gap-1.5 overflow-x-auto pb-1">
                {QUICK_BANGLA_UTTERANCES.map((u, idx) => (
                  <button
                    key={idx}
                    type="button"
                    disabled={busy}
                    onClick={() => sendUserUtterance(u.text)}
                    className="shrink-0 px-2.5 py-1.5 rounded-full bg-white hover:bg-indigo-50 border border-slate-200 hover:border-indigo-300 text-[11px] font-medium text-slate-700 hover:text-indigo-700 transition"
                  >
                    {u.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Bottom Call / Microphone / Text Input Footer */}
            <div className="p-3.5 bg-white border-t border-slate-100 space-y-2.5">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (textInput.trim()) sendUserUtterance(textInput);
                }}
                className="flex items-center gap-2"
              >
                <input
                  value={textInput}
                  onChange={(e) => setTextInput(e.target.value)}
                  placeholder="বাংলায় বলুন অথবা এখানে টাইপ করে Enter চাপুন..."
                  className="flex-1 px-3.5 py-2 text-xs rounded-full border border-slate-200 bg-slate-50 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <button
                  type="submit"
                  disabled={busy || !textInput.trim()}
                  className="p-2 rounded-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white transition"
                >
                  <Send className="w-3.5 h-3.5" />
                </button>
              </form>

              <div className="flex items-center justify-center gap-4 pt-1">
                <button
                  type="button"
                  onClick={() => {
                    if (listening) {
                      // If user clicks mic while speaking, submit whatever was captured so far or stop mic
                      if (interimTextRef.current.trim()) {
                        const captured = interimTextRef.current.trim();
                        interimTextRef.current = '';
                        setInterimTranscript('');
                        stopMicrophoneListening();
                        sendUserUtterance(captured);
                      } else {
                        stopMicrophoneListening();
                      }
                    } else {
                      if (!callActiveRef.current) {
                        startLiveCall();
                      } else {
                        startMicrophoneListening();
                      }
                    }
                  }}
                  className={`w-12 h-12 rounded-full flex items-center justify-center shadow-lg transition ${listening
                      ? 'bg-emerald-500 text-white ring-4 ring-emerald-200 animate-pulse'
                      : 'bg-indigo-600 hover:bg-indigo-700 text-white'
                    }`}
                  title="Speak in Bangla via Microphone"
                >
                  {listening ? <Mic className="w-5 h-5" /> : <MicOff className="w-5 h-5" />}
                </button>

                {callActive && (
                  <button
                    type="button"
                    onClick={endLiveCall}
                    className="w-11 h-11 rounded-full bg-rose-50 hover:bg-rose-100 border border-rose-200 text-rose-600 flex items-center justify-center shadow-sm transition"
                    title="End Call"
                  >
                    <PhoneOff className="w-4 h-4" />
                  </button>
                )}
              </div>
              <div className="text-center text-[10px] text-slate-400">
                Powered by FlowMind AI · CogniFlow Bangla Neural Voice Engine
              </div>
            </div>
          </div>
        </div>

        {/* RIGHT PANEL: NEURAL EXECUTION MAP — Live Decision Path (7 Columns, Dark UI from Video) */}
        <div className="lg:col-span-7 bg-[#0b1021] text-slate-100 rounded-3xl p-6 border border-slate-800 shadow-2xl flex flex-col justify-between min-h-[640px]">
          {/* Header */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest text-blue-400">
                <span className="w-2 h-2 rounded-full bg-blue-400 animate-ping" />
                NEURAL EXECUTION MAP
              </div>
              <span className="px-3 py-1 rounded-md bg-blue-950/90 border border-blue-700/60 text-[11px] font-bold tracking-wider text-blue-300">
                {session?.stageBadge || 'PRODUCT ORDER'}
              </span>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-bold text-white tracking-tight">Live decision path</h2>
                <p className="text-xs text-slate-400">Agentic orchestration</p>
              </div>
              <span
                className={`px-2.5 py-1 rounded text-[10px] font-bold uppercase tracking-wider border ${busy || speaking || listening
                    ? 'bg-indigo-950/90 border-indigo-500/50 text-indigo-300'
                    : 'bg-slate-900 border-slate-700 text-slate-400'
                  }`}
              >
                {busy || speaking || listening ? 'PROCESSING' : session?.stage === 'completed' ? 'PASSED' : 'STANDBY'}
              </span>
            </div>
          </div>

          {/* 10-Node Neural Execution Graph */}
          <div className="my-6 relative bg-[#0f162e] border border-slate-800/90 rounded-2xl p-5">
            <div className="grid grid-cols-3 gap-4">
              {/* Row 1: Caller voice (col 1) ---> Intent router (col 3) */}
              {renderNeuralNode(NEURAL_NODES[0], activeSet, completedSet)}
              <div className="flex items-center justify-center">
                <div className="w-full h-0.5 bg-gradient-to-r from-blue-500/60 to-indigo-500/60 relative">
                  <span className="absolute -top-2 left-1/2 -translate-x-1/2 text-[10px] text-blue-400">→</span>
                </div>
              </div>
              {renderNeuralNode(NEURAL_NODES[1], activeSet, completedSet)}

              {/* Row 2: Context memory (col 1) <--- Entity parser (col 3) */}
              {renderNeuralNode(NEURAL_NODES[2], activeSet, completedSet)}
              <div className="flex items-center justify-center">
                <div className="w-full h-0.5 bg-gradient-to-r from-indigo-500/40 to-blue-500/40 relative">
                  <span className="absolute -top-2 left-1/2 -translate-x-1/2 text-[10px] text-slate-500">↔</span>
                </div>
              </div>
              {renderNeuralNode(NEURAL_NODES[3], activeSet, completedSet)}

              {/* Row 3: Customer profile (col 1) | Order history (col 2) | Line items (col 3) */}
              {renderNeuralNode(NEURAL_NODES[4], activeSet, completedSet)}
              {renderNeuralNode(NEURAL_NODES[5], activeSet, completedSet)}
              {renderNeuralNode(NEURAL_NODES[6], activeSet, completedSet)}

              {/* Row 4: Delivery data (col 1) ---> Confirmation (col 3) */}
              {renderNeuralNode(NEURAL_NODES[7], activeSet, completedSet)}
              <div className="flex items-center justify-center">
                <div className="w-full h-0.5 bg-gradient-to-r from-blue-500/50 to-emerald-500/50 relative">
                  <span className="absolute -top-2 left-1/2 -translate-x-1/2 text-[10px] text-blue-400">→</span>
                </div>
              </div>
              {renderNeuralNode(NEURAL_NODES[8], activeSet, completedSet)}

              {/* Row 5: Action executor centered */}
              <div />
              {renderNeuralNode(NEURAL_NODES[9], activeSet, completedSet)}
              <div />
            </div>
          </div>

          {/* Bottom: LIVE EVENT TRACE */}
          <div className="bg-[#0f162e] border border-slate-800 rounded-2xl p-4 space-y-2.5">
            <div className="flex items-center justify-between text-[11px] font-bold uppercase tracking-wider text-slate-400">
              <span>LIVE EVENT TRACE</span>
              <span className="text-blue-400">{session?.signals.length || 0} SIGNALS</span>
            </div>

            {(!session || session.signals.length === 0) ? (
              <div className="text-xs text-slate-500 py-2">
                No signals yet — start a call or speak in Bangla to watch live entity extraction and intent routing.
              </div>
            ) : (
              <div className="space-y-1.5">
                {session.signals.map((sig, idx) => (
                  <div
                    key={idx}
                    className="flex items-center gap-2.5 text-xs bg-slate-900/90 border border-slate-800/80 rounded-lg px-3 py-1.5"
                  >
                    <span className="w-2 h-2 rounded-full bg-blue-400 shrink-0" />
                    <span className="text-slate-400 font-medium min-w-[85px]">{sig.key}</span>
                    <span className="text-white font-semibold truncate">{sig.value}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function renderNeuralNode(
  node: { id: NeuralNodeId; title: string; subtitle: string },
  activeSet: Set<NeuralNodeId>,
  completedSet: Set<NeuralNodeId>
) {
  const isActive = activeSet.has(node.id);
  const isDone = completedSet.has(node.id);

  return (
    <div
      key={node.id}
      className={`rounded-xl p-3 border transition-all duration-300 ${isActive
          ? 'bg-blue-950/90 border-blue-400 shadow-[0_0_20px_rgba(59,130,246,0.35)] scale-[1.02]'
          : isDone
            ? 'bg-slate-900/90 border-blue-800/70 text-slate-200'
            : 'bg-slate-900/40 border-slate-800/70 text-slate-500'
        }`}
    >
      <div className="flex items-center justify-between gap-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className={`w-2 h-2 rounded-full shrink-0 ${isActive
                ? 'bg-blue-400 animate-ping'
                : isDone
                  ? 'bg-emerald-400'
                  : 'bg-slate-600'
              }`}
          />
          <span
            className={`text-xs font-bold truncate ${isActive ? 'text-white' : isDone ? 'text-slate-200' : 'text-slate-400'
              }`}
          >
            {node.title}
          </span>
        </div>
        {isDone && (
          <span className="w-4 h-4 rounded-full bg-blue-500/20 border border-blue-400/50 text-blue-300 flex items-center justify-center text-[10px]">
            ✓
          </span>
        )}
      </div>
      <div className="text-[10px] text-slate-400 mt-1 pl-3.5 truncate">{node.subtitle}</div>
    </div>
  );
}
