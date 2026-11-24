from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import re
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple
import requests
from app.agent.tools import (
    ATTRIBUTE_BANGLA_LABELS,
    compute_missing_attributes,
    tool_format_order_for_store_adapter,
    tool_search_product_catalog,
)
from app.core.config import config
from app.guardrails import guardrail_engine
from app.guardrails.catalog_guards import match_allowed_attribute_option
from app.rag.rag_store import rag_store
from app.schemas.models import (
    AgentTurnRequest,
    AgentTurnResponse,
    DraftCartItem,
    GuardrailReport,
    GuardrailViolation,
    LiveTraceSignal,
    ProductCatalogItem,
)

_BANGLA_TO_ASCII = str.maketrans("০১২৩৪৫৬৭৮৯", "0123456789")
_ASCII_TO_BANGLA = str.maketrans("0123456789", "০১২৩৪৫৬৭৮৯")

# Phonetic repair rules for common Chrome `bn-BD` Speech-to-Text mishearings
_STT_PHONETIC_FIXES: List[Tuple[re.Pattern, str]] = [
    (
        re.compile(
            r"(?:শেষ|ছায়াছবি|ছায়াছবি|চাইজ|সাইস|সাইট)\s*([০-৯0-9]{2}|এম|এল|এক্সএল|m|l|xl)\b",
            re.I,
        ),
        r"সাইজ \1",
    ),
    (re.compile(r"কালার\s*(?:নিয়ে|নিয়ে)", re.I), "কালার"),
    (re.compile(r"করছে\s*আর|কুরসি\s*আর", re.I), "কর্সেয়ার"),
    (re.compile(r"দিদি\s*আর|ডি\s*ডি\s*আর|ভিডিও\s*আর", re.I), "DDR"),
]

# Common Bangla phonetic transliterations for brand/option values spoken into browser STT
_BANGLA_OPTION_SYNONYMS: Dict[str, str] = {
    "কর্সেয়ার": "Corsair",
    "কর্সেয়ার": "Corsair",
    "করসেয়ার": "Corsair",
    "কিংস্টন": "Kingston",
    "জি স্কিল": "G.Skill",
    "ট্রান্সসেন্ড": "Transcend",
    "এলজি": "LG",
    "আসুস": "ASUS",
    "স্যামসাং": "Samsung",
    "এমএসআই": "MSI",
    "লজিটেক": "Logitech",
    "এ ফোর টেক": "A4Tech",
    "এফোরটেক": "A4Tech",
    "রেজার": "Razer",
    "শাওমি": "Xiaomi",
    "রিয়েলমি": "Realme",
    "রিয়েলমি": "Realme",
    "আইফোন": "iPhone",
    "ডিডিআর ফোর": "DDR4",
    "ডিডিআর ৪": "DDR4",
    "ডিডিআর ফাইভ": "DDR5",
    "ডিডিআর ৫": "DDR5",
    "ষোল জিবি": "16GB",
    "১৬ জিবি": "16GB",
    "আট জিবি": "8GB",
    "৮ জিবি": "8GB",
    "বত্রিশ জিবি": "32GB",
    "৩২ জিবি": "32GB",
    "বত্রিশশো": "3200MHz",
    "৩২০০": "3200MHz",
    "পাঁচ হাজার ছয়শো": "5600MHz",
    "৫৬০০": "5600MHz",
    "কালো": "কালো (Black)",
    "নেভি ব্লু": "নেভি ব্লু (Navy Blue)",
    "নীল": "নীল (Blue)",
    "সাদা": "সাদা (White)",
    "মেরুন": "মেরুন (Maroon)",
    "অলিভ": "অলিভ (Olive)",
    "সিলভার": "সিলভার (Silver)",
    "স্লিম ফিট": "Slim Fit",
    "রেগুলার ফিট": "Regular Fit",
    "মিডিয়াম": "M",
    "মিডিয়াম": "M",
    "লার্জ": "L",
    "এক্সএল": "XL",
    "এক্স এল": "XL",
    "অফিসিয়াল": "Official 1 Year",
    "অফিসিয়াল": "Official 1 Year",
    "শপ ওয়ারেন্টি": "Shop Warranty",
    "ওয়্যারলেস": "Wireless",
    "ওয়্যারলেস": "Wireless",
    "তারযুক্ত": "USB Wired",
    "ওয়্যার্ড": "USB Wired",
}

# Candidate values for attributes that a user might ask for EVEN IF not in a product's allowed options
# (so we can pass them to `guardrail_engine.ground_catalog_items` and immediately trigger INVALID_ATTRIBUTE_OPTION!)
_CANDIDATE_COLOUR_WORDS: Dict[str, str] = {
    "লাল": "লাল (Red)",
    "red": "লাল (Red)",
    "সবুজ": "সবুজ (Green)",
    "green": "সবুজ (Green)",
    "হলুদ": "হলুদ (Yellow)",
    "yellow": "হলুদ (Yellow)",
    "গোলাপি": "গোলাপি (Pink)",
    "গোলাপী": "গোলাপি (Pink)",
    "pink": "গোলাপি (Pink)",
    "কমলা": "কমলা (Orange)",
    "orange": "কমলা (Orange)",
    "বেগুনি": "বেগুনি (Purple)",
    "purple": "বেগুনি (Purple)",
    "বাদামী": "বাদামী (Brown)",
    "brown": "বাদামী (Brown)",
    "আকাশী": "আকাশী (Sky Blue)",
    "গোল্ডেন": "গোল্ডেন (Golden)",
}


