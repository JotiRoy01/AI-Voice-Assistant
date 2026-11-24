from typing import Any, Dict, List
from app.rag.rag_store import infer_attributes_for_product, rag_store
from app.schemas.models import DraftCartItem, ProductCatalogItem


# Human-friendly Bangla labels for product attributes so the AI asks natural Bangla questions!
ATTRIBUTE_BANGLA_LABELS: Dict[str, str] = {
    "colour": "রঙ (Colour)",
    "size": "সাইজ (Size)",
    "fit": "ফিট (Slim/Regular Fit)",
    "brand": "ব্র্যান্ড (Brand)",
    "ddr_type": "ডিডিআর টাইপ (DDR4 নাকি DDR5)",
    "capacity_gb": "কত জিবি ক্যাপাসিটি (8GB / 16GB / 32GB)",
    "bus_speed_mhz": "বাস স্পিড (যেমন 3200MHz / 5600MHz)",
    "screen_size_inch": "স্ক্রিন সাইজ (22 / 24 / 27 ইঞ্চি)",
    "refresh_rate_hz": "রিফ্রেশ রেট (75Hz / 100Hz / 144Hz)",
    "panel_type": "প্যানেল টাইপ (IPS / VA / OLED)",
    "connection_type": "কানেকশন টাইপ (Wired নাকি Wireless)",
    "switch_type": "সুইচ টাইপ (Mechanical Red/Blue নাকি Office Membrane)",
    "dpi": "ডিপিআই / মডেল (DPI)",
    "ram_storage": "র‍্যাম ও স্টোরেজ (যেমন 8GB/128GB বা 8GB/256GB)",
    "warranty_type": "ওয়ারেন্টি (Official নাকি Shop Warranty)",
    "weight_or_volume": "পরিমাণ বা ওজন (500ml / 1 KG / 2 KG)",
    "packaging": "প্যাকেজিং (Glass Jar / Bottle)",
    "origin": "অরিজিন (Spanish / Italian)",
    "variant_or_brand": "ব্র্যান্ড বা ভ্যারিয়েন্ট",
}


def compute_missing_attributes(
    required_attributes: List[str], collected_attributes: Dict[str, str]
) -> List[str]:
    """
    Deterministically computes which required attributes for a product are still missing.
    """
    missing: List[str] = []
    for req in required_attributes:
        val = str(collected_attributes.get(req, "")).strip()
        if not val or val.lower() in ("null", "none", "unknown", "?"):
            missing.append(req)
    return missing


def tool_search_product_catalog(tenant_id: str, query: str) -> List[ProductCatalogItem]:
    """
    AGENT TOOL 1: search_product_catalog
    Searches the company's uploaded CSV/RAG product catalog for `query` and returns
    matching products along with their `required_attributes` and `attribute_options`.
    """
    return rag_store.search_products(tenant_id, query, top_k=3)


def tool_build_or_update_cart_item(
    tenant_id: str,
    product_name: str,
    quantity: int,
    quantity_text: str,
    collected_attributes: Dict[str, str],
    existing_item: DraftCartItem | None = None,
) -> DraftCartItem:
    """
    AGENT TOOL 2: build_or_update_cart_item
    Matches `product_name` against the company's catalog (or falls back to Zero-Shot schema inference
    if the product is not in the catalog), merges `collected_attributes`, and deterministically computes
    `missing_attributes`!
    """
    matches = rag_store.search_products(tenant_id, product_name, top_k=1)
    if matches:
        cat_item = matches[0]
        req_attrs = list(cat_item.required_attributes)
        resolved_name = cat_item.bangla_name or cat_item.product_name
        sku = cat_item.sku
        category = cat_item.category
        unit_price = cat_item.unit_price
    else:
        # Zero-Shot Inference Fallback when the company has not uploaded this product in their CSV
        category, req_attrs, _ = infer_attributes_for_product(product_name)
        resolved_name = product_name
        sku = "CUSTOM-REQ"
        unit_price = existing_item.unit_price if existing_item else 1200.0

    merged_attrs: Dict[str, str] = {}
    if existing_item:
        merged_attrs.update(existing_item.collected_attributes)
    for k, v in (collected_attributes or {}).items():
        if v and str(v).strip() and str(v).lower() not in ("null", "none"):
            merged_attrs[k] = str(v).strip()

    missing = compute_missing_attributes(req_attrs, merged_attrs)

    return DraftCartItem(
        sku=sku,
        product_name=resolved_name,
        bangla_name=resolved_name,
        category=category,
        quantity=max(1, quantity),
        quantity_text=quantity_text or f"{max(1, quantity)}টি",
        unit_price=unit_price,
        required_attributes=req_attrs,
        collected_attributes=merged_attrs,
        missing_attributes=missing,
    )


def tool_format_order_for_store_adapter(
    external_order_id: str,
    customer_name: str,
    phone: str,
    delivery_method: str,
    delivery_address: str,
    draft_items: List[DraftCartItem],
) -> Dict[str, Any]:
    """
    AGENT TOOL 3: format_order_for_store_adapter
    Formats the validated multi-product cart (with all product-specific dynamic attributes)
    into the exact payload schema consumed by `CustomStoreAdapter.normalizeOrderPayload` in `storeAdapters.ts`!
    """
    total_amount = sum(item.quantity * item.unit_price for item in draft_items)
    formatted_items: List[Dict[str, Any]] = []

    for item in draft_items:
        attrs = dict(item.collected_attributes)
        colour = attrs.get("colour") or attrs.get("color")
        size = attrs.get("size") or attrs.get("screen_size_inch") or attrs.get("capacity_gb")
        variant_parts = [f"{k}: {v}" for k, v in attrs.items() if v]
        variant_str = " · ".join(variant_parts) if variant_parts else item.quantity_text

        formatted_items.append(
            {
                "sku": item.sku,
                "category": item.category,
                "productName": item.product_name,
                "variant": variant_str,
                "colour": colour,
                "size": size,
                "quantity": item.quantity,
                "unitPrice": item.unit_price,
                "attributes": attrs,
            }
        )

    return {
        "externalOrderId": external_order_id,
        "storeProvider": "custom",
        "customerName": customer_name,
        "phone": phone,
        "deliveryMethod": delivery_method,
        "deliveryAddress": delivery_address,
        "totalAmount": total_amount,
        "currency": "BDT",
        "orderStatus": "confirmed",
        "consentGranted": True,
        "items": formatted_items,
    }
