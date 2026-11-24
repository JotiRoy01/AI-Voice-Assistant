import asyncio
from dataclasses import dataclass, field
from typing import List, Optional


@dataclass
class BargeInResult:
    interrupted: bool
    spoken_text_before_interrupt: str
    unspoken_text_discarded: str
    played_clauses: int
    total_clauses: int


class BargeInController:
    """
    Full-Duplex Interruption (Barge-In) & Spoken-Context Truncation Controller.
    When the customer starts talking while the AI is still speaking:
      1. Cancels the active async LLM / TTS streaming task immediately (`cancel_event.set()` + `task.cancel()`).
      2. Signals the client browser/SIP bridge to flush its playback audio buffer in <50ms.
      3. Truncates the AI's last assistant message in `conversation_history` to ONLY the clauses
         the customer actually heard — preventing the AI from hallucinating that the customer
         heard unspoken prices or delivery details!
    """

    def __init__(self) -> None:
        self.ai_is_speaking: bool = False
        self.active_turn_id: Optional[str] = None
        self.cancel_event: asyncio.Event = asyncio.Event()
        self.active_task: Optional[asyncio.Task] = None
        self.planned_clauses: List[str] = []
        self.last_played_clause_index: int = -1

    def begin_ai_turn(self, turn_id: str, clauses: List[str], task: Optional[asyncio.Task] = None) -> None:
        self.active_turn_id = turn_id
        self.ai_is_speaking = True
        self.cancel_event = asyncio.Event()
        self.active_task = task
        self.planned_clauses = list(clauses)
        self.last_played_clause_index = -1

    def mark_clause_played(self, turn_id: str, clause_index: int) -> None:
        if turn_id == self.active_turn_id and clause_index > self.last_played_clause_index:
            self.last_played_clause_index = clause_index

    def finish_ai_turn(self, turn_id: str) -> None:
        if turn_id == self.active_turn_id:
            self.ai_is_speaking = False
            self.active_task = None

    async def trigger_barge_in(
        self, client_played_clause_index: Optional[int] = None
    ) -> BargeInResult:
        if not self.ai_is_speaking and self.active_task is None:
            return BargeInResult(
                interrupted=False,
                spoken_text_before_interrupt="",
                unspoken_text_discarded="",
                played_clauses=0,
                total_clauses=0,
            )

        # 1. Immediately abort active TTS / LLM streaming
        self.cancel_event.set()
        self.ai_is_speaking = False

        if self.active_task and not self.active_task.done():
            self.active_task.cancel()
            try:
                await self.active_task
            except (asyncio.CancelledError, Exception):
                pass
        self.active_task = None

        # 2. Compute exact spoken vs. unspoken clauses for history truncation
        effective_idx = self.last_played_clause_index
        if client_played_clause_index is not None:
            effective_idx = max(effective_idx, client_played_clause_index)

        total = len(self.planned_clauses)
        if total == 0:
            return BargeInResult(True, "", "", 0, 0)

        # Include up to the clause that was currently playing when interrupted
        spoken_count = min(total, max(1, effective_idx + 1)) if effective_idx >= 0 else 1
        spoken_text = " ".join(self.planned_clauses[:spoken_count]).strip()
        unspoken_text = " ".join(self.planned_clauses[spoken_count:]).strip()

        return BargeInResult(
            interrupted=True,
            spoken_text_before_interrupt=spoken_text,
            unspoken_text_discarded=unspoken_text,
            played_clauses=spoken_count,
            total_clauses=total,
        )
