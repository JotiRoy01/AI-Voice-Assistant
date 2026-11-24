from typing import Dict
from pydantic import BaseModel


class GuardrailPolicy(BaseModel):
    """
    Per-Tenant Anti-Hallucination & Safety Policy Configuration.
    Allows each company to control how strictly the AI Voice Agent is constrained by their uploaded catalog.
    """

    tenant_id: str = "default"
    strict_catalog_only: bool = False
    enforce_attribute_options_whitelist: bool = True
    verify_spoken_prices: bool = True
    block_unauthorized_discounts: bool = True
    require_all_attributes_before_confirm: bool = True
    require_address_before_confirm: bool = True
    block_prompt_injection: bool = True


_TENANT_POLICIES: Dict[str, GuardrailPolicy] = {}


def get_tenant_policy(tenant_id: str) -> GuardrailPolicy:
    if tenant_id not in _TENANT_POLICIES:
        _TENANT_POLICIES[tenant_id] = GuardrailPolicy(tenant_id=tenant_id)
    return _TENANT_POLICIES[tenant_id]


def set_tenant_policy(tenant_id: str, policy: GuardrailPolicy) -> GuardrailPolicy:
    policy.tenant_id = tenant_id
    _TENANT_POLICIES[tenant_id] = policy
    return policy
