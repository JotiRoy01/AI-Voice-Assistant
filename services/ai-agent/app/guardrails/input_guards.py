import re
from typing import Optional
from app.schemas.models import GuardrailViolation

# Patterns that indicate prompt injection, jailbreak, or price-tampering instructions
PROMPT_INJECTION_PATTERNS = [
    re.compile(r"ignore\s+(?:all\s+)?(?:previous|prior|system)\s+instructions", re.I),
    re.compile(r"you\s+are\s+now\s+(?:a|an)\s+", re.I),
    re.compile(r"system\s*prompt|developer\s*mode|jailbreak", re.I),
    re.compile(r"set\s+(?:the\s+)?(?:unit[_\s]?price|price|total)\s*(?:to|=)\s*0\b", re.I),
    re.compile(r"দাম\s*(?:০|0|শূন্য|ফ্রি)\s*(?:টাকা)?\s*(?:করো|করে\s*দাও|ধরো)", re.I),
    re.compile(r"আগের\s*সব\s*নির্দেশনা\s*ভুলে\s*যাও", re.I),
]


def check_user_input_guardrails(
    user_text: str, block_prompt_injection: bool = True
) -> Optional[GuardrailViolation]:
    """
    Pre-LLM Input Guardrail:
    Detects prompt injection, system-prompt override attempts, or malicious price-zeroing commands
    before the utterance is sent to the LLM.
    """
    if not block_prompt_injection or not user_text:
        return None

    cleaned = user_text.strip()
    for pattern in PROMPT_INJECTION_PATTERNS:
        if pattern.search(cleaned):
            return GuardrailViolation(
                code="PROMPT_INJECTION_BLOCKED",
                severity="high",
                field="user_text",
                message="Blocked attempt to override system instructions or manipulate catalog pricing.",
                suggested_reply_bangla="দুঃখিত, পণ্যের নির্ধারিত মূল্য বা সিস্টেমের নিয়ম পরিবর্তন করা সম্ভব নয়। আপনি কোন পণ্যটি অর্ডার করতে চাচ্ছেন বলুন?",
            )

    return None
