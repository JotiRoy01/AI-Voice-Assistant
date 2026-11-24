import { ProductCatalogEntry } from '../domain/types';
import {
  ATTRIBUTE_BANGLA_LABELS,
  inferAttributesForProduct,
  ProductCatalogRagService,
} from './productCatalogRagService';

export interface GuardrailViolation {
  code:
    | 'PROMPT_INJECTION_BLOCKED'
    | 'OUT_OF_CATALOG_PRODUCT'
    | 'PRICE_HALLUCINATION_CORRECTED'
    | 'INVALID_ATTRIBUTE_OPTION'
    | 'PREMATURE_CONFIRMATION_MISSING_SPECS'
    | 'PREMATURE_CONFIRMATION_UNVERIFIED_ADDRESS'
    | 'UNAUTHORIZED_DISCOUNT_HALLUCINATION'
    | 'SPOKEN_PRICE_MISMATCH_CORRECTED';
  severity: 'low' | 'medium' | 'high';
  field: string;
  message: string;
  suggestedReplyBangla?: string;
}

export interface GroundedDraftOrderItem {
  sku?: string;
  category?: string;
  productName: string;
  quantityText: string | null;
  quantityNum: number;
  unitPrice: number;
  requiredAttributes: string[];
  collectedAttributes: Record<string, string>;
  missingAttributes: string[];
}

const BANGLA_DIGIT_MAP: Record<string, string> = {
  '০': '0',
  '১': '1',
  '২': '2',
  '৩': '3',
  '৪': '4',
  '৫': '5',
  '৬': '6',
  '৭': '7',
  '৮': '8',
  '৯': '9',
};

const ASCII_TO_BANGLA_MAP: Record<string, string> = {
  '0': '০',
  '1': '১',
  '2': '২',
  '3': '৩',
  '4': '৪',
  '5': '৫',
  '6': '৬',
  '7': '৭',
  '8': '৮',
  '9': '৯',
};

function toAsciiDigits(text: string): string {
  return text.replace(/[০-৯]/g, (d) => BANGLA_DIGIT_MAP[d] ?? d);
}

function toBanglaDigits(num: number): string {
  return String(Math.round(num)).replace(/[0-9]/g, (d) => ASCII_TO_BANGLA_MAP[d] ?? d);
}

function normalizeToken(val: string): string {
  return toAsciiDigits(val)
    .toLowerCase()
    .replace(/[\s\-_()]+/g, '')
    .trim();
}

/**
 * Dedicated Anti-Hallucination & Guardrail Service for the Node.js Conversational Voice Agent.
 * Mirrors the Python `services/ai-agent/app/guardrails/` architecture:
 *  1. Pre-LLM prompt-injection & price-tampering shield (`checkInput`)
 *  2. Catalog SKU/Price grounding & `attributeOptions` whitelist enforcement (`groundAndValidateItems`)
 *  3. Post-LLM confirmation gates, discount blocker & spoken BDT price fact-checker (`verifyOutput`)
 */
export class GuardrailService {
  private readonly promptInjectionPatterns: RegExp[] = [
    /ignore\s+(?:all\s+)?(?:previous|prior|system)\s+instructions/i,
    /system\s*prompt|developer\s*mode|jailbreak/i,
    /set\s+(?:the\s+)?(?:unit[_\s]?price|price|total)\s*(?:to|=)\s*0\b/i,
    /দাম\s*(?:০|0|শূন্য|ফ্রি)\s*(?:টাকা)?\s*(?:করো|করে\s*দাও|ধরো)/i,
    /আগের\s*সব\s*নির্দেশনা\s*ভুলে\s*যাও/i,
  ];

