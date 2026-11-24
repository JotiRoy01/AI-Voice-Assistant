import { StoreProvider } from '../../domain/types';
import { verifyHmacSignature } from '../../security/crypto';
import { NormalizedStoreOrder, StoreAdapter, StoreSyncResult } from '../interfaces';

/**
 * Helper: Safely extracts a single header string from Express's `req.headers` object.
 * - WHO CALLS THIS: `ShopifyStoreAdapter.verifyWebhookSignature`, `WooCommerceStoreAdapter.verifyWebhookSignature`, and `CustomStoreAdapter.verifyWebhookSignature`.
 * - WHERE INPUT COMES FROM: `headers` comes from the incoming HTTP request (`req.headers`), and `key` is the header name (e.g. `'x-shopify-hmac-sha256'`).
 * - PURPOSE: Node.js lowercases all HTTP header keys and allows values to be `string | string[] | undefined`. This helper normalizes any header lookup into a simple `string | undefined`.
 */
function getHeader(headers: Record<string, string | string[] | undefined>, key: string): string | undefined {
  const val = headers[key.toLowerCase()];
  return Array.isArray(val) ? val[0] : val;
}

/**
 * Helper: Splits a combined e-commerce variant string (like `"নীল / XL"`) into separate `colour` and `size` fields.
 * - WHO CALLS THIS: `ShopifyStoreAdapter.normalizeOrderPayload`.
 * - WHERE INPUT COMES FROM: The `variant_title` property inside Shopify's `line_items` array.
 * - PURPOSE: The Bangla TTS prompt builder needs separate `colour` and `size` fields so it can speak natural Bangla (e.g., "নীল রঙের পাঞ্জাবি, XL সাইজ").
 */
function parseVariantAttributes(variantTitle: string | null | undefined): {
  colour: string | null;
  size: string | null;
} {
  if (!variantTitle) return { colour: null, size: null };
  const parts = variantTitle.split('/').map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return { colour: parts[0], size: parts[1] };
  }
  return { colour: null, size: parts[0] || null };
}

class BaseStoreAdapter {
  /**
   * ============================================================================
   * CLASS DESCRIPTION: BaseStoreAdapter
   * - MEANING: A parent base class that provides shared outbound store-update logic (`confirmOrder` and `cancelOrder`) for all e-commerce platforms.
   * - WHY WE USE IT: Avoids repeating the same store confirmation/cancellation status-sync code across Shopify, WooCommerce, and Custom adapters.
   * - WHERE IT IS USED: Inherited (`extends BaseStoreAdapter`) by `ShopifyStoreAdapter`, `WooCommerceStoreAdapter`, and `CustomStoreAdapter` in this file.
   * ============================================================================
   */

  async confirmOrder(
    order: { externalOrderId: string },
    config?: Record<string, unknown> | null
  ): Promise<StoreSyncResult> {
    /**
     * METHOD DESCRIPTION: confirmOrder
     * - CALLED BY: `DtmfCallbackService.handleTelephonyEvent` (when the customer presses Key `1` on their phone) and `DtmfCallbackService.retryStoreSync` (when an admin clicks "Retry Sync" in the dashboard).
     * - INPUT SOURCE: `order` comes from the MySQL/Memory database (`repo.getOrderById`), and `config` comes from the tenant's `provider_credentials` record.
     * - PURPOSE: Pushes the "confirmed" status back to the merchant's e-commerce store API. If the store API fails (or `simulateSyncFailure` is true in tests), returns `{ success: false }` so the backend marks the order as `pending_sync` instead of losing the confirmation.
     */
    if (config?.simulateSyncFailure === true) {
      return { success: false, error: 'Simulated store API timeout during confirmOrder' };
    }
    return { success: true, providerStatus: `confirmed:${order.externalOrderId}` };
  }

  async cancelOrder(
    order: { externalOrderId: string },
    _reason: string,
    config?: Record<string, unknown> | null
  ): Promise<StoreSyncResult> {
    /**
     * METHOD DESCRIPTION: cancelOrder
     * - CALLED BY: `DtmfCallbackService.handleTelephonyEvent` (when the customer presses Key `2` and the order is not yet shipped/packed) and `DtmfCallbackService.retryStoreSync`.
     * - INPUT SOURCE: `order` comes from the database, `_reason` is the cancellation note (`"Customer pressed 2 during IVR confirmation"`), and `config` comes from `provider_credentials`.
     * - PURPOSE: Requests order cancellation in the external e-commerce store and returns whether the remote sync succeeded.
     */
    if (config?.simulateSyncFailure === true) {
      return { success: false, error: 'Simulated store API timeout during cancelOrder' };
    }
    return { success: true, providerStatus: `cancelled:${order.externalOrderId}` };
  }
}

