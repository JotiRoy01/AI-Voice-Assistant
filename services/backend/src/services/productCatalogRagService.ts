import fs from 'fs';
import path from 'path';
import { AppEnv } from '../config/env';
import { ProductCatalogEntry } from '../domain/types';

export const ATTRIBUTE_BANGLA_LABELS: Record<string, string> = {
  colour: 'রঙ (Colour)',
  size: 'সাইজ (Size)',
  fit: 'ফিট (Fit)',
  brand: 'ব্র্যান্ড (Brand)',
  ddr_type: 'ডিডিআর টাইপ (DDR4/DDR5)',
  capacity_gb: 'ক্যাপাসিটি (8GB/16GB/32GB)',
  bus_speed_mhz: 'বাস স্পিড (3200MHz/5600MHz)',
  screen_size_inch: 'স্ক্রিন সাইজ (22"/24"/27")',
  refresh_rate_hz: 'রিফ্রেশ রেট (75Hz/100Hz/144Hz)',
  panel_type: 'প্যানেল টাইপ (IPS/VA/OLED)',
  connection_type: 'কানেকশন টাইপ (Wired/Wireless)',
  switch_type: 'সুইচ টাইপ (Red/Blue/Membrane)',
  dpi: 'ডিপিআই (DPI)',
  ram_storage: 'র‍্যাম ও স্টোরেজ (8GB/128GB)',
  warranty_type: 'ওয়ারেন্টি (Official/Shop)',
  weight_or_volume: 'ওজন বা পরিমাণ (500ml/1KG/2KG)',
  packaging: 'প্যাকেজিং (Jar/Bottle)',
  origin: 'অরিজিন (Spanish/Italian)',
  variant_or_brand: 'ভ্যারিয়েন্ট বা ব্র্যান্ড',
};

const CATEGORY_INFERENCE_RULES: {
  regex: RegExp;
  category: string;
  requiredAttributes: string[];
  attributeOptions: Record<string, string[]>;
}[] = [
  {
    regex: /ram|র‍্যাম|র্যাম|মেমোরি/i,
    category: 'PC Hardware',
    requiredAttributes: ['brand', 'ddr_type', 'capacity_gb', 'bus_speed_mhz'],
    attributeOptions: {
      brand: ['Corsair', 'Kingston', 'G.Skill', 'Transcend'],
      ddr_type: ['DDR4', 'DDR5'],
      capacity_gb: ['8GB', '16GB', '32GB'],
      bus_speed_mhz: ['3200MHz', '4800MHz', '5600MHz'],
    },
  },
  {
    regex: /monitor|মনিটর|ডিসপ্লে/i,
    category: 'PC Hardware',
    requiredAttributes: ['brand', 'screen_size_inch', 'refresh_rate_hz', 'panel_type'],
    attributeOptions: {
      brand: ['LG', 'ASUS', 'Samsung', 'MSI'],
      screen_size_inch: ['22 inch', '24 inch', '27 inch'],
      refresh_rate_hz: ['75Hz', '100Hz', '144Hz', '180Hz'],
      panel_type: ['IPS', 'VA', 'OLED'],
    },
  },
  {
    regex: /keyboard|কিবোর্ড|কীবোর্ড/i,
    category: 'Accessories',
    requiredAttributes: ['brand', 'connection_type', 'switch_type'],
    attributeOptions: {
      brand: ['A4Tech', 'Logitech', 'Redragon', 'Keychron'],
      connection_type: ['USB Wired', 'Wireless 2.4G', 'Bluetooth'],
      switch_type: ['Red Switch (Silent)', 'Blue Switch (Clicky)', 'Membrane Office'],
    },
  },
  {
    regex: /mouse|মাউস|মাংস/i,
    category: 'Accessories',
    requiredAttributes: ['brand', 'connection_type', 'dpi'],
    attributeOptions: {
      brand: ['A4Tech', 'Logitech', 'Razer', 'Fantech'],
      connection_type: ['USB Wired', 'Wireless'],
      dpi: ['1600 DPI', '3200 DPI', '12000 DPI'],
    },
  },
  {
    regex: /phone|smartphone|মোবাইল|ফোন|স্মার্টফোন/i,
    category: 'Mobile',
    requiredAttributes: ['brand', 'ram_storage', 'colour', 'warranty_type'],
    attributeOptions: {
      brand: ['Samsung', 'Xiaomi', 'Realme', 'iPhone'],
      ram_storage: ['6GB/128GB', '8GB/128GB', '8GB/256GB'],
      colour: ['কালো (Black)', 'নীল (Blue)', 'সিলভার (Silver)'],
      warranty_type: ['Official 1 Year', 'Shop Warranty'],
    },
  },
  {
    regex: /shirt|pant|panjabi|saree|শার্ট|প্যান্ট|পাঞ্জাবি|শাড়ি|শাড়ি|টি-শার্ট/i,
    category: 'Apparel',
    requiredAttributes: ['colour', 'size'],
    attributeOptions: {
      colour: ['কালো (Black)', 'নেভি ব্লু (Navy Blue)', 'সাদা (White)', 'অলিভ (Olive)'],
      size: ['M', 'L', 'XL', '32', '34', '36', '40', '42'],
    },
  },
  {
    regex: /oil|tea|booster|honey|ghee|অয়েল|তেল|চা|বুস্টার|মধু|ঘি/i,
    category: 'Organic & Grocery',
    requiredAttributes: ['weight_or_volume'],
    attributeOptions: {
      weight_or_volume: ['250g', '500g / 500ml', '1 KG / 1 Liter', '2 KG / 2 Liter'],
    },
  },
];

