# FlowMind AI — November 22 Technical Discussion & Demo Brief

Prepared for the **November 22** engineering & leadership review of the **FlowMind AI — AI Voice Order Confirmation System (SRS v1.0)**.

---

## 1. 5-Minute Live Demo Script (Zero Carrier Cost, Real Pipeline)

1. **Show Architecture & Discipline (30s)**
   - Explain why v1.0 strictly uses **Bangla TTS + DTMF 1/2/3** instead of an LLM/STT conversational voice agent: deterministic accuracy on order totals/variants, near-zero AI inference cost, <200ms keypad response, and full compliance with SRS Section 1.2 & 18.
2. **Sign In & Show Multi-Tenant Isolation (45s)**
   - Open `http://localhost:3000`. Sign in as **Super Admin** (`admin@flowmind.ai`), switch between **Desh Fashion BD** and **Dhaka Organic Store** to show isolated data, masked phones (`+88017*****344`), and Asia/Dhaka localized timestamps.
3. **Live Order-to-Call Walkthrough via Test Bench (`/simulator`) (2m)**
   - Keep the pre-filled SRS Section 3.1 order (`কালো রঙের প্যান্ট, ৩৬ সাইজ, ১,৫০০ টাকা`) and click **Send Signed Order Webhook & Initiate Call**.
   - Play the real neural Bangla TTS audio (`bn-BD-NabanitaNeural`) generated & SHA-256 cached by `services/tts`.
   - Demonstrate **Key 1 (Confirm)** → show order transitioning to `confirmed` + `synced` + full `order_events` audit trail.
   - Fire a second order and press **Key 3 (WhatsApp)** → show generated `wa.me` deep link, then send a Bangla WhatsApp reply (`বাড্ডা লিংক রোডে ডেলিভারি দিবেন`) → open Order Details to show it automatically linked to the exact tenant & order!
   - Briefly show **No Input** (replays once, then `no_response`), **Invalid Key** (replays, then ends on 2nd invalid key), and **No Answer** (schedules retry respecting calling window).
4. **Show Production Readiness & Automated QA (1m)**
   - Run `npm --prefix services/backend test` live — show all **15 automated acceptance tests** (including every SRS Section 15 test case: cross-tenant denial, stale cancelled-order guard, duplicate webhook/callback dedup, fulfillment cancellation protection, AES-256-GCM credential encryption, and pending store-sync recovery) passing in <2 seconds!
5. **Show Production Handoff Artifacts (45s)**
   - Show `docker-compose.yml`, `n8n/workflows/flowmind-voice-confirmation.json`, and `asterisk/config/extensions.conf` + `pjsip.conf` ready to plug into an authorized Bangladesh SIP trunk.

---

## 2. Anticipated Leadership & Engineering Q&A

### Q1: "Can this really run at strictly zero cost?"
- **Honest engineering answer (SRS Section 7 & Appendix B):**
  - **Software & AI processing cost:** Near-zero / self-hostable (Node.js, MySQL, Redis/BullMQ, Asterisk, self-hosted n8n, local Piper/Edge-TTS with SHA-256 caching so repeated menu clips cost zero).
  - **Telecom termination cost:** Asterisk is free PBX software, **not** a mobile carrier. Calling public Bangladesh mobile numbers (`+88017/18/19/...`) requires an authorized **BTRC-licensed IPTSP SIP trunk** (e.g., Brilliant/InterCloud, AmberIT, Agni, Link3, or SSL Wireless voice gateway) or an authorized on-prem GSM gateway, which carries per-minute termination charges (~0.40–0.80 BDT/min typical BD IPTSP range).
  - **WhatsApp Business Platform:** Meta charges per business-initiated utility conversation (post-Nov 2024 service conversations are free; utility template messages incur modest Meta fees).

### Q2: "Why is Node.js the source of truth instead of n8n?"
- n8n excels at workflow orchestration and visual ops visibility, but it is **not** a transactional multi-tenant authorization boundary.
- Keeping tenant RBAC, HMAC signature verification, AES-256-GCM secret decryption, idempotency locks, fulfillment cancellation rules, and state transitions inside Node.js guarantees that **stale callbacks, duplicate webhooks, or mid-call cancellations can never corrupt store orders**.

### Q3: "What about Bangla TTS quality — Piper vs. Edge-TTS vs. paid APIs?"
- Our `services/tts` microservice uses a **pluggable adapter with SHA-256 caching**:
  - **Edge-TTS (`bn-BD-NabanitaNeural` / `bn-BD-PradeepNeural`):** Best free Bangladeshi Bangla pronunciation for Phase 1–2 prototyping. Note: unofficial Microsoft endpoint, so for strict commercial SLA in Phase 7 we can either deploy a **self-hosted Bengali VITS/Piper ONNX model** (zero per-char cost, 100% offline) or switch one adapter config to **Azure Speech / Google Cloud TTS `bn-IN`/`bn-BD`** (~$4 per 1M characters, heavily reduced by caching static menu/opening phrases!).

### Q4: "What about n8n licensing for commercial SaaS?"
- Per SRS Section 7, n8n uses the Sustainable Use License (fair-code). Using self-hosted n8n for internal backend orchestration is generally allowed, while exposing n8n directly as a white-labeled feature to tenants requires commercial licensing review. Because our backend supports `ORCHESTRATION_MODE=direct` (BullMQ worker) **and** `ORCHESTRATION_MODE=n8n`, FlowMind AI has **zero vendor lock-in** to n8n!

### Q5: "What happens if we want a full conversational Bangla AI agent later (Phase 2)?"
- The adapter architecture cleanly separates **Order State / Store Sync / Tenant Security** from **Call Execution**. In Phase 2, we can add a `ConversationalVoiceAdapter` (Asterisk AudioSocket / WebRTC + Bangla STT + LLM + streaming TTS) alongside the DTMF IVR adapter — letting merchants opt into DTMF (ultra-low cost) or Conversational AI (premium tier) per tenant!

---

## 3. Recommended Phase-by-Phase Production Rollout (SRS Section 17)

| Phase | Target | Next Concrete Actions |
|---|---|---|
| **Phase 1 (Done)** | Prototype & Core Platform | Completed in this repository: Node.js backend, MySQL schema, BullMQ queue, Bangla TTS service, n8n workflow, Asterisk config, Next.js dashboard, and all 15 QA tests. |
| **Phase 2 (Week 1–2)** | Telephony Proof | Procure 1 BTRC-licensed BD IPTSP SIP trunk test account, plug credentials into `asterisk/config/pjsip.conf`, verify RFC 4733 DTMF 1/2/3 detection on Grameenphone, Robi, Banglalink, and Teletalk handsets. |
| **Phase 3 (Week 2–3)** | Live Store & WhatsApp | Connect real Shopify/WooCommerce test stores via OAuth/webhooks; register approved Bangla utility template (`order_custom_instruction_bn`) on Meta WhatsApp Business Platform. |
| **Phase 4 (Week 4)** | Compliance & Pilot | Finalize BTRC automated-call compliance, customer checkout consent checkbox, DND/opt-out list, Prometheus/Grafana alerts, and onboard 2–3 pilot merchants. |