export class ShopifyStoreAdapter extends BaseStoreAdapter implements StoreAdapter {
  /**
   * ============================================================================
   * CLASS DESCRIPTION: ShopifyStoreAdapter
   * - MEANING: The concrete adapter that understands Shopify's webhook security headers (`x-shopify-hmac-sha256`) and Shopify's order JSON structure.
   * - WHY WE USE IT: Shopify sends order data in its own proprietary format (`line_items`, `variant_title`, `total_price`). This class translates Shopify's format into FlowMind's standard `NormalizedStoreOrder`.
   * - WHERE IT IS USED: Registered under `storeAdapters['shopify']` via `createStoreAdapters()` and called by `OrderIntakeService` and `DtmfCallbackService`.
   * ============================================================================
   */
  readonly provider: StoreProvider = 'shopify';

  verifyWebhookSignature(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
    secret: string
  ): boolean {
    /**
     * METHOD DESCRIPTION: verifyWebhookSignature (Shopify)
     * - CALLED BY: `OrderIntakeService.handleOrderWebhook` (in `src/services/orderIntakeService.ts`).
     * - INPUT SOURCE: `rawBody` (unparsed HTTP body buffer) and `headers` come from `webhookRoutes.ts` (`POST /api/webhooks/orders/shopify`); `secret` is decrypted from the tenant's database credentials.
     * - PURPOSE: Computes a Base64 HMAC-SHA256 hash of `rawBody` using `secret` and compares it against Shopify's `x-shopify-hmac-sha256` header to prevent fake/spoofed order webhooks.
     */
    const sig = getHeader(headers, 'x-shopify-hmac-sha256');
    return verifyHmacSignature(rawBody, sig, secret, 'base64');
  }

  normalizeOrderPayload(body: Record<string, unknown>): NormalizedStoreOrder {
    /**
     * METHOD DESCRIPTION: normalizeOrderPayload (Shopify)
     * - CALLED BY: `OrderIntakeService.handleOrderWebhook` right after `verifyWebhookSignature` succeeds.
     * - INPUT SOURCE: `body` is the parsed JSON object from Shopify's `orders/create` webhook request (`req.body`).
     * - PURPOSE: Extracts customer name, phone number, total price, currency, and line items from Shopify's nested JSON and returns a clean `NormalizedStoreOrder` object ready to save in our database.
     */
    const customer = (body.customer as Record<string, unknown>) || {};
    const shipping = (body.shipping_address as Record<string, unknown>) || {};
    const lineItems = Array.isArray(body.line_items) ? (body.line_items as Record<string, unknown>[]) : [];

    // Developer Note: Shopify may store the customer's name inside `body.customer` or `body.shipping_address`.
    const firstName = String(customer.first_name ?? shipping.first_name ?? '').trim();
    const lastName = String(customer.last_name ?? shipping.last_name ?? '').trim();
    const customerName = `${firstName} ${lastName}`.trim() || String(body.customer_name ?? 'Customer');

    return {
      externalOrderId: String(body.name ?? body.id ?? ''),
      storeProvider: 'shopify',
      phoneRaw: (body.phone as string) || (customer.phone as string) || (shipping.phone as string) || null,
      customerName,
      totalAmount: Number(body.total_price ?? body.total ?? 0),
      currency: String(body.currency ?? 'BDT'),
      orderStatus: String(body.fulfillment_status || body.order_status || 'pending').toLowerCase(),
      consentGranted: body.consent_granted === undefined ? true : Boolean(body.consent_granted),
      items: lineItems.map((li) => {
        // Developer Note: Shopify combines colour and size into `variant_title` (e.g., "নীল / XL"). We split them here.
        const variantStr = li.variant_title ? String(li.variant_title) : null;
        const parsed = parseVariantAttributes(variantStr);
        const colourVal = li.colour ? String(li.colour) : parsed.colour;
        const sizeVal = li.size ? String(li.size) : parsed.size;
        const attrs: Record<string, string | number | null> = {};
        if (colourVal) attrs.colour = colourVal;
        if (sizeVal) attrs.size = sizeVal;
        if (Array.isArray(li.properties)) {
          for (const prop of li.properties as Record<string, unknown>[]) {
            if (prop.name && prop.value != null) {
              attrs[String(prop.name)] = String(prop.value);
            }
          }
        }
        return {
          productName: String(li.title ?? li.name ?? 'পণ্য'),
          variant: variantStr,
          colour: colourVal,
          size: sizeVal,
          quantity: Number(li.quantity ?? 1),
          unitPrice: Number(li.price ?? 0),
          sku: li.sku ? String(li.sku) : null,
          category: li.product_type ? String(li.product_type) : null,
          attributes: Object.keys(attrs).length > 0 ? attrs : null,
        };
      }),
    };
  }
}

