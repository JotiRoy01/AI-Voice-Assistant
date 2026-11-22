import path from 'path';
import dotenv from 'dotenv';
import { z } from 'zod';

// Load .env from both services/backend/.env AND root workspace .env
dotenv.config({ path: path.resolve(process.cwd(), '.env') });
dotenv.config({ path: path.resolve(process.cwd(), '../../.env') });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATA_STORE: z.enum(['mysql', 'memory']).default('memory'),
  QUEUE_MODE: z.enum(['bullmq', 'inline']).default('inline'),
  ORCHESTRATION_MODE: z.enum(['n8n', 'direct']).default('direct'),
  SIMULATOR_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() === 'true'),

  JWT_SECRET: z.string().min(16).default('flowmind-dev-jwt-secret-change-in-production-32ch'),
  INTERNAL_SERVICE_TOKEN: z.string().min(8).default('flowmind-internal-service-token-change-me'),
  ENCRYPTION_KEY_HEX: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY_HEX must be 64 hex chars (32 bytes)')
    .default('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'),

  DEFAULT_SHOPIFY_WEBHOOK_SECRET: z.string().default('shopify-demo-webhook-secret'),
  DEFAULT_WOOCOMMERCE_WEBHOOK_SECRET: z.string().default('woo-demo-webhook-secret'),
  DEFAULT_CUSTOM_WEBHOOK_SECRET: z.string().default('custom-demo-webhook-secret'),
  TELEPHONY_WEBHOOK_SECRET: z.string().default('telephony-callback-hmac-secret'),
  WHATSAPP_APP_SECRET: z.string().default('whatsapp-app-hmac-secret'),
  WHATSAPP_VERIFY_TOKEN: z.string().default('flowmind-whatsapp-verify-token'),

  MYSQL_HOST: z.string().default('localhost'),
  MYSQL_PORT: z.coerce.number().int().default(3306),
  MYSQL_DATABASE: z.string().default('flowmind_voice'),
  MYSQL_USER: z.string().default('flowmind'),
  MYSQL_PASSWORD: z.string().default('flowmind_secret_password'),

  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().int().default(6379),
  REDIS_PASSWORD: z.string().optional(),
  CALL_WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),
  CALL_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
  CALL_RATE_LIMIT_DURATION_MS: z.coerce.number().int().positive().default(60000),

  N8N_WEBHOOK_URL: z.string().default('http://localhost:5678/webhook/flowmind-call-trigger'),

  TTS_SERVICE_URL: z.string().default('http://localhost:8000'),
  TTS_PROVIDER: z.enum(['local_http', 'mock']).default('local_http'),
  TTS_DEFAULT_VOICE: z.string().default('bn-BD-PradeepNeural'),

  TELEPHONY_PROVIDER: z.enum(['simulator', 'asterisk_ari', 'twilio']).default('simulator'),
  ASTERISK_ARI_URL: z.string().default('http://localhost:8088/ari'),
  ASTERISK_ARI_USER: z.string().default('flowmind'),
  ASTERISK_ARI_PASSWORD: z.string().default('flowmind_ari_secret'),
  ASTERISK_SIP_TRUNK: z.string().default('bd-sip-trunk'),
  ASTERISK_CALLER_ID: z.string().default('+8809600000000'),
  PUBLIC_CALLBACK_BASE_URL: z.string().default('http://localhost:4000'),

  TWILIO_ACCOUNT_SID: z.string().default(''),
  TWILIO_AUTH_TOKEN: z.string().default(''),
  TWILIO_FROM_NUMBER: z.string().default(''),

  // LLM API keys & Local Ollama settings loaded from .env
  GEMINI_API_KEY: z.string().default(''),
  GROQ_API_KEY: z.string().default(''),
  OPENAI_API_KEY: z.string().default(''),
  OLLAMA_BASE_URL: z.string().default('http://localhost:11434'),
  OLLAMA_MODEL: z.string().default('qwen2.5:7b'),

  WHATSAPP_PROVIDER: z.enum(['simulator', 'meta_cloud']).default('simulator'),
  WHATSAPP_PHONE_NUMBER_ID: z.string().default(''),
  WHATSAPP_ACCESS_TOKEN: z.string().default(''),
  WHATSAPP_BUSINESS_NUMBER: z.string().default('+8801700000000'),
  WHATSAPP_API_VERSION: z.string().default('v21.0'),

  CORS_ORIGINS: z.string().default('http://localhost:3000,http://127.0.0.1:3000'),
});

export type AppEnv = z.infer<typeof envSchema>;

export function loadEnv(overrides: Partial<Record<string, string>> = {}): AppEnv {
  return envSchema.parse({ ...process.env, ...overrides });
}

export const env: AppEnv = loadEnv();
