import asyncio
import base64
import hashlib
import os
import re
import time
from collections import OrderedDict
from typing import AsyncGenerator, Dict, List, Tuple


def split_into_spoken_clauses(text: str) -> List[str]:
    """
    Splits a Bangla response into short, natural spoken clauses along sentence/clause boundaries
    (`।`, `?`, `!`, `;`, or comma when clause is long) so the 1st clause begins playing in ~300ms
    while the remaining clauses synthesize in the background, AND barge-in can abort cleanly mid-reply!
    """
    cleaned = (text or "").strip()
    if not cleaned:
        return []

    raw_sentences = [
        s.strip()
        for s in re.split(r"(?<=[।?!.])\s+", cleaned)
        if s and s.strip()
    ]
    clauses: List[str] = []
    for sent in raw_sentences:
        if len(sent) > 95 and "," in sent:
            sub_parts = [p.strip() for p in sent.split(",") if p.strip()]
            buf = ""
            for sp in sub_parts:
                if len(buf) + len(sp) < 60:
                    buf = f"{buf}, {sp}" if buf else sp
                else:
                    if buf:
                        clauses.append(buf)
                    buf = sp
            if buf:
                clauses.append(buf)
        else:
            clauses.append(sent)
    return clauses or [cleaned]


class ClauseStreamingTtsEngine:
    """
    In-Memory Clause-by-Clause Streaming Bangla Neural TTS Engine.
    - Eliminates disk MP3 I/O and Python subprocess startup completely!
    - Uses `edge_tts.Communicate(...).stream()` asynchronously in memory, yielding audio chunks
      clause-by-clause directly over the WebSocket (`bn-BD-PradeepNeural` / `bn-BD-NabanitaNeural`).
    - Maintains an in-memory LRU cache so repeated Bangla phrases stream in <1ms!
    - Checks `cancel_event` continuously so Barge-In stops audio synthesis immediately.
    """

    def __init__(self, max_cache_entries: int = 256) -> None:
        self._cache: OrderedDict[str, bytes] = OrderedDict()
        self._max_cache_entries = max_cache_entries

    def _cache_key(self, clause: str, voice: str) -> str:
        return hashlib.sha256(f"{voice}|{clause.strip()}".encode("utf-8")).hexdigest()

    def _get_cached(self, key: str) -> bytes | None:
        if key in self._cache:
            self._cache.move_to_end(key)
            return self._cache[key]
        return None

    def _put_cached(self, key: str, audio_bytes: bytes) -> None:
        self._cache[key] = audio_bytes
        self._cache.move_to_end(key)
        while len(self._cache) > self._max_cache_entries:
            self._cache.popitem(last=False)

    async def synthesize_clause_bytes(
        self,
        clause: str,
        voice: str,
        cancel_event: asyncio.Event,
    ) -> Tuple[bytes, bool]:
        """
        Synthesizes one Bangla clause completely in memory (no temp files!).
        Returns `(mp3_bytes, was_cached)`. Aborts immediately if `cancel_event` is set.
        """
        selected_voice = (
            voice if (voice and "Neural" in voice and voice.startswith("bn-")) else "bn-BD-PradeepNeural"
        )
        ck = self._cache_key(clause, selected_voice)
        cached = self._get_cached(ck)
        if cached:
            return cached, True

        if cancel_event.is_set():
            return b"", False

        import edge_tts

        audio_parts: List[bytes] = []
        communicate = edge_tts.Communicate(text=clause, voice=selected_voice, rate="+2%")
        async for chunk in communicate.stream():
            if cancel_event.is_set():
                return b"", False
            if chunk.get("type") == "audio" and chunk.get("data"):
                audio_parts.append(chunk["data"])

        combined = b"".join(audio_parts)
        if combined and not cancel_event.is_set():
            self._put_cached(ck, combined)
        return combined, False

    async def stream_clauses(
        self,
        clauses: List[str],
        voice: str,
        cancel_event: asyncio.Event,
    ) -> AsyncGenerator[Dict, None]:
        """
        Pipelined clause generator: pre-fetches clause `i + 1` in the background while
        clause `i` is yielded to the client WebSocket, minimizing inter-clause gaps!
        """
        if not clauses:
            return

        t_start = time.perf_counter()
        next_task: asyncio.Task | None = None

        for idx, clause in enumerate(clauses):
            if cancel_event.is_set():
                if next_task and not next_task.done():
                    next_task.cancel()
                return

            if next_task is not None:
                audio_bytes, cached = await next_task
                next_task = None
            else:
                audio_bytes, cached = await self.synthesize_clause_bytes(
                    clause, voice, cancel_event
                )

            if cancel_event.is_set() or not audio_bytes:
                return

            # Pre-synthesize the next clause concurrently while this clause transmits/plays!
            if idx + 1 < len(clauses) and not cancel_event.is_set():
                next_task = asyncio.create_task(
                    self.synthesize_clause_bytes(clauses[idx + 1], voice, cancel_event)
                )

            ttfb_ms = round((time.perf_counter() - t_start) * 1000.0, 1) if idx == 0 else None
            yield {
                "clause_index": idx,
                "total_clauses": len(clauses),
                "clause_text": clause,
                "audio_base64": base64.b64encode(audio_bytes).decode("ascii"),
                "mime_type": "audio/mpeg",
                "cached": cached,
                "ttfb_ms": ttfb_ms,
            }


streaming_tts_engine = ClauseStreamingTtsEngine()