export class WooCommerceStoreAdapter extends BaseStoreAdapter implements StoreAdapter {
  /**
   * ============================================================================
   * CLASS DESCRIPTION: WooCommerceStoreAdapter
   * - MEANING: The concrete adapter that handles WordPress WooCommerce order webhooks.
   * - WHY WE USE IT: WooCommerce signs webhooks with `x-wc-webhook-signature` and stores customer info inside `body.billing` and item attributes inside `line_items[].meta_data`.
   * - WHERE IT IS USED: Registered under `storeAdapters['woocommerce']` via `createStoreAdapters()` and used by `OrderIntakeService` and `DtmfCallbackService`.
   * ============================================================================
   */
  readonly provider: StoreProvider = 'woocommerce';

  verifyWebhookSignature(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
    secret: string
  ): boolean {
    /**
     * METHOD DESCRIPTION: verifyWebhookSignature (WooCommerce)
     * - CALLED BY: `OrderIntakeService.handleOrderWebhook`.
     * - INPUT SOURCE: `rawBody` and `headers` from `POST /api/webhooks/orders/woocommerce`; `secret` from the tenant's decrypted WooCommerce webhook secret.
     * - PURPOSE: Verifies the `x-wc-webhook-signature` header (Base64 HMAC-SHA256) to ensure the request genuinely came from the merchant's WooCommerce store.
     */
    const sig = getHeader(headers, 'x-wc-webhook-signature');
    return verifyHmacSignature(rawBody, sig, secret, 'base64');
  }

  normalizeOrderPayload(body: Record<string, unknown>): NormalizedStoreOrder {
    /**
     * METHOD DESCRIPTION: normalizeOrderPayload (WooCommerce)
     * - CALLED BY: `OrderIntakeService.handleOrderWebhook`.
     * - INPUT SOURCE: `body` is the parsed JSON payload from a WooCommerce `order.created` webhook.
     * - PURPOSE: Maps WooCommerce fields (`body.number`, `body.billing.phone`, `line_items[].meta_data`) into FlowMind's standard `NormalizedStoreOrder` format.
     */
    const billing = (body.billing as Record<string, unknown>) || {};
    const lineItems = Array.isArray(body.line_items) ? (body.line_items as Record<string, unknown>[]) : [];
    const customerName =
      `${String(billing.first_name ?? '')} ${String(billing.last_name ?? '')}`.trim() || 'Customer';

    return {
      externalOrderId: String(body.number ?? body.id ?? ''),
      storeProvider: 'woocommerce',
      phoneRaw: (billing.phone as string) || (body.phone as string) || null,
      customerName,
      totalAmount: Number(body.total ?? 0),
      currency: String(body.currency ?? 'BDT'),
      orderStatus: String(body.status ?? 'pending').toLowerCase(),
      consentGranted: body.consent_granted === undefined ? true : Boolean(body.consent_granted),
      items: lineItems.map((li) => {
        // Developer Note: WooCommerce stores product attributes (colour, size) inside a `meta_data: [{ key, value }]` array.
        const meta = Array.isArray(li.meta_data) ? (li.meta_data as Record<string, unknown>[]) : [];
        const findMeta = (key: string): string | null => {
          const hit = meta.find((m) => String(m.key ?? '').toLowerCase().includes(key));
          return hit?.value ? String(hit.value) : null;
        };
        const attrs: Record<string, string | number | null> = {};
        for (const m of meta) {
          if (m.key && m.value != null && !String(m.key).startsWith('_')) {
            attrs[String(m.key)] = String(m.value);
          }
        }
        const colourVal = li.colour ? String(li.colour) : findMeta('color') || findMeta('colour');
        const sizeVal = li.size ? String(li.size) : findMeta('size');
        if (colourVal && !attrs.colour) attrs.colour = colourVal;
        if (sizeVal && !attrs.size) attrs.size = sizeVal;
        return {
          productName: String(li.name ?? 'পণ্য'),
          variant: li.variant ? String(li.variant) : null,
          colour: colourVal,
          size: sizeVal,
          quantity: Number(li.quantity ?? 1),
          unitPrice: Number(li.price ?? li.total ?? 0),
          sku: li.sku ? String(li.sku) : null,
          attributes: Object.keys(attrs).length > 0 ? attrs : null,
        };
      }),
    };
  }
}

export class CustomStoreAdapter extends BaseStoreAdapter implements StoreAdapter {
  /**
   * ============================================================================
   * CLASS DESCRIPTION: CustomStoreAdapter
   * - MEANING: The adapter for bespoke/custom Bangladeshi e-commerce websites (Laravel, Next.js, custom PHP/Node stores) that integrate using FlowMind's direct webhook specification.
   * - WHY WE USE IT: Many local merchants use custom-built websites instead of Shopify or WooCommerce. This gives them a straightforward JSON schema and hex HMAC signature (`x-flowmind-signature: sha256=...`).
   * - WHERE IT IS USED: Registered under `storeAdapters['custom']` via `createStoreAdapters()` and invoked by `OrderIntakeService` and `DtmfCallbackService`.
   * ============================================================================
   */
  readonly provider: StoreProvider = 'custom';

