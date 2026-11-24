'use client';

import React, { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  Database,
  Download,
  FileSpreadsheet,
  Plus,
  RefreshCw,
  Sparkles,
  Upload,
} from 'lucide-react';
import { useAuth } from '@/components/AuthContext';
import { API_BASE_URL, apiFetch } from '@/lib/api';

interface ProductCatalogEntry {
  id: string;
  tenantId: string;
  sku: string;
  productName: string;
  banglaName: string;
  aliases: string[];
  category: string;
  unitPrice: number;
  currency: string;
  stockQty: number;
  requiredAttributes: string[];
  attributeOptions: Record<string, string[]>;
  description: string;
}

export default function ProductCatalogRagPage() {
  const { token, activeTenantId } = useAuth();
  const [products, setProducts] = useState<ProductCatalogEntry[]>([]);
  const [attributeLabels, setAttributeLabels] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Quick Add Single Product Form
  const [newSku, setNewSku] = useState('');
  const [newName, setNewName] = useState('');
  const [newBanglaName, setNewBanglaName] = useState('');
  const [newCategory, setNewCategory] = useState('PC Hardware');
  const [newPrice, setNewPrice] = useState(3500);
  const [newReqAttrs, setNewReqAttrs] = useState('brand|ddr_type|capacity_gb|bus_speed_mhz');

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const loadCatalog = async () => {
    if (!token || !activeTenantId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{
        count: number;
        attributeLabels: Record<string, string>;
        products: ProductCatalogEntry[];
      }>('/api/conversation/catalog', { token, tenantId: activeTenantId });
      setProducts(res.products);
      setAttributeLabels(res.attributeLabels || {});
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load catalog');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadCatalog();
  }, [token, activeTenantId]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !token || !activeTenantId) return;
    setUploading(true);
    setStatusMsg(null);
    setError(null);
    try {
      const text = await file.text();
      const res = await apiFetch<{
        ingestedCount: number;
        attributeLabels: Record<string, string>;
        products: ProductCatalogEntry[];
      }>('/api/conversation/catalog/ingest-csv', {
        method: 'POST',
        token,
        tenantId: activeTenantId,
        body: JSON.stringify({
          csvContent: text,
          replaceExisting,
        }),
      });
      setProducts(res.products);
      setAttributeLabels(res.attributeLabels || {});
      setStatusMsg(
        `Successfully ingested "${file.name}" into RAG Knowledge Base (${res.ingestedCount} products active for this tenant)!`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'CSV ingestion failed');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleQuickAddProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !activeTenantId || !newName.trim()) return;
    setUploading(true);
    setStatusMsg(null);
    setError(null);
    try {
      const sku = newSku.trim() || `CUST-${Math.floor(100 + Math.random() * 900)}`;
      const bn = newBanglaName.trim() || newName.trim();
      const csvSnippet = [
        'sku,product_name,bangla_name,aliases,category,unit_price,currency,stock_qty,required_attributes',
        `${sku},"${newName.trim()}","${bn}","${newName.trim()}|${bn}",${newCategory},${newPrice},BDT,50,${newReqAttrs.trim()}`,
      ].join('\n');

      const res = await apiFetch<{
        ingestedCount: number;
        products: ProductCatalogEntry[];
      }>('/api/conversation/catalog/ingest-csv', {
        method: 'POST',
        token,
        tenantId: activeTenantId,
        body: JSON.stringify({
          csvContent: csvSnippet,
          replaceExisting: false,
        }),
      });
      setProducts(res.products);
      setNewSku('');
      setNewName('');
      setNewBanglaName('');
      setStatusMsg(
        `Added "${bn}" with required attributes [${newReqAttrs}] to the AI Voice Agent RAG catalog!`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add product');
    } finally {
      setUploading(false);
    }
  };

  const downloadSampleCsv = async () => {
    if (!token || !activeTenantId) return;
    try {
      const res = await fetch(`${API_BASE_URL}/api/conversation/catalog/sample-csv`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Tenant-Id': activeTenantId,
        },
      });
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'bd_multi_category_products.csv';
      a.click();
      window.URL.revokeObjectURL(url);
    } catch {
      // ignore
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            <Database className="w-6 h-6 text-indigo-600" />
            Product Catalog & Multi-Tenant RAG Knowledge Base
          </h1>
          <p className="text-sm text-slate-500">
            Attach your company&apos;s product CSV file or define product-specific required purchase attributes (Apparel, PC Hardware, Monitors, RAM, Phones, Grocery) for the AI Voice Agent &amp; <code>storeAdapters.ts</code>
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={downloadSampleCsv}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-white border border-slate-300 hover:bg-slate-50 text-xs font-semibold text-slate-700 shadow-sm"
          >
            <Download className="w-3.5 h-3.5" />
            Download Sample BD Multi-Category CSV
          </button>
          <button
            type="button"
            onClick={loadCatalog}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white border border-slate-200 hover:bg-slate-50 text-xs font-medium text-slate-700"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3.5 rounded-xl bg-red-50 border border-red-200 text-xs font-medium text-red-700">
          {error}
        </div>
      )}

      {statusMsg && (
        <div className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-xs font-semibold text-emerald-800 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-600" />
          {statusMsg}
        </div>
      )}

      {/* Upload CSV + Quick Add Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left: Attach Company CSV File */}
        <div className="lg:col-span-5 bg-white rounded-2xl border border-slate-200 p-5 shadow-sm space-y-4 flex flex-col justify-between">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <FileSpreadsheet className="w-4 h-4 text-indigo-600" />
                1. Attach Company Product CSV File (RAG Ingestion)
              </h2>
              <span className="text-[10px] font-mono bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded border border-indigo-200">
                Auto-Schema Inference
              </span>
            </div>
            <p className="text-xs text-slate-500 leading-relaxed">
              Upload a full product CSV (with <code>required_attributes</code> like <code>brand|ddr_type|capacity_gb|bus_speed_mhz</code>) OR a simple 2-column CSV (<code>product_name,price</code>) — our RAG engine automatically infers the required attributes for RAM, Monitors, Phones, Shirts, Pants, and Groceries!
            </p>
          </div>

          <div className="p-5 rounded-xl border-2 border-dashed border-indigo-200 bg-indigo-50/40 text-center space-y-3">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.txt"
              onChange={handleFileUpload}
              className="hidden"
              id="catalog-csv-upload"
            />
            <label
              htmlFor="catalog-csv-upload"
              className="cursor-pointer inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold shadow transition"
            >
              <Upload className="w-4 h-4" />
              {uploading ? 'Ingesting into RAG...' : 'Choose Company .CSV File to Attach'}
            </label>
            <div className="flex items-center justify-center gap-2 text-xs text-slate-600">
              <input
                type="checkbox"
                id="replace-existing"
                checked={replaceExisting}
                onChange={(e) => setReplaceExisting(e.target.checked)}
                className="rounded border-slate-300"
              />
              <label htmlFor="replace-existing">
                Replace existing catalog (uncheck to merge/append products)
              </label>
            </div>
          </div>
        </div>

        {/* Right: Quick Add Custom Product with Required Attributes */}
        <form
          onSubmit={handleQuickAddProduct}
          className="lg:col-span-7 bg-white rounded-2xl border border-slate-200 p-5 shadow-sm space-y-4"
        >
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-slate-900 flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-blue-600" />
              2. Add Custom Product & Required Voice Attributes
            </h2>
            <span className="text-[11px] text-slate-400">
              AI Voice Agent will automatically ask for these attributes!
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Product Name (English)
              </label>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. NVMe SSD / Router"
                required
                className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Bangla Name (বাংলা নাম)
              </label>
              <input
                value={newBanglaName}
                onChange={(e) => setNewBanglaName(e.target.value)}
                placeholder="যেমন: এসএসডি / রাউটার"
                className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Category
              </label>
              <select
                value={newCategory}
                onChange={(e) => {
                  const cat = e.target.value;
                  setNewCategory(cat);
                  if (cat === 'Apparel') setNewReqAttrs('colour|size');
                  if (cat === 'PC Hardware') setNewReqAttrs('brand|ddr_type|capacity_gb|bus_speed_mhz');
                  if (cat === 'Mobile') setNewReqAttrs('brand|ram_storage|colour|warranty_type');
                  if (cat === 'Organic & Grocery') setNewReqAttrs('weight_or_volume');
                }}
                className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
              >
                <option value="PC Hardware">PC Hardware (RAM / Monitor / SSD)</option>
                <option value="Apparel">Apparel (Shirt / Pant / Panjabi)</option>
                <option value="Accessories">Accessories (Keyboard / Mouse)</option>
                <option value="Mobile">Mobile / Smartphone</option>
                <option value="Organic & Grocery">Organic & Grocery</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Unit Price (BDT)
              </label>
              <input
                type="number"
                value={newPrice}
                onChange={(e) => setNewPrice(Number(e.target.value))}
                required
                className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Required Purchase Attributes (Pipe <code>|</code> separated)
              </label>
              <input
                value={newReqAttrs}
                onChange={(e) => setNewReqAttrs(e.target.value)}
                placeholder="colour|size  OR  brand|ddr_type|capacity_gb|bus_speed_mhz"
                required
                className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={uploading}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold shadow-sm"
          >
            <Plus className="w-4 h-4" />
            Add Product to AI Agent RAG Catalog
          </button>
        </form>
      </div>

      {/* Active Tenant Product Catalog Table */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-bold text-slate-900">
              Active RAG Product Catalog ({products.length} Products Loaded)
            </h2>
            <p className="text-xs text-slate-500">
              When a customer names any product below on a voice call, the AI Agent automatically asks for its Required Attributes and validates them before sending to <code>storeAdapters.ts</code>
            </p>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-[11px] font-semibold uppercase text-slate-500">
                <th className="py-3 px-4">SKU & Category</th>
                <th className="py-3 px-4">Product Name (Bangla & English)</th>
                <th className="py-3 px-4">Price</th>
                <th className="py-3 px-4">Required Attributes for Purchase (AI Voice & Manual Form)</th>
                <th className="py-3 px-4">Allowed Options / Specs</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-xs">
              {products.map((p) => (
                <tr key={p.id} className="hover:bg-slate-50/80">
                  <td className="py-3 px-4">
                    <div className="font-mono font-bold text-slate-800">{p.sku}</div>
                    <span className="inline-block mt-0.5 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-100 text-slate-600">
                      {p.category}
                    </span>
                  </td>
                  <td className="py-3 px-4">
                    <div className="font-bold text-slate-900 text-sm">{p.banglaName}</div>
                    <div className="text-slate-500">{p.productName}</div>
                  </td>
                  <td className="py-3 px-4 font-bold text-slate-900">
                    ৳{p.unitPrice.toLocaleString()} {p.currency}
                  </td>
                  <td className="py-3 px-4">
                    <div className="flex flex-wrap gap-1.5">
                      {p.requiredAttributes.map((attr) => (
                        <span
                          key={attr}
                          className="px-2 py-1 rounded-md bg-indigo-50 border border-indigo-200 text-indigo-800 font-semibold text-[11px]"
                        >
                          {attributeLabels[attr] || attr}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="py-3 px-4 text-[11px] text-slate-600 max-w-xs">
                    {Object.entries(p.attributeOptions || {}).map(([k, vals]) => (
                      <div key={k} className="truncate">
                        <strong className="text-slate-800">{k}:</strong> {vals.join(', ')}
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
