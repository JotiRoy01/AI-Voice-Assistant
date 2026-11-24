import asyncio
import json
import time
import uuid
from typing import Any, Dict, List, Optional
import requests
from fastapi import WebSocket, WebSocketDisconnect
from app.agent.graph import langgraph_agent
from app.core.config import config
from app.rag.rag_store import rag_store
from app.realtime.barge_in import BargeInController
from app.realtime.stt_stream import SpeculativeSttStreamProcessor
from app.realtime.tts_stream import split_into_spoken_clauses, streaming_tts_engine
from app.realtime.vad_turn import AudioVadProcessor
from app.schemas.models import AgentTurnRequest, DraftCartItem


class RealtimeVoiceSessionWorker:
    """
    ============================================================================
    CLASS DESCRIPTION: RealtimeVoiceSessionWorker (Full-Duplex Real-Time Engine)
    - MEANING: Manages one live, full-duplex voice call over WebSocket (and ready for LiveKit).
    - CAPABILITIES:
      1. Processes continuous 20ms PCM mic frames via `AudioVadProcessor`.
      2. Runs `SpeculativeSttStreamProcessor` WHILE the customer is still speaking ->
         pre-fetches RAG product schemas & calculates dynamic semantic turn timing.
      3. Executes instant `BargeInController` interruption (<50ms audio flush + context
         truncation) the moment the customer speaks while the AI is talking!
      4. Streams clause-by-clause Bangla Neural TTS in memory via `ClauseStreamingTtsEngine`.
      5. Commits confirmed orders to Node.js `storeAdapters.ts` (`POST /api/realtime/commit-order`).
    ============================================================================
    """

    def __init__(self, websocket: WebSocket) -> None:
        self.ws = websocket
        self.session_id: str = f"rt-{uuid.uuid4().hex[:8]}"
        self.tenant_id: str = "tenant_bd_demo"
        self.customer_name: str = "আব্দুল্লাহ আল মাহাদী"
        self.customer_phone: str = "+8801712345678"
        self.previous_orders_summary: str = "কোনো আগের অর্ডার নেই"
        self.saved_address: str = "গুলশান ২, ভাটারা, ঢাকা"
        self.delivery_method: str = "delivery"
        self.delivery_address: str = "গুলশান ২, ভাটারা, ঢাকা"
        self.address_verified: bool = False
        self.recipient_name: str = self.customer_name
        self.recipient_phone: str = self.customer_phone
        self.voice_name: str = "bn-BD-PradeepNeural"
        self.barge_in_enabled: bool = True
        self.history_mentioned: bool = False
        self.already_confirmed: bool = False
        self.draft_items: List[DraftCartItem] = []
        self.conversation_history: List[Dict[str, str]] = []
        self.api_key: Optional[str] = None
        self.last_rag_ms: float = 0.0

        self.vad = AudioVadProcessor()
        self.barge_in = BargeInController()
        self.stt_processor = SpeculativeSttStreamProcessor()
        self._ws_send_lock = asyncio.Lock()

    async def send_event(self, event_type: str, payload: Dict[str, Any]) -> None:
        async with self._ws_send_lock:
            try:
                await self.ws.send_json({"type": event_type, **payload})
            except Exception:
                pass

    async def run(self) -> None:
        await self.ws.accept()
        await self.send_event(
            "connected",
            {
                "session_id": self.session_id,
                "engine": "flowmind-realtime-full-duplex-v3",
                "barge_in_enabled": self.barge_in_enabled,
            },
        )

        try:
            while True:
                msg = await self.ws.receive()
                if msg.get("type") == "websocket.disconnect":
                    break

                # 1. Binary Frame: 20ms 16kHz Int16 PCM Mic Audio -> Real-Time VAD & Barge-In!
                if msg.get("bytes"):
                    await self._handle_pcm_audio_frame(msg["bytes"])
                    continue

                # 2. Text Frame: JSON Control / Transcript Event
                if msg.get("text"):
                    try:
                        data = json.loads(msg["text"])
                    except json.JSONDecodeError:
                        continue
                    await self._handle_json_message(data)
        except WebSocketDisconnect:
            pass
        finally:
            await self.barge_in.trigger_barge_in()

    async def _handle_pcm_audio_frame(self, pcm_bytes: bytes) -> None:
        vad_res = self.vad.process_pcm16_frame(
            pcm_bytes, ai_is_speaking=self.barge_in.ai_is_speaking
        )
        if vad_res.should_trigger_barge_in and self.barge_in_enabled:
            await self._execute_barge_in(source="server_vad")

    async def _handle_json_message(self, data: Dict[str, Any]) -> None:
        msg_type = str(data.get("type") or "")

        if msg_type == "session_init":
            self.tenant_id = str(data.get("tenant_id") or self.tenant_id)
            self.customer_name = str(data.get("customer_name") or self.customer_name)
            self.customer_phone = str(data.get("customer_phone") or self.customer_phone)
            self.recipient_name = self.customer_name
            self.recipient_phone = self.customer_phone
            self.previous_orders_summary = str(
                data.get("previous_orders_summary") or self.previous_orders_summary
            )
            self.saved_address = str(data.get("saved_address") or self.saved_address)
            self.delivery_address = self.saved_address
            self.voice_name = str(data.get("voice_name") or self.voice_name)
            if "barge_in_enabled" in data:
                self.barge_in_enabled = bool(data["barge_in_enabled"])
            if "vad_threshold" in data:
                try:
                    self.vad.energy_threshold = float(data["vad_threshold"])
                except (ValueError, TypeError):
                    pass
            if data.get("api_key"):
                self.api_key = str(data["api_key"])

            rag_store.ensure_tenant_seeded(self.tenant_id, config.SAMPLE_CSV_PATH)
            greeting = (
                "আসসালামু আলাইকুম! আমি ফ্লোমাইন্ড এআই ভয়েস অ্যাসিস্ট্যান্ট বলছি। "
                "আপনি যেকোনো সময় কথা বললে আমি থেমে আপনার কথা শুনবো। আজ কীভাবে সাহায্য করতে পারি?"
            )
            self.conversation_history.append({"role": "assistant", "text": greeting})
            await self._start_streaming_ai_reply(
                reply_text=greeting,
                stage_badge="REAL-TIME READY",
                active_nodes=["caller_voice", "customer_profile", "order_history"],
                signals=[
                    {"key": "Mode", "value": "Full-Duplex Real-Time (Barge-In ON)"},
                    {"key": "Caller", "value": f"{self.customer_name} ({self.customer_phone})"},
                    {"key": "History", "value": self.previous_orders_summary},
                ],
                guardrail_report={"passed": True, "deterministic_total_bdt": 0.0, "violations": []},
                llm_ms=0.0,
                rag_ms=0.0,
                confirmed=False,
                should_end_call=False,
            )

        elif msg_type == "transcript_interim":
            raw_partial = str(data.get("text") or "").strip()
            if not raw_partial:
                return

            # If customer speaks words while AI is speaking -> instant barge-in!
            if self.barge_in_enabled and self.barge_in.ai_is_speaking and len(raw_partial) >= 3:
                played_idx = data.get("played_clause_index")
                await self._execute_barge_in(
                    source="stt_interim",
                    client_played_clause_index=played_idx if isinstance(played_idx, int) else None,
                )

            # Speculative RAG Pre-Fetch + Smart Bangla Semantic Turn Timing WHILE user is speaking!
            analysis = self.stt_processor.process_interim_transcript(self.tenant_id, raw_partial)
            self.last_rag_ms = analysis.rag_latency_ms
            await self.send_event(
                "speculative_update",
                {
                    "normalized_text": analysis.normalized_text,
                    "matched_products": analysis.matched_products,
                    "semantic_turn": {
                        "is_complete": analysis.turn_decision.is_complete,
                        "recommended_silence_ms": analysis.turn_decision.recommended_silence_ms,
                        "reason": analysis.turn_decision.reason,
                    },
                    "rag_ms": analysis.rag_latency_ms,
                },
            )

        elif msg_type == "transcript_final":
            user_text = str(data.get("text") or "").strip()
            if not user_text:
                return
            await self._process_final_user_utterance(user_text)

        elif msg_type == "barge_in_client":
            if self.barge_in_enabled:
                played_idx = data.get("played_clause_index")
                await self._execute_barge_in(
                    source="client_vad",
                    client_played_clause_index=played_idx if isinstance(played_idx, int) else None,
                )

        elif msg_type == "audio_playback_ack":
            turn_id = str(data.get("turn_id") or "")
            clause_idx = data.get("clause_index")
            if turn_id and isinstance(clause_idx, int):
                self.barge_in.mark_clause_played(turn_id, clause_idx)
            if data.get("turn_completed"):
                self.barge_in.finish_ai_turn(turn_id)
                await self.send_event("agent_state", {"state": "listening"})

        elif msg_type == "update_config":
            if "barge_in_enabled" in data:
                self.barge_in_enabled = bool(data["barge_in_enabled"])
            if "voice_name" in data and data["voice_name"]:
                self.voice_name = str(data["voice_name"])
            if "vad_threshold" in data:
                try:
                    self.vad.energy_threshold = float(data["vad_threshold"])
                except (ValueError, TypeError):
                    pass
            await self.send_event(
                "config_updated",
                {
                    "barge_in_enabled": self.barge_in_enabled,
                    "voice_name": self.voice_name,
                    "vad_threshold": self.vad.energy_threshold,
                },
            )

    async def _execute_barge_in(
        self, source: str, client_played_clause_index: Optional[int] = None
    ) -> None:
        res = await self.barge_in.trigger_barge_in(
            client_played_clause_index=client_played_clause_index
        )
        if not res.interrupted:
            return

        # Truncate last assistant message in conversation history to ONLY what the customer heard!
        if (
            res.spoken_text_before_interrupt
            and self.conversation_history
            and self.conversation_history[-1].get("role") == "assistant"
        ):
            self.conversation_history[-1]["text"] = (
                f"{res.spoken_text_before_interrupt} [interrupted]"
            )

        await self.send_event(
            "barge_in",
            {
                "source": source,
                "flush_audio": True,
                "spoken_text": res.spoken_text_before_interrupt,
                "discarded_text": res.unspoken_text_discarded,
                "played_clauses": res.played_clauses,
                "total_clauses": res.total_clauses,
            },
        )
        await self.send_event("agent_state", {"state": "interrupted"})

    async def _process_final_user_utterance(self, user_text: str) -> None:
        # Cancel any previous AI reply still streaming
        if self.barge_in.ai_is_speaking:
            await self._execute_barge_in(source="new_utterance")

        self.vad.reset_turn()
        await self.send_event("agent_state", {"state": "thinking"})
        self.conversation_history.append({"role": "user", "text": user_text})

        t_reason_start = time.perf_counter()
        req = AgentTurnRequest(
            session_id=self.session_id,
            tenant_id=self.tenant_id,
            user_text=user_text,
            customer_name=self.customer_name,
            customer_phone=self.customer_phone,
            previous_orders_summary=self.previous_orders_summary,
            saved_address=self.saved_address,
            current_draft_items=self.draft_items,
            delivery_method=self.delivery_method,  # type: ignore[arg-type]
            delivery_address=self.delivery_address,
            address_verified=self.address_verified,
            recipient_name=self.recipient_name,
            recipient_phone=self.recipient_phone,
            history_mentioned=self.history_mentioned,
            already_confirmed=self.already_confirmed,
            conversation_history=self.conversation_history[-10:],
            api_key=self.api_key,
        )

        # Execute the existing Phase-2 RAG + Guardrails + Fast-Path / Parallel Gemini brain in worker thread
        turn_res = await asyncio.to_thread(langgraph_agent.run_turn, req)
        llm_ms = round((time.perf_counter() - t_reason_start) * 1000.0, 1)

        # Update live session state
        self.history_mentioned = True
        self.draft_items = list(turn_res.draft_items)
        self.delivery_method = turn_res.delivery_method
        self.delivery_address = turn_res.delivery_address
        self.address_verified = turn_res.address_verified
        self.recipient_name = turn_res.recipient_name
        self.recipient_phone = turn_res.recipient_phone
        newly_confirmed = bool(turn_res.confirmed and not self.already_confirmed)
        if turn_res.confirmed:
            self.already_confirmed = True

        self.conversation_history.append({"role": "assistant", "text": turn_res.reply_bangla})

        # If newly confirmed, persist the order into Node.js `storeAdapters.ts` -> MySQL in the background!
        if newly_confirmed and turn_res.store_adapter_payload:
            asyncio.create_task(self._commit_order_to_backend(turn_res.store_adapter_payload))

        await self._start_streaming_ai_reply(
            reply_text=turn_res.reply_bangla,
            stage_badge=turn_res.stage_badge,
            active_nodes=turn_res.active_nodes,
            signals=[s.model_dump() for s in turn_res.signals],
            guardrail_report=turn_res.guardrail_report.model_dump(),
            llm_ms=llm_ms,
            rag_ms=self.last_rag_ms,
            confirmed=turn_res.confirmed,
            should_end_call=turn_res.should_end_call,
            llm_engine_used=turn_res.llm_engine_used,
        )

    async def _start_streaming_ai_reply(
        self,
        reply_text: str,
        stage_badge: str,
        active_nodes: List[str],
        signals: List[Dict[str, Any]],
        guardrail_report: Dict[str, Any],
        llm_ms: float,
        rag_ms: float,
        confirmed: bool,
        should_end_call: bool,
        llm_engine_used: str = "realtime-v3",
    ) -> None:
        turn_id = f"turn-{uuid.uuid4().hex[:6]}"
        clauses = split_into_spoken_clauses(reply_text)

        # Immediately push metadata, cart specs, guardrails, and text to the UI BEFORE audio finishes synthesizing!
        await self.send_event(
            "assistant_turn_start",
            {
                "turn_id": turn_id,
                "reply_bangla": reply_text,
                "clauses": clauses,
                "stage_badge": stage_badge,
                "active_nodes": active_nodes,
                "signals": signals,
                "draft_items": [i.model_dump() for i in self.draft_items],
                "delivery_method": self.delivery_method,
                "delivery_address": self.delivery_address,
                "address_verified": self.address_verified,
                "confirmed": confirmed,
                "should_end_call": should_end_call,
                "llm_engine_used": llm_engine_used,
                "guardrail_report": guardrail_report,
                "latency_ms": {
                    "rag": rag_ms,
                    "reasoning": llm_ms,
                },
            },
        )

        async def _stream_tts_task() -> None:
            try:
                await self.send_event("agent_state", {"state": "speaking", "turn_id": turn_id})
                async for chunk in streaming_tts_engine.stream_clauses(
                    clauses=clauses,
                    voice=self.voice_name,
                    cancel_event=self.barge_in.cancel_event,
                ):
                    if self.barge_in.cancel_event.is_set():
                        return
                    await self.send_event(
                        "audio_chunk",
                        {
                            "turn_id": turn_id,
                            **chunk,
                            "total_mouth_to_ear_ms": (
                                round(llm_ms + chunk["ttfb_ms"], 1)
                                if chunk.get("ttfb_ms") is not None
                                else None
                            ),
                        },
                    )
                if not self.barge_in.cancel_event.is_set():
                    await self.send_event(
                        "assistant_turn_audio_done",
                        {"turn_id": turn_id, "should_end_call": should_end_call},
                    )
            except asyncio.CancelledError:
                return
            except Exception as exc:
                await self.send_event(
                    "tts_error",
                    {"turn_id": turn_id, "error": str(exc)},
                )
                self.barge_in.finish_ai_turn(turn_id)

        task = asyncio.create_task(_stream_tts_task())
        self.barge_in.begin_ai_turn(turn_id=turn_id, clauses=clauses, task=task)

    async def _commit_order_to_backend(self, payload: Dict[str, Any]) -> None:
        backend_url = config.BACKEND_API_URL.rstrip("/").replace("://localhost:", "://127.0.0.1:")
        try:
            await asyncio.to_thread(
                requests.post,
                f"{backend_url}/api/realtime/commit-order",
                headers={
                    "Content-Type": "application/json",
                    "X-Internal-Token": config.INTERNAL_SERVICE_TOKEN,
                    "X-Tenant-Id": self.tenant_id,
                },
                json={"tenantId": self.tenant_id, "orderPayload": payload},
                timeout=5.0,
            )
        except Exception:
            pass