export function inferAttributesForProduct(name: string): {
  category: string;
  requiredAttributes: string[];
  attributeOptions: Record<string, string[]>;
} {
  for (const rule of CATEGORY_INFERENCE_RULES) {
    if (rule.regex.test(name)) {
      return {
        category: rule.category,
        requiredAttributes: [...rule.requiredAttributes],
        attributeOptions: { ...rule.attributeOptions },
      };
    }
  }
  return {
    category: 'General',
    requiredAttributes: ['variant_or_brand'],
    attributeOptions: { variant_or_brand: ['Standard', 'Premium'] },
  };
}

/**
 * Parses a CSV line respecting quoted fields and escaped double-quotes (`""`).
 */
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

export class ProductCatalogRagService {
  /**
   * ============================================================================
   * CLASS DESCRIPTION: ProductCatalogRagService (Phase 2 Multi-Tenant Catalog & RAG Bridge)
   * - MEANING: Manages each company's uploaded Product Catalog (`.csv` / `.json`), dynamic required attributes (`requiredAttributes` + `attributeOptions`), and hybrid RAG product retrieval.
   * - WHY WE USE IT:
   *   1. Automatically loads the 12-item Bangladeshi Multi-Category Product Catalog (`services/ai-agent/sample_catalogs/bd_multi_category_products.csv`) covering Apparel (Pant, Panjabi, Shirt), PC Hardware (RAM, Monitor), Accessories (Keyboard, Mouse), Mobile (5G Smartphone), and Organic Grocery (Coconut Oil, Olive Oil, Yellow Booster, Green Tea).
   *   2. Allows companies to upload their own `.csv` file from the Dashboard ("Product Catalog & RAG" page)—automatically inferring required attributes if the CSV only has `product_name,price`!
   *   3. Synchronizes uploaded CSVs with the Python `services/ai-agent` microservice (`http://localhost:8001/api/v1/knowledge/ingest-csv`) while maintaining an in-process TypeScript mirror so your project works seamlessly even if only Node.js is running!
   * ============================================================================
   */
  private catalogs = new Map<string, ProductCatalogEntry[]>();
  private sampleCsvPath: string;

  constructor(private readonly env: AppEnv) {
    const candidates = [
      path.resolve(process.cwd(), '../ai-agent/sample_catalogs/bd_multi_category_products.csv'),
      path.resolve(process.cwd(), 'services/ai-agent/sample_catalogs/bd_multi_category_products.csv'),
    ];
    this.sampleCsvPath = candidates.find((p) => fs.existsSync(p)) || candidates[0];
  }

  private ensureSeeded(tenantId: string): ProductCatalogEntry[] {
    if (!this.catalogs.has(tenantId) || this.catalogs.get(tenantId)!.length === 0) {
      if (fs.existsSync(this.sampleCsvPath)) {
        const csvText = fs.readFileSync(this.sampleCsvPath, 'utf8');
        this.ingestCsvForTenant(tenantId, csvText, true);
      }
    }
    return this.catalogs.get(tenantId) || [];
  }

  getSampleCsvContent(): string {
    if (fs.existsSync(this.sampleCsvPath)) {
      return fs.readFileSync(this.sampleCsvPath, 'utf8');
    }
    return 'sku,product_name,bangla_name,category,unit_price,required_attributes\nAPP-SHT-01,Cotton Shirt,শার্ট,Apparel,1250,colour|size\nPC-RAM-01,Corsair RAM,র‍্যাম,PC Hardware,4200,brand|ddr_type|capacity_gb|bus_speed_mhz\n';
  }

  listCatalog(tenantId: string): ProductCatalogEntry[] {
    return [...this.ensureSeeded(tenantId)];
  }