  verifyWebhookSignature(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
    secret: string
  ): boolean {
    /**
     * METHOD DESCRIPTION: verifyWebhookSignature (Custom Store)
     * - CALLED BY: `OrderIntakeService.handleOrderWebhook`.
     * - INPUT SOURCE: `rawBody` and `headers` from `POST /api/webhooks/orders/custom`; `secret` from tenant credentials.
     * - PURPOSE: Validates the `x-flowmind-signature` header formatted as `sha256=<hex_hmac>`.
     */
    const sig = getHeader(headers, 'x-flowmind-signature');
    return verifyHmacSignature(rawBody, sig, secret, 'hex', 'sha256=');
  }

  normalizeOrderPayload(body: Record<string, unknown>): NormalizedStoreOrder {
    /**
     * METHOD DESCRIPTION: normalizeOrderPayload (Custom Store)
     * - CALLED BY: `OrderIntakeService.handleOrderWebhook`.
     * - INPUT SOURCE: `body` is the parsed JSON sent by a custom store or the Dashboard Simulator Test Bench.
     * - PURPOSE: Accepts camelCase or snake_case fields (`externalOrderId` or `order_id`, `customerName` or `customer_name`) and returns a standard `NormalizedStoreOrder`.
     */
    const items = Array.isArray(body.items) ? (body.items as Record<string, unknown>[]) : [];
    return {
      externalOrderId: String(body.externalOrderId ?? body.order_id ?? body.id ?? ''),
      storeProvider: 'custom',
      phoneRaw: (body.phone as string) || (body.customerPhone as string) || null,
      customerName: String(body.customerName ?? body.customer_name ?? 'Customer'),
      totalAmount: Number(body.totalAmount ?? body.total ?? 0),
      currency: String(body.currency ?? 'BDT'),
      orderStatus: String(body.orderStatus ?? body.status ?? 'pending').toLowerCase(),
      consentGranted: body.consentGranted === undefined ? true : Boolean(body.consentGranted),
      items: items.map((item) => {
        const rawAttrs =
          item.attributes && typeof item.attributes === 'object'
            ? (item.attributes as Record<string, string | number | null>)
            : {};
        const colourVal = item.colour
          ? String(item.colour)
          : item.color
          ? String(item.color)
          : rawAttrs.colour
          ? String(rawAttrs.colour)
          : null;
        const sizeVal = item.size
          ? String(item.size)
          : rawAttrs.size
          ? String(rawAttrs.size)
          : rawAttrs.screen_size_inch
          ? String(rawAttrs.screen_size_inch)
          : rawAttrs.capacity_gb
          ? String(rawAttrs.capacity_gb)
          : null;
        const mergedAttrs: Record<string, string | number | null> = { ...rawAttrs };
        if (colourVal && !mergedAttrs.colour) mergedAttrs.colour = colourVal;
        if (sizeVal && !mergedAttrs.size) mergedAttrs.size = sizeVal;
        const autoVariant =
          item.variant
            ? String(item.variant)
            : Object.entries(mergedAttrs)
                .filter(([, v]) => v != null && String(v).trim() !== '')
                .map(([k, v]) => `${k}: ${v}`)
                .join(' · ') || null;
        return {
          productName: String(item.productName ?? item.product_name ?? item.name ?? 'পণ্য'),
          variant: autoVariant,
          colour: colourVal,
          size: sizeVal,
          quantity: Number(item.quantity ?? 1),
          unitPrice: Number(item.unitPrice ?? item.unit_price ?? item.price ?? 0),
          sku: item.sku ? String(item.sku) : null,
          category: item.category ? String(item.category) : null,
          attributes: Object.keys(mergedAttrs).length > 0 ? mergedAttrs : null,
        };
      }),
    };
  }
}

/**
 * Factory Function: createStoreAdapters
 * - CALLED BY: `createAppContainer` in `src/app.ts` during server startup.
 * - PURPOSE: Instantiates all three store adapters (`shopify`, `woocommerce`, `custom`) in a dictionary so services can dynamically pick the right adapter using `this.storeAdapters[provider]`.
 */
export function createStoreAdapters(): Record<StoreProvider, StoreAdapter> {
  return {
    shopify: new ShopifyStoreAdapter(),
    woocommerce: new WooCommerceStoreAdapter(),
    custom: new CustomStoreAdapter(),
  };
}