  checkInput(userText: string): GuardrailViolation | null {
    const cleaned = (userText || '').trim();
    if (!cleaned) return null;

    for (const pattern of this.promptInjectionPatterns) {
      if (pattern.test(cleaned)) {
        return {
          code: 'PROMPT_INJECTION_BLOCKED',
          severity: 'high',
          field: 'userText',
          message: 'Blocked attempt to override system instructions or manipulate catalog pricing.',
          suggestedReplyBangla:
            'দুঃখিত, পণ্যের নির্ধারিত মূল্য বা সিস্টেমের নিয়ম পরিবর্তন করা সম্ভব নয়। আপনি কোন পণ্যটি অর্ডার করতে চাচ্ছেন বলুন?',
        };
      }
    }
    return null;
  }

  matchAllowedOption(rawVal: string, allowedOptions?: string[]): string | null {
    if (!allowedOptions || allowedOptions.length === 0) {
      return rawVal.trim();
    }
    const candidate = toAsciiDigits(rawVal).trim();
    const candNorm = normalizeToken(candidate);
    if (!candNorm) return null;

    // 1. Exact normalized match
    for (const opt of allowedOptions) {
      if (normalizeToken(opt) === candNorm) return opt;
    }

    // 2. Sub-token match (e.g. 'কালো (Black)' -> ['কালো', 'black'])
    for (const opt of allowedOptions) {
      const subTokens = toAsciiDigits(opt)
        .split(/[()/|,;\s]+/)
        .map((t) => normalizeToken(t))
        .filter(Boolean);
      if (subTokens.includes(candNorm)) return opt;
    }

    // 3. Unambiguous numeric match (e.g. '16' -> '16GB', '3200' -> '3200MHz')
    const candDigits = candidate.match(/\d+/g);
    if (candDigits && candDigits.length === 1) {
      const targetNum = candDigits[0];
      const numMatches = allowedOptions.filter((opt) => {
        const optDigits = toAsciiDigits(opt).match(/\d+/g);
        return optDigits && optDigits.length === 1 && optDigits[0] === targetNum;
      });
      if (numMatches.length === 1) return numMatches[0];
    }

    // 4. Unambiguous substring match
    const partialMatches = allowedOptions.filter((opt) => {
      const optNorm = normalizeToken(opt);
      return (
        (candNorm.length >= 2 && optNorm.includes(candNorm)) ||
        (optNorm.length >= 2 && candNorm.includes(optNorm))
      );
    });
    if (partialMatches.length === 1) return partialMatches[0];

    return null;
  }

