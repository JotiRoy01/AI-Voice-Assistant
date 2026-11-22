import crypto from 'crypto';

export interface EncryptedPayload {
  encryptedSecret: string;
  iv: string;
  authTag: string;
}

export function encryptSecret(plaintext: string, keyHex: string): EncryptedPayload {
  /**
   * FUNCTION DESCRIPTION: encryptSecret (AES-256-GCM Encryption at Rest)
   * - CALLED BY: `dashboardAndSimulatorRoutes.ts` (`PUT /api/dashboard/credentials/:provider`) and `seedData.ts`.
   * - INPUT SOURCE: `plaintext` (the merchant's Shopify/WooCommerce webhook secret) and `keyHex` (`env.ENCRYPTION_KEY_HEX`, a 64-character hex / 32-byte master key).
   * - PURPOSE: Encrypts sensitive provider secrets using authenticated AES-256-GCM with a random 12-byte Initialization Vector (`iv`) and 16-byte authentication tag (`authTag`) before storing them in the `provider_credentials` database table.
   */
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) {
    throw new Error('Encryption key must be 32 bytes (64 hex characters)');
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    encryptedSecret: encrypted.toString('base64'),
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
  };
}

export function decryptSecret(payload: EncryptedPayload, keyHex: string): string {
  /**
   * FUNCTION DESCRIPTION: decryptSecret
   * - CALLED BY: `OrderIntakeService.resolveWebhookSecret` (in `src/services/orderIntakeService.ts`).
   * - INPUT SOURCE: `payload` (`{ encryptedSecret, iv, authTag }` loaded from `provider_credentials` in the database) and `keyHex` (`env.ENCRYPTION_KEY_HEX`).
   * - PURPOSE: Decrypts the merchant's store webhook secret in memory right when a webhook arrives so `storeAdapters.ts` can verify the HMAC signature.
   */
  const key = Buffer.from(keyHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(payload.authTag, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.encryptedSecret, 'base64')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

export function computeHmacHex(rawBody: Buffer | string, secret: string): string {
  /**
   * FUNCTION DESCRIPTION: computeHmacHex
   * - CALLED BY: `verifyHmacSignature` (in this file) and `dashboardAndSimulatorRoutes.ts` (Simulator Test Bench).
   * - INPUT SOURCE: `rawBody` (raw request payload bytes) and `secret` (shared HMAC secret key).
   * - PURPOSE: Computes a lowercase hexadecimal HMAC-SHA256 digest (used by Custom stores, Asterisk callbacks, and Meta WhatsApp webhooks).
   */
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

export function computeHmacBase64(rawBody: Buffer | string, secret: string): string {
  /**
   * FUNCTION DESCRIPTION: computeHmacBase64
   * - CALLED BY: `verifyHmacSignature` (in this file) and `dashboardAndSimulatorRoutes.ts` (Simulator Test Bench).
   * - INPUT SOURCE: `rawBody` and `secret`.
   * - PURPOSE: Computes a Base64-encoded HMAC-SHA256 digest (used by Shopify `x-shopify-hmac-sha256` and WooCommerce `x-wc-webhook-signature`).
   */
  return crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
}

export function timingSafeCompare(a: string, b: string): boolean {
  /**
   * FUNCTION DESCRIPTION: timingSafeCompare
   * - CALLED BY: `verifyHmacSignature`, `verifyPassword`, and `requireInternalService` (`src/security/auth.ts`).
   * - INPUT SOURCE: Two strings `a` (user/header provided signature) and `b` (expected computed signature).
   * - PURPOSE: Uses `crypto.timingSafeEqual` so an attacker cannot guess webhook secrets or internal tokens character-by-character by measuring response time differences (timing attacks).
   */
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function verifyHmacSignature(
  rawBody: Buffer | string,
  providedSignature: string | undefined,
  secret: string,
  encoding: 'hex' | 'base64' = 'hex',
  prefix = ''
): boolean {
  /**
   * FUNCTION DESCRIPTION: verifyHmacSignature
   * - CALLED BY: `ShopifyStoreAdapter`, `WooCommerceStoreAdapter`, `CustomStoreAdapter` (in `storeAdapters.ts`), and `webhookRoutes.ts` (`/telephony/events` and `/whatsapp/messages`).
   * - INPUT SOURCE: `rawBody` (`req.rawBody` Buffer), `providedSignature` (HTTP signature header), `secret` (webhook secret), `encoding` (`'hex'` or `'base64'`), and optional `prefix` (like `'sha256='`).
   * - PURPOSE: Strips any prefix (such as `'sha256='`), computes the expected HMAC-SHA256 hash of `rawBody`, and compares them in constant time.
   */
  if (!providedSignature || !secret) return false;
  const normalizedProvided = prefix && providedSignature.startsWith(prefix)
    ? providedSignature.slice(prefix.length)
    : providedSignature;
  const expected =
    encoding === 'base64' ? computeHmacBase64(rawBody, secret) : computeHmacHex(rawBody, secret);
  return timingSafeCompare(normalizedProvided.trim(), expected);
}

export function hashPassword(password: string): string {
  /**
   * FUNCTION DESCRIPTION: hashPassword
   * - CALLED BY: `seedData.ts` when creating initial demo dashboard users.
   * - INPUT SOURCE: Plaintext `password` string.
   * - PURPOSE: Generates a random 16-byte salt and hashes the password with Node's `crypto.scryptSync` (`<salt>:<derivedKey>`).
   */
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  /**
   * FUNCTION DESCRIPTION: verifyPassword
   * - CALLED BY: `authRoutes.ts` (`POST /api/auth/login`).
   * - INPUT SOURCE: `password` entered on the login form and `storedHash` from the `users` table.
   * - PURPOSE: Re-computes the scrypt hash using the stored salt and checks if it matches in constant time.
   */
  const [salt, key] = storedHash.split(':');
  if (!salt || !key) return false;
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return timingSafeCompare(derived, key);
}