  ingestCsvForTenant(
    tenantId: string,
    csvContent: string,
    replaceExisting = false
  ): ProductCatalogEntry[] {
    const lines = csvContent
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length < 2) {
      return this.listCatalog(tenantId);
    }

    const headers = parseCsvLine(lines[0]).map((h) => h.toLowerCase().trim());
    const parsedItems: ProductCatalogEntry[] = [];

    for (let i = 1; i < lines.length; i++) {
      const cols = parseCsvLine(lines[i]);
      const row: Record<string, string> = {};
      headers.forEach((h, idx) => {
        row[h] = cols[idx] ?? '';
      });

      const productName = (
        row.product_name ||
        row.name ||
        row.title ||
        row['পণ্য'] ||
        ''
      ).trim();
      if (!productName) continue;

      const banglaName = (row.bangla_name || row.bn_name || productName).trim();
      const sku = (row.sku || row.id || `SKU-${100 + i}`).trim();
      const rawAliases = (row.aliases || row.synonyms || '').trim();
      const aliases = rawAliases
        .split(/[|,;]/)
        .map((a) => a.trim())
        .filter(Boolean);
      for (const candidate of [productName.toLowerCase(), banglaName.toLowerCase()]) {
        if (!aliases.includes(candidate)) aliases.push(candidate);
      }

      const unitPrice = Number(
        String(row.unit_price || row.price || '1200').replace(/[^\d.]/g, '') || 1200
      );
      const stockQty = Number(row.stock_qty || row.stock || 100);

      const inferred = inferAttributesForProduct(
        `${productName} ${banglaName} ${aliases.join(' ')}`
      );
      const category = (row.category || inferred.category).trim();

      const rawReqs = (row.required_attributes || '').trim();
      const requiredAttributes = rawReqs
        ? rawReqs
            .split(/[|,;]/)
            .map((r) => r.trim())
            .filter(Boolean)
        : inferred.requiredAttributes;

      let attributeOptions: Record<string, string[]> = inferred.attributeOptions;
      if (row.attribute_options_json) {
        try {
          attributeOptions = JSON.parse(row.attribute_options_json);
        } catch {
          attributeOptions = inferred.attributeOptions;
        }
      }

      parsedItems.push({
        id: `${tenantId}-${sku}`,
        tenantId,
        sku,
        productName,
        banglaName,
        aliases,
        category,
        unitPrice: Number.isNaN(unitPrice) ? 1200 : unitPrice,
        currency: (row.currency || 'BDT').trim(),
        stockQty: Number.isNaN(stockQty) ? 100 : stockQty,
        requiredAttributes,
        attributeOptions,
        description: (row.description || '').trim(),
      });
    }

    if (replaceExisting || !this.catalogs.has(tenantId)) {
      this.catalogs.set(tenantId, parsedItems);
    } else {
      const existingMap = new Map(
        this.catalogs.get(tenantId)!.map((item) => [item.sku, item])
      );
      for (const item of parsedItems) {
        existingMap.set(item.sku, item);
      }
      this.catalogs.set(tenantId, Array.from(existingMap.values()));
    }

    // Best-effort async sync to Python AI Agent microservice on port 8001 if running
    const pythonAgentUrl = process.env.PYTHON_AI_AGENT_URL || 'http://localhost:8001';
    fetch(`${pythonAgentUrl.replace(/\/$/, '')}/api/v1/knowledge/ingest-csv`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenant_id: tenantId,
        csv_content: csvContent,
        replace_existing: replaceExisting,
      }),
      signal: AbortSignal.timeout(2500),
    }).catch(() => {});

    return this.catalogs.get(tenantId)!;
  }

  searchProducts(tenantId: string, query: string, topK = 4): ProductCatalogEntry[] {
    const catalog = this.ensureSeeded(tenantId);
    if (!query || !query.trim()) return [];
    const qLower = query.toLowerCase().trim();

    const scored: { score: number; item: ProductCatalogEntry }[] = [];
    for (const item of catalog) {
      let score = 0;
      const terms = [
        item.productName.toLowerCase(),
        item.banglaName.toLowerCase(),
        item.sku.toLowerCase(),
        ...item.aliases.map((a) => a.toLowerCase()),
      ];
      for (const term of terms) {
        if (!term) continue;
        if (term === qLower) {
          score = Math.max(score, 100);
        } else if (term.length >= 2 && qLower.includes(term)) {
          score = Math.max(score, 85);
        } else if (qLower.length >= 2 && term.includes(qLower)) {
          score = Math.max(score, 75);
        }
      }
      if (score >= 50) {
        scored.push({ score, item });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).map((s) => s.item);
  }
}
