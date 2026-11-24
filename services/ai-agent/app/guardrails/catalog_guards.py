import re
from typing import Dict, List, Optional, Tuple
from app.agent.tools import ATTRIBUTE_BANGLA_LABELS, compute_missing_attributes
from app.guardrails.policy import GuardrailPolicy
from app.rag.rag_store import infer_attributes_for_product, rag_store
from app.schemas.models import DraftCartItem, GuardrailViolation, ProductCatalogItem

_BANGLA_TO_ASCII_DIGITS = str.maketrans("০১২৩৪৫৬৭৮৯", "0123456789")


def _normalize_token(val: str) -> str:
    return re.sub(r"[\s\-_()]+", "", val.translate(_BANGLA_TO_ASCII_DIGITS).lower().strip())


def match_allowed_attribute_option(
    raw_value: str, allowed_options: List[str]
) -> Optional[str]:
    """
    Matches an LLM-extracted attribute value against the catalog's `attribute_options` whitelist.
    Supports exact match, Bangla/English bilingual match (e.g. 'Black' or 'কালো' -> 'কালো (Black)'),
    and numeric unit match (e.g. '16' -> '16GB', '3200' -> '3200MHz'), while strictly rejecting
    hallucinated/unavailable options like 'DDR6', '64GB', or 'XXL' if not in `allowed_options`!
    """
    if not allowed_options:
        return raw_value.strip()

    candidate = raw_value.translate(_BANGLA_TO_ASCII_DIGITS).strip()
    if not candidate:
        return None

    cand_norm = _normalize_token(candidate)
    if not cand_norm:
        return None

    # 1. Exact or normalized match
    for opt in allowed_options:
        if _normalize_token(opt) == cand_norm:
            return opt

    # 2. Sub-token match (e.g. 'কালো (Black)' splits into ['কালো', 'black'])
    for opt in allowed_options:
        sub_tokens = [
            _normalize_token(t)
            for t in re.split(r"[()/|,;\s]+", opt.translate(_BANGLA_TO_ASCII_DIGITS))
            if t.strip()
        ]
        if cand_norm in sub_tokens:
            return opt
        # Check if candidate contains one of the option sub-tokens (minimum length 2)
        if any(len(st) >= 2 and st == cand_norm for st in sub_tokens):
            return opt

    # 3. Numeric prefix match for unambiguous capacities/speeds/sizes (e.g. '16' -> '16GB', '3200' -> '3200MHz', '24' -> '24 inch')
    cand_digits = re.findall(r"\d+", candidate)
    if len(cand_digits) == 1:
        num_str = cand_digits[0]
        matching_num_opts = [
            opt
            for opt in allowed_options
            if re.findall(r"\d+", opt.translate(_BANGLA_TO_ASCII_DIGITS)) == [num_str]
        ]
        if len(matching_num_opts) == 1:
            return matching_num_opts[0]

    # 4. Containment match if unambiguous (only 1 option matches)
    partial_matches = [
        opt
        for opt in allowed_options
        if (len(cand_norm) >= 2 and cand_norm in _normalize_token(opt))
        or (len(_normalize_token(opt)) >= 2 and _normalize_token(opt) in cand_norm)
    ]
    if len(partial_matches) == 1:
        return partial_matches[0]

    return None


