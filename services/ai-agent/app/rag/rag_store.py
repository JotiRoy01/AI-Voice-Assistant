import csv
import io
import json
import re
import uuid
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from app.schemas.models import ProductCatalogItem


# Automatic Zero-Shot Schema Inference when a company uploads a simple CSV without required_attributes
CATEGORY_ATTRIBUTE_INFERENCE: List[Tuple[re.Pattern, str, List[str], Dict[str, List[str]]]] = [
    (
        re.compile(r"ram|র‍্যাম|র্যাম|মেমোরি", re.I),
        "PC Hardware",
        ["brand", "ddr_type", "capacity_gb", "bus_speed_mhz"],
        {
            "brand": ["Corsair", "Kingston", "G.Skill", "Transcend"],
            "ddr_type": ["DDR4", "DDR5"],
            "capacity_gb": ["8GB", "16GB", "32GB"],
            "bus_speed_mhz": ["3200MHz", "4800MHz", "5600MHz"],
        },
    ),
    (
        re.compile(r"monitor|মনিটর|ডিসপ্লে", re.I),
        "PC Hardware",
        ["brand", "screen_size_inch", "refresh_rate_hz", "panel_type"],
        {
            "brand": ["LG", "ASUS", "Samsung", "MSI"],
            "screen_size_inch": ["22 inch", "24 inch", "27 inch"],
            "refresh_rate_hz": ["75Hz", "100Hz", "144Hz", "180Hz"],
            "panel_type": ["IPS", "VA", "OLED"],
        },
    ),
    (
        re.compile(r"keyboard|কিবোর্ড|কীবোর্ড", re.I),
        "Accessories",
        ["brand", "connection_type", "switch_type"],
        {
            "brand": ["A4Tech", "Logitech", "Redragon", "Keychron"],
            "connection_type": ["USB Wired", "Wireless 2.4G", "Bluetooth"],
            "switch_type": ["Red Switch", "Blue Switch", "Membrane Office"],
        },
    ),
    (
        re.compile(r"mouse|মাউস|মাংস", re.I),
        "Accessories",
        ["brand", "connection_type", "dpi"],
        {
            "brand": ["A4Tech", "Logitech", "Razer", "Fantech"],
            "connection_type": ["USB Wired", "Wireless"],
            "dpi": ["1600 DPI", "3200 DPI", "12000 DPI"],
        },
    ),
    (
        re.compile(r"phone|smartphone|মোবাইল|ফোন|স্মার্টফোন", re.I),
        "Mobile",
        ["brand", "ram_storage", "colour", "warranty_type"],
        {
            "brand": ["Samsung", "Xiaomi", "Realme", "iPhone"],
            "ram_storage": ["6GB/128GB", "8GB/128GB", "8GB/256GB"],
            "colour": ["কালো (Black)", "নীল (Blue)", "সিলভার (Silver)"],
            "warranty_type": ["Official 1 Year", "Shop Warranty"],
        },
    ),
    (
        re.compile(r"shirt|pant|panjabi|saree|শার্ট|প্যান্ট|পাঞ্জাবি|শাড়ি|শাড়ি|টি-শার্ট", re.I),
        "Apparel",
        ["colour", "size"],
        {
            "colour": ["কালো (Black)", "নেভি ব্লু (Navy Blue)", "সাদা (White)", "অলিভ (Olive)"],
            "size": ["M", "L", "XL", "32", "34", "36", "40", "42"],
        },
    ),
    (
        re.compile(r"oil|tea|booster|honey|ghee|অয়েল|তেল|চা|বুস্টার|মধু|ঘি", re.I),
        "Organic & Grocery",
        ["weight_or_volume"],
        {
            "weight_or_volume": ["250g", "500g / 500ml", "1 KG / 1 Liter", "2 KG / 2 Liter"],
        },
    ),
]


def infer_attributes_for_product(name: str) -> Tuple[str, List[str], Dict[str, List[str]]]:
    """
    If a company uploads a CSV or names a product that doesn't explicitly list required_attributes,
    automatically infers the category, required_attributes, and allowed options!
    """
    for pattern, category, req_attrs, opts in CATEGORY_ATTRIBUTE_INFERENCE:
        if pattern.search(name):
            return category, list(req_attrs), dict(opts)
    return "General", ["variant_or_brand"], {"variant_or_brand": ["Standard", "Premium"]}


