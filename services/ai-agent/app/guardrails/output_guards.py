import re
from typing import List, Tuple
from app.agent.tools import ATTRIBUTE_BANGLA_LABELS
from app.guardrails.policy import GuardrailPolicy
from app.schemas.models import DraftCartItem, GuardrailViolation

_BANGLA_TO_ASCII_DIGITS = str.maketrans("০১২৩৪৫৬৭৮৯", "0123456789")
_ASCII_TO_BANGLA_DIGITS = str.maketrans("0123456789", "০১২৩৪৫৬৭৮৯")

UNAUTHORIZED_DISCOUNT_REGEX = re.compile(
    r"(\d+\s*%\s*(?:ছাড়|ছাড়|ডিসকাউন্ট|discount)|ফ্রি\s*গিফট|বিনামূল্যে\s*ডেলিভারি|free\s*gift)",
    re.I,
)

SPOKEN_PRICE_REGEX = re.compile(
    r"([০-৯0-9]{3,6}(?:,[০-৯0-9]{3})*)\s*(?:টাকা|taka|bdt)", re.I
)


def to_bangla_number(n: int) -> str:
    return str(n).translate(_ASCII_TO_BANGLA_DIGITS)


def verify_output_and_confirmation_guards(
    reply_bangla: str,
    raw_confirmed: bool,
    stage_badge: str,
    active_nodes: List[str],
    draft_items: List[DraftCartItem],
    address_verified: bool,
    delivery_address: str,
    existing_violations: List[GuardrailViolation],
    policy: GuardrailPolicy,
) -> Tuple[str, bool, str, List[str], List[GuardrailViolation]]:
    """
    Post-LLM Output & Confirmation Fact-Checker Guardrail:
    1. If any high-severity catalog/option violation occurred (e.g., customer asked for 'DDR6' or out-of-catalog product),
       overrides `reply_bangla` with the deterministic explanation and blocks confirmation.
    2. Blocks premature confirmation (`confirmed=True`) if any required product attribute is missing.
    3. Blocks premature confirmation (`confirmed=True`) if the delivery address is not verified yet.
    4. Fact-checks spoken BDT prices in `reply_bangla` against deterministic catalog `unit_price` and `total_amount`.
    5. Blocks hallucinated discounts or unauthorized free-gift promises.
    """
    violations = list(existing_violations)
    confirmed = raw_confirmed
    reply = (reply_bangla or "").strip()
    badge = stage_badge
    nodes = list(active_nodes)

    # 1. Surface high-severity catalog/attribute option violations immediately
    blocking_violation = next(
        (
            v
            for v in violations
            if v.code in ("INVALID_ATTRIBUTE_OPTION", "OUT_OF_CATALOG_PRODUCT")
            and v.suggested_reply_bangla
        ),
        None,
    )
    if blocking_violation:
        confirmed = False
        badge = "GUARDRAIL · OPTION CHECK"
        nodes = ["caller_voice", "entity_parser", "line_items"]
        reply = blocking_violation.suggested_reply_bangla or reply
        return reply, confirmed, badge, nodes, violations

    # 2. Guard: Missing Required Attributes Blocker
    all_missing_prompts: List[str] = []
    for item in draft_items:
        if item.missing_attributes:
            bn_labels = [
                ATTRIBUTE_BANGLA_LABELS.get(attr, attr) for attr in item.missing_attributes
            ]
            all_missing_prompts.append(f"{item.product_name}-এর জন্য {', '.join(bn_labels)}")

    has_missing_specs = len(all_missing_prompts) > 0

    if policy.require_all_attributes_before_confirm and confirmed and has_missing_specs:
        confirmed = False
        badge = "COLLECTING SPECS"
        nodes = ["caller_voice", "entity_parser", "line_items"]
        reply = f"অর্ডারটি কনফার্ম করার আগে অনুগ্রহ করে বলুন: {' এবং '.join(all_missing_prompts)} কী হবে?"
        violations.append(
            GuardrailViolation(
                code="PREMATURE_CONFIRMATION_MISSING_SPECS",
                severity="high",
                field="confirmed",
                message=f"Blocked confirmation because required attributes are missing: {all_missing_prompts}",
                suggested_reply_bangla=reply,
            )
        )

    # 3. Guard: Unverified Delivery Address Blocker
    if (
        policy.require_address_before_confirm
        and confirmed
        and not address_verified
        and not has_missing_specs
    ):
        confirmed = False
        badge = "ADDRESS VERIFICATION"
        nodes = ["caller_voice", "line_items", "delivery_data"]
        reply = (
            f"পণ্যের সব তথ্য নোট করেছি! এখন বলুন, ডেলিভারি কি আপনার আগের ঠিকানায় "
            f"({delivery_address}) নিবেন, নাকি নতুন কোনো ঠিকানায় পাঠাবো?"
        )
        violations.append(
            GuardrailViolation(
                code="PREMATURE_CONFIRMATION_UNVERIFIED_ADDRESS",
                severity="high",
                field="address_verified",
                message="Blocked confirmation because delivery address has not been verified in this call.",
                suggested_reply_bangla=reply,
            )
        )

    # 4. Guard: Block unauthorized discount hallucinations
    if policy.block_unauthorized_discounts and reply and UNAUTHORIZED_DISCOUNT_REGEX.search(reply):
        violations.append(
            GuardrailViolation(
                code="UNAUTHORIZED_DISCOUNT_HALLUCINATION",
                severity="medium",
                field="reply_bangla",
                message="LLM hallucinated an unauthorized discount or free gift promise.",
            )
        )
        reply = UNAUTHORIZED_DISCOUNT_REGEX.sub("নির্ধারিত মূল্যে", reply)

    # 5. Guard: Fact-check spoken BDT prices in `reply_bangla` against deterministic cart prices
    if policy.verify_spoken_prices and reply and draft_items:
        deterministic_total = int(round(sum(i.quantity * i.unit_price for i in draft_items)))
        valid_amounts = {deterministic_total}
        for i in draft_items:
            valid_amounts.add(int(round(i.unit_price)))
            valid_amounts.add(int(round(i.quantity * i.unit_price)))

        for match in SPOKEN_PRICE_REGEX.finditer(reply):
            raw_num_str = match.group(1)
            ascii_num_str = raw_num_str.translate(_BANGLA_TO_ASCII_DIGITS).replace(",", "")
            try:
                spoken_amount = int(ascii_num_str)
            except ValueError:
                continue

            if spoken_amount >= 100 and spoken_amount not in valid_amounts:
                # Replace hallucinated BDT amount with the true deterministic total
                correct_bn = to_bangla_number(deterministic_total)
                reply = reply.replace(raw_num_str, correct_bn, 1)
                violations.append(
                    GuardrailViolation(
                        code="SPOKEN_PRICE_MISMATCH_CORRECTED",
                        severity="medium",
                        field="reply_bangla",
                        message=(
                            f"Corrected hallucinated spoken price {spoken_amount} BDT "
                            f"to deterministic total {deterministic_total} BDT."
                        ),
                    )
                )

    if not reply:
        if has_missing_specs:
            reply = f"ঠিক আছে! অনুগ্রহ করে বলুন: {' এবং '.join(all_missing_prompts)} কী চাচ্ছেন?"
        else:
            reply = "জি, আমি আপনার কথা বুঝতে পেরেছি। আর কীভাবে সাহায্য করতে পারি?"

    return reply, confirmed, badge, nodes, violations