  groundAndValidateItems(params: {
    tenantId: string;
    catalogRagService: ProductCatalogRagService;
    rawProducts: {
      name: string;
      qtyText?: string;
      qtyNum?: number;
      unitPrice?: number;
      attributes?: Record<string, string>;
    }[];
    existingItems: GroundedDraftOrderItem[];
  }): { items: GroundedDraftOrderItem[]; violations: GuardrailViolation[] } {
    const violations: GuardrailViolation[] = [];
    const previousByProduct = new Map(
      params.existingItems.map((d) => [d.productName.toLowerCase(), d])
    );

    const items: GroundedDraftOrderItem[] = params.rawProducts.map((p) => {
      const catMatch: ProductCatalogEntry | undefined = params.catalogRagService.searchProducts(
        params.tenantId,
        p.name,
        1
      )[0];
      const inferred = inferAttributesForProduct(p.name);
      const reqAttrs = catMatch ? catMatch.requiredAttributes : inferred.requiredAttributes;
      const allowedOptionsMap = catMatch ? catMatch.attributeOptions : inferred.attributeOptions;
      const resolvedName = catMatch ? catMatch.banglaName || catMatch.productName : p.name;
      const catalogPrice = catMatch ? catMatch.unitPrice : p.unitPrice || 1200;

      if (catMatch && p.unitPrice != null && Math.abs(Number(p.unitPrice) - catMatch.unitPrice) > 1) {
        violations.push({
          code: 'PRICE_HALLUCINATION_CORRECTED',
          severity: 'medium',
          field: `${catMatch.sku}.unitPrice`,
          message: `LLM output unitPrice=${p.unitPrice}, grounded to catalog unitPrice=${catMatch.unitPrice} BDT.`,
        });
      }

      const prevItem =
        previousByProduct.get(p.name.toLowerCase()) ||
        (catMatch ? previousByProduct.get(catMatch.banglaName.toLowerCase()) : undefined);

      const mergedAttrs: Record<string, string> = {
        ...(prevItem?.collectedAttributes || {}),
      };

      if (p.attributes && typeof p.attributes === 'object') {
        for (const [k, rawV] of Object.entries(p.attributes)) {
          if (rawV == null) continue;
          const valStr = String(rawV).trim();
          if (!valStr || ['null', 'none', 'unknown', '?'].includes(valStr.toLowerCase())) {
            continue;
          }
          const allowedForAttr = allowedOptionsMap?.[k];
          if (allowedForAttr && allowedForAttr.length > 0) {
            const canonical = this.matchAllowedOption(valStr, allowedForAttr);
            if (!canonical) {
              const bnLabel = ATTRIBUTE_BANGLA_LABELS[k] || k;
              violations.push({
                code: 'INVALID_ATTRIBUTE_OPTION',
                severity: 'high',
                field: `${resolvedName}.${k}`,
                message: `Invalid option '${valStr}' for ${k}. Allowed: ${allowedForAttr.join(', ')}`,
                suggestedReplyBangla: `দুঃখিত, ${resolvedName}-এর ${bnLabel} হিসেবে '${valStr}' আমাদের স্টকে নেই। আমাদের কাছে রয়েছে: ${allowedForAttr.join(', ')}। এর মধ্যে কোনটি নিবেন?`,
              });
              delete mergedAttrs[k];
              continue;
            }
            mergedAttrs[k] = canonical;
          } else {
            mergedAttrs[k] = valStr;
          }
        }
      }

      const missingAttrs = reqAttrs.filter((r: string) => !mergedAttrs[r] || !mergedAttrs[r].trim());

      return {
        sku: catMatch?.sku || 'CUSTOM-REQ',
        category: catMatch?.category || inferred.category,
        productName: resolvedName,
        quantityText: p.qtyText || '১টি',
        quantityNum: Math.max(1, p.qtyNum || 1),
        unitPrice: catalogPrice,
        requiredAttributes: reqAttrs,
        collectedAttributes: mergedAttrs,
        missingAttributes: missingAttrs,
      };
    });

    return { items, violations };
  }

