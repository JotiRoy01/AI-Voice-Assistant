# FlowMind AI — AI Voice Order Confirmation System (SRS v1.0)

Production-ready, multi-tenant, low-cost automated Bangla IVR/DTMF order confirmation platform built strictly to the **FlowMind AI SRS & Technical Architecture Document v1.0**.

> **Core Workflow:** `Order Created (Signed Webhook) → Node.js Authoritative Backend → MySQL + Redis/BullMQ → Self-Hosted n8n → Bangla TTS (Cached) → Asterisk/SIP Outbound Call → DTMF 1/2/3 → Store Update + WhatsApp Custom Requirement Capture + Dashboard`

---

## 1. Architecture Overview

```text
E-commerce Store (Shopify / WooCommerce / Custom)
        │ Signed Order-Created Webhook (HMAC-SHA256)
        ▼
Node.js + Express API (TypeScript — Source of Truth) ────► MySQL 8 (9+ Tenant-Isolated Tables)
        │
        ▼
Redis + BullMQ Durable Queue (Concurrency, Rate Limits, Exponential Backoff, DLQ)
        │
        ▼
Self-Hosted n8n Workflow (or Direct Worker Adapter)
        ├────► Bangla TTS Microservice (FastAPI + Edge-TTS/Piper/gTTS + SHA-256 Disk Cache)
        ▼
Telephony Adapter (Asterisk ARI + PJSIP Trunk  |  Zero-Cost Local Simulator)
        │                                             ▲
        └────► Customer Phone (Bangla Prompt + DTMF 1/2/3) ────┘
                                                      │ Signed Call & DTMF Callbacks
                                                      ▼
                                         Node.js DTMF Result Handler
                                         ├── 1: Confirm Order (Store Sync + Pending-Sync Recovery)
                                         ├── 2: Cancel Request (Enforces Store Fulfilment Rules)
                                         └── 3: WhatsApp Deep Link / Cloud API
                                                        │ Inbound WhatsApp Webhook
                                                        ▼
                                            MySQL + Next.js Admin Dashboard
```

### Key Architectural Guarantees (SRS Section 18)
- **Node.js is the single source of truth**: n8n orchestrates asynchronous steps via authenticated `/api/internal/*` endpoints and never makes unvalidated direct database writes.
- **No STT/LLM overhead in v1.0**: Uses deterministic Bangla TTS (cached by SHA-256 hash) + RFC 4733 DTMF keypad capture (`1`, `2`, `3`), eliminating per-minute LLM/STT API spend.
- **Replaceable Provider Adapters**: Clean interfaces for `StoreAdapter` (Shopify, WooCommerce, Custom), `TtsAdapter` (Local HTTP Bangla TTS, Mock), `TelephonyAdapter` (Asterisk ARI + SIP, Simulator), and `WhatsAppAdapter` (Meta Cloud API v21.0, Simulator).
- **Strict Tenant Isolation & Security**:
  - AES-256-GCM encrypted provider credentials at rest (`provider_credentials`)
  - Timing-safe HMAC-SHA256 verification on store, telephony, and WhatsApp webhooks
  - Phone numbers normalized to E.164 (`+880...`) and masked in logs & dashboard views (`+88017*****344`)
  - UTC timestamps in DB rendered in tenant timezone (`Asia/Dhaka`)
  - Idempotent order intake (`tenant_id + external_order_id`), call jobs (`idempotency_key`), and provider callbacks (`provider + provider_event_id`)

---

## 2. Repository Structure

```text
AI-Voice-Assistant/
├── docker-compose.yml                         # Full stack: MySQL, Redis, n8n, Bangla TTS, Backend, Worker, Dashboard, Asterisk
├── .env.example                               # Complete environment configuration reference
├── services/
│   ├── backend/                               # Node.js + TypeScript + Express + BullMQ + MySQL2
│   │   ├── migrations/001_initial_schema.sql  # All 9 SRS tables + callback dedup + opt-outs + RBAC users
│   │   ├── src/
│   │   │   ├── domain/                        # Bangla prompt builder (Appendix A), eligibility, DTMF state machine
│   │   │   ├── adapters/                      # Store, TTS, Telephony (Asterisk ARI / Sim), WhatsApp (Meta / Sim)
│   │   │   ├── db/                            # MySQL repository + Memory repository (zero-dep tests/dev)
│   │   │   ├── queue/                         # BullMQ + Redis worker & DLQ + Inline dev queue
│   │   │   ├── security/                      # AES-256-GCM crypto, HMAC, E.164/masking, RBAC JWT auth
│   │   │   ├── services/                      # Order intake, voice execution, DTMF callbacks, WhatsApp linking
│   │   │   └── routes/                        # All SRS Section 9 REST endpoints + Dashboard & Simulator routes
│   │   └── src/tests/                         # Unit tests + all 12 SRS Section 15 acceptance scenarios
│   ├── tts/                                   # Python FastAPI Bangla TTS service (Edge-TTS / Piper / gTTS + SHA-256 cache)
│   └── dashboard/                             # Next.js 15 + Tailwind CSS Admin Console (all SRS Section 14 pages + Test Bench)
├── n8n/
│   └── workflows/flowmind-voice-confirmation.json  # Importable n8n workflow (SRS Section 10)
├── asterisk/
│   ├── Dockerfile                             # Asterisk 20 container
│   ├── config/                                # pjsip.conf, extensions.conf (Bangla IVR), ari.conf, http.conf
│   └── agi/flowmind-callback.sh               # HMAC-SHA256 signed callback script to Node.js
└── docs/
    └── MEETING_BRIEF_NOV22.md                 # Executive walkthrough, demo script, BD telecom & cost Q&A
```

