from typing import Dict, List, Optional, Tuple
from app.guardrails.catalog_guards import validate_and_ground_cart_items
from app.guardrails.input_guards import check_user_input_guardrails
from app.guardrails.output_guards import verify_output_and_confirmation_guards
from app.guardrails.policy import GuardrailPolicy, get_tenant_policy
from app.schemas.models import DraftCartItem, GuardrailReport, GuardrailViolation


class GuardrailEngine:
    """
    ============================================================================
    CLASS DESCRIPTION: GuardrailEngine (Dedicated Anti-Hallucination Module)
    - MEANING: Centralized, testable, multi-stage anti-hallucination engine for the AI Agent.
    - STAGES:
      1. `check_input`: Blocks prompt injection, system-override attempts, and price zeroing.
      2. `ground_catalog_items`: Grounds products to RAG catalog SKUs/prices and validates
         all extracted attributes against the company's `attribute_options` whitelist.
      3. `verify_output`: Blocks premature confirmation (missing specs or unverified address),
         blocks unauthorized discount promises, and fact-checks spoken BDT prices in `reply_bangla`.
    ============================================================================
    """

    def get_policy(self, tenant_id: str) -> GuardrailPolicy:
        return get_tenant_policy(tenant_id)

    def check_input(self, tenant_id: str, user_text: str) -> Optional[GuardrailViolation]:
        policy = self.get_policy(tenant_id)
        return check_user_input_guardrails(
            user_text=user_text,
            block_prompt_injection=policy.block_prompt_injection,
        )

    def ground_catalog_items(
        self,
        tenant_id: str,
        raw_llm_products: List[Dict],
        existing_draft_items: List[DraftCartItem],
    ) -> Tuple[List[DraftCartItem], List[GuardrailViolation]]:
        policy = self.get_policy(tenant_id)
        return validate_and_ground_cart_items(
            tenant_id=tenant_id,
            raw_llm_products=raw_llm_products,
            existing_draft_items=existing_draft_items,
            policy=policy,
        )

    def verify_output(
        self,
        tenant_id: str,
        reply_bangla: str,
        raw_confirmed: bool,
        stage_badge: str,
        active_nodes: List[str],
        draft_items: List[DraftCartItem],
        address_verified: bool,
        delivery_address: str,
        existing_violations: List[GuardrailViolation],
    ) -> Tuple[str, bool, str, List[str], GuardrailReport]:
        policy = self.get_policy(tenant_id)
        corrected_reply, confirmed, badge, nodes, all_violations = (
            verify_output_and_confirmation_guards(
                reply_bangla=reply_bangla,
                raw_confirmed=raw_confirmed,
                stage_badge=stage_badge,
                active_nodes=active_nodes,
                draft_items=draft_items,
                address_verified=address_verified,
                delivery_address=delivery_address,
                existing_violations=existing_violations,
                policy=policy,
            )
        )
        deterministic_total = round(sum(i.quantity * i.unit_price for i in draft_items), 2)
        report = GuardrailReport(
            passed=len(all_violations) == 0,
            deterministic_total_bdt=deterministic_total,
            violations=all_violations,
        )
        return corrected_reply, confirmed, badge, nodes, report


guardrail_engine = GuardrailEngine()
