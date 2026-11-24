import time
from dataclasses import dataclass, field
from typing import Dict, List
from app.agent.graph import normalize_stt_utterance
from app.agent.tools import ATTRIBUTE_BANGLA_LABELS
from app.rag.rag_store import rag_store
from app.realtime.vad_turn import BanglaSemanticTurnDetector, SemanticTurnDecision
from app.schemas.models import ProductCatalogItem


@dataclass
class SpeculativePartialAnalysis:
    normalized_text: str
    matched_products: List[Dict]
    turn_decision: SemanticTurnDecision
    rag_latency_ms: float


class SpeculativeSttStreamProcessor:
    """
    Streaming Speech-to-Text + Speculative RAG Pre-Fetcher.
    As the customer is STILL SPEAKING (interim transcripts arriving every ~100-200ms):
      1. Repairs Bangla phonetic STT mishearings ("শেষ ৪২" -> "সাইজ ৪২").
      2. Immediately queries `rag_store.search_products()` to pre-fetch matching products,
         exact BDT prices, `required_attributes`, and `attribute_options` BEFORE the user finishes talking!
      3. Evaluates `BanglaSemanticTurnDetector` to decide whether the customer is mid-thought
         or ready for an instant AI reply.
    """

    def __init__(self) -> None:
        self.turn_detector = BanglaSemanticTurnDetector()
        self._last_speculative_skus: List[str] = []

    def process_interim_transcript(
        self, tenant_id: str, raw_partial_text: str
    ) -> SpeculativePartialAnalysis:
        t0 = time.perf_counter()
        cleaned = normalize_stt_utterance(raw_partial_text)
        matches: List[ProductCatalogItem] = (
            rag_store.search_products(tenant_id, cleaned, top_k=3) if cleaned else []
        )
        rag_ms = round((time.perf_counter() - t0) * 1000.0, 2)

        self._last_speculative_skus = [m.sku for m in matches]
        turn_decision = self.turn_detector.evaluate_turn(cleaned)

        formatted_matches = [
            {
                "sku": m.sku,
                "product_name": m.product_name,
                "bangla_name": m.bangla_name,
                "category": m.category,
                "unit_price": m.unit_price,
                "required_attributes": m.required_attributes,
                "required_labels": [
                    ATTRIBUTE_BANGLA_LABELS.get(a, a) for a in m.required_attributes
                ],
                "attribute_options": m.attribute_options,
            }
            for m in matches
        ]

        return SpeculativePartialAnalysis(
            normalized_text=cleaned,
            matched_products=formatted_matches,
            turn_decision=turn_decision,
            rag_latency_ms=rag_ms,
        )