---

## 3. Quick Start

### Option A: Full Production Stack via Docker Compose (Recommended)
```bash
cp .env.example .env
docker compose up --build -d
```
- **Dashboard:** http://localhost:3000
- **Backend API Health:** http://localhost:4000/api/health
- **Bangla TTS Service:** http://localhost:8000/health
- **n8n Orchestrator:** http://localhost:5678 (import `n8n/workflows/flowmind-voice-confirmation.json`)
- **Optional Asterisk PBX:** `docker compose --profile telephony up --build -d`

### Option B: Fast Local Dev Mode (Zero Docker Required — Great for Laptop Demos)
1. **Start Backend (in-memory seeded demo store + inline queue):**
   ```bash
   cd services/backend
   npm install
   npm run dev
   ```
2. **Start Bangla TTS Microservice (real neural Bangladeshi Bangla audio):**
   ```bash
   cd services/tts
   python -m venv .venv
   .venv\Scripts\activate      # Windows PowerShell
   pip install -r requirements.txt
   uvicorn app.main:app --host 0.0.0.0 --port 8000
   ```
3. **Start Next.js Admin Dashboard:**
   ```bash
   cd services/dashboard
   npm install
   npm run dev
   ```
4. Open **http://localhost:3000** and click any demo account (e.g., `admin@flowmind.ai` / `FlowMind@2026`).

---

## 4. Running Automated Tests (SRS Section 15 QA Suite)

```bash
cd services/backend
npm test
```
Verifies unit tests + all 12 SRS Section 15 scenarios (valid webhook, deduplication, DTMF 1/2/3, fulfillment cancel protection, no-input replay, invalid-key limit, no-answer retry scheduling, stale/cancelled order guard, duplicate callback deduplication, WhatsApp order matching, cross-tenant denial, invalid HMAC rejection, opt-out suppression, and pending store-sync recovery).

---

## 5. API Reference (SRS Section 9)

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /api/webhooks/orders/:provider` | HMAC-SHA256 | Receive & validate Shopify/WooCommerce/Custom order webhooks |
| `POST /api/voice/jobs` | `X-Internal-Token` | Create authenticated internal call job |
| `GET /api/voice/calls/:id` | Bearer JWT | Retrieve tenant-scoped call attempt result |
| `POST /api/webhooks/telephony/events` | `X-Telephony-Signature` | Receive call lifecycle & DTMF 1/2/3/timeout/invalid callbacks |
| `GET/POST /api/webhooks/whatsapp/messages` | Meta Verify / `X-Hub-Signature-256` | Meta webhook verification & inbound customer instructions |
| `GET /api/orders/:id/voice-history` | Bearer JWT | Retrieve order verification history, audit timeline & WhatsApp replies |
| `PATCH /api/voice/settings` | Bearer JWT (Admin/Owner) | Update tenant enablement, voice, call window & retry rules |
| `POST /api/voice/orders/:id/retry` | Bearer JWT | Request permitted manual retry |

---

## 6. Zero-Cost Boundary & Bangladesh Telecom Caveat (SRS Section 7 & Appendix B)

All software layers (**Node.js, MySQL, Redis/BullMQ, n8n, Asterisk, Piper/Edge-TTS, Next.js**) are self-hostable with zero per-seat SaaS fees. However, **placing automatic outbound calls to public mobile numbers in Bangladesh requires a licensed IPTSP / SIP trunk carrier or authorized GSM gateway**, which incurs per-minute telecom termination charges (illustrative estimate ~0.60 BDT/min tracked transparently in the Usage dashboard) and BTRC/caller-ID compliance approval prior to commercial rollout.


# Run the application
```
npm run dev:backend
npm run dev:dashboard
```