class MultiTenantCatalogRagStore:
    """
    ============================================================================
    CLASS DESCRIPTION: MultiTenantCatalogRagStore (RAG + Hybrid Product Search)
    - MEANING: Tenant-isolated knowledge base & product schema store for the Python AI Agent.
    - WHY WE USE IT:
      1. Ingests any company's CSV / JSON / Text product file (`ingest_csv_content`).
      2. Auto-enriches missing `required_attributes` when a company uploads a simple price list.
      3. Performs Hybrid Search (Bangla/English alias matching + token overlap + fuzzy character N-gram similarity) so even noisy Bangla speech recognition (like "টিয়োলো বুস্টার" or "এফ৪ টেকার" or "র্যাম") retrieves the exact product schema!
    ============================================================================
    """

    def __init__(self) -> None:
        # tenant_id -> list of ProductCatalogItem
        self._catalogs: Dict[str, List[ProductCatalogItem]] = {}

    def ensure_tenant_seeded(self, tenant_id: str, sample_csv_path: Path) -> List[ProductCatalogItem]:
        if tenant_id not in self._catalogs or len(self._catalogs[tenant_id]) == 0:
            if sample_csv_path.exists():
                csv_text = sample_csv_path.read_text(encoding="utf-8")
                self.ingest_csv_content(tenant_id, csv_text, replace_existing=True)
        return self._catalogs.get(tenant_id, [])

    def list_products(self, tenant_id: str) -> List[ProductCatalogItem]:
        return list(self._catalogs.get(tenant_id, []))

    def ingest_csv_content(
        self, tenant_id: str, csv_content: str, replace_existing: bool = False
    ) -> List[ProductCatalogItem]:
        """
        Parses an uploaded CSV file for `tenant_id`.
        Supports full schema CSVs (`sku,product_name,bangla_name,aliases,category,unit_price,required_attributes,attribute_options_json`)
        AND simple 2-column merchant CSVs (`product_name,price`) via auto-attribute inference!
        """
        reader = csv.DictReader(io.StringIO(csv_content.strip()))
        items: List[ProductCatalogItem] = []

        for idx, row in enumerate(reader):
            if not row:
                continue
            prod_name = (
                row.get("product_name")
                or row.get("name")
                or row.get("title")
                or row.get("পণ্য")
                or ""
            ).strip()
            if not prod_name:
                continue

            bangla_name = (row.get("bangla_name") or row.get("bn_name") or prod_name).strip()
            sku = (row.get("sku") or row.get("id") or f"SKU-{idx + 101}").strip()
            raw_aliases = (row.get("aliases") or row.get("synonyms") or "").strip()
            aliases = [a.strip() for a in re.split(r"[|,;]", raw_aliases) if a.strip()]
            for candidate in [prod_name.lower(), bangla_name.lower()]:
                if candidate not in aliases:
                    aliases.append(candidate)

            try:
                unit_price = float(
                    re.sub(r"[^\d.]", "", str(row.get("unit_price") or row.get("price") or "1200"))
                    or 1200.0
                )
            except ValueError:
                unit_price = 1200.0

            try:
                stock_qty = int(row.get("stock_qty") or row.get("stock") or 100)
            except ValueError:
                stock_qty = 100

            inferred_cat, inferred_reqs, inferred_opts = infer_attributes_for_product(
                f"{prod_name} {bangla_name} {' '.join(aliases)}"
            )
            category = (row.get("category") or inferred_cat).strip()

            raw_reqs = (row.get("required_attributes") or "").strip()
            if raw_reqs:
                required_attributes = [
                    r.strip() for r in re.split(r"[|,;]", raw_reqs) if r.strip()
                ]
            else:
                required_attributes = inferred_reqs

            raw_opts_json = (row.get("attribute_options_json") or "").strip()
            attribute_options: Dict[str, List[str]] = {}
            if raw_opts_json:
                try:
                    attribute_options = json.loads(raw_opts_json)
                except Exception:
                    attribute_options = inferred_opts
            else:
                attribute_options = inferred_opts

            items.append(
                ProductCatalogItem(
                    id=f"{tenant_id}-{sku}",
                    tenant_id=tenant_id,
                    sku=sku,
                    product_name=prod_name,
                    bangla_name=bangla_name,
                    aliases=aliases,
                    category=category,
                    unit_price=unit_price,
                    currency=(row.get("currency") or "BDT").strip(),
                    stock_qty=stock_qty,
                    required_attributes=required_attributes,
                    attribute_options=attribute_options,
                    description=(row.get("description") or "").strip(),
                )
            )

        if replace_existing or tenant_id not in self._catalogs:
            self._catalogs[tenant_id] = items
        else:
            existing_by_sku = {p.sku: p for p in self._catalogs[tenant_id]}
            for item in items:
                existing_by_sku[item.sku] = item
            self._catalogs[tenant_id] = list(existing_by_sku.values())

        return self._catalogs[tenant_id]

    def search_products(
        self, tenant_id: str, query: str, top_k: int = 4
    ) -> List[ProductCatalogItem]:
        """
        Hybrid RAG Search (Exact Alias Match + Word Overlap + Character Trigram Similarity)
        strictly isolated to `tenant_id`.
        """
        catalog = self._catalogs.get(tenant_id, [])
        if not catalog or not query.strip():
            return []

        q_lower = query.lower().strip()
        scored: List[Tuple[float, ProductCatalogItem]] = []

        for item in catalog:
            score = 0.0
            searchable_terms = [
                item.product_name.lower(),
                item.bangla_name.lower(),
                item.sku.lower(),
                * [a.lower() for a in item.aliases],
            ]

            for term in searchable_terms:
                if not term:
                    continue
                if term == q_lower:
                    score = max(score, 100.0)
                elif len(term) >= 2 and term in q_lower:
                    score = max(score, 85.0)
                elif len(q_lower) >= 2 and q_lower in term:
                    score = max(score, 75.0)
                else:
                    # Character bigram overlap for Bangla STT fuzzy matching
                    sim = self._char_ngram_similarity(q_lower, term)
                    if sim >= 0.45:
                        score = max(score, sim * 60.0)

            if score >= 25.0:
                scored.append((score, item))

        scored.sort(key=lambda x: x[0], reverse=True)
        return [item for _, item in scored[:top_k]]

    @staticmethod
    def _char_ngram_similarity(a: str, b: str, n: int = 2) -> float:
        if len(a) < n or len(b) < n:
            return 0.0
        set_a = {a[i : i + n] for i in range(len(a) - n + 1)}
        set_b = {b[i : i + n] for i in range(len(b) - n + 1)}
        if not set_a or not set_b:
            return 0.0
        return len(set_a & set_b) / float(len(set_a | set_b))


rag_store = MultiTenantCatalogRagStore()