  verifyOutput(params: {
    replyBangla: string;
    confirmed: boolean;
    stageBadge: string;
    draftItems: GroundedDraftOrderItem[];
    hasCapturedAddress: boolean;
    deliveryAddress: string;
    userWantsToChangeAddress: boolean;
    existingViolations: GuardrailViolation[];
  }): {
    replyBangla: string;
    confirmed: boolean;
    stageBadge: string;
    violations: GuardrailViolation[];
  } {
    const violations = [...params.existingViolations];
    let reply = (params.replyBangla || '').trim();
    let confirmed = params.confirmed;
    let stageBadge = params.stageBadge;

    // 1. High-severity invalid option violation
    const optionViolation = violations.find(
      (v) => v.code === 'INVALID_ATTRIBUTE_OPTION' && v.suggestedReplyBangla
    );
    if (optionViolation && optionViolation.suggestedReplyBangla) {
      return {
        replyBangla: optionViolation.suggestedReplyBangla,
        confirmed: false,
        stageBadge: 'GUARDRAIL · OPTION CHECK',
        violations,
      };
    }

    // 2. Missing required attributes confirmation guard
    const itemsWithMissingSpecs = params.draftItems.filter(
      (i) => i.missingAttributes && i.missingAttributes.length > 0
    );
    if (confirmed && itemsWithMissingSpecs.length > 0) {
      confirmed = false;
      stageBadge = 'COLLECTING SPECS';
      const missingDescriptions = itemsWithMissingSpecs
        .map((i) => {
          const labels = (i.missingAttributes || []).map(
            (attr) => ATTRIBUTE_BANGLA_LABELS[attr] || attr
          );
          return `${i.productName}-এর জন্য ${labels.join(', ')}`;
        })
        .join(' এবং ');
      reply = `অর্ডারটি কনফার্ম করার আগে অনুগ্রহ করে বলুন: ${missingDescriptions} কী চাচ্ছেন?`;
      violations.push({
        code: 'PREMATURE_CONFIRMATION_MISSING_SPECS',
        severity: 'high',
        field: 'confirmed',
        message: `Blocked premature confirmation with missing specs: ${missingDescriptions}`,
        suggestedReplyBangla: reply,
      });
    }

    // 3. Unverified delivery address confirmation guard
    if (confirmed && !params.hasCapturedAddress && !params.userWantsToChangeAddress) {
      confirmed = false;
      stageBadge = 'ITEMS AND DELIVERY';
      const itemsSummary = params.draftItems
        .map((i) => `${i.productName} (${i.quantityText || '১টি'})`)
        .join(' এবং ');
      reply = `${itemsSummary} নোট করেছি। অর্ডারটি কনফার্ম করার আগে বলুন, ডেলিভারি কি আপনার আগের ঠিকানায় (${params.deliveryAddress}) নিবেন, নাকি নতুন কোনো ঠিকানায় পাঠাবো?`;
      violations.push({
        code: 'PREMATURE_CONFIRMATION_UNVERIFIED_ADDRESS',
        severity: 'high',
        field: 'hasCapturedAddress',
        message: 'Blocked confirmation before delivery address verification.',
        suggestedReplyBangla: reply,
      });
    }

    // 4. Unauthorized discount hallucination guard
    const discountRegex =
      /(\d+\s*%\s*(?:ছাড়|ছাড়|ডিসকাউন্ট|discount)|ফ্রি\s*গিফট|বিনামূল্যে\s*ডেলিভারি)/gi;
    if (reply && discountRegex.test(reply)) {
      reply = reply.replace(discountRegex, 'নির্ধারিত মূল্যে');
      violations.push({
        code: 'UNAUTHORIZED_DISCOUNT_HALLUCINATION',
        severity: 'medium',
        field: 'replyBangla',
        message: 'Stripped unauthorized discount or free gift hallucination.',
      });
    }

    // 5. Spoken BDT price fact-checker
    if (reply && params.draftItems.length > 0) {
      const deterministicTotal = Math.round(
        params.draftItems.reduce((acc, i) => acc + i.quantityNum * i.unitPrice, 0)
      );
      const validAmounts = new Set<number>([deterministicTotal]);
      for (const item of params.draftItems) {
        validAmounts.add(Math.round(item.unitPrice));
        validAmounts.add(Math.round(item.quantityNum * item.unitPrice));
      }

      const priceRegex = /([০-৯0-9]{3,6}(?:,[০-৯0-9]{3})*)\s*(?:টাকা|taka|bdt)/gi;
      reply = reply.replace(priceRegex, (fullMatch, rawNum: string) => {
        const asciiNum = Number(toAsciiDigits(rawNum).replace(/,/g, ''));
        if (!Number.isNaN(asciiNum) && asciiNum >= 100 && !validAmounts.has(asciiNum)) {
          violations.push({
            code: 'SPOKEN_PRICE_MISMATCH_CORRECTED',
            severity: 'medium',
            field: 'replyBangla',
            message: `Corrected hallucinated spoken price ${asciiNum} BDT to ${deterministicTotal} BDT.`,
          });
          return fullMatch.replace(rawNum, toBanglaDigits(deterministicTotal));
        }
        return fullMatch;
      });
    }

    return { replyBangla: reply, confirmed, stageBadge, violations };
  }
}
