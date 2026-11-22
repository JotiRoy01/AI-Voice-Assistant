-- ============================================================================
-- FlowMind AI — AI Voice Order Confirmation System (SRS v1.0)
-- MySQL 8.0 Initial Schema (All timestamps stored in UTC)
-- ============================================================================

CREATE TABLE IF NOT EXISTS tenants (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(160) NOT NULL,
  slug VARCHAR(80) NOT NULL UNIQUE,
  status ENUM('active', 'suspended', 'inactive') NOT NULL DEFAULT 'active',
  timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Dhaka',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(36) PRIMARY KEY,
  tenant_id VARCHAR(36) NULL,
  email VARCHAR(190) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(120) NOT NULL,
  role ENUM('super_admin', 'business_owner', 'operator') NOT NULL DEFAULT 'business_owner',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_users_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS voice_settings (
  tenant_id VARCHAR(36) PRIMARY KEY,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  language VARCHAR(16) NOT NULL DEFAULT 'bn-BD',
  voice_name VARCHAR(80) NOT NULL DEFAULT 'bn-BD-NabanitaNeural',
  call_window_start VARCHAR(5) NOT NULL DEFAULT '09:00',
  call_window_end VARCHAR(5) NOT NULL DEFAULT '21:00',
  retry_limit INT NOT NULL DEFAULT 2,
  retry_interval_minutes INT NOT NULL DEFAULT 15,
  menu_replay_limit INT NOT NULL DEFAULT 1,
  invalid_key_limit INT NOT NULL DEFAULT 2,
  eligible_statuses_json JSON NOT NULL,
  whatsapp_fallback_contact VARCHAR(120) NOT NULL DEFAULT '+8801700000000',
  tts_provider VARCHAR(40) NOT NULL DEFAULT 'local_http',
  telephony_provider VARCHAR(40) NOT NULL DEFAULT 'simulator',
  whatsapp_provider VARCHAR(40) NOT NULL DEFAULT 'simulator',
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_voice_settings_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS orders (
  id VARCHAR(36) PRIMARY KEY,
  tenant_id VARCHAR(36) NOT NULL,
  external_order_id VARCHAR(120) NOT NULL,
  store_provider ENUM('shopify', 'woocommerce', 'custom') NOT NULL DEFAULT 'custom',
  phone_e164 VARCHAR(32) NOT NULL,
  customer_name VARCHAR(160) NOT NULL,
  total_amount DECIMAL(12, 2) NOT NULL,
  currency VARCHAR(10) NOT NULL DEFAULT 'BDT',
  order_status VARCHAR(40) NOT NULL DEFAULT 'pending',
  verification_status ENUM(
    'pending',
    'ineligible',
    'queued',
    'calling',
    'confirmed',
    'cancellation_requested',
    'cancelled',
    'whatsapp_requested',
    'no_response',
    'invalid_input',
    'no_answer',
    'failed',
    'suppressed_opt_out'
  ) NOT NULL DEFAULT 'pending',
  consent_granted TINYINT(1) NOT NULL DEFAULT 1,
  store_sync_status ENUM('not_required', 'synced', 'pending_sync', 'failed') NOT NULL DEFAULT 'not_required',
  store_sync_error TEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_orders_tenant_external (tenant_id, external_order_id),
  INDEX idx_orders_tenant_status (tenant_id, verification_status),
  INDEX idx_orders_tenant_phone (tenant_id, phone_e164),
  CONSTRAINT fk_orders_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS order_items (
  id VARCHAR(36) PRIMARY KEY,
  order_id VARCHAR(36) NOT NULL,
  product_name VARCHAR(255) NOT NULL,
  variant VARCHAR(120) NULL,
  colour VARCHAR(80) NULL,
  size VARCHAR(80) NULL,
  quantity INT NOT NULL DEFAULT 1,
  unit_price DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  INDEX idx_order_items_order (order_id),
  CONSTRAINT fk_order_items_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS call_jobs (
  id VARCHAR(36) PRIMARY KEY,
  tenant_id VARCHAR(36) NOT NULL,
  order_id VARCHAR(36) NOT NULL,
  status ENUM('queued', 'scheduled', 'in_progress', 'completed', 'retry_scheduled', 'failed', 'dead_letter', 'cancelled') NOT NULL DEFAULT 'queued',
  scheduled_at DATETIME(3) NOT NULL,
  attempt_no INT NOT NULL DEFAULT 1,
  max_attempts INT NOT NULL DEFAULT 3,
  idempotency_key VARCHAR(190) NOT NULL,
  last_error TEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_call_jobs_idempotency (idempotency_key),
  INDEX idx_call_jobs_tenant_order (tenant_id, order_id),
  INDEX idx_call_jobs_status (status, scheduled_at),
  CONSTRAINT fk_call_jobs_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_call_jobs_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS voice_calls (
  id VARCHAR(36) PRIMARY KEY,
  tenant_id VARCHAR(36) NOT NULL,
  call_job_id VARCHAR(36) NOT NULL,
  order_id VARCHAR(36) NOT NULL,
  provider_call_id VARCHAR(160) NULL,
  started_at DATETIME(3) NULL,
  ended_at DATETIME(3) NULL,
  duration_sec INT NOT NULL DEFAULT 0,
  call_status ENUM('initiated', 'ringing', 'answered', 'completed', 'no_answer', 'busy', 'failed', 'cancelled') NOT NULL DEFAULT 'initiated',
  dtmf_result ENUM('1_confirm', '2_cancel', '3_whatsapp', 'no_input', 'invalid_key', 'none') NOT NULL DEFAULT 'none',
  replay_count INT NOT NULL DEFAULT 0,
  invalid_attempts INT NOT NULL DEFAULT 0,
  prompt_text TEXT NULL,
  audio_url VARCHAR(512) NULL,
  error_code VARCHAR(64) NULL,
  error_message TEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  INDEX idx_voice_calls_tenant (tenant_id, created_at),
  INDEX idx_voice_calls_order (order_id),
  INDEX idx_voice_calls_provider_id (provider_call_id),
  CONSTRAINT fk_voice_calls_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_voice_calls_job FOREIGN KEY (call_job_id) REFERENCES call_jobs(id) ON DELETE CASCADE,
  CONSTRAINT fk_voice_calls_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS order_events (
  id VARCHAR(36) PRIMARY KEY,
  tenant_id VARCHAR(36) NOT NULL,
  order_id VARCHAR(36) NOT NULL,
  call_id VARCHAR(36) NULL,
  event_type VARCHAR(80) NOT NULL,
  source VARCHAR(60) NOT NULL,
  metadata_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_order_events_order (order_id, created_at),
  INDEX idx_order_events_tenant (tenant_id, created_at),
  CONSTRAINT fk_order_events_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_order_events_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS customer_instructions (
  id VARCHAR(36) PRIMARY KEY,
  tenant_id VARCHAR(36) NOT NULL,
  order_id VARCHAR(36) NOT NULL,
  channel ENUM('whatsapp', 'manual') NOT NULL DEFAULT 'whatsapp',
  sender_phone_e164 VARCHAR(32) NOT NULL,
  message_text TEXT NOT NULL,
  provider_message_id VARCHAR(160) NULL,
  received_at DATETIME(3) NOT NULL,
  status ENUM('received', 'reviewed', 'applied', 'delivery_failed') NOT NULL DEFAULT 'received',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_instructions_tenant_order (tenant_id, order_id),
  CONSTRAINT fk_instructions_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_instructions_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS provider_credentials (
  id VARCHAR(36) PRIMARY KEY,
  tenant_id VARCHAR(36) NOT NULL,
  provider VARCHAR(60) NOT NULL,
  config_json JSON NULL,
  encrypted_secret TEXT NOT NULL,
  iv VARCHAR(64) NOT NULL,
  auth_tag VARCHAR(64) NOT NULL,
  status ENUM('active', 'disabled') NOT NULL DEFAULT 'active',
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_credentials_tenant_provider (tenant_id, provider),
  CONSTRAINT fk_credentials_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS provider_callback_dedup (
  id VARCHAR(36) PRIMARY KEY,
  tenant_id VARCHAR(36) NOT NULL,
  provider VARCHAR(60) NOT NULL,
  provider_event_id VARCHAR(190) NOT NULL,
  received_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_callback_dedup (provider, provider_event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS customer_opt_outs (
  id VARCHAR(36) PRIMARY KEY,
  tenant_id VARCHAR(36) NOT NULL,
  phone_e164 VARCHAR(32) NOT NULL,
  reason VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_opt_out_tenant_phone (tenant_id, phone_e164),
  CONSTRAINT fk_opt_outs_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