def validate_and_ground_cart_items(
    tenant_id: str,
    raw_llm_products: List[Dict],
    existing_draft_items: List[DraftCartItem],
    policy: GuardrailPolicy,
) -> Tuple[List[DraftCartItem], List[GuardrailViolation]]:
    """
    Catalog Grounding & Whitelist Guardrail:
    1. Resolves every product against the tenant's RAG catalog.
    2. Overwrites hallucinated LLM prices/SKUs with the deterministic catalog `unit_price` and `sku`.
    3. If `policy.strict_catalog_only` is True, blocks products not found in the company's catalog.
    4. Validates every extracted attribute value against `catalog_item.attribute_options` so invalid specs
       (like 'DDR6' RAM or '128GB' when only 8GB/16GB/32GB exist) are rejected with a Bangla explanation!
    """
    violations: List[GuardrailViolation] = []
    if not raw_llm_products:
        return list(existing_draft_items), violations

    validated_items: List[DraftCartItem] = []

    for p in raw_llm_products:
        if not isinstance(p, dict) or not p.get("name"):
            continue
        p_name = str(p.get("name")).strip()
        p_qty = max(1, int(p.get("qtyNum") or 1))
        p_qty_text = str(p.get("qtyText") or f"{p_qty}টি")
        p_attrs = p.get("attributes") if isinstance(p.get("attributes"), dict) else {}

        prev_match = next(
            (
                x
                for x in existing_draft_items
                if x.product_name.lower() in p_name.lower()
                or p_name.lower() in x.product_name.lower()
            ),
            None,
        )

        matches: List[ProductCatalogItem] = rag_store.search_products(tenant_id, p_name, top_k=1)
        cat_item: Optional[ProductCatalogItem] = matches[0] if matches else None

        if cat_item is None:
            if policy.strict_catalog_only:
                violations.append(
                    GuardrailViolation(
                        code="OUT_OF_CATALOG_PRODUCT",
                        severity="high",
                        field=f"product:{p_name}",
                        message=f"Product '{p_name}' is not in tenant '{tenant_id}' catalog.",
                        suggested_reply_bangla=f"দুঃখিত, '{p_name}' বর্তমানে আমাদের ক্যাটালগে নেই। অনুগ্রহ করে আমাদের তালিকাভুক্ত পণ্য থেকে অর্ডার করুন।",
                    )
                )
                continue

            # Fallback inference when strict_catalog_only is False
            category, req_attrs, allowed_options_map = infer_attributes_for_product(p_name)
            resolved_name = p_name
            sku = "CUSTOM-REQ"
            unit_price = prev_match.unit_price if prev_match else 1200.0
        else:
            req_attrs = list(cat_item.required_attributes)
            allowed_options_map = dict(cat_item.attribute_options)
            resolved_name = cat_item.bangla_name or cat_item.product_name
            sku = cat_item.sku
            category = cat_item.category
            unit_price = cat_item.unit_price

            # Detect if LLM tried to hallucinate a different unitPrice than the catalog
            llm_price = p.get("unitPrice")
            if llm_price is not None:
                try:
                    if abs(float(llm_price) - unit_price) > 1.0:
                        violations.append(
                            GuardrailViolation(
                                code="PRICE_HALLUCINATION_CORRECTED",
                                severity="medium",
                                field=f"{sku}.unit_price",
                                message=f"LLM output unitPrice={llm_price}, overwritten with catalog price={unit_price} BDT.",
                            )
                        )
                except (ValueError, TypeError):
                    pass

        merged_attrs: Dict[str, str] = {}
        if prev_match:
            merged_attrs.update(prev_match.collected_attributes)

        for attr_key, raw_val in (p_attrs or {}).items():
            if raw_val is None:
                continue
            val_str = str(raw_val).strip()
            if not val_str or val_str.lower() in ("null", "none", "unknown", "?"):
                continue

            allowed_for_attr = allowed_options_map.get(attr_key, [])
            if policy.enforce_attribute_options_whitelist and allowed_for_attr:
                canonical_opt = match_allowed_attribute_option(val_str, allowed_for_attr)
                if canonical_opt is None:
                    bn_label = ATTRIBUTE_BANGLA_LABELS.get(attr_key, attr_key)
                    opts_display = ", ".join(allowed_for_attr)
                    # Remove any stale value so this attribute remains in missing_attributes
                    merged_attrs.pop(attr_key, None)
                    other_noted = (
                        f" ({', '.join(f'{k}: {v}' for k, v in merged_attrs.items())} নোট করা হয়েছে।)"
                        if merged_attrs
                        else ""
                    )
                    violations.append(
                        GuardrailViolation(
                            code="INVALID_ATTRIBUTE_OPTION",
                            severity="high",
                            field=f"{resolved_name}.{attr_key}",
                            message=f"Invalid option '{val_str}' for {attr_key}. Allowed: {allowed_for_attr}",
                            suggested_reply_bangla=(
                                f"দুঃখিত, {resolved_name}-এর {bn_label} হিসেবে '{val_str}' আমাদের স্টকে নেই।{other_noted} "
                                f"আমাদের কাছে রয়েছে: {opts_display}। এর মধ্যে কোনটি নিবেন?"
                            ),
                        )
                    )
                    continue
                else:
                    merged_attrs[attr_key] = canonical_opt
            else:
                merged_attrs[attr_key] = val_str

        missing = compute_missing_attributes(req_attrs, merged_attrs)

        validated_items.append(
            DraftCartItem(
                sku=sku,
                product_name=resolved_name,
                bangla_name=resolved_name,
                category=category,
                quantity=p_qty,
                quantity_text=p_qty_text,
                unit_price=unit_price,
                required_attributes=req_attrs,
                collected_attributes=merged_attrs,
                missing_attributes=missing,
            )
        )

    return validated_items, violations
