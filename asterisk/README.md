# FlowMind AI — Asterisk PBX & SIP Trunk Setup (SRS Section 6 & Appendix B)

This directory contains production-ready Asterisk 20 configuration files for outbound Bangla IVR calls and RFC 4733 DTMF capture (`1`, `2`, `3`, no-input replay, invalid-key limit).

## Files
- `config/pjsip.conf` — Outbound SIP trunk registration & endpoint (`bd-sip-trunk`) with `dtmf_mode=rfc4733`
- `config/extensions.conf` — `[flowmind-ivr]` dialplan executing Bangla prompt playback, bounded menu replay, and signed callbacks
- `config/ari.conf` & `config/http.conf` — Asterisk REST Interface (ARI) consumed by `AsteriskAriAdapter` in `services/backend`
- `agi/flowmind-callback.sh` — Signs call & DTMF callback JSON with HMAC-SHA256 (`X-Telephony-Signature`) and posts to Node.js

## Connecting a Real Bangladesh SIP Trunk
1. Obtain SIP credentials (`SIP_TRUNK_HOST`, `SIP_USERNAME`, `SIP_PASSWORD`) and an approved Caller ID from a licensed Bangladesh IPTSP / SIP carrier.
2. Replace placeholders in `config/pjsip.conf` and update `ASTERISK_CALLER_ID` in `.env`.
3. Set `TELEPHONY_PROVIDER=asterisk_ari` in `.env`.
4. Pre-generate the static Bangla confirmation/cancellation/WhatsApp `.wav` clips (`key1_confirmed.wav`, `key2_cancel.wav`, `key3_whatsapp.wav`) using `services/tts` (`format: "wav"`) into `/var/lib/asterisk/sounds/flowmind/`.
5. Start with Docker Compose telephony profile:
   ```bash
   docker compose --profile telephony up --build -d
   ```
