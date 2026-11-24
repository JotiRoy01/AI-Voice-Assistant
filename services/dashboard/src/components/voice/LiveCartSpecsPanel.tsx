'use client';

import React from 'react';
import { AlertTriangle, CheckCircle2, Package, ShieldCheck, Zap } from 'lucide-react';
import {
  RealtimeDraftItem,
  RealtimeGuardrailReport,
  SpeculativeProductMatch,
} from '@/lib/realtime/dataChannelProtocol';

interface LiveCartSpecsPanelProps {
  speculativeProducts: SpeculativeProductMatch[];
  draftItems: RealtimeDraftItem[];
  guardrailReport: RealtimeGuardrailReport;
  confirmed: boolean;
}

export function LiveCartSpecsPanel(props: LiveCartSpecsPanelProps) {
  return (
    <div className="space-y-4">
      {/* Anti-Hallucination Guardrail Telemetry Card */}
      <div
        className={`rounded-2xl border p-4 ${
          props.guardrailReport.passed
            ? 'border-emerald-800/60 bg-emerald-950/20'
            : 'border-amber-700/70 bg-amber-950/30'
        }`}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {props.guardrailReport.passed ? (
              <ShieldCheck className="h-4 w-4 text-emerald-400" />
            ) : (
              <AlertTriangle className="h-4 w-4 text-amber-400" />
            )}
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-200">
              Anti-Hallucination Guardrails
            </h4>
          </div>
          <span
            className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${
              props.guardrailReport.passed
                ? 'bg-emerald-500/20 text-emerald-300'
                : 'bg-amber-500/20 text-amber-300'
            }`}
          >
            {props.guardrailReport.passed ? 'PASSED' : `${props.guardrailReport.violations.length} CAUGHT`}
          </span>
        </div>
        {props.guardrailReport.violations.length > 0 && (
          <ul className="mt-2 space-y-1">
            {props.guardrailReport.violations.map((v, idx) => (
              <li key={idx} className="text-xs text-amber-200/90">
                <span className="font-mono font-semibold text-amber-300">{v.code}</span>: {v.message}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Speculative RAG Pre-Fetch Card (Lights up WHILE customer is still speaking!) */}
      {props.speculativeProducts.length > 0 && (
        <div className="rounded-2xl border border-sky-700/60 bg-sky-950/25 p-4">
          <div className="flex items-center gap-2 mb-2">
            <Zap className="h-4 w-4 text-sky-400" />
            <h4 className="text-xs font-bold uppercase tracking-wider text-sky-300">
              Speculative RAG Pre-Fetch (Live While Speaking)
            </h4>
          </div>
          <div className="space-y-2">
            {props.speculativeProducts.map((sp) => (
              <div
                key={sp.sku}
                className="rounded-xl bg-slate-950/70 border border-sky-800/50 p-3 text-xs"
              >
                <div className="flex items-center justify-between font-semibold text-slate-100">
                  <span>
                    {sp.bangla_name} ({sp.product_name})
                  </span>
                  <span className="text-sky-300">{sp.unit_price} BDT</span>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {sp.required_attributes.map((attr) => (
                    <span
                      key={attr}
                      className="px-2 py-0.5 rounded-md bg-sky-900/50 text-sky-200 border border-sky-700/50 text-[10px]"
                    >
                      req: {attr}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Confirmed / Draft Shopping Cart & Dynamic Product Attributes */}
      <div className="rounded-2xl border border-slate-800 bg-slate-950/90 p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Package className="h-4 w-4 text-indigo-400" />
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-200">
              Live Cart &amp; Required Specifications
            </h4>
          </div>
          {props.confirmed && (
            <span className="flex items-center gap-1 text-[11px] font-semibold text-emerald-300 bg-emerald-950/70 border border-emerald-700/60 px-2 py-0.5 rounded-full">
              <CheckCircle2 className="h-3 w-3" />
              Saved to storeAdapters.ts
            </span>
          )}
        </div>

        {props.draftItems.length === 0 ? (
          <p className="text-xs text-slate-500">
            No products in cart yet. Mention any item from your uploaded catalog (Shirt, Panjabi, RAM, Monitor, Phone, Mouse, Keyboard)...
          </p>
        ) : (
          <div className="space-y-3">
            {props.draftItems.map((item, idx) => (
              <div
                key={`${item.sku}-${idx}`}
                className="rounded-xl border border-slate-800 bg-slate-900/60 p-3 space-y-2"
              >
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-slate-100">
                    {item.product_name} · {item.quantity_text}
                  </span>
                  <span className="font-mono text-emerald-300 font-semibold">
                    {item.quantity * item.unit_price} BDT
                  </span>
                </div>

                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(item.collected_attributes || {}).map(([k, v]) => (
                    <span
                      key={k}
                      className="px-2 py-0.5 rounded-full text-[11px] bg-emerald-950/80 border border-emerald-700/60 text-emerald-200"
                    >
                      {k}: <strong>{v}</strong>
                    </span>
                  ))}
                  {(item.missing_attributes || []).map((m) => (
                    <span
                      key={m}
                      className="px-2 py-0.5 rounded-full text-[11px] bg-amber-950/70 border border-amber-700/60 text-amber-200"
                    >
                      missing: {m}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