def normalize_stt_utterance(raw_text: str) -> str:
    cleaned = (raw_text or "").strip()
    for pattern, replacement in _STT_PHONETIC_FIXES:
        cleaned = pattern.sub(replacement, cleaned)
    return cleaned


class FlowMindLangGraphAgent:
    """
    ============================================================================
    CLASS DESCRIPTION: FlowMindLangGraphAgent (Stateful Graph + RAG + Guardrails)
    - MEANING: The production Phase-2 Python AI Voice Agent brain.
    - LOW-LATENCY & ANTI-HALLUCINATION ARCHITECTURE:
      1. Post-Confirmation State Guard: Once an order is confirmed (`already_confirmed=True`),
         saying "ধন্যবাদ" or "ওকে বাই বাই" never re-triggers order confirmation or creates duplicate orders.
      2. Bangla Phonetic STT Repair + Instant Deterministic Fast-Path (`<5ms`) with full Bangla digit (`৪২` -> `42`)
         and invalid option detection (`লাল` -> immediate `INVALID_ATTRIBUTE_OPTION` guardrail explanation).
      3. Parallel Gemini Model Racing (`gemini-3.1-flash-lite` + `gemini-3.5-flash-lite`
         with `thinkingBudget=0` and a strict `2.6s` ceiling).
    ============================================================================
    """

    def __init__(self) -> None:
        self._http = requests.Session()
        self._ollama_backoff_until: float = 0.0

    def run_turn(self, req: AgentTurnRequest) -> AgentTurnResponse:
        req.user_text = normalize_stt_utterance(req.user_text)
        catalog = rag_store.ensure_tenant_seeded(req.tenant_id, config.SAMPLE_CSV_PATH)
        tool_calls_made: List[str] = []
        turn_violations: List[GuardrailViolation] = []
        user_lower = req.user_text.lower()

        # Node 0: Post-Confirmation Closing / Goodbye / Thank-You Guard!
        # Prevents the AI from EVER re-asking "সব তথ্য কি ঠিক আছে? আমি কি অর্ডারটি কনফার্ম করব?" after the order is already confirmed!
        is_goodbye = bool(
            re.search(
                r"বাই\s*বাই|গুড\s*বাই|আল্লাহ\s*হাফেজ|খোদা\s*হাফেজ|কল\s*কেটে\s*দিন|রাখি\s*তাহলে|ওকে\s*বাই|bye\s*bye|goodbye|okay\s*bye",
                user_lower,
            )
        )
        is_thanks = bool(
            re.search(
                r"ধন্যবাদ|থ্যাংক\s*ইউ|থ্যাঙ্ক\s*ইউ|thank\s*you|thanks|শুকরিয়া|শুকরিয়া",
                user_lower,
            )
        )
        wants_new_order_after_confirm = bool(
            re.search(
                r"নতুন\s*প্রোডাক্ট|আরেকটা\s*অর্ডার|নতুন\s*অর্ডার|আরেকটি\s*পণ্য",
                user_lower,
            )
        )

        if req.already_confirmed and not wants_new_order_after_confirm:
            if is_goodbye:
                return self._build_post_confirm_closing_response(
                    req=req,
                    reply_bangla="আপনাকেও অসংখ্য ধন্যবাদ! ভালো থাকবেন, আল্লাহ হাফেজ।",
                    stage_badge="CALL COMPLETED",
                    should_end_call=True,
                )
            if is_thanks:
                return self._build_post_confirm_closing_response(
                    req=req,
                    reply_bangla="আপনাকেও অসংখ্য ধন্যবাদ! আপনার অর্ডারটি ইতোমধ্যেই সফলভাবে কনফার্ম করা হয়েছে।",
                    stage_badge="REQUEST RECORDED",
                    should_end_call=False,
                )

        # Even if not yet confirmed, if the user explicitly says goodbye to end the call:
        if is_goodbye and not re.search(r"কনফার্ম|অর্ডার", user_lower):
            return self._build_post_confirm_closing_response(
                req=req,
                reply_bangla="ধন্যবাদ! ভালো থাকবেন, আল্লাহ হাফেজ।",
                stage_badge="CALL COMPLETED",
                should_end_call=True,
            )

        # Node 1: Pre-LLM Input Guardrail (Prompt Injection & Price Tampering Shield)
        input_violation = guardrail_engine.check_input(req.tenant_id, req.user_text)
        if input_violation is not None:
            turn_violations.append(input_violation)
            report = GuardrailReport(
                passed=False,
                deterministic_total_bdt=round(
                    sum(i.quantity * i.unit_price for i in req.current_draft_items), 2
                ),
                violations=turn_violations,
            )
            return AgentTurnResponse(
                reply_bangla=input_violation.suggested_reply_bangla
                or "দুঃখিত, এই অনুরোধটি গ্রহণ করা সম্ভব নয়।",
                stage_badge="GUARDRAIL · INPUT BLOCKED",
                active_nodes=["caller_voice", "intent_router"],
                tool_calls_made=["guardrail_engine.check_input -> BLOCKED"],
                draft_items=list(req.current_draft_items),
                delivery_method=req.delivery_method,
                delivery_address=req.delivery_address,
                address_verified=req.address_verified,
                recipient_name=req.recipient_name,
                recipient_phone=req.recipient_phone,
                confirmed=req.already_confirmed,
                should_end_call=False,
                llm_engine_used="python-guardrail:input-shield",
                signals=[
                    LiveTraceSignal(
                        key="Guardrail",
                        value=f"Blocked ({input_violation.code})",
                    )
                ],
                guardrail_report=report,
                store_adapter_payload=None,
            )

        # Node 2: Retrieve relevant catalog items via Hybrid RAG Search
        matched_catalog_items: List[ProductCatalogItem] = tool_search_product_catalog(
            req.tenant_id, req.user_text
        )
        if matched_catalog_items:
            tool_calls_made.append(
                f"search_product_catalog('{req.user_text}') -> {[m.product_name for m in matched_catalog_items]}"
            )

        for existing in req.current_draft_items:
            for c_item in catalog:
                if (
                    c_item.sku == existing.sku
                    or c_item.product_name.lower() == existing.product_name.lower()
                    or c_item.bangla_name == existing.product_name
                ):
                    if all(m.sku != c_item.sku for m in matched_catalog_items):
                        matched_catalog_items.append(c_item)

        # Node 2.5: Ultra-Fast Deterministic NLU Pre-Parser (<3ms)
        fast_parsed = self._try_fast_deterministic_nlu(
            req, matched_catalog_items, catalog
        )

        if fast_parsed is not None and fast_parsed.get("_instant_authoritative"):
            llm_parsed = fast_parsed
            engine_used = "instant-rag-fastpath"
        else:
            # Node 3: Run Parallel Low-Latency LLM Reasoning (max ~1.2-2.6s)
            llm_parsed, engine_used = self._call_llm_with_product_schemas(
                req, matched_catalog_items, catalog
            )
            if llm_parsed is None and fast_parsed is not None:
                llm_parsed = fast_parsed
                engine_used = "deterministic-rag-nlu"

        draft_items: List[DraftCartItem] = list(req.current_draft_items)
        delivery_method = req.delivery_method
        delivery_address = req.delivery_address
        address_verified = req.address_verified
        recipient_name = req.recipient_name
        recipient_phone = req.recipient_phone

        wants_address_change = bool(
            re.search(
                r"ঠিকানা.*(?:চেঞ্জ|পরিবর্তন|বদল|নতুন|মডিফাই)|(?:চেঞ্জ|পরিবর্তন|নতুন|মডিফাই).*ঠিকানা",
                user_lower,
            )
        )

        if llm_parsed:
            raw_products = llm_parsed.get("products")
            if isinstance(raw_products, list) and len(raw_products) > 0:
                grounded_items, catalog_violations = guardrail_engine.ground_catalog_items(
                    tenant_id=req.tenant_id,
                    raw_llm_products=raw_products,
                    existing_draft_items=draft_items,
                )
                turn_violations.extend(catalog_violations)
                if grounded_items:
                    draft_items = grounded_items
                    for bi in grounded_items:
                        tool_calls_made.append(
                            f"guardrail_ground_item('{bi.product_name}', attrs={bi.collected_attributes}, missing={bi.missing_attributes})"
                        )

            if llm_parsed.get("deliveryMethod") == "pickup" or re.search(
                r"পিকআপ|পিকাপ|pickup", user_lower
            ):
                delivery_method = "pickup"
                delivery_address = "স্টোর পিকআপ (Store Pickup)"
                address_verified = True
            elif wants_address_change and not llm_parsed.get("addressVerifiedInThisTurn"):
                address_verified = False
            elif llm_parsed.get("address") and (
                llm_parsed.get("addressVerifiedInThisTurn")
                or llm_parsed.get("address") != req.saved_address
            ):
                delivery_address = str(llm_parsed.get("address")).strip()
                address_verified = True

            if llm_parsed.get("recipientName"):
                recipient_name = str(llm_parsed.get("recipientName")).strip()
            if llm_parsed.get("recipientPhone"):
                recipient_phone = str(llm_parsed.get("recipientPhone")).strip()

        for item in draft_items:
            item.missing_attributes = compute_missing_attributes(
                item.required_attributes, item.collected_attributes
            )

        raw_confirmed = bool(llm_parsed.get("confirmed")) if llm_parsed else False
        raw_reply_bangla = (
            str(llm_parsed.get("replyBangla") or "").strip() if llm_parsed else ""
        )
        raw_stage_badge = (
            str(llm_parsed.get("stageBadge") or "PRODUCT ORDER")
            if llm_parsed
            else "PRODUCT ORDER"
        )
        raw_active_nodes: List[str] = (
            list(llm_parsed.get("activeNodes") or [])
            if llm_parsed and isinstance(llm_parsed.get("activeNodes"), list)
            else ["caller_voice", "intent_router", "entity_parser"]
        )

        # Node 4: Post-LLM Output & Confirmation Guardrail Verification (`app.guardrails`)
        reply_bangla, confirmed, stage_badge, active_nodes, guardrail_report = (
            guardrail_engine.verify_output(
                tenant_id=req.tenant_id,
                reply_bangla=raw_reply_bangla,
                raw_confirmed=raw_confirmed,
                stage_badge=raw_stage_badge,
                active_nodes=raw_active_nodes,
                draft_items=draft_items,
                address_verified=address_verified,
                delivery_address=delivery_address,
                existing_violations=turn_violations,
            )
        )

        has_missing_specs = any(len(i.missing_attributes) > 0 for i in draft_items)

        # Node 5: Format Order for `storeAdapters.ts` if newly confirmed and all guardrails passed
        store_payload: Optional[Dict[str, Any]] = None
        if (
            confirmed
            and not req.already_confirmed
            and len(draft_items) > 0
            and not has_missing_specs
        ):
            ext_id = f"AI-{uuid.uuid4().hex[:4].upper()}"
            store_payload = tool_format_order_for_store_adapter(
                external_order_id=ext_id,
                customer_name=recipient_name,
                phone=recipient_phone,
                delivery_method=delivery_method,
                delivery_address=delivery_address,
                draft_items=draft_items,
            )
            stage_badge = "REQUEST RECORDED"
            active_nodes = ["caller_voice", "intent_router", "confirmation", "action_executor"]
            tool_calls_made.append(f"format_order_for_store_adapter('{ext_id}')")

        signals: List[LiveTraceSignal] = [
            LiveTraceSignal(key="Caller", value=f"{recipient_name} ({recipient_phone})"),
            LiveTraceSignal(key="History", value=req.previous_orders_summary),
        ]
        if tool_calls_made:
            signals.append(LiveTraceSignal(key="RAG / Tools", value=" · ".join(tool_calls_made[:2])))
        if draft_items:
            prod_summary = " · ".join(
                [f"{i.product_name} ({i.quantity_text})" for i in draft_items]
            )
            signals.append(LiveTraceSignal(key="Products", value=prod_summary))
            specs_summary = " | ".join(
                [
                    f"{i.product_name}: "
                    + (
                        ", ".join([f"{k}={v}" for k, v in i.collected_attributes.items()])
                        or "pending specs"
                    )
                    for i in draft_items
                ]
            )
            signals.append(LiveTraceSignal(key="Collected Specs", value=specs_summary))
            if has_missing_specs:
                signals.append(
                    LiveTraceSignal(
                        key="Missing Specs",
                        value=" | ".join(
                            [
                                f"{i.product_name}: {', '.join(i.missing_attributes)}"
                                for i in draft_items
                                if i.missing_attributes
                            ]
                        ),
                    )
                )
        if not guardrail_report.passed:
            signals.append(
                LiveTraceSignal(
                    key="Guardrails",
                    value=", ".join([v.code for v in guardrail_report.violations]),
                )
            )
        else:
            signals.append(LiveTraceSignal(key="Guardrails", value="PASSED (Zero Hallucinations)"))

        signals.append(LiveTraceSignal(key="Delivery", value=delivery_address))
        if confirmed or req.already_confirmed:
            signals.append(LiveTraceSignal(key="Status", value="Confirmed -> Sent to storeAdapters.ts"))

        should_end = bool((confirmed or req.already_confirmed) and is_goodbye)

        return AgentTurnResponse(
            reply_bangla=reply_bangla,
            stage_badge=stage_badge,
            active_nodes=active_nodes,
            tool_calls_made=tool_calls_made,
            draft_items=draft_items,
            delivery_method=delivery_method,
            delivery_address=delivery_address,
            address_verified=address_verified,
            recipient_name=recipient_name,
            recipient_phone=recipient_phone,
            confirmed=bool(confirmed or req.already_confirmed),
            should_end_call=should_end,
            llm_engine_used=f"python-rag:{engine_used}",
            signals=signals,
            guardrail_report=guardrail_report,
            store_adapter_payload=store_payload,
        )

    def _build_post_confirm_closing_response(
        self,
        req: AgentTurnRequest,
        reply_bangla: str,
        stage_badge: str,
        should_end_call: bool,
    ) -> AgentTurnResponse:
        total_bdt = round(
            sum(i.quantity * i.unit_price for i in req.current_draft_items), 2
        )
        return AgentTurnResponse(
            reply_bangla=reply_bangla,
            stage_badge=stage_badge,
            active_nodes=["caller_voice", "confirmation", "action_executor"],
            tool_calls_made=["post_confirmation_closing_guard"],
            draft_items=list(req.current_draft_items),
            delivery_method=req.delivery_method,
            delivery_address=req.delivery_address,
            address_verified=req.address_verified,
            recipient_name=req.recipient_name,
            recipient_phone=req.recipient_phone,
            confirmed=bool(req.already_confirmed),
            should_end_call=should_end_call,
            llm_engine_used="python-rag:post-confirm-guard",
            signals=[
                LiveTraceSignal(
                    key="Caller",
                    value=f"{req.recipient_name} ({req.recipient_phone})",
                ),
                LiveTraceSignal(
                    key="Guardrails",
                    value="PASSED (Post-Confirmation State Protected)",
                ),
                LiveTraceSignal(
                    key="Status",
                    value="Call Ended Cleanly" if should_end_call else "Order Confirmed",
                ),
            ],
            guardrail_report=GuardrailReport(
                passed=True,
                deterministic_total_bdt=total_bdt,
                violations=[],
            ),
            store_adapter_payload=None,
        )

    def _try_fast_deterministic_nlu(
        self,
        req: AgentTurnRequest,
        matched_items: List[ProductCatalogItem],
        full_catalog: List[ProductCatalogItem],
    ) -> Optional[Dict[str, Any]]:
        text = req.user_text.strip()
        lower = text.lower()

        is_generic_order_intent = bool(
            re.search(
                r"অর্ডার\s*কর|নতুন\s*প্রোডাক্ট|নতুন\s*পণ্য|কিনতে\s*চাই|নিতে\s*চাচ্ছি|অর্ডার\s*দিতে|নতুন\s*কিছু",
                lower,
            )
        )
        if not req.current_draft_items and not matched_items and is_generic_order_intent:
            has_past = (
                req.previous_orders_summary
                and req.previous_orders_summary != "কোনো আগের অর্ডার নেই"
            )
            if not req.history_mentioned and has_past:
                return {
                    "_instant_authoritative": True,
                    "replyBangla": (
                        f"জি {req.customer_name}, আপনার আগের অর্ডারে {req.previous_orders_summary} ছিল। "
                        f"আপনি কি সেটিই আবার অর্ডার করতে চান, নাকি নতুন কোনো পণ্য নিবেন? কোন পণ্যটি নিতে চাচ্ছেন বলুন?"
                    ),
                    "stageBadge": "PREVIOUS ORDERS",
                    "activeNodes": [
                        "caller_voice",
                        "intent_router",
                        "customer_profile",
                        "order_history",
                    ],
                    "products": [],
                    "deliveryMethod": req.delivery_method,
                    "address": req.delivery_address,
                    "addressVerifiedInThisTurn": False,
                    "recipientName": req.recipient_name,
                    "recipientPhone": req.recipient_phone,
                    "confirmed": False,
                }
            else:
                sample_names = ", ".join([c.bangla_name for c in full_catalog[:6]])
                return {
                    "_instant_authoritative": True,
                    "replyBangla": (
                        f"অবশ্যই! আমাদের ক্যাটালগে {sample_names}-সহ আরও পণ্য রয়েছে। "
                        f"আপনি কোন পণ্যটি অর্ডার করতে চাচ্ছেন বলুন?"
                    ),
                    "stageBadge": "COLLECTING SPECS",
                    "activeNodes": ["caller_voice", "intent_router", "entity_parser"],
                    "products": [],
                    "deliveryMethod": req.delivery_method,
                    "address": req.delivery_address,
                    "addressVerifiedInThisTurn": False,
                    "recipientName": req.recipient_name,
                    "recipientPhone": req.recipient_phone,
                    "confirmed": False,
                }

        # Normalize Bangla digits (e.g., ৪২ -> 42) and Bangla phonetic option synonyms!
        normalized_text = text.translate(_BANGLA_TO_ASCII)
        for bn_word, en_canonical in _BANGLA_OPTION_SYNONYMS.items():
            if bn_word in text or bn_word in normalized_text:
                normalized_text += f" {en_canonical}"
        norm_lower = normalized_text.lower()

        target_catalog_items: List[ProductCatalogItem] = list(matched_items)
        if not target_catalog_items and not req.current_draft_items:
            return None

        extracted_products: List[Dict[str, Any]] = []
        added_new_product = False
        added_new_attr = False

        for c_item in target_catalog_items:
            existing_cart_item = next(
                (
                    d
                    for d in req.current_draft_items
                    if d.sku == c_item.sku
                    or d.product_name.lower() == c_item.product_name.lower()
                    or d.product_name == c_item.bangla_name
                ),
                None,
            )
            if existing_cart_item is None:
                added_new_product = True

            prev_attrs = (
                dict(existing_cart_item.collected_attributes)
                if existing_cart_item
                else {}
            )
            attrs: Dict[str, str] = dict(prev_attrs)

            for attr_key, allowed_opts in c_item.attribute_options.items():
                matched_this_attr = False
                for opt in allowed_opts:
                    opt_match = match_allowed_attribute_option(opt, [opt])
                    sub_tokens = [
                        t.strip()
                        for t in re.split(r"[()/|,;\s]+", opt.translate(_BANGLA_TO_ASCII))
                        if len(t.strip()) >= 1
                    ]
                    # For short tokens like 'M', 'L', '42', require word boundary so 'L' doesn't match inside random words
                    token_matched = False
                    if opt.lower() in norm_lower:
                        token_matched = True
                    else:
                        for st in sub_tokens:
                            st_l = st.lower()
                            if len(st_l) <= 2 or st_l.isdigit():
                                if re.search(rf"(?:^|\b|\s){re.escape(st_l)}(?:\b|\s|$)", norm_lower):
                                    token_matched = True
                                    break
                            elif st_l in norm_lower:
                                token_matched = True
                                break

                    if token_matched:
                        canonical_val = opt_match or opt
                        if prev_attrs.get(attr_key) != canonical_val:
                            added_new_attr = True
                        attrs[attr_key] = canonical_val
                        matched_this_attr = True
                        break

                # If no valid option matched for this attribute, check if the user explicitly asked for an UNAVAILABLE option
                # (e.g., "লাল" colour for Panjabi, or "DDR6" for RAM, or "38" size) so `guardrail_engine` catches it on the 1st try!
                if not matched_this_attr:
                    if attr_key == "colour":
                        for bad_word, bad_label in _CANDIDATE_COLOUR_WORDS.items():
                            if re.search(rf"(?:^|\b|\s){re.escape(bad_word)}(?:\b|\s|$)", norm_lower):
                                attrs["colour"] = bad_word
                                added_new_attr = True
                                break
                    elif attr_key == "ddr_type":
                        m_ddr = re.search(r"\bddr\s*\d+\b", norm_lower)
                        if m_ddr:
                            attrs["ddr_type"] = m_ddr.group(0).upper().replace(" ", "")
                            added_new_attr = True
                    elif attr_key == "size":
                        m_sz = re.search(r"(?:সাইজ|size)\s*([0-9]{2}|xxl|xxxl|xs)\b", norm_lower)
                        if m_sz:
                            attrs["size"] = m_sz.group(1).upper()
                            added_new_attr = True

            qty = existing_cart_item.quantity if existing_cart_item else 1
            extracted_products.append(
                {
                    "name": c_item.bangla_name or c_item.product_name,
                    "qtyText": f"{str(qty).translate(_ASCII_TO_BANGLA)}টি",
                    "qtyNum": qty,
                    "unitPrice": c_item.unit_price,
                    "attributes": attrs,
                }
            )

        address_verified_now = req.address_verified
        new_address = req.delivery_address
        delivery_method = req.delivery_method

        if re.search(r"পিকআপ|পিকাপ|pickup", lower):
            delivery_method = "pickup"
            new_address = "স্টোর পিকআপ (Store Pickup)"
            address_verified_now = True
        elif re.search(r"আগের ঠিকানা|আগেরটাই|সেভ করা ঠিকানা|ঐ ঠিকানায়|ওই ঠিকানায়", lower):
            address_verified_now = True
        elif re.search(
            r"মিরপুর|উত্তরা|ধানমন্ডি|গুলশান|বনানী|বাড্ডা|মোহাম্মদপুর|ফার্মগেট|রোড|বাসা|সেক্টর",
            lower,
        ):
            new_address = text
            address_verified_now = True

        is_confirming = bool(
            re.search(
                r"হ্যাঁ\s*কনফার্ম|কনফার্ম\s*করুন|কনফার্ম\s*করো|অর্ডারটি\s*কনফার্ম|সব\s*ঠিক\s*আছে|yes\s*confirm",
                lower,
            )
        )

        missing_prompts: List[str] = []
        for ep in extracted_products:
            c_match = next(
                (
                    c
                    for c in target_catalog_items
                    if (c.bangla_name or c.product_name) == ep["name"]
                ),
                None,
            )
            if c_match:
                missing_keys = compute_missing_attributes(
                    c_match.required_attributes, ep["attributes"]
                )
                if missing_keys:
                    labels = [ATTRIBUTE_BANGLA_LABELS.get(k, k) for k in missing_keys]
                    missing_prompts.append(f"{ep['name']}-এর {', '.join(labels)}")

        if missing_prompts:
            reply_bn = f"জি, আমি নোট করেছি। অনুগ্রহ করে বলুন: {' এবং '.join(missing_prompts)} কী নিবেন?"
            badge = "COLLECTING SPECS"
        elif not address_verified_now:
            reply_bn = (
                f"পণ্যের সব স্পেসিফিকেশন নোট করেছি! ডেলিভারি কি আপনার আগের ঠিকানায় "
                f"({new_address}) নিবেন, নাকি নতুন কোনো ঠিকানায় পাঠাবো?"
            )
            badge = "ADDRESS VERIFICATION"
        elif is_confirming:
            total_bdt = int(
                sum(p["qtyNum"] * float(p["unitPrice"]) for p in extracted_products)
            )
            total_bn = str(total_bdt).translate(_ASCII_TO_BANGLA)
            reply_bn = (
                f"আলহামদুলিল্লাহ! আপনার অর্ডারটি সফলভাবে কনফার্ম করা হয়েছে। "
                f"মোট বিল {total_bn} টাকা, ডেলিভারি ঠিকানা: {new_address}। ধন্যবাদ!"
            )
            badge = "REQUEST RECORDED"
        else:
            total_bdt = int(
                sum(p["qtyNum"] * float(p["unitPrice"]) for p in extracted_products)
            )
            total_bn = str(total_bdt).translate(_ASCII_TO_BANGLA)
            prod_str = ", ".join(
                [
                    f"{p['name']} ({', '.join(f'{k}: {v}' for k, v in p['attributes'].items())})"
                    for p in extracted_products
                ]
            )
            reply_bn = (
                f"সব তথ্য নোট করেছি: {prod_str}। মোট বিল {total_bn} টাকা, "
                f"ডেলিভারি ঠিকানা: {new_address}। সব তথ্য কি ঠিক আছে? আমি কি অর্ডারটি কনফার্ম করব?"
            )
            badge = "CONFIRMATION"

        updated_address = (address_verified_now and not req.address_verified) or (
            new_address != req.delivery_address
        )
        did_confirm = is_confirming and not missing_prompts and address_verified_now
        is_authoritative_turn = bool(
            added_new_product or added_new_attr or updated_address or did_confirm
        )

        return {
            "_instant_authoritative": is_authoritative_turn,
            "replyBangla": reply_bn,
            "stageBadge": badge,
            "activeNodes": [
                "caller_voice",
                "intent_router",
                "entity_parser",
                "line_items",
            ],
            "products": extracted_products,
            "deliveryMethod": delivery_method,
            "address": new_address,
            "addressVerifiedInThisTurn": address_verified_now,
            "recipientName": req.recipient_name,
            "recipientPhone": req.recipient_phone,
            "confirmed": did_confirm,
        }

    def _call_single_gemini_model(
        self,
        model_name: str,
        disable_thinking: bool,
        gemini_key: str,
        full_user_prompt: str,
    ) -> Optional[Tuple[Dict[str, Any], str]]:
        gen_cfg: Dict[str, Any] = {
            "responseMimeType": "application/json",
            "temperature": 0.2,
        }
        if disable_thinking:
            gen_cfg["thinkingConfig"] = {"thinkingBudget": 0}

        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent?key={gemini_key}"
        res = requests.post(
            url,
            json={
                "contents": [{"role": "user", "parts": [{"text": full_user_prompt}]}],
                "generationConfig": gen_cfg,
            },
            timeout=(1.5, 2.6),
        )
        if not res.ok:
            return None
        data = res.json()
        parts = (
            data.get("candidates", [{}])[0]
            .get("content", {})
            .get("parts", [])
        )
        non_thought_parts = [
            p
            for p in parts
            if isinstance(p, dict) and not p.get("thought") and p.get("text")
        ]
        raw_text = (
            non_thought_parts[-1].get("text", "")
            if non_thought_parts
            else (parts[-1].get("text", "") if parts else "")
        )
        if not raw_text:
            return None
        cleaned = re.sub(
            r"^```(?:json)?\s*|\s*```$", "", raw_text.strip(), flags=re.I
        )
        return json.loads(cleaned), model_name

    def _call_llm_with_product_schemas(
        self,
        req: AgentTurnRequest,
        matched_items: List[ProductCatalogItem],
        full_catalog: List[ProductCatalogItem],
    ) -> tuple[Optional[Dict[str, Any]], str]:
        catalog_context_lines: List[str] = []
        if matched_items:
            for item in matched_items:
                opts_str = json.dumps(item.attribute_options, ensure_ascii=False)
                req_bn = [
                    f"{r} ({ATTRIBUTE_BANGLA_LABELS.get(r, r)})"
                    for r in item.required_attributes
                ]
                catalog_context_lines.append(
                    f"- SKU: {item.sku} | Name: {item.bangla_name} ({item.product_name}) | Category: {item.category} | "
                    f"Price: {item.unit_price} {item.currency} | REQUIRED ATTRIBUTES TO COLLECT: {req_bn} | "
                    f"Allowed Options: {opts_str}"
                )
        else:
            compact_names = [
                f"{item.bangla_name} ({item.product_name} - {int(item.unit_price)} BDT)"
                for item in full_catalog[:12]
            ]
            catalog_context_lines.append(
                "Available Products: " + ", ".join(compact_names)
            )

        current_cart_lines: List[str] = []
        for d in req.current_draft_items:
            current_cart_lines.append(
                f"- Product: {d.product_name} | Qty: {d.quantity} ({d.quantity_text}) | "
                f"Collected Attributes: {json.dumps(d.collected_attributes, ensure_ascii=False)} | "
                f"STILL MISSING REQUIRED ATTRIBUTES: {d.missing_attributes}"
            )

        history_str = "\n".join(
            [
                f"{'Customer' if m.get('role') == 'user' else 'AI'}: {m.get('text')}"
                for m in req.conversation_history[-8:]
            ]
        )

        system_prompt = f"""You are FlowMind AI / Cogni AI, a production Bangla Voice Commerce Agent with RAG & Anti-Hallucination Guardrails.

COMPANY PRODUCT CATALOG & REQUIRED ATTRIBUTES (FROM RAG):
{chr(10).join(catalog_context_lines)}

CUSTOMER PROFILE:
- Name: {req.customer_name}
- Phone: {req.customer_phone}
- Customer's Specific Past Orders: {req.previous_orders_summary}
- Saved Address: {req.saved_address}

CURRENT DRAFT SHOPPING CART STATE:
{chr(10).join(current_cart_lines) if current_cart_lines else "(Cart is currently empty)"}
- Delivery Method: {req.delivery_method}
- Delivery Address: {req.delivery_address} (Address Verified in This Call: {req.address_verified})
- Recipient: {req.recipient_name} ({req.recipient_phone})
- Has Mentioned Past Orders Yet: {req.history_mentioned}
- Is Order Already Confirmed: {req.already_confirmed}

STRICT ANTI-HALLUCINATION & GROUNDING RULES:
- NEVER invent products, prices, discounts, free gifts, or specifications not listed in "COMPANY PRODUCT CATALOG & REQUIRED ATTRIBUTES".
- ONLY accept attribute values from the product's "Allowed Options" list.
- Always use the exact `Price` from the catalog when quoting BDT prices.
- If "Is Order Already Confirmed" is True and the customer says thank you or goodbye, NEVER ask to confirm the order again — just thank them warmly and say goodbye.

CRITICAL VOICE AGENT STEP-BY-STEP RULES:
1. STEP 1 (Past Order History): If the customer first says they want to order a product and "Has Mentioned Past Orders Yet" is False (and "Customer's Specific Past Orders" is not "কোনো আগের অর্ডার নেই"), remind them of their past order ({req.previous_orders_summary}) and ask if they want to reorder or order something new.
2. STEP 2 (Product-Specific Required Attributes!): Look closely at "REQUIRED ATTRIBUTES TO COLLECT" for the product the customer wants:
   - Extract every attribute the customer mentions into `products[i].attributes` using the exact attribute keys!
   - If any required attributes are still missing, ask for them naturally in Bangla!
3. STEP 3 (Delivery Address Check): Only AFTER all product required attributes are collected, ask if they want delivery to their saved address ({req.delivery_address}), a new address, or Store Pickup. When they answer, set `addressVerifiedInThisTurn: true`.
4. STEP 4 (Summary & Final Confirmation): Read back the product(s), all collected attributes, total BDT price, recipient name, phone, and address, and ask for confirmation. Set `confirmed: true` ONLY when the customer explicitly confirms AFTER all required attributes and address are verified!
5. Return ONLY valid JSON matching this schema:
{{
  "replyBangla": "Natural spoken Bangla response (1-2 sentences)",
  "stageBadge": "PREVIOUS ORDERS | COLLECTING SPECS | ITEMS AND DELIVERY | ADDRESS UPDATE | CONFIRMATION | REQUEST RECORDED",
  "activeNodes": ["caller_voice", "intent_router", "context_memory", "entity_parser", "customer_profile", "order_history", "line_items", "delivery_data", "confirmation", "action_executor"],
  "products": [
    {{
      "name": "Product Name",
      "qtyText": "১টি",
      "qtyNum": 1,
      "unitPrice": 1500,
      "attributes": {{
        "attribute_key": "collected_value"
      }}
    }}
  ],
  "deliveryMethod": "delivery",
  "address": "{req.delivery_address}",
  "addressVerifiedInThisTurn": false,
  "recipientName": "{req.recipient_name}",
  "recipientPhone": "{req.recipient_phone}",
  "confirmed": false
}}"""

        full_user_prompt = (
            f"{system_prompt}\n\nConversation History:\n{history_str}\n"
            f"Customer: {req.user_text}\n\nRespond with JSON:"
        )

        gemini_key = (
            req.api_key
            if (req.api_key and not req.api_key.startswith(("gsk_", "sk-")))
            else config.GEMINI_API_KEY
        )
        if gemini_key:
            candidates = [
                ("gemini-3.1-flash-lite", True),
                ("gemini-3.5-flash-lite", False),
            ]
            with ThreadPoolExecutor(max_workers=2) as pool:
                futures = [
                    pool.submit(
                        self._call_single_gemini_model,
                        m_name,
                        no_think,
                        gemini_key,
                        full_user_prompt,
                    )
                    for m_name, no_think in candidates
                ]
                try:
                    for fut in as_completed(futures, timeout=2.8):
                        try:
                            result = fut.result()
                            if result is not None:
                                return result
                        except Exception:
                            continue
                except Exception:
                    pass

        api_key = config.GROQ_API_KEY or config.OPENAI_API_KEY
        if api_key:
            is_groq = api_key.startswith("gsk_")
            endpoint = (
                "https://api.groq.com/openai/v1/chat/completions"
                if is_groq
                else "https://api.openai.com/v1/chat/completions"
            )
            model_name = "llama-3.3-70b-versatile" if is_groq else "gpt-4o-mini"
            try:
                res = self._http.post(
                    endpoint,
                    headers={"Authorization": f"Bearer {api_key}"},
                    json={
                        "model": model_name,
                        "messages": [{"role": "user", "content": full_user_prompt}],
                        "response_format": {"type": "json_object"},
                        "temperature": 0.2,
                    },
                    timeout=(1.5, 3.0),
                )
                if res.ok:
                    raw_text = res.json()["choices"][0]["message"]["content"]
                    return json.loads(raw_text), model_name
            except Exception:
                pass

        if config.OLLAMA_BASE_URL and time.time() >= self._ollama_backoff_until:
            ollama_url = config.OLLAMA_BASE_URL.rstrip("/").replace(
                "://localhost:", "://127.0.0.1:"
            )
            try:
                res = self._http.post(
                    f"{ollama_url}/api/chat",
                    json={
                        "model": config.OLLAMA_MODEL,
                        "stream": False,
                        "format": "json",
                        "messages": [{"role": "user", "content": full_user_prompt}],
                    },
                    timeout=(0.3, 2.5),
                )
                if res.ok:
                    raw_text = res.json().get("message", {}).get("content", "")
                    if raw_text:
                        return json.loads(raw_text), f"ollama:{config.OLLAMA_MODEL}"
            except Exception:
                self._ollama_backoff_until = time.time() + 60.0

        return None, "fallback-rag-nlu"


langgraph_agent = FlowMindLangGraphAgent()
