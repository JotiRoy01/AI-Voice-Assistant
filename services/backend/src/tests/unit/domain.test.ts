import { describe, expect, it } from 'vitest';
import {
  buildOrderVerificationPrompt,
  formatBengaliAmount,
  toBengaliDigits,
} from '../../domain/banglaPrompt';
import { isWithinCallingWindow } from '../../domain/eligibility';
import { Order } from '../../domain/types';
import {
  computeHmacBase64,
  computeHmacHex,
  decryptSecret,
  encryptSecret,
  verifyHmacSignature,
} from '../../security/crypto';
import { maskPhoneNumber, normalizePhoneE164 } from '../../security/phone';

describe('Bangla Prompt Builder (SRS Section 3.1 & Appendix A)', () => {
  it('converts digits and formats BDT amounts in Bengali', () => {
    expect(toBengaliDigits('36')).toBe('৩৬');
    expect(formatBengaliAmount(1500)).toBe('১,৫০০');
    expect(formatBengaliAmount(125000)).toBe('১,২৫,০০০');
  });

  it('builds natural Bangla order summary from authoritative order record', () => {
    const order: Order = {
      id: 'ord-1',
      tenantId: 't-1',
      externalOrderId: 'DF-1001',
      storeProvider: 'shopify',
      phoneE164: '+8801711223344',
      customerName: 'Mahmudul',
      totalAmount: 1500,
      currency: 'BDT',
      orderStatus: 'pending',
      verificationStatus: 'pending',
      consentGranted: true,
      storeSyncStatus: 'not_required',
      storeSyncError: null,
      items: [
        {
          id: 'item-1',
          orderId: 'ord-1',
          productName: 'প্যান্ট',
          variant: null,
          colour: 'কালো',
          size: '36',
          quantity: 1,
          unitPrice: 1500,
        },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const prompt = buildOrderVerificationPrompt(order);
    expect(prompt.opening).toContain('আসসালামু আলাইকুম');
    expect(prompt.opening).toContain('কালো রঙের প্যান্ট');
    expect(prompt.opening).toContain('৩৬ সাইজ');
    expect(prompt.opening).toContain('১,৫০০ টাকায়');
    expect(prompt.menu).toContain('১ চাপুন');
    expect(prompt.menu).toContain('২ চাপুন');
    expect(prompt.menu).toContain('৩ চাপুন');
  });
});

describe('Phone Normalization & PII Masking (SRS Section 8.1 & 13)', () => {
  it('normalizes Bangladesh local, Bengali-digit, and international numbers to E.164', () => {
    expect(normalizePhoneE164('01711223344')).toBe('+8801711223344');
    expect(normalizePhoneE164('8801819556677')).toBe('+8801819556677');
    expect(normalizePhoneE164('+880 1911-889900')).toBe('+8801911889900');
    expect(normalizePhoneE164('০১৭১১২২৩৩৪৪')).toBe('+8801711223344');
    expect(normalizePhoneE164('invalid')).toBeNull();
  });

  it('masks phone numbers cleanly without exposing middle digits', () => {
    const masked = maskPhoneNumber('+8801711223344');
    expect(masked.startsWith('+88017')).toBe(true);
    expect(masked.endsWith('344')).toBe(true);
    expect(masked).toContain('*****');
    expect(masked).not.toContain('11223');
  });
});

describe('Crypto & Webhook HMAC Security (SRS Section 5 & 8.1)', () => {
  it('encrypts and decrypts provider secrets with AES-256-GCM', () => {
    const keyHex = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const encrypted = encryptSecret('shpss_live_secret_token_999', keyHex);
    expect(encrypted.encryptedSecret).not.toContain('shpss_live');
    expect(decryptSecret(encrypted, keyHex)).toBe('shpss_live_secret_token_999');
  });

  it('verifies hex and base64 HMAC-SHA256 signatures timing-safely', () => {
    const body = Buffer.from(JSON.stringify({ id: '123' }));
    const secret = 'my-secret';
    const hexSig = `sha256=${computeHmacHex(body, secret)}`;
    const b64Sig = computeHmacBase64(body, secret);

    expect(verifyHmacSignature(body, hexSig, secret, 'hex', 'sha256=')).toBe(true);
    expect(verifyHmacSignature(body, b64Sig, secret, 'base64')).toBe(true);
    expect(verifyHmacSignature(body, 'sha256=deadbeef', secret, 'hex', 'sha256=')).toBe(false);
  });
});

describe('Calling Window Evaluation (SRS Section 11)', () => {
  it('allows calls inside Asia/Dhaka window and defers calls outside window', () => {
    // 2026-11-18T06:00:00Z = 12:00 Asia/Dhaka (inside 09:00-21:00)
    const noonDhaka = new Date('2026-11-18T06:00:00.000Z');
    expect(isWithinCallingWindow(noonDhaka, 'Asia/Dhaka', '09:00', '21:00').within).toBe(true);

    // 2026-11-18T17:00:00Z = 23:00 Asia/Dhaka (outside 09:00-21:00)
    const nightDhaka = new Date('2026-11-18T17:00:00.000Z');
    const res = isWithinCallingWindow(nightDhaka, 'Asia/Dhaka', '09:00', '21:00');
    expect(res.within).toBe(false);
    expect(res.nextWindowUtc).toBeDefined();
  });
});
