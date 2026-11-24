from typing import Any, Dict, List, Literal, Optional
from pydantic import BaseModel, Field


class ProductCatalogItem(BaseModel):
    """
    Represents a product in a company's multi-category catalog with dynamic required attributes.
    For example:
      - Shirt  -> required_attributes: ["colour", "size"]
      - RAM    -> required_attributes: ["brand", "ddr_type", "capacity_gb", "bus_speed_mhz"]
      - Monitor-> required_attributes: ["brand", "screen_size_inch", "refresh_rate_hz"]
    """

    id: str
    tenant_id: str
    sku: str
    product_name: str
    bangla_name: str
    aliases: List[str] = Field(default_factory=list)
    category: str = "General"
    unit_price: float = 0.0
    currency: str = "BDT"
    stock_qty: int = 100
    required_attributes: List[str] = Field(default_factory=list)
    attribute_options: Dict[str, List[str]] = Field(default_factory=dict)
    description: str = ""


class DraftCartItem(BaseModel):
    """
    Tracks a single product in the customer's live voice shopping cart, including
    which required attributes have been collected and which are still missing.
    """

    sku: str = "CUSTOM"
    product_name: str
    bangla_name: str = ""
    category: str = "General"
    quantity: int = 1
    quantity_text: str = "১টি"
    unit_price: float = 1200.0
    required_attributes: List[str] = Field(default_factory=list)
    collected_attributes: Dict[str, str] = Field(default_factory=dict)
    missing_attributes: List[str] = Field(default_factory=list)


class LiveTraceSignal(BaseModel):
    key: str
    value: str


class GuardrailViolation(BaseModel):
    """
    Represents a single anti-hallucination or safety violation caught by `app.guardrails`.
    """

    code: str
    severity: Literal["low", "medium", "high"] = "medium"
    field: str
    message: str
    suggested_reply_bangla: Optional[str] = None


class GuardrailReport(BaseModel):
    """
    Structured audit report produced by `GuardrailEngine` on every agent turn.
    """

    passed: bool = True
    deterministic_total_bdt: float = 0.0
    violations: List[GuardrailViolation] = Field(default_factory=list)


class AgentTurnRequest(BaseModel):
    session_id: str
    tenant_id: str
    user_text: str
    customer_name: str = "আব্দুল্লাহ আল মাহাদী"
    customer_phone: str = "+8801712345678"
    previous_orders_summary: str = "কোনো আগের অর্ডার নেই"
    saved_address: str = "গুলশান ২, ভাটারা, ঢাকা"
    current_draft_items: List[DraftCartItem] = Field(default_factory=list)
    delivery_method: Literal["delivery", "pickup"] = "delivery"
    delivery_address: str = "গুলশান ২, ভাটারা, ঢাকা"
    address_verified: bool = False
    recipient_name: str = "আব্দুল্লাহ আল মাহাদী"
    recipient_phone: str = "+8801712345678"
    history_mentioned: bool = False
    already_confirmed: bool = False
    conversation_history: List[Dict[str, str]] = Field(default_factory=list)
    api_key: Optional[str] = None


class AgentTurnResponse(BaseModel):
    reply_bangla: str
    stage_badge: str
    active_nodes: List[str]
    tool_calls_made: List[str] = Field(default_factory=list)
    draft_items: List[DraftCartItem]
    delivery_method: Literal["delivery", "pickup"]
    delivery_address: str
    address_verified: bool
    recipient_name: str
    recipient_phone: str
    confirmed: bool = False
    should_end_call: bool = False
    llm_engine_used: str = "python-langgraph-agent"
    signals: List[LiveTraceSignal] = Field(default_factory=list)
    guardrail_report: GuardrailReport = Field(default_factory=GuardrailReport)
    store_adapter_payload: Optional[Dict[str, Any]] = None
